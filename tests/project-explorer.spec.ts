import { expect, test, type Page } from "@playwright/test";
import type { OverviewData, SessionAggregate, TokenBreakdown, UsageFilter } from "../src/types";

test.use({ timezoneId: "Asia/Taipei" });

const specialProject = "/工作區/分析#專案";
const range = { days: 2, startDate: "2026-10-15", endDate: "2026-10-16" };
const emptyTokens = (): TokenBreakdown => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

function session(id: string, project: string, sourceId: string, model: string, usage: Array<[string, number, number]>): SessionAggregate {
  const turns = usage.map(([date, totalTokens, estimateMicrousd], index) => ({
    ordinal: index + 1, timestamp: date.includes("T") ? date : `${date}T01:00:00Z`, model, serviceTier: "default" as const, reasoningEffort: "high",
    tokens: { inputTokens: totalTokens * .9, cachedInputTokens: totalTokens * .5, cacheWriteInputTokens: 0, outputTokens: totalTokens * .1, reasoningOutputTokens: totalTokens * .02, totalTokens },
    estimateMicrousd, cacheRate: 100 * 5 / 9,
  }));
  const tokens = turns.reduce((sum, turn) => {
    for (const key of Object.keys(sum) as Array<keyof TokenBreakdown>) sum[key] += turn.tokens[key];
    return sum;
  }, emptyTokens());
  return {
    sessionId: id, project, sourceId, sourceName: sourceId === "local" ? "本機" : "測試遠端", sourceKind: sourceId === "local" ? "local" : "ssh",
    model, startedAt: turns[0].timestamp, endedAt: turns.at(-1)!.timestamp, origin: "cli", tokens, activityTokens: 0,
    estimateMicrousd: turns.reduce((sum, turn) => sum + turn.estimateMicrousd, 0), unpricedTurnCount: 0, unpricedTokens: 0,
    tokenEventCount: turns.length, rateUsedPercent: null, rateWindowMinutes: null, turns,
  };
}

const sessions = [
  session("pin-local", "PinLens", "local", "gpt-6.1-sol", [["2026-10-14", 300, 500_000], ["2026-10-15", 100, 400_000], ["2026-10-16T02:00:00Z", 200, 600_000]]),
  session("pin-remote", "PinLens", "remote-test", "gpt-6-astra", [["2026-10-16T01:30:00Z", 200, 800_000], ["2026-10-16T03:00:00Z", 300, 1_200_000]]),
  session("another", "另一個專案", "local", "gpt-6.1-sol", [["2026-10-16", 200, 1_000_000]]),
  session("encoded", specialProject, "local", "gpt-6.1-sol", [["2026-10-16", 70, 500_000]]),
];

interface ProjectTestDriver {
  calls: UsageFilter[];
  rejectProject: boolean;
  hold: Partial<UsageFilter> | null;
  pending: number;
  detailCalls: UsageFilter[];
  duplicateTimestamp: boolean;
  release: () => Promise<void>;
}
declare global { interface Window { __projectTest: ProjectTestDriver } }

