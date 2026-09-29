import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentExecutionEvent } from "@vibefix/schemas";
import { EvidenceStore, runPaths, type OrchestratorRuntime } from "@vibefix/core";
import { decodePath, ProjectRegistry } from "./projects.js";
import { isValidRunId, RateLimiter } from "./policies/resource-policy.js";

export interface BuildAppOptions {
  autoApproveMock?: boolean;
  security?: {
    token?: string;
    allowedOrigins?: string[];
    requestsPerMinute?: number;
    clonesPerMinute?: number;
    maxConcurrentClones?: number;
    maxConcurrentRuns?: number;
  };
}

export interface RunScope {
  repoPath: string;
  runtime?: OrchestratorRuntime;
  runDir?: string;
}

export interface DiskStateResult {
  ok: true;
  state: unknown;
}

export interface ServerContext {
  registry: ProjectRegistry;
  apiToken: string;
  maxConcurrentRuns: number;
  maxConcurrentClones: number;
  cloneLimiter: RateLimiter;
  reserveClone(): boolean;
  releaseClone(): void;
  decodeProject(enc: string, reply: FastifyReply): string | null;
  resolveRun(enc: string, runId: string, reply: FastifyReply): Promise<RunScope | null>;
  diskReplay(runDir: string, since: number): Promise<{ events: AgentExecutionEvent[]; corruptLines: number }>;
  diskState(runDir: string): Promise<DiskStateResult | { ok: false; reason: string } | null>;
  diskEvidence(runDir: string): EvidenceStore;
  idempotencyKey(runId: string, req: FastifyRequest): string | null;
  cachedIdempotency(key: string | null): { status: number; body: unknown } | undefined;
  rememberIdempotency(key: string | null, status: number, body: unknown): void;
}

export function createServerContext(
  registry: ProjectRegistry,
  apiToken: string,
  options: BuildAppOptions,
): ServerContext {
  const security = options.security ?? {};
  const maxConcurrentRuns = security.maxConcurrentRuns ?? Number(process.env.VIBEFIX_MAX_ACTIVE_RUNS ?? 4);
  const maxConcurrentClones = security.maxConcurrentClones ?? 2;
  const cloneLimiter = new RateLimiter(60_000, security.clonesPerMinute ?? 10);
  let activeClones = 0;
  const idempotencyCache = new Map<string, { status: number; body: unknown }>();

  const decodeProject = (enc: string, reply: FastifyReply): string | null => {
    const repoPath = decodePath(enc);
    if (!path.isAbsolute(repoPath)) {
      reply.code(400).send({ error: "invalid project path" });
      return null;
    }
    return repoPath;
  };

  const diskReplay = async (runDir: string, since: number) => {
    let content: string;
    try {
      content = await fs.readFile(path.join(runDir, "events.ndjson"), "utf8");
    } catch {
      return { events: [], corruptLines: 0 };
    }
    const events: AgentExecutionEvent[] = [];
    let corruptLines = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as AgentExecutionEvent;
        if (event.seq > since) events.push(event);
      } catch {
        corruptLines += 1;
      }
    }
    return { events, corruptLines };
  };

  const diskState = async (runDir: string) => {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(runDir, "state.json"), "utf8");
    } catch {
      return { ok: false as const, reason: "state.json is missing or unreadable" };
    }
    try {
      return { ok: true as const, state: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false as const, reason: "state.json is corrupt (unparseable JSON)" };
    }
  };

  const resolveRun = async (enc: string, runId: string, reply: FastifyReply): Promise<RunScope | null> => {
    if (!isValidRunId(runId)) {
      reply.code(400).send({ error: "invalid run id" });
      return null;
    }
    const repoPath = decodeProject(enc, reply);
    if (!repoPath) return null;
    const live = registry.runtimeForProject(runId, repoPath);
    if (live) return { repoPath, runtime: live.runtime };
    const runDir = runPaths(repoPath, runId).runDir;
    if (await fs.stat(runDir).then(() => true).catch(() => false)) return { repoPath, runDir };
    reply.code(404).send({ error: "unknown run for this project" });
    return null;
  };

  return {
    registry,
    apiToken,
    maxConcurrentRuns,
    maxConcurrentClones,
    cloneLimiter,
    reserveClone: () => {
      if (activeClones >= maxConcurrentClones) return false;
      activeClones += 1;
      return true;
    },
    releaseClone: () => { activeClones -= 1; },
    decodeProject,
    resolveRun,
    diskReplay,
    diskState,
    diskEvidence: (runDir) => new EvidenceStore({ evidenceDir: path.join(runDir, "evidence") } as never),
    idempotencyKey: (runId, req) => {
      const header = req.headers["idempotency-key"];
      if (typeof header === "string" && header.trim()) return `${runId}:${header.trim()}`;
      const bodyKey = (req.body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
      return typeof bodyKey === "string" && bodyKey.trim() ? `${runId}:${bodyKey.trim()}` : null;
    },
    cachedIdempotency: (key) => key ? idempotencyCache.get(key) : undefined,
    rememberIdempotency: (key, status, body) => {
      if (!key) return;
      if (idempotencyCache.size >= 500) {
        const oldest = idempotencyCache.keys().next().value;
        if (oldest !== undefined) idempotencyCache.delete(oldest);
      }
      idempotencyCache.set(key, { status, body });
    },
  };
}