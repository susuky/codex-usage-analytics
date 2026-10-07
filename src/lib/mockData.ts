import type { DailyUsage, OverviewData, SessionAggregate, SshSourceConfig, TokenBreakdown, TurnUsage, UsageSource } from "../types";
import { emptyDailyUsage, localDateKey } from "./daily";
import { isNonBillableModel } from "./pricing";

const baseDate = new Date();
baseDate.setHours(9, 21, 0, 0);

const tokens = (input: number, cached: number, output: number, reasoning: number, cacheWrite = 0): TokenBreakdown => ({
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: cacheWrite,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
  totalTokens: input + output
});

const projects = ["alpha-api-service", "data-pipeline", "web-dashboard", "ml-evaluation", "internal-tools"];
const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "codex-auto-review"];
const totals = [128430, 92118, 74562, 61204, 48731];

export const demoSessions: SessionAggregate[] = Array.from({ length: 42 }, (_, index) => {
  const date = new Date(baseDate);
  date.setHours(date.getHours() - index * 8);
  const total = index < totals.length ? totals[index] : 34_000 + ((index * 7919) % 74_000);
  const output = Math.max(340, Math.round(total * (0.008 + (index % 4) * 0.002)));
  const input = total - output;
  const cached = Math.round(input * (0.56 + (index % 5) * 0.065));
  const model = models[index % models.length];
  const cacheWrite = Math.round(input * (0.01 + (index % 3) * 0.006));
  const usage = tokens(input, cached, output, Math.round(output * 0.35), cacheWrite);
  const reviewTurns: TurnUsage[] | undefined = isNonBillableModel(model) ? Array.from({ length: 12 }, (_, ordinal) => {
    const part = (value: number) => Math.floor(value / 12) + (ordinal < value % 12 ? 1 : 0);
    const turnTokens = tokens(part(input), part(cached), part(output), part(usage.reasoningOutputTokens), part(cacheWrite));
    return { ordinal: ordinal + 1, timestamp: new Date(date.getTime() + ordinal * 94_000).toISOString(), model,
      serviceTier: "default", reasoningEffort: "low", tokens: turnTokens, estimateMicrousd: 0,
      cacheRate: turnTokens.cachedInputTokens / turnTokens.inputTokens * 100 };
  }) : undefined;
  const modelRate = isNonBillableModel(model) ? 0 : model === "gpt-5.6-sol" ? 4 : model === "gpt-5.6-terra" ? 2 : model === "gpt-5.6-luna" ? 0.2 : model === "gpt-5.5" ? 5 : model === "gpt-5.4" ? 2.5 : null;
  return {
    sessionId: `00000000-0000-4000-${String(9000 + index)}-000000000000`,
    sourceId: "local",
    sourceName: "這台電腦",
    sourceKind: "local",
    project: projects[index % projects.length],
    model,
    startedAt: date.toISOString(),
    endedAt: new Date(date.getTime() + 18 * 60_000).toISOString(),
    origin: "Codex Desktop",
    tokens: usage,
    activityTokens: total,
    estimateMicrousd: modelRate === null ? null : Math.round((((input - cached) * modelRate + cached * modelRate * 0.1 + output * modelRate * 5) / 1_000_000) * 1_000_000),
    unpricedTurnCount: modelRate === null ? 12 : index === 0 ? 1 : 0,
    unpricedTokens: modelRate === null ? total : index === 0 ? 12_167 : 0,
    tokenEventCount: 12,
    turns: reviewTurns,
    rateUsedPercent: 14,
    rateWindowMinutes: 10080
  };
});

const detailTurns: TurnUsage[] = Array.from({ length: 12 }, (_, index) => {
  const input = 8241 + index * 1437;
  const cached = Math.round(input * (0.82 + (index % 3) * 0.012));
  const output = 327 + index * 43;
  return {
    ordinal: index + 1,
    timestamp: new Date(baseDate.getTime() + index * 94_000).toISOString(),
    model: "gpt-5.6-luna",
    serviceTier: index % 4 === 0 ? "priority" : "default",
    reasoningEffort: ["medium", "high", "xhigh"][index % 3],
    tokens: tokens(input, cached, output, Math.round(output * 0.2)),
    estimateMicrousd: Math.round((input - cached) * 0.2 + cached * 0.02 + output * 1.2),
    cacheRate: (cached / input) * 100
  };
});

const detailTotal = detailTurns.reduce(
  (acc, turn) => ({
    inputTokens: acc.inputTokens + turn.tokens.inputTokens,
    cachedInputTokens: acc.cachedInputTokens + turn.tokens.cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens: acc.outputTokens + turn.tokens.outputTokens,
    reasoningOutputTokens: acc.reasoningOutputTokens + turn.tokens.reasoningOutputTokens,
    totalTokens: acc.totalTokens + turn.tokens.totalTokens
  }),
  tokens(0, 0, 0, 0)
);

demoSessions[2] = {
  ...demoSessions[2],
  tokens: detailTotal,
  estimateMicrousd: detailTurns.reduce((sum, turn) => sum + (turn.estimateMicrousd ?? 0), 0),
  unpricedTurnCount: 0,
  unpricedTokens: 0,
  turns: detailTurns,
  tokenEventCount: detailTurns.length
};

