use crate::models::{non_billable_pricing_rule, PricingRule, SessionAggregate, TokenBreakdown};
#[cfg(test)]
use crate::models::default_pricing_rules;

pub fn is_non_billable_model(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case("codex-auto-review")
}

pub fn apply_non_billable_pricing(rules: &mut Vec<PricingRule>) {
    rules.retain(|rule| !is_non_billable_model(&rule.model));
    rules.push(non_billable_pricing_rule());
}

pub fn validate_rule(rule: &PricingRule) -> Result<(), String> {
    let rates = [rule.input_usd_per_million, rule.cached_usd_per_million, rule.cache_write_usd_per_million,
        rule.output_usd_per_million, rule.cache_write_multiplier, rule.priority_multiplier];
    if rule.model.trim().is_empty() || rates.iter().any(|value| !value.is_finite() || *value < 0.0) {
        return Err("模型名稱不可空白，價格與倍率請填 0 或正數。".into());
    }
    if !(1..=9_007_199_254_740_991).contains(&rule.long_context_threshold) {
        return Err("長 context 的輸入門檻請填寫正整數。".into());
    }
    if [rule.long_input_multiplier, rule.long_output_multiplier].iter().any(|value| !value.is_finite() || *value <= 0.0) {
        return Err("長 context 的倍率請填寫大於 0 的數字。".into());
    }
    Ok(())
}

#[cfg(test)]
pub fn estimate_microusd(model: &str, tokens: &TokenBreakdown) -> Option<i64> {
    estimate_with_rules(model, tokens, &default_pricing_rules())
}

pub fn is_fast_tier(service_tier: &str) -> bool {
    matches!(service_tier.trim().to_ascii_lowercase().as_str(), "priority" | "fast")
}

#[cfg(test)]
pub fn estimate_with_rules(model: &str, tokens: &TokenBreakdown, rules: &[PricingRule]) -> Option<i64> {
    estimate_with_rules_for_tier(model, tokens, "default", rules)
}

