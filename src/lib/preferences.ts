import type { UsageFilter } from "../types";

const DATE_KEY = "codex-usage-date-range-v1";
const SIDEBAR_KEY = "codex-usage-sidebar-v1";
const presets = new Set([1, 7, 30, 90, 365, 36500]);

function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); }
  catch { return null; }
}

function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Preferences are optional when storage is unavailable. */ }
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function loadDateRange(): UsageFilter {
  const saved = read(DATE_KEY) as Partial<UsageFilter> | null;
  if (saved && validDate(saved.startDate) && validDate(saved.endDate) && saved.startDate <= saved.endDate) {
    const days = Math.round((Date.parse(saved.endDate) - Date.parse(saved.startDate)) / 86_400_000) + 1;
    return { days, startDate: saved.startDate, endDate: saved.endDate };
  }
  return { days: saved && presets.has(saved.days ?? 0) ? saved.days! : 365 };
}

export function saveDateRange({ days, startDate, endDate }: UsageFilter) {
  write(DATE_KEY, { days, startDate, endDate });
}

export function loadSidebarCollapsed(): boolean {
  const saved = read(SIDEBAR_KEY);
  return typeof saved === "boolean" ? saved : window.matchMedia?.("(max-width: 1100px)").matches ?? false;
}

export function saveSidebarCollapsed(collapsed: boolean) { write(SIDEBAR_KEY, collapsed); }
