# Codex 用量分析

在本機檢視 Codex 的 Token 用量、每日模型分布與 API 等值估算。桌面版使用 Tauri、React、TypeScript、Rust 與 SQLite，保存使用統計，不保存 prompt、回覆或工具輸出原文。

## 功能

- **用量總覽**：今日與區間 Tokens、快取率、每日組成與總量；點選日期可查看當天各模型用量與比例。
- **用量追查**：依日期、來源、專案、模型與估價狀態篩選 Sessions，查看每回合的模型、Thinking 與快速模式紀錄。
- **多台裝置**：讀取本機 `~/.codex/sessions`、`archived_sessions`，也能自行新增 SSH 來源；增量掃描並去重。
- **價格與偏好**：每日檢查官方價格、保留自訂價格，記住視窗、側欄及日期設定。
- **選用雲端同步**：設定 Supabase 並登入後，可同步去識別化統計。

金額是 **API 等值估算，不是 Codex 訂閱帳單**。未定價的用量會另外標示；Cached input 已包含在 Input、Reasoning 已包含在 Output，不重複計入。

## Windows 使用

需要 Windows 10／11 x64 與 Microsoft Edge WebView2 Runtime。

從原始碼建置時，先執行 `setup.bat` 準備依賴，再執行 `build.bat`。成品位於 `outputs/`：

| 檔案 | 用途 |
| --- | --- |
| `CodexUsageAnalytics-Setup.exe` | 安裝版，支援註冊登入回呼協定 |
| `CodexUsageAnalytics.exe` | 直接啟動，無命令視窗 |
| `CodexUsageAnalytics-Portable.zip` | 免安裝壓縮檔 |

目前 Windows 成品未簽章，可能出現 SmartScreen 警告。`start.bat` 是開發模式，會保留命令視窗。

## 資料來源與隱私

初次啟動只掃描本機。可在設定頁指定 `CODEX_HOME`、新增 SSH 主機與調整掃描間隔；預設每 15 分鐘更新，也可手動重新掃描。

SSH 沿用系統 OpenSSH、`~/.ssh/config`、`known_hosts` 與 ssh-agent，使用批次模式與嚴格主機金鑰驗證，不保存密碼或私鑰。遠端聚合後只傳統計。Linux 遠端需要 Python 3；Windows 遠端使用 PowerShell，並偵測可用的 WSL 紀錄。

官方價格更新只下載公開價目表，不傳送使用紀錄，也不需要 API Key。離線時保留上次價格；手動修改的費率不會被自動更新覆蓋。估算規則依模型與每次請求套用，缺少必要紀錄時不自行猜測。

雲端功能預設沒有服務連線。若要啟用，複製 `.env.example` 為 `.env.local`，填入自己的 Supabase 設定，部署 `supabase/migrations/` 並設定登入回呼。同步內容不含原始對話與完整路徑；免安裝版的協定註冊限制見 [使用說明](PORTABLE_README.txt)。

## 開發

需求：Node.js 22 或 24、pnpm 10+、Rust stable，以及各平台的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

```sh
pnpm install --frozen-lockfile
pnpm dev           # 瀏覽器預覽，使用範例資料
pnpm tauri dev     # 桌面開發模式，讀取實際來源
```

[開發指南](CONTRIBUTING.md) 包含目錄結構、測試與建置方式；[版本紀錄](CHANGELOG.md) 記錄使用者可見的變更。
