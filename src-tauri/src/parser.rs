use std::{collections::BTreeMap, io::BufRead};
use serde_json::Value;
use crate::{models::{default_pricing_rules, normalize_service_tier, NamedCount, SessionActivity, SessionAggregate, TokenBreakdown, TurnUsage}, pricing::{estimate_with_rules_for_tier, summarize_session_estimate}};

fn as_i64(value: Option<&Value>) -> i64 { value.and_then(Value::as_i64).unwrap_or_default() }

fn parse_tokens(value: &Value) -> TokenBreakdown {
    TokenBreakdown {
        input_tokens: as_i64(value.get("input_tokens")),
        cached_input_tokens: as_i64(value.get("cached_input_tokens")),
        cache_write_input_tokens: as_i64(value.get("cache_write_input_tokens")),
        output_tokens: as_i64(value.get("output_tokens")),
        reasoning_output_tokens: as_i64(value.get("reasoning_output_tokens")),
        total_tokens: as_i64(value.get("total_tokens")),
    }
}

fn recover_token_breakdown(
    reported: TokenBreakdown,
    previous_total: Option<&TokenBreakdown>,
    current_total: Option<&TokenBreakdown>,
) -> TokenBreakdown {
    if reported.total_tokens <= reported.input_tokens + reported.output_tokens {
        return reported;
    }
    let Some(current) = current_total else { return reported };
    let previous = previous_total.cloned().unwrap_or_default();
    let delta = TokenBreakdown {
        input_tokens: current.input_tokens - previous.input_tokens,
        cached_input_tokens: current.cached_input_tokens - previous.cached_input_tokens,
        cache_write_input_tokens: current.cache_write_input_tokens - previous.cache_write_input_tokens,
        output_tokens: current.output_tokens - previous.output_tokens,
        reasoning_output_tokens: current.reasoning_output_tokens - previous.reasoning_output_tokens,
        total_tokens: current.total_tokens - previous.total_tokens,
    };
    let nonnegative = [
        delta.input_tokens,
        delta.cached_input_tokens,
        delta.cache_write_input_tokens,
        delta.output_tokens,
        delta.reasoning_output_tokens,
        delta.total_tokens,
    ].into_iter().all(|value| value >= 0);
    if nonnegative
        && delta.total_tokens == reported.total_tokens
        && delta.total_tokens <= delta.input_tokens + delta.output_tokens
    {
        delta
    } else {
        reported
    }
}

const UNKNOWN_MODEL: &str = "未知模型";

fn backfill_leading_model(turns: &mut [TurnUsage], session_model: &str, pricing_rules: &[crate::models::PricingRule]) {
    let first_known_model = turns
        .iter()
        .find(|turn| turn.model != UNKNOWN_MODEL)
        .map(|turn| turn.model.clone())
        .or_else(|| (session_model != UNKNOWN_MODEL).then(|| session_model.to_string()));
    let Some(first_known_model) = first_known_model else { return };
    for turn in turns.iter_mut().take_while(|turn| turn.model == UNKNOWN_MODEL) {
        turn.model = first_known_model.clone();
        turn.estimate_microusd = estimate_with_rules_for_tier(
            &turn.model,
            &turn.tokens,
            &turn.service_tier,
            pricing_rules,
        );
    }
}

fn project_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or("未知專案")
        .to_string()
}

fn add_count(counts: &mut BTreeMap<String, i64>, name: &str) {
    let clean = name.trim().trim_matches('/');
    if !clean.is_empty() { *counts.entry(clean.to_string()).or_default() += 1; }
}

fn plugin_for_path(path: &str) -> Option<&'static str> {
    if path.contains("openai-bundled/browser") { Some("Browser") }
    else if path.contains("build-web-apps") { Some("Build Web Apps") }
    else if path.contains("build-web-data-visualization") { Some("Data Visualization") }
    else if path.contains("codex-security") { Some("Codex Security") }
    else if path.contains("/figma/") { Some("Figma") }
    else if path.contains("/hugging-face/") { Some("Hugging Face") }
    else if path.contains("/notion/") { Some("Notion") }
    else if path.contains("openai-primary-runtime") { Some("Artifact Tools") }
    else { None }
}