export function buildDemoSources(remoteSources: SshSourceConfig[] = []): UsageSource[] {
  return [
    { id: "local", name: "這台電腦", kind: "local", enabled: true, stale: false, lastScannedAt: new Date().toISOString(), lastError: null, sessionCount: demoSessions.length, latestDataAt: demoSessions[0].endedAt },
    ...remoteSources.map((source): UsageSource => ({
      id: source.id, name: source.name, kind: "ssh", target: source.target, enabled: source.enabled,
      stale: true, lastScannedAt: null, lastError: null, sessionCount: 0, latestDataAt: null
    }))
  ];
}

export function buildDemoOverview(remoteSources: SshSourceConfig[] = []): OverviewData {
  const map = new Map<string, DailyUsage>();
  for (const session of demoSessions) {
    const date = localDateKey(new Date(session.startedAt));
    const item = map.get(date) ?? emptyDailyUsage(date);
    item.cachedInput += session.tokens.cachedInputTokens;
    item.cacheWriteInput += session.tokens.cacheWriteInputTokens;
    item.uncachedInput += Math.max(0, session.tokens.inputTokens - session.tokens.cachedInputTokens - session.tokens.cacheWriteInputTokens);
    item.output += session.tokens.outputTokens;
    item.estimateMicrousd += session.estimateMicrousd ?? 0;
    item.unpricedTokens += session.unpricedTokens;
    item.sessions += 1;
    map.set(date, item);
  }
  const daily = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals = demoSessions.reduce(
    (acc, session) => ({
      inputTokens: acc.inputTokens + session.tokens.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + session.tokens.cachedInputTokens,
      cacheWriteInputTokens: acc.cacheWriteInputTokens + session.tokens.cacheWriteInputTokens,
      outputTokens: acc.outputTokens + session.tokens.outputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + session.tokens.reasoningOutputTokens,
      totalTokens: acc.totalTokens + session.tokens.totalTokens
    }),
    tokens(0, 0, 0, 0)
  );
  const grouped = new Map<string, SessionAggregate[]>();
  demoSessions.forEach((session) => grouped.set(session.model, [...(grouped.get(session.model) ?? []), session]));
  const modelUsage = [...grouped.entries()].map(([model, sessions]) => {
    const priced = sessions.filter((session) => session.estimateMicrousd !== null);
    const observedEffort = model === "gpt-5.6-sol" ? "max" : model === "gpt-5.6-terra" ? "high" : model === "gpt-5.6-luna" ? "medium" : model === "codex-auto-review" ? "low" : "xhigh";
    return {
      model,
      sessions: sessions.length,
      fastRequests: sessions.flatMap((session) => session.turns ?? []).filter((turn) => turn.serviceTier === "priority").length,
      fastTokens: sessions.flatMap((session) => session.turns ?? []).filter((turn) => turn.serviceTier === "priority").reduce((sum, turn) => sum + turn.tokens.totalTokens, 0),
      pricedRequests: sessions.reduce((sum, session) => sum + Math.max(0, session.tokenEventCount - session.unpricedTurnCount), 0),
      unpricedRequests: sessions.reduce((sum, session) => sum + session.unpricedTurnCount, 0),
      unpricedTokens: sessions.reduce((sum, session) => sum + session.unpricedTokens, 0),
      reasoningEfforts: [{ name: observedEffort, count: sessions.reduce((sum, session) => sum + session.tokenEventCount, 0) }],
      unrecordedEffortRequests: 0,
      tokens: sessions.reduce(
      (acc, session) => ({
        inputTokens: acc.inputTokens + session.tokens.inputTokens,
        cachedInputTokens: acc.cachedInputTokens + session.tokens.cachedInputTokens,
        cacheWriteInputTokens: acc.cacheWriteInputTokens + session.tokens.cacheWriteInputTokens,
        outputTokens: acc.outputTokens + session.tokens.outputTokens,
        reasoningOutputTokens: acc.reasoningOutputTokens + session.tokens.reasoningOutputTokens,
        totalTokens: acc.totalTokens + session.tokens.totalTokens
      }),
      tokens(0, 0, 0, 0)
    ),
      estimateMicrousd: priced.length ? priced.reduce((sum, session) => sum + (session.estimateMicrousd ?? 0), 0) : null
    };
  });
  return {
    todayTokens: daily.filter((day) => day.date === localDateKey(new Date())).reduce((sum, day) => sum + day.uncachedInput + day.cachedInput + day.cacheWriteInput + day.output + day.unclassified, 0),
    sessions: demoSessions,
    daily,
    models: modelUsage,
    sources: buildDemoSources(remoteSources),
    totals,
    activityTokens: demoSessions.reduce((sum, session) => sum + session.activityTokens, 0),
    estimateMicrousd: demoSessions.reduce((sum, session) => sum + (session.estimateMicrousd ?? 0), 0),
    unpricedSessions: 0
    ,activity: {
      skills: [{ name: "openai-docs", count: 18 }, { name: "frontend-testing-debugging", count: 12 }, { name: "react-best-practices", count: 9 }, { name: "data-visualization", count: 7 }],
      plugins: [{ name: "Build Web Apps", count: 21 }, { name: "Browser", count: 16 }, { name: "Data Visualization", count: 7 }, { name: "ImageGen", count: 3 }],
      efforts: [{ name: "medium", count: 24 }, { name: "high", count: 11 }, { name: "xhigh", count: 5 }, { name: "low", count: 2 }],
      serviceTiers: [{ name: "標準模式", count: 9 }, { name: "快速模式", count: 3 }],
      reasoningTokens: totals.reasoningOutputTokens,
      fastRequests: 3,
      fastTokens: detailTurns.filter((turn) => turn.serviceTier === "priority").reduce((sum, turn) => sum + turn.tokens.totalTokens, 0)
    }
  };
}
