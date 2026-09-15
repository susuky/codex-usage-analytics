use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read},
    process::{Command, Output},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{models::{SessionAggregate, TokenBreakdown}, process::{bounded_output, bounded_stream}};

const WINDOWS_OK: &[u8] = b"__CODEX_WINDOWS_OK__";
const POSIX_OK: &[u8] = b"__CODEX_POSIX_OK__";
const POSIX_SCAN_SCRIPT: &str = include_str!("remote_scan.py");
const WINDOWS_SCAN_SCRIPT: &str = include_str!("remote_scan.ps1");
const MAX_RECORD_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct RemoteScanSummary {
    pub scanned_sessions: usize,
    pub skipped_files: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemotePlatform {
    Windows,
    Posix,
}

fn validate_target(target: &str) -> Result<(), String> {
    if target.is_empty()
        || target.starts_with('-')
        || !target
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '@' | '.' | '-' | '_'))
    {
        return Err("SSH target 僅能包含帳號、主機名稱、@、點、底線與連字號".into());
    }
    Ok(())
}

fn validate_codex_home(codex_home: &str) -> Result<(), String> {
    if codex_home.len() > 2048 || codex_home.chars().any(char::is_control) {
        return Err("遠端 CODEX_HOME 包含不支援的字元".into());
    }
    Ok(())
}

fn base_command(target: &str) -> Result<Command, String> {
    validate_target(target)?;
    let mut command = Command::new("ssh");
    command.args([
        "-T",
        "-C",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "StrictHostKeyChecking=yes",
        target,
    ]);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    Ok(command)
}

fn powershell_encoded(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}

pub(crate) fn windows_script_command(script_bytes: usize) -> String {
    // -Command - treats stdin as interactive statements and can silently omit
    // the final statement unless an extra blank line is sent. Read the complete
    // UTF-8 script, then execute it as one script block (also fixes Unicode).
    // Windows OpenSSH may not propagate stdin EOF to a nested PowerShell; use
    // the exact byte length rather than ReadToEnd, which would wait forever.
    powershell_encoded(&r#"$ErrorActionPreference = 'Stop'
$stream = [Console]::OpenStandardInput()
$bytes = [byte[]]::new(__SCRIPT_BYTES__)
$offset = 0
while ($offset -lt $bytes.Length) {
    $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($count -eq 0) { throw 'CODEX_SCAN_INPUT_INCOMPLETE' }
    $offset += $count
}
$script = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
& ([ScriptBlock]::Create($script))"#.replace("__SCRIPT_BYTES__", &script_bytes.to_string()))
}

fn windows_probe_command() -> String {
    powershell_encoded(
        r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { exit 4 }
[Console]::Out.Write('__CODEX_WINDOWS_OK__')
exit 0"#,
    )
}

#[cfg(test)]
fn windows_archive_command(codex_home: &str) -> Result<String, String> {
    validate_codex_home(codex_home)?;
    let configured = codex_home.replace('\'', "''");
    let script = r#"$ErrorActionPreference = 'Stop'
$configured = '__CODEX_HOME__'
$profileRoot = [System.Environment]::GetFolderPath('UserProfile')
if (-not $profileRoot) { $profileRoot = $env:USERPROFILE }
$root = if ($configured) { [System.Environment]::ExpandEnvironmentVariables($configured) } elseif ($profileRoot) { Join-Path $profileRoot '.codex' } else { '' }
$sessions = Join-Path $root 'sessions'
if (-not (Test-Path -LiteralPath $sessions -PathType Container)) {
    [Console]::Error.Write('CODEX_SESSIONS_NOT_FOUND')
    exit 3
}
$items = @('sessions')
$archived = Join-Path $root 'archived_sessions'
if (Test-Path -LiteralPath $archived -PathType Container) { $items += 'archived_sessions' }
$tar = Get-Command 'tar.exe' -ErrorAction SilentlyContinue
if ($null -eq $tar) {
    [Console]::Error.Write('CODEX_TAR_NOT_FOUND')
    exit 4
}
Push-Location -LiteralPath $root
try {
    & $tar.Source -czf - @items
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}"#.replace("__CODEX_HOME__", &configured);
    Ok(powershell_encoded(&script))
}

fn posix_probe_command() -> &'static str {
    "printf '__CODEX_POSIX_OK__'"
}

