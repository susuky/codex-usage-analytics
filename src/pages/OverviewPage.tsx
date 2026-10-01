import { ArrowUpRight, Bot, CalendarClock, Coins, Gauge, MessagesSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ModelDistribution } from "../components/ModelDistribution";
import { PageHeader } from "../components/PageHeader";
import { SessionTable } from "../components/SessionTable";
import { UsageHealth } from "../components/UsageHealth";
import { useUsageData } from "../lib/data";
import { fillDailyDateRange, fillDailyRange } from "../lib/daily";
import { cacheRate, formatCost, formatDate, formatInteger, formatTokens } from "../lib/format";
import styles from "../components/Dashboard.module.css";

const chartColors = { uncached: "#408CF4", cached: "#8056D9", cacheWrite: "#F2B75F", output: "#62DDBD", unclassified: "#9AA6A8" };

function Metric({ icon: Icon, label, value, hint }: { icon: typeof Coins; label: string; value: string; hint?: string }) {
  return <div className={styles.metric}><div className={styles.metricIcon}><Icon size={18} strokeWidth={1.7} aria-hidden="true" /></div><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong>{hint ? <small className={styles.metricHint}>{hint}</small> : null}</div>;
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{label}</strong>{payload.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}<b>{formatInteger(item.value)}</b></span>)}</div>;
}