fn plugin_for_tool(name: &str) -> Option<&'static str> {
    if name.starts_with("mcp__node_repl__") { Some("Browser") }
    else if name.starts_with("image_gen__") { Some("ImageGen") }
    else if name.starts_with("web__") { Some("Web") }
    else if name.contains("figma") { Some("Figma") }
    else { None }
}

fn analyze_tool_text(raw: &str, skills: &mut BTreeMap<String, i64>, plugins: &mut BTreeMap<String, i64>) {
    let normalized = raw.replace('\\', "/");
    let mut remaining = normalized.as_str();
    while let Some(end) = remaining.find("/SKILL.md") {
        let prefix = &remaining[..end];
        if let Some(name) = prefix.rsplit('/').next() {
            add_count(skills, name);
            if let Some(plugin) = plugin_for_path(prefix) { add_count(plugins, plugin); }
        }
        remaining = &remaining[end + "/SKILL.md".len()..];
    }
    let mut tool_text = normalized.as_str();
    while let Some(start) = tool_text.find("tools.") {
        let tail = &tool_text[start + 6..];
        let end = tail.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).unwrap_or(tail.len());
        if let Some(plugin) = plugin_for_tool(&tail[..end]) { add_count(plugins, plugin); }
        tool_text = &tail[end..];
    }
}

fn into_counts(map: BTreeMap<String, i64>) -> Vec<NamedCount> {
    map.into_iter().map(|(name, count)| NamedCount { name, count }).collect()
}

