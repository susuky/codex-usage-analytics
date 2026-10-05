import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDateTime, formatInteger, formatSessionCost, formatTokens } from "../lib/format";
import { sortSessions, type SessionSort, type SessionSortKey } from "../lib/sessionView";
import type { SessionAggregate } from "../types";
import styles from "./Dashboard.module.css";

export function SessionTable({ sessions, limit, sort: controlledSort, onSortChange, page = 1, pageSize, returnTo = "/sessions" }: {
  sessions: SessionAggregate[]; limit?: number; sort?: SessionSort; onSortChange?: (sort: SessionSort) => void;
  page?: number; pageSize?: number; returnTo?: string;
}) {
  const [localSort, setSort] = useState<SessionSort>({ key: "endedAt", asc: false });
  const sort = controlledSort ?? localSort;
  const rows = useMemo(() => {
    const sorted = sortSessions(sessions, sort);
    if (pageSize) return sorted.slice((page - 1) * pageSize, page * pageSize);
    return limit ? sorted.slice(0, limit) : sorted;
  }, [sessions, limit, sort.key, sort.asc, page, pageSize]);

  const toggle = (key: SessionSortKey) => (onSortChange ?? setSort)({ key, asc: sort.key === key ? !sort.asc : true });
  const icon = (key: SessionSortKey) => sort.key !== key ? <ChevronsUpDown size={13} /> : sort.asc ? <ArrowUp size={13} /> : <ArrowDown size={13} />;
  const header = (key: SessionSortKey, label: string) => <th role="columnheader" scope="col" aria-sort={sort.key === key ? sort.asc ? "ascending" : "descending" : "none"} className={key === "tokens" || key === "cost" ? styles.numeric : undefined}><button className={styles.sortButton} onClick={() => toggle(key)}>{label}<span aria-hidden="true">{icon(key)}</span></button></th>;

  return (
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Session 使用紀錄">
      <table className={`${styles.table} ${styles.sessionTable}`} role="table" aria-label="Sessions 用量與成本">
        <thead role="rowgroup"><tr role="row">{header("project", "專案")}{header("model", "模型")}<th role="columnheader" scope="col" className={styles.sourceColumn}>來源</th>{header("endedAt", "最後活動")}{header("tokens", "Tokens")}{header("cost", "估算成本")}</tr></thead>
        <tbody role="rowgroup">
          {rows.map((session) => (
            <tr role="row" key={`${session.sourceId}:${session.sessionId}`}>
              <td role="cell"><Link to={`/sessions/${encodeURIComponent(session.sourceId)}/${encodeURIComponent(session.sessionId)}`} state={{ returnTo }}>{session.project}</Link></td>
              <td role="cell">{session.model}</td><td role="cell" data-label="來源" className={styles.muted}>{session.sourceName}</td><td role="cell" data-label="最後活動">{formatDateTime(session.endedAt)}</td>
              <td role="cell" data-label="Tokens" className={styles.numeric}>{formatInteger(session.tokens.totalTokens)}</td>
              <td role="cell" data-label="估算成本" className={styles.numeric}>
                <div className={styles.costCell} title={session.unpricedTurnCount > 0 ? `${formatInteger(session.unpricedTurnCount)} 個回合、${formatInteger(session.unpricedTokens)} tokens 尚未定價` : undefined}>
                  <span className={session.estimateMicrousd === null || session.tokens.totalTokens === 0 ? styles.muted : styles.accent}>{formatSessionCost(session.estimateMicrousd, session.tokens.totalTokens, session.unpricedTurnCount)}</span>
                  {session.unpricedTurnCount > 0 ? <small>{formatTokens(session.unpricedTokens)} 未定價</small> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
