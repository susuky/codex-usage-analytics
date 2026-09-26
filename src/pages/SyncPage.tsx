import { AlertCircle, CheckCircle2, Clock3, Cloud, Laptop, PauseCircle, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useCloud } from "../lib/cloud";
import { useUsageData } from "../lib/data";
import { formatDateTime } from "../lib/format";
import styles from "../components/Dashboard.module.css";

export default function SyncPage() {
  const { data, scanning, refresh, pollMinutes = 15 } = useUsageData();
  const { status, syncNow } = useCloud();
  const [message, setMessage] = useState<string | null>(null);
  const runCloudSync = async () => {
    if (!data) return;
    setMessage(null);
    try { await syncNow(data); setMessage("去識別化統計已同步"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
  const enabledCount = data?.sources.filter(source => source.enabled).length ?? 0;
  return <div className={styles.page}><PageHeader title="同步" subtitle="查看各裝置的更新狀態，讓使用紀錄保持完整" showDateFilter={false} /><div className={styles.content}>
    <section className="source-list"><div className="source-list-heading"><div><h2>資料來源</h2><p>{enabledCount} 個來源已啟用 · App 開啟時，每 {pollMinutes} 分鐘掃描一次</p></div><button className="primary-button" disabled={scanning || !enabledCount} onClick={() => void refresh(true)}><RefreshCw size={16} />{scanning ? "掃描中…" : "完整掃描所有來源"}</button></div>{!enabledCount && data ? <div className={styles.empty}><p>啟用本機或遠端來源後，就能更新使用紀錄。</p><Link className={styles.textLink} to="/settings">管理資料來源</Link></div> : null}{data?.sources.map((source) => {
      const state = !source.enabled ? "disabled" : source.lastError ? "error" : source.stale || !source.lastScannedAt ? "pending" : "ok";
      const StateIcon = state === "disabled" ? PauseCircle : state === "error" ? AlertCircle : state === "pending" ? Clock3 : CheckCircle2;
      return <article key={source.id}>
        <div className="source-icon">{source.kind === "local" ? <Laptop size={21} /> : source.kind === "cloud" ? <Cloud size={21} /> : <Server size={21} />}</div>
        <div className="source-identity"><strong>{source.name}</strong><span>{source.kind === "ssh" ? source.target : source.kind === "cloud" ? "雲端統計" : "本機 Codex"}</span></div>
        <div className="source-meta"><strong>{source.sessionCount.toLocaleString()} Sessions</strong><span>{source.lastScannedAt ? `上次成功掃描於 ${formatDateTime(source.lastScannedAt)}` : "尚無完整掃描紀錄"}</span><span>{source.latestDataAt ? `資料最新至 ${formatDateTime(source.latestDataAt)}` : "尚無 Token 資料"}</span></div>
        <span className={`source-badge source-badge-${state}`}><StateIcon size={15} />{state === "disabled" ? "已停用" : state === "error" ? "需要處理" : state === "pending" ? "待更新" : "正常"}</span>
        {source.enabled && source.lastError ? <details className="source-issue"><summary>查看問題詳情</summary><p>{source.lastError}</p><span>既有統計已保留。可重新掃描，或到設定檢查連線。</span></details> : null}
      </article>;
    })}</section>
    {scanning ? <p className="scan-progress" role="status">正在完整掃描本機與遠端來源，完成後會自動更新。</p> : null}
    <section className="cloud-panel"><div className="cloud-icon"><Cloud size={25} /></div><div><h2>雲端統計同步</h2><p>{!status.enabled ? "已停用雲端同步" : status.configured ? status.signedIn ? `已登入 ${status.email}` : "登入後即可跨裝置同步" : "尚未設定雲端同步，本機與 SSH 掃描仍可使用"}</p></div><button className="secondary-button" disabled={!status.signedIn || !status.enabled || status.syncing || !data} onClick={() => void runCloudSync()}><RefreshCw size={16} />{status.syncing ? "同步中…" : "立即同步"}</button></section>
    <p role="status">待同步 {status.pendingRows} 個 Sessions{status.lastSyncedAt ? ` · 上次同步 ${formatDateTime(status.lastSyncedAt)}` : ""}</p>
    <div className="action-row">{message ? <span role="status">{message}</span> : null}{status.lastError ? <span className="state-error" role="alert">{status.lastError}</span> : null}</div>
    <aside className="privacy-note"><ShieldCheck size={19} /><div><strong>保留統計，不保留對話</strong><p>刪除原始對話不會刪除已匯入的使用紀錄。雲端只同步去識別化統計，不包含對話內容、裝置名稱或完整路徑。</p></div></aside>
  </div></div>;
}
