import { useEffect, useState } from "react";
import { getDesktopPreferences, saveDesktopPreferences, type DesktopPreferences } from "../lib/desktop";

export function DesktopSettings() {
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setMessage(null);
    try { setPreferences(await getDesktopPreferences()); }
    catch { setMessage({ kind: "error", text: "無法讀取啟動設定，請重試。" }); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const update = async (patch: Partial<DesktopPreferences>) => {
    if (!preferences || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      setPreferences(await saveDesktopPreferences({ ...preferences, ...patch }));
      setMessage({ kind: "success", text: "啟動與背景執行設定已保存。" });
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setSaving(false); }
  };

  const disabled = loading || saving || !preferences;
  return <section id="desktop-settings" className="settings-section" aria-labelledby="desktop-settings-title" aria-busy={loading || saving}>
    <h2 id="desktop-settings-title">啟動與背景執行</h2>
    <label className="toggle-row">
      <span><strong>開機時自動啟動</strong><small>登入電腦後在背景啟動，可從右下角系統匣開啟。</small></span>
      <input type="checkbox" aria-label="開機時自動啟動" disabled={disabled} checked={preferences?.launchAtStartup ?? false} onChange={event => void update({ launchAtStartup: event.target.checked })} />
    </label>
    <label className="toggle-row">
      <span><strong>關閉視窗後繼續執行</strong><small>縮至系統匣並持續更新資料；右鍵選單可結束程式。</small></span>
      <input type="checkbox" aria-label="關閉視窗後繼續執行" disabled={disabled} checked={preferences?.closeToTray ?? false} onChange={event => void update({ closeToTray: event.target.checked })} />
    </label>
    {loading ? <p className="inline-status" role="status">正在讀取啟動設定…</p> : !preferences && !message ? <p className="section-description">請在桌面版設定開機啟動與背景執行。</p> : null}
    {saving ? <p className="inline-status" role="status">正在保存啟動設定…</p> : null}
    {message ? <p className={`inline-status ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
    {!preferences && message ? <button className="secondary-button" disabled={loading} onClick={() => void load()}>重新讀取啟動設定</button> : null}
  </section>;
}
