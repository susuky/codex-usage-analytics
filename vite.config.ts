import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envDir: process.env.CODEX_USAGE_ENV_DIR || process.cwd(),
  envPrefix: ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_AUTH_CALLBACK_URL", "TAURI_ENV_"],
  build: { target: "es2021", sourcemap: false, chunkSizeWarningLimit: 900 },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
    css: true
  }
});
