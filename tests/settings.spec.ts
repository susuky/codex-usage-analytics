import { expect, test } from "@playwright/test";

test("overview explains activity and deduplicated token totals", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "用量總覽" })).toBeVisible();
  await expect(page.getByText("區間 Tokens", { exact: true })).toBeVisible();
  await expect(page.getByText(/不會重複計入總量/).first()).toBeVisible();
  await expect(page.getByLabel("日期範圍")).toHaveValue("365");
});

test("multiple SSH sources test independently and custom pricing survives save", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "新增主機" }).click();
  await page.getByLabel("SSH 來源 2 名稱").fill("gpu-2");
  await page.getByLabel("gpu-2 SSH Target").fill("user@gpu-2");
  await page.getByLabel("gpu-2 遠端 CODEX_HOME").fill("/home/user/.codex-alt");
  await expect(page.getByLabel("example-server SSH Target")).toHaveValue("user@example-server");
  const ll1Source = page.locator("article").filter({ has: page.getByLabel("example-server SSH Target") });
  await page.getByRole("button", { name: "測試連線" }).first().click();
  await expect(ll1Source.getByRole("status")).toContainText("請在桌面版測試遠端連線。");

  await page.getByRole("button", { name: "保存設定" }).click();
  await expect(page.getByText("設定已保存，既有費用已重新計算")).toBeVisible();
  await page.getByRole("button", { name: "新增自訂價格" }).click();
  const modelInput = page.getByPlaceholder("例如 codex-auto-review").last();
  await modelInput.fill("codex-auto-review");
  await page.getByLabel("codex-auto-review input 價格").fill("1.5");
  await page.getByLabel("codex-auto-review cached input 價格").fill("0.15");
  await page.getByLabel("codex-auto-review cache writes 價格").fill("1.88");
  await page.getByLabel("codex-auto-review output 價格").fill("6");
  await page.getByRole("button", { name: "保存價格" }).click();
  await expect(page.getByText("codex-auto-review 的價格已保存。")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "編輯 codex-auto-review 價格" }).click();
  await expect(page.locator('input[value="codex-auto-review"]')).toBeVisible();
  await expect(page.getByLabel("codex-auto-review output 價格")).toHaveValue("6");
});

test("sync page distinguishes scan time from latest source data and runs a full scan", async ({ page }) => {
  await page.goto("/sync");
  await expect(page.getByText(/資料最新至/).first()).toBeVisible();
  await page.getByRole("button", { name: "完整掃描所有來源" }).click();
  await expect(page.getByText("正在完整掃描本機與遠端來源，完成後會自動更新。")).toBeVisible();
  await expect(page.getByRole("button", { name: "完整掃描所有來源" })).toBeEnabled({ timeout: 10_000 });
});
