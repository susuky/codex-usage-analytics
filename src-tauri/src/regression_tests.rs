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

fn subagent_fixture() -> String {
    let records = [
        json!({"type":"session_meta","timestamp":"2026-10-13T01:00:00Z","payload":{"id":"child","timestamp":"2026-10-13T01:00:00Z","cwd":"C:/child","originator":"child-origin","subagent_history_start_ordinal":6}}),
        json!({"type":"session_meta","ordinal":1,"timestamp":"2026-10-12T01:00:00Z","payload":{"id":"parent","cwd":"C:/parent","originator":"parent-origin"}}),
        json!({"type":"turn_context","ordinal":2,"payload":{"model":"old-model","effort":"low"}}),
        json!({"type":"event_msg","ordinal":3,"timestamp":"2026-10-12T01:00:01Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":999,"total_tokens":999},"total_token_usage":{"input_tokens":999,"total_tokens":999}}}}),
        json!({"type":"response_item","ordinal":4,"payload":{"type":"custom_tool_call","name":"exec","input":"cat /skills/copied-parent-skill/SKILL.md"}}),
        json!({"type":"event_msg","ordinal":6,"payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-sol","service_tier":"fast"}}}),
        json!({"type":"turn_context","ordinal":7,"payload":{"model":"gpt-5.6-sol","effort":"high"}}),
        json!({"type":"event_msg","ordinal":8,"timestamp":"2026-10-13T01:00:01Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":110,"total_tokens":110},"total_token_usage":{"input_tokens":110,"total_tokens":110}}}}),
        json!({"type":"event_msg","ordinal":9,"timestamp":"2026-10-13T01:00:02Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":220,"total_tokens":220},"total_token_usage":{"input_tokens":330,"total_tokens":330}}}}),
    ];
    records.into_iter().map(|r| r.to_string()+"\n").collect()
}

#[test]
fn subagent_identity_and_owned_history_match_all_scanners() {
    let root = temp(); std::fs::create_dir(root.join("sessions")).unwrap();
    let log = subagent_fixture();
    std::fs::write(root.join("sessions/child.jsonl"), &log).unwrap();
    let local = parse_session(Cursor::new(&log), "local", "Local", "local").unwrap();
    let mut results = vec![local];
    let python = format!("SINCE_ISO = ''\nCODEX_HOME = {}\n{}", serde_json::to_string(&root.to_string_lossy()).unwrap(), include_str!("remote_scan.py"));
    let mut scripts = vec![("python", python)];
    if cfg!(windows) { scripts.push(("powershell.exe", format!("$SinceIso = ''\n$CodexHome = '{}'\n{}", root.display(), include_str!("remote_scan.ps1")))); }
    for (program, script) in scripts {
        let mut command = std::process::Command::new(program);
        if program == "python" { command.arg("-"); }
        else { command.args(crate::ssh::windows_script_command(script.len()).split_whitespace().skip(1)); }
        let output = bounded_output(&mut command, script.into_bytes(), Duration::from_secs(45)).unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        results.push(serde_json::from_str::<SessionAggregate>(String::from_utf8_lossy(&output.stdout).lines().next().unwrap()).unwrap());
    }
    for parsed in results {
        assert_eq!(parsed.session_id, "child");
        assert_eq!(parsed.started_at, "2026-10-13T01:00:00Z");
        assert_eq!(parsed.project, "child");
        assert_eq!(parsed.origin, "child-origin");
        assert_eq!(parsed.tokens.total_tokens, 330);
        assert_eq!(parsed.token_event_count, 2);
        assert!(parsed.activity.skills.is_empty());
        assert_eq!(parsed.activity.efforts[0].name, "high");
        assert!(parsed.turns.unwrap().iter().all(|t| t.service_tier == "priority" && t.model == "gpt-5.6-sol"));
        let identity = parsed.import_identity.unwrap();
        assert_eq!(identity.legacy_session_id, "parent");
        assert_eq!(identity.excluded_turns[0].total_tokens, 999);
    }
    // Older logs without ordinals still retain usage and their first identity.
    let old: String = log.lines().map(|line| { let mut v: serde_json::Value = serde_json::from_str(line).unwrap(); v.as_object_mut().unwrap().remove("ordinal"); v.to_string()+"\n" }).collect();
    let old = parse_session(Cursor::new(old), "local", "Local", "local").unwrap();
    assert_eq!(old.session_id, "child");
    assert_eq!(old.tokens.total_tokens, 1329);
    assert!(!old.scan_complete);
}