pub fn estimate_with_rules_for_tier(model: &str, tokens: &TokenBreakdown, service_tier: &str, rules: &[PricingRule]) -> Option<i64> {
    // Keep review usage recorded even when prices or token breakdowns are missing.
    if is_non_billable_model(model) { return Some(0); }
    if tokens.total_tokens > tokens.input_tokens + tokens.output_tokens {
        return None;
    }
    let normalized_model = model.trim().to_ascii_lowercase();
    let rule = rules.iter().find(|rule| rule.model.trim().eq_ignore_ascii_case(&normalized_model)).or_else(|| rules.iter().find(|rule| {
        let rule_model = rule.model.trim().to_ascii_lowercase();
        normalized_model == rule_model || normalized_model
            .strip_prefix(&format!("{rule_model}-"))
            .and_then(|suffix| suffix.chars().next())
            .is_some_and(|first| first.is_ascii_digit())
    })).or_else(|| {
        (model == "gpt-5.6").then(|| rules.iter().find(|rule| rule.model == "gpt-5.6-sol")).flatten()
    })?;
    let uncached = (tokens.input_tokens - tokens.cached_input_tokens - tokens.cache_write_input_tokens).max(0) as f64;
    let cached = tokens.cached_input_tokens.max(0) as f64;
    let cache_write = tokens.cache_write_input_tokens.max(0) as f64;
    let long = tokens.input_tokens > rule.long_context_threshold;
    if rule.unavailable_rates.iter().any(|rate| match rate.as_str() {
        "cached" => tokens.cached_input_tokens > 0,
        "cacheWrite" => tokens.cache_write_input_tokens > 0,
        "fast" => is_fast_tier(service_tier),
        "longFast" => long && is_fast_tier(service_tier),
        _ => false,
    }) { return None; }
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
        assert_eq!(estimate_microusd("unknown-model", &TokenBreakdown::default()), None);
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
    fn long_context_uses_all_input_including_cache_and_prices_the_full_request() {
        let at_boundary = TokenBreakdown { input_tokens: 272_000, cached_input_tokens: 250_000, output_tokens: 10_000, total_tokens: 282_000, ..TokenBreakdown::default() };
        assert_eq!(estimate_microusd("gpt-5.6-sol", &at_boundary), Some(388_000));
        let above = TokenBreakdown { input_tokens: 272_001, total_tokens: 282_001, ..at_boundary };
        assert_eq!(estimate_microusd("gpt-5.6-sol", &above), Some(676_008));
        // Output and cumulative totals do not determine the input boundary.
        let output_above = TokenBreakdown { input_tokens: 260_000, output_tokens: 20_000, total_tokens: 280_000, ..TokenBreakdown::default() };
        assert_eq!(estimate_microusd("gpt-5.6-sol", &output_above), Some(1_440_000));
        let requests: Vec<_> = (1..=2).map(|ordinal| {
            let tokens = TokenBreakdown { input_tokens: 200_000, output_tokens: 10_000, total_tokens: 210_000, ..TokenBreakdown::default() };
            crate::models::TurnUsage { ordinal, timestamp: "2026-10-01T00:00:00Z".into(), model: "gpt-5.6-sol".into(), service_tier: "default".into(), reasoning_effort: "high".into(), estimate_microusd: estimate_microusd("gpt-5.6-sol", &tokens), tokens, cache_rate: 0.0 }
        }).collect();
        assert_eq!(summarize_session_estimate(&requests, 420_000), (Some(2_000_000), 0, 0));
    }

    #[test]
    fn custom_context_rules_apply_and_disabled_rules_keep_normal_prices() {
        let mut rule = default_pricing_rules().remove(0);
        rule.long_context_threshold = 500;
        let usage = TokenBreakdown { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, total_tokens: 1100, ..TokenBreakdown::default() };
        assert_eq!(estimate_with_rules("gpt-5.6-sol", &usage, &[rule.clone()]), Some(5240));
        rule.long_input_multiplier = 1.0; rule.long_output_multiplier = 1.0;
        assert_eq!(estimate_with_rules("gpt-5.6-sol", &usage, &[rule]), Some(3120));
    }

    #[test]
    fn rejects_invalid_context_rules_before_saving() {
        let original = default_pricing_rules().remove(0);
        assert!(validate_rule(&original).is_ok());
        for threshold in [0, -1, i64::MAX] {
            let rule = PricingRule { long_context_threshold: threshold, ..original.clone() };
            assert!(validate_rule(&rule).is_err());
        }
        for multiplier in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(validate_rule(&PricingRule { long_input_multiplier: multiplier, ..original.clone() }).is_err());
            assert!(validate_rule(&PricingRule { long_output_multiplier: multiplier, ..original.clone() }).is_err());
        }
        assert!(validate_rule(&PricingRule { input_usd_per_million: f64::NAN, ..original }).is_err());
    }

    #[test]
    fn custom_model_rule_is_used() {
        let mut rule = default_pricing_rules().remove(0);
        rule.model = "custom-review-model".into();
        rule.input_usd_per_million = 1.5;
        rule.cached_usd_per_million = 0.15;
        rule.output_usd_per_million = 6.0;
        let usage = TokenBreakdown { input_tokens: 100_000, cached_input_tokens: 80_000, cache_write_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 2_000, total_tokens: 110_000 };
        assert_eq!(estimate_with_rules("custom-review-model", &usage, &[rule]), Some(102_000));
    }

    #[test]
    fn auto_review_is_non_billable_with_any_prices_tier_or_token_breakdown() {
        let mut rule = default_pricing_rules().remove(0);
        rule.model = "codex-auto-review".into();
        rule.unavailable_rates = vec!["cached".into(), "cacheWrite".into(), "fast".into(), "longFast".into()];
        let full = TokenBreakdown { input_tokens: 300_000, cached_input_tokens: 80_000, cache_write_input_tokens: 10_000, output_tokens: 10_000, reasoning_output_tokens: 2_000, total_tokens: 310_000 };
        for usage in [full, TokenBreakdown { total_tokens: 48_395, ..TokenBreakdown::default() }] {
            for model in ["codex-auto-review", " CODEX-AUTO-REVIEW "] {
                for tier in ["default", "priority", "fast"] {
                    assert_eq!(estimate_with_rules_for_tier(model, &usage, tier, &[]), Some(0));
                    assert_eq!(estimate_with_rules_for_tier(model, &usage, tier, &[rule.clone()]), Some(0));
                }
            }
        }
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
