import { useEffect, useRef, useState } from "react";
import { AlertCircle, CalendarDays, CheckCircle2, ChevronDown, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useUsageData } from "../lib/data";
import { localDateKey } from "../lib/daily";
import styles from "./Dashboard.module.css";

const datePresets = [
  { days: 1, label: "今天" },
  { days: 7, label: "最近 7 天" },
  { days: 30, label: "最近 30 天" },
  { days: 90, label: "最近 90 天" },
  { days: 365, label: "最近 1 年" },
  { days: 36500, label: "全部期間" }
];

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - Math.max(0, days));
  return localDateKey(date);
}

function inclusiveDayCount(startDate: string, endDate: string) {
  const start = Date.UTC(Number(startDate.slice(0, 4)), Number(startDate.slice(5, 7)) - 1, Number(startDate.slice(8, 10)));
  const end = Date.UTC(Number(endDate.slice(0, 4)), Number(endDate.slice(5, 7)) - 1, Number(endDate.slice(8, 10)));
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function customRangeLabel(startDate?: string, endDate?: string) {
  if (!startDate || !endDate) return "自訂區間";
  return `${startDate.replaceAll("-", "/")} – ${endDate.slice(5).replace("-", "/")}`;
}

export function PageHeader({ title, subtitle, showDateFilter = true }: { title: string; subtitle?: string; showDateFilter?: boolean }) {
  const { data, filter, setFilter, loading, scanning, refresh, error } = useUsageData();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const firstDateRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | HTMLSelectElement | null>(null);
  const closePicker = () => { setPickerOpen(false); returnFocusRef.current?.focus(); };
  const synced = !error && Boolean(data?.sources.some((source) => source.enabled)) && data?.sources.filter((source) => source.enabled).every((source) => !source.stale && !source.lastError && source.lastScannedAt);
  const statusText = scanning ? "掃描中…" : loading && !data ? "載入中…" : error ? "需要注意" : !data?.sources.some(source => source.enabled) ? "未啟用來源" : synced ? "資料已更新" : "來源待更新";
  const today = localDateKey(new Date());
  const customRange = Boolean(filter.startDate && filter.endDate);
  const invalidRange = Boolean(draftStart && draftEnd && draftStart > draftEnd);

  const openPicker = (trigger: HTMLButtonElement | HTMLSelectElement) => {
    returnFocusRef.current = trigger;
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    const fallbackStart = filter.days >= 36500
      ? data?.daily.at(0)?.date ?? dateDaysAgo(364)
      : dateDaysAgo(filter.days - 1);
    setDraftStart(filter.startDate ?? fallbackStart);
    setDraftEnd(filter.endDate ?? today);
    setPickerOpen(true);
  };

  useEffect(() => {
    if (!pickerOpen) return;
    firstDateRef.current?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPickerOpen(false); returnFocusRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pickerOpen]);

  const applyCustomRange = () => {
    if (!draftStart || !draftEnd || invalidRange) return;
    setFilter({
      ...filter,
      days: inclusiveDayCount(draftStart, draftEnd),
      startDate: draftStart,
      endDate: draftEnd
    });
    closePicker();
  };

  return (
    <header className={styles.pageHeader}>
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
        {error ? <div role="alert">
          <p className="state-error">更新未完成。請重試，或查看資料來源的連線狀態。</p>
          <details className={styles.errorDetails}><summary>查看錯誤詳情</summary><p>{error}</p></details>
        </div> : null}
      </div>
      <div className={styles.headerActions}>
        {showDateFilter ? <div className={styles.dateControl} ref={pickerRef}>
          <button
            type="button"
            className={styles.calendarButton}
            aria-label="選擇日期區間"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            title="選擇日期區間"
            onClick={(event) => openPicker(event.currentTarget)}
          >
            <CalendarDays size={17} />
          </button>
          <select
            aria-label="日期範圍"
            value={customRange ? "custom" : String(filter.days)}
            onChange={(event) => {
              if (event.target.value === "custom-picker") {
                openPicker(event.currentTarget);
                return;
              }
              setFilter({ ...filter, days: Number(event.target.value), startDate: undefined, endDate: undefined });
              setPickerOpen(false);
            }}
          >
            {datePresets.map((preset) => <option key={preset.days} value={preset.days}>{preset.label}</option>)}
            {customRange ? <option value="custom" hidden>{customRangeLabel(filter.startDate, filter.endDate)}</option> : null}
            <option value="custom-picker">自訂區間</option>
          </select>
          <ChevronDown className={styles.dateChevron} size={14} />

          {pickerOpen ? (
            <form
              className={styles.datePopover}
              role="dialog"
              aria-label="選擇日期區間"
              onSubmit={(event) => { event.preventDefault(); applyCustomRange(); }}
            >
              <div className={styles.datePopoverHeader}>
                <div><strong>自訂日期區間</strong><span>包含開始日與結束日</span></div>
                <button type="button" aria-label="關閉日期選擇器" onClick={closePicker}><X size={16} /></button>
              </div>
              <div className={styles.dateFields}>
                <label>開始日期<input ref={firstDateRef} type="date" value={draftStart} max={draftEnd || today} onChange={(event) => setDraftStart(event.target.value)} /></label>
                <label>結束日期<input type="date" value={draftEnd} min={draftStart} max={today} onChange={(event) => setDraftEnd(event.target.value)} /></label>
              </div>
              {invalidRange ? <p className={styles.dateError} role="alert">開始日期不可晚於結束日期</p> : null}
              <div className={styles.datePopoverActions}>
                <button type="button" onClick={closePicker}>取消</button>
                <button type="submit" disabled={!draftStart || !draftEnd || invalidRange}>套用</button>
              </div>
            </form>
          ) : null}
        </div> : null}
        <span role="status" aria-atomic="true">
          <Link to="/sync" aria-label={`查看來源狀態：${statusText}`} className={`${styles.syncState} ${scanning ? styles.scanning : synced ? styles.ok : styles.warn}`}>
            {scanning ? <RefreshCw className={styles.spin} size={16} aria-hidden="true" /> : synced ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
            {statusText}
          </Link>
        </span>
        <button className={styles.iconButton} aria-label={scanning ? "正在掃描" : "重新掃描"} title={scanning ? "正在掃描所有啟用來源" : "重新掃描本機與遠端來源"} disabled={scanning} onClick={() => void refresh(true)}><RefreshCw size={18} /></button>
      </div>
    </header>
  );
}
