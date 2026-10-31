import { execSync } from "node:child_process";
import postgres from "postgres";

/** Creates the test database (if needed) and syncs the schema before tests run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://windveal:windveal@localhost:5433/windveal_test";
  const dbName = new URL(url).pathname.slice(1);
  const admin = postgres(url.replace(`/${dbName}`, "/postgres"), { onnotice: () => {} });
  const [exists] = await admin`select 1 from pg_database where datname = ${dbName}`;
  if (!exists) await admin.unsafe(`create database "${dbName}"`);
  await admin.end();
  execSync("npx drizzle-kit push --force", { stdio: "ignore", env: { ...process.env, WINDVEAL_DATABASE_URL: url } });
}
