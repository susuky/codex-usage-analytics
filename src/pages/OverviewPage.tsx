import { ArrowUpRight, Bot, CalendarClock, Coins, Gauge, MessagesSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ModelDistribution } from "../components/ModelDistribution";
import { PageHeader } from "../components/PageHeader";
import { SessionTable } from "../components/SessionTable";
import { UsageHealth } from "../components/UsageHealth";
import { useUsageData } from "../lib/data";
import { dailyEstimate, dailyTokenTotal, fillDailyDateRange, fillDailyRange, formatDailyCost } from "../lib/daily";
import { cacheRate, formatCost, formatDate, formatInteger, formatTokens } from "../lib/format";
import type { DailyUsage, UsageFilter } from "../types";
import styles from "../components/Dashboard.module.css";

const chartColors = { uncached: "#408CF4", cached: "#8056D9", cacheWrite: "#F2B75F", output: "#62DDBD", unclassified: "#9AA6A8" };

function Metric({ icon: Icon, label, value, hint }: { icon: typeof Coins; label: string; value: string; hint?: string }) {
  return <div className={styles.metric}><div className={styles.metricIcon}><Icon size={18} strokeWidth={1.7} aria-hidden="true" /></div><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong>{hint ? <small className={styles.metricHint}>{hint}</small> : null}</div>;
}

function ChartTooltip({ active, payload, label, view }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: DailyUsage }>; label?: string; view: "tokens" | "cost" }) {
  if (!active || !payload?.length) return null;
  const day = payload[0].payload;
  return <div className="chart-tooltip"><strong>{label}</strong>
    {view === "tokens" ? payload.map((item) => <span className="chart-tooltip-part" key={item.name}><i style={{ background: item.color }} />{item.name}<b>{formatInteger(item.value)}</b></span>) : null}
    <span className="chart-tooltip-total">總 Tokens<b>{formatInteger(dailyTokenTotal(day))}</b></span>
    <span className="chart-tooltip-cost">API 等值估算<b>{formatDailyCost(day)}</b></span>
    {day.unpricedTokens > 0 ? <small>{formatTokens(day.unpricedTokens)} Tokens 尚未定價</small> : null}
  </div>;
}

