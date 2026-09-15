import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SyncPage from "./SyncPage";
import { buildDemoOverview } from "../lib/mockData";
import type { OverviewData } from "../types";

const { state } = vi.hoisted(() => ({ state: { data: null as OverviewData | null } }));
vi.mock("../lib/data", () => ({ useUsageData: () => ({ ...state, scanning: false, refresh: vi.fn() }) }));
vi.mock("../lib/cloud", () => ({ useCloud: () => ({ status: { enabled: false, signedIn: false, pendingRows: 0 }, syncNow: vi.fn() }) }));
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));

beforeEach(() => { state.data = buildDemoOverview(); });
afterEach(cleanup);

it("shows imported data without calling a partial scan unscanned", () => {
  state.data!.sources = [{ ...state.data!.sources[0], lastScannedAt: null, latestDataAt: "2026-09-05T12:00:00Z", stale: true, lastError: "1 份紀錄未能更新，已保留先前統計" }];
  render(<SyncPage />);
  expect(screen.getByText("尚無完整掃描紀錄")).toBeVisible();
  expect(screen.getByText(/資料最新至/)).toBeVisible();
  expect(screen.queryByText("尚未掃描")).not.toBeInTheDocument();
});

it("labels the successful scan separately from the latest token timestamp", () => {
  state.data!.sources = [state.data!.sources[0]];
  render(<SyncPage />);
  expect(screen.getByText(/上次成功掃描於/)).toBeVisible();
  expect(screen.getByText(/資料最新至/)).toBeVisible();
});

it("keeps stale and disabled sources distinct from healthy sources", () => {
  const source = state.data!.sources[0];
  state.data!.sources = [{ ...source, stale: true, lastError: null }, { ...source, id: "disabled", enabled: false, lastError: "old error" }];
  render(<SyncPage />);
  expect(screen.getByText("待更新")).toBeVisible();
  expect(screen.getByText("已停用", { exact: true })).toBeVisible();
  expect(screen.queryByText("正常")).not.toBeInTheDocument();
  expect(screen.queryByText("old error")).not.toBeInTheDocument();
});

it("discloses connection errors without hiding the warning status", () => {
  state.data!.sources = [{ ...state.data!.sources[0], lastError: "connection diagnostic", stale: true }];
  const { container } = render(<SyncPage />);
  expect(screen.getByText("需要處理")).toBeVisible();
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("查看問題詳情"));
  expect(container.querySelector("details")).toHaveAttribute("open");
  expect(screen.getByText("connection diagnostic")).toBeVisible();
});
