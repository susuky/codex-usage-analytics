import { expect, test } from "@playwright/test";

test("custom range menu opens, cancels, applies and reopens the date picker", async ({ page }, testInfo) => {
  await page.goto("/");
  const range = page.getByLabel("日期範圍");
  await range.selectOption("30");
  const metric = page.getByText("區間 Tokens", { exact: true }).locator("..");
  const before = await metric.textContent();
  await expect(range.getByRole("option", { name: "自訂區間", exact: true })).toBeEnabled();
  await range.selectOption({ label: "自訂區間" });
  await expect(page.getByLabel("開始日期")).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("custom-range.png") });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(range).toBeFocused();
  await expect(range).toHaveValue("30");
  await expect(metric).toHaveText(before ?? "");
  await range.selectOption({ label: "自訂區間" });
  await page.getByLabel("開始日期").fill("2025-01-01");
  await page.getByLabel("結束日期").fill("2025-01-03");
  await page.getByRole("button", { name: "套用", exact: true }).click();
  await expect(range).toHaveValue("custom");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await range.selectOption({ label: "自訂區間" });
  await expect(page.getByLabel("開始日期")).toHaveValue("2025-01-01");
  await expect(page.getByLabel("結束日期")).toHaveValue("2025-01-03");
  await page.keyboard.press("Escape");
  await expect(range).toBeFocused();
  await range.selectOption("7");
  await expect(range).toHaveValue("7");
});

test("trends retain zero-usage days in preset and custom ranges", async ({ page }) => {
  await page.goto("/trends");
  await page.getByLabel("日期範圍").selectOption("7");
  const ticks = page.locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-label");
  await expect(ticks).toHaveCount(7);
  await page.getByRole("button", { name: "API 等值估算", exact: true }).click();
  await expect(ticks).toHaveCount(7);
  await page.getByLabel("日期範圍").selectOption({ label: "自訂區間" });
  await page.getByLabel("開始日期").fill("2020-01-01");
  await page.getByLabel("結束日期").fill("2020-01-03");
  await page.getByRole("button", { name: "套用", exact: true }).click();
  await expect(ticks).toHaveCount(3);
  await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(ticks).toHaveCount(3);
});

test("sidebar collapse works with keyboard and persists across navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto("/");
  const before = await page.locator("aside").first().boundingBox();
  await page.getByRole("button", { name: "收合側欄" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "展開側欄" })).toHaveAttribute("aria-expanded", "false");
  expect((await page.locator("aside").first().boundingBox())!.width).toBeLessThan(before!.width);
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expect(page.getByRole("button", { name: "展開側欄" })).toBeVisible();
  await page.getByRole("button", { name: "展開側欄" }).click();
  await expect(page.getByRole("button", { name: "收合側欄" })).toHaveAttribute("aria-expanded", "true");
});

test("calendar dismiss restores focus and table sort is keyboard accessible", async ({ page }) => {
  await page.goto("/");
  const calendar = page.getByRole("button", { name: "選擇日期區間" });
  await calendar.click();
  await expect(page.getByLabel("開始日期")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(calendar).toBeFocused();
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  const tokens = page.getByRole("columnheader", { name: "Tokens", exact: true });
  await tokens.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(tokens).toHaveAttribute("aria-sort", "ascending");
  const values = await page.locator("tbody tr td:nth-child(5)").allTextContents();
  const parsed = values.map(value => Number(value.replaceAll(",", "")));
  expect(parsed).toEqual([...parsed].sort((a, b) => a - b));
  await page.keyboard.press("Space");
  await expect(tokens).toHaveAttribute("aria-sort", "descending");
});

test("daily table exposes exact values and can be dismissed", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("7");
  await page.getByRole("button", { name: "查看每日明細" }).click();
  await expect(page.locator("#daily-usage-table tbody tr")).toHaveCount(7);
  await expect(page.locator("#daily-usage-table").getByRole("columnheader", { name: "Cache writes" })).toBeVisible();
  await page.getByRole("button", { name: "收合每日明細" }).click();
  await expect(page.locator("#daily-usage-table")).toHaveCount(0);
  await page.getByRole("link", { name: "查看模型比較" }).click();
  await expect(page.getByRole("heading", { name: "模型比較" })).toBeVisible();
});

test("a zero-usage day has no visible bars", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "選擇日期區間" }).click();
  await page.getByLabel("開始日期").fill("2020-01-01");
  await page.getByLabel("結束日期").fill("2020-01-01");
  await page.getByRole("button", { name: "套用", exact: true }).click();
  await expect(page.getByText("此區間尚無模型用量")).toBeVisible();
  const heights = await page.locator(".recharts-bar-rectangle path").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  expect(heights.every(height => height === 0)).toBe(true);
});

test("settings navigation keeps labeled pricing fields inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/settings");
  await expect(page.getByLabel("日期範圍")).toHaveCount(0);
  await page.getByRole("link", { name: "模型價格" }).click();
  await expect(page.getByRole("heading", { name: "API 等值價格" })).toBeInViewport();
  await page.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  for (const label of ["gpt-5.6-sol input 價格", "gpt-5.6-sol cached input 價格", "gpt-5.6-sol cache writes 價格", "gpt-5.6-sol Priority 倍率"]) {
    await expect(page.getByLabel(label)).toBeInViewport();
  }
});

test("all routes render without page overflow or console errors at desktop and narrow sizes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [{ width: 1536, height: 1024 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const route of ["/", "/trends", "/sessions", "/models", "/activity", "/sync", "/settings"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "主要導覽" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} at ${viewport.width}`).toBe(true);
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    }
  }
  expect(errors).toEqual([]);
});
