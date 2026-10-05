import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";
import { defaultPricingRules, getSettings, getPricingStatus, refreshPricing, saveSettings } from "../lib/api";
import type { AppSettings, PricingStatus } from "../types";

vi.mock("../components/PageHeader", () => ({ PageHeader: () => <h1>設定</h1> }));
vi.mock("../lib/data", () => ({ useUsageData: () => ({ data: null }) }));
vi.mock("../lib/cloud", () => ({ useCloud: () => ({ status: { configured: false, signedIn: false } }) }));
vi.mock("../lib/api", async importOriginal => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getSettings: vi.fn(), getPricingStatus: vi.fn(), refreshPricing: vi.fn(), saveSettings: vi.fn() };
});

let saved: AppSettings;
let status: PricingStatus;
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  saved = { codexHome: "", sshSources: [], cloudEnabled: false, pollMinutes: 15, autoUpdatePricing: true, pricingRules: structuredClone(defaultPricingRules) };
  status = { checkedAt: null, updatedAt: null, lastError: null, officialRules: structuredClone(defaultPricingRules) };
  vi.mocked(getSettings).mockImplementation(async () => structuredClone(saved));
  vi.mocked(getPricingStatus).mockImplementation(async () => structuredClone(status));
  vi.mocked(saveSettings).mockImplementation(async next => { saved = structuredClone(next); });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

it("preserves a price draft during background updates and saves only that model", async () => {
  render(<SettingsPage />);
  fireEvent.change(await screen.findByLabelText("資料夾路徑（選填）"), { target: { value: "C:/my-codex" } });
  fireEvent.click(screen.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" }));
  fireEvent.change(screen.getByLabelText("gpt-5.6-sol input 價格"), { target: { value: "9" } });
  saved.pricingRules[0].inputUsdPerMillion = 12;
  saved.pricingRules[1].outputUsdPerMillion = 50;
  status = { ...status, updatedAt: "2026-09-29T00:00:00Z", officialRules: structuredClone(saved.pricingRules) };
  window.dispatchEvent(new Event("usage-pricing-updated"));
  await waitFor(() => expect(screen.getByText(/最近更新/)).toBeVisible());
  expect(screen.getByLabelText("gpt-5.6-sol input 價格")).toHaveValue(9);
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByText("gpt-5.6-sol 的價格已保存。");
  expect(saved.pricingRules.find(rule => rule.model === "gpt-5.6-sol")!.inputUsdPerMillion).toBe(9);
  expect(saved.pricingRules.find(rule => rule.model === "gpt-5.6-terra")!.outputUsdPerMillion).toBe(50);
  expect(saved.codexHome).toBe("");
  expect(screen.getByLabelText("資料夾路徑（選填）")).toHaveValue("C:/my-codex");
  expect(screen.getByText("尚有變更未保存")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "保存設定" }));
  await screen.findByText("設定已保存，既有費用已重新計算");
  expect(saved.codexHome).toBe("C:/my-codex");
  expect(screen.queryByText("尚有變更未保存")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("資料夾路徑（選填）"), { target: { value: "C:/another-codex" } });
  expect(screen.getByText("尚有變更未保存")).toBeVisible();
  expect(screen.queryByText("設定已保存，既有費用已重新計算")).not.toBeInTheDocument();
});

it("keeps the current form usable when the official source cannot be reached", async () => {
  vi.mocked(refreshPricing).mockRejectedValue(new Error("無法連線至官方定價，已保留上次價格。請稍後再試。"));
  render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "更新官方價格" }));
  await screen.findByText("無法連線至官方定價，已保留上次價格。請稍後再試。");
  fireEvent.click(screen.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" }));
  expect(screen.getByLabelText("gpt-5.6-sol input 價格")).toHaveValue(4);
});

it("retains the dialog draft after a save failure and allows retry", async () => {
  render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "編輯 gpt-5.6-sol 價格" }));
  fireEvent.change(screen.getByLabelText("gpt-5.6-sol input 價格"), { target: { value: "9" } });
  vi.mocked(saveSettings).mockRejectedValueOnce(new Error("無法保存價格，請再試一次。"));
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("gpt-5.6-sol input 價格")).toHaveValue(9);
  expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByText("gpt-5.6-sol 的價格已保存。");
});

it("validates required and duplicate models without creating zero-price drafts", async () => {
  render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "新增自訂價格" }));
  fireEvent.change(screen.getByLabelText("模型名稱"), { target: { value: "new-model" } });
  expect(screen.getByLabelText("new-model input 價格")).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByRole("alert");
  expect(saveSettings).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("模型名稱"), { target: { value: " GPT-5.6-SOL " } });
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  expect(screen.getByRole("alert")).toHaveTextContent("這個模型已經有價格");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(saveSettings).not.toHaveBeenCalled();
});