#[test]
fn subagent_upgrade_reassigns_legacy_usage_without_loss_or_double_counting() {
    let root = temp(); let path = root.join("usage.sqlite3");
    std::fs::create_dir(root.join("sessions")).unwrap();
    let child_log = subagent_fixture();
    std::fs::write(root.join("sessions/child.jsonl"), &child_log).unwrap();
    let child = parse_session(Cursor::new(&child_log), "local", "Local", "local").unwrap();
    let parent_log = fixture().replace("regression", "parent");
    std::fs::write(root.join("sessions/parent.jsonl"), &parent_log).unwrap();
    let mut connection = db::open(&path).unwrap();
    let mut wrong_parent = child.clone(); wrong_parent.session_id = "parent".into(); wrong_parent.import_identity = None;
    db::save_sessions(&mut connection, &[wrong_parent.clone()]).unwrap();
    // Also simulate a child stored with copied input before the ordinal fix.
    let mut wrong_child = parse_session(Cursor::new(child_log.replace("subagent_history_start_ordinal", "unused_boundary")), "local", "Local", "local").unwrap();
    wrong_child.import_identity = None;
    db::save_sessions(&mut connection, &[wrong_child.clone()]).unwrap();
    connection.execute("INSERT INTO file_checkpoints VALUES('old-checkpoint',123,'unchanged')", []).unwrap();
    connection.execute("DELETE FROM settings WHERE key='data_revision:subagent-identity-v1'", []).unwrap();
    drop(connection);
    let mut connection = db::open(&path).unwrap();
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM file_checkpoints", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
    let batch = crate::scanner::scan_local(&root, &mut connection, false).unwrap();
    assert_eq!(batch.skipped_files, 0);
    assert_eq!(db::get_session(&connection,"local","child").unwrap().tokens.total_tokens, 330);
    assert_eq!(db::get_session(&connection,"local","parent").unwrap().tokens.total_tokens, 485);
    assert!(!crate::import_repair::pending(&connection,"local").unwrap());
    // Cloud snapshots produced by the old parser cannot resurrect wrong ownership.
    db::save_cloud_sessions(&mut connection, &[wrong_parent, wrong_child]).unwrap();
    assert_eq!(db::get_session(&connection,"local","child").unwrap().tokens.total_tokens, 330);
    assert_eq!(db::get_session(&connection,"local","parent").unwrap().tokens.total_tokens, 485);
    assert!(crate::scanner::scan_local(&root, &mut connection, false).unwrap().sessions.is_empty());
    crate::scanner::scan_local(&root, &mut connection, true).unwrap();
    assert_eq!(connection.query_row("SELECT SUM(total_tokens) FROM sessions", [], |r| r.get::<_,i64>(0)).unwrap(), 815);
    // An unmatched old observation must survive without blocking earlier own work.
    let mut orphan = child.clone(); orphan.import_identity = None;
    orphan.turns.as_mut().unwrap()[0].timestamp = "2026-10-13T01:00:01.500Z".into();
    connection.execute("DELETE FROM sessions WHERE session_id='child'", []).unwrap();
    connection.execute("DELETE FROM turns WHERE session_id='child'", []).unwrap();
    db::save_sessions(&mut connection, &[orphan]).unwrap();
    db::save_sessions(&mut connection, &[child.clone()]).unwrap();
    let recovered = db::get_session(&connection,"local","child").unwrap();
    assert_eq!(recovered.tokens.total_tokens, 440);
    assert_eq!(recovered.token_event_count, 3);
    db::save_sessions(&mut connection, &[child]).unwrap();
    assert_eq!(db::get_session(&connection,"local","child").unwrap().tokens.total_tokens, 440);
}

#[test]
fn subagent_repair_requires_complete_saved_evidence_and_stays_within_its_source() {
    let root = temp(); let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
    let child = parse_session(Cursor::new(subagent_fixture()), "local", "Local", "local").unwrap();
    let mut legacy = child.clone(); legacy.session_id = "parent".into(); legacy.import_identity = None;
    let mut remote = legacy.clone(); remote.source_id = "ssh-other".into(); remote.source_kind = "ssh".into();
    db::save_sessions(&mut connection, &[legacy.clone(), remote]).unwrap();
    let mut damaged = child.clone(); damaged.scan_complete = false;
    assert_eq!(db::save_sessions(&mut connection, &[damaged]).unwrap(), 1);
    assert!(db::get_session(&connection,"local","child").is_err());
    assert_eq!(db::get_session(&connection,"local","parent").unwrap().tokens.total_tokens, 330);
    // A rejected earlier conflicting child observation must never be moved.
    let mut saved_child = child.clone(); saved_child.import_identity = None;
    saved_child.turns.as_mut().unwrap()[0].tokens.input_tokens = 111;
    saved_child.turns.as_mut().unwrap()[0].tokens.total_tokens = 111;
    saved_child.tokens.input_tokens += 1; saved_child.tokens.total_tokens += 1;
    db::save_sessions(&mut connection, &[saved_child]).unwrap();
    db::save_sessions(&mut connection, &[child]).unwrap();
    assert_eq!(db::get_session(&connection,"local","parent").unwrap().tokens.total_tokens, 330);
    assert_eq!(db::get_session(&connection,"ssh-other","parent").unwrap().tokens.total_tokens, 330);
}

