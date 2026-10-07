use std::{collections::{BTreeMap, HashSet}, io::Read, path::Path, sync::Mutex, time::Duration};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{db, models::{default_pricing_rules, PricingRule}, pricing::is_non_billable_model};

const SOURCE: &str = "https://developers.openai.com/api/docs/pricing";
const DOCUMENT: &str = "https://developers.openai.com/api/docs/pricing.md";
const STATUS_KEY: &str = "official-pricing-status-v1";
const FORMAT_ERROR: &str = "官方價格資料暫時無法讀取，已保留上次價格。";
static REFRESH_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingStatus {
    pub checked_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_error: Option<String>,
    pub official_rules: Vec<PricingRule>,
}

impl Default for PricingStatus {
    fn default() -> Self {
        Self { checked_at: None, updated_at: None, last_error: None, official_rules: default_pricing_rules().into_iter().filter(|rule| !is_non_billable_model(&rule.model)).collect() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingUpdateResult {
    pub status: PricingStatus,
    pub changed: bool,
}

pub fn load_status(connection: &Connection) -> Result<PricingStatus, String> {
    let raw: Option<String> = connection.query_row("SELECT value FROM settings WHERE key=?1", [STATUS_KEY], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string())).unwrap_or_else(|| Ok(PricingStatus::default()))
}

fn save_status(connection: &Connection, status: &PricingStatus) -> Result<(), String> {
    let raw = serde_json::to_string(status).map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [STATUS_KEY, &raw])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn same_prices(left: &PricingRule, right: &PricingRule) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    left.model = left.model.trim().to_ascii_lowercase();
    right.model = right.model.trim().to_ascii_lowercase();
    left.reviewed_at.clear(); right.reviewed_at.clear();
    left.source_url.clear(); right.source_url.clear();
    left == right
}

fn find_rule<'a>(rules: &'a [PricingRule], model: &str) -> Option<&'a PricingRule> {
    rules.iter().find(|rule| rule.model.trim().eq_ignore_ascii_case(model.trim()))
}

/// Three-way merge: only replace values that still match the previous catalog.
pub fn merge_official(current: &[PricingRule], previous: &[PricingRule], next: &[PricingRule]) -> Vec<PricingRule> {
    let mut result = current.to_vec();
    for rule in next {
        if is_non_billable_model(&rule.model) { continue; }
        match result.iter_mut().find(|item| item.model.trim().eq_ignore_ascii_case(&rule.model)) {
            Some(item) if find_rule(previous, &item.model).is_some_and(|old| same_prices(item, old)) => *item = rule.clone(),
            Some(_) => {},
            None => result.push(rule.clone()),
        }
    }
    result
}

/// Preserve catalog updates which arrived while the settings form was open.
pub fn merge_settings_draft(draft: &[PricingRule], base: &[PricingRule], saved: &[PricingRule]) -> Vec<PricingRule> {
    let mut result = draft.to_vec();
    for rule in &mut result {
        if find_rule(base, &rule.model).is_some_and(|old| same_prices(rule, old)) {
            if let Some(latest) = find_rule(saved, &rule.model) { *rule = latest.clone(); }
        }
    }
    for rule in saved {
        if find_rule(base, &rule.model).is_none() && find_rule(&result, &rule.model).is_none() { result.push(rule.clone()); }
    }
    result
}

fn due(status: &PricingStatus, now: DateTime<Utc>) -> bool {
    let interval = if status.last_error.is_some() { 3600 } else { 86400 };
    status.checked_at.as_deref().and_then(|time| DateTime::parse_from_rfc3339(time).ok())
        .is_none_or(|time| { let elapsed = now.signed_duration_since(time).num_seconds(); elapsed < 0 || elapsed >= interval })
}

pub fn refresh(path: &Path, force: bool) -> Result<PricingUpdateResult, String> {
    refresh_with(path, force, fetch_official)
}

