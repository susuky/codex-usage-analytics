import type { SessionAggregate, StoredSyncState, TokenBreakdown, TurnUsage } from "../types";

export async function hashKey(userId: string, value: string) {
  const bytes = new TextEncoder().encode(`${userId}:${value}`);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export const localKey = (session: SessionAggregate) => `${session.sourceId}:${session.sessionId}`;
export const fingerprint = (session: SessionAggregate) => JSON.stringify([5, session.endedAt, session.model, session.tokens, session.tokenEventCount, session.estimateMicrousd, session.unpricedTokens]);

export function queueSnapshots(state: StoredSyncState, sessions: SessionAggregate[]): StoredSyncState {
  const pending = { ...state.pending };
  for (const session of sessions.filter((s) => s.sourceKind !== "cloud")) {
    const key = localKey(session), version = fingerprint(session);
    if (state.acknowledged[key] !== version) pending[key] = version;
    else delete pending[key];
  }
  return { ...state, pending };
}

interface TokenRow {
  input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number;
  output_tokens: number; reasoning_output_tokens: number; total_tokens: number;
}
export interface SessionRow extends TokenRow {
  source_key: string; session_key: string; project_key: string; started_at: string; ended_at: string;
  model: string; origin: string; token_event_count: number; estimate_microusd: number | null;
  aggregation_version: number; observed_at: string;
}
export interface TurnRow extends TokenRow {
  turn_ordinal: number; occurred_at: string; model: string; service_tier: "default" | "priority";
  reasoning_effort: string; estimate_microusd: number | null;
}
export interface CloudSnapshot { session: SessionRow; turns: TurnRow[] }

const toRow = (tokens: TokenBreakdown): TokenRow => ({
  input_tokens: tokens.inputTokens, cached_input_tokens: tokens.cachedInputTokens, cache_write_input_tokens: tokens.cacheWriteInputTokens,
  output_tokens: tokens.outputTokens, reasoning_output_tokens: tokens.reasoningOutputTokens, total_tokens: tokens.totalTokens,
});
const fromRow = (row: TokenRow): TokenBreakdown => ({ inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens, cacheWriteInputTokens: row.cache_write_input_tokens, outputTokens: row.output_tokens, reasoningOutputTokens: row.reasoning_output_tokens, totalTokens: row.total_tokens });

export async function uploadPayload(user: string, item: SessionAggregate): Promise<{ p_session: SessionRow; p_turns: TurnRow[] }> {
  const turns = item.turns;
  if (!turns || turns.length !== item.tokenEventCount || turns.reduce((n,t) => n+t.tokens.totalTokens,0) !== item.tokens.totalTokens) throw new Error("回合資料不完整，稍後將重新同步");
  return {
    p_session: {
      // Stable log identity, independent of a device's local/SSH configuration IDs.
      source_key: await hashKey(user, `session-origin:${item.sessionId}`), session_key: await hashKey(user,item.sessionId),
      project_key: await hashKey(user,item.project), started_at:item.startedAt, ended_at:item.endedAt, model:item.model, origin:"Codex",
      ...toRow(item.tokens), estimate_microusd:item.estimateMicrousd, token_event_count:item.tokenEventCount,
      aggregation_version:5, observed_at:item.endedAt,
    },
    p_turns: turns.map((turn) => ({ turn_ordinal:turn.ordinal, occurred_at:turn.timestamp, model:turn.model, ...toRow(turn.tokens),
      service_tier:turn.serviceTier ?? "default", reasoning_effort:turn.reasoningEffort || "unknown", estimate_microusd:turn.estimateMicrousd })),
  };
}

export function downloadPayload(snapshot: CloudSnapshot): { sessionKey: string; session: SessionAggregate } {
  const { session: row } = snapshot;
  const turns: TurnUsage[] = snapshot.turns.map((t) => ({ ordinal:t.turn_ordinal,timestamp:t.occurred_at,model:t.model,serviceTier:t.service_tier,reasoningEffort:t.reasoning_effort,
    tokens:fromRow(t),estimateMicrousd:t.estimate_microusd,cacheRate:t.input_tokens ? t.cached_input_tokens/t.input_tokens*100 : 0 }));
  return { sessionKey:row.session_key, session:{
    sessionId:row.session_key,sourceId:"",sourceName:"其他裝置",sourceKind:"cloud",project:`專案 ${row.project_key.slice(0,8)}`,
    model:row.model,startedAt:row.started_at,endedAt:row.ended_at,origin:"Codex",tokens:fromRow(row),activityTokens:row.total_tokens,
    estimateMicrousd:row.estimate_microusd,unpricedTurnCount:turns.filter((t) => t.estimateMicrousd===null).length,
    unpricedTokens:turns.filter((t) => t.estimateMicrousd===null).reduce((n,t) => n+t.tokens.totalTokens,0),
    tokenEventCount:row.token_event_count,rateUsedPercent:null,rateWindowMinutes:null,turns,
  } };
}
