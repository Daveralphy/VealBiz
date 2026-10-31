import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests use their own database so they never touch development or pilot data.
    env: {
      WINDVEAL_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://windveal:windveal@localhost:5433/windveal_test",
      STORAGE_DIR: "./storage-test",
      NODE_ENV: "test",
    },
    globalSetup: "./test/global-setup.ts",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
