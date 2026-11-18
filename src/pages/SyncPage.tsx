import { AlertCircle, CheckCircle2, Clock3, FolderArchive, Laptop, PauseCircle, RefreshCw, Server } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useUsageData } from "../lib/data";
import { formatDateTime } from "../lib/format";
import styles from "../components/Dashboard.module.css";

export default function SyncPage() {
  const { data, scanning, refresh, pollMinutes = 15 } = useUsageData();
  const enabledCount = data?.sources.filter(source => source.enabled).length ?? 0;
  return <div className={styles.page}><PageHeader title="資料來源" showDateFilter={false} /><div className={styles.content}>
    <section className="source-list"><div className="source-list-heading"><div><h2>掃描狀態</h2><p>{enabledCount} 個來源已啟用 · App 開啟時，每 {pollMinutes} 分鐘掃描一次</p></div><button className="primary-button" disabled={scanning || !enabledCount} onClick={() => void refresh(true)}><RefreshCw size={16} />{scanning ? "掃描中…" : "完整掃描所有來源"}</button></div>{!enabledCount && data ? <div className={styles.empty}><p>啟用本機或遠端來源後，就能更新使用紀錄。</p><Link className={styles.textLink} to="/settings">管理資料來源</Link></div> : null}{data?.sources.map((source) => {
      const state = !source.enabled ? "disabled" : source.lastError ? "error" : source.stale || !source.lastScannedAt ? "pending" : "ok";
      const StateIcon = state === "disabled" ? PauseCircle : state === "error" ? AlertCircle : state === "pending" ? Clock3 : CheckCircle2;
      return <article key={source.id}>
        <div className="source-icon">{source.kind === "local" ? <Laptop size={21} /> : source.kind === "cloud" ? <FolderArchive size={21} /> : <Server size={21} />}</div>
        <div className="source-identity"><strong>{source.name}</strong><span>{source.kind === "ssh" ? source.target : source.kind === "cloud" ? "歷史匯入" : "本機 Codex"}</span></div>
        <div className="source-meta"><strong>{source.sessionCount.toLocaleString()} Sessions</strong><span>{source.lastScannedAt ? `上次成功掃描於 ${formatDateTime(source.lastScannedAt)}` : "尚無完整掃描紀錄"}</span><span>{source.latestDataAt ? `資料最新至 ${formatDateTime(source.latestDataAt)}` : "尚無 Token 資料"}</span>{source.enabled && source.lastNotice ? <span>{source.lastNotice}</span> : null}</div>
        <span className={`source-badge source-badge-${state}`}><StateIcon size={15} />{state === "disabled" ? "已停用" : state === "error" ? "需要處理" : state === "pending" ? "待更新" : "正常"}</span>
        {source.enabled && source.lastError ? <details className="source-issue"><summary>查看問題詳情</summary><p>{source.lastError}</p><span>可重新掃描以更新紀錄；若無法連線，請到設定檢查來源。</span></details> : null}
      </article>;
    })}</section>
    {scanning ? <p className="scan-progress" role="status">正在完整掃描本機與遠端來源，完成後會自動更新。</p> : null}
  </div></div>;
}
