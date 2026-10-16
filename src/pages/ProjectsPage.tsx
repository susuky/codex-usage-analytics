import { Search } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useUsageData } from "../lib/data";
import { formatDateTime, formatInteger, formatSessionCost, formatTokens } from "../lib/format";
import { getProjectSummaries, projectPath } from "../lib/projectView";
import styles from "../components/Dashboard.module.css";

export default function ProjectsPage() {
  const { data, loading, error, reload } = useUsageData();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const source = params.get("source") ?? "";
  const sort = params.get("sort") ?? "tokens";
  const projects = useMemo(() => {
    const rows = getProjectSummaries((data?.sessions ?? []).filter(session => !source || session.sourceId === source))
      .filter(item => item.project.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    return rows.sort((a, b) => sort === "name" ? a.project.localeCompare(b.project) : sort === "sessions" ? b.sessionCount - a.sessionCount : sort === "cost" ? (b.estimateMicrousd ?? -1) - (a.estimateMicrousd ?? -1) : sort === "latest" ? b.endedAt.localeCompare(a.endedAt) : b.tokens.totalTokens - a.tokens.totalTokens);
  }, [data, query, source, sort]);
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const returnTo = `/projects${params.size ? `?${params}` : ""}`;
  return <div className={styles.page}>
    <PageHeader title="專案" subtitle="彙整各專案的用量、估算成本與 Sessions" />
    <div className={styles.content}>
      <section className={`${styles.sessionFilterGrid} ${styles.projectFilters}`} aria-label="篩選專案">
        <label><span>搜尋</span><span className="search-control"><Search size={16} aria-hidden="true" /><input aria-label="搜尋專案" name="q" type="search" autoComplete="off" spellCheck={false} placeholder="專案名稱…" value={query} onChange={event => update("q", event.target.value)} /></span></label>
        <label><span>來源</span><select name="source" value={source} onChange={event => update("source", event.target.value)}>
          <option value="">所有來源</option>
          {source && !data?.sources.some(item => item.id === source) ? <option value={source}>所選來源（目前無資料）</option> : null}
          {data?.sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label><span>排序</span><select aria-label="專案排序" value={sort} onChange={event => update("sort", event.target.value)}>
          <option value="tokens">Tokens 由多到少</option><option value="cost">估算成本由高到低</option><option value="sessions">Sessions 由多到少</option><option value="latest">最近活動優先</option><option value="name">專案名稱</option>
        </select></label>
      </section>
      {loading && !data ? <p className="page-loading" role="status">正在載入專案…</p> : error && !data ? <div className={styles.empty}><h2>暫時無法顯示專案</h2><p>請重新載入。</p><button className="secondary-button" onClick={() => void reload()}>重新載入</button></div> : <section className={styles.tablePanel}>
        <div className={styles.resultsHeading}><h2 className={styles.tableTitle}>{formatInteger(projects.length)} 個專案</h2><p>依所選日期與來源統計</p></div>
        {projects.length ? <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="專案用量與成本"><table className={`${styles.table} ${styles.projectTable}`}>
          <thead><tr>{["專案", "Sessions", "來源", "最後活動", "Tokens", "API 等值估算"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{projects.map(item => <tr key={item.project}>
            <td><Link to={`${projectPath(item.project)}${source ? `?source=${encodeURIComponent(source)}` : ""}`} state={{ returnTo }}>{item.project || "未記錄專案"}</Link></td>
            <td data-label="Sessions">{formatInteger(item.sessionCount)}</td><td data-label="來源">{item.sources.map(value => value.name).join("、")}</td><td data-label="最後活動">{item.endedAt ? formatDateTime(item.endedAt) : "未記錄"}</td>
            <td data-label="Tokens" className={styles.numeric}>{formatInteger(item.tokens.totalTokens)}</td>
            <td data-label="API 等值估算" className={styles.numeric}><div className={styles.costCell}><span>{formatSessionCost(item.estimateMicrousd, item.tokens.totalTokens, item.unpricedTurnCount)}</span>{item.unpricedTokens > 0 ? <small>{formatTokens(item.unpricedTokens)} 未定價</small> : null}</div></td>
          </tr>)}</tbody>
        </table></div> : <div className={styles.empty}><h3>{query || source ? "沒有符合條件的專案" : "此區間尚無專案用量"}</h3><p>請調整搜尋、來源或上方日期區間。</p>{query || source ? <button className="secondary-button" onClick={() => setParams({}, { replace: true })}>清除篩選</button> : <Link className={styles.textLink} to="/sync">查看資料來源</Link>}</div>}
      </section>}
    </div>
  </div>;
}
