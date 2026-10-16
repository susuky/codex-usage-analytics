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
