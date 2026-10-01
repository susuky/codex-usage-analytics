import { beforeEach, expect, it, vi } from "vitest";
import { loadDateRange, saveDateRange, loadSidebarCollapsed, saveSidebarCollapsed } from "./preferences";

beforeEach(() => localStorage.clear());

it("restores presets and custom dates without retaining other page filters", () => {
  saveDateRange({ days: 30, model: "private-model", project: "private-project" });
  expect(loadDateRange()).toEqual({ days: 30 });
  saveDateRange({ days: 1, startDate: "2026-09-01", endDate: "2026-09-03" });
  expect(loadDateRange()).toEqual({ days: 3, startDate: "2026-09-01", endDate: "2026-09-03" });
  saveSidebarCollapsed(true);
  expect(loadSidebarCollapsed()).toBe(true);
});

it("ignores malformed preferences and keeps the app usable without storage", () => {
  for (const raw of ["bad json", "null", '{"days":-1}', '{"days":5,"startDate":"2026-02-30","endDate":"2026-03-01"}']) {
    localStorage.setItem("codex-usage-date-range-v1", raw);
    expect(loadDateRange()).toEqual({ days: 365 });
  }
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  expect(() => saveDateRange({ days: 7 })).not.toThrow();
  spy.mockRestore();
});
