import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelDistribution } from "./ModelDistribution";
import { getOverview } from "../lib/api";
import { useUsageData } from "../lib/data";
import { buildDemoOverview } from "../lib/mockData";
import type { OverviewData } from "../types";

vi.mock("../lib/api", () => ({ getOverview: vi.fn() }));
vi.mock("../lib/data", () => ({ useUsageData: vi.fn() }));

const overview = buildDemoOverview();
const filter = { days: 30, sourceId: "local", project: "test-project" };
const setFilter = vi.fn();
const context: ReturnType<typeof useUsageData> = { data: overview, filter, setFilter, loading: false, scanning: false, pollMinutes: 15, error: null, refresh: vi.fn(async () => {}), reload: vi.fn(async () => {}) };
const dates = ["2026-10-01", "2026-10-02"];
function Panel({ date }: { date: string }) {
  return <MemoryRouter><ModelDistribution date={date} dates={dates} onDateChange={vi.fn()} /></MemoryRouter>;
}
function dayData(model: string, total: number): OverviewData {
  const tokens = { inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total };
  return { ...overview, totals: tokens, models: total ? [{ ...overview.models[0], model, tokens }] : [] };
}
beforeEach(() => {
  vi.mocked(useUsageData).mockReturnValue(context);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("sorts models without mutating the source and discloses every model", () => {
  const template = overview.models[0];
  const models = Array.from({ length: 8 }, (_, index) => ({ ...template, model: `model-${index}`, tokens: { ...template.tokens, totalTokens: (index + 1) * 100 } }));
  vi.mocked(useUsageData).mockReturnValue({ ...context, data: { ...overview, models, totals: { ...overview.totals, totalTokens: 3600 } } });
  const { container } = render(<Panel date="" />);
  expect(container.querySelectorAll("li")).toHaveLength(6);
  expect(container.querySelector("li")).toHaveTextContent("model-7");
  expect(models[0].model).toBe("model-0");
  fireEvent.click(screen.getByRole("button", { name: "顯示全部 8 個模型" }));
  expect(container.querySelectorAll("li")).toHaveLength(8);
  expect(screen.getByRole("button", { name: "收合模型" })).toHaveAttribute("aria-expanded", "true");
});

it("keeps tiny nonzero shares distinct from zero", () => {
  const model = overview.models[0];
  vi.mocked(useUsageData).mockReturnValue({ ...context, data: { ...overview, models: [{ ...model, tokens: { ...model.tokens, totalTokens: 1 } }], totals: { ...overview.totals, totalTokens: 1000000 } } });
  render(<Panel date="" />);
  expect(screen.getByText("<0.1%")).toBeVisible();
  expect(screen.getByText("1 Tokens")).toBeVisible();
});

it("shows an explicit empty state without a misleading ranking", () => {
  vi.mocked(useUsageData).mockReturnValue({ ...context, data: dayData("", 0) });
  render(<Panel date="" />);
  expect(screen.getByText("此區間尚無模型用量")).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("keeps the latest selected day when responses arrive out of order", async () => {
  const pending: Array<(data: OverviewData) => void> = [];
  vi.mocked(getOverview).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const view = render(<Panel date={dates[0]} />);
  expect(screen.getByText("正在載入當日模型用量…")).toBeVisible();
  expect(getOverview).toHaveBeenLastCalledWith({ ...filter, startDate: dates[0], endDate: dates[0] });
  view.rerender(<Panel date={dates[1]} />);
  await act(async () => pending[1](dayData("day-two-model", 250)));
  expect(screen.getAllByText("250 Tokens")[0]).toBeVisible();
  await act(async () => pending[0](dayData("stale-model", 100)));
  expect(screen.getByText("day-two-model")).toBeVisible();
  expect(screen.queryByText("stale-model")).not.toBeInTheDocument();
  expect(setFilter).not.toHaveBeenCalled();
  view.rerender(<Panel date="" />);
  expect(screen.queryByText("day-two-model")).not.toBeInTheDocument();
  expect(screen.getByText(overview.models[0].model)).toBeVisible();
});

it("shows a recoverable error and a truthful empty day", async () => {
  vi.mocked(getOverview).mockRejectedValueOnce(new Error("internal database error")).mockResolvedValueOnce(dayData("", 0));
  render(<Panel date={dates[0]} />);
  await screen.findByText("暫時無法載入當日模型用量。");
  expect(screen.queryByText("internal database error")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重試" }));
  await screen.findByText("這一天沒有模型用量");
  expect(screen.getByText("0 Tokens")).toBeVisible();
  expect(getOverview).toHaveBeenCalledTimes(2);
});

it("refreshes the selected day after a new overview and carries its date into Sessions", async () => {
  vi.mocked(getOverview).mockResolvedValueOnce(dayData("first-model", 100));
  const view = render(<Panel date={dates[0]} />);
  await screen.findByText("first-model");
  let finish!: (data: OverviewData) => void;
  vi.mocked(getOverview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(useUsageData).mockReturnValue({ ...context, data: { ...overview } });
  view.rerender(<Panel date={dates[0]} />);
  expect(screen.queryByText("first-model")).not.toBeInTheDocument();
  expect(screen.getByText("正在載入當日模型用量…")).toBeVisible();
  await act(async () => finish(dayData("updated-model", 150)));
  fireEvent.click(screen.getByRole("link", { name: "查看 updated-model 的 Sessions" }));
  expect(setFilter).toHaveBeenCalledWith({ ...filter, startDate: dates[0], endDate: dates[0] });
});
