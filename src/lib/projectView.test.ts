import { expect, it } from "vitest";
import type { SessionAggregate } from "../types";
import { demoSessions } from "./mockData";
import { getProjectSummaries, getProjectSummary, projectPath } from "./projectView";

const session = (overrides: Partial<SessionAggregate> = {}): SessionAggregate => ({
  ...demoSessions[0],
  project: "/work/PinLens",
  tokens: { inputTokens: 80, cachedInputTokens: 50, cacheWriteInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 100 },
  estimateMicrousd: 7,
  unpricedTurnCount: 0,
  unpricedTokens: 0,
  startedAt: "2026-10-15T01:00:00Z",
  endedAt: "2026-10-15T02:00:00Z",
  ...overrides,
});

it("combines project period slices across sessions and sources without changing input", () => {
  const sessions = [
    session(),
    session({ sessionId: "second", sourceId: "remote", sourceName: "遠端", sourceKind: "ssh", startedAt: "2026-10-14T01:00:00Z", endedAt: "2026-10-16T02:00:00Z" }),
    session({ sessionId: "third", estimateMicrousd: null, unpricedTurnCount: 2, unpricedTokens: 100 }),
  ];
  const original = structuredClone(sessions);
  expect(getProjectSummaries(sessions)).toEqual([{
    project: "/work/PinLens",
    tokens: { inputTokens: 240, cachedInputTokens: 150, cacheWriteInputTokens: 30, outputTokens: 60, reasoningOutputTokens: 15, totalTokens: 300 },
    estimateMicrousd: 14,
    unpricedTurnCount: 2,
    unpricedTokens: 100,
    sessionCount: 3,
    sources: [{ id: "local", name: "這台電腦", kind: "local" }, { id: "remote", name: "遠端", kind: "ssh" }],
    startedAt: "2026-10-14T01:00:00Z",
    endedAt: "2026-10-16T02:00:00Z",
  }]);
  expect(sessions).toEqual(original);
});

it("keeps full project identities separate and returns exact matches", () => {
  const sessions = [session(), session({ project: "/other/PinLens" }), session({ project: "/work/PinLens", sessionId: "second" })];
  expect(getProjectSummaries(sessions).map(summary => [summary.project, summary.sessionCount])).toEqual([["/work/PinLens", 2], ["/other/PinLens", 1]]);
  expect(getProjectSummary(sessions, "/other/PinLens")?.sessionCount).toBe(1);
  expect(getProjectSummary(sessions, "PinLens")).toBeUndefined();
  expect(getProjectSummaries([])).toEqual([]);
});

it("preserves unknown cost, partial estimates, and priced zero cost regardless of input order", () => {
  const unpriced = session({ estimateMicrousd: null, unpricedTurnCount: 1, unpricedTokens: 100 });
  expect(getProjectSummaries([unpriced, unpriced])[0]).toMatchObject({ estimateMicrousd: null, unpricedTurnCount: 2, unpricedTokens: 200 });
  for (const sessions of [[unpriced, session()], [session(), unpriced]]) {
    expect(getProjectSummaries(sessions)[0]).toMatchObject({ estimateMicrousd: 7, unpricedTurnCount: 1, unpricedTokens: 100 });
  }
  expect(getProjectSummaries([unpriced, session({ estimateMicrousd: 0 })])[0]).toMatchObject({ estimateMicrousd: 0, unpricedTokens: 100 });
});

it("compares activity timestamps by their instant and encodes complete project paths", () => {
  const summary = getProjectSummaries([
    session({ startedAt: "2026-10-15T09:00:00+08:00", endedAt: "2026-10-15T10:00:00+08:00" }),
    session({ startedAt: "2026-10-15T00:30:00Z", endedAt: "2026-10-15T03:00:00Z" }),
  ])[0];
  expect(summary.startedAt).toBe("2026-10-15T00:30:00Z");
  expect(summary.endedAt).toBe("2026-10-15T03:00:00Z");
  const project = "C:\\專案\\PinLens /測試#1?";
  const path = projectPath(project);
  expect(path).toBe(`/projects/${encodeURIComponent(project)}`);
  expect(decodeURIComponent(path.slice("/projects/".length))).toBe(project);
});
