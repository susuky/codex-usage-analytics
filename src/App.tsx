import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { OverviewPage } from "./pages/OverviewPage";
import { SessionsPage } from "./pages/SessionsPage";
import { SessionDetailPage } from "./pages/SessionDetailPage";

const TrendsPage = lazy(() => import("./pages/TrendsPage"));
const ModelsPage = lazy(() => import("./pages/ModelsPage"));
const ActivityPage = lazy(() => import("./pages/ActivityPage"));
const SyncPage = lazy(() => import("./pages/SyncPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

export function App() {
  return (
    <AppShell>
      <Suspense fallback={<div className="page-loading">載入分析資料…</div>}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/trends" element={<TrendsPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:sourceId/:sessionId" element={<SessionDetailPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/sync" element={<SyncPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
