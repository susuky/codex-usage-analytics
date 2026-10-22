import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopSettings } from "./DesktopSettings";
import { getDesktopPreferences, saveDesktopPreferences } from "../lib/desktop";

vi.mock("../lib/desktop", () => ({ getDesktopPreferences: vi.fn(), saveDesktopPreferences: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDesktopPreferences).mockResolvedValue({ launchAtStartup: false, closeToTray: true });
  vi.mocked(saveDesktopPreferences).mockImplementation(async preferences => preferences);
});

it("saves startup and background preferences independently and uses the confirmed native state", async () => {
  render(<DesktopSettings />);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).toBeEnabled());
  expect(screen.getByRole("checkbox", { name: "關閉視窗後繼續執行" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "開機時自動啟動" }));
  await screen.findByText("啟動與背景執行設定已保存。");
  expect(saveDesktopPreferences).toHaveBeenLastCalledWith({ launchAtStartup: true, closeToTray: true });
  expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "關閉視窗後繼續執行" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "關閉視窗後繼續執行" })).not.toBeChecked());
  expect(saveDesktopPreferences).toHaveBeenLastCalledWith({ launchAtStartup: true, closeToTray: false });
});

it("blocks overlapping changes and keeps the saved value after an OS write failure", async () => {
  let rejectSave!: (error: Error) => void;
  vi.mocked(saveDesktopPreferences).mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; }));
  render(<DesktopSettings />);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).toBeEnabled());
  fireEvent.click(screen.getByRole("checkbox", { name: "開機時自動啟動" }));
  expect(screen.getByRole("checkbox", { name: "關閉視窗後繼續執行" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).not.toBeChecked();
  rejectSave(new Error("無法設定開機啟動，請重試。"));
  expect(await screen.findByRole("alert")).toHaveTextContent("無法設定開機啟動，請重試。");
  expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "關閉視窗後繼續執行" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).toBeEnabled();
});

it("offers a retry when the native settings cannot load", async () => {
  vi.mocked(getDesktopPreferences).mockRejectedValueOnce(new Error("read failed"));
  render(<DesktopSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("無法讀取啟動設定，請重試。");
  fireEvent.click(screen.getByRole("button", { name: "重新讀取啟動設定" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).toBeEnabled());
});

it("shows unavailable desktop controls in a browser without saving pretend preferences", async () => {
  vi.mocked(getDesktopPreferences).mockResolvedValue(null);
  render(<DesktopSettings />);
  await screen.findByText("請在桌面版設定開機啟動與背景執行。");
  expect(screen.getByRole("checkbox", { name: "開機時自動啟動" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "關閉視窗後繼續執行" })).toBeDisabled();
  expect(saveDesktopPreferences).not.toHaveBeenCalled();
});
