export type SourceKind = "local" | "ssh" | "cloud";

export interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TurnUsage {
  ordinal: number;
  timestamp: string;
  model: string;
  serviceTier: "default" | "priority";
  reasoningEffort: string;
  tokens: TokenBreakdown;
  estimateMicrousd: number | null;
  cacheRate: number;
}

export interface SessionAggregate {
  sessionId: string;
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  project: string;
  model: string;
  startedAt: string;
  endedAt: string;
  origin: string;
  tokens: TokenBreakdown;
  activityTokens: number;
  estimateMicrousd: number | null;
  unpricedTurnCount: number;
  unpricedTokens: number;
  tokenEventCount: number;
  rateUsedPercent: number | null;
  rateWindowMinutes: number | null;
  turns?: TurnUsage[];
  activity?: SessionActivity;
}

export interface NamedCount { name: string; count: number }
export interface SessionActivity { skills: NamedCount[]; plugins: NamedCount[]; efforts: NamedCount[] }
export interface ActivityOverview extends SessionActivity {
  serviceTiers: NamedCount[];
  reasoningTokens: number;
  fastRequests: number;
  fastTokens: number;
  weightedUsageRequests: number;
}

export interface UsageSource {
  id: string;
  name: string;
  kind: SourceKind;
  target?: string;
  enabled: boolean;
  stale: boolean;
  lastScannedAt: string | null;
  lastError: string | null;
  sessionCount: number;
  latestDataAt: string | null;
}

export interface DailyUsage {
  date: string;
  uncachedInput: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  unclassified: number;
  estimateMicrousd: number;
  sessions: number;
}

export interface ModelUsage {
  model: string;
  tokens: TokenBreakdown;
  estimateMicrousd: number | null;
  sessions: number;
  fastRequests: number;
  fastTokens: number;
  pricedRequests: number;
  unpricedRequests: number;
  unpricedTokens: number;
  reasoningEfforts: NamedCount[];
  unrecordedEffortRequests: number;
}

export interface OverviewData {
  todayTokens: number;
  sessions: SessionAggregate[];
  daily: DailyUsage[];
  models: ModelUsage[];
  sources: UsageSource[];
  totals: TokenBreakdown;
  activityTokens: number;
  estimateMicrousd: number;
  unpricedSessions: number;
  activity: ActivityOverview;
}

export interface UsageFilter {
  days: number;
  startDate?: string;
  endDate?: string;
  sourceId?: string;
  model?: string;
  project?: string;
}

export interface PricingRule {
  model: string;
  inputUsdPerMillion: number;
  cachedUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheWriteMultiplier: number;
  longContextThreshold: number;
  longInputMultiplier: number;
  longOutputMultiplier: number;
  priorityMultiplier: number;
  sourceUrl: string;
  reviewedAt: string;
  unavailableRates?: string[];
}

export interface ScanResult {
  sources: UsageSource[];
  scannedSessions: number;
  scannedAt: string;
}

export interface SyncStatus {
  enabled: boolean;
  syncing: boolean;
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  pendingRows: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface StoredSyncState {
  acknowledged: Record<string, string>;
  pending: Record<string, string>;
  lastSyncedAt: string | null;
}

export interface AppSettings {
  codexHome: string;
  sshTarget?: string;
  sshEnabled?: boolean;
  sshSources: SshSourceConfig[];
  cloudEnabled: boolean;
  pollMinutes: number;
  pricingRules: PricingRule[];
  autoUpdatePricing?: boolean;
}

export interface PricingStatus {
  checkedAt: string | null;
  updatedAt: string | null;
  lastError: string | null;
  officialRules: PricingRule[];
}

export interface PricingUpdateResult {
  status: PricingStatus;
  changed: boolean;
}

export interface SshSourceConfig {
  id: string;
  name: string;
  target: string;
  codexHome: string;
  enabled: boolean;
}
