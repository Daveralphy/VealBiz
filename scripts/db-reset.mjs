// Deletes ALL WindVeal data on this computer: the database named in apps/api/.env,
// uploaded files (apps/api/storage) and the development mailbox. Then creates a fresh,
// empty database with the current tables. Usage: pnpm db:reset  (add --yes to skip the prompt)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = path.join(root, "apps/api");

function readEnv() {
  const file = path.join(api, ".env");
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = readEnv();
const url = process.env.WINDVEAL_DATABASE_URL ?? env.WINDVEAL_DATABASE_URL ?? "postgres://windveal:windveal@localhost:5433/windveal";
const name = new URL(url).pathname.slice(1);
const storage = path.resolve(api, env.STORAGE_DIR ?? "./storage");

if (!process.argv.includes("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This permanently deletes the "${name}" database and all uploaded files. Type DELETE to continue: `);
  rl.close();
  if (answer.trim() !== "DELETE") { console.log("Cancelled. Nothing was deleted."); process.exit(0); }
}

const admin = postgres(url.replace(`/${name}`, "/postgres"), { onnotice: () => {} });
await admin.unsafe(`drop database if exists "${name}" with (force)`);
await admin.unsafe(`create database "${name}"`);
await admin.end();
for (const dir of [storage, path.join(api, ".mailbox")]) fs.rmSync(dir, { recursive: true, force: true });
execSync("npx drizzle-kit push --force", { cwd: api, stdio: "ignore", env: { ...process.env, WINDVEAL_DATABASE_URL: url } });
console.log(`✓ "${name}" is now an empty database. Uploaded files and the dev mailbox were cleared.`);
