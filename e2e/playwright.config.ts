import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests drive the real apps in Microsoft Edge (installed with Windows).
 * They run against a separate database (windveal_e2e) seeded with demo data — see e2e/prepare.mjs.
 */
const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgres://windveal:windveal@localhost:5433/windveal_e2e";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: "msedge",
    baseURL: "http://localhost:5173",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @windveal/api start",
      url: "http://localhost:4000/api/health",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { WINDVEAL_DATABASE_URL: E2E_DB, STORAGE_DIR: "./storage-e2e" },
      cwd: "..",
    },
    { command: "pnpm --filter @windveal/web dev", url: "http://localhost:5173", reuseExistingServer: false, timeout: 60_000, cwd: ".." },
    { command: "pnpm --filter @windveal/site dev", url: "http://localhost:5174", reuseExistingServer: false, timeout: 60_000, cwd: ".." },
  ],
});
