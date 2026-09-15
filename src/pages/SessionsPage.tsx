import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { SessionTable } from "../components/SessionTable";
import { useUsageData } from "../lib/data";
import styles from "../components/Dashboard.module.css";

export function SessionsPage() {
  const { data } = useUsageData();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const rows = useMemo(() => (data?.sessions ?? []).filter((session) =>
    (!source || session.sourceId === source) &&
    (!query || `${session.project} ${session.model} ${session.sessionId}`.toLowerCase().includes(query.toLowerCase()))
  ), [data, query, source]);
  return <div className={styles.page}><PageHeader title="Sessions" subtitle="搜尋使用紀錄，查看每段對話的用量與成本" /><div className={styles.content}>
    <div className={styles.filterRow}><label className="search-control"><Search size={15} /><input aria-label="搜尋 Sessions" placeholder="搜尋專案、模型或 Session ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="來源" value={source} onChange={(event) => setSource(event.target.value)}><option value="">所有來源</option>{data?.sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    <section className={styles.tablePanel}><h2 className={styles.tableTitle}>{rows.length} 個 Sessions</h2>{rows.length ? <SessionTable sessions={rows} /> : <div className={styles.empty}>沒有符合條件的 Session</div>}</section>
  </div></div>;
}