fn refresh_with(path: &Path, force: bool, fetch: impl FnOnce() -> Result<Vec<PricingRule>, String>) -> Result<PricingUpdateResult, String> {
    let _guard = REFRESH_LOCK.lock().map_err(|_| "價格更新暫時無法使用".to_string())?;
    let mut connection = db::open(path)?;
    let mut status = load_status(&connection)?;
    if !force && (!db::load_settings(&connection)?.auto_update_pricing || !due(&status, Utc::now())) {
        return Ok(PricingUpdateResult { status, changed: false });
    }
    let fetched = fetch();
    status.checked_at = Some(Utc::now().to_rfc3339());
    let official = match fetched {
        Ok(rules) => rules,
        Err(error) => {
            status.last_error = Some(error.clone());
            save_status(&connection, &status)?;
            return Err(error);
        }
    };
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let mut settings = db::load_settings(&tx)?;
    // A user can disable automatic updates while the network request is running.
    if !force && !settings.auto_update_pricing { return Ok(PricingUpdateResult { status: load_status(&tx)?, changed: false }); }
    let merged = merge_official(&settings.pricing_rules, &status.official_rules, &official);
    let changed = merged.len() != settings.pricing_rules.len() || merged.iter().zip(&settings.pricing_rules).any(|(a,b)| !same_prices(a,b));
    settings.pricing_rules = merged;
    db::save_settings(&tx, &settings)?;
    if changed { db::reprice_in_transaction(&tx, &settings.pricing_rules)?; }
    status.official_rules = official;
    status.updated_at = status.checked_at.clone();
    status.last_error = None;
    save_status(&tx, &status)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(PricingUpdateResult { status, changed })
}

fn fetch_official() -> Result<Vec<PricingRule>, String> {
    let failed = |_| "無法連線至官方定價，已保留上次價格。請稍後再試。".to_string();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25)).connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).https_only(true)
        .user_agent(concat!("CodexUsageAnalytics/", env!("CARGO_PKG_VERSION")))
        .build().map_err(failed)?;
    let response = client.get(DOCUMENT).send().and_then(|response| response.error_for_status()).map_err(failed)?;
    let mut body = String::new();
    response.take(2_000_001).read_to_string(&mut body).map_err(|_| FORMAT_ERROR.to_string())?;
    if body.len() > 2_000_000 { return Err(FORMAT_ERROR.into()); }
    parse_official(&body, &Utc::now().format("%Y-%m-%d").to_string())
}

#[derive(Clone)]
struct Rates { values: Vec<Option<f64>>, threshold: Option<i64> }

fn amount(value: &str) -> Result<Option<f64>, String> {
    if value == "-" || value == "—" { return Ok(None); }
    let number = value.strip_prefix('$').and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 100_000.0).ok_or(FORMAT_ERROR)?;
    Ok(Some(number))
}

fn cells(line: &str) -> Vec<&str> { line.trim_matches('|').split('|').map(str::trim).collect() }

