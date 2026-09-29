import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

export const PUBLIC_PATHS = new Set(["/api/health"]);

export function tokenFilePath(): string {
  return path.join(process.env.VIBEFIX_HOME ?? path.join(homedir(), ".vibefix"), "server-token");
}

export async function getApiToken(): Promise<string> {
  const fromEnv = process.env.VIBEFIX_API_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const file = tokenFilePath();
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch { /* no token file yet */ }
  const token = randomBytes(32).toString("base64url");
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, token + "\n", { mode: 0o600 });
  } catch (err) {
    console.error(`[vibefix] cannot persist API token to ${file}:`, err);
    throw err;
  }
  console.log(`[vibefix] generated API token at ${file} (delete the file to rotate)`);
  return token;
}

export function tokenEquals(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const alternate = req.headers["x-vibefix-token"];
  if (typeof alternate === "string" && alternate.trim()) return alternate.trim();
  const queryIndex = req.url.indexOf("?");
  if (queryIndex >= 0) {
    const token = new URLSearchParams(req.url.slice(queryIndex + 1)).get("token");
    if (token) return token;
  }
  return null;
}

export function authHook(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const urlPath = req.url.split("?")[0] ?? req.url;
    if (PUBLIC_PATHS.has(urlPath)) return;
    const presented = extractToken(req);
    if (!presented || !tokenEquals(presented, token)) return reply.code(401).send({ error: "unauthorized: missing or invalid API token" });
  };
}

export function peekPersistedToken(): string | null {
  const file = tokenFilePath();
  if (!existsSync(file)) return null;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token.length >= 16 ? token : null;
  } catch { return null; }
}