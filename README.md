# Codex 用量分析

以 Tauri v2、React、TypeScript、Rust 與 SQLite 製作的 local-first 桌面 App。它只保存 Codex session 的 token、模型、時間與專案聚合資料，不保存 prompt、回覆或工具輸出。

## 功能

- 掃描本機 `CODEX_HOME`（預設 `~/.codex`）的 `sessions` 與 `archived_sessions`。
- 支援多個 SSH 來源，透過系統 OpenSSH 以 `BatchMode=yes` 與嚴格 host-key 驗證讀取，不保存密碼或私鑰。
- SQLite checkpoint、active/archive 去重、容忍 JSONL 未完成末行。
- 總覽、趨勢、Sessions、模型、同步、設定與 Session 回合明細。
- 依每次請求的模式標記統計標準／快速模式，並分開顯示 ChatGPT 額度等值與 API Priority 等值估算。
- 可選 Supabase Magic Link／PKCE 同步；雲端識別碼均先以使用者 ID 加鹽做 SHA-256。
- 金額一律標示「API 等值估算」，不是 Codex 訂閱帳單。

## 開發

需求：Node.js 20+、pnpm 10+、Rust stable、系統 OpenSSH，以及各平台的 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

Windows 可直接雙擊 `setup.bat` 完成初始設定。`start.bat` 用於開發模式，因此會保留命令視窗；一般使用請雙擊 `build.bat` 產出安裝版 EXE、單檔 EXE 與免安裝 ZIP，再直接開啟 `CodexUsageAnalytics.exe`。正式版不會開啟 Terminal，成品會放在 `outputs`。

Windows 的 Rust 中間產物會放在 `%TEMP%\CodexUsageAnalytics-cargo-target`，避免 Documents 的受保護資料夾規則阻擋 Cargo build scripts；這個暫存目錄可以安全刪除並重新建置。

```bash
pnpm install
pnpm dev
pnpm test
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

App 啟動與每 15 分鐘排程採增量掃描；右上角重新掃描及同步頁的「完整掃描所有來源」會掃描本機與所有已啟用的 SSH 來源。同步頁分別顯示本次掃描時間與來源中最新的 Token 資料時間。

### 0.3.14 介面與操作改善

- 精簡標題列、側欄及摘要，突出今日 Tokens；側欄可實際收合與展開。
- 模型用量改為可展開的排序長條，直接顯示數量與比例；每日趨勢另提供數值表，零用量不畫成有用量。
- Session 表格支援鍵盤排序；日期視窗關閉後恢復焦點。
- 同步頁區分正常、待更新、需要處理與停用，問題詳情可展開，掃描按鈕置於來源區塊上方。
- 設定頁加入分類捷徑、完整欄位標籤與響應式價格卡片；保留既有資料與計價規則。

### 0.3.13 大型遠端掃描修正

- SSH 改為逐筆接收並以 Session 交易保存，完整歷史不再受整批 256 MiB 緩衝區限制；仍限制單筆記錄大小與連線時間。只傳統計，並啟用 SSH 傳輸壓縮。
- Windows 透過 UTF-8 script block 執行完整腳本，不再依賴 `PowerShell -Command -` 的空白行規則，確保最後的完成訊號送出。
- 個別來源完成後立即更新狀態；中途斷線保留已完成的 Session，下次重試仍去重。不完整或較短的紀錄不覆蓋完整歷史。
- 已收錄的完整舊副本安靜略過；只有新舊內容衝突、缺少歷史回合或不完整檔案才保留警告，不將正常 active/archive 去重誤報為讀取失敗。
- 三台來源各自串流寫入，使用短交易及 prepared statement；總覽逐回合聚合並使用一致的讀取快照，避免大量歷史全數載入記憶體。
- 回歸測試包含 260 MiB 串流、超大單筆拒絕、重複紀錄、斷線保留、三來源並行，以及與正式程式完全相同的 PowerShell 呼叫方式。

### 0.3.12 資料保護與同步

- Session、總覽與圖表共用去重後回合；累計計數器歸零不會清掉先前用量。沒有 `last_token_usage` 的累計增量保留為未分類、不計價。原有累計觀測另保留在 `legacy_session_totals`，升級不刪除對話或已匯入回合。
- 原檔刪除後保留 SQLite 統計；較短或缺少舊回合的重掃不會覆蓋歷史。不完整檔案會標示並重試，不推進成功時間。
- 本機 checkpoint 只保存路徑 SHA-256、大小、mtime，不保存原檔。Windows 遠端共用讀寫中的 JSONL；Linux 需 Python 3。只傳統計，不會因聚合失敗改傳整份對話。
- SSH 最多同時掃描三台，連線及遠端作業均有期限，逾時會停止程序並保留既有紀錄。
- 雲端待同步清單和確認版本保存在 SQLite；登入且啟用後自動同步，離線每分鐘重試，連線恢復或掃描完成也會重試。原始 Session UUID 的雜湊讓不同裝置匯入同一份 log 時可去重；下載的去識別化專案以雜湊縮寫顯示。
- 必須先部署全部 migrations，尤其 `202609050001_atomic_sync.sql`。新版透過原子 RPC 提交完整 Session；舊版直接寫入及 prune 已停用，請同步升級其他裝置。清除雲端會暫停所有裝置自動上傳，本機紀錄仍保留；重新啟用後按「立即同步」才恢復上傳。
- `build.bat` 從原始專案讀取 `.env.local`，不必把設定複製到暫存目錄；只有指定的公開環境設定可進入前端。

### 驗證

`pnpm test` 包含 React 延遲回應、持久同步佇列、敏感欄位白名單，以及使用 PGlite 執行實際 PostgreSQL migrations／RLS／原子回滾測試；`cargo test` 包含 Windows 共用讀取、Python／PowerShell／Rust 統計一致性、逾時及資料保留測試。Windows 需 Python 可從 PATH 執行。`pnpm test:e2e` 驗證瀏覽器互動；該模式使用範例資料，不代表原生 SSH 或 Supabase Auth 的端到端驗證。

## 定價說明

內建 GPT-5.3 Codex、GPT-5.4、GPT-5.5，以及 GPT-5.6 Sol、Terra、Luna 的 API 等值費率。快取寫入按 input 費率 1.25 倍，超過 272K input token 的回合套用長上下文倍率；output 已包含 reasoning，不重複計價。快速模式最高提升 1.5 倍速度，但 1.5 倍不是價格倍率：GPT-5.6 的 API Priority 等值預設按標準價格 2 倍估算；ChatGPT 額度等值則依官方快速模式規則，GPT-5.6／5.5 為 2.5 倍、GPT-5.4 為 2 倍。沒有官方模型對應的名稱仍顯示「無法估算」，也可在設定頁自訂價格。

模型頁與 Session 回合明細會顯示 JSONL 實際記錄的 Thinking 程度；舊紀錄沒有此欄位時顯示「未記錄」，不會根據 reasoning token 數量猜測。

## 發佈

`.github/workflows` 包含 Windows、macOS Intel／Apple Silicon 與 Linux 的 CI／draft release，以及 GitHub Pages 中介頁部署。Release workflow 需由版本 tag 觸發。
