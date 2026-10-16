import { expect, test, type Page } from "@playwright/test";
import type { OverviewData, SessionAggregate, TokenBreakdown, UsageFilter } from "../src/types";

test.use({ timezoneId: "Asia/Taipei" });

const specialProject = "/工作區/分析#專案";
const range = { days: 2, startDate: "2026-10-15", endDate: "2026-10-16" };
const emptyTokens = (): TokenBreakdown => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

function session(id: string, project: string, sourceId: string, model: string, usage: Array<[string, number, number]>): SessionAggregate {
  const turns = usage.map(([date, totalTokens, estimateMicrousd], index) => ({
    ordinal: index + 1, timestamp: `${date}T01:00:00Z`, model, serviceTier: "default" as const, reasoningEffort: "high",
    tokens: { inputTokens: totalTokens * .9, cachedInputTokens: totalTokens * .5, cacheWriteInputTokens: 0, outputTokens: totalTokens * .1, reasoningOutputTokens: 0, totalTokens },
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
  session("pin-local", "PinLens", "local", "gpt-6.1-sol", [["2026-10-14", 300, 500_000], ["2026-10-15", 100, 400_000], ["2026-10-16", 200, 600_000]]),
  session("pin-remote", "PinLens", "remote-test", "gpt-6-astra", [["2026-10-16", 500, 2_000_000]]),
  session("another", "另一個專案", "local", "gpt-6.1-sol", [["2026-10-16", 200, 1_000_000]]),
  session("encoded", specialProject, "local", "gpt-6.1-sol", [["2026-10-16", 70, 500_000]]),
];

interface ProjectTestDriver {
  calls: UsageFilter[];
  rejectProject: boolean;
  hold: Partial<UsageFilter> | null;
  pending: number;
  release: () => Promise<void>;
}
declare global { interface Window { __projectTest: ProjectTestDriver } }

async function mockDesktop(page: Page) {
  await page.addInitScript(({ sessions, range }) => {
    localStorage.setItem("codex-usage-date-range-v1", JSON.stringify(range));
    const releases: Array<() => void> = [];
    const driver: ProjectTestDriver = window.__projectTest = {
      calls: [], rejectProject: false, hold: null, pending: 0,
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
        const turns = item.turns!.filter(turn => (!filter.startDate || turn.timestamp.slice(0, 10) >= filter.startDate) && (!filter.endDate || turn.timestamp.slice(0, 10) <= filter.endDate));
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
          return { date, uncachedInput: tokens.inputTokens - tokens.cachedInputTokens, cachedInput: tokens.cachedInputTokens, cacheWriteInput: 0, output: tokens.outputTokens, unclassified: 0, estimateMicrousd: turns.reduce((sum, turn) => sum + turn.estimateMicrousd!, 0), unpricedTokens: 0, sessions: turns.length };
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
        if (command === "get_overview") {
          const filter = args!.filter!;
          driver.calls.push(filter);
          if (filter.project && driver.rejectProject) throw new Error("測試查詢失敗");
          const result = overview(filter);
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
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
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
  await customRange(page, "2026-10-16", "2026-10-16");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("200");
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
  await page.getByRole("combobox", { name: "來源", exact: true }).selectOption("local");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("300");
  await page.evaluate(() => { window.__projectTest.hold = { startDate: "2026-10-15", endDate: "2026-10-15" }; });
  await customRange(page, "2026-10-15", "2026-10-15");
  await expect.poll(() => page.evaluate(() => window.__projectTest.pending)).toBeGreaterThan(0);
  await customRange(page, "2026-10-16", "2026-10-16");
  await expect(metric(page, "所選期間 Tokens")).toHaveText("200");
  await page.evaluate(() => window.__projectTest.release());
  await expect(metric(page, "所選期間 Tokens")).toHaveText("200");
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
