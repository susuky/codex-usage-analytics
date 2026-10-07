import { invoke } from "@tauri-apps/api/core";
import { buildDemoOverview, buildDemoSources, demoSessions } from "./mockData";
import { emptyDailyUsage, localDateKey } from "./daily";
import { applyNonBillablePricing, isNonBillableModel, nonBillablePricingRule } from "./pricing";
import type { AppSettings, OverviewData, PricingRule, PricingStatus, PricingUpdateResult, ScanResult, SessionAggregate, SshSourceConfig, StoredSyncState, UsageFilter, UsageSource } from "../types";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function getOverview(filter: UsageFilter): Promise<OverviewData> {
  if (!isTauri()) return filterDemo(buildDemoOverview((await getSettings()).sshSources), filter);
  return invoke<OverviewData>("get_overview", { filter });
}

export async function listSessions(filter: UsageFilter): Promise<SessionAggregate[]> {
  if (!isTauri()) return (await getOverview(filter)).sessions;
  return invoke<SessionAggregate[]>("list_sessions", { filter });
}

export async function listSyncSessions(): Promise<SessionAggregate[]> {
  if (!isTauri()) return demoSessions;
  return invoke<SessionAggregate[]>("list_sync_sessions");
}

export async function getSessionDetail(sourceId: string, sessionId: string): Promise<SessionAggregate> {
  if (!isTauri()) {
    const session = demoSessions.find((item) => item.sourceId === sourceId && item.sessionId === sessionId) ?? demoSessions[2];
    return session.turns ? session : { ...session, turns: demoSessions[2].turns };
  }
  return invoke<SessionAggregate>("get_session_detail", { sourceId, sessionId });
}

export async function scanSources(forceFull = false): Promise<ScanResult> {
  if (!isTauri()) {
    await new Promise((resolve) => setTimeout(resolve, 550));
    return { sources: buildDemoSources((await getSettings()).sshSources), scannedSessions: demoSessions.length, scannedAt: new Date().toISOString() };
  }
  return invoke<ScanResult>("scan_sources", { forceFull });
}

export async function getSyncState(userId: string): Promise<StoredSyncState> {
  if (isTauri()) return invoke("get_sync_state", { userId });
  return JSON.parse(sessionStorage.getItem(`cloud-state:${userId}`) ?? '{"acknowledged":{},"pending":{},"lastSyncedAt":null}');
}
export async function saveSyncState(userId: string, syncState: StoredSyncState): Promise<void> {
  if (isTauri()) await invoke("save_sync_state", { userId, syncState });
  else sessionStorage.setItem(`cloud-state:${userId}`, JSON.stringify(syncState));
}
export async function mergeCloudSessions(userId: string, sessions: Array<{ sessionKey: string; session: SessionAggregate }>): Promise<void> {
  if (isTauri()) await invoke("merge_cloud_sessions", { userId, sessions });
}

export async function testSshSource(target: string, codexHome = ""): Promise<string> {
  if (!isTauri()) {
    throw new Error("請在桌面版測試遠端連線。");
  }
  return invoke<string>("test_ssh_source", { target, codexHome });
}

