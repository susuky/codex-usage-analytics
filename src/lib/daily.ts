import type { DailyUsage } from "../types";

export const emptyDailyUsage = (date: string): DailyUsage => ({
  date,
  uncachedInput: 0,
  cachedInput: 0,
  cacheWriteInput: 0,
  output: 0,
  unclassified: 0,
  estimateMicrousd: 0,
  sessions: 0
});

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fillDailyRange(daily: DailyUsage[], days: number, now = new Date()): DailyUsage[] {
  if (days > 366) return daily;
  const values = new Map(daily.map((item) => [item.date, item]));
  const result: DailyUsage[] = [];
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  cursor.setDate(cursor.getDate() - Math.max(0, days - 1));
  for (let index = 0; index < days; index += 1) {
    const key = localDateKey(cursor);
    result.push(values.get(key) ?? emptyDailyUsage(key));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function dateFromKey(value: string): Date | null {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  return localDateKey(date) === value ? date : null;
}

export function fillDailyDateRange(daily: DailyUsage[], startDate: string, endDate: string): DailyUsage[] {
  const start = dateFromKey(startDate);
  const end = dateFromKey(endDate);
  if (!start || !end || start > end) return daily;

  const dayCount = Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86_400_000) + 1;
  const selected = daily.filter((item) => item.date >= startDate && item.date <= endDate);
  if (dayCount > 366) return selected;

  const values = new Map(selected.map((item) => [item.date, item]));
  const result: DailyUsage[] = [];
  const cursor = new Date(start);
  for (let index = 0; index < dayCount; index += 1) {
    const key = localDateKey(cursor);
    result.push(values.get(key) ?? emptyDailyUsage(key));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

export function dailyTokenTotal(day?: DailyUsage): number {
  if (!day) return 0;
  return day.uncachedInput + day.cachedInput + day.cacheWriteInput + day.output + day.unclassified;
}
