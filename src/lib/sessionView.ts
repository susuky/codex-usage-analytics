import type { SessionAggregate } from "../types";

export type SessionSortKey = "project" | "model" | "endedAt" | "tokens" | "cost";
export interface SessionSort { key: SessionSortKey; asc: boolean }
export type PricingFilter = "all" | "complete" | "partial" | "unpriced";

export function readSessionView(params: URLSearchParams) {
  const key = params.get("sort") ?? "endedAt";
  const pricing = params.get("pricing") ?? "all";
  const page = Number(params.get("page") ?? 1);
  const size = Number(params.get("size") ?? 25);
  return {
    query: params.get("q") ?? "",
    source: params.get("source") ?? "",
    model: params.get("model") ?? "",
    pricing: (["all", "complete", "partial", "unpriced"].includes(pricing) ? pricing : "all") as PricingFilter,
    sort: { key: (["project", "model", "endedAt", "tokens", "cost"].includes(key) ? key : "endedAt") as SessionSortKey, asc: params.get("direction") === "asc" },
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: [25, 50, 100].includes(size) ? size : 25,
  };
}

export function sessionPricing(session: SessionAggregate): Exclude<PricingFilter, "all"> | "empty" {
  if (session.tokens.totalTokens === 0) return "empty";
  if (session.estimateMicrousd === null) return "unpriced";
  return session.unpricedTurnCount > 0 || session.unpricedTokens > 0 ? "partial" : "complete";
}

export function filterSessions(sessions: SessionAggregate[], view: ReturnType<typeof readSessionView>) {
  const query = view.query.trim().toLocaleLowerCase();
  return sessions.filter(session =>
    (!view.source || session.sourceId === view.source) &&
    (!view.model || session.model === view.model) &&
    (view.pricing === "all" || sessionPricing(session) === view.pricing) &&
    (!query || `${session.project} ${session.model} ${session.sessionId}`.toLocaleLowerCase().includes(query))
  );
}

export function sortSessions(sessions: SessionAggregate[], sort: SessionSort) {
  return [...sessions].sort((a, b) => {
    const values: Record<SessionSortKey, [string | number, string | number]> = {
      project: [a.project, b.project], model: [a.model, b.model], endedAt: [a.endedAt, b.endedAt],
      tokens: [a.tokens.totalTokens, b.tokens.totalTokens], cost: [a.estimateMicrousd ?? -1, b.estimateMicrousd ?? -1],
    };
    const [left, right] = values[sort.key];
    return (typeof left === "number" ? left - Number(right) : String(left).localeCompare(String(right))) * (sort.asc ? 1 : -1);
  });
}