export const defaultPricingRules: PricingRule[] = [
  { model: "gpt-5.6-sol", inputUsdPerMillion: 4, cachedUsdPerMillion: 0.4, cacheWriteUsdPerMillion: 5, outputUsdPerMillion: 20, cacheWriteMultiplier: 1.25, longContextThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5, priorityMultiplier: 2, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol", reviewedAt: "2026-09-03" },
  { model: "gpt-5.6-terra", inputUsdPerMillion: 2, cachedUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 2.5, outputUsdPerMillion: 12, cacheWriteMultiplier: 1.25, longContextThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5, priorityMultiplier: 2, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-terra", reviewedAt: "2026-09-03" },
  { model: "gpt-5.6-luna", inputUsdPerMillion: 0.2, cachedUsdPerMillion: 0.02, cacheWriteUsdPerMillion: 0.25, outputUsdPerMillion: 1.2, cacheWriteMultiplier: 1.25, longContextThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5, priorityMultiplier: 2, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-luna", reviewedAt: "2026-09-03" },
  { model: "gpt-5.5", inputUsdPerMillion: 5, cachedUsdPerMillion: 0.5, cacheWriteUsdPerMillion: 6.25, outputUsdPerMillion: 30, cacheWriteMultiplier: 1.25, longContextThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5, priorityMultiplier: 2, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.5", reviewedAt: "2026-09-03" },
  { model: "gpt-5.4", inputUsdPerMillion: 2.5, cachedUsdPerMillion: 0.25, cacheWriteUsdPerMillion: 3.125, outputUsdPerMillion: 15, cacheWriteMultiplier: 1.25, longContextThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5, priorityMultiplier: 2, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4", reviewedAt: "2026-09-03" },
  { model: "gpt-5.3-codex", inputUsdPerMillion: 1.75, cachedUsdPerMillion: 0.175, cacheWriteUsdPerMillion: 2.1875, outputUsdPerMillion: 14, cacheWriteMultiplier: 1.25, longContextThreshold: 400000, longInputMultiplier: 1, longOutputMultiplier: 1, priorityMultiplier: 2, sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.3-codex", reviewedAt: "2026-09-03" },
  nonBillablePricingRule
];

const defaultSettings: AppSettings = {
  codexHome: "",
  sshTarget: "",
  sshEnabled: false,
  sshSources: [],
  cloudEnabled: true,
  pollMinutes: 15,
  pricingRules: defaultPricingRules,
  autoUpdatePricing: true
};

export async function getSettings(): Promise<AppSettings> {
  if (!isTauri()) {
    const raw = sessionStorage.getItem("codex-usage-settings");
    const saved = raw ? JSON.parse(raw) as Partial<AppSettings> : {};
    const loaded = { ...defaultSettings, ...saved };
    if (!("sshSources" in saved) && loaded.sshTarget?.trim()) {
      const host = loaded.sshTarget.split("@").at(-1) || "remote";
      loaded.sshSources = [{ id: `ssh-${host}`, name: host, target: loaded.sshTarget, codexHome: "", enabled: loaded.sshEnabled ?? true }];
    }
    loaded.sshSources = (loaded.sshSources ?? []).map((source: SshSourceConfig) => ({ ...source, codexHome: source.codexHome ?? "" }));
    loaded.pricingRules = applyNonBillablePricing((loaded.pricingRules?.length ? loaded.pricingRules : defaultPricingRules).map((rule: PricingRule) => ({ ...rule, priorityMultiplier: rule.priorityMultiplier ?? 2 })));
    return loaded;
  }
  return invoke<AppSettings>("get_settings");
}

export async function saveSettings(settings: AppSettings, basePricingRules?: PricingRule[]): Promise<void> {
  settings = { ...settings, pricingRules: applyNonBillablePricing(settings.pricingRules) };
  if (!isTauri()) {
    sessionStorage.setItem("codex-usage-settings", JSON.stringify(settings));
    window.dispatchEvent(new Event("usage-settings-changed"));
    return;
  }
  await invoke("save_settings", { settings, basePricingRules });
  window.dispatchEvent(new Event("usage-settings-changed"));
}

export async function getPricingStatus(): Promise<PricingStatus> {
  if (!isTauri()) return { checkedAt: null, updatedAt: null, lastError: null, officialRules: defaultPricingRules.filter(rule => !isNonBillableModel(rule.model)) };
  return invoke<PricingStatus>("get_pricing_status");
}

export async function refreshPricing(force = false): Promise<PricingUpdateResult | null> {
  if (!isTauri()) {
    if (force) throw new Error("請在桌面版更新官方價格。");
    return null;
  }
  try {
    const result = await invoke<PricingUpdateResult>("refresh_pricing", { force });
    if (result.changed) window.dispatchEvent(new Event("usage-settings-changed"));
    return result;
  } finally { window.dispatchEvent(new Event("usage-pricing-updated")); }
}

export async function openPricingDocs(): Promise<void> {
  if (!isTauri()) {
    window.open("https://developers.openai.com/api/docs/pricing", "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_pricing_docs");
}

export async function secureGet(key: string): Promise<string | null> {
  if (!isTauri()) return sessionStorage.getItem(`secure:${key}`);
  return invoke<string | null>("secure_get", { key });
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (!isTauri()) sessionStorage.setItem(`secure:${key}`, value);
  else await invoke("secure_set", { key, value });
}

export async function secureRemove(key: string): Promise<void> {
  if (!isTauri()) sessionStorage.removeItem(`secure:${key}`);
  else await invoke("secure_remove", { key });
}

function filterDemo(data: OverviewData, filter: UsageFilter): OverviewData {
  const sinceDate = new Date();
  sinceDate.setHours(12, 0, 0, 0);
  sinceDate.setDate(sinceDate.getDate() - Math.max(0, filter.days - 1));
  const startDate = filter.startDate ?? localDateKey(sinceDate);
  const endDate = filter.endDate;
  const sessions = data.sessions.filter((session) =>
    localDateKey(new Date(session.startedAt)) >= startDate &&
    (!endDate || localDateKey(new Date(session.startedAt)) <= endDate) &&
    (!filter.sourceId || session.sourceId === filter.sourceId) &&
    (!filter.model || session.model === filter.model) &&
    (!filter.project || session.project === filter.project)
  );
  if (sessions.length === data.sessions.length) return data;
  const sessionKeys = new Set(sessions.map((session) => `${session.sourceId}:${session.sessionId}`));
  const totals = sessions.reduce(
    (acc, session) => ({
      inputTokens: acc.inputTokens + session.tokens.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + session.tokens.cachedInputTokens,
      cacheWriteInputTokens: acc.cacheWriteInputTokens + session.tokens.cacheWriteInputTokens,
      outputTokens: acc.outputTokens + session.tokens.outputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + session.tokens.reasoningOutputTokens,
      totalTokens: acc.totalTokens + session.tokens.totalTokens
    }),
    { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }
  );
  const dailyMap = new Map<string, OverviewData["daily"][number]>();
  const modelMap = new Map<string, OverviewData["models"][number]>();
  for (const session of sessions) {
    const date = localDateKey(new Date(session.startedAt));
    const day = dailyMap.get(date) ?? emptyDailyUsage(date);
    day.uncachedInput += Math.max(0, session.tokens.inputTokens - session.tokens.cachedInputTokens - session.tokens.cacheWriteInputTokens);
    day.cachedInput += session.tokens.cachedInputTokens;
    day.cacheWriteInput += session.tokens.cacheWriteInputTokens;
    day.output += session.tokens.outputTokens;
    day.estimateMicrousd += session.estimateMicrousd ?? 0;
    day.unpricedTokens += session.unpricedTokens;
    day.sessions += 1;
    dailyMap.set(date, day);

    const model = modelMap.get(session.model) ?? { model: session.model, tokens: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }, estimateMicrousd: 0, sessions: 0, fastRequests: 0, fastTokens: 0, pricedRequests: 0, unpricedRequests: 0, unpricedTokens: 0, reasoningEfforts: [], unrecordedEffortRequests: 0 };
    model.tokens.inputTokens += session.tokens.inputTokens;
    model.tokens.cachedInputTokens += session.tokens.cachedInputTokens;
    model.tokens.cacheWriteInputTokens += session.tokens.cacheWriteInputTokens;
    model.tokens.outputTokens += session.tokens.outputTokens;
    model.tokens.reasoningOutputTokens += session.tokens.reasoningOutputTokens;
    model.tokens.totalTokens += session.tokens.totalTokens;
    model.sessions += 1;
    for (const turn of session.turns ?? []) {
      if (turn.serviceTier === "priority") { model.fastRequests += 1; model.fastTokens += turn.tokens.totalTokens; }
      if (!turn.reasoningEffort || turn.reasoningEffort === "unknown") model.unrecordedEffortRequests += 1;
      else {
        const effort = model.reasoningEfforts.find((item) => item.name === turn.reasoningEffort);
        if (effort) effort.count += 1;
        else model.reasoningEfforts.push({ name: turn.reasoningEffort, count: 1 });
      }
    }
    model.unpricedRequests += session.unpricedTurnCount;
    model.unpricedTokens += session.unpricedTokens;
    if (session.estimateMicrousd !== null) {
      model.pricedRequests += Math.max(0, session.tokenEventCount - session.unpricedTurnCount);
      model.estimateMicrousd = (model.estimateMicrousd ?? 0) + session.estimateMicrousd;
    }
    if (model.pricedRequests === 0) model.estimateMicrousd = null;
    modelMap.set(session.model, model);
  }
  return {
    ...data,
    sessions,
    daily: [...dailyMap.values()].sort((left, right) => left.date.localeCompare(right.date)),
    models: [...modelMap.values()],
    activityTokens: sessions.reduce((sum, session) => sum + session.activityTokens, 0),
    estimateMicrousd: sessions.reduce((sum, session) => sum + (session.estimateMicrousd ?? 0), 0),
    unpricedSessions: sessions.filter((session) => session.unpricedTurnCount > 0).length,
    totals,
    sources: data.sources.map((source) => ({
      ...source,
      sessionCount: sessions.filter((session) => session.sourceId === source.id && sessionKeys.has(`${session.sourceId}:${session.sessionId}`)).length,
      latestDataAt: sessions
        .filter((session) => session.sourceId === source.id)
        .reduce<string | null>((latest, session) => !latest || session.endedAt > latest ? session.endedAt : latest, null)
    })),
    activity: data.activity
  };
}