#[test]
fn incomplete_new_child_does_not_abort_other_local_imports() {
    let root=temp();std::fs::create_dir(root.join("sessions")).unwrap();
    let mut lines:Vec<serde_json::Value>=subagent_fixture().lines().map(|line|serde_json::from_str(line).unwrap()).collect();
    lines[7].as_object_mut().unwrap().remove("ordinal");
    std::fs::write(root.join("sessions/child.jsonl"),lines.iter().map(|line|line.to_string()+"\n").collect::<String>()).unwrap();
    std::fs::write(root.join("sessions/parent.jsonl"),fixture()).unwrap();
    let mut connection=db::open(&root.join("usage.sqlite3")).unwrap();
    let result=crate::scanner::scan_local(&root,&mut connection,false).unwrap();
    assert_eq!(result.skipped_files,1);
    assert_eq!(result.sessions.len(),1);
    assert_eq!(db::get_session(&connection,"local","regression").unwrap().tokens.total_tokens,485);
    assert!(db::get_session(&connection,"local","child").is_err());
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
fn daily_session_tokens_and_costs_match_overview_across_dates_models_and_sources() {
    use chrono::{Local, NaiveDate, SecondsFormat, TimeZone, Utc};
    let root = temp(); let path = root.join("usage.sqlite3");
    let mut connection = db::open(&path).unwrap();
    let mut settings = AppSettings::default();
    let mut astra = settings.pricing_rules[0].clone();
    astra.model = "gpt-6-astra".into(); astra.input_usd_per_million = 1.0;
    settings.pricing_rules.push(astra);
    db::save_settings(&connection, &settings).unwrap();
    let midnight = Local.from_local_datetime(&NaiveDate::from_ymd_opt(2026, 9, 6).unwrap().and_hms_opt(0, 0, 0).unwrap()).earliest().unwrap();
    let timestamp = |seconds| (midnight + chrono::Duration::seconds(seconds)).with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
    let log = |records: &[(i64, &str, i64)]| {
        let mut lines = vec![json!({"type":"session_meta","timestamp":timestamp(records[0].0),"payload":{"id":"daily-models","cwd":"C:/daily-test"}})];
        for (second, model, total) in records {
            lines.push(json!({"type":"turn_context","payload":{"model":model}}));
            lines.push(json!({"type":"event_msg","timestamp":timestamp(*second),"payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":total,"total_tokens":total}}}}));
        }
        lines.into_iter().map(|line| line.to_string()+"\n").collect::<String>()
    };
    let local = parse_session(Cursor::new(log(&[(-1,"gpt-6-astra",1000),(0,"gpt-5.6-sol",200),(3600,"gpt-6-astra",300),(86399,"unknown-model",50),(86400,"gpt-6-astra",900)])), "local", "Local", "local").unwrap();
    let remote = parse_session(Cursor::new(log(&[(7200,"gpt-6-astra",400)])), "ssh-test", "Remote", "ssh").unwrap();
    let mut gap = parse_session(Cursor::new(log(&[(-1,"gpt-6-astra",500),(86400,"gpt-6-astra",500)])), "local", "Local", "local").unwrap();
    gap.session_id = "no-usage-on-selected-day".into();
    db::save_sessions(&mut connection, &[local, remote, gap]).unwrap();
    let day = UsageFilter { days: 1, start_date: Some("2026-09-06".into()), end_date: Some("2026-09-06".into()), source_id: None, model: None, project: None };
    for (filter, expected_tokens, expected_cost, expected_sessions) in [
        (day.clone(), 950, 1500, 2),
        (UsageFilter { model: Some("gpt-6-astra".into()), ..day.clone() }, 700, 700, 2),
        (UsageFilter { model: Some("gpt-6-astra".into()), source_id: Some("local".into()), ..day.clone() }, 300, 300, 1),
        (UsageFilter { project: Some("absent".into()), ..day.clone() }, 0, 0, 0),
        (UsageFilter { start_date: Some("2026-09-05".into()), ..day.clone() }, 2450, 3000, 3),
    ] {
        let overview = crate::overview_for_path(&path, filter.clone()).unwrap();
        let sessions = db::list_sessions(&connection, &filter).unwrap();
        assert_eq!(sessions.len(), expected_sessions);
        assert_eq!(sessions.iter().map(|session| session.tokens.total_tokens).sum::<i64>(), expected_tokens);
        assert_eq!(sessions.iter().filter_map(|session| session.estimate_microusd).sum::<i64>(), expected_cost);
        assert_eq!(overview.totals.total_tokens, expected_tokens);
        assert_eq!(overview.estimate_microusd, expected_cost);
        assert_eq!(overview.daily.iter().map(|day| day.estimate_microusd).sum::<i64>(), expected_cost);
        assert_eq!(overview.daily.iter().map(|day| day.unpriced_tokens).sum::<i64>(), sessions.iter().map(|session| session.unpriced_tokens).sum::<i64>());
        assert_eq!(overview.models.iter().map(|model| model.tokens.total_tokens).sum::<i64>(), expected_tokens);
        if let Some(model) = filter.model { assert!(sessions.iter().all(|session| session.model == model)); }
    }
    let sessions = db::list_sessions(&connection, &day).unwrap();
    let local = sessions.iter().find(|session| session.source_id == "local").unwrap();
    assert_eq!(local.model, "多個模型");
    assert_eq!(local.unpriced_turn_count, 1);
    assert_eq!(local.unpriced_tokens, 50);
    assert_eq!(local.token_event_count, 3);
    assert_eq!(local.started_at, timestamp(0));
    assert_eq!(local.ended_at, timestamp(86399));
    let unknown = db::list_sessions(&connection, &UsageFilter { model: Some("unknown-model".into()), ..day }).unwrap();
    assert_eq!(unknown[0].estimate_microusd, None);
    assert_eq!(unknown[0].tokens.total_tokens, 50);
    let complete = db::get_session(&connection, "local", "daily-models").unwrap();
    assert_eq!(complete.tokens.total_tokens, 2450);
    assert_eq!(complete.turns.as_ref().unwrap().len(), 5);
    let snapshots = db::list_sync_sessions(&connection).unwrap();
    let snapshot = snapshots.iter().find(|session| session.source_id == "local" && session.session_id == "daily-models").unwrap();
    assert_eq!(snapshot.tokens, complete.tokens);
    assert_eq!(snapshot.model, complete.model);
    assert_eq!(snapshot.ended_at, complete.ended_at);
    assert_eq!(snapshot.token_event_count, complete.token_event_count);
    assert_eq!(snapshot.estimate_microusd, complete.estimate_microusd);
    assert_eq!(snapshot.unpriced_tokens, complete.unpriced_tokens);
}

