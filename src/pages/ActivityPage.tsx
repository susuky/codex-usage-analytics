import { BrainCircuit, Cable, Gauge, Sparkles, Wrench, Zap } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { useUsageData } from "../lib/data";
import { formatInteger, formatTokens } from "../lib/format";
import type { NamedCount } from "../types";
import styles from "../components/Dashboard.module.css";

function Ranking({ title, icon: Icon, items, empty }: { title: string; icon: typeof Wrench; items: NamedCount[]; empty: string }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return <section className="activity-panel"><h2><Icon size={18} />{title}</h2>{items.length ? <div className="activity-ranking">{items.map((item) => <div className="activity-row" key={item.name}><span title={item.name}>{item.name}</span><div><i style={{ width: `${Math.max(3, item.count / max * 100)}%` }} /></div><strong>{formatInteger(item.count)}</strong></div>)}</div> : <p className="activity-empty">{empty}</p>}</section>;
}

export default function ActivityPage() {
  const { data } = useUsageData();
  const activity = data?.activity;
  const effortTotal = activity?.efforts.reduce((sum, item) => sum + item.count, 0) ?? 0;
  return <div className={styles.page}><PageHeader title="活動" subtitle="Skills、Plugins、思考程度與快速模式" /><div className={styles.content}>
    <section className="activity-summary"><div><Sparkles size={19} /><span>Skill 使用</span><strong>{formatInteger(activity?.skills.reduce((sum, item) => sum + item.count, 0) ?? 0)}</strong></div><div><Cable size={19} /><span>Plugin 活動</span><strong>{formatInteger(activity?.plugins.reduce((sum, item) => sum + item.count, 0) ?? 0)}</strong></div><div><BrainCircuit size={19} /><span>有 effort 的回合</span><strong>{formatInteger(effortTotal)}</strong></div><div><BrainCircuit size={19} /><span>Reasoning tokens</span><strong>{formatTokens(activity?.reasoningTokens ?? 0)}</strong></div><div><Zap size={19} /><span>快速模式請求</span><strong>{formatInteger(activity?.fastRequests ?? 0)}</strong></div><div><Gauge size={19} /><span>快速模式 Tokens</span><strong>{formatTokens(activity?.fastTokens ?? 0)}</strong></div></section>
    <div className="activity-grid"><Ranking title="使用過的 Skills" icon={Sparkles} items={activity?.skills ?? []} empty="目前尚未辨識到 Skill 使用紀錄" /><Ranking title="Plugin 活動" icon={Cable} items={activity?.plugins ?? []} empty="目前尚未辨識到 Plugin 活動" /><Ranking title="思考程度" icon={BrainCircuit} items={activity?.efforts ?? []} empty="舊 Session 可能沒有思考程度紀錄" /><Ranking title="速度模式" icon={Zap} items={activity?.serviceTiers ?? []} empty="目前尚未辨識到速度模式" /><section className="activity-panel fast-mode-panel"><h2><Gauge size={18} />快速模式額度</h2><strong>{(activity?.weightedUsageRequests ?? 0).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}</strong><span>標準請求等值</span><p>GPT-5.6／5.5 的快速模式按 2.5 倍額度計，GPT-5.4 按 2 倍計。1.5 倍指最高速度提升，不是用量倍率。</p></section><section className="activity-panel activity-note"><h2><Wrench size={18} />統計口徑</h2><p>Skills、Plugins 與思考程度只保存名稱和次數；快速模式依每次請求留下的模式標記統計。</p><p>Reasoning tokens 是輸出 token 組成，不代表模型思考內容、品質或實際耗時。沒有明確標記的舊紀錄不會推測。</p></section></div>
  </div></div>;
}
