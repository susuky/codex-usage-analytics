import { expect, it } from "vitest";
import { buildSessionTimeline, sessionTimeAxisFormat } from "./sessionDetail";
import type { TurnUsage } from "../types";

const turn = (ordinal: number, timestamp: string, model = "gpt-6-astra"): TurnUsage => ({
  ordinal, timestamp, model, serviceTier: "default", reasoningEffort: "high",
  tokens: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 },
  estimateMicrousd: null, cacheRate: 80,
});

it("accumulates chronological usage across model switches and preserves actual time gaps", () => {
  const turns = [turn(9, "2026-10-13T01:00:00Z"), turn(2, "2026-10-12T01:00:00Z", "gpt-6.1-sol"), turn(4, "2026-10-12T01:01:00Z")];
  const points = buildSessionTimeline(turns);
  expect(points.map(point => point.ordinal)).toEqual([2, 4, 9]);
  expect(points.map(point => point.model)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-astra"]);
  expect(points.map(point => point.total)).toEqual([110, 220, 330]);
  expect(points[2]).toMatchObject({ input: 300, output: 30, reasoning: 6 });
  expect(points[1].timestamp - points[0].timestamp).toBe(60_000);
  expect(points[2].timestamp - points[0].timestamp).toBe(86_400_000);
  expect(turns.map(turn => turn.ordinal)).toEqual([9, 2, 4]);
});

it("keeps equal timestamps ordered and omits undated usage without inventing a date", () => {
  const timestamp = "2026-10-13T01:00:00Z";
  expect(buildSessionTimeline([turn(2, timestamp), turn(3, ""), turn(1, timestamp), turn(4, "invalid")]).map(point => [point.ordinal, point.total]))
    .toEqual([[1, 110], [2, 220]]);
  expect(buildSessionTimeline([])).toEqual([]);
});

it("uses local times within a day, dates across days and years across a year boundary", () => {
  const start = new Date(2026, 9, 13, 9, 0).getTime();
  expect(sessionTimeAxisFormat(start, start + 600_000).format(start)).toBe("09:00");
  expect(sessionTimeAxisFormat(start, start + 10_000).format(start + 1_000)).toBe("09:00:01");
  expect(sessionTimeAxisFormat(start, start + 432_000_000).format(start)).toBe("10/13");
  expect(sessionTimeAxisFormat(start, start + 86_400_000).format(start).replace(/\s+/g, " ")).toBe("10/13 09:00");
  const yearEnd = new Date(2026, 11, 31, 23, 59).getTime();
  expect(sessionTimeAxisFormat(yearEnd, yearEnd + 120_000).format(yearEnd + 120_000).replace(/\s+/g, " ")).toBe("2027/01/01 00:01");
});
