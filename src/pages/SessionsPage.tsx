import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { SessionTable } from "../components/SessionTable";
import { useUsageData } from "../lib/data";
import { listSessions } from "../lib/api";
import { formatCost, formatInteger, formatTokens } from "../lib/format";
import { filterSessions, readSessionView } from "../lib/sessionView";
import type { SessionAggregate, UsageFilter } from "../types";
import styles from "../components/Dashboard.module.css";

export function SessionsPage() {
  const { data, filter, loading, error, reload } = useUsageData();
  const [params, setParams] = useSearchParams();
  const view = readSessionView(params);
  const modelRequest = useMemo(() => ({ ...filter, model: view.model }), [filter, view.model]);
  const [modelResult, setModelResult] = useState<{ request: UsageFilter; rows: SessionAggregate[]; error: string | null } | null>(null);
  const [modelAttempt, setModelAttempt] = useState(0);
  useEffect(() => {
    if (!modelRequest.model || !data) return;
    let active = true;
    setModelResult(null);
    void listSessions(modelRequest).then(rows => {
      if (active) setModelResult({ request: modelRequest, rows, error: null });
    }).catch(cause => {
      if (active) setModelResult({ request: modelRequest, rows: [], error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { active = false; };
  }, [modelRequest, data, modelAttempt]);
  const selectedModel = modelResult?.request === modelRequest ? modelResult : null;
  const sessions = view.model ? selectedModel?.rows : data?.sessions;
  const rows = useMemo(() => filterSessions(sessions ?? [], { ...view, model: "" }), [sessions, view.query, view.source, view.pricing]);
  const models = useMemo(() => (data?.models ?? []).map(item => item.model).sort(), [data]);
  const pending = loading && !data || Boolean(data && view.model && !selectedModel);
  const queryError = view.model ? selectedModel?.error : null;
  const totals = useMemo(() => rows.reduce((sum, session) => ({
    tokens: sum.tokens + session.tokens.totalTokens,
    estimate: sum.estimate + (session.estimateMicrousd ?? 0),
    priced: sum.priced + Number(session.estimateMicrousd !== null && session.tokens.totalTokens > 0),
    unpriced: sum.unpriced + session.unpricedTokens,
  }), { tokens: 0, estimate: 0, priced: 0, unpriced: 0 }), [rows]);
  const pageCount = Math.max(1, Math.ceil(rows.length / view.pageSize));
  const page = Math.min(view.page, pageCount);
  const hasFilters = Boolean(view.query.trim() || view.source || view.model || view.pricing !== "all");
  const update = (values: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (resetPage) next.delete("page");
    setParams(next, { replace: true });
  };
  const clear = () => update({ q: "", source: "", model: "", pricing: "" });
  const returnParams = new URLSearchParams(params);
  if (page > 1) returnParams.set("page", String(page)); else returnParams.delete("page");
  const returnTo = `/sessions${returnParams.size ? `?${returnParams}` : ""}`;

  return <div className={styles.page}>
    <PageHeader title="Sessions" subtitle="查詢各段對話的用量、模型與估算成本" />
    <div className={styles.content}>
      <section className={styles.sessionFilters} aria-label="篩選 Sessions">
        <div className={styles.filterHeading}>
          <span><SlidersHorizontal size={16} aria-hidden="true" />篩選紀錄</span>
          {hasFilters ? <button className={styles.clearButton} onClick={clear}><X size={14} aria-hidden="true" />清除篩選</button> : null}
        </div>
        <div className={styles.sessionFilterGrid}>
          <label>
            <span>搜尋</span>
            <span className="search-control"><Search size={16} aria-hidden="true" /><input aria-label="搜尋 Sessions" type="search" name="q" autoComplete="off" spellCheck={false} placeholder="專案、模型或 Session ID…" value={view.query} onChange={event => update({ q: event.target.value })} /></span>
          </label>
          <label>
            <span>來源</span>
            <select name="source" value={view.source} onChange={event => update({ source: event.target.value })}>
              <option value="">所有來源</option>
              {view.source && !data?.sources.some(source => source.id === view.source) ? <option value={view.source}>所選來源（目前無資料）</option> : null}
              {data?.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
          </label>
          <label>
            <span>模型</span>
            <select name="model" value={view.model} onChange={event => update({ model: event.target.value })}>
              <option value="">所有模型</option>
              {view.model && !models.includes(view.model) ? <option value={view.model}>{view.model}</option> : null}
              {models.map(model => <option key={model}>{model}</option>)}
            </select>
          </label>
          <label>
            <span>估算狀態</span>
            <select name="pricing" value={view.pricing} onChange={event => update({ pricing: event.target.value })}>
              <option value="all">全部狀態</option>
              <option value="complete">完整估算</option>
              <option value="partial">部分估算</option>
              <option value="unpriced">無法估算</option>
            </select>
          </label>
        </div>
      </section>
      {pending ? <p className="page-loading" role="status">正在載入使用紀錄…</p> : error && !data || queryError ? (
        <div className={styles.empty}>
          <h2>暫時無法顯示紀錄</h2><p>請重新載入；既有統計不會因此刪除。</p>
          <button className="secondary-button" onClick={() => queryError ? setModelAttempt(attempt => attempt + 1) : void reload()}>重新載入</button>
          {queryError ? <details className={styles.errorDetails}><summary>查看錯誤詳情</summary><p>{queryError}</p></details> : null}
        </div>
      ) : <>
        <div className={styles.sessionSummary} role="region" aria-label="篩選結果摘要">
          <span>所選期間 Tokens<strong>{formatTokens(totals.tokens)}</strong></span>
          <span>API 等值估算<strong>{totals.tokens ? formatCost(totals.priced ? totals.estimate : null) : "無使用量"}</strong>
            {totals.unpriced > 0 ? <small>另有 {formatTokens(totals.unpriced)} tokens 未定價</small> : null}
          </span>
        </div>
        <section className={styles.tablePanel}>
          <div className={styles.resultsHeading}>
            <h2 className={styles.tableTitle}>{formatInteger(rows.length)} 個 Sessions</h2>
            <p role="status" aria-atomic="true">{rows.length ? `顯示 ${(page - 1) * view.pageSize + 1}–${Math.min(page * view.pageSize, rows.length)} 筆，共 ${formatInteger(rows.length)} 筆` : "沒有符合條件的紀錄"}</p>
          </div>
          {rows.length ? <>
            <SessionTable sessions={rows} sort={view.sort} onSortChange={sort => update({ sort: sort.key, direction: sort.asc ? "asc" : "desc" })} page={page} pageSize={view.pageSize} returnTo={returnTo} />
            <nav className={styles.pagination} aria-label="Session 分頁">
              <label>每頁筆數<select value={view.pageSize} onChange={event => update({ size: event.target.value })}>{[25, 50, 100].map(size => <option key={size}>{size}</option>)}</select></label>
              <div>
                <button aria-label="上一頁" disabled={page === 1} onClick={() => update({ page: String(page - 1) }, false)}><ChevronLeft size={16} aria-hidden="true" /></button>
                <span>第 {page} / {pageCount} 頁</span>
                <button aria-label="下一頁" disabled={page >= pageCount} onClick={() => update({ page: String(page + 1) }, false)}><ChevronRight size={16} aria-hidden="true" /></button>
              </div>
            </nav>
          </> : (
            <div className={styles.empty}>
              <Search size={28} aria-hidden="true" /><h3>沒有符合條件的 Session</h3>
              <p>{hasFilters ? "試試其他關鍵字，或清除篩選以查看此日期區間的紀錄。" : "請調整右上角的日期區間，或確認資料來源已完成掃描。"}</p>
              {hasFilters ? <button className="secondary-button" onClick={clear}>顯示此區間全部紀錄</button> : <Link className={styles.textLink} to="/sync">查看資料來源</Link>}
            </div>
          )}
        </section>
        <p className="footnote">列表依所選日期與模型計算，與總覽使用相同範圍。點進明細可查看整段對話。估算只包含已定價用量，不代表 Codex 訂閱帳單。</p>
      </>}
    </div>
  </div>;
}
