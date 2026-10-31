// Recreates the throwaway e2e database and loads the fictional test business. Runs before Playwright starts the servers.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.E2E_DATABASE_URL ?? "postgres://windveal:windveal@localhost:5433/windveal_e2e";
const name = new URL(url).pathname.slice(1);
const admin = postgres(url.replace(`/${name}`, "/postgres"), { onnotice: () => {} });
await admin.unsafe(`drop database if exists "${name}" with (force)`);
await admin.unsafe(`create database "${name}"`);
await admin.end();
const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/api");
const env = { ...process.env, WINDVEAL_DATABASE_URL: url };
execSync("npx drizzle-kit push --force", { cwd: api, stdio: "ignore", env });
execSync("npx tsx test/fixtures/sample-business.ts", { cwd: api, stdio: "inherit", env });
// The test business's admin also gets WindVeal admin access, so the admin panel screens are covered.
const db = postgres(url, { onnotice: () => {} });
await db`update users set platform_admin = true where email = 'admin@example-trading.test'`;
await db.end();
