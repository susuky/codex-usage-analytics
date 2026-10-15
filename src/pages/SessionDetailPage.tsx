import { ArrowLeft, BrainCircuit, Coins, Database, Download, Gauge, Upload, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getSessionDetail } from "../lib/api";
import { cacheRate, formatCost, formatDateTime, formatInteger, formatSessionCost, formatTokens, shortId } from "../lib/format";
import { buildSessionTimeline, sessionTimeAxisFormat, sessionTimestampFormat } from "../lib/sessionDetail";
import type { SessionAggregate } from "../types";
import styles from "../components/Dashboard.module.css";

function SessionTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ReturnType<typeof buildSessionTimeline>[number] }> }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return <div className="chart-tooltip">
    <strong>{sessionTimestampFormat.format(point.timestamp)}</strong>
    <small>第 {point.ordinal} 回合 · {point.model || "未知模型"}</small>
    <span><i style={{ background: "#4291f5" }} />Input<b>{formatInteger(point.input)}</b></span>
    <span><i style={{ background: "#8658dd" }} />Output<b>{formatInteger(point.output)}</b></span>
    <span><i style={{ background: "#f1bd3d" }} />Reasoning<b>{formatInteger(point.reasoning)}</b></span>
    <span className="chart-tooltip-total">總 Tokens<b>{formatInteger(point.total)}</b></span>
  </div>;
}

