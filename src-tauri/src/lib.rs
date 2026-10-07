mod db;
mod models;
mod parser;
mod pricing;
mod pricing_update;
mod scanner;
mod ssh;
mod process;
mod cloud_store;
#[cfg(test)]
mod regression_tests;

use std::{collections::{BTreeMap, HashMap, HashSet}, path::PathBuf};
use chrono::{DateTime, Local};
use chrono::Utc;
use keyring::Entry;
use tauri::{Manager, State};
use models::{AppSettings, DailyUsage, ModelUsage, OverviewData, ScanResult, SessionAggregate, TokenBreakdown, UsageFilter, UsageSource};
use pricing::is_fast_tier;

struct AppState { db_path: PathBuf }
static SCANNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct ScanGuard;
impl Drop for ScanGuard {
    fn drop(&mut self) { SCANNING.store(false, std::sync::atomic::Ordering::Release); }
}

async fn run_blocking<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| format!("背景工作失敗：{error}"))?
}

fn codex_home(settings: &AppSettings) -> Result<PathBuf, String> {
    if !settings.codex_home.trim().is_empty() { return Ok(PathBuf::from(settings.codex_home.trim())); }
    if let Ok(path) = std::env::var("CODEX_HOME") { if !path.trim().is_empty() { return Ok(PathBuf::from(path)); } }
    dirs::home_dir().map(|path| path.join(".codex")).ok_or_else(|| "無法找到使用者主目錄".into())
}

fn source(id: &str, name: &str, kind: &str, target: Option<String>, enabled: bool) -> UsageSource {
    UsageSource { id: id.into(), name: name.into(), kind: kind.into(), target, enabled, stale: false, last_scanned_at: None, last_error: None, last_notice: None, session_count: 0, latest_data_at: None }
}

#[tauri::command]
async fn scan_sources(state: State<'_, AppState>, force_full: Option<bool>) -> Result<ScanResult, String> {
    let db_path = state.db_path.clone();
    run_blocking(move || scan_sources_blocking(db_path, force_full.unwrap_or(false))).await
}

fn scan_sources_blocking(db_path: PathBuf, force_full: bool) -> Result<ScanResult, String> {
    if SCANNING.swap(true, std::sync::atomic::Ordering::AcqRel) { return Err("掃描正在進行，請等待本次完成".into()); }
    let _guard = ScanGuard;
    let mut connection = db::open(&db_path)?;
    let settings = db::load_settings(&connection)?;
    let scanned_at = Utc::now().to_rfc3339();
    let mut scanned_sessions = 0;

    let mut local_source = source("local", "這台電腦", "local", None, true);
    local_source.last_scanned_at = db::list_sources(&connection)?.into_iter().find(|item| item.id == "local").and_then(|item| item.last_scanned_at);
    match scanner::scan_local(&codex_home(&settings)?, &mut connection, force_full) {
        Ok(batch) => {
            scanned_sessions += batch.sessions.len() as i64;
            update_scan_status(&mut local_source, batch.skipped_files, batch.retained_sessions, &scanned_at);
        }
        Err(error) => { local_source.stale = true; local_source.last_error = Some(error); }
    }
    db::upsert_source(&connection, &local_source)?;

    let previous_sources: HashMap<String, UsageSource> = db::list_sources(&connection)?
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect();
    db::disable_ssh_sources(&connection)?;
    for group in settings.ssh_sources.chunks(3) {
        std::thread::scope(|scope| -> Result<(), String> {
            let jobs: Vec<_> = group.iter().map(|remote| scope.spawn(|| -> Result<i64, String> {
                let mut remote_connection = db::open(&db_path)?;
                let mut item = source(&remote.id, &remote.name, "ssh", Some(remote.target.clone()), remote.enabled);
                item.last_scanned_at = previous_sources.get(&remote.id).and_then(|old| old.last_scanned_at.clone());
                db::upsert_source(&remote_connection, &item)?;
                let since = if force_full { None } else { item.last_scanned_at.as_deref() };
                let result = if remote.enabled {
                    ssh::scan_remote(&remote.target, &remote.codex_home, &remote.id, &remote.name, since, |session| {
                        db::save_sessions(&mut remote_connection, &[session])
                    })
                } else { Ok(ssh::RemoteScanSummary::default()) };
                let mut count = 0;
                match result {
                    Ok(batch) if item.enabled => {
                        count = batch.scanned_sessions as i64;
                        update_scan_status(&mut item, batch.skipped_files, batch.retained_sessions, &scanned_at);
                    },
                    Err(error) => { item.stale = true; item.last_error = Some(error); },
                    _ => {},
                }
                // Publish each host's result immediately; another slow/offline host
                // must not hold back already committed statistics or its status.
                db::upsert_source(&remote_connection, &item)?;
                Ok(count)
            })).collect();
            for job in jobs {
                scanned_sessions += job.join().map_err(|_| "遠端掃描意外中止")??;
            }
            Ok(())
        })?;
    }
    cloud_store::reconcile(&mut connection)?;
    let sources = db::list_sources(&connection)?;
    Ok(ScanResult { sources, scanned_sessions, scanned_at })
}

