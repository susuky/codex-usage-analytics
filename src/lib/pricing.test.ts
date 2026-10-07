import { expect, it } from "vitest";
import { defaultPricingRules } from "./api";
import { applyNonBillablePricing, nonBillablePricingRule, sortPricingRows, type PricingRow, type PricingSortKey } from "./pricing";

it("keeps auto review non billable when legacy settings contain paid or unavailable prices", () => {
  const paid = { ...defaultPricingRules[0], inputUsdPerMillion: 9 };
  const legacy = { ...paid, model: " CODEX-AUTO-REVIEW ", unavailableRates: ["fast", "cached"] };
  const rules = [paid, legacy];
  expect(applyNonBillablePricing(rules)).toEqual([paid, nonBillablePricingRule]);
  expect(applyNonBillablePricing([paid])).toEqual([paid, nonBillablePricingRule]);
  expect(rules).toEqual([paid, legacy]);
});

it.each<PricingSortKey>(["inputUsdPerMillion", "cachedUsdPerMillion", "outputUsdPerMillion"])("sorts %s numerically in both directions, preserving free and missing prices", key => {
  const rows: PricingRow[] = [
    { model: "expensive", rule: { ...defaultPricingRules[0], [key]: 10 } },
    { model: "missing", rule: null },
    { model: "free", rule: { ...defaultPricingRules[0], [key]: 0 } },
    { model: "cheap", rule: { ...defaultPricingRules[0], [key]: 0.2 } },
    { model: "midrange", rule: { ...defaultPricingRules[0], [key]: 2 } }
  ];
  expect(sortPricingRows(rows, { key, direction: "ascending" }).map(row => row.model)).toEqual(["free", "cheap", "midrange", "expensive", "missing"]);
  expect(sortPricingRows(rows, { key, direction: "descending" }).map(row => row.model)).toEqual(["expensive", "midrange", "cheap", "free", "missing"]);
  expect(rows.map(row => row.model)).toEqual(["expensive", "missing", "free", "cheap", "midrange"]);
});

it("keeps unavailable cached prices last in both directions and breaks ties by natural model name", () => {
  const rows: PricingRow[] = [
    { model: "model-10", rule: { ...defaultPricingRules[0], cachedUsdPerMillion: 2 } },
    { model: "no-cache", rule: { ...defaultPricingRules[0], cachedUsdPerMillion: 0, unavailableRates: ["cached"] } },
    { model: "model-2", rule: { ...defaultPricingRules[0], cachedUsdPerMillion: 2 } },
    { model: "free-cache", rule: { ...defaultPricingRules[0], cachedUsdPerMillion: 0 } },
    { model: "unknown", rule: null }
  ];
  expect(sortPricingRows(rows, { key: "cachedUsdPerMillion", direction: "ascending" }).map(row => row.model)).toEqual(["free-cache", "model-2", "model-10", "no-cache", "unknown"]);
  expect(sortPricingRows(rows, { key: "cachedUsdPerMillion", direction: "descending" }).map(row => row.model)).toEqual(["model-2", "model-10", "free-cache", "no-cache", "unknown"]);
});

it("retains natural model name sorting in both directions", () => {
  const rows = ["model-10", "Model-2", "model-1"].map(model => ({ model, rule: null }));
  expect(sortPricingRows(rows, { key: "model", direction: "ascending" }).map(row => row.model)).toEqual(["model-1", "Model-2", "model-10"]);
  expect(sortPricingRows(rows, { key: "model", direction: "descending" }).map(row => row.model)).toEqual(["model-10", "Model-2", "model-1"]);
});