#[test]
fn project_timeline_combines_each_usage_across_sessions_and_matches_overview_filters() {
    use chrono::{Local, NaiveDate, SecondsFormat, TimeZone, Utc};
    let root = temp(); let path = root.join("usage.sqlite3");
    let mut connection = db::open(&path).unwrap();
    let midnight = Local.from_local_datetime(&NaiveDate::from_ymd_opt(2026, 9, 6).unwrap().and_hms_opt(0, 0, 0).unwrap()).earliest().unwrap();
    let timestamp = |seconds| (midnight + chrono::Duration::seconds(seconds)).with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
    let session = |source: &str, id: &str, project: &str, records: &[(i64, &str, i64, i64, i64, i64)]| {
        let mut lines = vec![json!({"type":"session_meta","timestamp":timestamp(records[0].0),"payload":{"id":id,"cwd":format!("C:/{project}")}})];
        for &(second, model, input, output, reasoning, total) in records {
            lines.push(json!({"type":"turn_context","payload":{"model":model}}));
            lines.push(json!({"type":"event_msg","timestamp":timestamp(second),"payload":{"type":"token_count","info":{"last_token_usage":{
                "input_tokens":input,"cached_input_tokens":input/2,"cache_write_input_tokens":input/10,
                "output_tokens":output,"reasoning_output_tokens":reasoning,"total_tokens":total
            }}}}));
        }
        parse_session(Cursor::new(lines.into_iter().map(|line| line.to_string()+"\n").collect::<String>()), source, source, if source == "local" { "local" } else { "ssh" }).unwrap()
    };
    db::save_sessions(&mut connection, &[
        session("local", "first", "timeline-project", &[(-1,"gpt-5.6-sol",1000,100,30,1100),(3600,"gpt-5.6-sol",100,10,3,115),(10800,"gpt-5.6-luna",200,20,7,220),(86400,"gpt-5.6-sol",900,90,50,990)]),
        session("ssh-test", "second", "timeline-project", &[(7200,"gpt-5.6-sol",300,30,11,330),(10800,"gpt-5.6-sol",400,40,17,440)]),
        session("local", "third", "timeline-project", &[(7200,"gpt-5.6-sol",50,5,2,55)]),
        session("local", "other", "other-project", &[(5400,"gpt-5.6-sol",5000,500,50,5500)]),
    ]).unwrap();
    let day = UsageFilter { days: 1, start_date: Some("2026-09-06".into()), end_date: Some("2026-09-06".into()), source_id: None, model: None, project: Some("timeline-project".into()) };
    for (filter, expected_total, expected_points) in [
        (day.clone(), 1160, 3),
        (UsageFilter { source_id: Some("local".into()), ..day.clone() }, 390, 3),
        (UsageFilter { model: Some("gpt-5.6-sol".into()), ..day.clone() }, 940, 3),
        (UsageFilter { source_id: Some("local".into()), model: Some("gpt-5.6-sol".into()), ..day.clone() }, 170, 2),
        (UsageFilter { project: Some("other-project".into()), ..day.clone() }, 5500, 1),
        (UsageFilter { project: Some("absent".into()), ..day.clone() }, 0, 0),
        (UsageFilter { start_date: Some("2026-09-05".into()), end_date: Some("2026-09-07".into()), ..day.clone() }, 3250, 5),
    ] {
        let points = db::project_timeline(&connection, &filter).unwrap();
        let detail = crate::project_detail_for_path(&path, filter).unwrap();
        assert_eq!(points, detail.timeline);
        let overview = detail.overview;
        assert_eq!(points.len(), expected_points);
        assert!(points.windows(2).all(|pair| pair[0].timestamp <= pair[1].timestamp));
        assert_eq!(points.last().map_or(0, |point| point.total), expected_total);
        let totals = overview.totals;
        assert_eq!(points.last().map(|point| (point.total, point.input, point.output, point.reasoning)).unwrap_or_default(),
            (totals.total_tokens, totals.input_tokens, totals.output_tokens, totals.reasoning_output_tokens));
    }
    let points = db::project_timeline(&connection, &day).unwrap();
    let millis = |seconds| chrono::DateTime::parse_from_rfc3339(&timestamp(seconds)).unwrap().timestamp_millis();
    assert_eq!(points.iter().map(|point| point.timestamp).collect::<Vec<_>>(), vec![millis(3600),millis(7200),millis(10800)]);
    assert_eq!(points.iter().map(|point| point.total).collect::<Vec<_>>(), vec![115,500,1160]);
    assert_eq!((points.last().unwrap().total, points.last().unwrap().input, points.last().unwrap().output, points.last().unwrap().reasoning), (1160,1050,105,40));
}

#[test]
fn project_timeline_orders_actual_instants_and_reports_invalid_usage_times() {
    let root = temp(); let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
    let mut parsed = parse_session(Cursor::new(fixture()), "local", "Local", "local").unwrap();
    let turns = parsed.turns.as_mut().unwrap();
    turns.truncate(2);
    turns[0].timestamp = "2026-09-06T02:00:00Z".into();
    turns[1].timestamp = "2026-09-06T09:00:00+08:00".into();
    db::save_sessions(&mut connection, &[parsed]).unwrap();
    let filter = UsageFilter { days: 36500, start_date: None, end_date: None, source_id: None, model: None, project: Some("test".into()) };
    let points = db::project_timeline(&connection, &filter).unwrap();
    assert_eq!(points.iter().map(|point| point.timestamp).collect::<Vec<_>>(), vec![1788656400000,1788660000000]);
    assert_eq!(points.iter().map(|point| point.total).collect::<Vec<_>>(), vec![220,330]);
    connection.execute("UPDATE turns SET timestamp='not-a-timestamp' WHERE ordinal=1", []).unwrap();
    assert!(db::project_timeline(&connection, &filter).unwrap_err().contains("有效時間"));
}

