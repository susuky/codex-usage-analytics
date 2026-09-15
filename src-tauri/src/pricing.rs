use crate::models::{PricingRule, SessionAggregate, TokenBreakdown};
#[cfg(test)]
use crate::models::default_pricing_rules;

#[cfg(test)]
pub fn estimate_microusd(model: &str, tokens: &TokenBreakdown) -> Option<i64> {
    estimate_with_rules(model, tokens, &default_pricing_rules())
}

pub fn is_fast_tier(service_tier: &str) -> bool {
    matches!(service_tier.trim().to_ascii_lowercase().as_str(), "priority" | "fast")
}

pub fn chatgpt_usage_multiplier(model: &str, service_tier: &str) -> f64 {
    if !is_fast_tier(service_tier) { return 1.0; }
    let normalized = model.trim().to_ascii_lowercase();
    if normalized == "gpt-5.4" || normalized.starts_with("gpt-5.4-") { 2.0 }
    else if normalized == "gpt-5.5" || normalized.starts_with("gpt-5.5-") || normalized == "gpt-5.6" || normalized.starts_with("gpt-5.6-") { 2.5 }
    else { 1.0 }
}

#[cfg(test)]
pub fn estimate_with_rules(model: &str, tokens: &TokenBreakdown, rules: &[PricingRule]) -> Option<i64> {
    estimate_with_rules_for_tier(model, tokens, "default", rules)
}

pub fn estimate_with_rules_for_tier(model: &str, tokens: &TokenBreakdown, service_tier: &str, rules: &[PricingRule]) -> Option<i64> {
    if tokens.total_tokens > tokens.input_tokens + tokens.output_tokens {
        return None;
    }
    let normalized_model = model.trim().to_ascii_lowercase();
    let rule = rules.iter().find(|rule| {
        let rule_model = rule.model.trim().to_ascii_lowercase();
        normalized_model == rule_model || normalized_model
            .strip_prefix(&format!("{rule_model}-"))
            .and_then(|suffix| suffix.chars().next())
            .is_some_and(|first| first.is_ascii_digit())
    }).or_else(|| {
        (model == "gpt-5.6").then(|| rules.iter().find(|rule| rule.model == "gpt-5.6-sol")).flatten()
    })?;
    let uncached = (tokens.input_tokens - tokens.cached_input_tokens - tokens.cache_write_input_tokens).max(0) as f64;
    let cached = tokens.cached_input_tokens.max(0) as f64;
    let cache_write = tokens.cache_write_input_tokens.max(0) as f64;
    let long = tokens.input_tokens > rule.long_context_threshold;
    let input_multiplier = if long { rule.long_input_multiplier } else { 1.0 };
    let output_multiplier = if long { rule.long_output_multiplier } else { 1.0 };
    let micro = (uncached * rule.input_usd_per_million * input_multiplier)
        + (cached * rule.cached_usd_per_million * input_multiplier)
        + (cache_write * rule.cache_write_usd_per_million * input_multiplier)
        + (tokens.output_tokens.max(0) as f64 * rule.output_usd_per_million * output_multiplier);
    let priority_multiplier = if is_fast_tier(service_tier) { rule.priority_multiplier } else { 1.0 };
    Some((micro * priority_multiplier).round() as i64)
}

pub fn summarize_session_estimate(turns: &[crate::models::TurnUsage], session_total_tokens: i64) -> (Option<i64>, i64, i64) {
    if turns.is_empty() {
        return if session_total_tokens == 0 {
            (Some(0), 0, 0)
        } else {
            (None, 1, session_total_tokens.max(0))
        };
    }

    let mut estimate = 0;
    let mut priced_turn_count = 0;
    let mut unpriced_turn_count = 0;
    let mut unpriced_tokens = 0;
    for turn in turns {
        if let Some(cost) = turn.estimate_microusd {
            estimate += cost;
            priced_turn_count += 1;
        } else {
            unpriced_turn_count += 1;
            unpriced_tokens += turn.tokens.total_tokens.max(0);
        }
    }
    (
        (priced_turn_count > 0).then_some(estimate),
        unpriced_turn_count,
        unpriced_tokens,
    )
}

