# 開發指南

## 目錄

| 位置 | 內容 |
| --- | --- |
| `src/` | React 介面、型別、前端狀態與單元測試 |
| `src-tauri/src/` | Rust 解析、SQLite、價格、SSH 與雲端同步；遠端聚合腳本 |
| `src-tauri/fixtures/` | 人工測試紀錄與價格解析樣本 |
| `tests/` | Playwright 互動測試與原生 Windows 煙霧測試 |
| `scripts/` | 預覽、打包與資料庫檢查工具 |
| `supabase/migrations/` | 雲端資料表、RLS 與同步 RPC |
| `auth-callback/` | 選用的 Magic Link 登入回呼頁 |
| `.github/workflows/` | CI、打包與回呼頁部署 |
| `archive/` | 歷史研究筆記，不代表現行規格或待辦清單 |

## 建置與測試

環境需求見 [README](README.md)。Windows 使用專案本機工具時，先在命令提示字元執行 `call runtime-env.bat`；這只設定當前程序的工具路徑。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

- 前端測試涵蓋日期、篩選、同步佇列及 PGlite migrations／RLS／原子回滾。
- Rust 測試涵蓋解析、去重、估算、資料保留與跨語言聚合一致性；需要 Python 3 可從 PATH 執行。
- 瀏覽器測試使用 `dist/` 與範例資料，須先建置；不驗證真實 SSH 或 Supabase 登入。

`build.bat` 在 `%TEMP%` 暫存來源並建置 Windows 成品，Rust 中間產物位於 `%TEMP%/CodexUsageAnalytics-cargo-target`。建置或測試執行時不要清理這些目錄。

Windows 成品可執行隔離的原生煙霧測試：

```sh
node tests/native-smoke.mjs outputs/<成品目錄>/CodexUsageAnalytics.exe
```

腳本建立暫存資料庫與人工紀錄，關閉 SSH／雲端，檢查掃描、單日模型分布、設定、價格、視窗操作與重新啟動後的偏好。它需要 Node.js 22.16+ 或 24，並連線下載官方價格；不更改日常使用資料，也不等於安裝包、真實遠端或登入驗證。

## 版本控制與容量

提交原始碼、人工 fixtures、`pnpm-lock.yaml`、`src-tauri/Cargo.lock` 與建置設定。不要提交 `.env.local`、資料庫、SSH 金鑰、個人對話、安裝包或測試截圖。

| 目錄 | 用途與清理界線 |
| --- | --- |
| `work/` | 本機工具鏈與 Cargo 快取；先確認使用中的工具，不能整個刪除 |
| `node_modules/`、`.pnpm-store/` | 前端依賴與套件快取；刪除後需重新安裝，離線建置需要快取 |
| `outputs/` | 本機成品；保留目前使用版本，舊版移出 repo 封存 |
| `dist/`、`target/`、`src-tauri/gen/` | 可重建產物；先確認沒有建置或預覽程序使用 |
| `test-results/`、`playwright-report/`、`coverage/` | 測試產物，按需要保留證據後清理 |

以上目錄已由 `.gitignore` 排除，不會隨 Git push 上傳。只有檔案大小不足以判斷能否刪除；套件管理器也可能使用硬連結共享空間。App 的個人統計資料庫在作業系統的應用程式資料目錄，不屬於 repo 清理範圍。

## 提交與發佈

提交前檢查實際 diff、`git diff --check` 及與變更相符的測試。更新版本時同步調整 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 與 `CHANGELOG.md`。

推送 `app-v<版本>` tag 才會觸發跨平台 draft release。登入回呼需先將 GitHub Pages 的建置來源設為 GitHub Actions，再手動執行 `Deploy auth callback` workflow；雲端不是本機分析的必要條件。成品目前未簽章，發佈說明應明確區分實際通過的驗證與尚未驗證的流程。