it("restores official prices without changing unsupported rate defaults or their availability", async () => {
  const official = { ...saved.pricingRules[0], cachedUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, priorityMultiplier: 1, unavailableRates: ["cached", "cacheWrite", "fast", "longFast"] };
  saved.pricingRules[0] = { ...official, inputUsdPerMillion: 9 };
  status.officialRules[0] = structuredClone(official);
  render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "編輯 gpt-5.6-sol 價格" }));
  fireEvent.click(screen.getByRole("button", { name: "使用官方價格與加價規則" }));
  expect(screen.getByLabelText("gpt-5.6-sol Priority 倍率")).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByText("gpt-5.6-sol 的價格已保存。");
  expect(saved.pricingRules.find(rule => rule.model === official.model)).toEqual(official);
});

it("validates and saves the long-context boundary and multipliers with an effective-price preview", async () => {
  render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "編輯 gpt-5.6-sol 價格" }));
  expect(screen.getByLabelText("gpt-5.6-sol 啟用長 context 加價")).toBeChecked();
  const threshold = screen.getByLabelText("gpt-5.6-sol 長 context 門檻");
  fireEvent.change(threshold, { target: { value: "128000.5" } });
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  expect(screen.getByRole("alert")).toHaveTextContent("正整數");
  expect(threshold).toHaveAttribute("aria-invalid", "true");
  expect(threshold).toHaveFocus();
  expect(saveSettings).not.toHaveBeenCalled();
  fireEvent.change(threshold, { target: { value: "128000" } });
  fireEvent.change(screen.getByLabelText("gpt-5.6-sol 長 context 輸入倍率"), { target: { value: "2.5" } });
  fireEvent.change(screen.getByLabelText("gpt-5.6-sol 長 context 輸出倍率"), { target: { value: "2" } });
  expect(screen.getByLabelText("長 context 單價")).toHaveTextContent("$10");
  expect(screen.getByLabelText("長 context 單價")).toHaveTextContent("$40");
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByText("gpt-5.6-sol 的價格已保存。");
  expect(saved.pricingRules.find(rule => rule.model === "gpt-5.6-sol")).toMatchObject({ longContextThreshold: 128000, longInputMultiplier: 2.5, longOutputMultiplier: 2 });
  expect(screen.getByRole("row", { name: /gpt-5.6-sol/ })).toHaveTextContent("輸入 > 128K");
});

it("can disable a surcharge then restore the official boundary and multipliers", async () => {
  render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "編輯 gpt-5.6-sol 價格" }));
  fireEvent.click(screen.getByLabelText("gpt-5.6-sol 啟用長 context 加價"));
  expect(screen.queryByLabelText("gpt-5.6-sol 長 context 門檻")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByText("gpt-5.6-sol 的價格已保存。");
  expect(saved.pricingRules.find(rule => rule.model === "gpt-5.6-sol")).toMatchObject({ longInputMultiplier: 1, longOutputMultiplier: 1 });
  fireEvent.click(screen.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" }));
  fireEvent.click(screen.getByRole("button", { name: "使用官方價格與加價規則" }));
  expect(screen.getByLabelText("gpt-5.6-sol 啟用長 context 加價")).toBeChecked();
  expect(screen.getByLabelText("gpt-5.6-sol 長 context 門檻")).toHaveValue(272000);
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByText("gpt-5.6-sol 的價格已保存。");
  expect(saved.pricingRules.find(rule => rule.model === "gpt-5.6-sol")).toEqual({ ...defaultPricingRules[0], unavailableRates: [] });
});

it("does not silently surcharge custom models and requires an explicit boundary when enabled", async () => {
  render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "新增自訂價格" }));
  fireEvent.change(screen.getByLabelText("模型名稱"), { target: { value: "my-model" } });
  fireEvent.change(screen.getByLabelText("my-model input 價格"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("my-model output 價格"), { target: { value: "5" } });
  expect(screen.getByLabelText("my-model 啟用長 context 加價")).not.toBeChecked();
  fireEvent.click(screen.getByLabelText("my-model 啟用長 context 加價"));
  expect(screen.getByLabelText("my-model 長 context 門檻")).toHaveValue(null);
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  expect(screen.getByRole("alert")).toHaveTextContent("輸入門檻");
  expect(saveSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("my-model 啟用長 context 加價"));
  fireEvent.click(screen.getByRole("button", { name: "保存價格" }));
  await screen.findByText("my-model 的價格已保存。");
  expect(saved.pricingRules.find(rule => rule.model === "my-model")).toMatchObject({ longContextThreshold: Number.MAX_SAFE_INTEGER, longInputMultiplier: 1, longOutputMultiplier: 1 });
});
