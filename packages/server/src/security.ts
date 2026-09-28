import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Security boundary for the VibeFix control plane (docs/risks-improvemts.md
 * Phase 2). The server is local-first: it MUST bind loopback by default and
 * require a bearer token on every endpoint, so a stray non-loopback bind, a
 * CSRF page, or a DNS-rebinding attack cannot drive the API.
 *
 * Token resolution order:
 *   1. VIBEFIX_API_TOKEN env var
 *   2. ~/.vibefix/server-token — generated on first start, reused after.
 *      The Vite dev/preview proxy reads this same file and injects the
 *      Authorization header, so the browser never needs to know the token.
 */

/** Paths that stay reachable without a token (the liveness probe). */
export const PUBLIC_PATHS = new Set(["/api/health"]);

export function tokenFilePath(): string {
  const home = process.env.VIBEFIX_HOME ?? path.join(homedir(), ".vibefix");
  return path.join(home, "server-token");
}

/** Env wins; otherwise load-or-create the persisted token file. */
export async function getApiToken(): Promise<string> {
  const fromEnv = process.env.VIBEFIX_API_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const file = tokenFilePath();
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    // no file yet — create below
  }
  const token = randomBytes(32).toString("base64url");
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, token + "\n", { mode: 0o600 });
  } catch (err) {
    // Read-only home etc. — every request will 401, which is loud and safe.
    console.error(`[vibefix] cannot persist API token to ${file}:`, err);
    throw err;
  }
  console.log(`[vibefix] generated API token at ${file} (delete the file to rotate)`);
  return token;
}

/** Length-safe constant-time compare — hash first so length never leaks. */
export function tokenEquals(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Token from Authorization: Bearer, X-VibeFix-Token, or ?token= (WebSocket). */
export function extractToken(req: FastifyRequest): string | null {
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    if (t) return t;
  }
  const alt = req.headers["x-vibefix-token"];
  if (typeof alt === "string" && alt.trim().length > 0) return alt.trim();
  // Parse the raw URL — req.query is not reliably populated for proxied
  // WebSocket upgrades in this @fastify/websocket version.
  const qi = req.url.indexOf("?");
  if (qi >= 0) {
    const t = new URLSearchParams(req.url.slice(qi + 1)).get("token");
    if (t && t.length > 0) return t;
  }
  return null;
}

/**
 * onRequest hook: reject anything unauthenticated except the health probe.
 * Applied to ALL /api routes and /ws (browsers cannot set headers on
 * WebSocket upgrade, so ?token= is accepted there and on every route).
 */
export function authHook(token: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const urlPath = req.url.split("?")[0] ?? req.url;
    if (PUBLIC_PATHS.has(urlPath)) return;
    const presented = extractToken(req);
    if (!presented || !tokenEquals(presented, token)) {
      return reply.code(401).send({ error: "unauthorized: missing or invalid API token" });
    }
  };
}

/**
 * DNS-rebinding / CSRF guard: browsers always send Origin on cross-site
 * requests. Non-browser clients (CLI, curl) send none and pass. CORS only
 * controls what a browser may READ — this hook stops the request from
 * EXECUTING when a foreign origin is present.
 */
export function originCheckHook(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0 && !allowed.has(origin)) {
      req.log.warn({ origin }, "blocked request with foreign Origin header");
      return reply.code(403).send({ error: `origin ${origin} is not allowed` });
    }
  };
}

/** Default browser origins the UI may live on (Vite dev + preview). */
export function defaultAllowedOrigins(): string[] {
  const fromEnv = process.env.VIBEFIX_UI_ORIGIN;
  if (fromEnv) return fromEnv.split(",").map((o) => o.trim()).filter(Boolean);
  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

// ---------------------------------------------------------------- rate limiting

/**
 * Fixed-window per-key limiter. In-process is deliberate: the server is a
 * local single-user control plane, so per-IP counters in memory are exactly
 * the right shape (no shared store needed). Keyed by client IP.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** Returns true when the request is allowed; records the hit either way. */
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  /** Seconds until the current window for `key` resets (for Retry-After). */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (!entry) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  /** Number of tracked keys (used to decide when pruning is worthwhile). */
  hitsSize(): number {
    return this.hits.size;
  }

  /** Drop stale windows so a long-lived process does not accumulate keys. */
  prune(now = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

export function rateLimitHook(limiter: RateLimiter) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.ip ?? "unknown";
    if (!limiter.allow(key)) {
      if (limiter.hitsSize() > 10_000) limiter.prune();
      return reply
        .code(429)
        .header("retry-after", String(limiter.retryAfterSeconds(key)))
        .send({ error: "rate limit exceeded — slow down" });
    }
  };
}

// ---------------------------------------------------------------- path safety

/**
 * True only when `candidate` is strictly inside `root`. A plain string
 * prefix check is NOT safe: C:\\repos\\project-secrets starts with
 * C:\\repos\\project. path.relative is the correct containment test.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Run IDs are opaque tokens from our own id generator — enforce the shape. */
export const RUN_ID_PATTERN = /^run_[A-Za-z0-9]{6,64}$/;

export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

// ---------------------------------------------------------------- git clone safety

/** Hosts clone requests may target. Extend with VIBEFIX_CLONE_HOSTS=host1,host2. */
export function allowedCloneHosts(): string[] {
  const extra = (process.env.VIBEFIX_CLONE_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return ["github.com", "www.github.com", ...extra];
}

export interface ParsedCloneUrl {
  host: string;
  owner: string;
  name: string;
}

/** Strict HTTPS-only URL parse. Returns null for anything malformed. */
export function parseCloneUrl(raw: string): ParsedCloneUrl | null {
  if (!raw || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Credentials in the URL would ride straight into the git argv.
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!allowedCloneHosts().includes(host)) return null;
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(name)) return null;
  return { host, owner, name };
}

/**
 * git-credential-store file body for a GitHub PAT. The clone URL passed on
 * the command line stays CLEAN — the token travels via this 0600 temp file,
 * which is deleted immediately after the clone finishes.
 */
export function credentialFileBody(host: string, token: string): string {
  return `protocol=https\nhost=${host}\nusername=x-access-token\npassword=${token}\n`;
}

/** Never let a secret reach logs, error responses, or the client. */
export function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length === 0) return text;
  return text.split(secret).join("[REDACTED]");
}

// ---------------------------------------------------------------- binding guard

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Refuse to start on a non-loopback interface unless the operator has BOTH
 * opted in (VIBEFIX_ALLOW_REMOTE=1) AND set an explicit token. An accidental
 * `--host 0.0.0.0` must never silently expose the filesystem-reading,
 * code-modifying API to the network.
 */
export function assertBindingAllowed(host: string): void {
  if (isLoopbackHost(host)) return;
  const optedIn = process.env.VIBEFIX_ALLOW_REMOTE === "1";
  const hasToken = (process.env.VIBEFIX_API_TOKEN ?? "").length >= 16;
  if (!optedIn || !hasToken) {
    throw new Error(
      `refusing to bind ${host}: VibeFix serves filesystem reads and code-modification ` +
        `endpoints. To expose it beyond loopback, set BOTH VIBEFIX_ALLOW_REMOTE=1 and ` +
        `VIBEFIX_API_TOKEN (>= 16 chars) in the environment.`,
    );
  }
}

/** Exists for tests / tooling that check the token file without generating. */
export function peekPersistedToken(): string | null {
  const file = tokenFilePath();
  if (!existsSync(file)) return null;
  try {
    const t = readFileSync(file, "utf8").trim();
    return t.length >= 16 ? t : null;
  } catch {
    return null;
  }
}
