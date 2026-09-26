import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Taipei" });

test("filters by model and pricing, and recovers from no results", async ({ page }) => {
  await page.goto("/sessions");
  await page.getByRole("combobox", { name: "模型", exact: true }).selectOption("codex-auto-review");
  await page.getByRole("combobox", { name: "估算狀態", exact: true }).selectOption("unpriced");
  await expect(page.getByRole("heading", { name: "7 個 Sessions" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.getByLabel("搜尋 Sessions").fill("no-such-project");
  await expect(page.getByRole("heading", { name: "沒有符合條件的 Session" })).toBeVisible();
  await page.getByRole("button", { name: "顯示此區間全部紀錄" }).click();
  await expect(page.getByRole("heading", { name: "42 個 Sessions" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "估算狀態", exact: true })).toHaveValue("all");
  await page.getByRole("combobox", { name: "估算狀態", exact: true }).selectOption("partial");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("（部分）");
});

test("pagination, global sorting and summary totals stay consistent", async ({ page }) => {
  await page.goto("/sessions");
  await expect(page.locator("tbody tr")).toHaveCount(25);
  const summary = await page.getByRole("region", { name: "篩選結果摘要" }).innerText();
  const firstPageIds = await page.locator("tbody a").evaluateAll(links => links.map(link => link.getAttribute("href")));
  await page.getByRole("button", { name: "下一頁", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(17);
  expect(await page.getByRole("region", { name: "篩選結果摘要" }).innerText()).toBe(summary);
  const secondPageIds = await page.locator("tbody a").evaluateAll(links => links.map(link => link.getAttribute("href")));
  expect(new Set([...firstPageIds, ...secondPageIds]).size).toBe(42);
  await page.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(page.getByText("第 1 / 2 頁")).toBeVisible();
  await page.getByRole("combobox", { name: "每頁筆數", exact: true }).selectOption("50");
  await expect(page.locator("tbody tr")).toHaveCount(42);
  const numbers = (await page.locator("tbody td:nth-child(5)").allTextContents()).map(text => Number(text.replaceAll(",", "")));
  expect(numbers).toHaveLength(42);
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
});

test("returning from a session preserves filters, page and sorting", async ({ page }) => {
  await page.goto("/sessions?source=local&sort=tokens&direction=desc&page=2");
  await expect(page.getByText("第 2 / 2 頁")).toBeVisible();
  const firstSession = await page.locator("tbody a").first().getAttribute("href");
  await page.locator("tbody a").first().click();
  await expect(page.getByRole("heading", { name: "Session 明細", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回 Sessions" }).click();
  await expect(page.getByRole("combobox", { name: "來源", exact: true })).toHaveValue("local");
  await expect(page.getByText("第 2 / 2 頁")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Tokens" })).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator("tbody a").first()).toHaveAttribute("href", firstSession!);
  await page.reload();
  await expect(page.getByText("第 2 / 2 頁")).toBeVisible();
});

test("overview model and source links lead to the matching records", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "查看 gpt-5.6-sol 的 Sessions" }).click();
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveValue("gpt-5.6-sol");
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.getByRole("link", { name: /查看來源狀態/ }).click();
  await expect(page.getByRole("heading", { name: "資料來源", exact: true })).toBeVisible();
});

test("today preset keeps the range total aligned with the today metric", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("1");
  await expect(page.getByRole("region", { name: "用量摘要" })).toBeVisible();
  const values = await page.locator('[aria-label="用量摘要"] strong').allTextContents();
  expect(values[0]).toBe(values[1]);
  await page.getByRole("button", { name: "查看每日明細" }).click();
  await expect(page.locator("#daily-usage-table tbody tr")).toHaveCount(1);
});

test("keyboard filtering and empty-state recovery work at a narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/sessions?model=unavailable");
  const clear = page.getByRole("button", { name: "清除篩選", exact: true });
  await clear.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await page.getByLabel("搜尋 Sessions").fill("missing");
  const recover = page.getByRole("button", { name: "顯示此區間全部紀錄" });
  await expect(recover).toBeVisible();
  await recover.focus();
  expect(await recover.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Space");
  await expect(page.locator("tbody tr")).toHaveCount(25);
});
