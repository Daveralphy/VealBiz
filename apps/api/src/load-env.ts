import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads apps/api/.env by its own location, so it works no matter which folder a command runs from.
 * Values already set in the environment win (tests and scripts use that to point at other databases).
 */
export function loadApiEnv() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

/** WindVeal uses its own variable name so a general DATABASE_URL from another project can't interfere. */
export const DEFAULT_DATABASE_URL = "postgres://windveal:windveal@localhost:5433/windveal";
