import { expect, test } from "@playwright/test";
import type { DailyUsage, OverviewData, SessionAggregate, TokenBreakdown } from "../src/types";

test("tooltip totals match the stack and a chart click selects that day's model distribution", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("30");
  await expect(page.getByRole("button", { name: "重新掃描", exact: true })).toBeEnabled();
  const summary = page.getByRole("region", { name: "用量摘要" });
  const originalSummary = await summary.textContent();
  const bars = page.locator(".recharts-bar-rectangle path");
  const visibleIndex = await bars.evaluateAll(nodes => nodes.findIndex(node => node.getBoundingClientRect().height > 5));
  expect(visibleIndex).toBeGreaterThanOrEqual(0);
  await bars.nth(visibleIndex).hover();
  const tooltip = page.locator(".chart-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(":scope > strong")).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  const date = await tooltip.locator(":scope > strong").textContent();
  const parts = await tooltip.locator(".chart-tooltip-part b").allTextContents();
  const total = parts.reduce((sum, value) => sum + Number(value.replaceAll(",", "")), 0);
  await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText(total.toLocaleString("en-US"));
  await bars.nth(visibleIndex).click();
  const panel = page.getByRole("region", { name: "模型用量排行" });
  await expect(panel.getByLabel("模型分布日期")).toHaveValue(date!);
  await expect(panel.getByText(`${total.toLocaleString("en-US")} Tokens`, { exact: true })).toBeVisible();
  const estimate = await tooltip.locator(".chart-tooltip-cost b").textContent();
  await expect(panel.getByRole("region", { name: "當日用量與估算" })).toContainText(estimate!);
  await bars.nth(visibleIndex).hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator(":scope > strong")).toHaveText(date!);
  await expect(summary).toHaveText(originalSummary ?? "");
  await panel.getByRole("button", { name: "返回整個區間" }).click();
  await expect(panel.getByLabel("模型分布日期")).toHaveValue("");
  await expect(page.getByLabel("日期範圍")).toHaveValue("30");
});

test("daily totals, keyboard date selection, empty days and interval changes stay consistent", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("7");
  await page.getByRole("button", { name: "查看每日明細" }).click();
  const table = page.locator("#daily-usage-table");
  await expect(table.getByRole("columnheader", { name: "總 Tokens", exact: true })).toBeVisible();
  const firstRow = table.locator("tbody tr").first();
  const cells = await firstRow.locator("td").allTextContents();
  expect(Number(cells[6].replaceAll(",", ""))).toBe(cells.slice(1, 6).reduce((sum, value) => sum + Number(value.replaceAll(",", "")), 0));
  await firstRow.getByRole("button").focus();
  await page.keyboard.press("Enter");
  const date = page.getByLabel("模型分布日期", { exact: true });
  await expect(date).toHaveValue(cells[0]);
  await page.getByLabel("日期範圍").selectOption("30");
  await expect(date).toHaveValue("");
  await date.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(date).not.toHaveValue("");
  await expect(page.getByText("這一天沒有模型用量")).toBeVisible();
  await page.getByRole("button", { name: "返回整個區間" }).click();
  await expect(date).toHaveValue("");
});

test("opening a model's Sessions carries the selected day into the destination", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("7");
  const panel = page.getByRole("region", { name: "模型用量排行" });
  const date = await panel.getByLabel("模型分布日期").locator("option").last().getAttribute("value");
  await panel.getByLabel("模型分布日期").selectOption(date!);
  const modelLink = panel.getByRole("link", { name: /的 Sessions$/ }).first();
  await expect(modelLink).toBeVisible();
  const model = await modelLink.textContent();
  await modelLink.click();
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveValue(model!);
  await expect(page.getByLabel("日期範圍")).toHaveValue("custom");
  await page.getByRole("button", { name: "選擇日期區間" }).click();
  await expect(page.getByLabel("開始日期")).toHaveValue(date!);
  await expect(page.getByLabel("結束日期")).toHaveValue(date!);
});

test("daily estimate chart, tooltip, selected day and table show the same amount", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("日期範圍").selectOption("7");
  await page.getByRole("button", { name: "查看每日明細" }).click();
  const table = page.locator("#daily-usage-table");
  await expect(table.getByRole("columnheader", { name: "API 等值估算", exact: true })).toBeVisible();
  const controls = page.getByRole("group", { name: "每日圖表顯示方式" });
  await controls.getByRole("button", { name: "API 等值估算", exact: true }).click();
  await expect(page.getByRole("heading", { name: "每日 API 等值估算", exact: true })).toBeVisible();
  const bars = page.locator(".main-chart .recharts-bar-rectangle path");
  await expect(bars.first()).toBeVisible();
  const visibleIndex = await bars.evaluateAll(nodes => nodes.findIndex(node => node.getBoundingClientRect().height > 5));
  expect(visibleIndex).toBeGreaterThanOrEqual(0);
  await bars.nth(visibleIndex).hover();
  const tooltip = page.locator(".chart-tooltip");
  const date = await tooltip.locator(":scope > strong").textContent();
  const row = table.getByRole("row").filter({ has: page.getByRole("button", { name: `查看 ${date} 模型分布`, exact: true }) });
  const amount = await row.locator("td").last().locator("span").textContent();
  await expect(tooltip.locator(".chart-tooltip-cost b")).toHaveText(amount!);
  await bars.nth(visibleIndex).click();
  const selected = page.getByRole("region", { name: "當日用量與估算" });
  await expect(selected).toContainText(amount!);
  await controls.getByRole("button", { name: "Tokens", exact: true }).click();
  await expect(page.getByLabel("模型分布日期", { exact: true })).toHaveValue(date!);
  await expect(selected).toContainText(amount!);
});