pub fn parse_official(document: &str, reviewed_at: &str) -> Result<Vec<PricingRule>, String> {
    let mut standard = BTreeMap::<String, Rates>::new();
    let mut fast = BTreeMap::<String, Rates>::new();
    let (mut family, mut tier, mut columns) = ("", "", 0);
    for line in document.lines().map(str::trim) {
        let heading = line.trim_start_matches('#').trim();
        match heading {
            "Flagship models" => { family = "flagship"; tier = ""; },
            "Specialized models" => { family = "specialized"; tier = ""; },
            "Cyber models" | "Multimodal models" | "Finetuning" => { family = ""; tier = ""; },
            "Standard" => tier = "standard",
            "Batch" | "Flex" | "Ultrafast" | "Ultrafast mode" => tier = "skip",
            "Fast" | "Fast mode" => tier = "fast",
            _ => {},
        }
        if !line.starts_with('|') { columns = 0; continue; }
        let row = cells(line);
        if family == "flagship" && row == ["Model", "Short context input", "Short context cached input", "Short context cache writes", "Short context output", "Long context input", "Long context cached input", "Long context cache writes", "Long context output"] { columns = 9; continue; }
        if family == "specialized" && row == ["Category", "Model", "Input", "Cached input", "Output"] { columns = 5; continue; }
        if columns == 0 || !matches!(tier, "standard" | "fast") || row.iter().all(|cell| cell.chars().all(|c| c == '-' || c == ':')) { continue; }
        if row.len() != columns { return Err(FORMAT_ERROR.into()); }
        if columns == 5 && row[0] != "Codex" { continue; }
        let model_cell = row[if columns == 5 { 1 } else { 0 }];
        let model = model_cell.split_whitespace().next().unwrap_or("").trim_matches('`');
        if model.is_empty() || !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.')) { return Err(FORMAT_ERROR.into()); }
        let values = if columns == 9 { row[1..].iter().map(|v| amount(v)).collect::<Result<Vec<_>, _>>()? }
            else { vec![amount(row[2])?, amount(row[3])?, None, amount(row[4])?, None, None, None, None] };
        if values[0].is_none() || values[3].is_none() { return Err(FORMAT_ERROR.into()); }
        let threshold = model_cell.split("<").nth(1).and_then(|v| v.split('K').next()).and_then(|v| v.parse::<i64>().ok()).map(|v| v * 1000);
        let target = if tier == "standard" { &mut standard } else { &mut fast };
        if target.insert(model.into(), Rates { values, threshold }).is_some() { return Err(FORMAT_ERROR.into()); }
    }
    if standard.len() < 3 || fast.is_empty() { return Err(FORMAT_ERROR.into()); }
    let defaults = default_pricing_rules();
    let mut result = Vec::new();
    for (model, rates) in standard {
        let values = &rates.values;
        let input = values[0].unwrap();
        let output = values[3].unwrap();
        let long = values[4].is_some() || values[7].is_some();
        // Prefer boundaries supplied by the current feed over bundled defaults.
        // GPT-6 model pages document a >272K input boundary, including cached input.
        let known_threshold = rates.threshold.or_else(|| find_rule(&defaults, &model).map(|rule| rule.long_context_threshold))
            .or_else(|| matches!(model.as_str(), "gpt-6-astra" | "gpt-6.1-sol" | "gpt-6-sol" | "gpt-6-luna").then_some(272_000));
        // Unknown long-context boundaries cannot be safely inferred from prices.
        if long && known_threshold.is_none() { continue; }
        let mut unavailable = Vec::new();
        if values[1].is_none() { unavailable.push("cached".into()); }
        if values[2].is_none() { unavailable.push("cacheWrite".into()); }
        let long_input = if long { values[4].ok_or(FORMAT_ERROR)? / input } else { 1.0 };
        let long_output = if long { values[7].ok_or(FORMAT_ERROR)? / output } else { 1.0 };
        // The estimator uses a common input multiplier, so reject incompatible rows.
        if long && (1..=2).any(|i| match (values[i], values[i+4]) { (Some(short), Some(long)) => (long / short - long_input).abs() > 0.00001, (None, None) => false, _ => true }) { continue; }
        let multiplier = fast.get(&model).and_then(|rate| {
            let ratio = rate.values[0]? / input;
            (0..4).all(|i| match (values[i], rate.values[i]) { (Some(a), Some(b)) => (b / a - ratio).abs() < 0.00001, (None, None) => true, _ => false }).then_some(ratio)
        });
        if multiplier.is_none() { unavailable.push("fast".into()); }
        if long && fast.get(&model).is_some_and(|rate| (4..8).any(|i| match (values[i], rate.values[i]) { (Some(a), Some(b)) => (b / a - multiplier.unwrap_or(1.0)).abs() > 0.00001, (None, None) => false, _ => true })) { unavailable.push("longFast".into()); }
        result.push(PricingRule {
            model, input_usd_per_million: input, cached_usd_per_million: values[1].unwrap_or(0.0),
            cache_write_usd_per_million: values[2].unwrap_or(0.0), output_usd_per_million: output,
            cache_write_multiplier: values[2].map(|rate| rate / input).unwrap_or(1.0),
            long_context_threshold: if long { known_threshold.unwrap() } else { 9_007_199_254_740_991 },
            long_input_multiplier: long_input, long_output_multiplier: long_output,
            priority_multiplier: multiplier.unwrap_or(1.0), source_url: SOURCE.into(), reviewed_at: reviewed_at.into(), unavailable_rates: unavailable,
        });
    }
    if result.len() < 3 || result.iter().map(|r| &r.model).collect::<HashSet<_>>().len() != result.len() { return Err(FORMAT_ERROR.into()); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::TokenBreakdown, pricing::estimate_with_rules_for_tier};

    const FEED: &str = include_str!("../fixtures/official-pricing.md");

    fn test_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("pricing-refresh-{}-{}.sqlite3", std::process::id(), Utc::now().timestamp_nanos_opt().unwrap()))
    }

    #[test]
    fn imports_standard_fast_long_context_and_codex_without_batch() {
        let rules = parse_official(FEED, "2026-09-29").unwrap();
        let astra = find_rule(&rules, "gpt-6-astra").unwrap();
        assert_eq!(astra.input_usd_per_million, 10.0);
        assert_eq!(astra.cache_write_usd_per_million, 12.5);
        assert_eq!(astra.priority_multiplier, 2.0);
        assert_eq!(astra.long_context_threshold, 272000);
        assert_eq!(find_rule(&rules, "gpt-5.5").unwrap().priority_multiplier, 2.5);
        assert_eq!(find_rule(&rules, "gpt-5.3-codex").unwrap().output_usd_per_million, 14.0);
        assert!(find_rule(&rules, "codex-auto-review").is_none());
        let usage = TokenBreakdown { input_tokens: 300000, cached_input_tokens: 100000, cache_write_input_tokens: 100000, output_tokens: 10000, total_tokens: 310000, ..TokenBreakdown::default() };
        assert_eq!(estimate_with_rules_for_tier("gpt-6-astra", &usage, "fast", &rules), Some(10900000));
        assert_eq!(estimate_with_rules_for_tier("gpt-5.5", &usage, "default", &rules), None);
        let long_usage = TokenBreakdown { cache_write_input_tokens: 0, ..usage };
        assert_eq!(estimate_with_rules_for_tier("gpt-5.5", &long_usage, "fast", &rules), None);
    }

    #[test]
    fn rejects_changed_headers_invalid_prices_duplicates_and_truncated_tables() {
        for broken in [FEED.replace("Short context input", "Input tokens"), FEED.replace("$10.00", "$NaN"), FEED.replace("$10.00", "$-1"), FEED.replace("gpt-6-sol", "gpt-6-astra"), FEED.replace("| $75.00 |", "|")] {
            assert!(parse_official(&broken, "2026-09-29").is_err());
        }
        assert!(parse_official("<html>Access denied</html>", "2026-09-29").is_err());
    }

    #[test]
    fn imports_current_models_and_prefers_updated_context_boundaries() {
        let rules = parse_official(&FEED.replace("<272K context length", "<128K context length"), "2026-10-01").unwrap();
        let sol = find_rule(&rules, "gpt-6.1-sol").unwrap();
        assert_eq!(sol.long_context_threshold, 272_000);
        assert_eq!(sol.cached_usd_per_million, 0.1);
        assert_eq!(sol.long_input_multiplier, 2.0);
        assert_eq!(sol.long_output_multiplier, 1.5);
        assert_eq!(find_rule(&rules, "gpt-5.5").unwrap().long_context_threshold, 128_000);
        // A future model without a documented boundary must not inherit 272K.
        let future = parse_official(&FEED.replace("gpt-6.1-sol", "gpt-future"), "2026-10-01").unwrap();
        assert!(find_rule(&future, "gpt-future").is_none());
    }

    #[test]
    fn accepts_current_fast_heading_without_importing_ultrafast_prices() {
        let feed = FEED.replace("Fast mode", "Fast").replace("Specialized models", "Ultrafast\n\n| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| gpt-6-astra | $60.00 | $6.00 | $75.00 | $300.00 | $120.00 | $12.00 | $150.00 | $450.00 |\n\nSpecialized models");
        let rules = parse_official(&feed, "2026-10-01").unwrap();
        assert_eq!(find_rule(&rules, "gpt-6-astra").unwrap().priority_multiplier, 2.0);
        assert_eq!(find_rule(&rules, "gpt-5.3-codex").unwrap().priority_multiplier, 2.0);
    }

    #[test]
    fn keeps_custom_rules_and_edits_made_during_an_update() {
        let previous = default_pricing_rules();
        let mut current = previous.clone();
        current[0].input_usd_per_million = 9.0;
        let mut custom = current[0].clone(); custom.model = "custom-review-model".into(); current.push(custom);
        let mut next = previous.clone(); next[0].input_usd_per_million = 12.0; next[1].output_usd_per_million = 50.0;
        let merged = merge_official(&current, &previous, &next);
        assert_eq!(merged[0].input_usd_per_million, 9.0);
        assert_eq!(merged[1].output_usd_per_million, 50.0);
        assert!(find_rule(&merged, "custom-review-model").is_some());
        let draft = merge_settings_draft(&current, &previous, &next);
        assert_eq!(draft[0].input_usd_per_million, 9.0);
        assert_eq!(draft[1].output_usd_per_million, 50.0);
    }

    #[test]
    fn official_updates_cannot_price_auto_review() {
        let current = default_pricing_rules();
        let mut next = current.clone();
        let review = next.iter_mut().find(|rule| is_non_billable_model(&rule.model)).unwrap();
        review.input_usd_per_million = 99.0;
        review.output_usd_per_million = 99.0;
        let merged = merge_official(&current, &current, &next);
        assert_eq!(find_rule(&merged, "codex-auto-review"), find_rule(&current, "codex-auto-review"));
        assert!(find_rule(&PricingStatus::default().official_rules, "codex-auto-review").is_none());
    }

    #[test]
    fn caches_across_restarts_preserves_prices_on_failure_and_honors_opt_out() {
        let path = test_path();
        let result = refresh_with(&path, false, || parse_official(FEED, "2026-09-29")).unwrap();
        assert!(result.changed);
        assert!(!refresh_with(&path, false, || panic!("cached request must not connect")).unwrap().changed);
        assert!(refresh_with(&path, true, || Err("離線，保留上次價格".into())).is_err());
        let connection = db::open(&path).unwrap();
        let failed = load_status(&connection).unwrap();
        assert_eq!(failed.updated_at, result.status.updated_at);
        assert_eq!(failed.official_rules, result.status.official_rules);
        assert!(failed.last_error.is_some());
        assert!(!refresh_with(&path, false, || panic!("failure must back off")).unwrap().changed);
        let mut settings = db::load_settings(&connection).unwrap();
        settings.auto_update_pricing = false;
        db::save_settings(&connection, &settings).unwrap();
        connection.execute("DELETE FROM settings WHERE key=?1", [STATUS_KEY]).unwrap();
        assert!(!refresh_with(&path, false, || panic!("disabled updates must not connect")).unwrap().changed);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_catalog_save_rolls_back_price_changes() {
        let path = test_path();
        let connection = db::open(&path).unwrap();
        let before = db::load_settings(&connection).unwrap().pricing_rules;
        connection.execute_batch("CREATE TRIGGER reject_catalog BEFORE INSERT ON settings WHEN NEW.key='official-pricing-status-v1' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(refresh_with(&path, true, || parse_official(FEED, "2026-09-29")).is_err());
        assert_eq!(db::load_settings(&connection).unwrap().pricing_rules, before);
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    #[ignore = "requires access to the official pricing website"]
    fn live_official_pricing_feed() {
        let rules = fetch_official().unwrap();
        assert!(rules.len() >= 6);
        assert!(find_rule(&rules, "gpt-6-astra").is_some());
        println!("Fetched and validated {} official model prices", rules.len());
    }
}
