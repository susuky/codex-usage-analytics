import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useUsageData } from "../lib/data";
import { cacheRate, formatCost, formatInteger, formatTokens } from "../lib/format";
import type { ModelUsage, NamedCount } from "../types";
import styles from "../components/Dashboard.module.css";

function EffortDistribution({ efforts, unrecorded }: { efforts: NamedCount[]; unrecorded: number }) {
  if (!efforts.length) return <span className={styles.muted}>未記錄</span>;
  const visible = efforts.slice(0, 3);
  return (
    <div className={styles.effortCell}>
      {visible.map((item) => <span className={styles.effortBadge} key={item.name}>{item.name}<b>{formatInteger(item.count)}</b></span>)}
      {efforts.length > visible.length ? <small>+{efforts.length - visible.length} 種</small> : null}
      {unrecorded > 0 ? <small title={`${formatInteger(unrecorded)} 次沒有 Thinking 紀錄`}>另有 {formatInteger(unrecorded)} 次未記錄</small> : null}
    </div>
  );
}

function CostEstimate({ model }: { model: ModelUsage }) {
  if (model.estimateMicrousd === null) {
    return <div className={styles.costCell}><span className={styles.muted}>無法估算</span><small>{formatTokens(model.unpricedTokens)} 未定價</small></div>;
  }
  return (
    <div className={styles.costCell}>
      <span>{formatCost(model.estimateMicrousd)}</span>
      {model.unpricedRequests > 0 ? <small>部分估算 · {formatTokens(model.unpricedTokens)} 未定價</small> : null}
    </div>
  );
}

export default function ModelsPage() {
  const { data, loading, error, reload } = useUsageData();
  return (
    <div className={styles.page}>
      <PageHeader title="模型" subtitle="比較 token 組成、Thinking、快取效率、快速模式與 API 等值估算" />
      <div className={styles.content}>
        {loading && !data ? <div className="page-loading" role="status">正在載入模型用量…</div> : error && !data ? <div className={styles.empty}>
          <h2>暫時無法顯示模型用量</h2><p>請重新載入，或查看資料來源的更新狀態。</p><button className="secondary-button" onClick={() => void reload()}>重新載入</button>
        </div> : !data?.models.length ? <div className={styles.empty}>
          <h2>此區間尚無模型用量</h2><p>請調整上方的日期區間，或確認資料來源已完成掃描。</p><Link className={styles.textLink} to="/sync">查看資料來源</Link>
        </div> : <>
        <section className={styles.tablePanel}>
          <h2 className={styles.tableTitle}>模型比較</h2>
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="模型用量比較">
            <table className={`${styles.table} ${styles.modelTable}`}>
              <thead><tr><th>模型</th><th>Sessions</th><th>Thinking</th><th>快速請求</th><th>快速 Tokens</th><th>Input</th><th>Cached input</th><th>Cache writes</th><th>Output</th><th>Reasoning</th><th>快取率</th><th>API 等值估算</th></tr></thead>
              <tbody>{data.models.map((item) => <tr key={item.model}><td><Link to={`/sessions?model=${encodeURIComponent(item.model)}`} aria-label={`查看 ${item.model} 的 Sessions`}>{item.model}</Link></td><td>{item.sessions}</td><td><EffortDistribution efforts={item.reasoningEfforts} unrecorded={item.unrecordedEffortRequests} /></td><td>{formatInteger(item.fastRequests)}</td><td>{formatInteger(item.fastTokens)}</td><td>{formatInteger(item.tokens.inputTokens)}</td><td>{formatInteger(item.tokens.cachedInputTokens)}</td><td>{formatInteger(item.tokens.cacheWriteInputTokens)}</td><td>{formatInteger(item.tokens.outputTokens)}</td><td>{formatInteger(item.tokens.reasoningOutputTokens)}</td><td className={styles.accent}>{cacheRate(item.tokens).toFixed(1)}%</td><td><CostEstimate model={item} /></td></tr>)}</tbody>
            </table>
          </div>
        </section>
        <p className="footnote">Thinking 來自每回合的實際設定；舊紀錄缺少標記時顯示「未記錄」，不會自行推測。估價缺少 token 拆分時會顯示部分估算。Reasoning tokens 已包含於 Output，不會重複計價。</p>
        </>}
      </div>
    </div>
  );
}
