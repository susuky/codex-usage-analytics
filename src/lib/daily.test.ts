import { describe, expect, it } from "vitest";
import { dailyEstimate, dailyTokenTotal, emptyDailyUsage, fillDailyDateRange, fillDailyRange, formatDailyCost } from "./daily";

describe("daily usage", () => {
  it("fills every date in a seven-day range", () => {
    const values = fillDailyRange([
      { date: "2026-09-01", uncachedInput: 10, cachedInput: 20, cacheWriteInput: 5, output: 2, unclassified: 3, estimateMicrousd: 0, unpricedTokens: 0, sessions: 1 }
    ], 7, new Date(2026, 8, 3, 9));
    expect(values).toHaveLength(7);
    expect(values.map((item) => item.date)).toEqual(["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(dailyTokenTotal(values[4])).toBe(40);
    expect(dailyTokenTotal(values[6])).toBe(0);
  });

  it("fills an inclusive custom date range", () => {
    const values = fillDailyDateRange([
      { date: "2026-09-02", uncachedInput: 10, cachedInput: 0, cacheWriteInput: 0, output: 2, unclassified: 0, estimateMicrousd: 0, unpricedTokens: 0, sessions: 1 }
    ], "2026-09-01", "2026-09-03");

    expect(values.map((item) => item.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(dailyTokenTotal(values[1])).toBe(12);
  });

  it("distinguishes free and empty days from partially or entirely unpriced usage", () => {
    const empty = emptyDailyUsage("2026-10-07");
    const free = { ...empty, uncachedInput: 100 };
    const unknown = { ...free, unpricedTokens: 100 };
    const partial = { ...free, unpricedTokens: 50, estimateMicrousd: 12345678 };
    expect(formatDailyCost(empty)).toBe("US$0.00");
    expect(formatDailyCost(free)).toBe("US$0.00");
    expect(formatDailyCost(unknown)).toBe("無法估算");
    expect(dailyEstimate(unknown)).toBeNull();
    expect(formatDailyCost(partial)).toBe("US$12.35（部分）");
    expect(dailyEstimate(partial)).toBe(12345678);
  });
});
