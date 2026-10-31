import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATABASE_URL, loadApiEnv } from "./load-env";

loadApiEnv();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing environment variable ${name}. Set it in apps/api/.env (see .env.example).`);
  return v;
}

export const env = {
  databaseUrl: req("WINDVEAL_DATABASE_URL", DEFAULT_DATABASE_URL),
  sessionSecret: req("SESSION_SECRET", "dev-only-secret"),
  appUrl: req("APP_URL", "http://localhost:5173"),
  siteUrl: req("SITE_URL", "http://localhost:5174"),
  port: Number(process.env.API_PORT ?? 4000),
  // Relative to apps/api, whichever folder the command runs from.
  storageDir: path.resolve(repoRoot, "apps/api", process.env.STORAGE_DIR ?? "./storage"),
  /** Folder with editable data files (pricing.json, organisation files). */
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(repoRoot, "data")),
  isProd: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  /** Sign-in, sign-up and code attempts allowed per minute from one address (raised for automated tests). */
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT ?? (process.env.NODE_ENV === "test" || process.env.VITEST === "true" ? 10_000 : 10)),
};
