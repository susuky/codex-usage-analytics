import { ArrowLeft, BrainCircuit, ChevronLeft, ChevronRight, Coins, Database, Download, Gauge, Upload, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "../components/PageHeader";
import { SessionTable } from "../components/SessionTable";
import { getProjectDetail } from "../lib/api";
import { useUsageData } from "../lib/data";
import { dailyTokenTotal, fillDailyDateRange, fillDailyRange, formatDailyCost } from "../lib/daily";
import { cacheRate, formatDate, formatDateTime, formatInteger, formatSessionCost, formatTokens } from "../lib/format";
import { getProjectSummary, projectPath } from "../lib/projectView";
import { sessionTimeAxisFormat, sessionTimestampFormat } from "../lib/sessionDetail";
import { readSessionView } from "../lib/sessionView";
import type { DailyUsage, OverviewData, ProjectDetailData, ProjectTimelinePoint, UsageFilter } from "../types";
import styles from "../components/Dashboard.module.css";

function DailyTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: DailyUsage }> }) {
  if (!active || !payload?.length) return null;
  const day = payload[0].payload;
  return <div className="chart-tooltip"><strong>{day.date}</strong><span className="chart-tooltip-total">總 Tokens<b>{formatInteger(dailyTokenTotal(day))}</b></span><span className="chart-tooltip-cost">API 等值估算<b>{formatDailyCost(day)}</b></span>{day.unpricedTokens > 0 ? <small>{formatTokens(day.unpricedTokens)} Tokens 尚未定價</small> : null}</div>;
}

function CumulativeTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ProjectTimelinePoint }> }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return <div className="chart-tooltip">
    <strong>{sessionTimestampFormat.format(point.timestamp)}</strong>
    <span><i style={{ background: "#4291f5" }} />Input<b>{formatInteger(point.input)}</b></span>
    <span><i style={{ background: "#8658dd" }} />Output<b>{formatInteger(point.output)}</b></span>
    <span><i style={{ background: "#f1bd3d" }} />Reasoning<b>{formatInteger(point.reasoning)}</b></span>
    <span className="chart-tooltip-total">總 Tokens<b>{formatInteger(point.total)}</b></span>
  </div>;
}