export function OverviewPage() {
  const { data, filter, loading, scanning, error, reload } = useUsageData();
  const [showDailyTable, setShowDailyTable] = useState(false);
  const chartData = useMemo(
    () => filter.startDate && filter.endDate
      ? fillDailyDateRange(data?.daily ?? [], filter.startDate, filter.endDate)
      : fillDailyRange(data?.daily ?? [], filter.days),
    [data?.daily, filter.days, filter.startDate, filter.endDate]
  );
  if (loading && !data) return <div className={styles.page}><PageHeader title="用量總覽" /><div className="page-loading" role="status">正在載入使用紀錄…</div></div>;
  if (error && !data) return <div className={styles.page}><PageHeader title="用量總覽" /><div className={styles.empty}><h2>暫時無法顯示用量</h2><p>請重新載入；既有統計不會因此刪除。</p><button className="secondary-button" onClick={() => void reload()}>重新載入</button></div></div>;
  if (!data) return null;
  const barMinimum = (key: "uncachedInput" | "cachedInput" | "cacheWriteInput" | "output" | "unclassified") => (_value: number | null | undefined, index: number) => (chartData[index]?.[key] ?? 0) > 0 ? 3 : 0;
  const rate = cacheRate(data.totals);
  const todayTokens = data.todayTokens;
  const unpricedTokens = data.models.reduce((sum, model) => sum + model.unpricedTokens, 0);

  return (
    <div className={styles.page}>
      <PageHeader title="用量總覽" subtitle="掌握每日用量、模型分布與使用成本" />
      <section className={styles.metricRail} aria-label="用量摘要">
        <Metric icon={Coins} label={!filter.startDate && filter.days >= 36500 ? "全部 Tokens" : "區間 Tokens"} value={formatTokens(data.totals.totalTokens)} hint="依所選日期統計" />
        <Metric icon={CalendarClock} label="今日 Tokens" value={formatTokens(todayTokens)} hint="依裝置當地時間" />
        <Metric icon={Gauge} label="API 等值估算" value={formatCost(data.estimateMicrousd)} hint={unpricedTokens > 0 ? `${formatTokens(unpricedTokens)} tokens 尚未定價` : "非 Codex 訂閱帳單"} />
        <Metric icon={Bot} label="快取命中率" value={`${rate.toFixed(1)}%`} hint="快取輸入占總輸入比例" />
        <Metric icon={MessagesSquare} label="Sessions" value={formatInteger(data.sessions.length)} hint="所選區間內的對話" />
      </section>
      <div className={styles.content}>
        <div className={styles.charts}>
          <section className={styles.chartPanel}>
            <div className={styles.sectionHeading}><h2 className={styles.panelTitle}>每日 Token 趨勢</h2><Link to="/trends" className={styles.textLink}>查看趨勢<ArrowUpRight size={14} /></Link></div>
            <div className={styles.legend}><span><i style={{ background: chartColors.uncached }} />未快取輸入</span><span><i style={{ background: chartColors.cached }} />Cached input</span><span><i style={{ background: chartColors.cacheWrite }} />Cache writes</span><span><i style={{ background: chartColors.output }} />輸出</span><span><i style={{ background: chartColors.unclassified }} />未分類</span></div>
            <div className="main-chart" aria-label={`每日 Token 趨勢，區間總計 ${formatInteger(data.totals.totalTokens)} Tokens；可展開每日明細查看數值。`}><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} barCategoryGap="24%" maxBarSize={56} margin={{ top: 16, right: 8, left: -14, bottom: 0 }}><CartesianGrid stroke="#2b343a" vertical={false} strokeDasharray="2 2" /><XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: "#9aa7ad", fontSize: 12 }} axisLine={{ stroke: "#354047" }} tickLine={false} /><YAxis tickFormatter={formatTokens} tick={{ fill: "#9aa7ad", fontSize: 12 }} axisLine={false} tickLine={false} /><Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(255,255,255,.035)" }} /><Bar name="未快取輸入" dataKey="uncachedInput" stackId="a" fill={chartColors.uncached} minPointSize={barMinimum("uncachedInput")} isAnimationActive={false} /><Bar name="Cached input" dataKey="cachedInput" stackId="a" fill={chartColors.cached} minPointSize={barMinimum("cachedInput")} isAnimationActive={false} /><Bar name="Cache writes" dataKey="cacheWriteInput" stackId="a" fill={chartColors.cacheWrite} minPointSize={barMinimum("cacheWriteInput")} isAnimationActive={false} /><Bar name="輸出" dataKey="output" stackId="a" fill={chartColors.output} minPointSize={barMinimum("output")} isAnimationActive={false} /><Bar name="未分類" dataKey="unclassified" stackId="a" fill={chartColors.unclassified} minPointSize={barMinimum("unclassified")} isAnimationActive={false} radius={[2,2,0,0]} /></BarChart></ResponsiveContainer></div>
          </section>
          <ModelDistribution models={data.models} total={data.totals.totalTokens} />
        </div>
        <UsageHealth data={data} scanning={scanning} />
        <button className={styles.disclosureButton} aria-expanded={showDailyTable} aria-controls="daily-usage-table" onClick={() => setShowDailyTable(value => !value)}>{showDailyTable ? "收合每日明細" : "查看每日明細"}</button>
        {showDailyTable ? <section id="daily-usage-table" className={styles.tablePanel}><h2 className={styles.tableTitle}>每日用量明細</h2><div className={styles.dailyTableScroll} tabIndex={0} aria-label="每日用量明細"><table className={styles.table}><thead><tr>{["日期", "未快取輸入", "Cached input", "Cache writes", "輸出", "未分類"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{chartData.map(day => <tr key={day.date}><td>{day.date}</td>{[day.uncachedInput, day.cachedInput, day.cacheWriteInput, day.output, day.unclassified].map((value, index) => <td key={index}>{formatInteger(value)}</td>)}</tr>)}</tbody></table></div></section> : null}
        <section className={styles.tablePanel}><div className={styles.sectionHeading}><h2 className={styles.tableTitle}>最近 Sessions</h2><Link to="/sessions" className={styles.textLink}>查看全部<ArrowUpRight size={14} /></Link></div>{data.sessions.length ? <SessionTable sessions={data.sessions} limit={6} /> : <div className={styles.empty}>此區間尚無使用紀錄，請調整日期或掃描資料來源。</div>}</section>
        <p className="footnote">Cached input 與 Cache writes 已包含在 Input 中，不會重複計入總量。API 等值估算不代表 Codex 訂閱帳單。</p>
      </div>
    </div>
  );
}