fn update_scan_status(source: &mut UsageSource, skipped: usize, retained: usize, at: &str) {
    source.stale = skipped > 0;
    source.last_error = (skipped > 0).then(|| format!("{skipped} 份紀錄無法完整讀取；可用紀錄已更新，既有統計已保留。"));
    source.last_notice = (retained > 0).then(|| format!("{retained} 段對話的歷史用量已保留。"));
    if skipped == 0 { source.last_scanned_at = Some(at.into()); }
}

#[tauri::command]
async fn test_ssh_source(target: String, codex_home: Option<String>) -> Result<String, String> {
    run_blocking(move || ssh::test_connection(&target, codex_home.as_deref().unwrap_or_default())).await
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>, filter: UsageFilter) -> Result<Vec<SessionAggregate>, String> {
    let path = state.db_path.clone();
    run_blocking(move || db::list_sessions(&db::open(&path)?, &filter)).await
}

#[tauri::command]
async fn list_sync_sessions(state: State<'_, AppState>) -> Result<Vec<SessionAggregate>, String> {
    let path = state.db_path.clone();
    run_blocking(move || db::list_sync_sessions(&db::open(&path)?)).await
}

#[tauri::command]
async fn get_session_detail(state: State<'_, AppState>, source_id: String, session_id: String) -> Result<SessionAggregate, String> {
    let path = state.db_path.clone();
    run_blocking(move || db::get_session(&db::open(&path)?, &source_id, &session_id)).await
}

#[tauri::command]
async fn get_overview(state: State<'_, AppState>, filter: UsageFilter) -> Result<OverviewData, String> {
    let path = state.db_path.clone();
    run_blocking(move || overview_for_path(&path, filter)).await
}

