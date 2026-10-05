import { ExternalLink, KeyRound, LoaderCircle, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PricingEditor } from "../components/PricingEditor";
import { useUsageData } from "../lib/data";
import { PageHeader } from "../components/PageHeader";
import { defaultPricingRules, getPricingStatus, getSettings, openPricingDocs, refreshPricing, saveSettings, testSshSource } from "../lib/api";
import { useCloud } from "../lib/cloud";
import type { AppSettings, PricingRule, PricingStatus, SshSourceConfig } from "../types";
import styles from "../components/Dashboard.module.css";

type StatusMessage = { kind: "success" | "error" | "pending"; text: string };
const cloneDefaults = () => defaultPricingRules.map((rule) => ({ ...rule }));
const generalSettingsKey = (settings: AppSettings) => JSON.stringify([settings.codexHome, settings.sshSources, settings.cloudEnabled]);

export default function SettingsPage() {
  const { data } = useUsageData();
  const { status, sendMagicLink, signOut, deleteCloudData } = useCloud();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [savedGeneral, setSavedGeneral] = useState("");
  const [email, setEmail] = useState("");
  const [sshStatuses, setSshStatuses] = useState<Record<string, StatusMessage>>({});
  const [saveStatus, setSaveStatus] = useState<StatusMessage | null>(null);
  const [testingSsh, setTestingSsh] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [pricingStatus, setPricingStatus] = useState<PricingStatus | null>(null);
  const [pricingMessage, setPricingMessage] = useState<StatusMessage | null>(null);
  const basePricing = useRef<PricingRule[]>([]);
  const pricingRequest = useRef(0);

  const loadPricing = useCallback(async () => {
    const request = ++pricingRequest.current;
    const [latest, status] = await Promise.all([getSettings(), getPricingStatus()]);
    if (request !== pricingRequest.current) return;
    basePricing.current = latest.pricingRules;
    setSavedGeneral(generalSettingsKey(latest));
    setPricingStatus(status);
    setSettings(current => current ? { ...current, pricingRules: latest.pricingRules } : latest);
  }, []);

  useEffect(() => {
    const load = () => { void loadPricing().catch(() => setSaveStatus({ kind: "error", text: "無法載入設定，請稍後重試。" })); };
    load();
    window.addEventListener("usage-pricing-updated", load);
    return () => window.removeEventListener("usage-pricing-updated", load);
  }, [loadPricing]);
  if (!settings) return <div className="page-loading" role="status">{saveStatus?.text ?? "載入設定…"}</div>;
  const hasGeneralChanges = generalSettingsKey(settings) !== savedGeneral;
  const saveFeedback = hasGeneralChanges && saveStatus?.text === "設定已保存，既有費用已重新計算" ? null : saveStatus;

  const save = async () => {
    setSaving(true);
    setSaveStatus({ kind: "pending", text: "正在保存並重算既有 Sessions…" });
    try {
      await saveSettings(settings, basePricing.current);
      await loadPricing();
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

  const updateSsh = (index: number, patch: Partial<SshSourceConfig>) => setSettings({ ...settings, sshSources: settings.sshSources.map((source, sourceIndex) => sourceIndex === index ? { ...source, ...patch } : source) });
  const addSsh = () => setSettings({ ...settings, sshSources: [...settings.sshSources, { id: `ssh-${Date.now().toString(36)}`, name: `遠端 ${settings.sshSources.length + 1}`, target: "", codexHome: "", enabled: true }] });
  const removeSsh = (index: number) => setSettings({ ...settings, sshSources: settings.sshSources.filter((_, sourceIndex) => sourceIndex !== index) });
  const openPricing = async () => {
    try { await openPricingDocs(); setSaveStatus({ kind: "success", text: "已在預設瀏覽器開啟官方定價" }); }
    catch (cause) { setSaveStatus({ kind: "error", text: `無法開啟官方定價：${cause instanceof Error ? cause.message : String(cause)}` }); }
  };
  const refreshPrices = async () => {
    setRefreshingPrices(true);
    setPricingMessage({ kind: "pending", text: "正在更新官方價格…" });
    try {
      await refreshPricing(true);
      await loadPricing();
      setPricingMessage({ kind: "success", text: "官方價格已更新，自訂價格已保留。" });
    } catch (cause) {
      setPricingMessage({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setRefreshingPrices(false); }
  };
  const savePrice = async (rule: PricingRule | null, original: PricingRule | null) => {
    setPricingBusy(true);
    try {
      const latest = await getSettings();
      const originalKey = original?.model.trim().toLowerCase();
      const nextKey = rule?.model.trim().toLowerCase();
      if (rule && latest.pricingRules.some(item => item.model.trim().toLowerCase() === nextKey && item.model.trim().toLowerCase() !== originalKey)) throw new Error("這個模型已經有價格，請編輯現有模型。");
      const pricingRules = latest.pricingRules.filter(item => item.model.trim().toLowerCase() !== originalKey);
      if (rule) pricingRules.push(rule);
      await saveSettings({ ...latest, pricingRules }, latest.pricingRules);
      await loadPricing();
    } finally { setPricingBusy(false); }
  };
  const toggleAutomaticPrices = async (enabled: boolean) => {
    setPricingBusy(true);
    setPricingMessage({ kind: "pending", text: "正在保存自動更新設定…" });
    try {
      const latest = await getSettings();
      await saveSettings({ ...latest, autoUpdatePricing: enabled }, latest.pricingRules);
      setSettings(current => current ? { ...current, autoUpdatePricing: enabled } : current);
      setPricingMessage({ kind: "success", text: enabled ? "已開啟每日自動更新。" : "已關閉自動更新。" });
      await loadPricing();
    } catch (cause) { setPricingMessage({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setPricingBusy(false); }
  };
  const officialRules = pricingStatus?.officialRules ?? cloneDefaults();
  const updatedLabel = pricingStatus?.updatedAt ? new Date(pricingStatus.updatedAt).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;

  return <div className={styles.page}><PageHeader title="設定" subtitle="管理資料來源、雲端同步與估算價格" showDateFilter={false} /><div className={`${styles.content} settings-grid`}>
    <nav className="settings-navigation" aria-label="設定分類"><a href="#local-settings">本機</a><a href="#remote-settings">SSH 來源</a><a href="#cloud-settings">雲端同步</a><a href="#pricing-settings">模型價格</a></nav>
    <section id="local-settings" className="settings-section"><h2>本機 Codex</h2><p className="section-description">自動讀取這台電腦的使用紀錄，也可以指定其他資料夾。</p><label><span>資料夾路徑（選填）</span><input value={settings.codexHome} onChange={(event) => setSettings({ ...settings, codexHome: event.target.value })} placeholder="留空以自動偵測" /></label></section>
    <section id="remote-settings" className="settings-section"><div className="section-title-row"><div><h2>SSH 遠端來源</h2><p>新增 Windows、Linux 或 macOS 裝置，沿用現有 SSH 連線設定。</p></div><button className="secondary-button" onClick={addSsh}><Plus size={15} />新增主機</button></div><div className="ssh-source-editor">{settings.sshSources.map((source, index) => <article className="ssh-source-row" key={source.id}><label className="ssh-enabled"><input aria-label={`${source.name} 啟用`} type="checkbox" checked={source.enabled} onChange={(event) => updateSsh(index, { enabled: event.target.checked })} /><span>啟用</span></label><label><span>顯示名稱</span><input aria-label={`SSH 來源 ${index + 1} 名稱`} value={source.name} onChange={(event) => updateSsh(index, { name: event.target.value })} /></label><label><span>SSH Target</span><input aria-label={`${source.name} SSH Target`} value={source.target} placeholder="user@host" onChange={(event) => updateSsh(index, { target: event.target.value })} /></label><div className="ssh-source-actions"><button className="secondary-button" disabled={testingSsh[source.id] || !source.target} onClick={() => void test(source)}>{testingSsh[source.id] ? <LoaderCircle className={styles.spin} size={16} /> : <KeyRound size={16} />}{testingSsh[source.id] ? "測試中…" : "測試連線"}</button><button className="icon-danger-button" aria-label={`刪除 SSH 來源 ${source.name}`} onClick={() => removeSsh(index)}><Trash2 size={16} /></button></div><label className="ssh-home-field"><span>遠端 CODEX_HOME（選填）</span><input aria-label={`${source.name} 遠端 CODEX_HOME`} value={source.codexHome ?? ""} placeholder="留空以自動偵測" onChange={(event) => updateSsh(index, { codexHome: event.target.value })} /></label>{sshStatuses[source.id] ? <span className={`inline-status ${sshStatuses[source.id].kind}`} role="status">{sshStatuses[source.id].text}</span> : null}</article>)}</div></section>
    <section id="cloud-settings" className="settings-section"><h2>雲端同步</h2><p className="section-description">{status.configured ? "使用 Email 登入，跨裝置保留使用紀錄。" : "尚未設定雲端服務。本機與 SSH 分析不受影響。"}</p>{status.signedIn ? <div className="signed-row"><span>已登入 {status.email}</span><button className="secondary-button" onClick={() => void signOut()}>登出</button></div> : <div className="magic-row"><label><span className="field-label">Email</span><input aria-label="登入 Email" autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label><button className="primary-button" disabled={!email || !status.configured} onClick={() => void login()}>寄送 Magic Link</button></div>}<label className="toggle-row"><span><strong>同步去識別化統計</strong><small>不包含原始對話或完整路徑</small></span><input type="checkbox" checked={settings.cloudEnabled} onChange={(event) => setSettings({ ...settings, cloudEnabled: event.target.checked })} /></label><button className="danger-button" disabled={!status.signedIn} onClick={() => void clearCloud()}><Trash2 size={16} />清除雲端統計</button></section>
    <div className="settings-footer"><div className="settings-save-summary" role="status" aria-atomic="true"><strong className={hasGeneralChanges ? "state-pending" : undefined}>{hasGeneralChanges ? "尚有變更未保存" : "來源與同步設定"}</strong><small>模型價格會個別保存</small></div>{saveFeedback ? <span className={`inline-status ${saveFeedback.kind}`} role="status">{saveFeedback.text}</span> : null}<button className="primary-button" disabled={saving || refreshingPrices || pricingBusy} onClick={() => void save()}>{saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}{saving ? "保存中…" : "保存設定"}</button></div>
    <section id="pricing-settings" className="settings-section">
      <div className="section-title-row pricing-title"><div><h2>API 等值價格</h2><p>美元／每百萬 Tokens · API 等值估算，非訂閱帳單</p></div><button className="secondary-button" disabled={refreshingPrices || saving || pricingBusy} onClick={() => void refreshPrices()}><RefreshCw size={15} className={refreshingPrices ? styles.spin : undefined} />{refreshingPrices ? "更新中…" : "更新官方價格"}</button></div>
      <div className="pricing-update-line">
        <label><input type="checkbox" aria-label="自動更新官方價格" disabled={pricingBusy || saving || refreshingPrices} checked={settings.autoUpdatePricing ?? true} onChange={event => void toggleAutomaticPrices(event.target.checked)} /><span>每日自動更新</span></label>
        <span>{updatedLabel ? `最近更新 ${updatedLabel}` : "尚未更新官方價格"}</span>
        <button className="link-button" onClick={() => void openPricing()}>官方定價 <ExternalLink size={13} aria-hidden="true" /></button>
      </div>
      {pricingMessage ? <p className={`inline-status pricing-feedback ${pricingMessage.kind}`} role="status">{pricingMessage.text}</p> : pricingStatus?.lastError ? <p className="inline-status pricing-feedback error" role="status">{pricingStatus.lastError}</p> : null}
      <PricingEditor rules={settings.pricingRules} officialRules={officialRules} usedModels={data?.models.map(model => model.model) ?? []} busy={pricingBusy || saving || refreshingPrices} onSave={savePrice} />
    </section>

  </div></div>;
}
