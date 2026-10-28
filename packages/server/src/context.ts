import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentExecutionEvent } from "@vibefix/schemas";
import { migrateEvent, redactSecrets, redactUnknown } from "@vibefix/schemas";
import { EvidenceStore, atomicWrite, runPaths, runsDir, vibefixHome, type OrchestratorRuntime } from "@vibefix/core";
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
    allowedBrowseRoots?: string[];
    maxRepoBytes?: number;
    maxDiskBytes?: number;
    retentionMaxRuns?: number;
  };
}

export interface AuditRecord {
  auditId: string;
  ts: string;
  requestId: string;
  commandId: string;
  projectId: string | null;
  runId: string | null;
  actor: string;
  action: string;
  result: "ok" | "denied" | "error";
  errorCode: string | null;
  detail?: string;
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
  maxRepoBytes: number;
  maxDiskBytes: number;
  retentionMaxRuns: number;
  allowedBrowseRoots: string[];
  cloneLimiter: RateLimiter;
  reserveClone(): boolean;
  releaseClone(): void;
  decodeProject(enc: string, reply: FastifyReply): string | null;
  resolveRun(enc: string, runId: string, reply: FastifyReply): Promise<RunScope | null>;
  diskReplay(runDir: string, since: number): Promise<{ events: AgentExecutionEvent[]; corruptLines: number }>;
  diskState(runDir: string): Promise<DiskStateResult | { ok: false; reason: string } | null>;
  diskEvidence(runDir: string): EvidenceStore;
  idempotencyKey(runId: string, req: FastifyRequest): string | null;
  cachedIdempotency(key: string | null): Promise<{ status: number; body: unknown } | undefined>;
  rememberIdempotency(key: string | null, status: number, body: unknown): Promise<void>;
  withIdempotency(
    runId: string,
    req: FastifyRequest,
    execute: () => Promise<{ status: number; body: unknown }>,
  ): Promise<{ status: number; body: unknown; replayed: boolean }>;
  measureDirectoryBytes(dir: string, skipDirs?: Set<string>): Promise<number>;
  sweepRetention(repoPath: string, maxRuns?: number): Promise<{ removedRuns: string[] }>;
  audit(entry: {
    action: string;
    result: "ok" | "denied" | "error";
    projectId?: string | null;
    runId?: string | null;
    requestId?: string;
    commandId?: string;
    actor?: string;
    errorCode?: string | null;
    detail?: string;
  }): Promise<AuditRecord>;
  readAuditLog(): Promise<AuditRecord[]>;
}

