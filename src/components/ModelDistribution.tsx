import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import type { OverviewData, UsageFilter } from "../types";
import { getOverview } from "../lib/api";
import { useUsageData } from "../lib/data";
import { formatInteger, formatTokens } from "../lib/format";
import styles from "./Dashboard.module.css";

export function ModelDistribution({ date, dates, onDateChange }: { date: string; dates: string[]; onDateChange: (date: string) => void }) {
  const { data, filter, setFilter } = useUsageData();
  const [expanded, setExpanded] = useState(false);
  const request = useMemo(() => date ? { ...filter, startDate: date, endDate: date } : null, [filter, date]);
  const [result, setResult] = useState<{ request: UsageFilter; overview: OverviewData; data: OverviewData | null; failed: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!request || !data) return;
    let active = true;
    void getOverview(request).then(day => {
      if (active) setResult({ request, overview: data, data: day, failed: false });
    }).catch(() => {
      if (active) setResult({ request, overview: data, data: null, failed: true });
    });
    return () => { active = false; };
  }, [request, data, attempt]);
  const current = result?.request === request && result.overview === data ? result : null;
  const selected = request ? current?.data : data;
  const models = selected?.models ?? [];
  const total = selected?.totals.totalTokens ?? 0;
  const pending = Boolean(request && !current);
  const ranked = useMemo(() => [...models].sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens), [models]);
  const openSelectedDate = () => { if (request) setFilter(request); };
  return <section className={`${styles.chartPanel} ${styles.modelPanel}`} aria-label="模型用量排行">
    <div className={styles.sectionHeading}><h2 className={styles.panelTitle}>模型分布</h2><Link className={styles.textLink} to="/models" aria-label="查看模型比較" onClick={openSelectedDate}><ArrowUpRight size={18} /></Link></div>
    <div className={styles.modelDateControls}>
      <select aria-label="模型分布日期" value={date} onChange={event => onDateChange(event.target.value)}>
        <option value="">整個區間</option>
        {dates.map(day => <option key={day} value={day}>{day}</option>)}
      </select>
      {date ? <button className={styles.clearButton} onClick={() => onDateChange("")}>返回整個區間</button> : null}
    </div>
    {selected ? <p className={styles.sectionHint}>{date ? <><strong className={styles.dayModelTotal}>{formatInteger(total)} Tokens</strong><br /></> : null}依 Token 用量排序 · {models.length} 個模型</p> : null}
    {pending ? <div className={styles.empty} role="status">正在載入當日模型用量…</div> : current?.failed ? <div className={styles.empty} role="status"><p>暫時無法載入當日模型用量。</p><button className="secondary-button" onClick={() => { setResult(null); setAttempt(value => value + 1); }}>重試</button></div> : total > 0 ? <ol className={styles.modelRanking}>{(expanded ? ranked : ranked.slice(0, 6)).map((model, index) => {
      const percent = model.tokens.totalTokens / total * 100;
      return <li key={model.model}>
        <div className={styles.modelRow}><span className={styles.rankNumber}>{String(index + 1).padStart(2, "0")}</span><Link className={styles.modelName} to={`/sessions?model=${encodeURIComponent(model.model)}`} aria-label={`查看 ${model.model} 的 Sessions`} onClick={openSelectedDate}>{model.model}</Link><strong>{percent > 0 && percent < .1 ? "<0.1" : percent.toFixed(1)}%</strong></div>
        <div className={styles.modelTrack} aria-hidden="true"><span style={{ width: `${Math.min(100, percent)}%` }} /></div>
        <span className={styles.modelTokens}>{formatTokens(model.tokens.totalTokens)} Tokens</span>
      </li>;
    })}</ol> : <div className={styles.empty}>{date ? "這一天沒有模型用量" : "此區間尚無模型用量"}</div>}
    {models.length > 6 ? <button className={styles.disclosureButton} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收合模型" : `顯示全部 ${models.length} 個模型`}<ChevronDown size={14} /></button> : null}
  </section>;
}
