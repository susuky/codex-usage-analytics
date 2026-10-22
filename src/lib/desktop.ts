import { invoke } from "@tauri-apps/api/core";

export type DesktopPreferences = { launchAtStartup: boolean; closeToTray: boolean };

export async function getDesktopPreferences(): Promise<DesktopPreferences | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  return invoke<DesktopPreferences>("get_desktop_preferences");
}

export async function saveDesktopPreferences(preferences: DesktopPreferences): Promise<DesktopPreferences> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("請在桌面版設定開機啟動與背景執行。");
  return invoke<DesktopPreferences>("save_desktop_preferences", { preferences });
}