fn overview_for_path(path: &std::path::Path, filter: UsageFilter) -> Result<OverviewData, String> {
    let mut database = db::open(path)?;
    // A consistent read snapshot while the streaming scanners commit sessions.
    let connection = database.transaction().map_err(|error| error.to_string())?;
    let today_filter = UsageFilter { days: 1, start_date: None, end_date: None, ..filter.clone() };
    let mut today_tokens = 0;
    db::visit_period_turns(&connection, &today_filter, |turn| today_tokens += turn.tokens.total_tokens)?;
    let sessions = db::list_sessions(&connection, &filter)?;
    let sources = db::list_sources(&connection)?;
    let mut totals = TokenBreakdown::default();
    let mut estimate_total = 0;
    let mut unpriced_session_keys = HashSet::new();
    let mut daily_map: BTreeMap<String, DailyUsage> = BTreeMap::new();
    let mut model_map: BTreeMap<String, ModelUsage> = BTreeMap::new();
    let mut daily_sessions: HashMap<String, HashSet<(String, String)>> = HashMap::new();
    let mut model_sessions: HashMap<String, HashSet<(String, String)>> = HashMap::new();
    // Fold one row at a time rather than retaining millions of turn objects.
    db::visit_period_turns(&connection, &filter, |turn| {
        totals.add_assign(&turn.tokens);
        let session_key = (turn.source_id.clone(), turn.session_id.clone());
        if let Some(cost) = turn.estimate_microusd { estimate_total += cost; } else { unpriced_session_keys.insert(session_key.clone()); }
        let date = DateTime::parse_from_rfc3339(&turn.timestamp)
            .map(|value| value.with_timezone(&Local).format("%Y-%m-%d").to_string())
            .unwrap_or_else(|_| turn.timestamp.get(0..10).unwrap_or(&turn.timestamp).to_string());
        let daily = daily_map.entry(date.clone()).or_insert(DailyUsage { date: date.clone(), uncached_input: 0, cached_input: 0, cache_write_input: 0, output: 0, unclassified: 0, estimate_microusd: 0, unpriced_tokens: 0, sessions: 0 });
        daily.cached_input += turn.tokens.cached_input_tokens;
        daily.cache_write_input += turn.tokens.cache_write_input_tokens;
        daily.uncached_input += (turn.tokens.input_tokens - turn.tokens.cached_input_tokens - turn.tokens.cache_write_input_tokens).max(0);
        daily.output += turn.tokens.output_tokens;
        daily.unclassified += (turn.tokens.total_tokens - turn.tokens.input_tokens - turn.tokens.output_tokens).max(0);
        daily.estimate_microusd += turn.estimate_microusd.unwrap_or_default();
        if turn.estimate_microusd.is_none() { daily.unpriced_tokens += turn.tokens.total_tokens; }
        daily_sessions.entry(date).or_default().insert(session_key.clone());
        let model = model_map.entry(turn.model.clone()).or_insert(ModelUsage {
            model: turn.model.clone(),
            tokens: TokenBreakdown::default(),
            estimate_microusd: Some(0),
            sessions: 0,
            fast_requests: 0,
            fast_tokens: 0,
            priced_requests: 0,
            unpriced_requests: 0,
            unpriced_tokens: 0,
            reasoning_efforts: Vec::new(),
            unrecorded_effort_requests: 0,
        });
        model.tokens.add_assign(&turn.tokens);
        if let Some(cost) = turn.estimate_microusd {
            model.priced_requests += 1;
            model.estimate_microusd = Some(model.estimate_microusd.unwrap_or_default() + cost);
        } else {
            model.unpriced_requests += 1;
            model.unpriced_tokens += turn.tokens.total_tokens;
        }
        let effort = turn.reasoning_effort.trim();
        if effort.is_empty() || effort.eq_ignore_ascii_case("unknown") {
            model.unrecorded_effort_requests += 1;
        } else if let Some(item) = model.reasoning_efforts.iter_mut().find(|item| item.name.eq_ignore_ascii_case(effort)) {
            item.count += 1;
        } else {
            model.reasoning_efforts.push(models::NamedCount { name: effort.to_string(), count: 1 });
        }
        if is_fast_tier(&turn.service_tier) { model.fast_requests += 1; model.fast_tokens += turn.tokens.total_tokens; }
        model_sessions.entry(turn.model.clone()).or_default().insert(session_key);
    })?;
    for (date, keys) in daily_sessions { if let Some(daily) = daily_map.get_mut(&date) { daily.sessions = keys.len() as i64; } }
    for (model_name, keys) in model_sessions {
        if let Some(model) = model_map.get_mut(&model_name) {
            model.sessions = keys.len() as i64;
            if model.priced_requests == 0 { model.estimate_microusd = None; }
            model.reasoning_efforts.sort_by(|left, right| right.count.cmp(&left.count).then_with(|| left.name.cmp(&right.name)));
        }
    }
    let activity_tokens = totals.total_tokens;
    let activity = db::get_activity(&connection, &filter)?;
    Ok(OverviewData { today_tokens, sessions, daily: daily_map.into_values().collect(), models: model_map.into_values().collect(), sources, totals, activity_tokens, estimate_microusd: estimate_total, unpriced_sessions: unpriced_session_keys.len() as i64, activity })
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let path = state.db_path.clone();
    run_blocking(move || db::load_settings(&db::open(&path)?)).await
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, mut settings: AppSettings, base_pricing_rules: Option<Vec<models::PricingRule>>) -> Result<(), String> {
    let db_path = state.db_path.clone();
    run_blocking(move || {
        for rule in &settings.pricing_rules { pricing::validate_rule(rule)?; }
        let mut models = std::collections::HashSet::new();
        if settings.pricing_rules.iter().any(|rule| !models.insert(rule.model.trim().to_ascii_lowercase())) { return Err("模型名稱不可重複".into()); }
        let mut source_ids = std::collections::HashSet::new();
        for source in &settings.ssh_sources {
            if source.id.trim().is_empty() || source.name.trim().is_empty() || source.target.trim().is_empty() { return Err("SSH 來源名稱與 Target 不可空白".into()); }
            if source.codex_home.len() > 2048 || source.codex_home.chars().any(char::is_control) { return Err("遠端 CODEX_HOME 包含不支援的字元".into()); }
            if !source_ids.insert(source.id.clone()) { return Err("SSH 來源 ID 不可重複".into()); }
        }
        let mut connection = db::open(&db_path)?;
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
        if let Some(base) = base_pricing_rules {
            settings.pricing_rules = pricing_update::merge_settings_draft(&settings.pricing_rules, &base, &db::load_settings(&tx)?.pricing_rules);
        }
        db::save_settings(&tx, &settings)?;
        db::reprice_in_transaction(&tx, &settings.pricing_rules)?;
        tx.commit().map_err(|error| error.to_string())
    }).await
}