export function SessionDetailPage() {
  const { sourceId = "", sessionId = "" } = useParams();
  const location = useLocation();
  const requestedReturn = location.state?.returnTo;
  const returnTo = typeof requestedReturn === "string" && (requestedReturn === "/sessions" || requestedReturn.startsWith("/sessions?")) ? requestedReturn : "/sessions";
  const [session, setSession] = useState<SessionAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSession(null); setError(null);
    void getSessionDetail(sourceId, sessionId).then((value) => { if (active) setSession(value); }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [sourceId, sessionId]);
  const chart = useMemo(() => buildSessionTimeline(session?.turns ?? []), [session?.turns]);
  const axisFormat = useMemo(() => sessionTimeAxisFormat(chart[0]?.timestamp ?? 0, chart.at(-1)?.timestamp ?? 0), [chart]);
  const heading = <header className="detail-header"><div><h1>Session 明細</h1><Link to={returnTo}><ArrowLeft size={16} aria-hidden="true" />返回 Sessions</Link></div>{session ? <code>{shortId(session.sessionId)}</code> : null}</header>;
  if (error) return <div className={styles.page}>{heading}<div className={styles.empty}><h2>無法載入這段紀錄</h2><p role="alert">請返回列表再試一次，或重新掃描資料來源。</p><details className={styles.errorDetails}><summary>查看錯誤詳情</summary><p>{error}</p></details></div></div>;
  if (!session) return <div className={styles.page}>{heading}<div className="page-loading" role="status">正在載入 Session 明細…</div></div>;
  const models = [...new Set((session.turns ?? []).map(turn => turn.model || "未知模型"))];
  const untimedTurns = (session.turns?.length ?? 0) - chart.length;
  const firstTimestamp = chart[0]?.timestamp ?? 0, lastTimestamp = chart.at(-1)?.timestamp ?? 0;
  const fastRequests = session.turns?.filter((turn) => turn.serviceTier === "priority").length ?? 0;
  const metricItems = [
    { Icon: Database, label: "整段對話 Tokens", value: formatInteger(session.tokens.totalTokens) },
    { Icon: Download, label: "Input", value: formatInteger(session.tokens.inputTokens) },
    { Icon: Gauge, label: "Cached input", value: formatInteger(session.tokens.cachedInputTokens), hint: `快取率 ${cacheRate(session.tokens).toFixed(1)}%` },
    { Icon: Gauge, label: "Cache writes", value: formatInteger(session.tokens.cacheWriteInputTokens) },
    { Icon: Upload, label: "Output", value: formatInteger(session.tokens.outputTokens) },
    { Icon: BrainCircuit, label: "Reasoning", value: formatInteger(session.tokens.reasoningOutputTokens) },
    { Icon: Zap, label: "快速模式請求", value: formatInteger(fastRequests) },
    {
      Icon: Coins,
      label: "API 等值估算",
      value: formatSessionCost(session.estimateMicrousd, session.tokens.totalTokens, session.unpricedTurnCount),
      hint: session.unpricedTurnCount > 0 ? `${formatTokens(session.unpricedTokens)} tokens 尚未定價` : undefined,
    },
  ];
  return <div className={`${styles.page} detail-page`}>
    {heading}
    <div className={styles.content}>
      <p className="footnote">這裡顯示整段對話的所有日期與模型；所選期間的用量請看 Sessions 列表。</p>
      <section className="metadata-strip"><div><span>使用模型</span><strong>{models.length ? models.join("、") : session.model}</strong></div><div><span>專案</span><strong>{session.project}</strong></div><div><span>開始時間</span><strong>{formatDateTime(session.startedAt)}</strong></div><div><span>最後活動</span><strong>{formatDateTime(session.endedAt)}</strong></div><div><span>資料來源</span><strong>{session.sourceName}</strong></div></section>
      <section className="detail-metrics">{metricItems.map(({ Icon, label, value, hint }) => <div key={label}><Icon size={20} /><span>{label}</span><strong>{value}</strong>{hint ? <small>{hint}</small> : null}</div>)}</section>
      <section className={`${styles.tablePanel} detail-chart-panel`}>
        <h2 className={styles.tableTitle}>Token 累積曲線</h2>
        <p className="footnote">依本機時區顯示；每次用量記錄後累加，沒有活動時維持水平。</p>
        {untimedTurns > 0 ? <p className="footnote">{formatInteger(untimedTurns)} 回合缺少有效時間，未計入曲線；整段用量與下方明細仍保留。</p> : null}
        {chart.length ? <div className="detail-chart"><ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chart} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
            <defs><linearGradient id="mintArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#65dfbf" stopOpacity=".35" /><stop offset="1" stopColor="#65dfbf" stopOpacity="0" /></linearGradient></defs>
            <CartesianGrid stroke="#2c353c" strokeDasharray="2 3" />
            <XAxis dataKey="timestamp" type="number" scale="time" domain={firstTimestamp === lastTimestamp ? [firstTimestamp - 30_000, lastTimestamp + 30_000] : ["dataMin", "dataMax"]} tickFormatter={value => axisFormat.format(Number(value))} tickCount={6} minTickGap={28} tick={{ fill: "#849094", fontSize: 11 }} tickLine={false} />
            <YAxis tickFormatter={formatTokens} tick={{ fill: "#849094", fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip content={<SessionTooltip />} />
            <Area type="stepAfter" dataKey="total" name="總 Tokens" stroke="#65dfbf" fill="url(#mintArea)" strokeWidth={2} dot={chart.length === 1} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="input" name="Input" stroke="#4291f5" fill="none" strokeWidth={1.5} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="output" name="Output" stroke="#8658dd" fill="none" strokeWidth={1.5} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="reasoning" name="Reasoning" stroke="#f1bd3d" fill="none" strokeWidth={1.4} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer></div> : <p className="footnote">沒有可繪製的時間紀錄。</p>}
      </section>
      <section className={styles.tablePanel}><h2 className={styles.tableTitle}>每回合用量</h2><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="每回合用量明細"><table className={styles.table}><thead><tr><th>回合</th><th>時間</th><th>模型</th><th>模式</th><th>Thinking</th><th>Tokens</th><th>Input（含快取）</th><th>Cached input</th><th>Cache writes</th><th>Output</th><th>Reasoning</th><th>快取率</th><th>API 等值</th></tr></thead><tbody>{session.turns?.map((turn) => <tr key={turn.ordinal}><td>{turn.ordinal}</td><td>{Number.isFinite(Date.parse(turn.timestamp)) ? formatDateTime(turn.timestamp) : "未記錄"}</td><td>{turn.model || "未知模型"}</td><td><span className={turn.serviceTier === "priority" ? "tier-badge fast" : "tier-badge"}>{turn.serviceTier === "priority" ? "快速" : "標準"}</span></td><td><span className="effort-badge">{turn.reasoningEffort && turn.reasoningEffort !== "unknown" ? turn.reasoningEffort : "未記錄"}</span></td><td>{formatInteger(turn.tokens.totalTokens)}</td><td>{formatInteger(turn.tokens.inputTokens)}</td><td>{formatInteger(turn.tokens.cachedInputTokens)}</td><td>{formatInteger(turn.tokens.cacheWriteInputTokens)}</td><td>{formatInteger(turn.tokens.outputTokens)}</td><td>{formatInteger(turn.tokens.reasoningOutputTokens)}</td><td className={styles.accent}>{turn.cacheRate.toFixed(1)}%</td><td>{formatCost(turn.estimateMicrousd)}</td></tr>)}</tbody></table></div></section>
      <p className="footnote">快速模式回合的 API 等值已套用 Priority 倍率；這不是 Codex 訂閱帳單。</p>
    </div>
  </div>;
}