pub fn reprice_sessions(sessions: &mut [SessionAggregate], rules: &[PricingRule]) {
    for session in sessions {
        let Some(turns) = session.turns.as_mut() else { continue };
        for turn in turns.iter_mut() { turn.estimate_microusd = estimate_with_rules_for_tier(&turn.model, &turn.tokens, &turn.service_tier, rules); }
        let (estimate, unpriced_turn_count, unpriced_tokens) = summarize_session_estimate(turns, session.tokens.total_tokens);
        session.estimate_microusd = estimate;
        session.unpriced_turn_count = unpriced_turn_count;
        session.unpriced_tokens = unpriced_tokens;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_cached_and_output_without_double_counting_reasoning() {
        let usage = TokenBreakdown { input_tokens: 100_000, cached_input_tokens: 80_000, cache_write_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 4_000, total_tokens: 110_000 };
        assert_eq!(estimate_microusd("gpt-5.6-sol", &usage), Some(312_000));
    }

    #[test]
    fn unknown_model_is_unpriced() {
        assert_eq!(estimate_microusd("codex-auto-review", &TokenBreakdown::default()), None);
    }

    #[test]
    fn usage_without_a_token_breakdown_is_unpriced() {
        let usage = TokenBreakdown { total_tokens: 48_395, ..TokenBreakdown::default() };
        assert_eq!(estimate_microusd("gpt-5.6-sol", &usage), None);
    }

    #[test]
    fn long_context_and_cache_write_multipliers_apply() {
        let usage = TokenBreakdown { input_tokens: 300_000, cached_input_tokens: 0, cache_write_input_tokens: 100_000, output_tokens: 10_000, reasoning_output_tokens: 0, total_tokens: 310_000 };
        assert_eq!(estimate_microusd("gpt-5.6-luna", &usage), Some(148_000));
    }

    #[test]
    fn custom_model_rule_is_used() {
        let mut rule = default_pricing_rules().remove(0);
        rule.model = "codex-auto-review".into();
        rule.input_usd_per_million = 1.5;
        rule.cached_usd_per_million = 0.15;
        rule.output_usd_per_million = 6.0;
        let usage = TokenBreakdown { input_tokens: 100_000, cached_input_tokens: 80_000, cache_write_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 2_000, total_tokens: 110_000 };
        assert_eq!(estimate_with_rules("codex-auto-review", &usage, &[rule]), Some(102_000));
    }

    #[test]
    fn priority_tier_uses_api_priority_multiplier() {
        let usage = TokenBreakdown { input_tokens: 100_000, cached_input_tokens: 80_000, cache_write_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 4_000, total_tokens: 110_000 };
        assert_eq!(estimate_with_rules_for_tier("gpt-5.6-sol", &usage, "priority", &default_pricing_rules()), Some(624_000));
        assert_eq!(estimate_with_rules_for_tier("gpt-5.6-sol", &usage, "default", &default_pricing_rules()), Some(312_000));
    }

    #[test]
    fn official_legacy_models_have_default_prices() {
        let usage = TokenBreakdown { input_tokens: 100_000, cached_input_tokens: 80_000, cache_write_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 2_000, total_tokens: 110_000 };
        let rules = default_pricing_rules();
        assert_eq!(estimate_with_rules("gpt-5.3-codex", &usage, &rules), Some(189_000));
        assert_eq!(estimate_with_rules("gpt-5.4", &usage, &rules), Some(220_000));
        assert_eq!(estimate_with_rules("gpt-5.5", &usage, &rules), Some(440_000));
        assert_eq!(estimate_with_rules("gpt-5.4-2026-03-05", &usage, &rules), Some(220_000));
    }

    #[test]
    fn chatgpt_fast_usage_multiplier_depends_on_model() {
        assert_eq!(chatgpt_usage_multiplier("gpt-5.6-sol", "priority"), 2.5);
        assert_eq!(chatgpt_usage_multiplier("gpt-5.5", "priority"), 2.5);
        assert_eq!(chatgpt_usage_multiplier("gpt-5.4", "priority"), 2.0);
        assert_eq!(chatgpt_usage_multiplier("gpt-5.6-sol", "default"), 1.0);
    }

    #[test]
    fn session_estimate_keeps_priced_turns_when_one_turn_is_unpriced() {
        let turns = vec![
            crate::models::TurnUsage {
                ordinal: 1,
                timestamp: "2026-09-05T00:00:00Z".into(),
                model: "gpt-5.6-sol".into(),
                service_tier: "default".into(),
                reasoning_effort: "high".into(),
                tokens: TokenBreakdown { input_tokens: 100, output_tokens: 10, total_tokens: 110, ..TokenBreakdown::default() },
                estimate_microusd: Some(240),
                cache_rate: 0.0,
            },
            crate::models::TurnUsage {
                ordinal: 2,
                timestamp: "2026-09-05T00:01:00Z".into(),
                model: "gpt-5.6-sol".into(),
                service_tier: "default".into(),
                reasoning_effort: "high".into(),
                tokens: TokenBreakdown { total_tokens: 25, ..TokenBreakdown::default() },
                estimate_microusd: None,
                cache_rate: 0.0,
            },
        ];
        assert_eq!(summarize_session_estimate(&turns, 135), (Some(240), 1, 25));
        assert_eq!(summarize_session_estimate(&[], 0), (Some(0), 0, 0));
        assert_eq!(summarize_session_estimate(&[], 42), (None, 1, 42));
    }
}
