import { ArrowUpRight, CircleDollarSign, Server } from "lucide-react";
import { Link } from "react-router-dom";
import { formatTokens } from "../lib/format";
import type { OverviewData } from "../types";
import styles from "./Dashboard.module.css";

export function UsageHealth({ data, scanning }: { data: OverviewData; scanning: boolean }) {
  const enabled = data.sources.filter(source => source.enabled);
  const ready = enabled.filter(source => !source.stale && !source.lastError && source.lastScannedAt);
  const pending = enabled.length - ready.length;
  const unpriced = data.models.reduce((sum, model) => sum + model.unpricedTokens, 0);
  const coverage = data.totals.totalTokens > 0 ? Math.max(0, Math.min(100, (1 - unpriced / data.totals.totalTokens) * 100)) : null;
  const coverageLabel = coverage === null ? "尚無用量" : `${unpriced > 0 && coverage > 99.9 ? ">99.9" : coverage.toFixed(1)}% 的 Tokens 已估價`;
  return <section className={styles.healthGrid} aria-label="資料與估算狀態">
    <Link to="/sync" className={styles.healthCard}>
      <Server size={18} aria-hidden="true" /><div><span>資料來源</span><strong>{scanning ? "正在掃描來源" : !enabled.length ? "尚未啟用來源" : pending ? `${pending} 個來源待更新` : `${ready.length} 個來源已更新`}</strong><small>{scanning ? "完成後會自動更新用量" : pending ? "部分來源尚未更新，總量可能不完整" : "查看各裝置的掃描時間與連線狀態"}</small></div><ArrowUpRight size={16} aria-hidden="true" />
    </Link>
    <Link to="/models" className={styles.healthCard}>
      <CircleDollarSign size={18} aria-hidden="true" /><div><span>估價涵蓋率</span><strong>{coverageLabel}</strong><small>{unpriced > 0 ? `${formatTokens(unpriced)} tokens 尚未定價，查看模型明細` : "API 等值估算，不是訂閱帳單"}</small></div><ArrowUpRight size={16} aria-hidden="true" />
    </Link>
  </section>;
}