export default function ProjectDetailPage() {
  const { project = "" } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const source = params.get("source") ?? "";
  const { data, filter, loading, error, reload } = useUsageData();
  const request = useMemo(() => ({ ...filter, project, sourceId: source || undefined }), [filter, project, source]);
  const [result, setResult] = useState<{ request: UsageFilter; base: OverviewData; detail: ProjectDetailData | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showDaily, setShowDaily] = useState(false);
  useEffect(() => {
    if (!data) return;
    let active = true;
    void getProjectDetail(request).then(detail => {
      if (active) setResult({ request, base: data, detail, error: null });
    }).catch(cause => {
      if (active) setResult({ request, base: data, detail: null, error: String(cause) });
    });
    return () => { active = false; };
  }, [request, data, attempt]);
  const current = result?.request === request && result.base === data ? result : null;
  const overview = current?.detail?.overview;
  const summary = useMemo(() => getProjectSummary(overview?.sessions ?? [], project), [overview, project]);
  const daily = useMemo(() => filter.startDate && filter.endDate ? fillDailyDateRange(overview?.daily ?? [], filter.startDate, filter.endDate) : fillDailyRange(overview?.daily ?? [], filter.days), [overview, filter]);
  const timeline = current?.detail?.timeline ?? [];
  const firstTimestamp = timeline[0]?.timestamp ?? 0, lastTimestamp = timeline.at(-1)?.timestamp ?? 0;
  const timelineDateFormat = useMemo(() => sessionTimeAxisFormat(firstTimestamp, lastTimestamp), [firstTimestamp, lastTimestamp]);
  const view = readSessionView(params);
  const pageCount = Math.max(1, Math.ceil((overview?.sessions.length ?? 0) / view.pageSize));
  const page = Math.min(view.page, pageCount);
  const update = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  const returnTo = `${projectPath(project)}${params.size ? `?${params}` : ""}`;
  const requestedReturn = location.state?.returnTo;
  const listReturn = typeof requestedReturn === "string" && (requestedReturn === "/projects" || requestedReturn.startsWith("/projects?")) ? requestedReturn : `/projects${source ? `?source=${encodeURIComponent(source)}` : ""}`;
  const pending = loading && !data || Boolean(data && !current);
  const queryError = current?.error || (error && !data);
  const metrics = summary && overview ? [
    { Icon: Database, label: "所選期間 Tokens", value: formatInteger(overview.totals.totalTokens) },
    { Icon: Download, label: "Input", value: formatInteger(overview.totals.inputTokens) },
    { Icon: Gauge, label: "Cached input", value: formatInteger(overview.totals.cachedInputTokens), hint: `快取率 ${cacheRate(overview.totals).toFixed(1)}%` },
    { Icon: Gauge, label: "Cache writes", value: formatInteger(overview.totals.cacheWriteInputTokens) },
    { Icon: Upload, label: "Output", value: formatInteger(overview.totals.outputTokens) },
    { Icon: BrainCircuit, label: "Reasoning", value: formatInteger(overview.totals.reasoningOutputTokens) },
    { Icon: Zap, label: "快速模式請求", value: formatInteger(overview.activity.fastRequests) },
    { Icon: Coins, label: "API 等值估算", value: formatSessionCost(summary.estimateMicrousd, summary.tokens.totalTokens, summary.unpricedTurnCount), hint: summary.unpricedTokens > 0 ? `${formatTokens(summary.unpricedTokens)} Tokens 尚未定價` : undefined },
  ] : [];
  return <div className={styles.page}>
    <PageHeader title="專案明細" subtitle="依所選日期彙整這個專案的所有 Sessions" />
    <div className={styles.content}>
      <Link className={styles.textLink} to={listReturn}><ArrowLeft size={16} aria-hidden="true" />返回專案</Link>
      <div className={styles.projectHeading}><h2>{project || "未記錄專案"}</h2><label>來源<select value={source} onChange={event => update({ source: event.target.value })}><option value="">所有來源</option>{source && !data?.sources.some(item => item.id === source) ? <option value={source}>所選來源（目前無資料）</option> : null}{data?.sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      {pending ? <p className="page-loading" role="status">正在載入專案明細…</p> : queryError ? <div className={styles.empty}><h2>暫時無法顯示專案明細</h2><p>請重新載入。</p><button className="secondary-button" onClick={() => data ? setAttempt(value => value + 1) : void reload()}>重新載入</button></div> : !overview || !summary ? <div className={styles.empty}><h2>此區間尚無專案用量</h2><p>請調整日期區間或來源，查看這個專案的其他紀錄。</p><Link className={styles.textLink} to="/projects">查看所有專案</Link></div> : <>
        <section className={`${styles.projectMetadata} metadata-strip`} aria-label="專案摘要"><div><span>Sessions</span><strong>{formatInteger(summary.sessionCount)}</strong></div><div><span>資料來源</span><strong>{summary.sources.map(item => item.name).join("、")}</strong></div><div><span>區間首次活動</span><strong>{summary.startedAt ? formatDateTime(summary.startedAt) : "未記錄"}</strong></div><div><span>最後活動</span><strong>{summary.endedAt ? formatDateTime(summary.endedAt) : "未記錄"}</strong></div></section>
        <section className="detail-metrics" aria-label="專案用量摘要">{metrics.map(({ Icon, label, value, hint }) => <div key={label}><Icon size={20} aria-hidden="true" /><span>{label}</span><strong>{value}</strong>{hint ? <small>{hint}</small> : null}</div>)}</section>
        <section className={`${styles.tablePanel} detail-chart-panel`} aria-label="專案 Token 累積曲線">
          <h2 className={styles.tableTitle}>Token 累積曲線</h2>
          <p className="footnote">依本機時區顯示；每次用量記錄後累加，沒有活動時維持水平。</p>
          {timeline.length ? <div className="detail-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={timeline} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
            <defs><linearGradient id="projectMintArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#65dfbf" stopOpacity=".35" /><stop offset="1" stopColor="#65dfbf" stopOpacity="0" /></linearGradient></defs>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 3" />
            <XAxis dataKey="timestamp" type="number" scale="time" domain={firstTimestamp === lastTimestamp ? [firstTimestamp - 30_000, lastTimestamp + 30_000] : ["dataMin", "dataMax"]} tickFormatter={value => timelineDateFormat.format(Number(value))} tickCount={6} minTickGap={28} tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} />
            <YAxis tickFormatter={formatTokens} tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} axisLine={false} />
            <Tooltip content={<CumulativeTooltip />} />
            <Area type="stepAfter" dataKey="total" name="總 Tokens" stroke="#65dfbf" fill="url(#projectMintArea)" strokeWidth={2} dot={timeline.length === 1} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="input" name="Input" stroke="#4291f5" fill="none" strokeWidth={1.5} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="output" name="Output" stroke="#8658dd" fill="none" strokeWidth={1.5} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="reasoning" name="Reasoning" stroke="#f1bd3d" fill="none" strokeWidth={1.4} isAnimationActive={false} />
          </AreaChart></ResponsiveContainer></div> : <p className="footnote">{current?.detail?.timeline === null ? "請在桌面版查看逐筆用量曲線。" : "沒有可繪製的時間紀錄。"}</p>}
        </section>
        <section className={styles.tablePanel} aria-label="專案每日用量"><h2 className={styles.tableTitle}>每日用量</h2><div className="detail-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={daily} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} strokeDasharray="2 3" /><XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} minTickGap={28} /><YAxis tickFormatter={formatTokens} tick={{ fill: "var(--muted)", fontSize: 12 }} axisLine={false} tickLine={false} /><Tooltip content={<DailyTooltip />} /><Bar dataKey={dailyTokenTotal} name="Tokens" fill="var(--mint)" maxBarSize={48} isAnimationActive={false} />
        </BarChart></ResponsiveContainer></div><div className={styles.projectDailyAction}><button className={styles.disclosureButton} aria-expanded={showDaily} aria-controls="project-daily-table" onClick={() => setShowDaily(value => !value)}>{showDaily ? "收合每日明細" : "查看每日明細"}</button></div>
          {showDaily ? <div id="project-daily-table" className={`${styles.tableWrap} ${styles.dailyTableScroll}`} tabIndex={0} role="region" aria-label="專案每日明細"><table className={styles.table}><thead><tr><th scope="col">日期</th><th scope="col">Sessions</th><th scope="col">Tokens</th><th scope="col">API 等值估算</th></tr></thead><tbody>{daily.map(day => <tr key={day.date}><td>{day.date}</td><td>{formatInteger(day.sessions)}</td><td>{formatInteger(dailyTokenTotal(day))}</td><td>{formatDailyCost(day)}</td></tr>)}</tbody></table></div> : null}
        </section>
        <section className={styles.tablePanel}><h2 className={styles.tableTitle}>模型分布</h2><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="專案模型分布"><table className={styles.table}><thead><tr>{["模型", "Sessions", "Tokens", "Input", "Cached input", "Output", "API 等值估算"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{overview.models.map(model => <tr key={model.model}><td>{model.model}</td><td>{formatInteger(model.sessions)}</td><td>{formatInteger(model.tokens.totalTokens)}</td><td>{formatInteger(model.tokens.inputTokens)}</td><td>{formatInteger(model.tokens.cachedInputTokens)}</td><td>{formatInteger(model.tokens.outputTokens)}</td><td><div className={styles.costCell}><span>{formatSessionCost(model.estimateMicrousd, model.tokens.totalTokens, model.unpricedRequests)}</span>{model.unpricedTokens > 0 ? <small>{formatTokens(model.unpricedTokens)} 未定價</small> : null}</div></td></tr>)}</tbody></table></div></section>
        <section className={styles.tablePanel}><div className={styles.resultsHeading}><h2 className={styles.tableTitle}>專案 Sessions</h2><p>{formatInteger(summary.sessionCount)} 段對話 · 點選查看整段明細</p></div><SessionTable sessions={overview.sessions} sort={view.sort} onSortChange={sort => update({ sort: sort.key, direction: sort.asc ? "asc" : "desc" })} page={page} pageSize={view.pageSize} returnTo={returnTo} />{pageCount > 1 ? <nav className={styles.pagination} aria-label="專案 Session 分頁"><span>第 {page} / {pageCount} 頁</span><div><button aria-label="上一頁" disabled={page === 1} onClick={() => update({ page: String(page - 1) })}><ChevronLeft size={16} /></button><button aria-label="下一頁" disabled={page === pageCount} onClick={() => update({ page: String(page + 1) })}><ChevronRight size={16} /></button></div></nav> : null}</section>
      </>}
    </div>
  </div>;
}
