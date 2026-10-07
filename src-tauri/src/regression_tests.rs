use crate::{db, models::*, parser::parse_session, process::bounded_output};
use std::{io::Cursor, path::PathBuf, time::{Duration, SystemTime, UNIX_EPOCH}};
use serde_json::json;

fn temp() -> PathBuf {
    let root = std::env::temp_dir().join(format!("codex-usage-regression-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&root).unwrap(); root
}
fn fixture() -> String {
    let mut lines = vec![json!({"timestamp":"2026-09-05T01:00:00Z","type":"session_meta","payload":{"id":"regression","cwd":"C:/private/test","timestamp":"2026-09-05T01:00:00Z"}}),json!({"type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"high"}})];
    for (time,total,last) in [(1,110,Some(110)),(2,330,Some(220)),(3,55,Some(55)),(4,155,None)] {
        lines.push(json!({"timestamp":format!("2026-09-05T01:00:{time:02}Z"),"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":total,"total_tokens":total},"last_token_usage":last.map(|last|json!({"input_tokens":last,"total_tokens":last}))}}}));
    }
    lines.into_iter().map(|line| line.to_string()+"\n").collect()
}

#[test]
fn auto_review_usage_survives_imports_and_legacy_price_upgrade_without_charges() {
    let root = temp();
    let path = root.join("usage.sqlite3");
    let mut connection = db::open(&path).unwrap();
    let log = fixture().replace("gpt-5.6-sol", "codex-auto-review")
        .replace("\"last_token_usage\":null", "\"last_token_usage\":{\"total_tokens\":100}");
    for kind in ["local", "ssh", "cloud"] {
        let parsed = parse_session(Cursor::new(&log), kind, kind, kind).unwrap();
        assert_eq!(parsed.tokens.total_tokens, 485);
        assert_eq!(parsed.token_event_count, 4);
        assert_eq!(parsed.estimate_microusd, Some(0));
        assert_eq!(parsed.unpriced_turn_count, 0);
        assert_eq!(parsed.unpriced_tokens, 0);
        if kind == "cloud" { db::save_cloud_sessions(&mut connection, &[parsed]).unwrap(); }
        else { db::save_sessions(&mut connection, &[parsed]).unwrap(); }
    }
    let mut legacy = AppSettings::default();
    legacy.pricing_rules[0].input_usd_per_million = 9.0;
    let review = legacy.pricing_rules.iter_mut().find(|rule| rule.model == "codex-auto-review").unwrap();
    review.model = " CODEX-AUTO-REVIEW ".into();
    review.input_usd_per_million = 99.0;
    review.output_usd_per_million = 99.0;
    review.unavailable_rates = vec!["fast".into()];
    connection.execute("UPDATE settings SET value=?1 WHERE key='app'", [serde_json::to_string(&legacy).unwrap()]).unwrap();
    connection.execute("UPDATE settings SET value='2' WHERE key='data_revision:official-pricing-v2'", []).unwrap();
    connection.execute("UPDATE turns SET estimate_microusd=CASE WHEN ordinal=4 THEN NULL ELSE 12345 END", []).unwrap();
    connection.execute("UPDATE sessions SET estimate_microusd=37035", []).unwrap();
    drop(connection);

    let mut connection = db::open(&path).unwrap();
    let settings = db::load_settings(&connection).unwrap();
    assert_eq!(settings.pricing_rules[0].input_usd_per_million, 9.0);
    assert_eq!(settings.pricing_rules.iter().find(|rule| rule.model == "codex-auto-review"), Some(&non_billable_pricing_rule()));
    for kind in ["local", "ssh", "cloud"] {
        let saved = db::get_session(&connection, kind, "regression").unwrap();
        assert_eq!(saved.tokens.total_tokens, 485);
        assert_eq!(saved.activity_tokens, 485);
        assert_eq!(saved.token_event_count, 4);
        assert_eq!(saved.estimate_microusd, Some(0));
        assert_eq!(saved.unpriced_turn_count, 0);
        assert_eq!(saved.unpriced_tokens, 0);
        let turns = saved.turns.unwrap();
        assert_eq!(turns.len(), 4);
        assert!(turns.iter().all(|turn| turn.estimate_microusd == Some(0)));
    }
    db::save_settings(&connection, &legacy).unwrap();
    db::reprice_all_sessions(&mut connection, &legacy.pricing_rules).unwrap();
    assert_eq!(db::get_session(&connection, "local", "regression").unwrap().estimate_microusd, Some(0));
    drop(connection);
    let connection = db::open(&path).unwrap();
    assert_eq!(db::get_session(&connection, "local", "regression").unwrap().tokens.total_tokens, 485);
    assert_eq!(db::load_settings(&connection).unwrap().pricing_rules.iter().find(|rule| rule.model == "codex-auto-review"), Some(&non_billable_pricing_rule()));
}

#[test]
fn mixed_sessions_keep_paid_and_unknown_usage_separate_from_auto_review() {
    let root = temp();
    let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
    let mut parsed = parse_session(Cursor::new(fixture()), "local", "Local", "local").unwrap();
    let turns = parsed.turns.as_mut().unwrap();
    turns[0].model = "codex-auto-review".into();
    turns[2].model = "unknown-model".into();
    turns[3].model = "codex-auto-review".into();
    db::save_sessions(&mut connection, &[parsed]).unwrap();
    let saved = db::get_session(&connection, "local", "regression").unwrap();
    assert_eq!(saved.tokens.total_tokens, 485);
    assert_eq!(saved.estimate_microusd, Some(880));
    assert_eq!(saved.unpriced_turn_count, 1);
    assert_eq!(saved.unpriced_tokens, 55);
    let turns = saved.turns.unwrap();
    assert_eq!(turns.iter().map(|turn| turn.estimate_microusd).collect::<Vec<_>>(), vec![Some(0), Some(880), None, Some(0)]);
}

#[test]
fn resets_and_missing_last_reconcile_everywhere_and_remain_idempotent() {
    let root=temp(); let mut connection=db::open(&root.join("usage.sqlite3")).unwrap();
    let parsed=parse_session(Cursor::new(fixture()),"local","Local","local").unwrap();
    assert_eq!(parsed.tokens.total_tokens,485);
    assert_eq!(parsed.unpriced_tokens,100);
    assert_eq!(parsed.unpriced_turn_count,1);
    db::save_sessions(&mut connection,&[parsed.clone()]).unwrap();
    db::save_sessions(&mut connection,&[parsed.clone()]).unwrap();
    let saved=db::get_session(&connection,"local","regression").unwrap();
    assert_eq!(saved.tokens.total_tokens,saved.turns.unwrap().iter().map(|t|t.tokens.total_tokens).sum::<i64>());
    let mut short=parsed.clone(); short.turns.as_mut().unwrap().remove(0); short.token_event_count-=1;
    db::save_sessions(&mut connection,&[short]).unwrap();
    assert_eq!(db::get_session(&connection,"local","regression").unwrap().token_event_count,4);
    let mut corrupted=parsed.clone(); corrupted.turns.as_mut().unwrap()[0].timestamp="2026-09-01T00:00:00Z".into();
    db::save_sessions(&mut connection,&[corrupted]).unwrap();
    assert_eq!(db::get_session(&connection,"local","regression").unwrap().turns.unwrap()[0].timestamp,parsed.turns.unwrap()[0].timestamp);
}
#[test]
fn imported_older_copies_are_quiet_but_conflicting_or_incomplete_snapshots_warn() {
    let root = temp(); let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
    let original = parse_session(Cursor::new(fixture()), "local", "Local", "local").unwrap();
    assert_eq!(db::save_sessions(&mut connection, &[original.clone()]).unwrap(), 0);
    let mut older = original.clone();
    older.turns.as_mut().unwrap().truncate(3);
    older.token_event_count = 3;
    older.tokens = TokenBreakdown::default();
    for turn in older.turns.as_mut().unwrap() {
        older.tokens.add_assign(&turn.tokens);
        turn.timestamp = turn.timestamp.replace('Z', "+00:00");
    }
    older.ended_at = "2026-09-05T09:00:03+08:00".into();
    assert_eq!(db::save_sessions(&mut connection, &[older.clone()]).unwrap(), 0);
    let mut newer = older.clone(); newer.ended_at = "2026-09-05T01:00:05Z".into();
    assert_eq!(db::save_sessions(&mut connection, &[newer]).unwrap(), 1);
    let mut partial = older.clone(); partial.scan_complete = false;
    assert_eq!(db::save_sessions(&mut connection, &[partial]).unwrap(), 1);
    let mut conflicting = older.clone();
    conflicting.turns.as_mut().unwrap()[0].timestamp = "2026-09-05T00:00:00Z".into();
    assert_eq!(db::save_sessions(&mut connection, &[conflicting]).unwrap(), 1);
    let mut invalid_date = older; invalid_date.ended_at = "invalid".into();
    assert_eq!(db::save_sessions(&mut connection, &[invalid_date]).unwrap(), 1);
    let saved = db::get_session(&connection, "local", "regression").unwrap();
    assert_eq!(saved.token_event_count, original.token_event_count);
    assert_eq!(saved.tokens, original.tokens);
    assert_eq!(saved.turns.unwrap().len(), 4);
}
#[test]
fn fresh_settings_have_no_remote_and_saved_sources_survive_loading() {
    let root = temp();
    let connection = db::open(&root.join("usage.sqlite3")).unwrap();
    let mut settings = db::load_settings(&connection).unwrap();
    assert!(settings.ssh_target.is_empty());
    assert!(!settings.ssh_enabled);
    assert!(settings.ssh_sources.is_empty());
    settings.ssh_sources.push(SshSourceConfig { id: "ssh-personal".into(), name: "My server".into(), target: "user@my-server".into(), codex_home: "/data/codex".into(), enabled: true });
    db::save_settings(&connection, &settings).unwrap();
    let saved = db::load_settings(&connection).unwrap();
    assert_eq!(saved.ssh_sources.len(), 1);
    assert_eq!(saved.ssh_sources[0].target, "user@my-server");
    assert_eq!(saved.ssh_sources[0].codex_home, "/data/codex");

    let legacy = json!({ "codexHome": "", "sshTarget": "user@old-server", "sshEnabled": true, "cloudEnabled": false, "pollMinutes": 15 });
    connection.execute("UPDATE settings SET value=?1 WHERE key='app'", [legacy.to_string()]).unwrap();
    let migrated = db::load_settings(&connection).unwrap();
    assert_eq!(migrated.ssh_sources[0].target, "user@old-server");
    assert!(migrated.ssh_sources[0].enabled);
}

#[test]
fn startup_and_zero_price_and_cloud_queue_survive_reopening() {
    let root=temp(); let path=root.join("usage.sqlite3"); let connection=db::open(&path).unwrap();
    let mut source=UsageSource { id:"ssh-test".into(),name:"Test".into(),kind:"ssh".into(),target:None,enabled:false,stale:true,last_scanned_at:Some("2026-09-05T00:00:00Z".into()),last_error:Some("offline".into()),session_count:0,latest_data_at:None };
    db::upsert_source(&connection,&source).unwrap();
    source.last_scanned_at=None; source.last_error=None; source.enabled=true;
    db::ensure_source(&connection,&source).unwrap();
    let mut settings=AppSettings::default(); settings.pricing_rules[0].cache_write_usd_per_million=0.0;
    db::save_settings(&connection,&settings).unwrap();
    let user="00000000-0000-0000-0000-000000000001";
    let mut state=crate::cloud_store::SyncState::default(); state.pending.insert("local:regression".into(),"version-1".into());
    crate::cloud_store::save(&connection,user,&state).unwrap(); drop(connection);
    let connection=db::open(&path).unwrap();
    assert_eq!(db::list_sources(&connection).unwrap()[0].last_error.as_deref(),Some("offline"));
    assert!(!db::list_sources(&connection).unwrap()[0].enabled);
    assert_eq!(db::load_settings(&connection).unwrap().pricing_rules[0].cache_write_usd_per_million,0.0);
    assert_eq!(crate::cloud_store::load(&connection,user).unwrap().pending.len(),1);
}
#[test]
fn historical_date_filter_does_not_zero_today_metric() {
    let root=temp(); let path=root.join("usage.sqlite3"); let mut connection=db::open(&path).unwrap();
    let mut session=parse_session(Cursor::new(fixture()),"local","Local","local").unwrap();
    for turn in session.turns.as_mut().unwrap() { turn.timestamp=chrono::Utc::now().to_rfc3339(); }
    session.ended_at=chrono::Utc::now().to_rfc3339();
    db::save_sessions(&mut connection,&[session]).unwrap();
    let data=crate::overview_for_path(&path,UsageFilter { days:1,start_date:Some("2025-01-01".into()),end_date:Some("2025-01-01".into()),source_id:None,model:None,project:None }).unwrap();
    assert_eq!(data.totals.total_tokens,0); assert_eq!(data.today_tokens,485);
}

#[test]
fn cloud_copy_merges_without_doubling_and_rejects_a_shorter_download() {
    use sha2::{Digest,Sha256};
    use crate::cloud_store::{Download,merge,reconcile};
    let root=temp(); let mut connection=db::open(&root.join("usage.sqlite3")).unwrap();
    let user="00000000-0000-0000-0000-000000000001";
    let key=format!("{:x}",Sha256::digest(format!("{user}:regression").as_bytes()));
    let original=parse_session(Cursor::new(fixture()),"local","Local","local").unwrap();
    merge(&mut connection,user,vec![Download{session_key:key.clone(),session:original.clone()}]).unwrap();
    let mut local=original.clone();
    local.turns.as_mut().unwrap().iter_mut().for_each(|t|t.timestamp=t.timestamp.replace('Z',"+00:00"));
    db::save_sessions(&mut connection,&[local.clone()]).unwrap();
    reconcile(&mut connection).unwrap();
    let count:i64=connection.query_row("SELECT COUNT(*) FROM sessions",[],|row|row.get(0)).unwrap();
    assert_eq!(count,1);
    let mut short=original.clone(); short.turns.as_mut().unwrap().truncate(1); short.token_event_count=1; short.tokens=short.turns.as_ref().unwrap()[0].tokens.clone();
    merge(&mut connection,user,vec![Download{session_key:key,session:short}]).unwrap();
    assert_eq!(db::get_session(&connection,"local","regression").unwrap().token_event_count,4);
}

fn activity_fixture() -> String {
    fixture() + &json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"cat /skills/frontend-craft/SKILL.md; tools.mcp__node_repl__js({})"}}).to_string() + "\n"
}

