import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const windowActions = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  startDragging: vi.fn(),
  close: vi.fn()
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowActions
}));

describe("AppShell native title bar", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    Object.values(windowActions).forEach((mock) => mock.mockClear());
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("connects the three window buttons to Tauri", () => {
    render(<MemoryRouter><AppShell><p>內容</p></AppShell></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "最小化視窗" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化或還原視窗" }));
    fireEvent.click(screen.getByRole("button", { name: "關閉視窗" }));

    expect(windowActions.minimize).toHaveBeenCalledOnce();
    expect(windowActions.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowActions.close).toHaveBeenCalledOnce();
  });

  it("drags on a single press and maximizes on a double press", () => {
    const { container } = render(<MemoryRouter><AppShell><p>內容</p></AppShell></MemoryRouter>);
    const titlebar = container.querySelector("header");
    expect(titlebar).not.toBeNull();

    fireEvent.mouseDown(titlebar!, { button: 0, detail: 1 });
    fireEvent.mouseDown(titlebar!, { button: 0, detail: 2 });

    expect(windowActions.startDragging).toHaveBeenCalledOnce();
    expect(windowActions.toggleMaximize).toHaveBeenCalledOnce();
  });
});