test("comparison shares daily selection and keeps unknown estimates out of the cost line", async ({ page }, info) => {
  const days: DailyUsage[] = [1, 2, 3].map((factor, index) => ({
    date: `2026-10-${13 + index}`, uncachedInput: 200 * factor, cachedInput: 600 * factor, cacheWriteInput: 50 * factor,
    output: 100 * factor, unclassified: 50 * factor, estimateMicrousd: index ? 0 : 1_000_000,
    unpricedTokens: index === 1 ? 2_000 : index === 2 ? 500 : 0, sessions: 1,
  }));
  const tokens = (day?: DailyUsage): TokenBreakdown => ({
    inputTokens: day ? day.uncachedInput + day.cachedInput + day.cacheWriteInput : 0, cachedInputTokens: day?.cachedInput ?? 0,
    cacheWriteInputTokens: day?.cacheWriteInput ?? 0, outputTokens: day?.output ?? 0, reasoningOutputTokens: (day?.output ?? 0) / 5,
    totalTokens: day ? day.uncachedInput + day.cachedInput + day.cacheWriteInput + day.output + day.unclassified : 0,
  });
  const sessions: SessionAggregate[] = days.map((day, index) => ({
    sessionId: `comparison-${index}`, sourceId: "local", sourceName: "本機", sourceKind: "local", project: "comparison-example", model: "comparison-model",
    startedAt: `${day.date}T01:00:00Z`, endedAt: `${day.date}T01:00:00Z`, origin: "cli", tokens: tokens(day), activityTokens: 0,
    estimateMicrousd: index === 1 ? null : day.estimateMicrousd, unpricedTurnCount: Number(day.unpricedTokens > 0), unpricedTokens: day.unpricedTokens,
    tokenEventCount: index === 2 ? 2 : 1, rateUsedPercent: null, rateWindowMinutes: null,
  }));
  const overview = (date = ""): OverviewData => {
    const daily = days.filter(day => !date || day.date === date), rows = sessions.filter(row => !date || row.startedAt.startsWith(date));
    const totals = rows.reduce((sum, row) => {
      for (const key of Object.keys(sum) as Array<keyof TokenBreakdown>) sum[key] += row.tokens[key];
      return sum;
    }, tokens());
    const estimate = rows.reduce((sum, row) => sum + (row.estimateMicrousd ?? 0), 0);
    return {
      todayTokens: 0, sessions: rows, daily, totals, activityTokens: 0, estimateMicrousd: estimate, unpricedSessions: rows.filter(row => row.unpricedTokens > 0).length,
      sources: [{ id: "local", name: "本機", kind: "local", enabled: true, stale: false, lastScannedAt: "2026-10-16T01:00:00Z", lastError: null, sessionCount: rows.length, latestDataAt: rows.at(-1)?.endedAt ?? null }],
      models: rows.length ? [{ model: "comparison-model", tokens: totals, estimateMicrousd: rows.some(row => row.estimateMicrousd !== null) ? estimate : null,
        sessions: rows.length, fastRequests: 0, fastTokens: 0, pricedRequests: rows.reduce((sum, row) => sum + row.tokenEventCount - row.unpricedTurnCount, 0),
        unpricedRequests: rows.reduce((sum, row) => sum + row.unpricedTurnCount, 0), unpricedTokens: rows.reduce((sum, row) => sum + row.unpricedTokens, 0), reasoningEfforts: [], unrecordedEffortRequests: 0 }] : [],
      activity: { skills: [], plugins: [], efforts: [], serviceTiers: [], reasoningTokens: totals.reasoningOutputTokens, fastRequests: 0, fastTokens: 0 },
    };
  };
  const fixtures = { all: overview(), days: Object.fromEntries(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map(date => [date, overview(date)])) };
  await page.addInitScript(fixtures => {
    localStorage.setItem("codex-usage-date-range-v1", JSON.stringify({ days: 4, startDate: "2026-10-13", endDate: "2026-10-16" }));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      invoke: async (command: string, args?: { filter?: { startDate?: string; endDate?: string } }) => {
        if (command === "get_overview") return args?.filter?.startDate === args?.filter?.endDate ? fixtures.days[args!.filter!.startDate!] : fixtures.all;
        if (command === "get_settings") return { pollMinutes: 15, cloudEnabled: false, autoUpdatePricing: false, sshSources: [], pricingRules: [] };
        if (command === "scan_sources") return { sources: fixtures.all.sources, scannedSessions: 3, scannedAt: "2026-10-16T01:00:00Z" };
        if (command === "plugin:deep-link|get_current") return [];
        return null;
      }, transformCallback: () => 0, unregisterCallback: () => {},
    } });
  }, fixtures);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/");
  const controls = page.getByRole("group", { name: "每日圖表顯示方式" });
  await controls.getByRole("button", { name: "比較", exact: true }).click();
  await expect(page.getByRole("heading", { name: "每日用量與 API 等值估算", exact: true })).toBeVisible();
  const chart = page.locator(".main-chart");
  await expect(chart.locator(".recharts-bar")).toHaveCount(5);
  await expect(chart.locator(".recharts-line-curve")).toHaveCount(1);
  await expect(chart.locator(".recharts-yAxis")).toHaveCount(2);
  await expect(chart.locator("..").locator("span", { hasText: /^Tokens$/ })).toBeVisible();
  await expect(chart.locator("..").getByText("API 等值估算（US$）", { exact: true })).toBeVisible();
  const dots = chart.locator(".recharts-line-dot");
  await expect(dots).toHaveCount(3);
  const coordinates = await dots.evaluateAll(nodes => nodes.map(node => ({ x: Number(node.getAttribute("cx")), y: Number(node.getAttribute("cy")) })));
  expect(coordinates[0].y).toBeLessThan(coordinates[1].y);
  expect(coordinates[1].y).toBeCloseTo(coordinates[2].y, 3);
  expect((coordinates[1].x - coordinates[0].x) / (coordinates[2].x - coordinates[0].x)).toBeCloseTo(2 / 3, 3);
  const path = await chart.locator(".recharts-line-curve").getAttribute("d");
  expect(path!.match(/M/g)).toHaveLength(2);
  await page.getByRole("button", { name: "查看每日明細", exact: true }).click();
  const table = page.locator("#daily-usage-table");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const panel = page.getByRole("region", { name: "模型用量排行" });
  const tooltip = chart.locator(".chart-tooltip");
  for (const [index, total, cost] of [[0, "1,000", "US$1.00"], [1, "2,000", "無法估算"], [2, "3,000", "US$0.00（部分）"], [3, "0", "US$0.00"]] as const) {
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.locator(".recharts-surface").boundingBox();
    await page.mouse.move(box!.x + coordinates[0].x + index * (coordinates[2].x - coordinates[0].x) / 3, box!.y + box!.height / 2);
    await expect(tooltip.locator(":scope > strong")).toHaveText(`2026-10-${13 + index}`);
    await expect(tooltip.locator(".chart-tooltip-part")).toHaveCount(5);
    const parts = await tooltip.locator(".chart-tooltip-part b").allTextContents();
    expect(parts.reduce((sum, value) => sum + Number(value.replaceAll(",", "")), 0)).toBe(Number(total.replaceAll(",", "")));
    await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText(total);
    await expect(tooltip.locator(".chart-tooltip-cost b")).toHaveText(cost);
    await page.mouse.click(box!.x + coordinates[0].x + index * (coordinates[2].x - coordinates[0].x) / 3, box!.y + box!.height / 2);
    const date = `2026-10-${13 + index}`;
    await expect(panel.getByLabel("模型分布日期")).toHaveValue(date);
    await expect(panel.getByRole("region", { name: "當日用量與估算" })).toContainText(`${total} Tokens`);
    await expect(panel.getByRole("region", { name: "當日用量與估算" })).toContainText(cost);
    const row = table.getByRole("row").filter({ has: page.getByRole("button", { name: `查看 ${date} 模型分布`, exact: true }) });
    await expect(row.locator("td").nth(6)).toHaveText(total);
    await expect(row.locator("td").last().locator("span")).toHaveText(cost);
  }
  await panel.getByLabel("模型分布日期").selectOption("2026-10-13");
  for (const label of ["Tokens", "API 等值估算", "比較"]) {
    await controls.getByRole("button", { name: label, exact: true }).click();
    await expect(controls.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("模型分布日期")).toHaveValue("2026-10-13");
    await expect(panel.getByRole("region", { name: "當日用量與估算" })).toContainText("US$1.00");
  }
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("comparison-desktop.png"), fullPage: true });
  await chart.locator("..").screenshot({ path: info.outputPath("comparison-chart-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await chart.scrollIntoViewIfNeeded();
  await dots.first().click();
  await expect(panel.getByLabel("模型分布日期")).toHaveValue("2026-10-13");
  await panel.getByLabel("模型分布日期").selectOption("2026-10-15");
  await expect(panel.getByRole("region", { name: "當日用量與估算" })).toContainText("US$0.00（部分）");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("comparison-mobile.png"), fullPage: true });
  await chart.locator("..").screenshot({ path: info.outputPath("comparison-chart-mobile.png") });
  expect(errors).toEqual([]);
});
