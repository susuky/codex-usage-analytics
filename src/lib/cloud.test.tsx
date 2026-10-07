import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { SessionAggregate, StoredSyncState } from "../types";
import { fingerprint, localKey, remoteFingerprint, uploadPayload, type CloudSnapshot } from "./cloudSync";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), listSyncSessions: vi.fn(), getSettings: vi.fn(), getSyncState: vi.fn(),
  saveSyncState: vi.fn(), mergeCloudSessions: vi.fn(), rpc: vi.fn(), from: vi.fn(), reload: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("./data", () => ({ useUsageData: () => ({ reload: mocks.reload }) }));
vi.mock("./api", () => ({
  ...mocks, getSessionDetail: vi.fn(), saveSettings: vi.fn(), secureGet: vi.fn(),
  secureRemove: vi.fn(), secureSet: vi.fn(),
}));

let CloudProvider: typeof import("./cloud").CloudProvider;
let useCloud: typeof import("./cloud").useCloud;
let snapshot: CloudSnapshot;
let state: StoredSyncState;
const user = "00000000-0000-0000-0000-000000000001";
const tokens = { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 };
const local: SessionAggregate = {
  sessionId: "test-session", sourceId: "local", sourceName: "Local", sourceKind: "local", project: "test",
  model: "gpt-5.6-sol", startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-01T00:01:00Z", origin: "Codex",
  tokens, activityTokens: 110, estimateMicrousd: 600, unpricedTurnCount: 0, unpricedTokens: 0,
  tokenEventCount: 1, rateUsedPercent: null, rateWindowMinutes: null,
  turns: [{ ordinal: 1, timestamp: "2026-09-01T00:01:00Z", model: "gpt-5.6-sol", serviceTier: "default",
    reasoningEffort: "high", tokens, estimateMicrousd: 600, cacheRate: 0 }],
};

beforeAll(async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "test-key");
  mocks.createClient.mockReturnValue({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: user, email: "test@example.com" } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
    rpc: mocks.rpc, from: mocks.from,
  });
  ({ CloudProvider, useCloud } = await import("./cloud"));
});

beforeEach(async () => {
  vi.clearAllMocks();
  const payload = await uploadPayload(user, local);
  snapshot = { session: payload.p_session, turns: payload.p_turns };
  state = { acknowledged: { [localKey(local)]: fingerprint(local) }, pending: {}, lastSyncedAt: null };
  mocks.getSettings.mockResolvedValue({ cloudEnabled: true });
  mocks.getSyncState.mockImplementation(async () => structuredClone(state));
  mocks.saveSyncState.mockImplementation(async (_user, next) => { state = structuredClone(next); });
  mocks.mergeCloudSessions.mockResolvedValue(undefined);
  mocks.rpc.mockImplementation((name) => ({ abortSignal: async () => ({
    data: name === "get_usage_session_v3" ? structuredClone(snapshot) : true, error: null,
  }) }));
  mocks.from.mockImplementation((table) => {
    const query = {
      select: () => query, order: () => query, range: () => query, eq: () => query,
      abortSignal: () => table === "usage_sessions"
        ? Promise.resolve({ data: [structuredClone(snapshot.session)], error: null })
        : { maybeSingle: async () => ({ data: { paused: false }, error: null }) },
    };
    return query;
  });
});
afterEach(cleanup);

function Probe() {
  const { status, syncNow } = useCloud();
  return <><button onClick={() => void syncNow().catch(() => undefined)}>sync</button>
    <output>{status.syncing ? "busy" : "idle"}</output><p>{status.lastError}</p></>;
}
const downloads = () => mocks.rpc.mock.calls.filter(([name]) => name === "get_usage_session_v3");
async function syncAgain() {
  await act(async () => { fireEvent.click(screen.getByText("sync")); });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("idle"));
}

it.each(["local", "cloud"] as const)("downloads equal-total corrections for %s sessions and skips unchanged content", async (kind) => {
  mocks.listSyncSessions.mockResolvedValue([{ ...local, sourceKind: kind }]);
  state.acknowledged[`remote:${snapshot.session.session_key}`] = remoteFingerprint(snapshot.session);
  snapshot.session.input_tokens -= 20;
  snapshot.session.output_tokens += 20;
  snapshot.session.cached_input_tokens = 10;
  snapshot.turns[0].input_tokens -= 20;
  snapshot.turns[0].output_tokens += 20;
  snapshot.turns[0].cached_input_tokens = 10;
  render(<CloudProvider><Probe /></CloudProvider>);
  await waitFor(() => expect(mocks.mergeCloudSessions).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("idle"));
  expect(mocks.mergeCloudSessions.mock.calls[0][1][0].session.tokens).toMatchObject({ inputTokens: 80, outputTokens: 30, cachedInputTokens: 10, totalTokens: 110 });
  await syncAgain();
  expect(downloads()).toHaveLength(1);
  snapshot.session.sync_revision = "turn-correction";
  snapshot.turns[0].reasoning_effort = "medium";
  await syncAgain();
  expect(downloads()).toHaveLength(2);
  expect(mocks.mergeCloudSessions.mock.calls[1][1][0].session.turns[0].reasoningEffort).toBe("medium");
});

it("retries a failed merge without acknowledging the unimported snapshot", async () => {
  mocks.listSyncSessions.mockResolvedValue([local]);
  mocks.mergeCloudSessions.mockRejectedValueOnce(new Error("merge failed"));
  render(<CloudProvider><Probe /></CloudProvider>);
  await waitFor(() => expect(screen.getByText("merge failed")).toBeVisible());
  expect(state.acknowledged[`remote:${snapshot.session.session_key}`]).toBeUndefined();
  await syncAgain();
  expect(downloads()).toHaveLength(2);
  expect(state.acknowledged[`remote:${snapshot.session.session_key}`]).toBe(remoteFingerprint(snapshot.session));
});

it("acknowledges the fetched revision when the cloud changes after listing", async () => {
  mocks.listSyncSessions.mockResolvedValue([local]);
  mocks.rpc.mockImplementation((name) => ({ abortSignal: async () => {
    if (name === "get_usage_session_v3") snapshot.session.sync_revision = "updated-after-listing";
    return { data: name === "get_usage_session_v3" ? structuredClone(snapshot) : true, error: null };
  } }));
  render(<CloudProvider><Probe /></CloudProvider>);
  await waitFor(() => expect(mocks.mergeCloudSessions).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("idle"));
  expect(state.acknowledged[`remote:${snapshot.session.session_key}`]).toBe(remoteFingerprint(snapshot.session));
  await syncAgain();
  expect(downloads()).toHaveLength(1);
});
