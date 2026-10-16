import type { SessionAggregate, TokenBreakdown, UsageSource } from "../types";

export interface ProjectSummary {
  project: string;
  tokens: TokenBreakdown;
  estimateMicrousd: number | null;
  unpricedTurnCount: number;
  unpricedTokens: number;
  sessionCount: number;
  sources: Pick<UsageSource, "id" | "name" | "kind">[];
  startedAt: string;
  endedAt: string;
}

export type ProjectSortKey = "name" | "sessions" | "source" | "latest" | "tokens" | "cost";
export interface ProjectSort { key: ProjectSortKey; asc: boolean }

export function readProjectSort(params: URLSearchParams): ProjectSort {
  const requested = params.get("sort") ?? "tokens";
  const key = (["name", "sessions", "source", "latest", "tokens", "cost"].includes(requested) ? requested : "tokens") as ProjectSortKey;
  const direction = params.get("direction");
  return { key, asc: direction === "asc" ? true : direction === "desc" ? false : key === "name" || key === "source" };
}

export function sortProjects(rows: ProjectSummary[], sort: ProjectSort): ProjectSummary[] {
  const value = (row: ProjectSummary) => {
    switch (sort.key) {
      case "name": return row.project;
      case "sessions": return row.sessionCount;
      case "source": return row.sources.map(source => source.name).join("、");
      case "latest": {
        const timestamp = Date.parse(row.endedAt);
        return Number.isFinite(timestamp) ? timestamp : null;
      }
      case "cost": return row.estimateMicrousd;
      default: return row.tokens.totalTokens;
    }
  };
  return [...rows].sort((a, b) => {
    const left = value(a), right = value(b);
    const tie = a.project.localeCompare(b.project);
    if (left === null || right === null) return Number(left === null) - Number(right === null) || tie;
    const comparison = typeof left === "number" ? left - Number(right) : left.localeCompare(String(right));
    return comparison * (sort.asc ? 1 : -1) || tie;
  });
}

export const projectPath = (project: string) => `/projects/${encodeURIComponent(project)}`;

export function getProjectSummaries(sessions: SessionAggregate[]): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>();
  for (const session of sessions) {
    let summary = projects.get(session.project);
    if (!summary) {
      summary = {
        project: session.project,
        tokens: { ...session.tokens },
        estimateMicrousd: session.estimateMicrousd,
        unpricedTurnCount: session.unpricedTurnCount,
        unpricedTokens: session.unpricedTokens,
        sessionCount: 1,
        sources: [{ id: session.sourceId, name: session.sourceName, kind: session.sourceKind }],
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      };
      projects.set(session.project, summary);
      continue;
    }
    summary.tokens.inputTokens += session.tokens.inputTokens;
    summary.tokens.cachedInputTokens += session.tokens.cachedInputTokens;
    summary.tokens.cacheWriteInputTokens += session.tokens.cacheWriteInputTokens;
    summary.tokens.outputTokens += session.tokens.outputTokens;
    summary.tokens.reasoningOutputTokens += session.tokens.reasoningOutputTokens;
    summary.tokens.totalTokens += session.tokens.totalTokens;
    if (session.estimateMicrousd !== null) summary.estimateMicrousd = (summary.estimateMicrousd ?? 0) + session.estimateMicrousd;
    summary.unpricedTurnCount += session.unpricedTurnCount;
    summary.unpricedTokens += session.unpricedTokens;
    summary.sessionCount += 1;
    if (!summary.sources.some(source => source.id === session.sourceId)) {
      summary.sources.push({ id: session.sourceId, name: session.sourceName, kind: session.sourceKind });
    }
    if (Date.parse(session.startedAt) < Date.parse(summary.startedAt)) summary.startedAt = session.startedAt;
    if (Date.parse(session.endedAt) > Date.parse(summary.endedAt)) summary.endedAt = session.endedAt;
  }
  return [...projects.values()].sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens || a.project.localeCompare(b.project));
}

export function getProjectSummary(sessions: SessionAggregate[], project: string): ProjectSummary | undefined {
  return getProjectSummaries(sessions.filter(session => session.project === project))[0];
}
