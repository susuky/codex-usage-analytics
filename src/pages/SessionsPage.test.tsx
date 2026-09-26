import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildDemoOverview } from "../lib/mockData";
import { formatTokens } from "../lib/format";
import type { OverviewData, SessionAggregate } from "../types";
import { SessionsPage } from "./SessionsPage";

const { state, queryModel } = vi.hoisted(() => ({ state: { data: null as OverviewData | null, filter: { days: 365 }, loading: false, error: null as string | null, reload: vi.fn() }, queryModel: vi.fn() }));
vi.mock("../lib/data", () => ({ useUsageData: () => state }));
vi.mock("../lib/api", () => ({ listSessions: queryModel }));
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
beforeEach(() => {
  state.data = buildDemoOverview(); state.loading = false; state.error = null; state.reload.mockReset();
  queryModel.mockReset().mockImplementation(async filter => state.data!.sessions.filter(session => session.model === filter.model));
});
afterEach(cleanup);

it("clamps an out-of-range page and totals all results rather than the visible page", () => {
  const { container } = render(<MemoryRouter initialEntries={["/sessions?page=999"]}><SessionsPage /></MemoryRouter>);
  expect(container.querySelectorAll("tbody tr")).toHaveLength(17);
  expect(screen.getByText("第 2 / 2 頁")).toBeVisible();
  expect(screen.getByRole("region", { name: "篩選結果摘要" })).toHaveTextContent(formatTokens(state.data!.totals.totalTokens));
  fireEvent.change(screen.getByLabelText("來源", { exact: true }), { target: { value: "ssh-example-server" } });
  expect(container.querySelectorAll("tbody tr")).toHaveLength(11);
  expect(screen.getByText("第 1 / 1 頁")).toBeVisible();
});

it("shows a retry instead of a false empty state after loading fails", () => {
  state.data = null;
  state.error = "read failed";
  render(<MemoryRouter><SessionsPage /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "暫時無法顯示紀錄" })).toBeVisible();
  expect(screen.queryByText("沒有符合條件的 Session")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新載入" }));
  expect(state.reload).toHaveBeenCalledOnce();
});

it("retains unavailable URL filters and offers a way to clear them", async () => {
  render(<MemoryRouter initialEntries={["/sessions?model=unavailable&source=removed"]}><SessionsPage /></MemoryRouter>);
  expect(screen.getByLabelText("模型", { exact: true })).toHaveValue("unavailable");
  expect(screen.getByLabelText("來源", { exact: true })).toHaveValue("removed");
  expect(await screen.findByRole("heading", { name: "沒有符合條件的 Session" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "顯示此區間全部紀錄" }));
  expect(screen.getByRole("heading", { name: "42 個 Sessions" })).toBeVisible();
});

it("uses turn-aware model matches even when the session model differs", async () => {
  const session = { ...state.data!.sessions[0], model: "gpt-5.6-terra" };
  queryModel.mockResolvedValue([session]);
  const { container } = render(<MemoryRouter initialEntries={["/sessions?model=gpt-5.6-sol"]}><SessionsPage /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "1 個 Sessions" })).toBeVisible();
  expect(queryModel).toHaveBeenCalledWith({ days: 365, model: "gpt-5.6-sol" });
  expect(container.querySelector("tbody")).toHaveTextContent("gpt-5.6-terra");
  expect(screen.getByText(/整段對話的累計用量/)).toBeVisible();
});

it("ignores a previous model response that arrives after a new filter", async () => {
  let finishOld!: (sessions: SessionAggregate[]) => void;
  const oldSession = { ...state.data!.sessions[0], project: "old model result" };
  const newSession = { ...state.data!.sessions[1], project: "new model result" };
  queryModel.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValueOnce([newSession]);
  render(<MemoryRouter initialEntries={["/sessions?model=gpt-5.6-sol"]}><SessionsPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("模型", { exact: true }), { target: { value: "gpt-5.6-terra" } });
  expect(await screen.findByRole("link", { name: "new model result" })).toBeVisible();
  await act(async () => { finishOld([oldSession]); });
  expect(screen.queryByRole("link", { name: "old model result" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "new model result" })).toBeVisible();
});

it("retries a model query failure without presenting it as zero results", async () => {
  queryModel.mockRejectedValueOnce(new Error("query failed")).mockResolvedValueOnce([state.data!.sessions[0]]);
  render(<MemoryRouter initialEntries={["/sessions?model=gpt-5.6-sol"]}><SessionsPage /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "暫時無法顯示紀錄" })).toBeVisible();
  expect(screen.queryByText("沒有符合條件的 Session")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新載入" }));
  expect(await screen.findByRole("heading", { name: "1 個 Sessions" })).toBeVisible();
});
