use std::{
    io::{Read, Write},
    process::{ChildStdout, Command, ExitStatus, Output, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub struct StreamOutput<T> {
    pub status: ExitStatus,
    pub stdout: T,
    pub stderr: Vec<u8>,
}

// Consume stdout as it arrives: a full scan must not buffer an entire machine's
// history. Stdin, stdout and stderr are concurrent; errors/deadlines reap SSH.
pub fn bounded_stream<T: Send, F>(command: &mut Command, input: Vec<u8>, timeout: Duration, consume: F) -> Result<StreamOutput<T>, String>
where F: FnOnce(ChildStdout) -> Result<T, String> + Send,
{
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| format!("無法啟動連線程序：{e}"))?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let failed = AtomicBool::new(false);
    thread::scope(|scope| {
        let out = scope.spawn(|| {
            let result = consume(stdout);
            if result.is_err() { failed.store(true, Ordering::Release); }
            result
        });
        let err = scope.spawn(move || {
            let mut bytes = Vec::new();
            let mut chunk = [0; 8192];
            loop {
                let count = stderr.read(&mut chunk).map_err(|e| e.to_string())?;
                if count == 0 { return Ok::<_, String>(bytes); }
                let keep = count.min((256 * 1024usize).saturating_sub(bytes.len()));
                bytes.extend_from_slice(&chunk[..keep]);
            }
        });
        let writer = scope.spawn(move || stdin.write_all(&input));
        let started = Instant::now();
        let mut consumer_failed = false;
        let result = loop {
            // Observe an SSH exit before the secondary EOF/parser error, so an
            // actual transport timeout is not mislabeled as incomplete JSON.
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(e) => break Err(e.to_string()),
                Ok(None) => {},
            }
            if failed.load(Ordering::Acquire) {
                consumer_failed = true;
                break Err("無法讀取遠端統計".to_string());
            }
            if started.elapsed() >= timeout {
                break Err("遠端作業逾時，已保留完成的統計；請稍後重試".to_string());
            }
            thread::sleep(Duration::from_millis(25));
        };
        if result.is_err() { let _ = child.kill(); }
        let _ = child.wait();
        let write_result = writer.join();
        let stdout = out.join().map_err(|_| "讀取資料失敗".to_string())?;
        let stderr = err.join().map_err(|_| "讀取錯誤資訊失敗".to_string())??;
        if consumer_failed { return Err(stdout.err().unwrap_or_else(|| "無法讀取遠端統計".into())); }
        let status = result?;
        if !status.success() && stdout.is_err() {
            let text = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(if text.is_empty() { "遠端作業中斷，已保留完成的統計；請稍後重試".into() } else { text });
        }
        if status.success() { write_result.map_err(|_| "傳送資料失敗")?.map_err(|e| e.to_string())?; }
        Ok(StreamOutput { status, stdout: stdout?, stderr })
    })
}

pub fn bounded_output(command: &mut Command, input: Vec<u8>, timeout: Duration) -> Result<Output, String> {
    let output = bounded_stream(command, input, timeout, |stdout| {
        let max = 256 * 1024 * 1024;
        let mut bytes = Vec::new();
        stdout.take(max + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > max { return Err("遠端回應超過安全大小限制".into()); }
        Ok(bytes)
    })?;
    Ok(Output { status: output.status, stdout: output.stdout, stderr: output.stderr })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hung_process_is_killed_and_wait_releases() {
        #[cfg(windows)] let mut command = { let mut c = Command::new("powershell.exe"); c.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]); c };
        #[cfg(not(windows))] let mut command = { let mut c = Command::new("sleep"); c.arg("30"); c };
        let start = Instant::now();
        assert!(bounded_output(&mut command, vec![], Duration::from_millis(150)).unwrap_err().contains("逾時"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn consumer_error_stops_the_child_without_waiting_for_timeout() {
        #[cfg(windows)] let mut command = { let mut c = Command::new("powershell.exe"); c.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]); c };
        #[cfg(not(windows))] let mut command = { let mut c = Command::new("sleep"); c.arg("30"); c };
        let start = Instant::now();
        let result = bounded_stream(&mut command, vec![], Duration::from_secs(20), |_| Err::<(), _>("record limit".into()));
        assert_eq!(result.err().as_deref(), Some("record limit"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
