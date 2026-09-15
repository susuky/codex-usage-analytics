import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DataProvider, useUsageData } from "./data";
import { getOverview, getSettings, scanSources } from "./api";
import { buildDemoOverview } from "./mockData";
import type { OverviewData } from "../types";

vi.mock("./api", () => ({ getOverview:vi.fn(),getSettings:vi.fn(),scanSources:vi.fn() }));
function Probe() {
  const { filter,setFilter,data,scanning,error,refresh }=useUsageData();
  return <><button onClick={() => setFilter({days:30})}>30</button><button onClick={() => setFilter({days:7})}>7</button>
    <button onClick={() => void refresh(true)}>scan</button><output>{filter.days}:{data?.totals.totalTokens ?? "loading"}</output><span>{scanning ? "busy" : "idle"}</span><p>{error}</p></>;
}
beforeEach(() => { vi.mocked(getSettings).mockResolvedValue({pollMinutes:15} as Awaited<ReturnType<typeof getSettings>>); vi.mocked(scanSources).mockReturnValue(new Promise(() => {})); });
afterEach(() => vi.resetAllMocks());
it("rejects old filter responses arriving after the current filter",async () => {
  const pending:Array<{days:number;resolve:(data:OverviewData)=>void}>=[];
  vi.mocked(getOverview).mockImplementation((filter) => new Promise((resolve) => pending.push({days:filter.days,resolve})));
  render(<DataProvider><Probe /></DataProvider>);
  fireEvent.click(screen.getByText("30")); fireEvent.click(screen.getByText("7"));
  const snapshot=(value:number) => { const data=buildDemoOverview(); data.totals.totalTokens=value; return data; };
  await act(async () => pending.find((p) => p.days===7)!.resolve(snapshot(7)));
  await act(async () => pending.find((p) => p.days===30)!.resolve(snapshot(30)));
  expect(screen.getByRole("status")).toHaveTextContent("7:7");
});
it("reloads after pricing changes without scanning and reports failures over existing data",async () => {
  vi.mocked(getOverview).mockResolvedValue(buildDemoOverview());
  vi.mocked(scanSources).mockRejectedValue(new Error("遠端作業逾時"));
  render(<DataProvider><Probe /></DataProvider>);
  await waitFor(() => expect(screen.getByText("遠端作業逾時")).toBeVisible());
  expect(screen.getByText("idle")).toBeVisible();
  const calls=vi.mocked(getOverview).mock.calls.length;
  await act(async () => window.dispatchEvent(new Event("usage-settings-changed")));
  expect(vi.mocked(getOverview).mock.calls.length).toBeGreaterThan(calls);
  expect(scanSources).toHaveBeenCalledTimes(1);
});