#[test]
fn project_detail_keeps_overview_and_timeline_in_the_same_read_snapshot() {
    let root = temp(); let path = root.join("usage.sqlite3");
    let mut reader = db::open(&path).unwrap();
    let mut first = parse_session(Cursor::new(fixture()), "local", "Local", "local").unwrap();
    db::save_sessions(&mut reader, &[first.clone()]).unwrap();
    let mut writer = db::open(&path).unwrap();
    let filter = UsageFilter { days: 36500, start_date: None, end_date: None, source_id: None, model: None, project: Some("test".into()) };
    let transaction = reader.transaction().unwrap();
    let overview = crate::overview_for_connection(&transaction, &filter).unwrap();
    first.session_id = "arrived-during-read".into();
    db::save_sessions(&mut writer, &[first]).unwrap();
    let timeline = db::project_timeline(&transaction, &filter).unwrap();
    assert_eq!(overview.totals.total_tokens, 485);
    assert_eq!(timeline.last().unwrap().total, overview.totals.total_tokens);
    assert_eq!(crate::overview_for_connection(&writer, &filter).unwrap().totals.total_tokens, 970);
    drop(transaction);
    let detail = crate::project_detail_for_path(&path, filter).unwrap();
    assert_eq!(detail.overview.totals.total_tokens, 970);
    assert_eq!(detail.timeline.last().unwrap().total, 970);
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
fn imported_older_copies_are_quiet_but_conflicting_or_incomplete_snapshots_are_retained() {
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
    let mut source=UsageSource { id:"ssh-test".into(),name:"Test".into(),kind:"ssh".into(),target:None,enabled:false,stale:true,last_scanned_at:Some("2026-09-05T00:00:00Z".into()),last_error:Some("offline".into()),last_notice:None,session_count:0,latest_data_at:None };
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
    merge(&mut connection,user,vec![Download{prefer_local:false,session_key:key.clone(),session:original.clone()}]).unwrap();
    let mut local=original.clone();
    local.turns.as_mut().unwrap().iter_mut().for_each(|t|t.timestamp=t.timestamp.replace('Z',"+00:00"));
    db::save_sessions(&mut connection,&[local.clone()]).unwrap();
    reconcile(&mut connection).unwrap();
    let count:i64=connection.query_row("SELECT COUNT(*) FROM sessions",[],|row|row.get(0)).unwrap();
    assert_eq!(count,1);
    let mut short=original.clone(); short.turns.as_mut().unwrap().truncate(1); short.token_event_count=1; short.tokens=short.turns.as_ref().unwrap()[0].tokens.clone();
    merge(&mut connection,user,vec![Download{prefer_local:false,session_key:key,session:short}]).unwrap();
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

fn effort_settings_fixture() -> String {
    let mut records = vec![json!({"type":"session_meta","timestamp":"2026-10-15T01:00:00Z","payload":{"id":"efforts","cwd":"C:/test"}})];
    let settings = [
        None,
        Some(json!({"type":"turn_context","payload":{"model":"gpt-5.6-sol","collaboration_mode":{"settings":{"reasoning_effort":" high "}}}})),
        Some(json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"reasoning_effort":"max"}}})),
        Some(json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"reasoning_effort":null,"collaboration_mode":{"settings":{"reasoning_effort":"ultra"}}}}})),
        Some(json!({"type":"turn_context","payload":{"effort":" xhigh ","reasoning_effort":"low","collaboration_mode":{"settings":{"reasoning_effort":"medium"}}}})),
        Some(json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"priority","collaboration_mode":"legacy"}}})),
        Some(json!({"type":"turn_context","payload":{"reasoning_effort":"medium"}})),
    ];
    for (index, setting) in settings.into_iter().enumerate() {
        if let Some(setting) = setting { records.push(setting); }
        records.push(json!({"type":"event_msg","timestamp":format!("2026-10-15T01:00:{:02}Z",index+1),"payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"total_tokens":100}}}}));
    }
    records.into_iter().map(|record| record.to_string()+"\n").collect()
}

#[test]
fn recorded_effort_aliases_and_setting_switches_match_all_scanners() {
    let root=temp(); std::fs::create_dir(root.join("sessions")).unwrap();
    let log=effort_settings_fixture(); std::fs::write(root.join("sessions/efforts.jsonl"),&log).unwrap();
    let local=parse_session(Cursor::new(&log),"local","Local","local").unwrap();
    let mut results=vec![local];
    let python=format!("SINCE_ISO = ''\nCODEX_HOME = {}\n{}",serde_json::to_string(&root.to_string_lossy()).unwrap(),include_str!("remote_scan.py"));
    let mut scripts=vec![("python",python)];
    if cfg!(windows) { scripts.push(("powershell.exe",format!("$SinceIso = ''\n$CodexHome = '{}'\n{}",root.display(),include_str!("remote_scan.ps1")))); }
    for (program,script) in scripts {
        let mut command=std::process::Command::new(program);
        if program=="python" { command.arg("-"); } else { command.args(crate::ssh::windows_script_command(script.len()).split_whitespace().skip(1)); }
        let output=bounded_output(&mut command,script.into_bytes(),Duration::from_secs(45)).unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        results.push(serde_json::from_str::<SessionAggregate>(String::from_utf8_lossy(&output.stdout).lines().next().unwrap()).unwrap());
    }
    for parsed in &results {
        assert_eq!(parsed.tokens.total_tokens,700);
        assert_eq!(parsed.turns.as_ref().unwrap().iter().map(|turn| turn.reasoning_effort.as_str()).collect::<Vec<_>>(),["unknown","high","max","ultra","xhigh","xhigh","medium"]);
        assert_eq!(parsed.activity.efforts.iter().map(|item| (&item.name,item.count)).collect::<Vec<_>>(),results[0].activity.efforts.iter().map(|item| (&item.name,item.count)).collect::<Vec<_>>());
    }
}

#[test]
fn historical_effort_repair_preserves_amounts_activity_and_syncs_partial_segments() {
    let root=temp(); let mut connection=db::open(&root.join("usage.sqlite3")).unwrap();
    let raw=parse_session(Cursor::new(effort_settings_fixture()),"remote","Remote","ssh").unwrap();
    let mut legacy=raw.clone();
    for turn in legacy.turns.as_mut().unwrap() { turn.reasoning_effort="unknown".into(); }
    db::save_sessions(&mut connection,&[legacy]).unwrap();
    let before=db::get_session(&connection,"remote","efforts").unwrap();
    let activity: i64=connection.query_row("SELECT COUNT(*) FROM session_activity",[],|row|row.get(0)).unwrap();
    let mut prefix=raw.clone(); prefix.turns.as_mut().unwrap().truncate(3); prefix.token_event_count=3; prefix.tokens=TokenBreakdown::default();
    for turn in prefix.turns.as_ref().unwrap() { prefix.tokens.add_assign(&turn.tokens); }
    prefix.ended_at=prefix.turns.as_ref().unwrap().last().unwrap().timestamp.clone();
    assert_eq!(db::save_sessions(&mut connection,&[prefix.clone()]).unwrap(),0);
    let repaired=db::get_session(&connection,"remote","efforts").unwrap();
    assert_eq!(repaired.tokens,before.tokens); assert_eq!(repaired.token_event_count,before.token_event_count);
    assert_eq!(repaired.estimate_microusd,before.estimate_microusd);
    assert_ne!(repaired.sync_fingerprint,before.sync_fingerprint);
    assert_eq!(repaired.turns.as_ref().unwrap().iter().map(|turn|turn.reasoning_effort.as_str()).collect::<Vec<_>>(),["unknown","high","max","unknown","unknown","unknown","unknown"]);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM session_activity",[],|row|row.get::<_,i64>(0)).unwrap(),activity);
    db::save_sessions(&mut connection,&[prefix]).unwrap();
    assert_eq!(db::get_session(&connection,"remote","efforts").unwrap().sync_fingerprint,repaired.sync_fingerprint);
    let mut missing_again=raw.clone();
    for turn in missing_again.turns.as_mut().unwrap() { turn.reasoning_effort="unknown".into(); }
    db::save_sessions(&mut connection,&[missing_again]).unwrap();
    let saved=db::get_session(&connection,"remote","efforts").unwrap();
    assert_eq!(saved.turns.unwrap()[1].reasoning_effort,"high");
    assert_eq!(saved.tokens,before.tokens);
}

#[test]
fn effort_parser_upgrade_reparses_checkpointed_logs() {
    let root=temp(); let path=root.join("usage.sqlite3"); std::fs::create_dir(root.join("sessions")).unwrap();
    std::fs::write(root.join("sessions/efforts.jsonl"),effort_settings_fixture()).unwrap();
    let mut connection=db::open(&path).unwrap();
    crate::scanner::scan_local(&root,&mut connection,false).unwrap();
    assert!(crate::scanner::scan_local(&root,&mut connection,false).unwrap().sessions.is_empty());
    connection.execute("DELETE FROM settings WHERE key='data_revision:reasoning-effort-v1'",[]).unwrap(); drop(connection);
    let mut connection=db::open(&path).unwrap();
    assert_eq!(crate::scanner::scan_local(&root,&mut connection,false).unwrap().sessions.len(),1);
    assert!(crate::scanner::scan_local(&root,&mut connection,false).unwrap().sessions.is_empty());
}

#[test]
fn historical_effort_repair_ignores_ambiguous_and_incomplete_evidence() {
    let root=temp(); let mut connection=db::open(&root.join("usage.sqlite3")).unwrap();
    let mut legacy=parse_session(Cursor::new(effort_settings_fixture()),"remote","Remote","ssh").unwrap();
    for turn in legacy.turns.as_mut().unwrap() { turn.reasoning_effort="unknown".into(); }
    db::save_sessions(&mut connection,&[legacy.clone()]).unwrap();
    let before=db::get_session(&connection,"remote","efforts").unwrap();
    let mut candidate=legacy.clone(); candidate.turns.as_mut().unwrap().truncate(1);
    candidate.turns.as_mut().unwrap()[0].reasoning_effort="ultra".into();
    candidate.token_event_count=1; candidate.tokens=candidate.turns.as_ref().unwrap()[0].tokens.clone();
    candidate.ended_at=candidate.turns.as_ref().unwrap()[0].timestamp.clone();
    let mut ambiguous=candidate.clone();
    let mut duplicate=candidate.turns.as_ref().unwrap()[0].clone(); duplicate.ordinal=2; duplicate.reasoning_effort="low".into();
    ambiguous.turns.as_mut().unwrap().push(duplicate); ambiguous.token_event_count=2; ambiguous.tokens.add_assign(&candidate.tokens);
    let mut incomplete=candidate.clone(); incomplete.scan_complete=false;
    let mut other_model=candidate.clone(); other_model.turns.as_mut().unwrap()[0].model="other-model".into();
    for observation in [ambiguous,incomplete,other_model] {
        db::save_sessions(&mut connection,&[observation]).unwrap();
        let saved=db::get_session(&connection,"remote","efforts").unwrap();
        assert_eq!(saved.tokens,before.tokens);
        assert_eq!(saved.sync_fingerprint,before.sync_fingerprint);
        assert!(saved.turns.unwrap().iter().all(|turn| turn.reasoning_effort=="unknown"));
    }
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
fn retained_local_history_is_checkpointed_without_hiding_unreadable_logs() {
    let root = temp(); let path = root.join("usage.sqlite3");
    std::fs::create_dir(root.join("sessions")).unwrap();
    let log_path = root.join("sessions/retained.jsonl");
    std::fs::write(&log_path, fixture()).unwrap();
    let mut connection = db::open(&path).unwrap();
    crate::scanner::scan_local(&root, &mut connection, false).unwrap();
    let original = db::get_session(&connection, "local", "regression").unwrap();
    let compacted = [
        json!({"type":"session_meta","timestamp":"2026-09-05T01:00:00Z","payload":{"id":"regression","history_mode":"paginated"}}),
        json!({"type":"compacted","timestamp":"2026-09-05T01:00:00Z","payload":{}}),
        json!({"type":"event_msg","timestamp":"2026-09-05T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":485,"total_tokens":485},"last_token_usage":{"input_tokens":100,"total_tokens":100}}}}),
    ].into_iter().map(|line| line.to_string()+"\n").collect::<String>();
    let compacted = compacted + "\0\0\0\n";
    std::fs::write(&log_path, &compacted).unwrap();
    let scan = crate::scanner::scan_local(&root, &mut connection, false).unwrap();
    assert_eq!((scan.skipped_files, scan.retained_sessions), (0, 1));
    let saved = db::get_session(&connection, "local", "regression").unwrap();
    assert_eq!(saved.tokens, original.tokens);
    assert_eq!(saved.estimate_microusd, original.estimate_microusd);
    assert_eq!(serde_json::to_value(saved.turns).unwrap(), serde_json::to_value(&original.turns).unwrap());
    assert!(crate::scanner::scan_local(&root, &mut connection, false).unwrap().sessions.is_empty());
    std::fs::write(&log_path, compacted + "{broken\n").unwrap();
    for _ in 0..2 {
        let scan = crate::scanner::scan_local(&root, &mut connection, false).unwrap();
        assert_eq!(scan.skipped_files, 1);
        assert_eq!(db::get_session(&connection, "local", "regression").unwrap().tokens, original.tokens);
    }
}

