use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub skills: Vec<NamedCount>,
    pub plugins: Vec<NamedCount>,
    pub efforts: Vec<NamedCount>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub cache_write_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

impl TokenBreakdown {
    pub fn add_assign(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.cache_write_input_tokens += other.cache_write_input_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_output_tokens += other.reasoning_output_tokens;
        self.total_tokens += other.total_tokens;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub ordinal: i64,
    pub timestamp: String,
    pub model: String,
    #[serde(default = "default_service_tier")]
    pub service_tier: String,
    #[serde(default = "default_reasoning_effort")]
    pub reasoning_effort: String,
    pub tokens: TokenBreakdown,
    pub estimate_microusd: Option<i64>,
    pub cache_rate: f64,
}

#[derive(Debug, Clone)]
pub struct PeriodTurnUsage {
    pub source_id: String,
    pub session_id: String,
    pub timestamp: String,
    pub model: String,
    pub service_tier: String,
    pub reasoning_effort: String,
    pub tokens: TokenBreakdown,
    pub estimate_microusd: Option<i64>,
}

pub fn default_service_tier() -> String { "default".into() }

pub fn default_reasoning_effort() -> String { "unknown".into() }

pub fn normalize_service_tier(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "priority" | "fast" => "priority".into(),
        _ => "default".into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAggregate {
    #[serde(default = "scan_complete_default")]
    pub scan_complete: bool,
    pub session_id: String,
    pub source_id: String,
    pub source_name: String,
    pub source_kind: String,
    pub project: String,
    pub model: String,
    pub started_at: String,
    pub ended_at: String,
    pub origin: String,
    pub tokens: TokenBreakdown,
    pub activity_tokens: i64,
    pub estimate_microusd: Option<i64>,
    #[serde(default)]
    pub unpriced_turn_count: i64,
    #[serde(default)]
    pub unpriced_tokens: i64,
    pub token_event_count: i64,
    pub rate_used_percent: Option<f64>,
    pub rate_window_minutes: Option<i64>,
    #[serde(default)]
    pub activity: SessionActivity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<TurnUsage>>,
}

fn scan_complete_default() -> bool { true }

#[derive(Debug, Default)]
pub struct ScanBatch {
    pub sessions: Vec<SessionAggregate>,
    pub skipped_files: usize,
    pub retained_sessions: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingRule {
    pub model: String,
    pub input_usd_per_million: f64,
    pub cached_usd_per_million: f64,
    #[serde(default)]
    pub cache_write_usd_per_million: f64,
    pub output_usd_per_million: f64,
    pub cache_write_multiplier: f64,
    pub long_context_threshold: i64,
    pub long_input_multiplier: f64,
    pub long_output_multiplier: f64,
    #[serde(default = "default_priority_multiplier")]
    pub priority_multiplier: f64,
    pub source_url: String,
    pub reviewed_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable_rates: Vec<String>,
}

fn default_priority_multiplier() -> f64 { 2.0 }

pub fn default_pricing_rules() -> Vec<PricingRule> {
    vec![
        PricingRule { model: "gpt-5.6-sol".into(), input_usd_per_million: 4.0, cached_usd_per_million: 0.40, cache_write_usd_per_million: 5.0, output_usd_per_million: 20.0, cache_write_multiplier: 1.25, long_context_threshold: 272_000, long_input_multiplier: 2.0, long_output_multiplier: 1.5, priority_multiplier: 2.0, source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-sol".into(), reviewed_at: "2026-09-03".into(), unavailable_rates: Vec::new() },
        PricingRule { model: "gpt-5.6-terra".into(), input_usd_per_million: 2.0, cached_usd_per_million: 0.20, cache_write_usd_per_million: 2.50, output_usd_per_million: 12.0, cache_write_multiplier: 1.25, long_context_threshold: 272_000, long_input_multiplier: 2.0, long_output_multiplier: 1.5, priority_multiplier: 2.0, source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra".into(), reviewed_at: "2026-09-03".into(), unavailable_rates: Vec::new() },
        PricingRule { model: "gpt-5.6-luna".into(), input_usd_per_million: 0.20, cached_usd_per_million: 0.02, cache_write_usd_per_million: 0.25, output_usd_per_million: 1.20, cache_write_multiplier: 1.25, long_context_threshold: 272_000, long_input_multiplier: 2.0, long_output_multiplier: 1.5, priority_multiplier: 2.0, source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna".into(), reviewed_at: "2026-09-03".into(), unavailable_rates: Vec::new() },
        PricingRule { model: "gpt-5.5".into(), input_usd_per_million: 5.0, cached_usd_per_million: 0.50, cache_write_usd_per_million: 6.25, output_usd_per_million: 30.0, cache_write_multiplier: 1.25, long_context_threshold: 272_000, long_input_multiplier: 2.0, long_output_multiplier: 1.5, priority_multiplier: 2.0, source_url: "https://developers.openai.com/api/docs/models/gpt-5.5".into(), reviewed_at: "2026-09-03".into(), unavailable_rates: Vec::new() },
        PricingRule { model: "gpt-5.4".into(), input_usd_per_million: 2.50, cached_usd_per_million: 0.25, cache_write_usd_per_million: 3.125, output_usd_per_million: 15.0, cache_write_multiplier: 1.25, long_context_threshold: 272_000, long_input_multiplier: 2.0, long_output_multiplier: 1.5, priority_multiplier: 2.0, source_url: "https://developers.openai.com/api/docs/models/gpt-5.4".into(), reviewed_at: "2026-09-03".into(), unavailable_rates: Vec::new() },
        PricingRule { model: "gpt-5.3-codex".into(), input_usd_per_million: 1.75, cached_usd_per_million: 0.175, cache_write_usd_per_million: 2.1875, output_usd_per_million: 14.0, cache_write_multiplier: 1.25, long_context_threshold: 400_000, long_input_multiplier: 1.0, long_output_multiplier: 1.0, priority_multiplier: 2.0, source_url: "https://developers.openai.com/api/docs/models/gpt-5.3-codex".into(), reviewed_at: "2026-09-03".into(), unavailable_rates: Vec::new() },
        non_billable_pricing_rule(),
    ]
}

pub fn non_billable_pricing_rule() -> PricingRule {
    PricingRule { model: "codex-auto-review".into(), input_usd_per_million: 0.0, cached_usd_per_million: 0.0, cache_write_usd_per_million: 0.0, output_usd_per_million: 0.0, cache_write_multiplier: 1.0, long_context_threshold: 9_007_199_254_740_991, long_input_multiplier: 1.0, long_output_multiplier: 1.0, priority_multiplier: 0.0, source_url: String::new(), reviewed_at: "2026-10-07".into(), unavailable_rates: Vec::new() }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub target: Option<String>,
    pub enabled: bool,
    pub stale: bool,
    pub last_scanned_at: Option<String>,
    pub last_error: Option<String>,
    pub last_notice: Option<String>,
    pub session_count: i64,
    pub latest_data_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    pub uncached_input: i64,
    pub cached_input: i64,
    pub cache_write_input: i64,
    pub output: i64,
    pub unclassified: i64,
    pub estimate_microusd: i64,
    pub unpriced_tokens: i64,
    pub sessions: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub tokens: TokenBreakdown,
    pub estimate_microusd: Option<i64>,
    pub sessions: i64,
    pub fast_requests: i64,
    pub fast_tokens: i64,
    pub priced_requests: i64,
    pub unpriced_requests: i64,
    pub unpriced_tokens: i64,
    pub reasoning_efforts: Vec<NamedCount>,
    pub unrecorded_effort_requests: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewData {
    pub today_tokens: i64,
    pub sessions: Vec<SessionAggregate>,
    pub daily: Vec<DailyUsage>,
    pub models: Vec<ModelUsage>,
    pub sources: Vec<UsageSource>,
    pub totals: TokenBreakdown,
    pub activity_tokens: i64,
    pub estimate_microusd: i64,
    pub unpriced_sessions: i64,
    pub activity: ActivityOverview,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOverview {
    pub skills: Vec<NamedCount>,
    pub plugins: Vec<NamedCount>,
    pub efforts: Vec<NamedCount>,
    pub service_tiers: Vec<NamedCount>,
    pub reasoning_tokens: i64,
    pub fast_requests: i64,
    pub fast_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageFilter {
    pub days: i64,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub source_id: Option<String>,
    pub model: Option<String>,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub sources: Vec<UsageSource>,
    pub scanned_sessions: i64,
    pub scanned_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub codex_home: String,
    #[serde(default)]
    pub ssh_target: String,
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_sources: Vec<SshSourceConfig>,
    pub cloud_enabled: bool,
    pub poll_minutes: i64,
    #[serde(default = "default_pricing_rules")]
    pub pricing_rules: Vec<PricingRule>,
    #[serde(default = "default_auto_update_pricing")]
    pub auto_update_pricing: bool,
}

fn default_auto_update_pricing() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSourceConfig {
    pub id: String,
    pub name: String,
    pub target: String,
    #[serde(default)]
    pub codex_home: String,
    pub enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { codex_home: String::new(), ssh_target: String::new(), ssh_enabled: false, ssh_sources: Vec::new(), cloud_enabled: true, poll_minutes: 15, pricing_rules: default_pricing_rules(), auto_update_pricing: true }
    }
}