#[tauri::command]
async fn get_pricing_status(state: State<'_, AppState>) -> Result<pricing_update::PricingStatus, String> {
    let path = state.db_path.clone();
    run_blocking(move || pricing_update::load_status(&db::open(&path)?)).await
}

#[tauri::command]
async fn refresh_pricing(state: State<'_, AppState>, force: bool) -> Result<pricing_update::PricingUpdateResult, String> {
    let path = state.db_path.clone();
    run_blocking(move || pricing_update::refresh(&path, force)).await
}

#[tauri::command]
fn open_pricing_docs() -> Result<(), String> {
    const URL: &str = "https://developers.openai.com/api/docs/pricing";
    #[cfg(target_os = "windows")]
    let mut command = { let mut command = std::process::Command::new("rundll32.exe"); command.args(["url.dll,FileProtocolHandler", URL]); command };
    #[cfg(target_os = "macos")]
    let mut command = { let mut command = std::process::Command::new("open"); command.arg(URL); command };
    #[cfg(target_os = "linux")]
    let mut command = { let mut command = std::process::Command::new("xdg-open"); command.arg(URL); command };
    command.spawn().map(|_| ()).map_err(|error| format!("無法開啟預設瀏覽器：{error}"))
}

fn credential_entry(key: &str) -> Result<Entry, String> {
    if key.is_empty() || key.len() > 160 || !key.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.')) { return Err("無效的安全儲存鍵".into()); }
    Entry::new("codex-usage-analytics", key).map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_sync_state(state: State<'_, AppState>, user_id: String) -> Result<cloud_store::SyncState,String> {
    let path = state.db_path.clone();
    run_blocking(move || cloud_store::load(&db::open(&path)?,&user_id)).await
}
#[tauri::command]
async fn save_sync_state(state: State<'_, AppState>, user_id: String, sync_state: cloud_store::SyncState) -> Result<(),String> {
    let path = state.db_path.clone();
    run_blocking(move || cloud_store::save(&db::open(&path)?,&user_id,&sync_state)).await
}
#[tauri::command]
async fn merge_cloud_sessions(state: State<'_, AppState>, user_id: String, sessions: Vec<cloud_store::Download>) -> Result<(),String> {
    let path = state.db_path.clone();
    run_blocking(move || cloud_store::merge(&mut db::open(&path)?,&user_id,sessions)).await
}

#[tauri::command]
fn secure_get(key: String) -> Result<Option<String>, String> {
    match credential_entry(&key)?.get_password() { Ok(value) => Ok(Some(value)), Err(keyring::Error::NoEntry) => Ok(None), Err(error) => Err(error.to_string()) }
}

#[tauri::command]
fn secure_set(key: String, value: String) -> Result<(), String> { credential_entry(&key)?.set_password(&value).map_err(|error| error.to_string()) }

#[tauri::command]
fn secure_remove(key: String) -> Result<(), String> {
    match credential_entry(&key)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(error) => Err(error.to_string()) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut window_state = tauri_plugin_window_state::Builder::default().with_state_flags(
        tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED
    );
    // Isolated test databases must not alter the user's normal window state.
    if let Some(path) = std::env::var_os("CODEX_USAGE_DB_PATH") {
        let path = PathBuf::from(path).with_extension("window-state.json");
        window_state = window_state.with_filename(path.to_string_lossy());
    }
    tauri::Builder::default()
        .plugin(window_state.build())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let db_path = if let Some(path) = std::env::var_os("CODEX_USAGE_DB_PATH") {
                PathBuf::from(path)
            } else {
                app.path().app_data_dir()?.join("usage.sqlite3")
            };
            if let Some(parent) = db_path.parent() { std::fs::create_dir_all(parent)?; }
            // Database migrations and initial scanning run through the asynchronous
            // commands, never on the native window's event thread.
            app.manage(AppState { db_path });
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            { use tauri_plugin_deep_link::DeepLinkExt; app.deep_link().register_all()?; }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![scan_sources, test_ssh_source, list_sessions, list_sync_sessions, get_session_detail, get_overview, get_settings, save_settings, get_pricing_status, refresh_pricing, open_pricing_docs, secure_get, secure_set, secure_remove, get_sync_state, save_sync_state, merge_cloud_sessions])
        .run(tauri::generate_context!())
        .expect("error while running Codex usage analytics");
}
