import type { PricingRule } from "../types";

export const nonBillablePricingRule: PricingRule = {
  model: "codex-auto-review", inputUsdPerMillion: 0, cachedUsdPerMillion: 0, cacheWriteUsdPerMillion: 0,
  outputUsdPerMillion: 0, cacheWriteMultiplier: 1, longContextThreshold: Number.MAX_SAFE_INTEGER,
  longInputMultiplier: 1, longOutputMultiplier: 1, priorityMultiplier: 0, sourceUrl: "", reviewedAt: "2026-10-07", unavailableRates: []
};

export function isNonBillableModel(model: string) {
  return model.trim().toLowerCase() === nonBillablePricingRule.model;
}

export function applyNonBillablePricing(rules: PricingRule[]) {
  return [...rules.filter(rule => !isNonBillableModel(rule.model)), { ...nonBillablePricingRule, unavailableRates: [] }];
}

export type PricingSortKey = "model" | "inputUsdPerMillion" | "cachedUsdPerMillion" | "outputUsdPerMillion";
export interface PricingSort {
  key: PricingSortKey;
  direction: "ascending" | "descending";
}
export interface PricingRow {
  model: string;
  rule: PricingRule | null;
}

export function sortPricingRows(rows: PricingRow[], sort: PricingSort) {
  const direction = sort.direction === "ascending" ? 1 : -1;
  const compareNames = (a: PricingRow, b: PricingRow) => a.model.localeCompare(b.model, "en", { numeric: true, sensitivity: "base" });
  const valueOf = ({ rule }: PricingRow) => !rule || sort.key === "model" || sort.key === "cachedUsdPerMillion" && rule.unavailableRates?.includes("cached") ? null : rule[sort.key];
  return [...rows].sort((a, b) => {
    if (sort.key === "model") return compareNames(a, b) * direction;
    const left = valueOf(a), right = valueOf(b);
    if (left === null || right === null) {
      if (left === right) return compareNames(a, b);
      return left === null ? 1 : -1;
    }
    return (left - right) * direction || compareNames(a, b);
  });
}

export function hasLongContextPricing(rule: PricingRule) {
  return rule.longInputMultiplier !== 1 || rule.longOutputMultiplier !== 1;
}

export function samePrices(left: PricingRule, right: PricingRule) {
  const fields = ["inputUsdPerMillion", "cachedUsdPerMillion", "cacheWriteUsdPerMillion", "outputUsdPerMillion", "cacheWriteMultiplier", "longContextThreshold", "longInputMultiplier", "longOutputMultiplier", "priorityMultiplier"] as const;
  return left.model.trim().toLowerCase() === right.model.trim().toLowerCase()
    && fields.every(field => left[field] === right[field])
    && JSON.stringify(left.unavailableRates ?? []) === JSON.stringify(right.unavailableRates ?? []);
}