fn model_switch_fixture() -> String {
    let records = [
        json!({"type":"session_meta","timestamp":"2026-10-07T01:00:00Z","payload":{"id":"switch-model","cwd":"C:/test"}}),
        json!({"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}),
        json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-6-astra","service_tier":"priority"}}}),
        json!({"type":"event_msg","timestamp":"2026-10-07T01:00:01Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"total_tokens":100}}}}),
        json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"codex-auto-review"}}}),
        json!({"type":"event_msg","timestamp":"2026-10-07T01:00:02Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"total_tokens":200}}}}),
    ];
    records.into_iter().map(|record| record.to_string()+"\n").collect()
}

#[test]
fn thread_settings_model_switches_match_local_and_python_scanning() {
    let root = temp(); std::fs::create_dir(root.join("sessions")).unwrap();
    let log = model_switch_fixture();
    std::fs::write(root.join("sessions/model.jsonl"), &log).unwrap();
    let local = parse_session(Cursor::new(log), "local", "Local", "local").unwrap();
    let turns = local.turns.unwrap();
    assert_eq!(turns.iter().map(|turn| turn.model.as_str()).collect::<Vec<_>>(), vec!["gpt-6-astra", "codex-auto-review"]);
    assert!(turns.iter().all(|turn| turn.service_tier == "priority"));
    assert_eq!(turns[1].estimate_microusd, Some(0));
    let script = format!("SINCE_ISO = ''\nCODEX_HOME = {}\n{}", serde_json::to_string(&root.to_string_lossy()).unwrap(), include_str!("remote_scan.py"));
    let output = bounded_output(std::process::Command::new("python").arg("-"), script.into_bytes(), Duration::from_secs(15)).unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let remote: SessionAggregate = serde_json::from_str(String::from_utf8_lossy(&output.stdout).lines().next().unwrap()).unwrap();
    assert_eq!(remote.tokens, local.tokens);
    assert_eq!(remote.turns.unwrap().iter().map(|turn| (&turn.model, &turn.service_tier)).collect::<Vec<_>>(), turns.iter().map(|turn| (&turn.model, &turn.service_tier)).collect::<Vec<_>>());
}

#[test]
fn model_parser_upgrade_reparses_unchanged_logs_without_losing_usage() {
    let root = temp(); let path = root.join("usage.sqlite3");
    std::fs::create_dir(root.join("sessions")).unwrap();
    std::fs::write(root.join("sessions/model.jsonl"), model_switch_fixture()).unwrap();
    let mut connection = db::open(&path).unwrap();
    let mut original = crate::scanner::scan_local(&root, &mut connection, false).unwrap().sessions.remove(0);
    for turn in original.turns.as_mut().unwrap() { turn.model = "gpt-6.1-sol".into(); }
    db::save_sessions(&mut connection, &[original]).unwrap();
    assert!(crate::scanner::scan_local(&root, &mut connection, false).unwrap().sessions.is_empty());
    connection.execute("DELETE FROM settings WHERE key='data_revision:thread-settings-model-v1'", []).unwrap();
    drop(connection);
    let mut connection = db::open(&path).unwrap();
    let scanned = crate::scanner::scan_local(&root, &mut connection, false).unwrap();
    assert_eq!(scanned.sessions.len(), 1);
    assert_eq!(scanned.skipped_files, 0);
    let saved = db::get_session(&connection, "local", "switch-model").unwrap();
    assert_eq!(saved.tokens.total_tokens, 300);
    assert_eq!(saved.turns.unwrap().iter().map(|turn| turn.model.as_str()).collect::<Vec<_>>(), vec!["gpt-6-astra", "codex-auto-review"]);
    assert!(crate::scanner::scan_local(&root, &mut connection, false).unwrap().sessions.is_empty());
}

#[test]
fn resumed_log_suffix_preserves_history_imports_new_usage_and_is_idempotent() {
    let root = temp(); let path = root.join("usage.sqlite3");
    let mut connection = db::open(&path).unwrap();
    let original = parse_session(Cursor::new(activity_fixture()), "local", "Local", "local").unwrap();
    db::save_sessions(&mut connection, &[original.clone()]).unwrap();
    let original_activity = activity_rows(&connection);
    let mut suffix = original.clone();
    suffix.turns.as_mut().unwrap().drain(..2);
    let mut newer = original.turns.as_ref().unwrap()[0].clone();
    newer.timestamp = "2026-10-07T01:00:00Z".into(); newer.model = "gpt-6-astra".into();
    suffix.turns.as_mut().unwrap().push(newer);
    suffix.tokens = TokenBreakdown::default();
    for turn in suffix.turns.as_ref().unwrap() { suffix.tokens.add_assign(&turn.tokens); }
    suffix.token_event_count = suffix.turns.as_ref().unwrap().len() as i64;
    suffix.ended_at = "2026-10-07T01:00:00Z".into();
    suffix.activity = SessionActivity::default();
    assert_eq!(db::save_sessions(&mut connection, &[suffix.clone()]).unwrap(), 0);
    let saved = db::get_session(&connection, "local", "regression").unwrap();
    assert_eq!(saved.tokens.total_tokens, 595);
    assert_eq!(saved.token_event_count, 5);
    assert_eq!(saved.turns.as_ref().unwrap()[4].model, "gpt-6-astra");
    assert_eq!(activity_rows(&connection), original_activity);
    assert_eq!(db::save_sessions(&mut connection, &[suffix.clone()]).unwrap(), 0);
    assert_eq!(db::get_session(&connection, "local", "regression").unwrap().tokens, saved.tokens);
    // A conflicting overlap must never overwrite retained observations.
    suffix.turns.as_mut().unwrap()[0].tokens.total_tokens += 1;
    assert_eq!(db::save_sessions(&mut connection, &[suffix]).unwrap(), 1);
    assert_eq!(db::get_session(&connection, "local", "regression").unwrap().tokens, saved.tokens);
    // A later segment with no overlap can still be appended without losing history.
    let mut next = saved.clone();
    next.turns = Some(vec![saved.turns.unwrap()[4].clone()]);
    next.turns.as_mut().unwrap()[0].timestamp = "2026-10-07T02:00:00Z".into();
    next.tokens = next.turns.as_ref().unwrap()[0].tokens.clone(); next.token_event_count = 1;
    next.ended_at = "2026-10-07T02:00:00Z".into();
    let mut incomplete = next.clone(); incomplete.scan_complete = false;
    assert_eq!(db::save_sessions(&mut connection, &[incomplete]).unwrap(), 1);
    let mut cumulative = next.clone();
    cumulative.turns.as_mut().unwrap()[0].tokens = TokenBreakdown { total_tokens: 1000, ..TokenBreakdown::default() };
    cumulative.tokens = cumulative.turns.as_ref().unwrap()[0].tokens.clone();
    assert_eq!(db::save_sessions(&mut connection, &[cumulative]).unwrap(), 1);
    assert_eq!(db::save_sessions(&mut connection, &[next]).unwrap(), 0);
    assert_eq!(db::get_session(&connection, "local", "regression").unwrap().tokens.total_tokens, 705);
}

#[test]
fn conflicting_early_history_does_not_block_independent_new_requests() {
    let root = temp(); let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
    let original = parse_session(Cursor::new(activity_fixture()), "ssh-test", "Remote", "ssh").unwrap();
    db::save_sessions(&mut connection, &[original.clone()]).unwrap();
    let activity = activity_rows(&connection);
    let mut changed = original.clone();
    changed.turns.as_mut().unwrap()[0].tokens.total_tokens += 5;
    let mut newer = original.turns.as_ref().unwrap()[0].clone();
    newer.timestamp = "2026-10-07T01:00:00Z".into(); newer.model = "gpt-6-astra".into();
    changed.turns.as_mut().unwrap().push(newer);
    changed.token_event_count += 1; changed.ended_at = "2026-10-07T01:00:00Z".into();
    changed.tokens = TokenBreakdown::default();
    for turn in changed.turns.as_ref().unwrap() { changed.tokens.add_assign(&turn.tokens); }
    for _ in 0..2 {
        assert_eq!(db::save_sessions(&mut connection, &[changed.clone()]).unwrap(), 1);
        let saved = db::get_session(&connection, "ssh-test", "regression").unwrap();
        assert_eq!(saved.tokens.total_tokens, 595);
        assert_eq!(saved.token_event_count, 5);
        assert_eq!(saved.turns.as_ref().unwrap()[0].tokens, original.turns.as_ref().unwrap()[0].tokens);
        assert_eq!(saved.turns.unwrap()[4].model, "gpt-6-astra");
        assert_eq!(activity_rows(&connection), activity);
    }
}

fn activity_rows(connection: &rusqlite::Connection) -> Vec<(String, String, i64)> {
    connection.prepare("SELECT kind,name,count FROM session_activity ORDER BY kind,name").unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap()
        .collect::<Result<Vec<_>, _>>().unwrap()
}

fn corrected_cloud_copy(mut session: SessionAggregate) -> SessionAggregate {
    session.activity = SessionActivity::default();
    let tokens = &mut session.turns.as_mut().unwrap()[0].tokens;
    tokens.input_tokens -= 30;
    tokens.cached_input_tokens = 20;
    tokens.output_tokens = 30;
    tokens.reasoning_output_tokens = 10;
    session.tokens = TokenBreakdown::default();
    for turn in session.turns.as_ref().unwrap() { session.tokens.add_assign(&turn.tokens); }
    session
}

#[test]
fn cloud_download_preserves_local_and_ssh_activity_when_unchanged_logs_are_skipped() {
    use crate::cloud_store::{Download, merge};
    use sha2::{Digest, Sha256};
    let user = "00000000-0000-0000-0000-000000000001";
    let key = format!("{:x}", Sha256::digest(format!("{user}:regression").as_bytes()));
    for kind in ["local", "ssh"] {
        let root = temp();
        std::fs::create_dir(root.join("sessions")).unwrap();
        std::fs::write(root.join("sessions/activity.jsonl"), activity_fixture()).unwrap();
        let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
        let source = if kind == "local" { "local" } else { "ssh-test" };
        if kind == "local" {
            crate::scanner::scan_local(&root, &mut connection, false).unwrap();
        } else {
            let session = parse_session(Cursor::new(activity_fixture()), source, "Remote", kind).unwrap();
            db::save_sessions(&mut connection, &[session]).unwrap();
        }
        let activity = activity_rows(&connection);
        assert_eq!(activity, vec![("effort".into(), "high".into(), 1), ("plugin".into(), "Browser".into(), 1), ("skill".into(), "frontend-craft".into(), 1)]);
        let original = db::get_session(&connection, source, "regression").unwrap();
        let incoming = corrected_cloud_copy(original.clone());
        assert_eq!(incoming.tokens.total_tokens, original.tokens.total_tokens);
        for _ in 0..2 {
            merge(&mut connection, user, vec![Download { session_key: key.clone(), session: incoming.clone() }]).unwrap();
            assert_eq!(db::get_session(&connection, source, "regression").unwrap().tokens, incoming.tokens);
            assert_eq!(activity_rows(&connection), activity);
        }
        if kind == "local" {
            assert!(crate::scanner::scan_local(&root, &mut connection, false).unwrap().sessions.is_empty());
            assert_eq!(activity_rows(&connection), activity);
        }
        // An authoritative log scan may still remove activity that no longer exists.
        db::save_sessions(&mut connection, &[incoming]).unwrap();
        assert!(activity_rows(&connection).is_empty());
    }
}

#[test]
fn cloud_reconciliation_preserves_activity_when_a_download_later_becomes_local() {
    use crate::cloud_store::{Download, merge, reconcile};
    use sha2::{Digest, Sha256};
    let root = temp();
    let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
    let user = "00000000-0000-0000-0000-000000000001";
    let key = format!("{:x}", Sha256::digest(format!("{user}:regression").as_bytes()));
    let local = parse_session(Cursor::new(activity_fixture()), "local", "Local", "local").unwrap();
    let incoming = corrected_cloud_copy(local.clone());
    merge(&mut connection, user, vec![Download { session_key: key, session: incoming.clone() }]).unwrap();
    assert!(activity_rows(&connection).is_empty());
    db::save_sessions(&mut connection, &[local]).unwrap();
    let activity = activity_rows(&connection);
    assert_eq!(activity.len(), 3);
    reconcile(&mut connection).unwrap();
    assert_eq!(activity_rows(&connection), activity);
    assert_eq!(db::get_session(&connection, "local", "regression").unwrap().tokens, incoming.tokens);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
}

#[cfg(windows)]
#[test]
fn windows_writer_lock_and_python_match_rust_and_report_partial_lines() {
    let root=temp(); std::fs::create_dir(root.join("sessions")).unwrap();
    let path=root.join("sessions/active.jsonl");
    std::fs::write(&path,fixture()+&model_switch_fixture()+"{partial\n").unwrap();
    let _writer=std::fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
    // Exact production invocation, deliberately without a trailing blank line.
    // The previous -Command - test added a blank line and hid the real SSH bug.
    let script=format!("$SinceIso = ''\n$CodexHome = '{}'\n{}",root.display(),include_str!("remote_scan.ps1"));
    let command = crate::ssh::windows_script_command(script.len());
    let output=bounded_output(std::process::Command::new("powershell.exe").args(command.split_whitespace().skip(1)),script.into_bytes(),Duration::from_secs(45)).unwrap();
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let rows:Vec<serde_json::Value>=String::from_utf8(output.stdout).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).collect();
    assert_eq!(rows.len(),2);
    let remote:SessionAggregate=serde_json::from_value(rows[0].clone()).unwrap();
    let local=parse_session(Cursor::new(fixture()+&model_switch_fixture()+"{partial\n"),"local","Local","local").unwrap();
    assert_eq!(remote.tokens,local.tokens);
    assert!(!remote.scan_complete);
    assert_eq!(rows[1]["scanSummary"]["skippedFiles"],1);
    let script=format!("SINCE_ISO = ''\nCODEX_HOME = {}\n{}",serde_json::to_string(&root.to_string_lossy()).unwrap(),include_str!("remote_scan.py"));
    let output=bounded_output(std::process::Command::new("python").arg("-").env("PYTHONIOENCODING", "cp1252"),script.into_bytes(),Duration::from_secs(20)).unwrap();
    assert!(output.status.success(), "Python exited with {}: {}", output.status, String::from_utf8_lossy(&output.stderr));
    assert!(output.stdout.is_ascii());
    let text=String::from_utf8(output.stdout).unwrap();
    let python:SessionAggregate=serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(python.tokens,remote.tokens);
    assert_eq!(python.turns.unwrap().iter().map(|t| &t.tokens).collect::<Vec<_>>(),remote.turns.unwrap().iter().map(|t| &t.tokens).collect::<Vec<_>>());
}

#[test]
fn concurrent_streaming_sources_commit_without_lost_sessions_or_busy_snapshots() {
    let root = temp(); let path = root.join("usage.sqlite3");
    db::open(&path).unwrap();
    let barrier = std::sync::Barrier::new(3);
    std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..3).map(|index| {
            let path = &path; let barrier = &barrier;
            scope.spawn(move || {
                let mut connection = db::open(path).unwrap();
                let mut session = parse_session(Cursor::new(fixture()), &format!("remote-{index}"), "Remote", "ssh").unwrap();
                barrier.wait();
                for serial in 0..20 {
                    session.session_id = format!("session-{serial}");
                    db::save_sessions(&mut connection, &[session.clone()]).unwrap();
                }
            })
        }).collect();
        for job in jobs { job.join().unwrap(); }
    });
    let connection = db::open(&path).unwrap();
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 60);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM turns", [], |row| row.get::<_, i64>(0)).unwrap(), 240);
}
