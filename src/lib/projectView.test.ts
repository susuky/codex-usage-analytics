import { expect, it } from "vitest";
import type { SessionAggregate } from "../types";
import { demoSessions } from "./mockData";
import { getProjectSummaries, getProjectSummary, projectPath, readProjectSort, sortProjects, type ProjectSortKey } from "./projectView";

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

it("reads project sort direction with column defaults and validates URL values", () => {
  expect(readProjectSort(new URLSearchParams())).toEqual({ key: "tokens", asc: false });
  for (const key of ["name", "sessions", "source", "latest", "tokens", "cost"] as const) {
    const asc = key === "name" || key === "source";
    expect(readProjectSort(new URLSearchParams(`sort=${key}`))).toEqual({ key, asc });
    expect(readProjectSort(new URLSearchParams(`sort=${key}&direction=invalid`))).toEqual({ key, asc });
    expect(readProjectSort(new URLSearchParams(`sort=${key}&direction=asc`))).toEqual({ key, asc: true });
    expect(readProjectSort(new URLSearchParams(`sort=${key}&direction=desc`))).toEqual({ key, asc: false });
  }
  expect(readProjectSort(new URLSearchParams("sort=invalid&direction=invalid"))).toEqual({ key: "tokens", asc: false });
  expect(readProjectSort(new URLSearchParams("sort=invalid&direction=asc"))).toEqual({ key: "tokens", asc: true });
});

it("sorts all six project columns in both directions without changing rows", () => {
  const base = getProjectSummaries([session()])[0];
  const rows = [
    { ...base, project: "Gamma", sessionCount: 2, tokens: { ...base.tokens, totalTokens: 30 }, sources: [{ id: "a", name: "alpha", kind: "ssh" as const }, { id: "z", name: "zulu", kind: "ssh" as const }], endedAt: "2026-10-16T02:00:00Z", estimateMicrousd: 1 },
    { ...base, project: "Beta", sessionCount: 1, tokens: { ...base.tokens, totalTokens: 10 }, sources: [{ id: "a", name: "alpha", kind: "ssh" as const }, { id: "z", name: "zeta", kind: "ssh" as const }], endedAt: "2026-10-16T09:00:00+08:00", estimateMicrousd: 2 },
    { ...base, project: "Alpha", sessionCount: 3, tokens: { ...base.tokens, totalTokens: 20 }, sources: [{ id: "z", name: "zeta", kind: "ssh" as const }], endedAt: "2026-10-16T01:00:00Z", estimateMicrousd: 0 },
  ];
  const original = structuredClone(rows);
  const cases: Array<[ProjectSortKey, string[], string[]]> = [
    ["name", ["Alpha", "Beta", "Gamma"], ["Gamma", "Beta", "Alpha"]],
    ["sessions", ["Beta", "Gamma", "Alpha"], ["Alpha", "Gamma", "Beta"]],
    ["source", ["Beta", "Gamma", "Alpha"], ["Alpha", "Gamma", "Beta"]],
    ["latest", ["Alpha", "Beta", "Gamma"], ["Gamma", "Alpha", "Beta"]],
    ["tokens", ["Beta", "Alpha", "Gamma"], ["Gamma", "Alpha", "Beta"]],
    ["cost", ["Alpha", "Gamma", "Beta"], ["Beta", "Gamma", "Alpha"]],
  ];
  for (const [key, ascending, descending] of cases) {
    for (const [asc, expected] of [[true, ascending], [false, descending]] as const) {
      const sorted = sortProjects(rows, { key, asc });
      expect(sorted.map(row => row.project)).toEqual(expected);
      expect(sorted).not.toBe(rows);
    }
  }
  expect(rows).toEqual(original);
});

it("keeps missing costs and invalid activity dates last in either direction", () => {
  const base = getProjectSummaries([session()])[0];
  const rows = [
    { ...base, project: "D", estimateMicrousd: null, endedAt: "invalid" },
    { ...base, project: "C", estimateMicrousd: null, endedAt: "" },
    { ...base, project: "B", estimateMicrousd: 3, endedAt: "2026-10-16T01:00:00Z" },
    { ...base, project: "A", estimateMicrousd: 0, endedAt: "2026-10-16T10:00:00+08:00" },
  ];
  expect(sortProjects(rows, { key: "cost", asc: true }).map(row => row.project)).toEqual(["A", "B", "C", "D"]);
  expect(sortProjects(rows, { key: "cost", asc: false }).map(row => row.project)).toEqual(["B", "A", "C", "D"]);
  expect(sortProjects(rows, { key: "latest", asc: true }).map(row => row.project)).toEqual(["B", "A", "C", "D"]);
  expect(sortProjects(rows, { key: "latest", asc: false }).map(row => row.project)).toEqual(["A", "B", "C", "D"]);
});
