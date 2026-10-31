import { defineConfig } from "drizzle-kit";
import { DEFAULT_DATABASE_URL, loadApiEnv } from "./src/load-env";

loadApiEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.WINDVEAL_DATABASE_URL ?? DEFAULT_DATABASE_URL },
});
