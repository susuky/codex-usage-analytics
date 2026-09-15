import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import type { OverviewData } from "../types";
import { formatTokens } from "../lib/format";
import styles from "./Dashboard.module.css";

export function ModelDistribution({ models, total }: { models: OverviewData["models"]; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const ranked = useMemo(() => [...models].sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens), [models]);
  return <section className={`${styles.chartPanel} ${styles.modelPanel}`} aria-label="模型用量排行">
    <div className={styles.sectionHeading}><h2 className={styles.panelTitle}>模型分布</h2><Link className={styles.textLink} to="/models" aria-label="查看模型比較"><ArrowUpRight size={18} /></Link></div>
    <p className={styles.sectionHint}>依 Token 用量排序 · {models.length} 個模型</p>
    {total > 0 ? <ol className={styles.modelRanking}>{(expanded ? ranked : ranked.slice(0, 6)).map((model, index) => {
      const percent = model.tokens.totalTokens / total * 100;
      return <li key={model.model}>
        <div className={styles.modelRow}><span className={styles.rankNumber}>{String(index + 1).padStart(2, "0")}</span><span className={styles.modelName}>{model.model}</span><strong>{percent > 0 && percent < .1 ? "<0.1" : percent.toFixed(1)}%</strong></div>
        <div className={styles.modelTrack} aria-hidden="true"><span style={{ width: `${Math.min(100, percent)}%` }} /></div>
        <span className={styles.modelTokens}>{formatTokens(model.tokens.totalTokens)} Tokens</span>
      </li>;
    })}</ol> : <div className={styles.empty}>此區間尚無模型用量</div>}
    {models.length > 6 ? <button className={styles.disclosureButton} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收合模型" : `顯示全部 ${models.length} 個模型`}<ChevronDown size={14} /></button> : null}
  </section>;
}
