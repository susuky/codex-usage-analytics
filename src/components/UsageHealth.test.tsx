import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { buildDemoOverview } from "../lib/mockData";
import { UsageHealth } from "./UsageHealth";

afterEach(cleanup);

it("links incomplete sources and unpriced usage to their details", () => {
  const data = buildDemoOverview();
  data.sources = [{ ...data.sources[0], stale: true }, { ...data.sources[0], id: "disabled", enabled: false, lastError: "old error" }];
  render(<MemoryRouter><UsageHealth data={data} scanning={false} /></MemoryRouter>);
  expect(screen.getByRole("link", { name: /1 個來源待更新/ })).toHaveAttribute("href", "/sync");
  expect(screen.getByRole("link", { name: /tokens 尚未定價/ })).toHaveAttribute("href", "/models");
  expect(screen.queryByText(/100.0%/)).not.toBeInTheDocument();
});

it("does not announce a completed scan while scanning", () => {
  render(<MemoryRouter><UsageHealth data={buildDemoOverview()} scanning /></MemoryRouter>);
  expect(screen.getByText("正在掃描來源")).toBeVisible();
  expect(screen.queryByText(/個來源已更新/)).not.toBeInTheDocument();
});

it("avoids a false 100% claim when a small amount remains unpriced", () => {
  const data = buildDemoOverview();
  data.models = data.models.map(model => ({ ...model, unpricedTokens: 1 }));
  render(<MemoryRouter><UsageHealth data={data} scanning={false} /></MemoryRouter>);
  expect(screen.getByText(">99.9% 的 Tokens 已估價")).toBeVisible();
});

it("does not invent coverage or ready sources for an empty account", () => {
  const data = buildDemoOverview();
  data.sources = [];
  data.models = [];
  data.totals = { ...data.totals, totalTokens: 0 };
  render(<MemoryRouter><UsageHealth data={data} scanning={false} /></MemoryRouter>);
  expect(screen.getByText("尚無用量")).toBeVisible();
  expect(screen.getByText("尚未啟用來源")).toBeVisible();
});
