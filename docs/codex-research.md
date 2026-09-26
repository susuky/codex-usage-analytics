# Codex 用量分析：外部專案與改善方向

查核日期：2026-09-26。範圍限 Codex 的本機紀錄、分析工具與插件，未加入其他代理工具的資料來源。

## 值得參考的專案

| 專案 | 可借鏡的做法 | 本專案的取捨 |
|---|---|---|
| [douglasmonsky/codex-usage-tracker](https://github.com/douglasmonsky/codex-usage-tracker) | Codex 本機用量追蹤、增量讀取與 MCP 查詢；也提供插件安裝方式 | 優先補足來源完整度與可追查性。唯讀聚合 MCP 可列為後續功能，這次沒有安裝插件或額外啟動服務。 |
| [capisoft-lib/codex_usage](https://github.com/capisoft-lib/codex_usage) | 本機儀表板、專案／Session 篩選，以及用量、額度與估算的區分 | 採用可追查的篩選流程。該專案標示 AGPL-3.0-or-later，未複製其程式碼。 |
| [luyh7/codex-usage-dashboard](https://github.com/luyh7/codex-usage-dashboard/blob/main/README.md) | 以模型、思考程度、時間及對話檢視 Codex 使用情況 | 保留目前 JSONL 有記錄才顯示的原則；不從 reasoning tokens 猜思考程度，也不取得推理原文。 |

[OpenAI Codex issue #38989](https://github.com/openai/codex/issues/38989) 討論子代理的 token 用量增長。這是使用者回報，不能當作計費或額度倍率的官方依據；可用來規劃父子 Session 追查，但不能因此修改目前公式。

## 已放進本次變更

Sessions 加入模型與估算狀態篩選、分頁、全結果排序，以及返回明細前的列表狀態。總覽增加來源更新狀態與估價涵蓋率，模型名稱可進入相關紀錄。所有金額維持「API 等值估算」，沒有替未知模型猜價格。

模型篩選呼叫現有的逐回合查詢，不能只比較 Session 最後標記的模型。列表中的 token 與金額仍是整段對話累計；日期區間內的使用量要看總覽。兩者的範圍在介面上分別說明。

## 後續優先順序

1. **掃描完整度明細。** 在來源頁顯示本次新增、略過、失敗紀錄的數量與最近成功時間。以來源類型與能力處理，不為某台機器寫例外。
2. **未定價原因。** 區分缺少價格、模型未記錄、回合資訊不足；目前 UI 可以找出相關 Session，但還不能逐項說明缺價原因。
3. **子代理關聯。** 只有原始紀錄含明確父子識別時才建立關聯；加總仍按既有唯一鍵去重，不把父項累計與子項重複相加。
4. **唯讀聚合 MCP。** 若需要讓 Codex 查詢這個 App 的歷史，只提供篩選後的統計、來源時間與估價涵蓋率。不要新增原始對話、完整路徑或工具輸出的匯出端點。

以上是後續建議，不代表已實作。沒有安裝第三方用量插件、修改 SSH 設定，或上傳使用紀錄到上述專案。

## 本次 UI／UX 檢查方式

使用已安裝的 `ui-ux-pro-max` 決定元件與設計 tokens，沿用遠端 AGENTS 指定的 `frontend-craft`、`ux-audit`、`im-human`。保留深色石墨／薄荷綠與既有字體；新增資訊用精簡狀態列呈現，沒有加入漸層、外部字體或新元件套件。

`ux-writing` 與 `web-design-guidelines` 未安裝在這個環境，因此讀取公開原始指引執行文案及程式層檢查，沒有宣稱已安裝：

- [ux-writing 原始指引](https://github.com/content-designer/ux-writing-skill/blob/main/SKILL.md)
- [web-design-guidelines skill](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md) 與 [實際檢查清單](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md)

檢查包含欄位標籤、鍵盤操作、可見焦點、空結果復原、錯誤重試、數值對齊與窄視窗排版。前端測試使用範例資料；原生 SSH 掃描、Supabase 登入與安裝包仍需各自的端到端驗證。
