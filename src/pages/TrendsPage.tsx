import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "../components/PageHeader";
import { useUsageData } from "../lib/data";
import { fillDailyDateRange, fillDailyRange } from "../lib/daily";
import { formatCost, formatDate, formatTokens } from "../lib/format";
import styles from "../components/Dashboard.module.css";

export default function TrendsPage() {
  const { data, filter } = useUsageData();
  const [view, setView] = useState<"tokens" | "cost">("tokens");
  const chartData = useMemo(() => {
    const daily = filter.startDate && filter.endDate
      ? fillDailyDateRange(data?.daily ?? [], filter.startDate, filter.endDate)
      : fillDailyRange(data?.daily ?? [], filter.days);
    return daily.map((item) => ({ ...item, estimateUsd: item.estimateMicrousd / 1_000_000 }));
  }, [data?.daily, filter.days, filter.startDate, filter.endDate]);
  return <div className={styles.page}><PageHeader title="趨勢" subtitle="依裝置時區彙整每日使用量" /><div className={styles.content}>
    <div className="segmented"><button className={view === "tokens" ? "active" : ""} onClick={() => setView("tokens")}>Tokens</button><button className={view === "cost" ? "active" : ""} onClick={() => setView("cost")}>API 等值估算</button></div>
    <section className={`${styles.tablePanel} trend-large`}><h2 className={styles.tableTitle}>{view === "tokens" ? "每日 Token 組成" : "每日 API 等值估算"}</h2><div className="trend-chart"><ResponsiveContainer width="100%" height="100%">{view === "tokens" ? <AreaChart data={chartData}><CartesianGrid stroke="#2c353c" vertical={false} /><XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: "#849094", fontSize: 11 }} /><YAxis tickFormatter={formatTokens} tick={{ fill: "#849094", fontSize: 11 }} /><Tooltip contentStyle={{ background: "#10171c", border: "1px solid #334047" }} /><Legend /><Area stackId="1" type="monotone" dataKey="cachedInput" name="Cached input" stroke="#8056d9" fill="#8056d9" fillOpacity={.55} /><Area stackId="1" type="monotone" dataKey="cacheWriteInput" name="Cache writes" stroke="#f2b75f" fill="#f2b75f" fillOpacity={.55} /><Area stackId="1" type="monotone" dataKey="uncachedInput" name="未快取輸入" stroke="#408cf4" fill="#408cf4" fillOpacity={.5} /><Area stackId="1" type="monotone" dataKey="output" name="輸出" stroke="#62ddbd" fill="#62ddbd" fillOpacity={.65} /><Area stackId="1" type="monotone" dataKey="unclassified" name="未分類" stroke="#9aa6a8" fill="#9aa6a8" fillOpacity={.55} /></AreaChart> : <BarChart data={chartData}><CartesianGrid stroke="#2c353c" vertical={false} /><XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: "#849094", fontSize: 11 }} /><YAxis tickFormatter={(value) => formatCost(Number(value) * 1_000_000)} tick={{ fill: "#849094", fontSize: 11 }} /><Tooltip formatter={(value) => formatCost(Number(value) * 1_000_000)} contentStyle={{ background: "#10171c", border: "1px solid #334047" }} /><Bar dataKey="estimateUsd" name="API 等值估算" fill="#62ddbd" radius={[3,3,0,0]} /></BarChart>}</ResponsiveContainer></div></section>
  </div></div>;
}
