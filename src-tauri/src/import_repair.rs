use std::collections::HashSet;
use rusqlite::{params, Connection, OptionalExtension};
use crate::{db, models::{SessionAggregate, TokenBreakdown}, pricing};

const REVISION: &str = "data_revision:subagent-identity-v1";

pub fn initialize(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS usage_attribution_repairs (
        source_id TEXT NOT NULL, previous_session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL, total_tokens INTEGER NOT NULL, owner_session_id TEXT,
        PRIMARY KEY(source_id,previous_session_id,timestamp,total_tokens)
    );").map_err(|e| e.to_string())?;
    let initialized: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1)", [REVISION], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !initialized {
        connection.execute_batch("BEGIN IMMEDIATE;
            DELETE FROM file_checkpoints WHERE NOT EXISTS(SELECT 1 FROM settings WHERE key='data_revision:subagent-identity-v1');
            UPDATE sources SET last_scanned_at=NULL WHERE kind IN ('local','ssh') AND NOT EXISTS(SELECT 1 FROM settings WHERE key='data_revision:subagent-identity-v1');
            INSERT OR IGNORE INTO settings VALUES('data_revision:subagent-identity-v1','1');
            COMMIT;").map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn stamp(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value).map(|v| v.timestamp_micros().to_string()).unwrap_or_else(|_| value.to_string())
}

fn pending_key(source: &str) -> String { format!("subagent-repair-pending:{source}") }

pub fn pending(connection: &Connection, source: &str) -> Result<bool, String> {
    Ok(revision(connection, source)?.is_some())
}

pub fn revision(connection: &Connection, source: &str) -> Result<Option<i64>, String> {
    connection.query_row("SELECT CAST(value AS INTEGER) FROM settings WHERE key=?1", [pending_key(source)], |r| r.get(0)).optional().map_err(|e| e.to_string())
}

pub fn set_pending(connection: &Connection, source: &str, pending: bool) -> Result<(), String> {
    if pending {
        connection.execute("INSERT INTO settings VALUES(?1,'1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1", [pending_key(source)])
    } else {
        connection.execute("DELETE FROM settings WHERE key=?1", [pending_key(source)])
    }.map_err(|e| e.to_string())?;
    Ok(())
}

pub fn filter_reassigned_turns(connection: &Connection, session: &mut SessionAggregate) -> Result<bool, String> {
    let Some(turns) = &mut session.turns else { return Ok(false) };
    let mut query = connection.prepare("SELECT timestamp,total_tokens FROM usage_attribution_repairs
        WHERE source_id=?1 AND previous_session_id=?2 AND (owner_session_id IS NULL OR owner_session_id<>?2)").map_err(|e| e.to_string())?;
    let excluded = query.query_map(params![session.source_id,session.session_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))
        .map_err(|e| e.to_string())?.collect::<Result<HashSet<_>,_>>().map_err(|e| e.to_string())?;
    if excluded.is_empty() { return Ok(false); }
    let count = turns.len();
    turns.retain(|turn| !excluded.contains(&(stamp(&turn.timestamp),turn.tokens.total_tokens)));
    if turns.len() == count { return Ok(false); }
    session.tokens = TokenBreakdown::default();
    for (index, turn) in turns.iter_mut().enumerate() {
        turn.ordinal = index as i64 + 1;
        session.tokens.add_assign(&turn.tokens);
    }
    session.token_event_count = turns.len() as i64;
    session.activity_tokens = session.tokens.total_tokens;
    if let Some(last) = turns.last() { session.ended_at = last.timestamp.clone(); session.model = last.model.clone(); }
    let (estimate, unpriced_count, unpriced_tokens) = pricing::summarize_session_estimate(turns, session.tokens.total_tokens);
    session.estimate_microusd = estimate;
    session.unpriced_turn_count = unpriced_count;
    session.unpriced_tokens = unpriced_tokens;
    Ok(true)
}

fn clean_saved_session(connection: &Connection, source: &str, id: &str) -> Result<(), String> {
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE source_id=?1 AND session_id=?2)", params![source,id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !exists { return Ok(()); }
    let mut saved = db::get_session(connection, source, id)?;
    if filter_reassigned_turns(connection, &mut saved)? {
        db::write_session(connection, &saved, false, false)?;
        // Revisit the real parent's unchanged log after all children are known.
        set_pending(connection, source, true)?;
    }
    Ok(())
}

pub fn exclude_inherited_turns(connection: &Connection, session: &SessionAggregate) -> Result<(), String> {
    let Some(identity) = &session.import_identity else { return Ok(()) };
    if !session.scan_complete { return Ok(()); }
    for turn in &identity.excluded_turns {
        connection.execute("INSERT OR IGNORE INTO usage_attribution_repairs VALUES(?1,?2,?3,?4,NULL)",
            params![session.source_id,session.session_id,stamp(&turn.timestamp),turn.total_tokens]).map_err(|e| e.to_string())?;
    }
    clean_saved_session(connection, &session.source_id, &session.session_id)
}

pub fn claim_owned_turns(connection: &Connection, session: &SessionAggregate) -> Result<(), String> {
    let Some(identity) = &session.import_identity else { return Ok(()) };
    if !session.scan_complete || identity.legacy_session_id.is_empty() || identity.legacy_session_id == session.session_id { return Ok(()); }
    // Called only after the corrected child was saved, in the same transaction.
    // Moving an exact observation therefore cannot discard its only saved copy.
    let saved = db::get_session(connection, &session.source_id, &session.session_id)?;
    let owned: HashSet<_> = saved.turns.as_deref().unwrap_or_default().iter()
        .map(|turn| (stamp(&turn.timestamp), turn.tokens.total_tokens)).collect();
    for turn in session.turns.as_deref().unwrap_or_default() {
        if !owned.contains(&(stamp(&turn.timestamp), turn.tokens.total_tokens)) { continue; }
        connection.execute("INSERT OR IGNORE INTO usage_attribution_repairs VALUES(?1,?2,?3,?4,?5)",
            params![session.source_id,identity.legacy_session_id,stamp(&turn.timestamp),turn.tokens.total_tokens,session.session_id]).map_err(|e| e.to_string())?;
    }
    clean_saved_session(connection, &session.source_id, &identity.legacy_session_id)
}
