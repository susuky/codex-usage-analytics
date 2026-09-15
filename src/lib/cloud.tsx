import { createClient, type Session, type SupportedStorage, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getOverview, getSessionDetail, getSettings, getSyncState, saveSyncState, mergeCloudSessions, saveSettings, secureGet, secureRemove, secureSet } from "./api";
import { downloadPayload, fingerprint, hashKey, localKey, queueSnapshots, uploadPayload, type CloudSnapshot, type SessionRow } from "./cloudSync";
import { useUsageData } from "./data";
import type { OverviewData, SyncStatus } from "../types";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const configured = Boolean(url && key);
const storage: SupportedStorage = { getItem: secureGet, setItem: secureSet, removeItem: secureRemove };
const client: SupabaseClient | null = configured ? createClient(url!, key!, { global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000) }) }, auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage } }) : null;

interface CloudContextValue {
  status: SyncStatus;
  sendMagicLink: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: (data?: OverviewData, automatic?: boolean) => Promise<void>;
  deleteCloudData: () => Promise<void>;
}

const initialStatus: SyncStatus = { enabled: false, syncing: false, configured, signedIn: false, email: null, pendingRows: 0, lastSyncedAt: null, lastError: null };
const CloudContext = createContext<CloudContextValue | null>(null);

async function handleAuthUrl(authUrl: string) {
  if (!client) return;
  const parsed = new URL(authUrl);
  const code = parsed.searchParams.get("code");
  if (code) await client.auth.exchangeCodeForSession(code);
}

