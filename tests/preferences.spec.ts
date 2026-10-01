import { expect, test } from "@playwright/test";

test("date presets, custom ranges and the sidebar survive reopening", async ({ page, context }) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("30");
  await page.getByRole("button", { name: "收合側欄" }).click();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByLabel("日期範圍")).toHaveValue("30");
  await expect(reopened.getByRole("button", { name: "展開側欄" })).toBeVisible();
  await reopened.getByRole("button", { name: "選擇日期區間" }).click();
  await reopened.getByLabel("開始日期").fill("2026-09-01");
  await reopened.getByLabel("結束日期").fill("2026-09-03");
  await reopened.getByRole("button", { name: "套用", exact: true }).click();
  await reopened.reload();
  await expect(reopened.getByLabel("日期範圍")).toHaveValue("custom");
  await reopened.getByRole("button", { name: "選擇日期區間" }).click();
  await expect(reopened.getByLabel("開始日期")).toHaveValue("2026-09-01");
  await expect(reopened.getByLabel("結束日期")).toHaveValue("2026-09-03");
  await reopened.getByRole("button", { name: "取消", exact: true }).click();
  await reopened.getByLabel("日期範圍").selectOption("7");
  await reopened.reload();
  await expect(reopened.getByLabel("日期範圍")).toHaveValue("7");
});

test("overview places source and pricing status below the charts", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  for (const width of [1536, 1024, 390]) {
    await page.setViewportSize({ width, height: 1024 });
    await page.goto("/");
    await page.getByLabel("日期範圍").selectOption("30");
    const chart = await page.locator(".main-chart").boundingBox();
    const health = await page.getByRole("region", { name: "資料與估算狀態" }).boundingBox();
    expect(health!.y).toBeGreaterThanOrEqual(chart!.y + chart!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`overview-${width}.png`) });
  }
  expect(errors).toEqual([]);
});

test("pricing changes and automatic update preferences save at the point of action", async ({ page }) => {
  await page.goto("/settings");
  const autoUpdate = page.getByRole("checkbox", { name: "自動更新官方價格" });
  await expect(autoUpdate).toBeChecked();
  await autoUpdate.uncheck();
  await expect(page.getByText("已關閉自動更新。")).toBeVisible();
  await page.getByLabel("搜尋模型價格").fill("gpt-5.6-sol");
  await expect(page.locator(".pricing-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" }).click();
  await page.getByLabel("gpt-5.6-sol input 價格").fill("9");
  await page.getByRole("button", { name: "保存價格" }).click();
  await expect(page.getByText("gpt-5.6-sol 的價格已保存。")).toBeVisible();
  await page.reload();
  await expect(autoUpdate).not.toBeChecked();
  await page.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" }).click();
  await expect(page.getByLabel("gpt-5.6-sol input 價格")).toHaveValue("9");
  await page.getByRole("button", { name: "使用官方價格與加價規則", exact: true }).click();
  await expect(page.getByLabel("gpt-5.6-sol input 價格")).toHaveValue("4");
  await page.getByRole("button", { name: "保存價格" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "更新官方價格", exact: true }).click();
  await expect(page.getByText("請在桌面版更新官方價格。")).toBeVisible();
});
