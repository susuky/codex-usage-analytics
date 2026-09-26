import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildDemoOverview } from "../lib/mockData";
import type { OverviewData } from "../types";
import { PageHeader } from "./PageHeader";

const { state } = vi.hoisted(() => ({ state: {
  data: null as OverviewData | null, filter: { days: 30 }, setFilter: vi.fn(), refresh: vi.fn(),
  loading: false, scanning: false, error: null as string | null,
} }));
vi.mock("../lib/data", () => ({ useUsageData: () => state }));
beforeEach(() => { state.data = buildDemoOverview(); state.loading = false; state.scanning = false; state.error = null; state.setFilter.mockReset(); state.refresh.mockReset(); });
afterEach(cleanup);
const renderHeader = () => render(<MemoryRouter><PageHeader title="用量總覽" /></MemoryRouter>);

it("offers a today preset and marks scanning as unfinished", () => {
  state.scanning = true;
  renderHeader();
  fireEvent.change(screen.getByLabelText("日期範圍"), { target: { value: "1" } });
  expect(state.setFilter).toHaveBeenCalledWith({ days: 1, startDate: undefined, endDate: undefined });
  expect(screen.getByRole("link", { name: "查看來源狀態：掃描中…" })).toHaveAttribute("href", "/sync");
  expect(screen.getByRole("button", { name: "正在掃描" })).toBeDisabled();
  expect(screen.queryByText("資料已更新")).not.toBeInTheDocument();
});

it("reports loading before source settings are known", () => {
  state.loading = true;
  state.data = null;
  renderHeader();
  expect(screen.getByText("載入中…")).toBeVisible();
  expect(screen.queryByText("未啟用來源")).not.toBeInTheDocument();
});

it("keeps an actionable warning while technical details are collapsed", () => {
  state.error = "diagnostic detail";
  const { container } = renderHeader();
  expect(screen.getByText("需要注意")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("請重試");
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(screen.getByText("diagnostic detail")).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重新掃描" }));
  expect(state.refresh).toHaveBeenCalledWith(true);
});

it("does not label disabled sources as synchronized", () => {
  state.data!.sources = state.data!.sources.map(source => ({ ...source, enabled: false }));
  renderHeader();
  expect(screen.getByRole("link", { name: "查看來源狀態：未啟用來源" })).toBeVisible();
  expect(screen.queryByText("資料已更新")).not.toBeInTheDocument();
});
