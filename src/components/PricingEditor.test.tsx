import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultPricingRules } from "../lib/api";
import { PricingEditor } from "./PricingEditor";

afterEach(cleanup);

it("toggles every price header, marks only the active sort, and retains sorting while searching", () => {
  const rules = [
    { ...defaultPricingRules[0], model: "model-10", inputUsdPerMillion: 2, cachedUsdPerMillion: 0, outputUsdPerMillion: 50, unavailableRates: ["cached"] },
    { ...defaultPricingRules[0], model: "model-2", inputUsdPerMillion: 10, cachedUsdPerMillion: 2, outputUsdPerMillion: 5 },
    { ...defaultPricingRules[0], model: "model-free", inputUsdPerMillion: 0, cachedUsdPerMillion: 0, outputUsdPerMillion: 0 }
  ];
  render(<PricingEditor rules={rules} officialRules={rules} usedModels={["model-unknown"]} busy={false} onSave={vi.fn()} />);
  const table = screen.getByRole("table", { name: "模型 API 等值價格" });
  const names = () => Array.from(table.querySelectorAll(".pricing-model-name"), element => element.textContent);
  expect(names()).toEqual(["model-2", "model-10", "model-free", "model-unknown"]);
  const cases = [
    { label: "輸入價格排序", ascending: ["model-free", "model-10", "model-2", "model-unknown"], descending: ["model-2", "model-10", "model-free", "model-unknown"] },
    { label: "快取輸入價格排序", ascending: ["model-free", "model-2", "model-10", "model-unknown"], descending: ["model-2", "model-free", "model-10", "model-unknown"] },
    { label: "輸出價格排序", ascending: ["model-free", "model-2", "model-10", "model-unknown"], descending: ["model-10", "model-2", "model-free", "model-unknown"] }
  ];
  for (const test of cases) {
    const button = within(table).getByRole("button", { name: test.label });
    fireEvent.click(button);
    expect(names()).toEqual(test.ascending);
    expect(button.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(table.querySelectorAll('th[aria-sort]:not([aria-sort="none"])')).toHaveLength(1);
    fireEvent.click(button);
    expect(names()).toEqual(test.descending);
    expect(button.closest("th")).toHaveAttribute("aria-sort", "descending");
  }
  fireEvent.change(screen.getByLabelText("搜尋模型價格"), { target: { value: "model-1" } });
  expect(names()).toEqual(["model-10"]);
  fireEvent.click(screen.getByRole("button", { name: "清除模型搜尋" }));
  expect(names()).toEqual(cases[2].descending);
  fireEvent.click(screen.getByRole("button", { name: "模型名稱排序" }));
  expect(names()).toEqual(["model-2", "model-10", "model-free", "model-unknown"]);
  fireEvent.click(screen.getByRole("button", { name: "模型名稱排序" }));
  expect(names()).toEqual(["model-unknown", "model-free", "model-10", "model-2"]);
});
