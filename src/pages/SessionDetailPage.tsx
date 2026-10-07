import { ArrowLeft, BrainCircuit, Coins, Database, Download, Gauge, Upload, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getSessionDetail } from "../lib/api";
import { cacheRate, formatCost, formatDateTime, formatInteger, formatSessionCost, formatTokens, shortId } from "../lib/format";
import type { SessionAggregate } from "../types";
import styles from "../components/Dashboard.module.css";

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
  const chart = useMemo(() => {
    let total = 0, input = 0, output = 0, reasoning = 0;
    return (session?.turns ?? []).map((turn) => {
      total += turn.tokens.totalTokens; input += turn.tokens.inputTokens; output += turn.tokens.outputTokens; reasoning += turn.tokens.reasoningOutputTokens;
      return { turn: turn.ordinal, total, input, output, reasoning };
    });
  }, [session]);
  const heading = <header className="detail-header"><div><h1>Session 明細</h1><Link to={returnTo}><ArrowLeft size={16} aria-hidden="true" />返回 Sessions</Link></div>{session ? <code>{shortId(session.sessionId)}</code> : null}</header>;
  if (error) return <div className={styles.page}>{heading}<div className={styles.empty}><h2>無法載入這段紀錄</h2><p role="alert">請返回列表再試一次，或重新掃描資料來源。</p><details className={styles.errorDetails}><summary>查看錯誤詳情</summary><p>{error}</p></details></div></div>;
  if (!session) return <div className={styles.page}>{heading}<div className="page-loading" role="status">正在載入 Session 明細…</div></div>;
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
      <section className="metadata-strip"><div><span>模型</span><strong>{session.model}</strong></div><div><span>專案</span><strong>{session.project}</strong></div><div><span>開始時間</span><strong>{formatDateTime(session.startedAt)}</strong></div><div><span>最後活動</span><strong>{formatDateTime(session.endedAt)}</strong></div><div><span>資料來源</span><strong>{session.sourceName}</strong></div></section>
      <section className="detail-metrics">{metricItems.map(({ Icon, label, value, hint }) => <div key={label}><Icon size={20} /><span>{label}</span><strong>{value}</strong>{hint ? <small>{hint}</small> : null}</div>)}</section>
      <section className={`${styles.tablePanel} detail-chart-panel`}><h2 className={styles.tableTitle}>Token 累積曲線</h2><div className="detail-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chart} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}><defs><linearGradient id="mintArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#65dfbf" stopOpacity=".35" /><stop offset="1" stopColor="#65dfbf" stopOpacity="0" /></linearGradient></defs><CartesianGrid stroke="#2c353c" strokeDasharray="2 3" /><XAxis dataKey="turn" tick={{ fill: "#849094", fontSize: 11 }} tickLine={false} /><YAxis tickFormatter={formatTokens} tick={{ fill: "#849094", fontSize: 11 }} tickLine={false} axisLine={false} /><Tooltip contentStyle={{ background: "#10171c", border: "1px solid #334047", borderRadius: 8 }} /><Area type="monotone" dataKey="total" name="總 Tokens" stroke="#65dfbf" fill="url(#mintArea)" strokeWidth={2} /><Area type="monotone" dataKey="input" name="Input" stroke="#4291f5" fill="none" strokeWidth={1.5} /><Area type="monotone" dataKey="output" name="Output" stroke="#8658dd" fill="none" strokeWidth={1.5} /><Area type="monotone" dataKey="reasoning" name="Reasoning" stroke="#f1bd3d" fill="none" strokeWidth={1.4} /></AreaChart></ResponsiveContainer></div></section>
      <section className={styles.tablePanel}><h2 className={styles.tableTitle}>每回合用量</h2><div className={styles.tableWrap} tabIndex={0} role="region" aria-label="每回合用量明細"><table className={styles.table}><thead><tr><th>回合</th><th>時間</th><th>模式</th><th>Thinking</th><th>Tokens</th><th>Input（含快取）</th><th>Cached input</th><th>Cache writes</th><th>Output</th><th>Reasoning</th><th>快取率</th><th>API 等值</th></tr></thead><tbody>{session.turns?.map((turn) => <tr key={turn.ordinal}><td>{turn.ordinal}</td><td>{formatDateTime(turn.timestamp)}</td><td><span className={turn.serviceTier === "priority" ? "tier-badge fast" : "tier-badge"}>{turn.serviceTier === "priority" ? "快速" : "標準"}</span></td><td><span className="effort-badge">{turn.reasoningEffort && turn.reasoningEffort !== "unknown" ? turn.reasoningEffort : "未記錄"}</span></td><td>{formatInteger(turn.tokens.totalTokens)}</td><td>{formatInteger(turn.tokens.inputTokens)}</td><td>{formatInteger(turn.tokens.cachedInputTokens)}</td><td>{formatInteger(turn.tokens.cacheWriteInputTokens)}</td><td>{formatInteger(turn.tokens.outputTokens)}</td><td>{formatInteger(turn.tokens.reasoningOutputTokens)}</td><td className={styles.accent}>{turn.cacheRate.toFixed(1)}%</td><td>{formatCost(turn.estimateMicrousd)}</td></tr>)}</tbody></table></div></section>
      <p className="footnote">快速模式回合的 API 等值已套用 Priority 倍率；這不是 Codex 訂閱帳單。</p>
    </div>
  </div>;
}
