import { useState, type MouseEvent, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Activity, BarChart3, Box, ChartNoAxesCombined, PanelLeftClose, PanelLeftOpen, CircleGauge, Minus, RefreshCw, Settings, Square, TerminalSquare, X } from "lucide-react";
import styles from "./AppShell.module.css";

const navigation = [
  { to: "/", label: "總覽", icon: CircleGauge, end: true },
  { to: "/trends", label: "趨勢", icon: ChartNoAxesCombined },
  { to: "/sessions", label: "Sessions", icon: BarChart3 },
  { to: "/models", label: "模型", icon: Box },
  { to: "/activity", label: "活動", icon: Activity },
  { to: "/sync", label: "同步", icon: RefreshCw },
  { to: "/settings", label: "設定", icon: Settings }
];

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function runWindowAction(action: "minimize" | "toggleMaximize" | "close") {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  if (action === "minimize") void appWindow.minimize();
  else if (action === "toggleMaximize") void appWindow.toggleMaximize();
  else void appWindow.close();
}

function handleTitlebarMouseDown(event: MouseEvent<HTMLElement>) {
  if (!isTauri() || event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;

  const appWindow = getCurrentWindow();
  if (event.detail === 2) void appWindow.toggleMaximize();
  else void appWindow.startDragging();
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.("(max-width: 1100px)").matches ?? false);
  return (
    <div className={styles.window}>
      <a className={styles.skipLink} href="#main-content">跳至主要內容</a>
      <header className={styles.titlebar} data-tauri-drag-region onMouseDown={handleTitlebarMouseDown}>
        <div className={styles.brandMark} data-tauri-drag-region><TerminalSquare size={20} strokeWidth={1.8} /></div>
        <span data-tauri-drag-region>Codex 用量分析</span>
        <div className={styles.windowControls}>
          <button type="button" aria-label="最小化視窗" onClick={() => runWindowAction("minimize")}><Minus size={15} strokeWidth={1.4} /></button>
          <button type="button" aria-label="最大化或還原視窗" onClick={() => runWindowAction("toggleMaximize")}><Square size={12} strokeWidth={1.35} /></button>
          <button type="button" aria-label="關閉視窗" className={styles.closeButton} onClick={() => runWindowAction("close")}><X size={16} strokeWidth={1.35} /></button>
        </div>
      </header>
      <div className={`${styles.body} ${collapsed ? styles.collapsed : ""}`}>
        <aside className={styles.sidebar}>
          <nav aria-label="主要導覽">
            {navigation.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} aria-label={label} title={collapsed ? label : undefined} className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}>
                <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <button type="button" className={styles.sidebarBottom} aria-label={collapsed ? "展開側欄" : "收合側欄"} aria-expanded={!collapsed} title={collapsed ? "展開側欄" : "收合側欄"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}<span>收合側欄</span></button>
        </aside>
        <main className={styles.main} id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