export function CloudProvider({ children }: { children: ReactNode }) {
  const { reload } = useUsageData();
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const inFlight = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<SyncStatus>(initialStatus);

  useEffect(() => {
    if (!client) return;
    void client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => setSession(next));
    const isTauri = "__TAURI_INTERNALS__" in window;
    let unlisten: (() => void) | undefined;
    if (isTauri) {
      void getCurrent().then((urls) => urls?.forEach((item) => void handleAuthUrl(item)));
      void onOpenUrl((urls) => urls.forEach((item) => void handleAuthUrl(item))).then((fn) => { unlisten = fn; });
    }
    return () => { listener.subscription.unsubscribe(); unlisten?.(); };
  }, []);

  useEffect(() => setStatus((current) => ({ ...current, signedIn: Boolean(session), email: session?.user.email ?? null })), [session]);

  const sendMagicLink = useCallback(async (email: string) => {
    if (!client) throw new Error("尚未設定 Supabase 環境變數");
    const callback = import.meta.env.VITE_AUTH_CALLBACK_URL;
    if (!callback) throw new Error("尚未設定 VITE_AUTH_CALLBACK_URL");
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: callback, shouldCreateUser: true } });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => { if (client) { const { error } = await client.auth.signOut(); if (error) throw error; } }, []);

  const syncNow = useCallback((_overview?: OverviewData, automatic = false): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!client || !session) return Promise.reject(new Error("請先登入 Supabase"));
    const account = session.user.id;
    const run = async () => {
      const settings = await getSettings();
      if (!settings.cloudEnabled) throw new Error("雲端同步已停用");
      const abort = new AbortController();
      controller.current = abort;
      const signal = abort.signal;
      setStatus((current) => ({ ...current, syncing:true, lastError:null }));
      try {
        const state = queueSnapshots(await getSyncState(account), (await getOverview({ days:36500 })).sessions);
        await saveSyncState(account,state);
        setStatus((current) => ({ ...current,pendingRows:Object.keys(state.pending).length,lastSyncedAt:state.lastSyncedAt }));
        if (!automatic) {
          const result = await client!.rpc("resume_cloud_usage_v3").abortSignal(signal);
          if (result.error) throw result.error;
        } else {
          const result = await client!.from("usage_sync_control").select("paused").eq("user_id",account).abortSignal(signal).maybeSingle();
          if (result.error) throw result.error;
          if (result.data?.paused) throw new Error("雲端統計已清除；按立即同步可重新啟用");
        }
        const overview = await getOverview({ days:36500 });
        for (const item of overview.sessions.filter((s) => s.sourceKind !== "cloud" && state.pending[localKey(s)])) {
          signal.throwIfAborted();
          const detail = await getSessionDetail(item.sourceId,item.sessionId);
          const result = await client!.rpc("sync_usage_session_v3", await uploadPayload(account,detail)).abortSignal(signal);
          if (result.error) throw result.error;
          // False means the server already holds a newer complete copy. Pull it below;
          // do not repeatedly send this older version on every retry.
          state.acknowledged[localKey(item)] = fingerprint(detail);
          delete state.pending[localKey(item)];
          await saveSyncState(account,state);
          setStatus((current) => ({ ...current,pendingRows:Object.keys(state.pending).length }));
        }

        const rows = new Map<string,SessionRow>();
        for (let offset=0;;offset+=500) {
          signal.throwIfAborted();
          const result = await client!.from("usage_sessions").select("*").order("session_key").order("source_key").range(offset,offset+499).abortSignal(signal);
          if (result.error) throw result.error;
          for (const row of (result.data ?? []) as SessionRow[]) {
            const previous = rows.get(row.session_key);
            if (!previous || row.token_event_count>previous.token_event_count || (row.token_event_count===previous.token_event_count && row.observed_at>previous.observed_at)) rows.set(row.session_key,row);
          }
          if ((result.data?.length ?? 0)<500) break;
        }
        const known = new Map(await Promise.all(overview.sessions.filter((s) => s.sourceKind!=="cloud").map(async (s) => [await hashKey(account,s.sessionId),s] as const)));
        for (const row of rows.values()) {
          signal.throwIfAborted();
          const local = known.get(row.session_key);
          if (local && local.tokenEventCount >= row.token_event_count && local.tokens.totalTokens===row.total_tokens) continue;
          const remoteVersion = JSON.stringify([row.token_event_count,row.total_tokens,row.observed_at,row.aggregation_version]);
          const ackKey = `remote:${row.session_key}`;
          if (!local && state.acknowledged[ackKey]===remoteVersion) continue;
          const result = await client!.rpc("get_usage_session_v3",{p_source_key:row.source_key,p_session_key:row.session_key}).abortSignal(signal);
          if (result.error) throw result.error;
          if (!result.data) continue;
          await mergeCloudSessions(account,[downloadPayload(result.data as CloudSnapshot)]);
          state.acknowledged[ackKey] = remoteVersion;
          await saveSyncState(account,state);
        }
        state.lastSyncedAt = new Date().toISOString();
        await saveSyncState(account,state);
        setStatus((current) => ({ ...current,pendingRows:Object.keys(state.pending).length,lastSyncedAt:state.lastSyncedAt,lastError:null }));
        await reloadRef.current();
      } catch (cause) {
        if (!signal.aborted) setStatus((current) => ({ ...current,lastError:cause instanceof Error ? cause.message : String((cause as { message?:string })?.message ?? cause) }));
        throw cause;
      } finally {
        if (controller.current===abort) controller.current=null;
        setStatus((current) => ({ ...current,syncing:false }));
      }
    };
    const operation = run();
    inFlight.current = operation;
    void operation.then(() => { if (inFlight.current===operation) inFlight.current=null; }, () => { if (inFlight.current===operation) inFlight.current=null; });
    return operation;
  }, [session]);

  useEffect(() => {
    let live = true;
    const loadSettings = () => { void getSettings().then((settings) => {
      if (!live) return;
      setEnabled(settings.cloudEnabled);
      setStatus((current) => ({...current,enabled:settings.cloudEnabled}));
      if (!settings.cloudEnabled) controller.current?.abort();
    }).catch(() => undefined); };
    loadSettings();
    window.addEventListener("usage-settings-changed",loadSettings);
    return () => { live=false; window.removeEventListener("usage-settings-changed",loadSettings); };
  }, []);

  useEffect(() => {
    if (!session || !enabled || !client) return;
    const retry = () => { void syncNow(undefined,true).catch(() => undefined); };
    retry();
    const timer = window.setInterval(retry,60_000);
    window.addEventListener("online",retry);
    window.addEventListener("usage-scanned",retry);
    return () => {
      controller.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("online",retry);
      window.removeEventListener("usage-scanned",retry);
    };
  }, [session,enabled,syncNow]);

  const deleteCloudData = useCallback(async () => {
    if (!client || !session) throw new Error("請先登入 Supabase");
    controller.current?.abort();
    await inFlight.current?.catch(() => undefined);
    const { error } = await client.rpc("delete_cloud_usage_v3");
    if (error) throw error;
    const settings = await getSettings();
    await saveSettings({ ...settings,cloudEnabled:false });
    await saveSyncState(session.user.id,{acknowledged:{},pending:{},lastSyncedAt:null});
    setStatus((current) => ({ ...current,lastSyncedAt:null,pendingRows:0,enabled:false }));
  }, [session]);

  const value = useMemo(() => ({ status, sendMagicLink, signOut, syncNow, deleteCloudData }), [status, sendMagicLink, signOut, syncNow, deleteCloudData]);
  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud() {
  const value = useContext(CloudContext);
  if (!value) throw new Error("useCloud must be used inside CloudProvider");
  return value;
}
