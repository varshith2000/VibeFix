import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Tiny .env loader — no dependency. Walks up from cwd to the workspace root,
 * finds the first .env, and exports KEY=VALUE lines into process.env WITHOUT
 * overriding variables already set in the real environment. Values may be
 * quoted; blank lines and #comments are ignored.
 */
export function loadEnvFile(): void {
  let dir = process.cwd();
  const candidates: string[] = [];
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, ".env"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const envFile = candidates.find((c) => existsSync(c));
  if (!envFile) return;

  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
