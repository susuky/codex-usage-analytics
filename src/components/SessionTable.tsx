import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDateTime, formatInteger, formatSessionCost, formatTokens } from "../lib/format";
import type { SessionAggregate } from "../types";
import styles from "./Dashboard.module.css";

type SortKey = "project" | "model" | "endedAt" | "tokens" | "cost";

export function SessionTable({ sessions, limit }: { sessions: SessionAggregate[]; limit?: number }) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "endedAt", asc: false });
  const rows = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const values: Record<SortKey, [string | number, string | number]> = {
        project: [a.project, b.project], model: [a.model, b.model], endedAt: [a.endedAt, b.endedAt],
        tokens: [a.tokens.totalTokens, b.tokens.totalTokens], cost: [a.estimateMicrousd ?? -1, b.estimateMicrousd ?? -1]
      };
      const [left, right] = values[sort.key];
      return (typeof left === "number" ? left - Number(right) : String(left).localeCompare(String(right))) * (sort.asc ? 1 : -1);
    });
    return limit ? sorted.slice(0, limit) : sorted;
  }, [sessions, limit, sort]);

  const toggle = (key: SortKey) => setSort((current) => ({ key, asc: current.key === key ? !current.asc : true }));
  const icon = (key: SortKey) => sort.key !== key ? <ChevronsUpDown size={13} /> : sort.asc ? <ArrowUp size={13} /> : <ArrowDown size={13} />;
  const header = (key: SortKey, label: string) => <th scope="col" aria-sort={sort.key === key ? sort.asc ? "ascending" : "descending" : "none"} className={key === "tokens" || key === "cost" ? styles.numeric : undefined}><button className={styles.sortButton} onClick={() => toggle(key)}>{label}<span aria-hidden="true">{icon(key)}</span></button></th>;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr>{header("project", "專案")}{header("model", "模型")}<th>來源</th>{header("endedAt", "最後活動")}{header("tokens", "Tokens")}{header("cost", "估算成本")}</tr></thead>
        <tbody>
          {rows.map((session) => (
            <tr key={`${session.sourceId}:${session.sessionId}`}>
              <td><Link to={`/sessions/${encodeURIComponent(session.sourceId)}/${encodeURIComponent(session.sessionId)}`}>{session.project}</Link></td>
              <td>{session.model}</td><td className={styles.muted}>{session.sourceName}</td><td>{formatDateTime(session.endedAt)}</td>
              <td className={styles.numeric}>{formatInteger(session.tokens.totalTokens)}</td>
              <td className={styles.numeric}>
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
