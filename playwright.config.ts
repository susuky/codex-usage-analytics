import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:1420", screenshot: "only-on-failure" },
  webServer: {
    command: "node scripts/preview-server.mjs",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: true
  }
});
