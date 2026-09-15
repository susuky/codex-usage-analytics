import { ExternalLink, KeyRound, LoaderCircle, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { defaultPricingRules, getSettings, openPricingDocs, saveSettings, testSshSource } from "../lib/api";
import { useCloud } from "../lib/cloud";
import type { AppSettings, PricingRule, SshSourceConfig } from "../types";
import styles from "../components/Dashboard.module.css";

type StatusMessage = { kind: "success" | "error" | "pending"; text: string };
type PriceField = "inputUsdPerMillion" | "cachedUsdPerMillion" | "cacheWriteUsdPerMillion" | "outputUsdPerMillion" | "priorityMultiplier";
const cloneDefaults = () => defaultPricingRules.map((rule) => ({ ...rule }));
const priceFields: Array<{ field: PriceField; label: string; accessible: string }> = [
  { field: "inputUsdPerMillion", label: "Input", accessible: "input 價格" },
  { field: "cachedUsdPerMillion", label: "Cached input", accessible: "cached input 價格" },
  { field: "cacheWriteUsdPerMillion", label: "Cache writes", accessible: "cache writes 價格" },
  { field: "outputUsdPerMillion", label: "Output", accessible: "output 價格" },
  { field: "priorityMultiplier", label: "Priority 倍率", accessible: "Priority 倍率" }
];

export default function SettingsPage() {
  const { status, sendMagicLink, signOut, deleteCloudData } = useCloud();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [email, setEmail] = useState("");
  const [sshStatuses, setSshStatuses] = useState<Record<string, StatusMessage>>({});
  const [saveStatus, setSaveStatus] = useState<StatusMessage | null>(null);
  const [testingSsh, setTestingSsh] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { void getSettings().then((value) => setSettings({ ...value, sshSources: value.sshSources.map((source) => ({ ...source, codexHome: source.codexHome ?? "" })), pricingRules: value.pricingRules?.length ? value.pricingRules : cloneDefaults() })); }, []);
  if (!settings) return <div className="page-loading">載入設定…</div>;

  const save = async () => {
    setSaving(true);
    setSaveStatus({ kind: "pending", text: "正在保存並重算既有 Sessions…" });
    try {
      await saveSettings(settings);
      setSaveStatus({ kind: "success", text: "設定已保存，既有費用已重新計算" });
    } catch (cause) {
      setSaveStatus({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setSaving(false); }
  };

  const test = async (source: SshSourceConfig) => {
    setTestingSsh((current) => ({ ...current, [source.id]: true }));
    setSshStatuses((current) => ({ ...current, [source.id]: { kind: "pending", text: "正在連線並檢查遠端 sessions…" } }));
    try { const text = await testSshSource(source.target, source.codexHome); setSshStatuses((current) => ({ ...current, [source.id]: { kind: "success", text } })); }
    catch (cause) { setSshStatuses((current) => ({ ...current, [source.id]: { kind: "error", text: cause instanceof Error ? cause.message : String(cause) } })); }
    finally { setTestingSsh((current) => ({ ...current, [source.id]: false })); }
  };

  const login = async () => {
    try { await sendMagicLink(email); setSaveStatus({ kind: "success", text: "Magic Link 已寄出，請在同一台裝置開啟" }); }
    catch (cause) { setSaveStatus({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) }); }
  };

  const clearCloud = async () => {
    if (!window.confirm("清除所有雲端統計並暫停同步？本機紀錄會保留。")) return;
    try {
      await deleteCloudData();
      setSettings((current) => current ? {...current,cloudEnabled:false} : current);
      setSaveStatus({kind:"success",text:"雲端統計已清除，同步已暫停"});
    } catch (cause) { setSaveStatus({kind:"error",text:cause instanceof Error ? cause.message : String(cause)}); }
  };

  const updateRule = (index: number, patch: Partial<PricingRule>) => setSettings((current) => current ? { ...current, pricingRules: current.pricingRules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule) } : current);
  const updatePrice = (index: number, field: PriceField, value: string) => updateRule(index, { [field]: Math.max(0, Number(value) || 0) });
  const addRule = () => setSettings({ ...settings, pricingRules: [...settings.pricingRules, { model: "", inputUsdPerMillion: 0, cachedUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 0, cacheWriteMultiplier: 1.25, longContextThreshold: 272000, longInputMultiplier: 2, longOutputMultiplier: 1.5, priorityMultiplier: 2, sourceUrl: "", reviewedAt: new Date().toISOString().slice(0, 10) }] });
  const removeRule = (index: number) => setSettings({ ...settings, pricingRules: settings.pricingRules.filter((_, ruleIndex) => ruleIndex !== index) });
  const updateSsh = (index: number, patch: Partial<SshSourceConfig>) => setSettings({ ...settings, sshSources: settings.sshSources.map((source, sourceIndex) => sourceIndex === index ? { ...source, ...patch } : source) });
  const addSsh = () => setSettings({ ...settings, sshSources: [...settings.sshSources, { id: `ssh-${Date.now().toString(36)}`, name: `遠端 ${settings.sshSources.length + 1}`, target: "", codexHome: "", enabled: true }] });
  const removeSsh = (index: number) => setSettings({ ...settings, sshSources: settings.sshSources.filter((_, sourceIndex) => sourceIndex !== index) });
  const openPricing = async () => {
    try { await openPricingDocs(); setSaveStatus({ kind: "success", text: "已在預設瀏覽器開啟官方定價" }); }
    catch (cause) { setSaveStatus({ kind: "error", text: `無法開啟官方定價：${cause instanceof Error ? cause.message : String(cause)}` }); }
  };

  return <div className={styles.page}><PageHeader title="設定" subtitle="管理資料來源、雲端同步與估算價格" showDateFilter={false} /><div className={`${styles.content} settings-grid`}>
    <nav className="settings-navigation" aria-label="設定分類"><a href="#local-settings">本機</a><a href="#remote-settings">SSH 來源</a><a href="#cloud-settings">雲端同步</a><a href="#pricing-settings">模型價格</a></nav>
    <section id="local-settings" className="settings-section"><h2>本機 Codex</h2><p className="section-description">自動讀取這台電腦的使用紀錄，也可以指定其他資料夾。</p><label><span>資料夾路徑（選填）</span><input value={settings.codexHome} onChange={(event) => setSettings({ ...settings, codexHome: event.target.value })} placeholder="留空以自動偵測" /></label></section>
    <section id="remote-settings" className="settings-section"><div className="section-title-row"><div><h2>SSH 遠端來源</h2><p>新增 Windows、Linux 或 macOS 裝置，沿用現有 SSH 連線設定。</p></div><button className="secondary-button" onClick={addSsh}><Plus size={15} />新增主機</button></div><div className="ssh-source-editor">{settings.sshSources.map((source, index) => <article className="ssh-source-row" key={source.id}><label className="ssh-enabled"><input aria-label={`${source.name} 啟用`} type="checkbox" checked={source.enabled} onChange={(event) => updateSsh(index, { enabled: event.target.checked })} /><span>啟用</span></label><label><span>顯示名稱</span><input aria-label={`SSH 來源 ${index + 1} 名稱`} value={source.name} onChange={(event) => updateSsh(index, { name: event.target.value })} /></label><label><span>SSH Target</span><input aria-label={`${source.name} SSH Target`} value={source.target} placeholder="user@host" onChange={(event) => updateSsh(index, { target: event.target.value })} /></label><div className="ssh-source-actions"><button className="secondary-button" disabled={testingSsh[source.id] || !source.target} onClick={() => void test(source)}>{testingSsh[source.id] ? <LoaderCircle className={styles.spin} size={16} /> : <KeyRound size={16} />}{testingSsh[source.id] ? "測試中…" : "測試連線"}</button><button className="icon-danger-button" aria-label={`刪除 SSH 來源 ${source.name}`} onClick={() => removeSsh(index)}><Trash2 size={16} /></button></div><label className="ssh-home-field"><span>遠端 CODEX_HOME（選填）</span><input aria-label={`${source.name} 遠端 CODEX_HOME`} value={source.codexHome ?? ""} placeholder="留空以自動偵測" onChange={(event) => updateSsh(index, { codexHome: event.target.value })} /></label>{sshStatuses[source.id] ? <span className={`inline-status ${sshStatuses[source.id].kind}`} role="status">{sshStatuses[source.id].text}</span> : null}</article>)}</div></section>
    <section id="cloud-settings" className="settings-section"><h2>雲端同步</h2><p className="section-description">{status.configured ? "使用 Email 登入，跨裝置保留使用紀錄。" : "尚未設定雲端服務。本機與 SSH 分析不受影響。"}</p>{status.signedIn ? <div className="signed-row"><span>已登入 {status.email}</span><button className="secondary-button" onClick={() => void signOut()}>登出</button></div> : <div className="magic-row"><label><span className="field-label">Email</span><input aria-label="登入 Email" autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label><button className="primary-button" disabled={!email || !status.configured} onClick={() => void login()}>寄送 Magic Link</button></div>}<label className="toggle-row"><span><strong>同步去識別化統計</strong><small>不包含原始對話或完整路徑</small></span><input type="checkbox" checked={settings.cloudEnabled} onChange={(event) => setSettings({ ...settings, cloudEnabled: event.target.checked })} /></label><button className="danger-button" disabled={!status.signedIn} onClick={() => void clearCloud()}><Trash2 size={16} />清除雲端統計</button></section>
    <section id="pricing-settings" className="settings-section">
      <div className="section-title-row"><div><h2>API 等值價格</h2><p>美元／每百萬 Tokens · 儲存後會重新估算既有紀錄</p></div><div className="button-row"><button className="secondary-button" onClick={() => setSettings({ ...settings, pricingRules: cloneDefaults() })}><RotateCcw size={15} />還原預設</button><button className="secondary-button" onClick={addRule}><Plus size={15} />新增模型</button></div></div>
      <div className="pricing-cards">{settings.pricingRules.map((rule, index) => <div className="pricing-card" key={`${index}-${rule.reviewedAt}`}>
        <div className="pricing-card-heading"><label><span className="field-label">模型 ID</span><input aria-label={`模型 ${index + 1} ID`} value={rule.model} placeholder="例如 codex-auto-review" onChange={(event) => updateRule(index, { model: event.target.value })} /></label><button className="icon-danger-button" aria-label={`刪除 ${rule.model || `模型 ${index + 1}`}`} onClick={() => removeRule(index)}><X size={16} /></button></div>
        <div className="pricing-fields">{priceFields.map(({ field, label, accessible }) => <label key={field}><span>{label}</span><input aria-label={`${rule.model || `模型 ${index + 1}`} ${accessible}`} type="number" min="0" step={field === "priorityMultiplier" ? "0.1" : "0.01"} value={rule[field]} onChange={(event) => updatePrice(index, field, event.target.value)} /></label>)}</div>
      </div>)}</div>
      <button className="link-button" onClick={() => void openPricing()}>官方模型定價 <ExternalLink size={14} /></button><p className="footnote">快速模式依各模型的 Priority 倍率估算。價格可自行調整；所有金額皆為 API 等值估算，不代表 Codex 訂閱帳單。</p>
    </section>
    <div className="settings-footer"><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}{saving ? "保存中…" : "保存設定"}</button>{saveStatus ? <span className={`inline-status ${saveStatus.kind}`} role="status">{saveStatus.text}</span> : null}</div>
  </div></div>;
}