pub fn parse_session<R: BufRead>(reader: R, source_id: &str, source_name: &str, source_kind: &str) -> Result<SessionAggregate, String> {
    let mut session_id = String::new();
    let mut origin = "Codex".to_string();
    let mut started_at = String::new();
    let mut ended_at = String::new();
    let mut project = "未知專案".to_string();
    let mut model = UNKNOWN_MODEL.to_string();
    let mut service_tier = "default".to_string();
    let mut reasoning_effort = "unknown".to_string();
    let mut totals = TokenBreakdown::default();
    let mut turns = Vec::new();
    let mut rate_used_percent = None;
    let mut rate_window_minutes = None;
    let mut skills = BTreeMap::new();
    let mut plugins = BTreeMap::new();
    let mut efforts = BTreeMap::new();
    let pricing_rules = default_pricing_rules();
    let mut previous_total_snapshot: Option<TokenBreakdown> = None;
    let mut scan_complete = true;

    for line_result in reader.lines() {
        let line = match line_result { Ok(value) => value, Err(_) => { scan_complete = false; break; } };
        // Some rollout files contain blank regions filled with NUL bytes.
        // Only a wholly empty/padded line is ignorable; damaged JSON still warns.
        if line.chars().all(|ch| ch.is_whitespace() || ch == '\0') { continue; }
        let value: Value = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => { scan_complete = false; continue; } };
        let timestamp = value.get("timestamp").and_then(Value::as_str).unwrap_or_default().to_string();
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let payload = &value["payload"];
                session_id = payload.get("id").or_else(|| payload.get("session_id")).and_then(Value::as_str).unwrap_or_default().to_string();
                started_at = payload.get("timestamp").and_then(Value::as_str).unwrap_or(&timestamp).to_string();
                ended_at = started_at.clone();
                origin = payload.get("originator").and_then(Value::as_str).unwrap_or("Codex").to_string();
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) { project = project_name(cwd); }
            }
            Some("turn_context") => {
                let payload = &value["payload"];
                if let Some(next_model) = payload.get("model").and_then(Value::as_str) { model = next_model.to_string(); }
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) { project = project_name(cwd); }
                if let Some(effort) = payload.get("effort").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()) {
                    reasoning_effort = effort.to_string();
                    add_count(&mut efforts, effort);
                }
            }
            Some("event_msg") if value["payload"].get("type").and_then(Value::as_str) == Some("thread_settings_applied") => {
                if let Some(next_model) = value["payload"]["thread_settings"].get("model").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
                    model = next_model.to_string();
                }
                if let Some(next_tier) = value["payload"]["thread_settings"].get("service_tier").and_then(Value::as_str) {
                    service_tier = normalize_service_tier(next_tier);
                }
            }
            Some("event_msg") if value["payload"].get("type").and_then(Value::as_str) == Some("token_count") => {
                let payload = &value["payload"];
                let info = &payload["info"];
                let total_snapshot = (!info["total_token_usage"].is_null()).then(|| parse_tokens(&info["total_token_usage"]));
                let is_duplicate_snapshot = total_snapshot.as_ref().is_some_and(|snapshot| previous_total_snapshot.as_ref() == Some(snapshot));
                if !is_duplicate_snapshot && !info["last_token_usage"].is_null() {
                    let token_usage = recover_token_breakdown(
                        parse_tokens(&info["last_token_usage"]),
                        previous_total_snapshot.as_ref(),
                        total_snapshot.as_ref(),
                    );
                    let cache_rate = if token_usage.input_tokens > 0 { token_usage.cached_input_tokens as f64 / token_usage.input_tokens as f64 * 100.0 } else { 0.0 };
                    turns.push(TurnUsage {
                        ordinal: turns.len() as i64 + 1,
                        timestamp: timestamp.clone(),
                        model: model.clone(),
                        service_tier: service_tier.clone(),
                        reasoning_effort: reasoning_effort.clone(),
                        estimate_microusd: estimate_with_rules_for_tier(&model, &token_usage, &service_tier, &pricing_rules),
                        tokens: token_usage,
                        cache_rate,
                    });
                } else if !is_duplicate_snapshot {
                    // A cumulative delta can cover multiple requests. Keep its amount, but do
                    // not invent a model, context length or price for those missing requests.
                    if let Some(snapshot) = &total_snapshot {
                        let previous = previous_total_snapshot.as_ref().map_or(0, |value| value.total_tokens);
                        let missing = if snapshot.total_tokens >= previous { snapshot.total_tokens - previous } else { snapshot.total_tokens };
                        if missing > 0 {
                            turns.push(TurnUsage {
                                ordinal: turns.len() as i64 + 1, timestamp: timestamp.clone(),
                                model: UNKNOWN_MODEL.into(), service_tier: "default".into(), reasoning_effort: "unknown".into(),
                                tokens: TokenBreakdown { total_tokens: missing, ..TokenBreakdown::default() },
                                estimate_microusd: None, cache_rate: 0.0,
                            });
                        }
                    }
                }
                if let Some(snapshot) = total_snapshot {
                    previous_total_snapshot = Some(snapshot);
                }
                let primary = &payload["rate_limits"]["primary"];
                rate_used_percent = primary.get("used_percent").and_then(Value::as_f64);
                rate_window_minutes = primary.get("window_minutes").and_then(Value::as_i64);
                if !timestamp.is_empty() { ended_at = timestamp; }
            }
            Some("response_item") => {
                let payload = &value["payload"];
                let kind = payload.get("type").and_then(Value::as_str).unwrap_or_default();
                if matches!(kind, "custom_tool_call" | "function_call") {
                    if let Some(name) = payload.get("name").and_then(Value::as_str) {
                        if let Some(plugin) = plugin_for_tool(name) { add_count(&mut plugins, plugin); }
                    }
                    if let Some(raw) = payload.get("input").or_else(|| payload.get("arguments")).and_then(Value::as_str) {
                        analyze_tool_text(raw, &mut skills, &mut plugins);
                    }
                }
            }
            _ => {}
        }
    }
    if session_id.is_empty() { return Err("缺少 session_meta.id".into()); }
    if started_at.is_empty() { started_at = ended_at.clone(); }
    backfill_leading_model(&mut turns, &model, &pricing_rules);
    for turn in &turns { totals.add_assign(&turn.tokens); }
    let (estimate_microusd, unpriced_turn_count, unpriced_tokens) = summarize_session_estimate(&turns, totals.total_tokens);
    Ok(SessionAggregate {
        scan_complete,
        session_id, source_id: source_id.into(), source_name: source_name.into(), source_kind: source_kind.into(),
        project, model, started_at, ended_at, origin, activity_tokens: totals.total_tokens, tokens: totals, estimate_microusd,
        unpriced_turn_count, unpriced_tokens,
        token_event_count: turns.len() as i64, rate_used_percent, rate_window_minutes,
        activity: SessionActivity { skills: into_counts(skills), plugins: into_counts(plugins), efforts: into_counts(efforts) },
        turns: Some(turns),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_metadata_and_latest_cumulative_usage() {
        let fixture = r#"{"timestamp":"2026-08-23T01:00:00Z","type":"session_meta","payload":{"id":"sess-1","timestamp":"2026-08-23T01:00:00Z","cwd":"C:\\work\\alpha","originator":"Codex Desktop"}}
{"timestamp":"2026-08-23T01:01:00Z","type":"turn_context","payload":{"model":"gpt-5.6-luna","effort":"high"}}
{"timestamp":"2026-08-23T01:01:30Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"Get-Content C:/plugins/cache/openai-curated-remote/build-web-apps/skills/react-best-practices/SKILL.md; tools.mcp__node_repl__js({})"}}
not-json
{"timestamp":"2026-08-23T01:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":25,"total_tokens":1100},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":25,"total_tokens":1100}},"rate_limits":{"primary":{"used_percent":14.0,"window_minutes":10080}}}}
{"timestamp":"2026-08-23T01:03:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2500,"cached_input_tokens":1700,"cache_write_input_tokens":0,"output_tokens":220,"reasoning_output_tokens":50,"total_tokens":2720},"last_token_usage":{"input_tokens":1500,"cached_input_tokens":900,"cache_write_input_tokens":0,"output_tokens":120,"reasoning_output_tokens":25,"total_tokens":1620}},"rate_limits":{"primary":{"used_percent":15.0,"window_minutes":10080}}}}
{"partial":
"#;
        let parsed = parse_session(Cursor::new(fixture), "local", "這台電腦", "local").unwrap();
        assert_eq!(parsed.project, "alpha");
        assert_eq!(parsed.model, "gpt-5.6-luna");
        assert_eq!(parsed.tokens.total_tokens, 2720);
        assert_eq!(parsed.activity_tokens, 2720);
        assert_eq!(parsed.activity.skills[0].name, "react-best-practices");
        assert_eq!(parsed.activity.efforts[0].name, "high");
        assert_eq!(parsed.activity.plugins[0].name, "Browser");
        assert!(parsed.turns.as_ref().unwrap().iter().all(|turn| turn.reasoning_effort == "high"));
        assert_eq!(parsed.turns.unwrap().len(), 2);
        assert_eq!(parsed.rate_used_percent, Some(15.0));
    }


    #[test]
    fn recovers_total_only_turn_from_cumulative_snapshot_delta() {
        let fixture = r#"{"timestamp":"2026-09-05T00:00:00Z","type":"session_meta","payload":{"id":"recover-1","cwd":"C:\\work\\recover"}}
{"timestamp":"2026-09-05T00:00:01Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}
{"timestamp":"2026-09-05T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"total_tokens":110}}}}
{"timestamp":"2026-09-05T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":240,"output_tokens":20,"total_tokens":320},"last_token_usage":{"total_tokens":210}}}}
"#;
        let parsed = parse_session(Cursor::new(fixture), "local", "這台電腦", "local").unwrap();
        let turns = parsed.turns.unwrap();
        assert_eq!(turns[1].tokens, TokenBreakdown {
            input_tokens: 200,
            cached_input_tokens: 160,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
            total_tokens: 210,
        });
        assert!(turns[1].estimate_microusd.is_some());
        assert_eq!(parsed.unpriced_turn_count, 0);
        assert_eq!(parsed.unpriced_tokens, 0);
    }

    #[test]
    fn keeps_partial_estimate_when_total_only_turn_cannot_be_recovered() {
        let fixture = r#"{"timestamp":"2026-09-05T00:00:00Z","type":"session_meta","payload":{"id":"partial-1","cwd":"C:\\work\\partial"}}
{"timestamp":"2026-09-05T00:00:01Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}
{"timestamp":"2026-09-05T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"total_tokens":110}}}}
{"timestamp":"2026-09-05T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":240,"output_tokens":20,"total_tokens":320},"last_token_usage":{"total_tokens":25}}}}
"#;
        let parsed = parse_session(Cursor::new(fixture), "local", "這台電腦", "local").unwrap();
        assert!(parsed.estimate_microusd.is_some());
        assert_eq!(parsed.unpriced_turn_count, 1);
        assert_eq!(parsed.unpriced_tokens, 25);
        assert!(parsed.turns.unwrap()[1].estimate_microusd.is_none());
    }

    #[test]
    fn missing_session_metadata_is_rejected() {
        assert!(parse_session(Cursor::new("{}\n"), "local", "local", "local").is_err());
    }

    #[test]
    fn tracks_fast_mode_per_request_and_prices_priority_tier() {
        let fixture = r#"{"timestamp":"2026-09-03T10:00:00Z","type":"session_meta","payload":{"id":"sess-fast","cwd":"C:\\work\\fast"}}
{"timestamp":"2026-09-03T10:00:01Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}
{"timestamp":"2026-09-03T10:00:02Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"priority"}}}
{"timestamp":"2026-09-03T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100000,"cached_input_tokens":80000,"output_tokens":10000,"total_tokens":110000},"last_token_usage":{"input_tokens":100000,"cached_input_tokens":80000,"output_tokens":10000,"total_tokens":110000}}}}
{"timestamp":"2026-09-03T10:00:04Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"default"}}}
{"timestamp":"2026-09-03T10:00:05Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200000,"cached_input_tokens":160000,"output_tokens":20000,"total_tokens":220000},"last_token_usage":{"input_tokens":100000,"cached_input_tokens":80000,"output_tokens":10000,"total_tokens":110000}}}}
"#;
        let parsed = parse_session(Cursor::new(fixture), "local", "這台電腦", "local").unwrap();
        let turns = parsed.turns.unwrap();
        assert_eq!(turns[0].service_tier, "priority");
        assert_eq!(turns[0].estimate_microusd, Some(624_000));
        assert_eq!(turns[1].service_tier, "default");
        assert_eq!(turns[1].estimate_microusd, Some(312_000));
    }

    #[test]
    fn attributes_only_leading_unknown_usage_to_the_first_known_model() {
        let fixture = r#"{"timestamp":"2026-09-03T10:00:00Z","type":"session_meta","payload":{"id":"sess-model","cwd":"C:\\work\\model"}}
{"timestamp":"2026-09-03T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110},"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}
{"timestamp":"2026-09-03T10:00:02Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}
{"timestamp":"2026-09-03T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"output_tokens":20,"total_tokens":220},"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}
{"timestamp":"2026-09-03T10:00:04Z","type":"turn_context","payload":{"model":"gpt-5.6-terra"}}
{"timestamp":"2026-09-03T10:00:05Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"output_tokens":30,"total_tokens":330},"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}
"#;
        let parsed = parse_session(Cursor::new(fixture), "local", "這台電腦", "local").unwrap();
        let turns = parsed.turns.unwrap();
        assert_eq!(turns.iter().map(|turn| turn.model.as_str()).collect::<Vec<_>>(), vec!["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]);
        assert!(turns[0].estimate_microusd.is_some());
    }

    #[test]
    fn skips_identical_cumulative_snapshots_but_keeps_resets() {
        let fixture = r#"{"timestamp":"2026-09-03T10:00:00Z","type":"session_meta","payload":{"id":"sess-dedupe","cwd":"C:\\work\\dedupe"}}
{"timestamp":"2026-09-03T10:00:01Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}
{"timestamp":"2026-09-03T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110},"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}
{"timestamp":"2026-09-03T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110},"last_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}
{"timestamp":"2026-09-03T10:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"output_tokens":5,"total_tokens":45},"last_token_usage":{"input_tokens":40,"output_tokens":5,"total_tokens":45}}}}
"#;
        let parsed = parse_session(Cursor::new(fixture), "local", "這台電腦", "local").unwrap();
        let turns = parsed.turns.unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].tokens.total_tokens, 110);
        assert_eq!(turns[1].tokens.total_tokens, 45);
        assert_eq!(parsed.token_event_count, 2);
        assert_eq!(parsed.tokens.total_tokens, 155);
    }
}
