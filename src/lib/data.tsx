import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getOverview, getSettings, scanSources } from "./api";
import type { OverviewData, UsageFilter } from "../types";

interface DataContextValue {
  data: OverviewData | null;
  filter: UsageFilter;
  setFilter: (next: UsageFilter) => void;
  loading: boolean;
  scanning: boolean;
  error: string | null;
  refresh: (forceFull?: boolean) => Promise<void>;
  reload: () => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [filter, updateFilter] = useState<UsageFilter>({ days: 365 });
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pollMinutes, setPollMinutes] = useState(15);
  const requestVersion = useRef(0);
  const setFilter = useCallback((next: UsageFilter) => {
    requestVersion.current += 1;
    setData(null);
    setLoading(true);
    updateFilter(next);
  }, []);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const scanInFlightRef = useRef<Promise<void> | null>(null);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await getOverview(filter);
      if (version !== requestVersion.current) return;
      setError(null);
      setData(next);
    } catch (cause) {
      if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => { loadRef.current = load; }, [load]);

  const refresh = useCallback((forceFull = false) => {
    if (scanInFlightRef.current) return scanInFlightRef.current;
    const operation = (async () => {
      setScanning(true);
      setScanError(null);
      try {
        await scanSources(forceFull);
        await loadRef.current();
        window.dispatchEvent(new Event("usage-scanned"));
      } catch (cause) {
        setScanError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setScanning(false);
      }
    })();
    scanInFlightRef.current = operation;
    void operation.finally(() => {
      if (scanInFlightRef.current === operation) scanInFlightRef.current = null;
    });
    return operation;
  }, []);

  useEffect(() => { void load(); return () => { requestVersion.current += 1; }; }, [load]);
  useEffect(() => {
    const settingsChanged = () => {
      void getSettings().then((settings) => setPollMinutes(Math.min(1440, Math.max(1, settings.pollMinutes)))).catch(() => undefined);
      void loadRef.current();
    };
    void getSettings().then((settings) => setPollMinutes(Math.min(1440, Math.max(1, settings.pollMinutes)))).catch(() => undefined);
    window.addEventListener("usage-settings-changed", settingsChanged);
    return () => window.removeEventListener("usage-settings-changed", settingsChanged);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, pollMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, pollMinutes]);
  useEffect(() => {
    if (!scanning) return;
    const timer = window.setInterval(() => { void loadRef.current(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [scanning]);

  const value = useMemo(() => ({ data, filter, setFilter, loading, scanning, error: scanError ?? error, refresh, reload: load }), [data, filter, setFilter, loading, scanning, error, scanError, refresh, load]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useUsageData() {
  const value = useContext(DataContext);
  if (!value) throw new Error("useUsageData must be used inside DataProvider");
  return value;
}
