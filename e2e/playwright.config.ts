import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests drive the real apps in Microsoft Edge (installed with Windows).
 * They run against a separate database (windveal_e2e) seeded with demo data — see e2e/prepare.mjs.
 */
const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgres://windveal:windveal@localhost:5433/windveal_e2e";
// Own ports, so the tests can run while `pnpm dev` is using 4000, 5173 and 5174.
const PORTS = { API_PORT: "4100", WEB_PORT: "5273", SITE_PORT: "5274" };
const APP_URL = `http://localhost:${PORTS.WEB_PORT}`;
const SITE_URL = `http://localhost:${PORTS.SITE_PORT}`;
const SHARED = { ...PORTS, APP_URL, SITE_URL, VITE_APP_URL: APP_URL, VITE_SITE_URL: SITE_URL, E2E_API_URL: `http://localhost:${PORTS.API_PORT}` };
Object.assign(process.env, { E2E_APP_URL: APP_URL, E2E_SITE_URL: SITE_URL, E2E_API_URL: SHARED.E2E_API_URL });

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: "msedge",
    baseURL: APP_URL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @windveal/api start",
      url: `${SHARED.E2E_API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      // Many sign-ins in a few minutes: lift the per-minute sign-in limit for the test server only.
      env: { ...SHARED, WINDVEAL_DATABASE_URL: E2E_DB, STORAGE_DIR: "./storage-e2e", AUTH_RATE_LIMIT: "1000", AI_BASE_URL: "" },
      cwd: "..",
    },
    { command: "pnpm --filter @windveal/web dev", url: APP_URL, reuseExistingServer: false, timeout: 60_000, cwd: "..", env: SHARED },
    { command: "pnpm --filter @windveal/site dev", url: SITE_URL, reuseExistingServer: false, timeout: 60_000, cwd: "..", env: SHARED },
  ],
});