export function OverviewPage() {
  const { data, filter, loading, scanning, error, reload } = useUsageData();
  const [showDailyTable, setShowDailyTable] = useState(false);
  const [view, setView] = useState<"tokens" | "cost">("tokens");
  const [selectedDay, setSelectedDay] = useState<{ date: string; filter: UsageFilter } | null>(null);
  const chartData = useMemo(
    () => filter.startDate && filter.endDate
      ? fillDailyDateRange(data?.daily ?? [], filter.startDate, filter.endDate)
      : fillDailyRange(data?.daily ?? [], filter.days),
    [data?.daily, filter.days, filter.startDate, filter.endDate]
  );
  const selectedDate = selectedDay?.filter === filter && chartData.some(day => day.date === selectedDay.date) ? selectedDay.date : "";
  const selectDate = (date: string) => setSelectedDay(date ? { date, filter } : null);
  if (loading && !data) return <div className={styles.page}><PageHeader title="用量總覽" /><div className="page-loading" role="status">正在載入使用紀錄…</div></div>;
  if (error && !data) return <div className={styles.page}><PageHeader title="用量總覽" /><div className={styles.empty}><h2>暫時無法顯示用量</h2><p>請重新載入；既有統計不會因此刪除。</p><button className="secondary-button" onClick={() => void reload()}>重新載入</button></div></div>;
  if (!data) return null;
  const barMinimum = (key: "uncachedInput" | "cachedInput" | "cacheWriteInput" | "output" | "unclassified") => (_value: number | null | undefined, index: number) => (chartData[index]?.[key] ?? 0) > 0 ? 3 : 0;
  const rate = cacheRate(data.totals);
  const todayTokens = data.todayTokens;
  const unpricedTokens = data.models.reduce((sum, model) => sum + model.unpricedTokens, 0);
  const chartTitle = view === "tokens" ? "每日 Token 趨勢" : "每日 API 等值估算";

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
            <div className={`${styles.sectionHeading} ${styles.chartHeading}`}><h2 className={styles.panelTitle}>{chartTitle}</h2><Link to="/trends" className={styles.textLink}>查看趨勢<ArrowUpRight size={14} /></Link></div>
            <div className={styles.chartControls}><div className="segmented" role="group" aria-label="每日圖表顯示方式"><button aria-pressed={view === "tokens"} className={view === "tokens" ? "active" : ""} onClick={() => setView("tokens")}>Tokens</button><button aria-pressed={view === "cost"} className={view === "cost" ? "active" : ""} onClick={() => setView("cost")}>API 等值估算</button></div></div>
            {view === "tokens" ? <div className={styles.legend}><span><i style={{ background: chartColors.uncached }} />未快取輸入</span><span><i style={{ background: chartColors.cached }} />Cached input</span><span><i style={{ background: chartColors.cacheWrite }} />Cache writes</span><span><i style={{ background: chartColors.output }} />輸出</span><span><i style={{ background: chartColors.unclassified }} />未分類</span></div> : <p className={styles.chartCostNote}>單位：美元{unpricedTokens > 0 ? " · 僅計入已定價用量" : ""}</p>}
            <div className="main-chart" aria-label={`${chartTitle}；點選日期可查看當天的估算與模型分布，也可使用模型分布日期選單。`}>
              <ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} barCategoryGap="24%" maxBarSize={56} margin={{ top: 24, right: 8, left: 0, bottom: 0 }} onClick={({ activeLabel }) => { if (typeof activeLabel === "string" && chartData.some(day => day.date === activeLabel)) selectDate(activeLabel); }}>
                <CartesianGrid stroke="#2b343a" vertical={false} strokeDasharray="2 2" />
                <XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: "#9aa7ad", fontSize: 12 }} axisLine={{ stroke: "#354047" }} tickLine={false} />
                <YAxis width={view === "cost" ? 88 : 60} tickFormatter={view === "cost" ? formatCost : formatTokens} tick={{ fill: "#9aa7ad", fontSize: 12 }} axisLine={false} tickLine={false} />
                {selectedDate ? <ReferenceLine x={selectedDate} stroke={chartColors.output} strokeDasharray="4 4" /> : null}
                <Tooltip content={<ChartTooltip view={view} />} filterNull={false} cursor={{ fill: "rgba(255,255,255,.035)" }} />
                {view === "cost" ? <Bar name="API 等值估算" dataKey={dailyEstimate} fill={chartColors.output} radius={[2,2,0,0]} isAnimationActive={false}>
                  {chartData.length <= 7 ? <LabelList className="daily-cost-label" position="top" fill="var(--text)" fontSize={11} formatter={value => typeof value === "number" ? formatCost(value) : ""} /> : null}
                </Bar> : <>
                  <Bar name="未快取輸入" dataKey="uncachedInput" stackId="a" fill={chartColors.uncached} minPointSize={barMinimum("uncachedInput")} isAnimationActive={false} />
                  <Bar name="Cached input" dataKey="cachedInput" stackId="a" fill={chartColors.cached} minPointSize={barMinimum("cachedInput")} isAnimationActive={false} />
                  <Bar name="Cache writes" dataKey="cacheWriteInput" stackId="a" fill={chartColors.cacheWrite} minPointSize={barMinimum("cacheWriteInput")} isAnimationActive={false} />
                  <Bar name="輸出" dataKey="output" stackId="a" fill={chartColors.output} minPointSize={barMinimum("output")} isAnimationActive={false} />
                  <Bar name="未分類" dataKey="unclassified" stackId="a" fill={chartColors.unclassified} minPointSize={barMinimum("unclassified")} isAnimationActive={false} radius={[2,2,0,0]} />
                </>}
              </BarChart></ResponsiveContainer>
            </div>
            <p className={styles.sectionHint}>點選日期，查看當天的估算與模型分布。</p>
          </section>
          <ModelDistribution date={selectedDate} dates={chartData.map(day => day.date)} onDateChange={selectDate} />
        </div>
        <UsageHealth data={data} scanning={scanning} />
        <button className={styles.disclosureButton} aria-expanded={showDailyTable} aria-controls="daily-usage-table" onClick={() => setShowDailyTable(value => !value)}>{showDailyTable ? "收合每日明細" : "查看每日明細"}</button>
        {showDailyTable ? <section id="daily-usage-table" className={styles.tablePanel}><h2 className={styles.tableTitle}>每日用量明細</h2><div className={styles.dailyTableScroll} tabIndex={0} aria-label="每日用量明細"><table className={styles.table}><thead><tr>{["日期", "未快取輸入", "Cached input", "Cache writes", "輸出", "未分類", "總 Tokens", "API 等值估算"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{chartData.map(day => <tr key={day.date}><td><button className={styles.dailyDateButton} aria-label={`查看 ${day.date} 模型分布`} aria-pressed={selectedDate === day.date} onClick={() => selectDate(day.date)}>{day.date}</button></td>{[day.uncachedInput, day.cachedInput, day.cacheWriteInput, day.output, day.unclassified, dailyTokenTotal(day)].map((value, index) => <td key={index} className={index === 5 ? styles.accent : undefined}>{formatInteger(value)}</td>)}<td><div className={styles.costCell}><span>{formatDailyCost(day)}</span>{day.unpricedTokens > 0 ? <small>{formatTokens(day.unpricedTokens)} 未定價</small> : null}</div></td></tr>)}</tbody></table></div></section> : null}
        <section className={styles.tablePanel}><div className={styles.sectionHeading}><h2 className={styles.tableTitle}>最近 Sessions</h2><Link to="/sessions" className={styles.textLink}>查看全部<ArrowUpRight size={14} /></Link></div>{data.sessions.length ? <SessionTable sessions={data.sessions} limit={6} /> : <div className={styles.empty}>此區間尚無使用紀錄，請調整日期或掃描資料來源。</div>}</section>
        <p className="footnote">Cached input 與 Cache writes 已包含在 Input 中，不會重複計入總量。API 等值估算不代表 Codex 訂閱帳單。</p>
      </div>
    </div>
  );
}
