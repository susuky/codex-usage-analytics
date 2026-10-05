import { afterEach, beforeEach, expect, it } from "vitest";
import { getOverview, getSettings, saveSettings, scanSources } from "./api";
import type { SshSourceConfig } from "../types";

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

it("starts with only local sample usage and no configured remote machines", async () => {
  expect((await getSettings()).sshSources).toEqual([]);
  const data = await getOverview({ days: 365 });
  expect(data.sources.map(source => source.id)).toEqual(["local"]);
  expect(data.sources[0].sessionCount).toBe(data.sessions.length);
  expect(data.sessions.every(session => session.sourceId === "local")).toBe(true);
});

it("uses saved remote names and targets without inventing remote usage or scan success", async () => {
  const sources: SshSourceConfig[] = [
    { id: "saved-a", name: "Lab Linux", target: "operator@lab-linux", codexHome: "/data/codex", enabled: true },
    { id: "saved-b", name: "Lab Windows", target: "lab-windows", codexHome: "", enabled: false },
    { id: "saved-c", name: "Lab WSL", target: "lab-wsl", codexHome: "", enabled: true }
  ];
  const settings = { ...await getSettings(), sshSources: sources };
  await saveSettings(settings);
  expect((await getSettings()).sshSources).toEqual(sources);
  const data = await getOverview({ days: 365 });
  expect(data.sources.slice(1)).toEqual(sources.map(source => ({
    id: source.id, name: source.name, kind: "ssh", target: source.target, enabled: source.enabled,
    stale: true, lastScannedAt: null, lastError: null, sessionCount: 0, latestDataAt: null
  })));
  const scan = await scanSources();
  expect(scan.sources.slice(1)).toEqual(data.sources.slice(1));
  expect((await getOverview({ days: 365, sourceId: sources[0].id })).sessions).toEqual([]);
  await saveSettings({ ...settings, sshSources: [{ ...sources[0], name: "Renamed lab", target: "operator@renamed-lab" }] });
  expect((await getOverview({ days: 365 })).sources.slice(1)).toEqual([
    expect.objectContaining({ id: "saved-a", name: "Renamed lab", target: "operator@renamed-lab" })
  ]);
});

it("derives a legacy source from its saved target and preserves an explicitly empty source list", async () => {
  sessionStorage.setItem("codex-usage-settings", JSON.stringify({ sshTarget: "operator@legacy-lab", sshEnabled: true }));
  const migrated = await getSettings();
  expect(migrated.sshSources).toEqual([{ id: "ssh-legacy-lab", name: "legacy-lab", target: "operator@legacy-lab", codexHome: "", enabled: true }]);
  await saveSettings({ ...migrated, sshSources: [] });
  expect((await getSettings()).sshSources).toEqual([]);
  expect((await getOverview({ days: 365 })).sources.map(source => source.id)).toEqual(["local"]);
});
