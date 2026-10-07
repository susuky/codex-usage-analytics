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
  await expect(page.getByRole("button", { name: "測試連線" })).toHaveCount(0);
  await page.getByRole("button", { name: "新增主機" }).click();
  await page.getByLabel("SSH 來源 1 名稱").fill("dev-server");
  await page.getByLabel("dev-server SSH Target").fill("user@dev-server");
  await page.getByRole("button", { name: "新增主機" }).click();
  await page.getByLabel("SSH 來源 2 名稱").fill("gpu-2");
  await page.getByLabel("gpu-2 SSH Target").fill("user@gpu-2");
  await page.getByLabel("gpu-2 遠端 CODEX_HOME").fill("/home/user/.codex-alt");
  await expect(page.getByLabel("dev-server SSH Target")).toHaveValue("user@dev-server");
  const firstSource = page.locator("article").filter({ has: page.getByLabel("dev-server SSH Target") });
  await page.getByRole("button", { name: "測試連線" }).first().click();
  await expect(firstSource.getByRole("status")).toContainText("請在桌面版測試遠端連線。");

  await page.getByRole("button", { name: "保存設定" }).click();
  await expect(page.getByText("設定已保存，既有費用已重新計算")).toBeVisible();
  await page.getByRole("button", { name: "新增自訂價格" }).click();
  const modelInput = page.getByPlaceholder("例如 my-model").last();
  await modelInput.fill("custom-review-model");
  await page.getByLabel("custom-review-model input 價格").fill("1.5");
  await page.getByLabel("custom-review-model cached input 價格").fill("0.15");
  await page.getByLabel("custom-review-model cache writes 價格").fill("1.88");
  await page.getByLabel("custom-review-model output 價格").fill("6");
  await page.getByRole("button", { name: "保存價格" }).click();
  await expect(page.getByText("custom-review-model 的價格已保存。")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("dev-server SSH Target")).toHaveValue("user@dev-server");
  await expect(page.getByLabel("gpu-2 SSH Target")).toHaveValue("user@gpu-2");
  await page.getByRole("button", { name: "編輯 custom-review-model 價格" }).click();
  await expect(page.locator('input[value="custom-review-model"]')).toBeVisible();
  await expect(page.getByLabel("custom-review-model output 價格")).toHaveValue("6");
});

test("sync page distinguishes scan time from latest source data and runs a full scan", async ({ page }) => {
  await page.goto("/sync");
  await expect(page.getByText(/資料最新至/).first()).toBeVisible();
  await page.getByRole("button", { name: "完整掃描所有來源" }).click();
  await expect(page.getByText("正在完整掃描本機與遠端來源，完成後會自動更新。")).toBeVisible();
  await expect(page.getByRole("button", { name: "完整掃描所有來源" })).toBeEnabled({ timeout: 10_000 });
});

test("remote sources appear only from saved settings and disappear when removed", async ({ page }) => {
  await page.goto("/sync");
  await expect(page.locator(".source-list article")).toHaveCount(1);
  await page.goto("/settings");
  await page.getByRole("button", { name: "新增主機" }).click();
  await page.getByLabel("SSH 來源 1 名稱").fill("Custom server");
  await page.getByLabel("Custom server SSH Target").fill("operator@custom-host");
  await page.getByRole("button", { name: "保存設定" }).click();
  await expect(page.getByText("設定已保存，既有費用已重新計算")).toBeVisible();
  await page.goto("/sync");
  await expect(page.locator(".source-list article")).toHaveCount(2);
  const remote = page.locator(".source-list article").filter({ hasText: "Custom server" });
  await expect(remote).toContainText("operator@custom-host");
  await expect(remote).toContainText("0 Sessions");
  await expect(remote).toContainText("尚無完整掃描紀錄");
  await page.goto("/settings");
  await page.getByRole("button", { name: "刪除 SSH 來源 Custom server" }).click();
  await page.getByRole("button", { name: "保存設定" }).click();
  await expect(page.getByText("設定已保存，既有費用已重新計算")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "測試連線" })).toHaveCount(0);
  await page.goto("/sync");
  await expect(page.locator(".source-list article")).toHaveCount(1);
});
