import { expect, test } from "@playwright/test";

test("dashboard navigation and session drill-down work", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "用量總覽" })).toBeVisible();
  await expect(page.getByText("API 等值估算").first()).toBeVisible();

  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "最後活動" })).toBeVisible();
  await page.locator("tbody a").first().click();
  await expect(page.getByRole("heading", { name: "每回合用量" })).toBeVisible();
});

test("sessions distinguish partial estimates from fully unpriced usage", async ({ page }) => {
  await page.goto("/sessions");
  const partialRow = page.getByRole("row").filter({ hasText: "alpha-api-service" }).first();
  await expect(partialRow).toContainText("（部分）");
  await expect(partialRow).toContainText("12.2K 未定價");
  const unpricedRow = page.getByRole("row").filter({ hasText: "codex-auto-review" }).first();
  await expect(unpricedRow).toContainText("無法估算");
});

test("seven-day view shows today usage and a complete daily axis", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("7");
  await expect(page.getByText("今日 Tokens", { exact: true })).toBeVisible();
  await expect(page.locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label")).toHaveCount(7);
  await expect(page.locator(".recharts-bar-rectangle").first()).toBeVisible();
});

test("calendar icon applies an inclusive custom date range", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto("/");
  const today = await page.evaluate(() => {
    const date = new Date();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  });

  await page.getByRole("button", { name: "選擇日期區間" }).click();
  await expect(page.getByRole("dialog", { name: "選擇日期區間" })).toBeVisible();
  await page.getByLabel("開始日期").fill(today);
  await page.getByLabel("結束日期").fill(today);
  await page.getByRole("button", { name: "套用" }).click();

  await expect(page.getByRole("dialog", { name: "選擇日期區間" })).toBeHidden();
  await expect(page.getByLabel("日期範圍")).toHaveValue("custom");
  await expect(page.locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label")).toHaveCount(1);

  await page.getByLabel("日期範圍").selectOption("7");
  await expect(page.getByLabel("日期範圍")).toHaveValue("7");
  await expect(page.locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label")).toHaveCount(7);
  expect(runtimeErrors).toEqual([]);
});

test("responsive layout keeps all primary navigation available", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主要導覽" })).toBeVisible();
  await expect(page.getByRole("link", { name: "設定" })).toBeVisible();
});

test("activity page reports skills plugins and reasoning effort", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "活動", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "使用過的 Skills" })).toBeVisible();
  await expect(page.getByText("openai-docs", { exact: true })).toBeVisible();
  await expect(page.getByText("medium", { exact: true })).toBeVisible();
  await expect(page.getByText("Reasoning tokens", { exact: true })).toBeVisible();
  await expect(page.getByText("快速模式請求", { exact: true })).toBeVisible();
  await expect(page.getByText(/1\.5 倍指最高速度提升/)).toBeVisible();
});

test("fast mode is tracked per turn and uses an editable Priority multiplier", async ({ page }) => {
  await page.goto("/sessions/local/00000000-0000-4000-9002-000000000000");
  await expect(page.getByText("快速模式請求", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "模式" })).toBeVisible();
  await expect(page.getByText("快速", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/API 等值已套用 Priority 倍率/)).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" }).click();
  await expect(page.getByLabel("gpt-5.6-sol Priority 倍率")).toHaveValue("2");
});

test("models show per-model Thinking records and official legacy pricing", async ({ page }) => {
  await page.goto("/models");
  await expect(page.getByRole("columnheader", { name: "Thinking" })).toBeVisible();
  const solRow = page.getByRole("row").filter({ hasText: "gpt-5.6-sol" });
  await expect(solRow.getByRole("cell").nth(2)).toContainText("max");
  await expect(page.getByText(/Thinking 來自每回合的實際設定/)).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: "編輯 gpt-5.5 價格" }).click();
  await expect(page.getByLabel("gpt-5.5 input 價格")).toHaveValue("5");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "編輯 gpt-5.4 價格" }).click();
  await expect(page.getByLabel("gpt-5.4 input 價格")).toHaveValue("2.5");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "編輯 gpt-5.3-codex 價格" }).click();
  await expect(page.getByLabel("gpt-5.3-codex input 價格")).toHaveValue("1.75");
});

test("browser preview identifies sample data and only offers working controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("範例資料", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "最小化視窗" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "最大化或還原視窗" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "關閉視窗" })).toHaveCount(0);
});
