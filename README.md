# Codex 用量分析

以 Tauri v2、React、TypeScript、Rust 與 SQLite 製作的 local-first 桌面 App。它只保存 Codex session 的 token、模型、時間與專案聚合資料，不保存 prompt、回覆或工具輸出。

## 功能

- 掃描本機 `CODEX_HOME`（預設 `~/.codex`）的 `sessions` 與 `archived_sessions`。
- 支援多個 SSH 來源，透過系統 OpenSSH 以 `BatchMode=yes` 與嚴格 host-key 驗證讀取，不保存密碼或私鑰。
- SQLite checkpoint、active/archive 去重、容忍 JSONL 未完成末行。
- 總覽、趨勢、Sessions、模型、同步、設定與 Session 回合明細。
- 自動記住視窗大小、位置、最大化、側欄與日期週期，自訂日期區間也會保留。
- 桌面版每日自動檢查 OpenAI 官方 API 價格，支援立即更新與手動價格；離線時沿用上次價格。
- 模型價格以完整價目表呈現，可依名稱、輸入、快取輸入或輸出價格排序，並直接搜尋全部模型。每列可編輯，價格與每日更新開關均可直接保存。
- 依每次請求的模式標記統計標準／快速模式，並分開顯示 ChatGPT 額度等值與 API Priority 等值估算。
- 可選 Supabase Magic Link／PKCE 同步；雲端識別碼均先以使用者 ID 加鹽做 SHA-256。
- 金額一律標示「API 等值估算」，不是 Codex 訂閱帳單。

## 開發

需求：Node.js 22+、pnpm 10+、Rust stable、系統 OpenSSH，以及各平台的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

Windows 可直接雙擊 `setup.bat` 完成初始設定。`start.bat` 用於開發模式，因此會保留命令視窗；一般使用請雙擊 `build.bat` 產出安裝版 EXE、單檔 EXE 與免安裝 ZIP，再直接開啟 `CodexUsageAnalytics.exe`。正式版不會開啟 Terminal，成品會放在 `outputs`。

Windows 的 Rust 中間產物會放在 `%TEMP%\CodexUsageAnalytics-cargo-target`，避免 Documents 的受保護資料夾規則阻擋 Cargo build scripts；這個暫存目錄可以安全刪除並重新建置。

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm tauri dev
```

桌面安裝包：

```bash
pnpm tauri build
```

第一版未簽章。Windows 可能顯示 SmartScreen，macOS 可能顯示 Gatekeeper 警告；請只安裝自己或可信 CI 產出的檔案。

## 設定

複製 `.env.example` 為 `.env.local`，填入 Supabase URL 與 publishable key。未設定或未登入時，本機與 SSH 分析仍可完整使用。資料庫 migration 位於 `supabase/migrations`；GitHub Pages 的 Magic Link 中介頁位於 `auth-callback`。

遠端預設使用 `user@example-server`，也可在設定頁新增多台主機。每個來源沿用 `~/.ssh/config`、`known_hosts` 與 ssh-agent；資料不在遠端使用者的 `~/.codex` 時，可個別指定遠端 `CODEX_HOME`。Windows 遠端也會偵測目前可用的 WSL Codex 資料。App 沒有略過 host-key 驗證的選項。

App 啟動時會增量掃描，之後依設定的間隔更新，預設為 15 分鐘；右上角重新掃描及同步頁的「完整掃描所有來源」會掃描本機與所有已啟用的 SSH 來源。同步頁分別顯示本次掃描時間與來源中最新的 Token 資料時間。

官方價格更新只下載公開的 [OpenAI 定價表](https://developers.openai.com/api/docs/pricing)，不傳送使用紀錄，也不需要 API Key。成功檢查後快取 24 小時；失敗後保留原有價格，最多每小時重試一次。使用者手動修改的模型價格會保留；在設定頁選擇「使用官方價格」並保存，可恢復自動更新該模型。未公布或目前無法完整換算的價格維持未定價，不能視為零費用。

## 驗證

`pnpm test` 包含 React 延遲回應、持久同步佇列、敏感欄位白名單，以及使用 PGlite 執行實際 PostgreSQL migrations／RLS／原子回滾測試；`cargo test` 包含 Windows 共用讀取、Python／PowerShell／Rust 統計一致性、逾時及資料保留測試。Windows 需 Python 可從 PATH 執行。`pnpm test:e2e` 驗證瀏覽器互動；該模式使用範例資料，不代表原生 SSH 或 Supabase Auth 的端到端驗證。

## 定價說明

內建 GPT-5.3 Codex、GPT-5.4、GPT-5.5，以及 GPT-5.6 Sol、Terra、Luna 的 API 等值費率，桌面版會自動更新官方價目表，包括 GPT-6 Astra 和 GPT-6.1 Sol。長 context 以單次請求的 input（含快取）判斷；依各模型門檻，對整筆請求的輸入、快取與輸出套用倍率，不以整段對話累計 Tokens 判斷。設定頁顯示一般單價、加價門檻及倍率，編輯時可預覽加價後單價；自訂模型預設不啟用長 context 加價。官方未提供的定價仍標為尚未定價，output 已包含 reasoning，不重複計價。快速模式的速度倍率與價格倍率不同：API 等值使用官方 Fast / Priority 價格，ChatGPT 額度等值則依其快速模式規則估算。

模型頁與 Session 回合明細會顯示 JSONL 實際記錄的 Thinking 程度；舊紀錄沒有此欄位時顯示「未記錄」，不會根據 reasoning token 數量猜測。

## 發佈

`.github/workflows` 包含 Windows、macOS Intel／Apple Silicon 與 Linux 的 CI／draft release，以及 GitHub Pages 中介頁部署。Release workflow 需由版本 tag 觸發。

## Repo 維護

原始碼、人工測試資料、lockfiles 與建置腳本納入 Git；安裝包、歷史截圖、工具快取及個人使用資料不納入 Git。`outputs/` 保留目前版本的成品，歷史產物移出 repo 保存，不影響 App 的統計資料庫。

- [版本紀錄](CHANGELOG.md)
- [目錄結構、開發測試與安全清理界線](CONTRIBUTING.md)
- [Codex 相關專案研究](docs/codex-research.md)

原生煙霧測試可使用 `node tests/native-smoke.mjs`，預設選取 `package.json` 對應版本的 EXE；它不等於安裝包、真實 SSH 或 Supabase 登入流程的驗證。
