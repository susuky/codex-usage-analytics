import { expect, it } from "vitest";
import { demoSessions } from "./mockData";
import { filterSessions, readSessionView, sessionPricing, sortSessions } from "./sessionView";

it("validates URL state and preserves supported filters", () => {
  const view = readSessionView(new URLSearchParams("q=api&source=local&model=gpt-5.6-sol&pricing=partial&sort=tokens&direction=asc&page=3&size=50"));
  expect(view).toEqual({ query: "api", source: "local", model: "gpt-5.6-sol", pricing: "partial", sort: { key: "tokens", asc: true }, page: 3, pageSize: 50 });
  for (const page of ["-1", "0", "1.5", "Infinity", "NaN", "9007199254740992"]) {
    expect(readSessionView(new URLSearchParams(`sort=oops&pricing=oops&size=999&page=${page}`))).toMatchObject({ pricing: "all", sort: { key: "endedAt", asc: false }, page: 1, pageSize: 25 });
  }
});

it("keeps partial, unpriced, zero-cost and zero-usage sessions distinct", () => {
  const session = demoSessions[0];
  expect(sessionPricing(session)).toBe("partial");
  expect(sessionPricing({ ...session, unpricedTurnCount: 0 })).toBe("partial");
  expect(sessionPricing({ ...session, estimateMicrousd: null })).toBe("unpriced");
  expect(sessionPricing({ ...session, estimateMicrousd: 0, unpricedTurnCount: 0, unpricedTokens: 0 })).toBe("complete");
  expect(sessionPricing({ ...session, tokens: { ...session.tokens, totalTokens: 0 } })).toBe("empty");
});

it("combines filters without treating whitespace as a missing result", () => {
  const view = readSessionView(new URLSearchParams("q=%20ALPHA%20&source=ssh-example-server&model=gpt-5.6-sol&pricing=partial"));
  expect(filterSessions(demoSessions, view)).toEqual([demoSessions[0]]);
  expect(filterSessions(demoSessions, { ...view, source: "local" })).toEqual([]);
  expect(filterSessions(demoSessions, readSessionView(new URLSearchParams("q=+++")))).toHaveLength(demoSessions.length);
  expect(filterSessions(demoSessions, readSessionView(new URLSearchParams("pricing=unpriced"))).every(session => session.estimateMicrousd === null)).toBe(true);
});

it("sorts the complete result without mutating its source", () => {
  const originalIds = demoSessions.map(session => session.sessionId);
  const sorted = sortSessions(demoSessions, { key: "tokens", asc: false });
  expect(sorted[0].tokens.totalTokens).toBe(Math.max(...demoSessions.map(session => session.tokens.totalTokens)));
  expect(sorted.map(session => session.tokens.totalTokens)).toEqual([...sorted.map(session => session.tokens.totalTokens)].sort((a, b) => b - a));
  expect(sortSessions(demoSessions, { key: "cost", asc: true })[0].estimateMicrousd).toBeNull();
  expect(demoSessions.map(session => session.sessionId)).toEqual(originalIds);
});