#[test]
fn source_notice_upgrade_preserves_errors_until_a_successful_scan() {
    let root = temp(); let path = root.join("usage.sqlite3");
    let connection = db::open(&path).unwrap();
    let mut source = crate::source("local", "Local", "local", None, true);
    source.stale = true; source.last_error = Some("legacy scan warning".into());
    db::upsert_source(&connection, &source).unwrap();
    connection.execute("ALTER TABLE sources DROP COLUMN last_notice", []).unwrap();
    drop(connection);
    let connection = db::open(&path).unwrap();
    let mut source = db::list_sources(&connection).unwrap().remove(0);
    assert_eq!(source.last_error.as_deref(), Some("legacy scan warning"));
    assert_eq!(source.last_notice, None);
    crate::update_scan_status(&mut source, 0, 3, "2026-10-07T01:00:00Z");
    db::upsert_source(&connection, &source).unwrap();
    drop(connection);
    let connection = db::open(&path).unwrap();
    let mut source = db::list_sources(&connection).unwrap().remove(0);
    assert!(!source.stale);
    assert_eq!(source.last_error, None);
    assert_eq!(source.last_notice.as_deref(), Some("3 段對話的歷史用量已保留。"));
    assert_eq!(source.last_scanned_at.as_deref(), Some("2026-10-07T01:00:00Z"));
    crate::update_scan_status(&mut source, 1, 3, "2026-10-07T02:00:00Z");
    assert!(source.stale);
    assert!(source.last_error.unwrap().starts_with("1 份紀錄無法完整讀取"));
    assert_eq!(source.last_scanned_at.as_deref(), Some("2026-10-07T01:00:00Z"));
    assert!(source.last_notice.is_some());
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

#[test]
fn disjoint_segments_merge_in_any_order_without_double_counting_same_time_requests() {
    for reverse in [false, true] {
        let root = temp(); std::fs::create_dir(root.join("sessions")).unwrap();
        let original = fixture().lines().take(5).collect::<Vec<_>>().join("\n")+"\n";
        let lines: Vec<_> = original.lines().collect();
        let segments = [format!("{}\n{}\n{}\n",lines[0],lines[1],lines[2]),
            format!("{}\n{}\n{}\n{}\n",lines[0],lines[1],lines[3],lines[4])];
        for (index, segment) in segments.iter().enumerate() { std::fs::write(root.join(format!("sessions/{index}.jsonl")), segment).unwrap(); }
        let mut connection = db::open(&root.join("usage.sqlite3")).unwrap();
        let order = if reverse { [1,0,1,0] } else { [0,1,0,1] };
        for index in order {
            let parsed = parse_session(Cursor::new(&segments[index]), "local", "Local", "local").unwrap();
            assert_eq!(db::save_sessions(&mut connection, &[parsed]).unwrap(), 0);
        }
        assert_eq!(db::get_session(&connection,"local","regression").unwrap().tokens.total_tokens,385);
        crate::scanner::scan_local(&root,&mut connection,true).unwrap();
        let mut saved = db::get_session(&connection,"local","regression").unwrap();
        assert_eq!(saved.token_event_count,3);
        // Real logs can record distinct requests in the same millisecond.
        saved.turns.as_mut().unwrap()[1].timestamp=saved.turns.as_ref().unwrap()[0].timestamp.clone();
        let fresh=temp(); let mut other=db::open(&fresh.join("usage.sqlite3")).unwrap();
        db::save_sessions(&mut other,&[saved.clone()]).unwrap();
        let mut earlier=saved.clone(); earlier.turns.as_mut().unwrap().truncate(1);
        earlier.token_event_count=1; earlier.tokens=earlier.turns.as_ref().unwrap()[0].tokens.clone();
        db::save_sessions(&mut other,&[earlier]).unwrap();
        assert_eq!(db::get_session(&other,"local","regression").unwrap().token_event_count,3);
    }
}

#[test]
fn downloaded_removals_survive_restart_rescan_and_cloud_to_local_reconciliation() {
    use crate::cloud_store::{Download, merge, reconcile};
    use sha2::{Digest,Sha256};
    let user="00000000-0000-0000-0000-000000000001";
    let key=format!("{:x}",Sha256::digest(format!("{user}:regression").as_bytes()));
    let root=temp(); let path=root.join("usage.sqlite3");
    let mut connection=db::open(&path).unwrap();
    let old=parse_session(Cursor::new(activity_fixture()),"local","Local","local").unwrap();
    let mut correction=old.clone();
    let removed=correction.turns.as_mut().unwrap().remove(0);
    correction.excluded_usage.push(UsageIdentity{timestamp:removed.timestamp.clone(),total_tokens:removed.tokens.total_tokens});
    correction.tokens=TokenBreakdown::default();
    for (i,t) in correction.turns.as_mut().unwrap().iter_mut().enumerate(){t.ordinal=i as i64+1;correction.tokens.add_assign(&t.tokens);}
    correction.token_event_count-=1;
    merge(&mut connection,user,vec![Download{prefer_local:false,session_key:key.clone(),session:correction.clone()}]).unwrap();
    db::save_sessions(&mut connection,&[old.clone()]).unwrap();
    reconcile(&mut connection).unwrap();
    assert_eq!(db::get_session(&connection,"local","regression").unwrap().tokens,correction.tokens);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM sessions WHERE source_kind='cloud'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let before=db::get_session(&connection,"local","regression").unwrap();
    drop(connection);let mut connection=db::open(&path).unwrap();
    db::save_sessions(&mut connection,&[old.clone()]).unwrap();
    db::save_cloud_sessions(&mut connection,&[old]).unwrap();
    let saved=db::get_session(&connection,"local","regression").unwrap();
    assert_eq!(saved.tokens,correction.tokens);
    assert_eq!(saved.excluded_usage.len(),1);
    // Equal-total model/tier corrections still invalidate the upload queue.
    let mut changed=saved.clone();changed.turns.as_mut().unwrap()[0].reasoning_effort="medium".into();
    db::save_sessions(&mut connection,&[changed]).unwrap();
    assert_ne!(db::get_session(&connection,"local","regression").unwrap().sync_fingerprint,before.sync_fingerprint);
}

#[test]
fn download_before_upload_keeps_unsent_raw_model_and_fast_corrections() {
    use crate::cloud_store::{Download,merge};
    use sha2::{Digest,Sha256};
    let user="00000000-0000-0000-0000-000000000001";
    let key=format!("{:x}",Sha256::digest(format!("{user}:regression").as_bytes()));
    let root=temp();let mut connection=db::open(&root.join("usage.sqlite3")).unwrap();
    let mut current=parse_session(Cursor::new(fixture()),"local","Local","local").unwrap();
    current.turns.as_mut().unwrap()[0].service_tier="priority".into();
    db::save_sessions(&mut connection,&[current.clone()]).unwrap();
    let mut stale=current.clone();stale.turns.as_mut().unwrap()[0].service_tier="default".into();
    stale.turns.as_mut().unwrap()[0].model="older-model".into();
    for (version,prefer_local) in [(5,false),(6,true)] {
        stale.aggregation_version=version;
        merge(&mut connection,user,vec![Download{prefer_local,session_key:key.clone(),session:stale.clone()}]).unwrap();
        let saved=db::get_session(&connection,"local","regression").unwrap();
        assert_eq!(saved.turns.as_ref().unwrap()[0].service_tier,"priority");
        assert_eq!(saved.turns.as_ref().unwrap()[0].model,current.turns.as_ref().unwrap()[0].model);
    }
    // The cloud can insert an earlier request while local metadata stays newer.
    // Preserving a local turn must not copy its old ordinal onto a different row.
    let mut expanded=stale.clone();expanded.aggregation_version=5;
    let mut earlier=expanded.turns.as_ref().unwrap()[0].clone();earlier.timestamp="2026-09-05T01:00:00.500Z".into();
    expanded.turns.as_mut().unwrap().insert(0,earlier);
    expanded.tokens=TokenBreakdown::default();expanded.token_event_count+=1;
    for (i,t) in expanded.turns.as_mut().unwrap().iter_mut().enumerate(){t.ordinal=i as i64+1;expanded.tokens.add_assign(&t.tokens);}
    merge(&mut connection,user,vec![Download{prefer_local:true,session_key:key.clone(),session:expanded}]).unwrap();
    let merged=db::get_session(&connection,"local","regression").unwrap();
    assert_eq!(merged.token_event_count,5);
    assert_eq!(merged.turns.unwrap()[1].service_tier,"priority");
    let fresh=temp();let mut fresh=db::open(&fresh.join("usage.sqlite3")).unwrap();
    merge(&mut fresh,user,vec![Download{prefer_local:false,session_key:key.clone(),session:current}]).unwrap();
    stale.aggregation_version=5;
    merge(&mut fresh,user,vec![Download{prefer_local:false,session_key:key.clone(),session:stale}]).unwrap();
    assert_eq!(db::get_session(&fresh,&format!("cloud:{user}"),&key).unwrap().turns.unwrap()[0].service_tier,"priority");
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
            merge(&mut connection, user, vec![Download { prefer_local: false, session_key: key.clone(), session: incoming.clone() }]).unwrap();
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
    merge(&mut connection, user, vec![Download { prefer_local: false, session_key: key, session: incoming.clone() }]).unwrap();
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
fn nul_padding_and_damaged_records_are_distinguished_by_all_scanners() {
    let root = temp(); std::fs::create_dir(root.join("sessions")).unwrap();
    let padding = fixture().replace("regression", "padding") + " \0\t\0 \n";
    let damaged = fixture().replace("regression", "damaged") + "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}\0\n";
    for (name, log, complete) in [("padding", padding, true), ("damaged", damaged, false)] {
        std::fs::write(root.join(format!("sessions/{name}.jsonl")), &log).unwrap();
        let local = parse_session(Cursor::new(log), "local", "Local", "local").unwrap();
        assert_eq!(local.scan_complete, complete);
        assert_eq!(local.tokens.total_tokens, 485);
    }
    let python = format!("SINCE_ISO = ''\nCODEX_HOME = {}\n{}", serde_json::to_string(&root.to_string_lossy()).unwrap(), include_str!("remote_scan.py"));
    let powershell = format!("$SinceIso = ''\n$CodexHome = '{}'\n{}", root.display(), include_str!("remote_scan.ps1"));
    for (program, script) in [("python", python), ("powershell.exe", powershell)] {
        let mut command = std::process::Command::new(program);
        if program == "python" { command.arg("-"); }
        else { command.args(crate::ssh::windows_script_command(script.len()).split_whitespace().skip(1)); }
        let output = bounded_output(&mut command, script.into_bytes(), Duration::from_secs(45)).unwrap();
        assert!(output.status.success(), "{program}: {}", String::from_utf8_lossy(&output.stderr));
        let rows: Vec<serde_json::Value> = String::from_utf8(output.stdout).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2]["scanSummary"]["skippedFiles"], 1);
        for row in &rows[..2] {
            let session: SessionAggregate = serde_json::from_value(row.clone()).unwrap();
            assert_eq!(session.scan_complete, session.session_id == "padding", "{program}: {}", session.session_id);
            assert_eq!(session.tokens.total_tokens, 485);
        }
    }
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
