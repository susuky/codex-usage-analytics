import { expect, test, type Page } from "@playwright/test";
import { demoSessions } from "../src/lib/mockData";
import type { SessionAggregate, TurnUsage } from "../src/types";

test.use({ timezoneId: "Asia/Taipei" });

function detailSession(timestamps: string[]): SessionAggregate {
  const turns: TurnUsage[] = timestamps.map((timestamp, index) => ({
    ordinal: index + 1, timestamp, model: index % 2 === 0 ? "gpt-6.1-sol" : "gpt-6-astra",
    serviceTier: index === 1 ? "priority" : "default", reasoningEffort: "high",
    tokens: { inputTokens: 100 * (index + 1), cachedInputTokens: 80 * (index + 1), cacheWriteInputTokens: 0, outputTokens: 10 * (index + 1), reasoningOutputTokens: 2 * (index + 1), totalTokens: 110 * (index + 1) },
    estimateMicrousd: 500 * (index + 1), cacheRate: 80,
  }));
  const totals = turns.reduce((sum, turn) => {
    for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += turn.tokens[key];
    return sum;
  }, { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
  return { ...demoSessions[2], sessionId: "timeline", project: "timeline-example", model: "gpt-6-astra", startedAt: timestamps[0] || "2026-10-13T01:00:00Z", endedAt: timestamps.at(-1) || "2026-10-13T01:00:00Z", turns, tokens: totals, tokenEventCount: turns.length, estimateMicrousd: turns.reduce((sum, turn) => sum + (turn.estimateMicrousd ?? 0), 0) };
}

async function openDetail(page: Page, session: SessionAggregate) {
  // Exercise the desktop data contract with artificial records, without reading a personal database.
  await page.addInitScript(session => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      invoke: async (command: string) => {
        if (command === "get_session_detail") return session;
        if (command === "get_settings") return { pollMinutes: 15, cloudEnabled: false };
        if (command === "plugin:deep-link|get_current") return [];
        return null;
      },
      transformCallback: () => 0, unregisterCallback: () => {},
    } });
  }, session);
  await page.goto("/sessions/local/timeline");
  await expect(page.getByRole("heading", { name: "每回合用量" })).toBeVisible();
}

test("actual elapsed time determines the curve and each turn retains its model", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 1080 });
  const session = detailSession(["2026-10-12T01:00:00Z", "2026-10-12T01:10:00Z", "2026-10-12T03:00:00Z", "2026-10-13T01:00:00Z"]);
  await openDetail(page, session);
  await expect(page).toHaveTitle("Session 明細 · Codex 用量分析");
  await expect(page.locator(".metadata-strip").getByText("使用模型", { exact: true })).toBeVisible();
  await expect(page.locator(".metadata-strip strong").first()).toHaveText("gpt-6.1-sol、gpt-6-astra");
  await expect(page.getByRole("columnheader", { name: "模型", exact: true })).toBeVisible();
  expect(await page.locator("tbody tr td:nth-child(3)").allTextContents()).toEqual(session.turns!.map(turn => turn.model));
  const axis = page.locator(".detail-chart .recharts-xAxis-tick-labels");
  await expect(axis).toContainText("10/12");
  await expect(axis).toContainText("10/13");
  const path = await page.locator(".detail-chart .recharts-area-curve").first().getAttribute("d");
  const xs = [...path!.matchAll(/[ML]([\d.]+),/g)].map(match => Number(match[1]));
  expect(xs.length).toBeGreaterThan(3);
  expect((xs[1] - xs[0]) / (xs.at(-1)! - xs[0])).toBeCloseTo(10 / 1440, 3);
  const surface = page.locator(".detail-chart .recharts-surface");
  await surface.focus();
  await expect(page.locator(".detail-chart .chart-tooltip")).toContainText("gpt-6.1-sol");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".detail-chart .chart-tooltip")).toBeVisible();
  const tooltip = page.locator(".detail-chart .chart-tooltip");
  await expect(tooltip).toContainText("gpt-6-astra");
  await expect(tooltip).toContainText("2026/10/12 09:10:00");
  await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText("330");
  await page.screenshot({ path: info.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".detail-chart-panel").scrollIntoViewIfNeeded();
  await expect(axis).toContainText("10/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("same-day sessions show clock times and the tooltip changes with the active model", async ({ page }) => {
  await openDetail(page, detailSession(["2026-10-13T01:00:00Z", "2026-10-13T01:10:00Z"]));
  await expect(page.locator(".detail-chart .recharts-xAxis-tick-labels")).toContainText("09:00");
  await expect(page.locator(".detail-chart .recharts-xAxis-tick-labels")).toContainText("09:10");
  await page.locator(".detail-chart .recharts-surface").focus();
  await expect(page.locator(".detail-chart .chart-tooltip")).toContainText("gpt-6.1-sol");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".detail-chart .chart-tooltip")).toContainText("gpt-6-astra");
});

test("long conversations show dates on desktop and mobile", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1280 });
  await openDetail(page, detailSession(["2026-08-30T09:25:00Z", "2026-09-03T02:00:00Z", "2026-09-25T03:00:00Z", "2026-10-13T06:47:00Z"]));
  const axis = page.locator(".detail-chart .recharts-xAxis-tick-labels");
  await expect(axis).toContainText("08/30");
  await expect(axis).toContainText("10/13");
  expect(await axis.textContent()).not.toContain(":");
  await page.locator(".detail-chart .recharts-surface").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".detail-chart .chart-tooltip")).toContainText("2026/10/13 14:47:00");
  await page.screenshot({ path: info.outputPath("desktop-dates.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".detail-chart-panel").scrollIntoViewIfNeeded();
  await expect(axis).toContainText("10/13");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(".detail-chart-panel").screenshot({ path: info.outputPath("mobile-dates.png") });
});

test("one timestamp stays visible, and undated turns remain in totals and the table", async ({ page }) => {
  await openDetail(page, detailSession(["2026-10-13T01:00:00Z", ""]));
  await expect(page.locator(".detail-chart .recharts-area-dot").first()).toBeVisible();
  await expect(page.getByText(/1 回合缺少有效時間/)).toBeVisible();
  await expect(page.locator("tbody tr").last()).toContainText("未記錄");
  await expect(page.locator(".detail-metrics").getByText("330", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("tbody tr")).toHaveCount(2);
});

test("an empty timeline shows an honest empty state", async ({ page }) => {
  await openDetail(page, detailSession([]));
  await expect(page.getByText("沒有可繪製的時間紀錄。")).toBeVisible();
  await expect(page.locator(".detail-chart .recharts-surface")).toHaveCount(0);
});
