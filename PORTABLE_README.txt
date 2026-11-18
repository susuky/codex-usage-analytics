Codex Usage Analytics - Portable
================================

Double-click CodexUsageAnalytics.exe to start the app. It runs without opening
a Terminal window.

Requirements:
- Windows 10/11 x64
- Microsoft Edge WebView2 Runtime
- System OpenSSH for remote scanning
- Host keys for enabled SSH sources present in the current user's known_hosts

This portable build does not install files or register an uninstaller.
Application statistics remain in the standard per-user Tauri application-data
directory so upgrades do not erase usage history.

Supabase Magic Link deep-link callbacks require the installed version because
the codex-usage:// protocol must be registered with Windows. Local and SSH
analytics work normally in the portable build.

更新免安裝版：
- 從 0.3.22 起，在「設定 → 程式更新」選擇新版的 CodexUsageAnalytics.exe。
- 程式會在原位置完成更新並重新啟動；開機啟動設定和使用紀錄會保留。
- 從沒有更新按鈕的舊版升級時，先從系統匣結束舊程式，再以新版 EXE 覆蓋原位置的同名檔案。

Multiple SSH sources and an optional per-source remote CODEX_HOME can be
configured in Settings. Manual rescan checks local data and every enabled SSH
source.

This build is unsigned. Windows SmartScreen may display a warning.
