use std::{collections::HashMap, fs::File, io::{BufReader, Read}, path::Path};
use walkdir::WalkDir;
use sha2::{Digest, Sha256};
use rusqlite::{Connection, OptionalExtension, params};
use crate::{models::{SessionAggregate, ScanBatch}, parser::parse_session};

pub fn scan_local(codex_home: &Path, connection: &mut Connection, force_full: bool) -> Result<ScanBatch, String> {
    let mut sessions: HashMap<String, SessionAggregate> = HashMap::new();
    let mut skipped_files = 0;
    let mut checkpoints = Vec::new();
    let roots = [codex_home.join("sessions"), codex_home.join("archived_sessions")];
    if !roots.iter().any(|path| path.exists()) { return Err(format!("找不到 Codex sessions：{}", codex_home.display())); }
    for root in roots.iter().filter(|path| path.exists()) {
        for entry in WalkDir::new(root).follow_links(false) {
            let entry = match entry { Ok(value) => value, Err(_) => { skipped_files += 1; continue; } };
            if !entry.file_type().is_file() || entry.path().extension().and_then(|value| value.to_str()) != Some("jsonl") { continue; }
            let file_key = format!("{:x}", Sha256::digest(entry.path().to_string_lossy().as_bytes()));
            let metadata = match entry.metadata() { Ok(value) => value, Err(_) => { skipped_files += 1; continue; } };
            let modified = format!("{:?}", metadata.modified().ok());
            let saved: Option<(u64, String)> = connection.query_row("SELECT size,modified FROM file_checkpoints WHERE file_key=?1", [&file_key], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
            if !force_full && saved == Some((metadata.len(), modified.clone())) { continue; }
            let file = match File::open(entry.path()) { Ok(file) => file, Err(_) => { skipped_files += 1; continue; } };
            let parsed = match parse_session(BufReader::new(file.take(metadata.len())), "local", "這台電腦", "local") { Ok(value) => value, Err(_) => { skipped_files += 1; continue; } };
            let unchanged = entry.path().metadata().ok().is_some_and(|after| after.len() == metadata.len() && after.modified().ok() == metadata.modified().ok());
            if parsed.scan_complete && unchanged { checkpoints.push((file_key, metadata.len(), modified)); }
            else { skipped_files += 1; }
            let should_replace = sessions.get(&parsed.session_id).map(|current| parsed.token_event_count >= current.token_event_count).unwrap_or(true);
            if should_replace { sessions.insert(parsed.session_id.clone(), parsed); }
        }
    }
    let mut sessions: Vec<_> = sessions.into_values().collect();
    let rules = crate::db::load_settings(connection)?.pricing_rules;
    crate::pricing::reprice_sessions(&mut sessions, &rules);
    let retained = crate::db::save_sessions(connection, &sessions)?;
    skipped_files += retained;
    if retained > 0 { checkpoints.clear(); }
    // Checkpoints advance only after the corresponding aggregates are committed.
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    for (key, size, modified) in checkpoints {
        tx.execute("INSERT INTO file_checkpoints VALUES(?1,?2,?3) ON CONFLICT(file_key) DO UPDATE SET size=excluded.size,modified=excluded.modified", params![key,size,modified]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ScanBatch { sessions, skipped_files })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn active_and_archived_are_deduplicated_by_session_id() {
        let root = std::env::temp_dir().join(format!(
            "codex-usage-scanner-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::create_dir_all(root.join("archived_sessions")).unwrap();
        let meta = "{\"timestamp\":\"2026-08-23T01:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"same\",\"cwd\":\"/work/a\"}}\n";
        fs::write(root.join("sessions/a.jsonl"), meta).unwrap();
        fs::write(root.join("archived_sessions/a.jsonl"), meta).unwrap();
        let mut connection = crate::db::open(&root.join("test.sqlite3")).unwrap();
        let session_count = scan_local(&root, &mut connection, false).unwrap().sessions.len();
        assert_eq!(scan_local(&root, &mut connection, false).unwrap().sessions.len(), 0);
        assert_eq!(scan_local(&root, &mut connection, true).unwrap().sessions.len(), 1);
        drop(connection);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(session_count, 1);
    }
}
