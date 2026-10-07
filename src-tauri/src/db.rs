use std::path::Path;
use chrono::{Duration, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use crate::{models::{default_pricing_rules, ActivityOverview, AppSettings, NamedCount, PeriodTurnUsage, PricingRule, SessionActivity, SessionAggregate, SshSourceConfig, TokenBreakdown, TurnUsage, UsageFilter, UsageSource}, pricing::{chatgpt_usage_multiplier, estimate_with_rules_for_tier, is_fast_tier}};

const MODEL_ATTRIBUTION_REVISION_KEY: &str = "data_revision:model-attribution-v2";
const PRICING_REVISION_KEY: &str = "data_revision:official-pricing-v2";
const TOKEN_BREAKDOWN_REVISION_KEY: &str = "data_revision:token-breakdown-v2";
static OPEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn merge_missing_default_pricing_rules(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    for default_rule in default_pricing_rules() {
        if !settings.pricing_rules.iter().any(|rule| rule.model.eq_ignore_ascii_case(&default_rule.model)) {
            settings.pricing_rules.push(default_rule);
            changed = true;
        }
    }
    changed
}

fn period_start(days: i64) -> String {
    let first_date = Local::now().date_naive() - Duration::days(days.max(1) - 1);
    let midnight = first_date.and_hms_opt(0, 0, 0).expect("valid midnight");
    Local.from_local_datetime(&midnight).earliest().unwrap_or_else(Local::now).with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn period_bounds(filter: &UsageFilter) -> (String, Option<String>) {
    let custom = filter.start_date.as_deref().zip(filter.end_date.as_deref()).and_then(|(start, end)| {
        let start_date = NaiveDate::parse_from_str(start, "%Y-%m-%d").ok()?;
        let end_date = NaiveDate::parse_from_str(end, "%Y-%m-%d").ok()?;
        if start_date > end_date { return None; }
        let end_exclusive = end_date.succ_opt()?;
        let start_local = Local.from_local_datetime(&start_date.and_hms_opt(0, 0, 0)?).earliest()?;
        let end_local = Local.from_local_datetime(&end_exclusive.and_hms_opt(0, 0, 0)?).earliest()?;
        Some((
            start_local.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true),
            end_local.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true),
        ))
    });
    custom.map(|(start, end)| (start, Some(end))).unwrap_or_else(|| (period_start(filter.days), None))
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let _initialization = OPEN_LOCK.lock().map_err(|_| "資料庫初始化失敗，請重新啟動應用程式")?;
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection.busy_timeout(std::time::Duration::from_secs(10)).map_err(|error| error.to_string())?;
    connection.pragma_update(None, "journal_mode", "WAL").map_err(|error| error.to_string())?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS sources (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, target TEXT, enabled INTEGER NOT NULL DEFAULT 1,
            stale INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT, last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            source_id TEXT NOT NULL, session_id TEXT NOT NULL, source_name TEXT NOT NULL, source_kind TEXT NOT NULL,
            project TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, origin TEXT NOT NULL,
            input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, cache_write_input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, activity_tokens INTEGER NOT NULL DEFAULT 0,
            estimate_microusd INTEGER, token_event_count INTEGER NOT NULL, rate_used_percent REAL, rate_window_minutes INTEGER,
            PRIMARY KEY (source_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions(started_at DESC);
        CREATE INDEX IF NOT EXISTS sessions_source_started_idx ON sessions(source_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS sessions_model_started_idx ON sessions(model, started_at DESC);
        CREATE TABLE IF NOT EXISTS turns (
            source_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, timestamp TEXT NOT NULL, model TEXT NOT NULL,
            service_tier TEXT NOT NULL DEFAULT 'default',
            reasoning_effort TEXT NOT NULL DEFAULT 'unknown',
            input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, cache_write_input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
            estimate_microusd INTEGER, cache_rate REAL NOT NULL,
            PRIMARY KEY (source_id, session_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(source_id, session_id, ordinal);
        CREATE TABLE IF NOT EXISTS session_activity (
            source_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL,
            PRIMARY KEY (source_id, session_id, kind, name)
        );
        CREATE INDEX IF NOT EXISTS activity_kind_name_idx ON session_activity(kind, name);
        CREATE TABLE IF NOT EXISTS file_checkpoints (file_key TEXT PRIMARY KEY, size INTEGER NOT NULL, modified TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    ).map_err(|error| error.to_string())?;
    let has_activity_tokens = {
        let mut statement = connection.prepare("PRAGMA table_info(sessions)").map_err(|error| error.to_string())?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        columns.iter().any(|name| name == "activity_tokens")
    };
    if !has_activity_tokens {
        connection.execute("ALTER TABLE sessions ADD COLUMN activity_tokens INTEGER NOT NULL DEFAULT 0", []).map_err(|error| error.to_string())?;
    }
    let has_service_tier = {
        let mut statement = connection.prepare("PRAGMA table_info(turns)").map_err(|error| error.to_string())?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        columns.iter().any(|name| name == "service_tier")
    };
    if !has_service_tier {
        connection.execute("ALTER TABLE turns ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'default'", []).map_err(|error| error.to_string())?;
        connection.execute("UPDATE sources SET last_scanned_at=NULL WHERE kind='ssh'", []).map_err(|error| error.to_string())?;
    }
    let has_reasoning_effort = {
        let mut statement = connection.prepare("PRAGMA table_info(turns)").map_err(|error| error.to_string())?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        columns.iter().any(|name| name == "reasoning_effort")
    };
    if !has_reasoning_effort {
        connection.execute("ALTER TABLE turns ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'unknown'", []).map_err(|error| error.to_string())?;
        connection.execute("UPDATE sources SET last_scanned_at=NULL WHERE kind='ssh'", []).map_err(|error| error.to_string())?;
    }
    let model_revision: Option<String> = connection.query_row(
        "SELECT value FROM settings WHERE key=?1",
        [MODEL_ATTRIBUTION_REVISION_KEY],
        |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    if model_revision.as_deref() != Some("2") {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             DROP TABLE IF EXISTS temp.model_backfill;
             CREATE TEMP TABLE model_backfill (
                 source_id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 first_known_ordinal INTEGER,
                 first_known_model TEXT,
                 session_model TEXT NOT NULL
             );
             INSERT INTO model_backfill(source_id,session_id,first_known_ordinal,first_known_model,session_model)
             SELECT legacy.source_id,legacy.session_id,
                    (SELECT known.ordinal FROM turns AS known
                     WHERE known.source_id=legacy.source_id AND known.session_id=legacy.session_id AND known.model<>'未知模型'
                     ORDER BY known.ordinal LIMIT 1),
                    (SELECT known.model FROM turns AS known
                     WHERE known.source_id=legacy.source_id AND known.session_id=legacy.session_id AND known.model<>'未知模型'
                     ORDER BY known.ordinal LIMIT 1),
                    session.model
             FROM (SELECT source_id,session_id FROM turns WHERE model='未知模型' GROUP BY source_id,session_id) AS legacy
             JOIN sessions AS session ON session.source_id=legacy.source_id AND session.session_id=legacy.session_id;
             CREATE UNIQUE INDEX model_backfill_key_idx ON model_backfill(source_id,session_id);
             UPDATE turns AS target
             SET model=COALESCE(
                 (SELECT mapping.first_known_model FROM model_backfill AS mapping
                  WHERE mapping.source_id=target.source_id AND mapping.session_id=target.session_id),
                 (SELECT NULLIF(mapping.session_model,'未知模型') FROM model_backfill AS mapping
                  WHERE mapping.source_id=target.source_id AND mapping.session_id=target.session_id)
             )
             WHERE target.model='未知模型'
               AND EXISTS (
                   SELECT 1 FROM model_backfill AS mapping
                   WHERE mapping.source_id=target.source_id AND mapping.session_id=target.session_id
                     AND ((mapping.first_known_ordinal IS NOT NULL AND target.ordinal<mapping.first_known_ordinal)
                          OR (mapping.first_known_ordinal IS NULL AND mapping.session_model<>'未知模型'))
               );
             UPDATE sessions AS session
             SET model=(
                 SELECT mapping.first_known_model FROM model_backfill AS mapping
                 WHERE mapping.source_id=session.source_id AND mapping.session_id=session.session_id
             )
             WHERE session.model='未知模型'
               AND EXISTS (
                   SELECT 1 FROM model_backfill AS mapping
                   WHERE mapping.source_id=session.source_id AND mapping.session_id=session.session_id AND mapping.first_known_model IS NOT NULL
               );
             DROP TABLE model_backfill;
             COMMIT;"
        ).map_err(|error| error.to_string())?;
        let pricing_rules = load_settings(&connection)?.pricing_rules;
        reprice_all_sessions(&mut connection, &pricing_rules)?;
        connection.execute(
            "INSERT INTO settings(key,value) VALUES(?1,'2') ON CONFLICT(key) DO UPDATE SET value='2'",
            [MODEL_ATTRIBUTION_REVISION_KEY],
        ).map_err(|error| error.to_string())?;
        connection.execute("UPDATE sources SET last_scanned_at=NULL WHERE kind='ssh'", []).map_err(|error| error.to_string())?;
    }
    let pricing_revision: Option<String> = connection.query_row(
        "SELECT value FROM settings WHERE key=?1",
        [PRICING_REVISION_KEY],
        |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    if pricing_revision.as_deref() != Some("3") {
        let mut settings = load_settings(&connection)?;
        merge_missing_default_pricing_rules(&mut settings);
        save_settings(&connection, &settings)?;
        reprice_all_sessions(&mut connection, &settings.pricing_rules)?;
        connection.execute(
            "INSERT INTO settings(key,value) VALUES(?1,'3') ON CONFLICT(key) DO UPDATE SET value='3'",
            [PRICING_REVISION_KEY],
        ).map_err(|error| error.to_string())?;
    }
    let token_breakdown_revision: Option<String> = connection.query_row(
        "SELECT value FROM settings WHERE key=?1",
        [TOKEN_BREAKDOWN_REVISION_KEY],
        |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    if token_breakdown_revision.as_deref() != Some("2") {
        let pricing_rules = load_settings(&connection)?.pricing_rules;
        reprice_all_sessions(&mut connection, &pricing_rules)?;
        connection.execute(
            "INSERT INTO settings(key,value) VALUES(?1,'2') ON CONFLICT(key) DO UPDATE SET value='2'",
            [TOKEN_BREAKDOWN_REVISION_KEY],
        ).map_err(|error| error.to_string())?;
        connection.execute("UPDATE sources SET last_scanned_at=NULL WHERE kind='ssh'", []).map_err(|error| error.to_string())?;
    }
    let canonical: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key='data_revision:canonical-turns-v1')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !canonical {
        // Preserve the old cumulative observations for audit; never remove imported history.
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS legacy_session_totals AS SELECT source_id,session_id,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens FROM sessions;
            INSERT INTO turns(source_id,session_id,ordinal,timestamp,model,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,estimate_microusd,cache_rate)
            SELECT source_id,session_id,1,ended_at,'未知模型',0,0,0,0,0,total_tokens,NULL,0 FROM sessions s
            WHERE total_tokens>0 AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.source_id=s.source_id AND t.session_id=s.session_id);
            UPDATE sessions AS s SET (input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,activity_tokens,token_event_count)=
              (SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(cached_input_tokens),0),COALESCE(SUM(cache_write_input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(reasoning_output_tokens),0),COALESCE(SUM(total_tokens),0),COALESCE(SUM(total_tokens),0),COUNT(*) FROM turns t WHERE t.source_id=s.source_id AND t.session_id=s.session_id);
            UPDATE sources SET last_scanned_at=NULL;
            INSERT INTO settings VALUES('data_revision:canonical-turns-v1','1');
            COMMIT;").map_err(|e| e.to_string())?;
        let rules = load_settings(&connection)?.pricing_rules;
        reprice_all_sessions(&mut connection, &rules)?;
    }
    let settings_models: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key='data_revision:thread-settings-model-v1')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !settings_models {
        connection.execute_batch("BEGIN IMMEDIATE;
            DELETE FROM file_checkpoints;
            UPDATE sources SET last_scanned_at=NULL WHERE kind IN ('local','ssh');
            INSERT INTO settings VALUES('data_revision:thread-settings-model-v1','1');
            COMMIT;").map_err(|e| e.to_string())?;
    }
    Ok(connection)
}

pub fn ensure_source(connection: &Connection, source: &UsageSource) -> Result<(), String> {
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sources WHERE id=?1)", [&source.id], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !exists { upsert_source(connection, source)?; }
    Ok(())
}

pub fn upsert_source(connection: &Connection, source: &UsageSource) -> Result<(), String> {
    connection.execute(
        "INSERT INTO sources(id,name,kind,target,enabled,stale,last_scanned_at,last_error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,target=excluded.target,enabled=excluded.enabled,stale=excluded.stale,last_scanned_at=excluded.last_scanned_at,last_error=excluded.last_error",
        params![source.id, source.name, source.kind, source.target, source.enabled as i64, source.stale as i64, source.last_scanned_at, source.last_error]
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn disable_ssh_sources(connection: &Connection) -> Result<(), String> {
    connection.execute("UPDATE sources SET enabled=0 WHERE kind='ssh'", []).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn save_sessions(connection: &mut Connection, sessions: &[SessionAggregate]) -> Result<usize, String> {
    save_sessions_with_activity(connection, sessions, true)
}

pub fn save_cloud_sessions(connection: &mut Connection, sessions: &[SessionAggregate]) -> Result<usize, String> {
    // Activity comes from local/SSH logs and is absent from cloud snapshots.
    save_sessions_with_activity(connection, sessions, false)
}

fn save_sessions_with_activity(connection: &mut Connection, sessions: &[SessionAggregate], replace_activity: bool) -> Result<usize, String> {
    // Streaming SSH jobs write independently. Acquire the write lock before
    // reading prices/history to avoid SQLITE_BUSY_SNAPSHOT on a deferred upgrade.
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let rules = load_settings(&tx)?.pricing_rules;
    let mut retained = 0;
    for session in sessions {
        let mut current = session.clone();
        let mut retained_history = false;
        crate::pricing::reprice_sessions(std::slice::from_mut(&mut current), &rules);
        let Some(incoming_turns) = &current.turns else { retained += 1; continue };
        let existing: Option<(i64, i64, String)> = tx.query_row(
            "SELECT token_event_count,total_tokens,ended_at FROM sessions WHERE source_id=?1 AND session_id=?2",
            params![current.source_id, current.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|error| error.to_string())?;
        // Preserve history when a resumed log contains only its newer suffix.
        // Overlapping observations must still agree; gaps in the middle stay rejected.
        if let Some((event_count, total_tokens, ended_at)) = existing {
            let mut query = tx.prepare("SELECT timestamp,total_tokens FROM turns WHERE source_id=?1 AND session_id=?2 ORDER BY ordinal").map_err(|e| e.to_string())?;
            let old = query.query_map(params![current.source_id,current.session_id], |row| Ok((row.get::<_,String>(0)?, row.get::<_,i64>(1)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
            let mut next = incoming_turns.iter();
            let includes_old = old.iter().all(|(timestamp,total)| next.any(|turn| same_timestamp(&turn.timestamp, timestamp) && turn.tokens.total_tokens == *total));
            let segments = if current.scan_complete && !includes_old {
                retained_segments(&old, incoming_turns)
            } else { None };
            if let Some((saved_count, incoming_start, conflicting_history)) = segments {
                let previous = get_session(&tx, &current.source_id, &current.session_id)?;
                let mut turns: Vec<_> = previous.turns.unwrap_or_default().into_iter().take(saved_count).chain(incoming_turns[incoming_start..].iter().cloned()).collect();
                current.tokens = TokenBreakdown::default();
                for (index, turn) in turns.iter_mut().enumerate() {
                    turn.ordinal = index as i64 + 1;
                    current.tokens.add_assign(&turn.tokens);
                }
                current.started_at = previous.started_at;
                current.token_event_count = turns.len() as i64;
                current.activity_tokens = current.tokens.total_tokens;
                current.turns = Some(turns);
                retained_history = true;
                if conflicting_history { retained += 1; }
                crate::pricing::reprice_sessions(std::slice::from_mut(&mut current), &rules);
            } else if current.token_event_count < event_count
                || (current.token_event_count == event_count && current.tokens.total_tokens < total_tokens)
            {
                // Active/archive copies can contain an earlier, already imported snapshot.
                // Only silence it when every incoming observation is already saved and the
                // complete snapshot is not newer. Conflicting/truncated histories still warn.
                let not_newer = chrono::DateTime::parse_from_rfc3339(&current.ended_at).ok()
                    .zip(chrono::DateTime::parse_from_rfc3339(&ended_at).ok())
                    .is_some_and(|(incoming, saved)| incoming <= saved);
                let mut saved = old.iter();
                let already_imported = current.scan_complete
                    && current.token_event_count < event_count
                    && current.tokens.total_tokens <= total_tokens
                    && not_newer
                    && incoming_turns.iter().all(|turn| saved.any(|(timestamp, total)| same_timestamp(&turn.timestamp, timestamp) && turn.tokens.total_tokens == *total));
                if !already_imported { retained += 1; }
                continue;
            } else if !includes_old { retained += 1; continue; }
        }
        let session = &current;
        let t = &session.tokens;
        tx.execute(
            "INSERT INTO sessions(source_id,session_id,source_name,source_kind,project,model,started_at,ended_at,origin,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,activity_tokens,estimate_microusd,token_event_count,rate_used_percent,rate_window_minutes) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
             ON CONFLICT(source_id,session_id) DO UPDATE SET source_name=excluded.source_name,source_kind=excluded.source_kind,project=excluded.project,model=excluded.model,started_at=excluded.started_at,ended_at=excluded.ended_at,origin=excluded.origin,input_tokens=excluded.input_tokens,cached_input_tokens=excluded.cached_input_tokens,cache_write_input_tokens=excluded.cache_write_input_tokens,output_tokens=excluded.output_tokens,reasoning_output_tokens=excluded.reasoning_output_tokens,total_tokens=excluded.total_tokens,activity_tokens=excluded.activity_tokens,estimate_microusd=excluded.estimate_microusd,token_event_count=excluded.token_event_count,rate_used_percent=excluded.rate_used_percent,rate_window_minutes=excluded.rate_window_minutes",
            params![session.source_id,session.session_id,session.source_name,session.source_kind,session.project,session.model,session.started_at,session.ended_at,session.origin,t.input_tokens,t.cached_input_tokens,t.cache_write_input_tokens,t.output_tokens,t.reasoning_output_tokens,t.total_tokens,session.activity_tokens,session.estimate_microusd,session.token_event_count,session.rate_used_percent,session.rate_window_minutes]
        ).map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM turns WHERE source_id=?1 AND session_id=?2", params![session.source_id, session.session_id]).map_err(|error| error.to_string())?;
        if replace_activity {
            // Aggregate activity has no per-request timestamps. For resumed suffixes,
            // retain known counts without guessing how much the snapshots overlap.
            if !retained_history {
                tx.execute("DELETE FROM session_activity WHERE source_id=?1 AND session_id=?2", params![session.source_id, session.session_id]).map_err(|error| error.to_string())?;
            }
            for (kind, items) in [("skill", &session.activity.skills), ("plugin", &session.activity.plugins), ("effort", &session.activity.efforts)] {
                for item in items {
                    tx.execute("INSERT INTO session_activity(source_id,session_id,kind,name,count) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(source_id,session_id,kind,name) DO UPDATE SET count=MAX(session_activity.count,excluded.count)", params![session.source_id,session.session_id,kind,item.name,item.count]).map_err(|error| error.to_string())?;
                }
            }
        }
        if let Some(turns) = &session.turns {
            let mut insert = tx.prepare_cached("INSERT INTO turns(source_id,session_id,ordinal,timestamp,model,service_tier,reasoning_effort,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,estimate_microusd,cache_rate) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)").map_err(|error| error.to_string())?;
            for turn in turns {
                let t = &turn.tokens;
                insert.execute(params![session.source_id,session.session_id,turn.ordinal,turn.timestamp,turn.model,turn.service_tier,turn.reasoning_effort,t.input_tokens,t.cached_input_tokens,t.cache_write_input_tokens,t.output_tokens,t.reasoning_output_tokens,t.total_tokens,turn.estimate_microusd,turn.cache_rate]).map_err(|error| error.to_string())?;
            }
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(retained)
}

fn retained_segments(old: &[(String, i64)], incoming: &[TurnUsage]) -> Option<(usize, usize, bool)> {
    let dates = |times: Vec<&str>| times.into_iter().map(chrono::DateTime::parse_from_rfc3339).collect::<Result<Vec<_>, _>>().ok();
    let old_dates = dates(old.iter().map(|(timestamp, _)| timestamp.as_str()).collect())?;
    let incoming_dates = dates(incoming.iter().map(|turn| turn.timestamp.as_str()).collect())?;
    let first = *incoming_dates.first()?;
    let last_saved = old_dates.last()?;
    if old_dates.windows(2).chain(incoming_dates.windows(2)).any(|pair| pair[0] > pair[1])
        || incoming_dates.last()? < last_saved
    { return None; }
    let prefix_len = old_dates.iter().take_while(|date| **date < first).count();
    let mut next = incoming.iter();
    let overlap_matches = old[prefix_len..].iter().all(|(timestamp, total)| next.any(|turn| same_timestamp(&turn.timestamp, timestamp) && turn.tokens.total_tokens == *total));
    let classified = |turn: &TurnUsage| turn.tokens.total_tokens <= turn.tokens.input_tokens + turn.tokens.output_tokens;
    if prefix_len > 0 && overlap_matches && classified(&incoming[0]) {
        return Some((prefix_len, 0, false));
    }
    // Earlier conflicting observations must not block independently recorded newer
    // requests. Keep every saved turn, append only the strictly newer suffix, and warn.
    let incoming_start = incoming_dates.iter().take_while(|date| *date <= last_saved).count();
    let first_new = incoming.get(incoming_start)?;
    classified(first_new).then_some((old.len(), incoming_start, true))
}

pub fn same_timestamp(left: &str, right: &str) -> bool {
    left == right || chrono::DateTime::parse_from_rfc3339(left).ok().zip(chrono::DateTime::parse_from_rfc3339(right).ok()).is_some_and(|(left,right)| left==right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SessionActivity, TurnUsage};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn session(event_count: i64, total_tokens: i64) -> SessionAggregate {
        let tokens = TokenBreakdown {
            input_tokens: total_tokens,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens,
        };
        SessionAggregate {
            scan_complete: true,
            session_id: "stable-session".into(),
            source_id: "local".into(),
            source_name: "這台電腦".into(),
            source_kind: "local".into(),
            project: "test".into(),
            model: "gpt-5.6-sol".into(),
            started_at: "2026-09-03T00:00:00Z".into(),
            ended_at: "2026-09-03T00:01:00Z".into(),
            origin: "Codex".into(),
            tokens: tokens.clone(),
            activity_tokens: total_tokens,
            estimate_microusd: Some(1),
            unpriced_turn_count: 0,
            unpriced_tokens: 0,
            token_event_count: event_count,
            rate_used_percent: None,
            rate_window_minutes: None,
            activity: SessionActivity::default(),
            turns: Some(vec![TurnUsage {
                ordinal: 1,
                timestamp: "2026-09-03T00:01:00Z".into(),
                model: "gpt-5.6-sol".into(),
                service_tier: "default".into(),
                reasoning_effort: "high".into(),
                tokens,
                estimate_microusd: Some(1),
                cache_rate: 0.0,
            }]),
        }
    }

    #[test]
    fn incomplete_rescan_cannot_reduce_saved_usage() {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-db-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut connection = open(&path).unwrap();
        save_sessions(&mut connection, &[session(4, 400)]).unwrap();
        save_sessions(&mut connection, &[session(3, 900)]).unwrap();
        save_sessions(&mut connection, &[session(4, 300)]).unwrap();

        let saved = get_session(&connection, "local", "stable-session").unwrap();
        assert_eq!(saved.token_event_count, 4);
        assert_eq!(saved.tokens.total_tokens, 400);
        assert_eq!(saved.turns.unwrap()[0].tokens.total_tokens, 400);
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn partial_session_estimate_round_trips_with_unpriced_usage_metadata() {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-partial-price-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut connection = open(&path).unwrap();
        let mut mixed = session(2, 135);
        mixed.turns = Some(vec![
            TurnUsage {
                ordinal: 1,
                timestamp: "2026-09-05T00:00:01Z".into(),
                model: "gpt-5.6-sol".into(),
                service_tier: "default".into(),
                reasoning_effort: "high".into(),
                tokens: TokenBreakdown { input_tokens: 100, output_tokens: 10, total_tokens: 110, ..TokenBreakdown::default() },
                estimate_microusd: None,
                cache_rate: 0.0,
            },
            TurnUsage {
                ordinal: 2,
                timestamp: "2026-09-05T00:00:02Z".into(),
                model: "gpt-5.6-sol".into(),
                service_tier: "default".into(),
                reasoning_effort: "high".into(),
                tokens: TokenBreakdown { total_tokens: 25, ..TokenBreakdown::default() },
                estimate_microusd: None,
                cache_rate: 0.0,
            },
        ]);
        crate::pricing::reprice_sessions(std::slice::from_mut(&mut mixed), &default_pricing_rules());
        save_sessions(&mut connection, &[mixed]).unwrap();

        let saved = get_session(&connection, "local", "stable-session").unwrap();
        assert_eq!(saved.estimate_microusd, Some(600));
        assert_eq!(saved.unpriced_turn_count, 1);
        assert_eq!(saved.unpriced_tokens, 25);

        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn service_tier_round_trips_through_sqlite() {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-tier-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut connection = open(&path).unwrap();
        let mut fast_session = session(1, 400);
        fast_session.turns.as_mut().unwrap()[0].service_tier = "priority".into();
        save_sessions(&mut connection, &[fast_session]).unwrap();

        let saved = get_session(&connection, "local", "stable-session").unwrap();
        assert_eq!(saved.turns.unwrap()[0].service_tier, "priority");
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn equal_total_does_not_authorize_deleting_previous_events() {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-corrected-rescan-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut connection = open(&path).unwrap();
        save_sessions(&mut connection, &[session(4, 400)]).unwrap();
        save_sessions(&mut connection, &[session(3, 400)]).unwrap();

        let saved = get_session(&connection, "local", "stable-session").unwrap();
        assert_eq!(saved.token_event_count, 4);
        assert_eq!(saved.tokens.total_tokens, 400);
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn opening_an_existing_database_backfills_only_leading_unknown_turns() {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-model-migration-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut connection = open(&path).unwrap();
        let mut legacy = session(3, 330);
        legacy.turns = Some(vec![
            TurnUsage { ordinal: 1, timestamp: "2026-09-03T00:00:01Z".into(), model: "未知模型".into(), service_tier: "default".into(), reasoning_effort: "unknown".into(), tokens: TokenBreakdown { input_tokens: 100, output_tokens: 10, total_tokens: 110, ..TokenBreakdown::default() }, estimate_microusd: None, cache_rate: 0.0 },
            TurnUsage { ordinal: 2, timestamp: "2026-09-03T00:00:02Z".into(), model: "gpt-5.6-sol".into(), service_tier: "default".into(), reasoning_effort: "high".into(), tokens: TokenBreakdown { input_tokens: 100, output_tokens: 10, total_tokens: 110, ..TokenBreakdown::default() }, estimate_microusd: Some(600), cache_rate: 0.0 },
            TurnUsage { ordinal: 3, timestamp: "2026-09-03T00:00:03Z".into(), model: "gpt-5.6-terra".into(), service_tier: "default".into(), reasoning_effort: "medium".into(), tokens: TokenBreakdown { input_tokens: 100, output_tokens: 10, total_tokens: 110, ..TokenBreakdown::default() }, estimate_microusd: Some(320), cache_rate: 0.0 },
        ]);
        legacy.estimate_microusd = None;
        save_sessions(&mut connection, &[legacy]).unwrap();
        connection.execute("DELETE FROM settings WHERE key=?1", [MODEL_ATTRIBUTION_REVISION_KEY]).unwrap();
        drop(connection);

        let connection = open(&path).unwrap();
        let saved = get_session(&connection, "local", "stable-session").unwrap();
        let turns = saved.turns.unwrap();
        assert_eq!(turns.iter().map(|turn| turn.model.as_str()).collect::<Vec<_>>(), vec!["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]);
        assert!(turns[0].estimate_microusd.is_some());
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn pricing_upgrade_adds_new_official_models_without_overwriting_custom_values() {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-pricing-migration-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let connection = open(&path).unwrap();
        let mut settings = AppSettings::default();
        settings.pricing_rules.retain(|rule| rule.model == "gpt-5.6-sol");
        settings.pricing_rules[0].input_usd_per_million = 9.0;
        save_settings(&connection, &settings).unwrap();
        connection.execute("DELETE FROM settings WHERE key=?1", [PRICING_REVISION_KEY]).unwrap();
        drop(connection);

        let connection = open(&path).unwrap();
        let upgraded = load_settings(&connection).unwrap();
        assert_eq!(upgraded.pricing_rules.iter().find(|rule| rule.model == "gpt-5.6-sol").unwrap().input_usd_per_million, 9.0);
        assert!(upgraded.pricing_rules.iter().any(|rule| rule.model == "gpt-5.5"));
        assert!(upgraded.pricing_rules.iter().any(|rule| rule.model == "gpt-5.4"));
        assert!(upgraded.pricing_rules.iter().any(|rule| rule.model == "gpt-5.3-codex"));
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn custom_date_range_includes_both_selected_boundaries_only() {
        let path = std::env::temp_dir().join(format!(
            "codex-usage-date-range-test-{}-{}.sqlite3",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut connection = open(&path).unwrap();
        let local_timestamp = |date: NaiveDate| {
            Local.from_local_datetime(&date.and_hms_opt(12, 0, 0).unwrap()).earliest().unwrap().with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true)
        };
        let selected_date = NaiveDate::from_ymd_opt(2026, 9, 3).unwrap();
        let next_date = selected_date.succ_opt().unwrap();

        let mut selected = session(1, 400);
        selected.started_at = local_timestamp(selected_date);
        selected.ended_at = selected.started_at.clone();
        selected.turns.as_mut().unwrap()[0].timestamp = selected.started_at.clone();

        let mut outside = session(1, 700);
        outside.session_id = "outside-session".into();
        outside.started_at = local_timestamp(next_date);
        outside.ended_at = outside.started_at.clone();
        outside.turns.as_mut().unwrap()[0].timestamp = outside.started_at.clone();
        save_sessions(&mut connection, &[selected, outside]).unwrap();

        let filter = UsageFilter {
            days: 365,
            start_date: Some("2026-09-03".into()),
            end_date: Some("2026-09-03".into()),
            source_id: None,
            model: None,
            project: None,
        };
        let sessions = list_sessions(&connection, &filter).unwrap();
        let turns = list_period_turns(&connection, &filter).unwrap();
        assert_eq!(sessions.iter().map(|item| item.session_id.as_str()).collect::<Vec<_>>(), vec!["stable-session"]);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].tokens.total_tokens, 400);

        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionAggregate> {
    Ok(SessionAggregate {
        scan_complete: true,
        source_id: row.get(0)?, session_id: row.get(1)?, source_name: row.get(2)?, source_kind: row.get(3)?,
        project: row.get(4)?, model: row.get(5)?, started_at: row.get(6)?, ended_at: row.get(7)?, origin: row.get(8)?,
        tokens: TokenBreakdown { input_tokens: row.get(9)?, cached_input_tokens: row.get(10)?, cache_write_input_tokens: row.get(11)?, output_tokens: row.get(12)?, reasoning_output_tokens: row.get(13)?, total_tokens: row.get(14)? },
        activity_tokens: row.get(15)?, estimate_microusd: row.get(16)?, token_event_count: row.get(17)?, rate_used_percent: row.get(18)?, rate_window_minutes: row.get(19)?,
        unpriced_turn_count: row.get(20)?, unpriced_tokens: row.get(21)?, activity: SessionActivity::default(), turns: None,
    })
}

pub fn list_sessions(connection: &Connection, filter: &UsageFilter) -> Result<Vec<SessionAggregate>, String> {
    let (since, until) = period_bounds(filter);
    let mut statement = connection.prepare("SELECT source_id,session_id,source_name,source_kind,project,model,started_at,ended_at,origin,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,activity_tokens,estimate_microusd,token_event_count,rate_used_percent,rate_window_minutes,
        CASE WHEN estimate_microusd IS NULL AND total_tokens>0 AND NOT EXISTS (SELECT 1 FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id) THEN 1 ELSE (SELECT COUNT(*) FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id AND missing.estimate_microusd IS NULL) END,
        CASE WHEN estimate_microusd IS NULL AND total_tokens>0 AND NOT EXISTS (SELECT 1 FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id) THEN total_tokens ELSE COALESCE((SELECT SUM(missing.total_tokens) FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id AND missing.estimate_microusd IS NULL),0) END
        FROM sessions s WHERE ended_at >= ?1 AND (?5 IS NULL OR started_at < ?5) AND (?2 IS NULL OR s.source_id=?2) AND (?4 IS NULL OR s.project=?4) AND (?3 IS NULL OR EXISTS (SELECT 1 FROM turns t WHERE t.source_id=s.source_id AND t.session_id=s.session_id AND t.timestamp >= ?1 AND (?5 IS NULL OR t.timestamp < ?5) AND t.model=?3)) ORDER BY ended_at DESC").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![since, filter.source_id, filter.model, filter.project, until], session_from_row).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn visit_period_turns(connection: &Connection, filter: &UsageFilter, mut visit: impl FnMut(PeriodTurnUsage)) -> Result<(), String> {
    let (since, until) = period_bounds(filter);
    let mut statement = connection.prepare(
        "SELECT t.source_id,t.session_id,t.timestamp,t.model,t.service_tier,t.reasoning_effort,t.input_tokens,t.cached_input_tokens,t.cache_write_input_tokens,t.output_tokens,t.reasoning_output_tokens,t.total_tokens,t.estimate_microusd
         FROM turns t JOIN sessions s ON s.source_id=t.source_id AND s.session_id=t.session_id
         WHERE t.timestamp >= ?1 AND (?5 IS NULL OR t.timestamp < ?5) AND (?2 IS NULL OR t.source_id=?2) AND (?3 IS NULL OR t.model=?3) AND (?4 IS NULL OR s.project=?4)
         ORDER BY t.timestamp"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![since, filter.source_id, filter.model, filter.project, until], |row| Ok(PeriodTurnUsage {
        source_id: row.get(0)?, session_id: row.get(1)?, timestamp: row.get(2)?, model: row.get(3)?, service_tier: row.get(4)?, reasoning_effort: row.get(5)?,
        tokens: TokenBreakdown { input_tokens: row.get(6)?, cached_input_tokens: row.get(7)?, cache_write_input_tokens: row.get(8)?, output_tokens: row.get(9)?, reasoning_output_tokens: row.get(10)?, total_tokens: row.get(11)? },
        estimate_microusd: row.get(12)?,
    })).map_err(|error| error.to_string())?;
    for row in rows { visit(row.map_err(|error| error.to_string())?); }
    Ok(())
}

#[cfg(test)]
pub fn list_period_turns(connection: &Connection, filter: &UsageFilter) -> Result<Vec<PeriodTurnUsage>, String> {
    let mut result = Vec::new();
    visit_period_turns(connection, filter, |turn| result.push(turn))?;
    Ok(result)
}

pub fn get_session(connection: &Connection, source_id: &str, session_id: &str) -> Result<SessionAggregate, String> {
    let mut statement = connection.prepare("SELECT source_id,session_id,source_name,source_kind,project,model,started_at,ended_at,origin,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,activity_tokens,estimate_microusd,token_event_count,rate_used_percent,rate_window_minutes,
        CASE WHEN estimate_microusd IS NULL AND total_tokens>0 AND NOT EXISTS (SELECT 1 FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id) THEN 1 ELSE (SELECT COUNT(*) FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id AND missing.estimate_microusd IS NULL) END,
        CASE WHEN estimate_microusd IS NULL AND total_tokens>0 AND NOT EXISTS (SELECT 1 FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id) THEN total_tokens ELSE COALESCE((SELECT SUM(missing.total_tokens) FROM turns missing WHERE missing.source_id=s.source_id AND missing.session_id=s.session_id AND missing.estimate_microusd IS NULL),0) END
        FROM sessions s WHERE source_id=?1 AND session_id=?2").map_err(|error| error.to_string())?;
    let mut session = statement.query_row(params![source_id, session_id], session_from_row).optional().map_err(|error| error.to_string())?.ok_or_else(|| "找不到 Session".to_string())?;
    let mut turns_statement = connection.prepare("SELECT ordinal,timestamp,model,service_tier,reasoning_effort,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,estimate_microusd,cache_rate FROM turns WHERE source_id=?1 AND session_id=?2 ORDER BY ordinal").map_err(|error| error.to_string())?;
    session.turns = Some(turns_statement.query_map(params![source_id, session_id], |row| Ok(TurnUsage { ordinal: row.get(0)?, timestamp: row.get(1)?, model: row.get(2)?, service_tier: row.get(3)?, reasoning_effort: row.get(4)?, tokens: TokenBreakdown { input_tokens: row.get(5)?, cached_input_tokens: row.get(6)?, cache_write_input_tokens: row.get(7)?, output_tokens: row.get(8)?, reasoning_output_tokens: row.get(9)?, total_tokens: row.get(10)? }, estimate_microusd: row.get(11)?, cache_rate: row.get(12)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?);
    Ok(session)
}

pub fn list_sources(connection: &Connection) -> Result<Vec<UsageSource>, String> {
    let mut statement = connection.prepare("SELECT s.id,s.name,s.kind,s.target,s.enabled,s.stale,s.last_scanned_at,s.last_error,(SELECT COUNT(*) FROM sessions x WHERE x.source_id=s.id),(SELECT MAX(x.ended_at) FROM sessions x WHERE x.source_id=s.id) FROM sources s ORDER BY s.kind,s.name").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(UsageSource { id: row.get(0)?, name: row.get(1)?, kind: row.get(2)?, target: row.get(3)?, enabled: row.get::<_,i64>(4)? != 0, stale: row.get::<_,i64>(5)? != 0, last_scanned_at: row.get(6)?, last_error: row.get(7)?, session_count: row.get(8)?, latest_data_at: row.get(9)? })).map_err(|error| error.to_string())?;
    let sources = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(sources)
}

pub fn load_settings(connection: &Connection) -> Result<AppSettings, String> {
    let json: Option<String> = connection.query_row("SELECT value FROM settings WHERE key='app'", [], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let needs_ssh_migration = json.as_ref().map(|raw| !raw.contains("\"sshSources\"")).unwrap_or(false);
    let raw_rules = json.as_ref().and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let mut settings: AppSettings = json.map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string())).unwrap_or_else(|| Ok(AppSettings::default()))?;
    for (index, rule) in settings.pricing_rules.iter_mut().enumerate() {
        if raw_rules.as_ref().and_then(|value| value.get("pricingRules")).and_then(|value| value.get(index)).is_some_and(|value| value.get("cacheWriteUsdPerMillion").is_none()) {
            rule.cache_write_usd_per_million = rule.input_usd_per_million * rule.cache_write_multiplier;
        }
    }
    if needs_ssh_migration && settings.ssh_sources.is_empty() && !settings.ssh_target.trim().is_empty() {
        let host = settings.ssh_target.split('@').next_back().unwrap_or("remote");
        settings.ssh_sources.push(SshSourceConfig { id: format!("ssh-{host}"), name: host.into(), target: settings.ssh_target.clone(), codex_home: String::new(), enabled: settings.ssh_enabled });
    }
    crate::pricing::apply_non_billable_pricing(&mut settings.pricing_rules);
    Ok(settings)
}

pub fn get_activity(connection: &Connection, filter: &UsageFilter) -> Result<ActivityOverview, String> {
    let (since, until) = period_bounds(filter);
    let mut statement = connection.prepare(
        "SELECT a.kind,a.name,SUM(a.count) FROM session_activity a JOIN sessions s ON s.source_id=a.source_id AND s.session_id=a.session_id WHERE s.ended_at >= ?1 AND (?5 IS NULL OR s.started_at < ?5) AND (?2 IS NULL OR s.source_id=?2) AND (?3 IS NULL OR s.model=?3) AND (?4 IS NULL OR s.project=?4) GROUP BY a.kind,a.name ORDER BY SUM(a.count) DESC,a.name"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![since, filter.source_id, filter.model, filter.project, until], |row| Ok((row.get::<_,String>(0)?, NamedCount { name: row.get(1)?, count: row.get(2)? }))).map_err(|error| error.to_string())?;
    let mut activity = ActivityOverview::default();
    for row in rows {
        let (kind, item) = row.map_err(|error| error.to_string())?;
        match kind.as_str() { "skill" => activity.skills.push(item), "plugin" => activity.plugins.push(item), "effort" => activity.efforts.push(item), _ => {} }
    }
    activity.reasoning_tokens = connection.query_row(
        "SELECT COALESCE(SUM(t.reasoning_output_tokens),0) FROM turns t JOIN sessions s ON s.source_id=t.source_id AND s.session_id=t.session_id WHERE t.timestamp >= ?1 AND (?5 IS NULL OR t.timestamp < ?5) AND (?2 IS NULL OR t.source_id=?2) AND (?3 IS NULL OR t.model=?3) AND (?4 IS NULL OR s.project=?4)",
        params![since, filter.source_id, filter.model, filter.project, until], |row| row.get(0)
    ).map_err(|error| error.to_string())?;
    let mut tier_statement = connection.prepare(
        "SELECT t.service_tier,t.model,COUNT(*),COALESCE(SUM(t.total_tokens),0) FROM turns t JOIN sessions s ON s.source_id=t.source_id AND s.session_id=t.session_id WHERE t.timestamp >= ?1 AND (?5 IS NULL OR t.timestamp < ?5) AND (?2 IS NULL OR t.source_id=?2) AND (?3 IS NULL OR t.model=?3) AND (?4 IS NULL OR s.project=?4) GROUP BY t.service_tier,t.model"
    ).map_err(|error| error.to_string())?;
    let tier_rows = tier_statement.query_map(params![since, filter.source_id, filter.model, filter.project, until], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,i64>(2)?, row.get::<_,i64>(3)?))).map_err(|error| error.to_string())?;
    let mut tier_counts: HashMap<String, i64> = HashMap::new();
    for row in tier_rows {
        let (tier, model, count, tokens) = row.map_err(|error| error.to_string())?;
        let fast = is_fast_tier(&tier);
        *tier_counts.entry(if fast { "快速模式".into() } else { "標準模式".into() }).or_default() += count;
        if fast { activity.fast_requests += count; activity.fast_tokens += tokens; }
        activity.weighted_usage_requests += count as f64 * chatgpt_usage_multiplier(&model, &tier);
    }
    activity.service_tiers = tier_counts.into_iter().map(|(name, count)| NamedCount { name, count }).collect();
    activity.service_tiers.sort_by(|left, right| right.count.cmp(&left.count).then_with(|| left.name.cmp(&right.name)));
    Ok(activity)
}

pub fn save_settings(connection: &Connection, settings: &AppSettings) -> Result<(), String> {
    let mut settings = settings.clone();
    crate::pricing::apply_non_billable_pricing(&mut settings.pricing_rules);
    let json = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO settings(key,value) VALUES('app',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [json]).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn reprice_all_sessions(connection: &mut Connection, rules: &[PricingRule]) -> Result<(), String> {
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    reprice_in_transaction(&tx, rules)?;
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn reprice_in_transaction(tx: &Connection, rules: &[PricingRule]) -> Result<(), String> {
    let turns = {
        let mut statement = tx.prepare("SELECT source_id,session_id,ordinal,model,service_tier,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens FROM turns").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?,
            TokenBreakdown { input_tokens: row.get(5)?, cached_input_tokens: row.get(6)?, cache_write_input_tokens: row.get(7)?, output_tokens: row.get(8)?, reasoning_output_tokens: row.get(9)?, total_tokens: row.get(10)? }
        ))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        rows
    };
    let mut session_costs: HashMap<(String, String), (i64, i64, i64)> = HashMap::new();
    for (source_id, session_id, ordinal, model, service_tier, tokens) in turns {
        let estimate = estimate_with_rules_for_tier(&model, &tokens, &service_tier, rules);
        tx.execute("UPDATE turns SET estimate_microusd=?1 WHERE source_id=?2 AND session_id=?3 AND ordinal=?4", params![estimate, source_id, session_id, ordinal]).map_err(|error| error.to_string())?;
        let item = session_costs.entry((source_id, session_id)).or_insert((0, 0, 0));
        match estimate {
            Some(value) => { item.0 += value; item.1 += 1; }
            None => item.2 += 1,
        }
    }
    for ((source_id, session_id), (sum, priced_count, _unpriced_count)) in session_costs {
        let estimate = (priced_count > 0).then_some(sum);
        tx.execute("UPDATE sessions SET estimate_microusd=?1 WHERE source_id=?2 AND session_id=?3", params![estimate, source_id, session_id]).map_err(|error| error.to_string())?;
    }
    tx.execute(
        "UPDATE sessions SET estimate_microusd=0 WHERE total_tokens=0 AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.source_id=sessions.source_id AND turns.session_id=sessions.session_id)",
        [],
    ).map_err(|error| error.to_string())?;
    Ok(())
}
