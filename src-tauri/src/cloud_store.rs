use std::collections::HashMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::{db, models::{SessionAggregate, UsageSource}, pricing};

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all="camelCase")]
pub struct SyncState {
    pub acknowledged: HashMap<String,String>,
    pub pending: HashMap<String,String>,
    pub last_synced_at: Option<String>,
}

pub fn user_key(user: &str) -> Result<String,String> {
    if user.len() != 36 || !user.chars().all(|c| c.is_ascii_hexdigit() || c=='-') { return Err("無效的同步帳號".into()); }
    Ok(format!("cloud-state:{user}"))
}

pub fn load(connection: &Connection, user: &str) -> Result<SyncState,String> {
    let raw: Option<String> = connection.query_row("SELECT value FROM settings WHERE key=?1", [user_key(user)?], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string())).unwrap_or_else(|| Ok(SyncState::default()))
}

pub fn save(connection: &Connection, user: &str, state: &SyncState) -> Result<(),String> {
    connection.execute("INSERT INTO settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![user_key(user)?,serde_json::to_string(state).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Download {
    pub session_key: String,
    pub session: SessionAggregate,
}

fn session_hash(user: &str, session: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{user}:{session}").as_bytes()))
}

fn local_keys(connection: &Connection, user: &str) -> Result<HashMap<String,(String,String)>,String> {
    let mut query = connection.prepare("SELECT source_id,session_id FROM sessions WHERE source_kind<>'cloud' ORDER BY token_event_count").map_err(|e| e.to_string())?;
    let rows = query.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
    let mut result = HashMap::new();
    for row in rows { let (source,session) = row.map_err(|e| e.to_string())?; result.insert(session_hash(user,&session),(source,session)); }
    Ok(result)
}

pub fn merge(connection: &mut Connection, user: &str, downloads: Vec<Download>) -> Result<(),String> {
    user_key(user)?;
    let keys = local_keys(connection,user)?;
    let cloud_source = format!("cloud:{user}");
    let rules = db::load_settings(connection)?.pricing_rules;
    db::ensure_source(connection,&UsageSource { id: cloud_source.clone(), name: "其他裝置".into(), kind: "cloud".into(), target: None, enabled: false, stale:false,last_scanned_at:None,last_error:None,last_notice:None,session_count:0,latest_data_at:None })?;
    for download in downloads {
        if download.session_key.len()!=64 || !download.session_key.chars().all(|c| c.is_ascii_hexdigit()) { return Err("雲端統計識別碼無效".into()); }
        let mut incoming = download.session;
        let turns = incoming.turns.as_ref().ok_or("雲端回合資料不完整")?;
        if turns.len() as i64 != incoming.token_event_count || turns.iter().map(|t| t.tokens.total_tokens).sum::<i64>() != incoming.tokens.total_tokens {
            return Err("雲端統計與回合總量不符，已保留原有資料".into());
        }
        if let Some((source,session)) = keys.get(&download.session_key) {
            let original = db::get_session(connection,source,session)?;
            incoming.source_id = original.source_id;
            incoming.source_name = original.source_name;
            incoming.source_kind = original.source_kind;
            incoming.session_id = original.session_id;
            incoming.project = original.project;
        } else {
            incoming.source_id = cloud_source.clone();
            incoming.source_name = "其他裝置".into();
            incoming.source_kind = "cloud".into();
            incoming.session_id = download.session_key;
        }
        incoming.origin = "Codex".into();
        pricing::reprice_sessions(std::slice::from_mut(&mut incoming),&rules);
        db::save_cloud_sessions(connection,&[incoming])?;
    }
    reconcile(connection)
}

// A previously downloaded log may later become a local/SSH source. Retain the
// richer copy, then remove only its redundant cloud projection, never both copies.
pub fn reconcile(connection: &mut Connection) -> Result<(),String> {
    let copies = {
        let mut query = connection.prepare("SELECT source_id,session_id FROM sessions WHERE source_kind='cloud'").map_err(|e| e.to_string())?;
        let rows = query.query_map([],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
    };
    let mut per_user = HashMap::new();
    for (source,id) in copies {
        let Some(user) = source.strip_prefix("cloud:") else { continue };
        if !per_user.contains_key(user) { per_user.insert(user.to_string(),local_keys(connection,user)?); }
        let Some((local_source,local_id)) = per_user[user].get(&id) else { continue };
        let cloud = db::get_session(connection,&source,&id)?;
        let local = db::get_session(connection,local_source,local_id)?;
        let mut merged = cloud.clone();
        merged.source_id = local.source_id; merged.session_id = local.session_id;
        merged.source_name = local.source_name; merged.source_kind = local.source_kind; merged.project = local.project;
        db::save_cloud_sessions(connection,&[merged])?;
        let saved = db::get_session(connection,local_source,local_id)?;
        let mut existing = saved.turns.as_ref().unwrap().iter();
        if !cloud.turns.as_ref().unwrap().iter().all(|t| existing.any(|old| db::same_timestamp(&old.timestamp,&t.timestamp) && old.tokens.total_tokens==t.tokens.total_tokens)) { continue; }
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        for table in ["turns","session_activity","sessions"] {
            tx.execute(&format!("DELETE FROM {table} WHERE source_id=?1 AND session_id=?2"),params![source,id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}