export function createServerContext(
  registry: ProjectRegistry,
  apiToken: string,
  options: BuildAppOptions,
): ServerContext {
  const security = options.security ?? {};
  const maxConcurrentRuns = security.maxConcurrentRuns ?? Number(process.env.VIBEFIX_MAX_ACTIVE_RUNS ?? 4);
  const maxConcurrentClones = security.maxConcurrentClones ?? 2;
  const maxRepoBytes = security.maxRepoBytes ?? Number(process.env.VIBEFIX_MAX_REPO_BYTES ?? 500_000_000);
  const maxDiskBytes = security.maxDiskBytes ?? Number(process.env.VIBEFIX_MAX_DISK_BYTES ?? 2_000_000_000);
  const retentionMaxRuns = security.retentionMaxRuns ?? Number(process.env.VIBEFIX_RETENTION_MAX_RUNS ?? 20);
  const allowedBrowseRoots = (security.allowedBrowseRoots ?? [process.env.USERPROFILE ?? process.env.HOME ?? ""])
    .filter((root) => root.length > 0)
    .map((root) => path.resolve(root));
  const cloneLimiter = new RateLimiter(60_000, security.clonesPerMinute ?? 10);
  let activeClones = 0;
  const idempotencyCache = new Map<string, { status: number; body: unknown }>();
  let idempotencyLoaded = false;
  let idempotencyChain: Promise<void> = Promise.resolve();
  let auditChain: Promise<void> = Promise.resolve();
  const homeDir = () => process.env.VIBEFIX_HOME ?? vibefixHome();
  const idempotencyFile = () => path.join(homeDir(), "idempotency.json");
  const auditFile = () => path.join(homeDir(), "audit.ndjson");
  const loadIdempotency = async () => {
    if (idempotencyLoaded) return;
    idempotencyLoaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(idempotencyFile(), "utf8")) as Record<string, { status: number; body: unknown }>;
      for (const [key, value] of Object.entries(parsed)) if (value && typeof value.status === "number") idempotencyCache.set(key, value);
    } catch { /* first process / absent file */ }
  };
  const persistIdempotency = async () => {
    await atomicWrite(idempotencyFile(), JSON.stringify(Object.fromEntries(idempotencyCache), null, 2));
  };

  const idempotencyKey = (runId: string, req: FastifyRequest): string | null => {
    const project = (req.params as { enc?: string } | undefined)?.enc ?? "unknown-project";
    const header = req.headers["idempotency-key"];
    if (typeof header === "string" && header.trim()) return `${project}:${runId}:${header.trim()}`;
    const bodyKey = (req.body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
    return typeof bodyKey === "string" && bodyKey.trim() ? `${project}:${runId}:${bodyKey.trim()}` : null;
  };

  const cachedIdempotency = async (key: string | null) => {
    await loadIdempotency();
    return key ? idempotencyCache.get(key) : undefined;
  };

  const rememberIdempotency = async (key: string | null, status: number, body: unknown) => {
    if (!key) return;
    await loadIdempotency();
    if (idempotencyCache.size >= 500) {
      const oldest = idempotencyCache.keys().next().value;
      if (oldest !== undefined) idempotencyCache.delete(oldest);
    }
    idempotencyCache.set(key, { status, body: redactUnknown(body) });
    await persistIdempotency();
  };

  const withIdempotency = async (
    runId: string,
    req: FastifyRequest,
    execute: () => Promise<{ status: number; body: unknown }>,
  ): Promise<{ status: number; body: unknown; replayed: boolean }> => {
    const key = idempotencyKey(runId, req);
    let resolveOut!: (res: { status: number; body: unknown; replayed: boolean }) => void;
    let rejectOut!: (err: unknown) => void;
    const out = new Promise<{ status: number; body: unknown; replayed: boolean }>((resolve, reject) => {
      resolveOut = resolve;
      rejectOut = reject;
    });
    const op = idempotencyChain.then(async () => {
      try {
        const hit = await cachedIdempotency(key);
        if (hit) {
          resolveOut({ ...hit, replayed: true });
          return;
        }
        const res = await execute();
        if (res.status >= 200 && res.status < 300) {
          await rememberIdempotency(key, res.status, res.body);
        }
        resolveOut({ ...res, replayed: false });
      } catch (err) {
        rejectOut(err);
      }
    });
    idempotencyChain = op.catch(() => undefined);
    return out;
  };

  const measureDirectoryBytes = async (
    dir: string,
    skipDirs = new Set(["node_modules", ".git"]),
  ): Promise<number> => {
    let total = 0;
    const walk = async (current: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          try {
            const st = await fs.stat(full);
            total += st.size;
          } catch {
            // ignore concurrent removal
          }
        }
      }
    };
    await walk(dir);
    return total;
  };

  const sweepRetention = async (repoPath: string, maxRuns = retentionMaxRuns): Promise<{ removedRuns: string[] }> => {
    const rDir = runsDir(repoPath);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(rDir, { withFileTypes: true });
    } catch {
      return { removedRuns: [] };
    }
    const candidates: Array<{ runId: string; dir: string; createdAt: string; status: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      const dir = path.join(rDir, entry.name);
      if (registry.runtime(entry.name)) continue; // never sweep live runtimes
      try {
        const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as {
          status?: string;
          createdAt?: string;
        };
        if (state.status === "completed" || state.status === "aborted" || state.status === "failed") {
          candidates.push({
            runId: entry.name,
            dir,
            createdAt: state.createdAt ?? new Date(0).toISOString(),
            status: state.status,
          });
        }
      } catch {
        // skip unreadable runs
      }
    }
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const toRemove = candidates.slice(Math.max(0, maxRuns));
    const removedRuns: string[] = [];
    for (const item of toRemove) {
      await fs.rm(item.dir, { recursive: true, force: true }).catch(() => undefined);
      removedRuns.push(item.runId);
    }
    return { removedRuns };
  };

  const audit = async (entry: {
    action: string;
    result: "ok" | "denied" | "error";
    projectId?: string | null;
    runId?: string | null;
    requestId?: string;
    commandId?: string;
    actor?: string;
    errorCode?: string | null;
    detail?: string;
  }): Promise<AuditRecord> => {
    const record: AuditRecord = {
      auditId: `aud_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      ts: new Date().toISOString(),
      requestId: entry.requestId ?? `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      commandId: entry.commandId ?? `cmd_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      projectId: entry.projectId ?? null,
      runId: entry.runId ?? null,
      actor: entry.actor ?? "local-operator",
      action: entry.action,
      result: entry.result,
      errorCode: entry.errorCode ?? null,
      ...(entry.detail ? { detail: redactSecrets(entry.detail) } : {}),
    };
    const op = auditChain.then(async () => {
      const file = auditFile();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    });
    auditChain = op.catch(() => undefined);
    await op.catch(() => undefined);
    return record;
  };

  const readAuditLog = async (): Promise<AuditRecord[]> => {
    await auditChain.catch(() => undefined);
    try {
      const content = await fs.readFile(auditFile(), "utf8");
      const out: AuditRecord[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as AuditRecord);
        } catch {
          // ignore corrupt line
        }
      }
      return out;
    } catch {
      return [];
    }
  };

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
        const event = migrateEvent(JSON.parse(line));
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
    maxRepoBytes,
    maxDiskBytes,
    retentionMaxRuns,
    allowedBrowseRoots,
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
    idempotencyKey,
    cachedIdempotency,
    rememberIdempotency,
    withIdempotency,
    measureDirectoryBytes,
    sweepRetention,
    audit,
    readAuditLog,
  };
}
