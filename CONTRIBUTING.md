# 開發指南

## 原始碼結構

| 位置 | 內容 |
| --- | --- |
| `src/` | React 介面、共用型別、前端狀態與單元測試 |
| `src-tauri/src/` | Rust 解析、SQLite、價格、SSH 與雲端同步；遠端 Python／PowerShell 聚合腳本 |
| `src-tauri/fixtures/` | 人工製作的測試紀錄，不是個人對話 |
| `tests/` | Playwright 互動測試與原生 Windows 煙霧測試 |
| `scripts/` | 預覽伺服器、打包與資料庫檢查工具 |
| `supabase/migrations/` | 資料表、RLS 與同步 RPC |
| `auth-callback/` | GitHub Pages 登入回呼頁 |
| `.github/workflows/` | CI、打包與回呼頁部署 |
| `docs/` | 研究與補充文件 |

`pnpm-lock.yaml` 與 `src-tauri/Cargo.lock` 都需要提交。不要把自己機器上的 `.env.local`、SQLite、SSH 金鑰、原始對話或安裝包加入版本控制。

## 建置環境

使用 Node.js 22 或 24、pnpm 10+、Rust stable、Python 3 與平台所需的 Tauri 工具。原生煙霧測試使用 `node:sqlite`，需要 Node.js 22.16+ 或 24。Windows 的 `setup.bat` 可準備 Node、pnpm、Rust 與前端依賴；MSVC C++ Build Tools 和 WebView2 仍須安裝。

```sh
pnpm install --frozen-lockfile
pnpm build
```

Windows 若使用專案本機工具，請先在命令提示字元執行 `call runtime-env.bat`。它只設定當前程序的工具路徑；不要直接搬走 `work/cargo`、`work/rustup` 或目前啟用的 pnpm store。

`start.bat` 啟動桌面開發模式；`build.bat` 產生正式成品。後者會先複製來源到 `%TEMP%` 建置，Rust 中間產物放在 `%TEMP%/CodexUsageAnalytics-cargo-target`，避免受保護的 Documents 資料夾阻擋編譯。不要在 build 或測試執行期間清理這些目錄。

## 驗證

```sh
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

- 前端測試涵蓋日期、篩選、狀態、同步佇列，並以 PGlite 執行 migrations／RLS／原子回滾測試。
- Rust 測試涵蓋解析、去重、費用、資料保留，以及 Python／PowerShell 與 Rust 聚合結果的一致性。
- 瀏覽器互動測試使用範例資料，需先建置 `dist/`。它不會驗證真實 SSH 主機或 Supabase Auth。

Windows 打包完成後，可另外執行隔離的原生測試：

```sh
node tests/native-smoke.mjs
# 也可以指定要測試的成品：
node tests/native-smoke.mjs outputs/v0.3.21/CodexUsageAnalytics.exe
```

未指定 EXE 時，腳本會從 `package.json` 讀取版本並使用 `outputs/v<版本>/CodexUsageAnalytics.exe`，不固定指向舊版。測試建立暫存資料庫、視窗狀態與人工紀錄，關閉 SSH／雲端；不更改日常使用的統計資料。它檢查視窗按鈕、掃描去重、日期、重新計價、官方價格下載與 Session 明細，並重新啟動兩次驗證視窗大小、最大化、側欄與日期偏好。此測試需要連線到官方定價網站，不等於安裝包、真實遠端或登入流程驗證。

## Repo 與本機產物的界線

| 位置 | 是否提交 | 清理注意事項 |
| --- | --- | --- |
| `src/`、`src-tauri/src/`、fixtures、設定與 lockfiles | 是 | 不當成暫存檔清除 |
| `outputs/` | 否 | 保留目前可用版本；舊版先移出 repo，確認不再使用後才刪除 |
| `dist/`、`src-tauri/target/`、`test-results/`、`playwright-report/` | 否 | 可重建；先確認沒有 build、測試或預覽伺服器正在使用 |
| `node_modules/`、`.pnpm-store/` | 否 | 依賴與快取，不是原始碼；刪除後需重新安裝 |
| `work/` | 否 | 可能包含實際使用中的 Rust／Node 工具，不能整個盲刪 |
| 個人 Codex 原始紀錄、App 的統計資料庫 | 否 | 不屬於 repo 清理範圍 |

`.gitignore` 已排除本機資料、金鑰、安裝包、壓縮檔與一般 JSONL；僅允許 `src-tauri/fixtures/` 內的人工 JSONL。不要用 `git add -f` 繞過這些保護。

## 提交與發佈

提交前檢查 `git status`、`git diff --check` 和測試結果。版本變更時同步更新 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 與 `src-tauri/tauri.conf.json`，並更新 `CHANGELOG.md`。

推送 `app-v<版本>` tag 才會觸發跨平台 draft release。Windows 成品目前未簽章；不要將成功打包描述成通過 SmartScreen、安裝、SSH 或 Supabase 登入驗證。發布前必須分別記錄實際測過的流程與未驗證範圍。