async function mockDesktop(page: Page) {
  await page.addInitScript(({ sessions, range }) => {
    localStorage.setItem("codex-usage-date-range-v1", JSON.stringify(range));
    const releases: Array<() => void> = [];
    const driver: ProjectTestDriver = window.__projectTest = {
      calls: [], rejectProject: false, hold: null, pending: 0,
      detailCalls: [], duplicateTimestamp: false,
      release: async () => {
        driver.hold = null;
        releases.splice(0).forEach(resolve => resolve());
        driver.pending = 0;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      },
    };
    const zero = (): TokenBreakdown => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
    const add = (sum: TokenBreakdown, next: TokenBreakdown) => {
      for (const key of Object.keys(sum) as Array<keyof TokenBreakdown>) sum[key] += next[key];
      return sum;
    };
    const overview = (filter: UsageFilter): OverviewData => {
      const selected = sessions.filter(item => (!filter.project || item.project === filter.project) && (!filter.sourceId || item.sourceId === filter.sourceId)).flatMap(item => {
        const turns = item.turns!.map(turn => driver.duplicateTimestamp && item.sessionId === "pin-remote" && turn.ordinal === 2 ? { ...turn, timestamp: "2026-10-16T02:00:00Z" } : turn)
          .filter(turn => (!filter.startDate || turn.timestamp.slice(0, 10) >= filter.startDate) && (!filter.endDate || turn.timestamp.slice(0, 10) <= filter.endDate));
        return turns.length ? [{ ...item, turns, startedAt: turns[0].timestamp, endedAt: turns.at(-1)!.timestamp, tokens: turns.reduce((sum, turn) => add(sum, turn.tokens), zero()), estimateMicrousd: turns.reduce((sum, turn) => sum + turn.estimateMicrousd!, 0), tokenEventCount: turns.length }] : [];
      });
      const sources = ["local", "remote-test"].map(id => ({ id, name: id === "local" ? "本機" : "測試遠端", kind: id === "local" ? "local" as const : "ssh" as const, enabled: true, stale: false, lastScannedAt: "2026-10-16T02:00:00Z", lastError: null, sessionCount: selected.filter(item => item.sourceId === id).length, latestDataAt: "2026-10-16T01:00:00Z" }));
      const dates = [...new Set(selected.flatMap(item => item.turns.map(turn => turn.timestamp.slice(0, 10))))].sort();
      return {
        todayTokens: 0, sessions: selected, sources, totals: selected.reduce((sum, item) => add(sum, item.tokens), zero()),
        estimateMicrousd: selected.reduce((sum, item) => sum + item.estimateMicrousd, 0), activityTokens: 0, unpricedSessions: 0,
        daily: dates.map(date => {
          const turns = selected.flatMap(item => item.turns.filter(turn => turn.timestamp.startsWith(date)));
          const tokens = turns.reduce((sum, turn) => add(sum, turn.tokens), zero());
          return { date, uncachedInput: tokens.inputTokens - tokens.cachedInputTokens, cachedInput: tokens.cachedInputTokens, cacheWriteInput: 0, output: tokens.outputTokens, unclassified: 0, estimateMicrousd: turns.reduce((sum, turn) => sum + turn.estimateMicrousd!, 0), unpricedTokens: 0, sessions: selected.filter(item => item.turns.some(turn => turn.timestamp.startsWith(date))).length };
        }),
        models: [...new Set(selected.map(item => item.model))].map(model => {
          const rows = selected.filter(item => item.model === model);
          return { model, tokens: rows.reduce((sum, item) => add(sum, item.tokens), zero()), estimateMicrousd: rows.reduce((sum, item) => sum + item.estimateMicrousd, 0), sessions: rows.length, fastRequests: 0, fastTokens: 0, pricedRequests: rows.reduce((sum, item) => sum + item.tokenEventCount, 0), unpricedRequests: 0, unpricedTokens: 0, reasoningEfforts: [], unrecordedEffortRequests: 0 };
        }),
        activity: { skills: [], plugins: [], efforts: [], serviceTiers: [], reasoningTokens: 0, fastRequests: 0, fastTokens: 0 },
      };
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      invoke: async (command: string, args?: { filter?: UsageFilter; sourceId?: string; sessionId?: string }) => {
        if (command === "get_overview" || command === "get_project_detail") {
          const filter = args!.filter!;
          driver.calls.push(filter);
          if (command === "get_project_detail") driver.detailCalls.push(filter);
          if (filter.project && driver.rejectProject) throw new Error("測試查詢失敗");
          const data = overview(filter);
          let total = 0, input = 0, output = 0, reasoning = 0;
          const events = command === "get_project_detail" ? data.sessions.flatMap(item => item.turns!).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).map(turn => {
            total += turn.tokens.totalTokens; input += turn.tokens.inputTokens; output += turn.tokens.outputTokens; reasoning += turn.tokens.reasoningOutputTokens;
            return { timestamp: Date.parse(turn.timestamp), total, input, output, reasoning };
          }) : null;
          const timeline = events?.filter((point, index) => point.timestamp !== events[index + 1]?.timestamp) ?? null;
          const result = timeline ? { overview: data, timeline } : data;
          if (filter.project && driver.hold && Object.entries(driver.hold).every(([key, value]) => filter[key as keyof UsageFilter] === value)) {
            driver.pending += 1;
            await new Promise<void>(resolve => releases.push(resolve));
          }
          return result;
        }
        if (command === "get_session_detail") return sessions.find(item => item.sourceId === args?.sourceId && item.sessionId === args?.sessionId);
        if (command === "get_settings") return { pollMinutes: 15, cloudEnabled: false, autoUpdatePricing: false, sshSources: [], pricingRules: [] };
        if (command === "scan_sources") return { sources: overview(range).sources, scannedSessions: sessions.length, scannedAt: "2026-10-16T02:00:00Z" };
        if (command === "plugin:deep-link|get_current") return [];
        return null;
      },
      transformCallback: () => 0, unregisterCallback: () => {},
    } });
  }, { sessions, range });
}