#[cfg(test)]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
fn posix_archive_command(codex_home: &str) -> Result<String, String> {
    validate_codex_home(codex_home)?;
    let root = if codex_home.trim().is_empty() {
        "\"$HOME/.codex\"".to_string()
    } else {
        shell_single_quote(codex_home.trim())
    };
    Ok(format!("cd {root} && set -- sessions && if [ -d archived_sessions ]; then set -- \"$@\" archived_sessions; fi && tar -czf - \"$@\""))
}

fn run_remote(target: &str, remote_command: &str) -> Result<Output, String> {
    bounded_output(base_command(target)?.arg(remote_command), vec![], std::time::Duration::from_secs(20))
}

fn is_transport_error(stderr: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    [
        "permission denied",
        "host key verification failed",
        "remote host identification has changed",
        "could not resolve hostname",
        "connection timed out",
        "connection refused",
        "no route to host",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn friendly_transport_error(stderr: &[u8], target: &str) -> String {
    let text = String::from_utf8_lossy(stderr)
        .replace(target, "遠端主機")
        .trim()
        .to_string();
    if text.is_empty() {
        "無法連線遠端主機，請檢查 SSH 設定與網路狀態".into()
    } else {
        text
    }
}

fn detect_platform(target: &str) -> Result<RemotePlatform, String> {
    let windows = run_remote(target, &windows_probe_command())?;
    if windows.status.success() && windows.stdout == WINDOWS_OK {
        return Ok(RemotePlatform::Windows);
    }
    if is_transport_error(&windows.stderr) {
        return Err(friendly_transport_error(&windows.stderr, target));
    }

    let posix = run_remote(target, posix_probe_command())?;
    if posix.status.success() && posix.stdout == POSIX_OK {
        return Ok(RemotePlatform::Posix);
    }
    if is_transport_error(&posix.stderr) {
        return Err(friendly_transport_error(&posix.stderr, target));
    }

    Err("SSH 已連線，但找不到此帳號的 Codex sessions 資料夾".into())
}

pub fn test_connection(target: &str, codex_home: &str) -> Result<String, String> {
    let platform = detect_platform(target)?;
    scan_remote_aggregates(target, codex_home, "probe", "probe", platform, Some("9999-12-31T23:59:59Z"), |_| Ok(0))?;
    match platform {
        RemotePlatform::Windows => Ok("已連線 Windows 遠端，並找到 Codex sessions".into()),
        RemotePlatform::Posix => Ok("已連線 Linux／Unix 遠端，並找到 Codex sessions".into()),
    }
}

fn archive_failure(stderr: &[u8], platform: RemotePlatform, target: &str) -> String {
    if is_transport_error(stderr) {
        return friendly_transport_error(stderr, target);
    }
    let text = String::from_utf8_lossy(stderr);
    if text.contains("CODEX_SESSIONS_NOT_FOUND") {
        return "找不到此帳號的 Codex sessions 資料夾".into();
    }
    if text.contains("CODEX_TAR_NOT_FOUND") {
        return "Windows 遠端缺少系統 tar.exe，請安裝 Windows OpenSSH 相容工具".into();
    }
    match platform {
        RemotePlatform::Windows => "Windows 遠端無法建立 Codex sessions 串流".into(),
        RemotePlatform::Posix => "Linux／Unix 遠端無法建立 Codex sessions 串流".into(),
    }
}

pub fn scan_remote<F>(
    target: &str,
    codex_home: &str,
    source_id: &str,
    source_name: &str,
    modified_after: Option<&str>,
    on_session: F,
) -> Result<RemoteScanSummary, String>
where F: FnMut(SessionAggregate) -> Result<usize, String> + Send,
{
    let platform = detect_platform(target)?;
    scan_remote_aggregates(
        target,
        codex_home,
        source_id,
        source_name,
        platform,
        modified_after,
        on_session,
    )
}

fn scan_remote_aggregates<F>(
    target: &str,
    codex_home: &str,
    source_id: &str,
    source_name: &str,
    platform: RemotePlatform,
    modified_after: Option<&str>,
    on_session: F,
) -> Result<RemoteScanSummary, String>
where F: FnMut(SessionAggregate) -> Result<usize, String> + Send,
{
    validate_codex_home(codex_home)?;
    let since = modified_after.unwrap_or_default();
    let (remote_command, script) = match platform {
        RemotePlatform::Windows => {
            let script = format!(
                "$SinceIso = '{}'\n$CodexHome = '{}'\n{}",
                since.replace('\'', "''"),
                codex_home.replace('\'', "''"),
                WINDOWS_SCAN_SCRIPT
            );
            (windows_script_command(script.len()), script)
        },
        RemotePlatform::Posix => (
            "python3 -".to_string(),
            format!(
                "SINCE_ISO = {}\nCODEX_HOME = {}\n{}",
                serde_json::to_string(since).map_err(|error| error.to_string())?,
                serde_json::to_string(codex_home.trim()).map_err(|error| error.to_string())?,
                POSIX_SCAN_SCRIPT
            ),
        ),
    };
    let output = bounded_stream(base_command(target)?.arg(remote_command), script.into_bytes(), std::time::Duration::from_secs(600), |stdout| {
        consume_aggregates(BufReader::new(stdout), source_id, source_name, on_session)
    })?;
    if !output.status.success() {
        return Err(archive_failure(&output.stderr, platform, target));
    }

    Ok(output.stdout)
}

fn valid_session(session: &SessionAggregate) -> bool {
    let Some(turns) = &session.turns else { return false; };
    if session.session_id.is_empty() || session.token_event_count != turns.len() as i64 { return false; }
    fn values(t: &TokenBreakdown) -> [i64; 6] {
        [t.input_tokens, t.cached_input_tokens, t.cache_write_input_tokens, t.output_tokens, t.reasoning_output_tokens, t.total_tokens]
    }
    let mut total = [0_i128; 6];
    for (index, turn) in turns.iter().enumerate() {
        if turn.ordinal != index as i64 + 1 { return false; }
        for (index, value) in values(&turn.tokens).into_iter().enumerate() {
            if value < 0 { return false; }
            total[index] += value as i128;
        }
    }
    values(&session.tokens).into_iter().enumerate().all(|(index, value)| value >= 0 && value as i128 == total[index])
}

// Only one aggregate record is held at a time. The callback commits a complete
// session transaction before reading the next, providing bounded backpressure.
// Completed sessions survive a subsequent malformed record or disconnected SSH.
fn consume_aggregates<R: BufRead, F: FnMut(SessionAggregate) -> Result<usize, String>>(
    mut reader: R, source_id: &str, source_name: &str, mut on_session: F,
) -> Result<RemoteScanSummary, String> {
    let mut sessions: HashMap<String, (i64, i64)> = HashMap::new();
    let mut rejected = HashSet::new();
    let mut invalid_lines = 0;
    let mut summary = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = Read::by_ref(&mut reader).take(MAX_RECORD_BYTES + 1).read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        if count as u64 > MAX_RECORD_BYTES { return Err("單筆遠端統計過大，已保留其他完成的統計".into()); }
        let bytes = line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&line);
        if bytes.iter().all(u8::is_ascii_whitespace) { continue; }
        if summary.is_some() { return Err("遠端統計順序異常，已保留完成的統計；請重試".into()); }
        let mut parsed: SessionAggregate = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(_) => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Summary { scan_summary: Counts }
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Counts { skipped_files: usize }
                if let Ok(value) = serde_json::from_slice::<Summary>(bytes) {
                    summary = Some(value.scan_summary.skipped_files);
                    continue;
                }
                invalid_lines += 1;
                continue;
            }
        };
        if !valid_session(&parsed) { invalid_lines += 1; continue; }
        parsed.source_id = source_id.into();
        parsed.source_name = source_name.into();
        parsed.source_kind = "ssh".into();
        let key = parsed.session_id.clone();
        let revision = (parsed.token_event_count, parsed.tokens.total_tokens);
        if sessions.get(&key).is_some_and(|current| *current >= revision) { continue; }
        sessions.insert(key.clone(), revision);
        if on_session(parsed)? > 0 {
            rejected.insert(key);
        } else {
            rejected.remove(&key);
        }
    }
    let skipped = summary.ok_or_else(|| "遠端掃描未完整結束，已保留完成的統計；請重試".to_string())?;
    Ok(RemoteScanSummary { scanned_sessions: sessions.len(), skipped_files: skipped + invalid_lines + rejected.len() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};

    fn sample_record(id: &str) -> String {
        let input = format!(r#"{{"type":"session_meta","timestamp":"2026-09-05T00:00:00Z","payload":{{"id":"{id}","cwd":"/test"}}}}
{{"type":"turn_context","payload":{{"model":"gpt-5.6-sol"}}}}
{{"type":"event_msg","timestamp":"2026-09-05T00:00:01Z","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"total_tokens":100}},"last_token_usage":{{"input_tokens":100,"total_tokens":100}}}}}}}}
"#);
        serde_json::to_string(&crate::parser::parse_session(Cursor::new(input), "", "", "ssh").unwrap()).unwrap() + "\n"
    }

    #[test]
    fn stream_keeps_good_records_and_deduplicates_active_archive_copies() {
        let a = sample_record("one");
        let b = sample_record("two");
        let input = format!("{a}{{broken\n{a}{b}{{\"scanSummary\":{{\"skippedFiles\":0}}}}\n");
        let mut received = Vec::new();
        let result = consume_aggregates(Cursor::new(input), "remote", "Remote", |session| {
            assert_eq!(session.source_id, "remote");
            received.push(session.session_id);
            Ok(0)
        }).unwrap();
        assert_eq!(received, ["one", "two"]);
        assert_eq!(result.scanned_sessions, 2);
        assert_eq!(result.skipped_files, 1);
    }

    #[test]
    fn disconnected_stream_preserves_completed_sessions_and_retries_idempotently() {
        let path = std::env::temp_dir().join(format!("codex-stream-{}.sqlite3", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut connection = crate::db::open(&path).unwrap();
        let record = sample_record("one");
        let truncated = record.clone() + "{\"sessionId\":\"unfinished";
        assert!(consume_aggregates(Cursor::new(truncated), "remote", "Remote", |session| {
            crate::db::save_sessions(&mut connection, &[session])
        }).is_err());
        assert_eq!(crate::db::get_session(&connection, "remote", "one").unwrap().token_event_count, 1);
        let complete = record + "{\"scanSummary\":{\"skippedFiles\":0}}\n";
        consume_aggregates(Cursor::new(complete), "remote", "Remote", |session| crate::db::save_sessions(&mut connection, &[session])).unwrap();
        assert_eq!(crate::db::get_session(&connection, "remote", "one").unwrap().tokens.total_tokens, 100);
    }

    #[test]
    fn full_scan_larger_than_256_mib_is_consumed_without_a_whole_scan_buffer() {
        // Generate 260 MiB lazily with a single 1 MiB fixture in memory.
        struct Repeated<'a> { bytes: &'a [u8], position: usize, remaining: usize }
        impl Read for Repeated<'_> {
            fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
                if self.remaining == 0 { return Ok(0); }
                let count = output.len().min(self.bytes.len() - self.position).min(self.remaining);
                output[..count].copy_from_slice(&self.bytes[self.position..self.position + count]);
                self.position = (self.position + count) % self.bytes.len();
                self.remaining -= count;
                Ok(count)
            }
        }
        let mut record = sample_record("same");
        record.pop();
        record.extend(std::iter::repeat_n(' ', 1024 * 1024 - record.len() - 1));
        record.push('\n');
        let reader = Repeated { bytes: record.as_bytes(), position: 0, remaining: record.len() * 260 }
            .chain(Cursor::new(b"{\"scanSummary\":{\"skippedFiles\":0}}\n"));
        let mut calls = 0;
        let result = consume_aggregates(BufReader::new(reader), "remote", "Remote", |_| { calls += 1; Ok(0) }).unwrap();
        assert_eq!(calls, 1);
        assert_eq!(result.skipped_files, 0);
    }

    #[test]
    fn oversized_single_record_and_invalid_totals_are_not_imported() {
        assert!(consume_aggregates(BufReader::new(io::repeat(b'x').take(MAX_RECORD_BYTES + 1)), "remote", "Remote", |_| panic!("oversized record accepted")).unwrap_err().contains("過大"));
        let mut value: serde_json::Value = serde_json::from_str(&sample_record("one")).unwrap();
        value["tokens"]["totalTokens"] = 999.into();
        let input = value.to_string() + "\n{\"scanSummary\":{\"skippedFiles\":0}}\n";
        let result = consume_aggregates(Cursor::new(input), "remote", "Remote", |_| panic!("invalid totals accepted")).unwrap();
        assert_eq!(result.skipped_files, 1);
    }

    #[test]
    fn rejects_targets_that_could_become_options_or_shell_input() {
        assert!(validate_target("-oProxyCommand=bad").is_err());
        assert!(validate_target("user@host;touch-x").is_err());
        assert!(validate_target("user@example-server").is_ok());
        assert!(validate_target("user@workstation").is_ok());
    }

    #[test]
    fn powershell_commands_are_encoded_as_a_single_safe_argument() {
        let command = windows_probe_command();
        let encoded = command.split_whitespace().last().unwrap();
        assert!(encoded
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')));
        assert!(!command.contains("$HOME"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_script_finishes_with_unicode_and_without_stdin_eof_or_blank_line() {
        use std::{io::Write, process::Stdio, time::{Duration, Instant}};
        let script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n[Console]::Out.WriteLine('{\"scanSummary\":{\"skippedFiles\":0},\"label\":\"完成\"}')";
        let command = windows_script_command(script.len());
        let mut child = Command::new("powershell.exe")
            .args(command.split_whitespace().skip(1))
            .creation_flags(0x0800_0000)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        input.write_all(script.as_bytes()).unwrap();
        // Keep stdin OPEN, reproducing the EOF behavior of nested Windows SSH.
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break Some(status); }
            if started.elapsed() > Duration::from_secs(5) { break None; }
            std::thread::sleep(Duration::from_millis(20));
        };
        if status.is_none() { let _ = child.kill(); }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(status.is_some_and(|status| status.success()), "Script waited for stdin EOF or failed: {}", String::from_utf8_lossy(&output.stderr));
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["label"], "完成");
        assert_eq!(value["scanSummary"]["skippedFiles"], 0);
    }

    #[test]
    fn platform_specific_archive_commands_include_both_session_roots() {
        let windows = windows_archive_command("").unwrap();
        let encoded = windows.split_whitespace().last().unwrap();
        let bytes = STANDARD.decode(encoded).unwrap();
        let words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        let decoded = String::from_utf16(&words).unwrap();
        assert!(decoded.contains("sessions"));
        assert!(decoded.contains("archived_sessions"));
        assert!(decoded.contains("tar.exe"));
        assert!(decoded.contains("-czf"));
        assert!(posix_archive_command("").unwrap().contains("archived_sessions"));
        assert!(posix_archive_command("").unwrap().contains("tar -czf"));
    }

    #[test]
    fn aggregate_scripts_do_not_emit_conversation_content_fields() {
        for script in [POSIX_SCAN_SCRIPT, WINDOWS_SCAN_SCRIPT] {
            assert!(!script.contains("prompt\":"));
            assert!(!script.contains("response\":"));
            assert!(!script.contains("toolOutput\":"));
        }
    }

    #[test]
    fn windows_aggregate_discovers_configured_and_active_wsl_codex_roots() {
        assert!(WINDOWS_SCAN_SCRIPT.contains("$env:CODEX_HOME"));
        assert!(WINDOWS_SCAN_SCRIPT.contains("\\\\wsl.localhost"));
        assert!(WINDOWS_SCAN_SCRIPT.contains("foreach ($userHome"));
        assert!(WINDOWS_SCAN_SCRIPT.contains("AddHours(-6)"));
        assert!(POSIX_SCAN_SCRIPT.contains("21600"));
    }

    #[test]
    fn configured_codex_home_is_injected_without_shell_interpolation() {
        let command = windows_archive_command(r"C:\Users\O'Brien\.codex").unwrap();
        assert!(!command.contains("O'Brien"));
        let posix = posix_archive_command("/home/o'brien/.codex").unwrap();
        assert!(posix.contains("o'\"'\"'brien"));
        assert!(validate_codex_home("bad\npath").is_err());
    }
}
