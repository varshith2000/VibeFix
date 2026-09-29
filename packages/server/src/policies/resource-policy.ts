import type { FastifyReply, FastifyRequest } from "fastify";

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly windowMs: number, private readonly max: number) {}
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }
  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }
  hitsSize(): number { return this.hits.size; }
  prune(now = Date.now()): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

export function rateLimitHook(limiter: RateLimiter) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.ip ?? "unknown";
    if (!limiter.allow(key)) {
      if (limiter.hitsSize() > 10_000) limiter.prune();
      return reply.code(429).header("retry-after", String(limiter.retryAfterSeconds(key))).send({ error: "rate limit exceeded — slow down" });
    }
  };
}

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9]{6,64}$/;
export function isValidRunId(runId: string): boolean { return RUN_ID_PATTERN.test(runId); }

export function allowedCloneHosts(): string[] {
  const extra = (process.env.VIBEFIX_CLONE_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  return ["github.com", "www.github.com", ...extra];
}

export interface ParsedCloneUrl { host: string; owner: string; name: string }
export function parseCloneUrl(raw: string): ParsedCloneUrl | null {
  if (!raw || raw.length > 500) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!allowedCloneHosts().includes(host)) return null;
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(name)) return null;
  return { host, owner, name };
}

export function credentialFileBody(host: string, token: string): string {
  return `protocol=https\nhost=${host}\nusername=x-access-token\npassword=${token}\n`;
}
export function scrubSecret(text: string, secret: string | undefined): string {
  return !secret ? text : text.split(secret).join("[REDACTED]");
}