function metric(page: Page, label: string) {
  return page.locator(label === "Sessions" ? ".metadata-strip" : ".detail-metrics").getByText(label, { exact: true }).locator("..").locator("strong");
}

function projectSessions(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "專案 Sessions", exact: true }) });
}

function projectCurve(page: Page) {
  return page.getByRole("region", { name: "專案 Token 累積曲線", exact: true });
}

async function customRange(page: Page, start: string, end: string) {
  await page.getByRole("button", { name: "選擇日期區間", exact: true }).click();
  await page.getByLabel("開始日期", { exact: true }).fill(start);
  await page.getByLabel("結束日期", { exact: true }).fill(end);
  await page.getByRole("button", { name: "套用", exact: true }).click();
}

test.beforeEach(async ({ page }) => { await mockDesktop(page); });

test("projects combine sessions across sources and expose period usage on desktop and mobile", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/sessions");
  await page.getByRole("link", { name: "查看專案", exact: true }).click();
  await expect(page).toHaveTitle("專案 · Codex 用量分析");
  await expect(page.getByRole("navigation", { name: "主要導覽" }).getByRole("link", { name: "專案", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  const pin = page.getByRole("row").filter({ has: page.getByRole("link", { name: "PinLens", exact: true }) });
  await expect(pin).toContainText("800");
  await expect(pin).toContainText("US$3.00");
  await page.getByLabel("搜尋專案", { exact: true }).fill("PinLens");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("搜尋專案", { exact: true }).fill("");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("local");
  await expect(pin).toContainText("300");
  await expect(pin).toContainText("US$1.00");
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("");
  await expect(pin).toContainText("800");
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("projects-desktop.png"), fullPage: true });
  await pin.getByRole("link", { name: "PinLens", exact: true }).click();
  await expect(page).toHaveTitle("專案明細 · Codex 用量分析");
  await expect(page.getByRole("heading", { name: "專案明細", exact: true })).toBeVisible();
  await expect(metric(page, "所選期間 Tokens")).toHaveText("800");
  await expect(metric(page, "API 等值估算")).toHaveText("US$3.00");
  await expect(metric(page, "Sessions")).toHaveText("2");
  await expect(page.getByRole("heading", { name: "模型分布", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "專案 Sessions", exact: true })).toBeVisible();
  await expect(projectSessions(page).locator("tbody tr")).toHaveCount(2);
  const curve = projectCurve(page);
  await expect(curve.getByRole("heading", { name: "Token 累積曲線", exact: true })).toBeVisible();
  await expect(curve.locator(".recharts-area-curve")).toHaveCount(4);
  await page.mouse.move(0, 0);
  await curve.locator(".recharts-surface").focus();
  const tooltip = curve.locator(".chart-tooltip");
  await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText("100");
  await expect(tooltip).toContainText("10/15 09:00:00");
  for (const total of ["300", "500", "800"]) {
    await page.keyboard.press("ArrowRight");
    await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText(total);
  }
  await expect(tooltip.locator("span").filter({ hasText: /^Input/ }).locator("b")).toHaveText("720");
  await expect(tooltip.locator("span").filter({ hasText: /^Output/ }).locator("b")).toHaveText("80");
  await expect(tooltip.locator("span").filter({ hasText: /^Reasoning/ }).locator("b")).toHaveText("16");
  await expect(tooltip).toContainText("10/16 11:00:00");
  await curve.screenshot({ path: info.outputPath("project-timeline-desktop.png") });
  await expect(page.getByRole("region", { name: "專案每日用量", exact: true }).locator(".recharts-surface")).toBeVisible();
  const models = page.getByRole("region", { name: "專案模型分布", exact: true });
  await expect(models.getByRole("row").filter({ hasText: "gpt-6.1-sol" })).toContainText("300");
  await expect(models.getByRole("row").filter({ hasText: "gpt-6-astra" })).toContainText("500");
  await page.getByRole("button", { name: "查看每日明細", exact: true }).click();
  const daily = page.getByRole("region", { name: "專案每日明細", exact: true });
  await expect(daily.locator("tbody tr")).toHaveCount(2);
  await expect(daily.getByRole("row").filter({ hasText: "2026-10-15" })).toContainText("US$0.40");
  await expect(daily.getByRole("row").filter({ hasText: "2026-10-16" })).toContainText("700");
  await expect(daily.getByRole("row").filter({ hasText: "2026-10-16" })).toContainText("US$2.60");
  await page.getByRole("button", { name: "收合每日明細", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__projectTest.calls.some(filter => filter.project === "PinLens" && filter.startDate === "2026-10-15" && filter.endDate === "2026-10-16"))).toBe(true);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  await expect(page.getByRole("heading", { name: "專案明細", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("project-detail-desktop.png"), fullPage: false });
  await page.screenshot({ path: info.outputPath("project-detail-desktop-full.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("project-detail-mobile.png"), fullPage: true });
  await curve.screenshot({ path: info.outputPath("project-timeline-mobile.png") });
  await page.getByRole("link", { name: "返回專案", exact: true }).click();
  await expect(page.getByRole("heading", { name: "專案", exact: true })).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("projects-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("project source and date filters survive session drilldown and return", async ({ page }) => {
  await page.goto("/projects/PinLens");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("800");
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("local");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("300");
  const curve = projectCurve(page);
  await page.mouse.move(0, 0);
  await curve.locator(".recharts-surface").focus();
  await expect(curve.locator(".chart-tooltip-total b")).toHaveText("100");
  await page.keyboard.press("ArrowRight");
  await expect(curve.locator(".chart-tooltip-total b")).toHaveText("300");
  await customRange(page, "2026-10-16", "2026-10-16");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("200");
  await expect(curve.locator(".recharts-area-dot").first()).toBeVisible();
  await page.mouse.move(0, 0);
  await curve.locator(".recharts-surface").focus();
  await expect(curve.locator(".chart-tooltip-total b")).toHaveText("200");
  await expect(curve.locator(".chart-tooltip span").filter({ hasText: /^Input/ }).locator("b")).toHaveText("180");
  await expect(curve.locator(".chart-tooltip span").filter({ hasText: /^Output/ }).locator("b")).toHaveText("20");
  await expect(curve.locator(".chart-tooltip span").filter({ hasText: /^Reasoning/ }).locator("b")).toHaveText("4");
  await expect.poll(() => page.evaluate(() => window.__projectTest.calls.some(filter => filter.project === "PinLens" && filter.sourceId === "local" && filter.startDate === "2026-10-16" && filter.endDate === "2026-10-16"))).toBe(true);
  const projectUrl = page.url();
  await page.locator("tbody").getByRole("link", { name: "PinLens", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session 明細", exact: true })).toBeVisible();
  await expect(page.locator(".detail-metrics").getByText("600", { exact: true })).toBeVisible();
  await expect(page.locator(".metadata-strip").getByRole("link", { name: "PinLens", exact: true })).toHaveAttribute("href", /\/projects\/PinLens/);
  await page.getByRole("link", { name: "返回專案明細", exact: true }).click();
  await expect(page).toHaveURL(projectUrl);
  await expect(page.getByRole("combobox", { name: "來源", exact: true })).toHaveValue("local");
  await expect(page.getByLabel("日期範圍", { exact: true })).toHaveValue("custom");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("200");
  await page.getByRole("button", { name: "選擇日期區間", exact: true }).click();
  await expect(page.getByLabel("開始日期", { exact: true })).toHaveValue("2026-10-16");
  await expect(page.getByLabel("結束日期", { exact: true })).toHaveValue("2026-10-16");
});

test("project failures retry and late responses cannot replace a newer source or date", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("link", { name: "PinLens", exact: true })).toBeVisible();
  await page.evaluate(() => { window.__projectTest.rejectProject = true; });
  await page.getByRole("link", { name: "PinLens", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新載入", exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await page.evaluate(() => { window.__projectTest.rejectProject = false; });
  await page.getByRole("button", { name: "重新載入", exact: true }).click();
  await expect(metric(page, "所選期間 Tokens")).toHaveText("800");
  await page.evaluate(() => { window.__projectTest.hold = { sourceId: "local" }; });
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("local");
  await expect.poll(() => page.evaluate(() => window.__projectTest.pending)).toBeGreaterThan(0);
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("remote-test");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("500");
  await page.evaluate(() => window.__projectTest.release());
  await expect(metric(page, "所選期間 Tokens")).toHaveText("500");
  const curve = projectCurve(page);
  await page.mouse.move(0, 0);
  await curve.locator(".recharts-surface").focus();
  await expect(curve.locator(".chart-tooltip-total b")).toHaveText("200");
  await page.keyboard.press("ArrowRight");
  await expect(curve.locator(".chart-tooltip-total b")).toHaveText("500");
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("local");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("300");
  await page.evaluate(() => { window.__projectTest.hold = { startDate: "2026-10-15", endDate: "2026-10-15" }; });
  await customRange(page, "2026-10-15", "2026-10-15");
  await expect.poll(() => page.evaluate(() => window.__projectTest.pending)).toBeGreaterThan(0);
  await customRange(page, "2026-10-16", "2026-10-16");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("200");
  await page.evaluate(() => window.__projectTest.release());
  await expect(metric(page, "所選期間 Tokens")).toHaveText("200");
  await page.mouse.move(0, 0);
  await curve.locator(".recharts-surface").focus();
  await expect(curve.locator(".chart-tooltip-total b")).toHaveText("200");
});

test("project identity preserves slashes, a hash and Traditional Chinese through links and reload", async ({ page }) => {
  await page.goto("/projects");
  const link = page.getByRole("link", { name: specialProject, exact: true });
  await expect(link).toHaveAttribute("href", `/projects/${encodeURIComponent(specialProject)}`);
  await link.click();
  await expect(page.getByRole("heading", { name: "專案明細", exact: true })).toBeVisible();
  await expect(metric(page, "所選期間 Tokens")).toHaveText("70");
  await expect.poll(() => page.evaluate(() => window.__projectTest.calls.some(filter => filter.project === "/工作區/分析#專案"))).toBe(true);
  await page.reload();
  await expect(metric(page, "所選期間 Tokens")).toHaveText("70");
  await page.locator("tbody").getByRole("link", { name: specialProject, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session 明細", exact: true })).toBeVisible();
  await page.locator(".metadata-strip").getByRole("link", { name: specialProject, exact: true }).click();
  await expect(page.getByRole("heading", { name: "專案明細", exact: true })).toBeVisible();
  await expect(metric(page, "所選期間 Tokens")).toHaveText("70");
});

test("the project curve interleaves exact session events within a day", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/projects/PinLens");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("800");
  await customRange(page, "2026-10-16", "2026-10-16");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("700");
  const curve = projectCurve(page);
  await expect(curve.locator(".recharts-area-curve")).toHaveCount(4);
  await expect(curve.locator(".recharts-xAxis-tick-labels")).toContainText("09:30");
  await expect(curve.locator(".recharts-xAxis-tick-labels")).toContainText("11:00");
  await page.mouse.move(0, 0);
  await curve.locator(".recharts-surface").focus();
  const tooltip = curve.locator(".chart-tooltip");
  for (const [index, time, total] of [[0, "09:30:00", "200"], [1, "10:00:00", "400"], [2, "11:00:00", "700"]] as const) {
    if (index) await page.keyboard.press("ArrowRight");
    await expect(tooltip).toContainText(time);
    await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText(total);
  }
  await expect(tooltip.locator("span").filter({ hasText: /^Input/ }).locator("b")).toHaveText("630");
  await expect(tooltip.locator("span").filter({ hasText: /^Output/ }).locator("b")).toHaveText("70");
  await expect(tooltip.locator("span").filter({ hasText: /^Reasoning/ }).locator("b")).toHaveText("14");
  const path = await curve.locator(".recharts-area-curve").first().getAttribute("d");
  const points = [...path!.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
  const xPositions = [...new Set(points.map(point => point.x))];
  expect(xPositions).toHaveLength(3);
  expect((xPositions[1] - xPositions[0]) / (xPositions[2] - xPositions[0])).toBeCloseTo(1 / 3, 3);
  expect(points.length).toBeGreaterThan(3);
  await expect.poll(() => page.evaluate(() => window.__projectTest.detailCalls.some(filter => filter.project === "PinLens" && filter.startDate === "2026-10-16" && filter.endDate === "2026-10-16"))).toBe(true);
  await curve.screenshot({ path: info.outputPath("project-intraday-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await curve.screenshot({ path: info.outputPath("project-intraday-mobile.png") });
});

test("same-instant usage retains every contribution in keyboard and pointer tooltips", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/projects");
  await expect(page.getByRole("link", { name: "PinLens", exact: true })).toBeVisible();
  await page.evaluate(() => { window.__projectTest.duplicateTimestamp = true; });
  await page.getByRole("link", { name: "PinLens", exact: true }).click();
  await expect(metric(page, "所選期間 Tokens")).toHaveText("800");
  await customRange(page, "2026-10-16", "2026-10-16");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("700");
  const curve = projectCurve(page);
  const paths = curve.locator(".recharts-area-curve");
  await expect(paths).toHaveCount(4);
  const path = await paths.first().getAttribute("d");
  expect(new Set([...path!.matchAll(/[ML]([\d.]+),/g)].map(match => Number(match[1]))).size).toBe(2);
  await page.mouse.move(0, 0);
  await curve.locator(".recharts-surface").focus();
  const tooltip = curve.locator(".chart-tooltip");
  await expect(tooltip).toContainText("09:30:00");
  await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText("200");
  await page.keyboard.press("ArrowRight");
  await expect(tooltip).toContainText("10:00:00");
  await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText("700");
  const endpoints = await paths.evaluateAll(nodes => nodes.map(node => {
    const path = node as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength());
    return { x: point.x, y: point.y };
  }));
  const box = await curve.locator(".recharts-surface").boundingBox();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.mouse.move(box!.x + endpoints[0].x - 1, box!.y + endpoints[0].y);
  await expect(tooltip.locator(".chart-tooltip-total b")).toHaveText("700");
  await expect(tooltip.locator("span").filter({ hasText: /^Input/ }).locator("b")).toHaveText("630");
  await expect(tooltip.locator("span").filter({ hasText: /^Output/ }).locator("b")).toHaveText("70");
  await expect(tooltip.locator("span").filter({ hasText: /^Reasoning/ }).locator("b")).toHaveText("14");
  const activeDots = curve.locator(".recharts-active-dot circle");
  await expect(activeDots).toHaveCount(4);
  const coordinates = await activeDots.evaluateAll(nodes => nodes.map(node => ({ x: Number(node.getAttribute("cx")), y: Number(node.getAttribute("cy")) })));
  coordinates.forEach((point, index) => {
    expect(point.x).toBeCloseTo(endpoints[index].x, 2);
    expect(point.y).toBeCloseTo(endpoints[index].y, 2);
  });
});

test("project column headers sort both ways and retain filters through drilldown", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/projects");
  const table = page.getByRole("region", { name: "專案用量與成本", exact: true });
  const names = table.locator("tbody td:first-child a");
  const byName = ["PinLens", "另一個專案", specialProject].sort((a, b) => a.localeCompare(b));
  const tied = byName.filter(name => name !== "PinLens");
  const byAmount = ["PinLens", "另一個專案", specialProject];
  await expect(names).toHaveText(byAmount);
  await expect(table.getByRole("columnheader", { name: "Tokens", exact: true })).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByRole("combobox", { name: "專案排序", exact: true })).toHaveCount(0);
  const cases = [
    { label: "專案", key: "name", orders: [["asc", byName], ["desc", [...byName].reverse()]] },
    { label: "Sessions", key: "sessions", orders: [["desc", ["PinLens", ...tied]], ["asc", [...tied, "PinLens"]]] },
    { label: "來源", key: "source", orders: [["asc", [...tied, "PinLens"]], ["desc", ["PinLens", ...tied]]] },
    { label: "最後活動", key: "latest", orders: [["desc", ["PinLens", ...tied]], ["asc", [...tied, "PinLens"]]] },
    { label: "Tokens", key: "tokens", orders: [["desc", byAmount], ["asc", [...byAmount].reverse()]] },
    { label: "API 等值估算", key: "cost", orders: [["desc", byAmount], ["asc", [...byAmount].reverse()]] },
  ] as const;
  for (const item of cases) {
    const header = table.getByRole("columnheader", { name: item.label, exact: true });
    for (const [direction, expected] of item.orders) {
      await header.getByRole("button", { name: item.label, exact: true }).click();
      await expect(header).toHaveAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
      await expect(header.locator("svg")).toBeVisible();
      await expect(names).toHaveText([...expected]);
      expect(new URL(page.url()).searchParams.get("sort")).toBe(item.key);
      expect(new URL(page.url()).searchParams.get("direction")).toBe(direction);
    }
  }
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("project-header-sort-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const item of cases) {
    const button = table.getByRole("button", { name: item.label, exact: true });
    await expect(button).toBeVisible();
    expect(await button.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  const tokenHeader = table.getByRole("columnheader", { name: "Tokens", exact: true });
  await tokenHeader.getByRole("button", { name: "Tokens", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(tokenHeader).toHaveAttribute("aria-sort", "descending");
  await expect(names).toHaveText(byAmount);
  await page.keyboard.press("Enter");
  await expect(tokenHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(names).toHaveText([...byAmount].reverse());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: info.outputPath("project-header-sort-mobile.png"), fullPage: true });
  await page.getByLabel("搜尋專案", { exact: true }).fill("Pin");
  await expect(names).toHaveText(["PinLens"]);
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("local");
  await expect(table.locator("tbody tr")).toContainText("300");
  await table.getByRole("button", { name: "專案", exact: true }).click();
  const listUrl = page.url();
  const params = new URL(listUrl).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ q: "Pin", source: "local", sort: "name", direction: "asc" });
  await table.getByRole("link", { name: "PinLens", exact: true }).click();
  await expect(metric(page, "所選期間 Tokens")).toHaveText("300");
  await page.getByRole("link", { name: "返回專案", exact: true }).click();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByLabel("搜尋專案", { exact: true })).toHaveValue("Pin");
  await expect(page.getByRole("combobox", { name: "來源", exact: true })).toHaveValue("local");
  await expect(table.getByRole("columnheader", { name: "專案", exact: true })).toHaveAttribute("aria-sort", "ascending");
  await page.reload();
  await expect(page).toHaveURL(listUrl);
  await expect(names).toHaveText(["PinLens"]);
  expect(errors).toEqual([]);
});
