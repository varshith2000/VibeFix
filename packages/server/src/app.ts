import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  BacklogArtifactSchema,
  FindingsArtifactSchema,
  KnowledgeGraphSchema,
  ProductIntentSchema,
  RepoConfigSchema,
  ReportArtifactSchema,
  TestSurveyArtifactSchema,
  type AgentExecutionEvent,
  type ChangeLedgerEntry,
  type RefactoringMode,
} from "@vibefix/schemas";
import { AGENT_DEFINITIONS } from "@vibefix/agents";
import { NodeFsFacts, runCommand } from "@vibefix/adapters";
import {
  loadRepoConfig,
  saveRepoConfig,
  runPaths,
  clonesDir,
  EvidenceStore,
  type OrchestratorRuntime,
} from "@vibefix/core";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ProjectRegistry, decodePath, encodePath } from "./projects.js";
import {
  RateLimiter,
  authHook,
  credentialFileBody,
  defaultAllowedOrigins,
  getApiToken,
  isPathInside,
  isValidRunId,
  originCheckHook,
  parseCloneUrl,
  rateLimitHook,
  scrubSecret,
  tokenEquals,
} from "./security.js";

export interface BuildAppOptions {
  /** Auto-approve checkpoints in mock/demo mode. Default false. */
  autoApproveMock?: boolean;
  /**
   * Security overrides — primarily for tests. Production values come from
   * the environment (VIBEFIX_API_TOKEN, VIBEFIX_UI_ORIGIN, ...); see
   * security.ts. The token here bypasses env/file resolution entirely.
   */
  security?: {
    token?: string;
    allowedOrigins?: string[];
    requestsPerMinute?: number;
    clonesPerMinute?: number;
    maxConcurrentClones?: number;
    maxConcurrentRuns?: number;
  };
}

/** Events that change RunState/usage and therefore trigger a WS snapshot. */
const SNAPSHOT_EVENTS = new Set([
  "phase.entered",
  "phase.completed",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.rejected",
  "checkpoint.awaitingApproval",
  "checkpoint.approved",
  "proposal.verdict",
  "ledger.updated",
  "run.aborted",
  "run.nochanges",
  "run.completed",
  "run.failed",
]);

export async function buildApp(registry: ProjectRegistry, options: BuildAppOptions = {}) {
  const sec = options.security ?? {};
  const apiToken = sec.token ?? (await getApiToken());
  const allowedOrigins = sec.allowedOrigins ?? defaultAllowedOrigins();

  const app = Fastify({
    logger: { level: process.env.VIBEFIX_LOG ?? "info" },
    // Requests are small JSON commands (configs, approvals) — 1 MiB is ample.
    bodyLimit: 1_000_000,
    // Project paths travel base64url-encoded in URL params; the router's
    // default 100-char param limit silently 404s any repo path longer than
    // ~75 real characters (deep Windows paths hit this easily).
    maxParamLength: 1000,
  });
  // MUST be awaited BEFORE routes are defined: @fastify/websocket wraps
  // `{ websocket: true }` route handlers in an onRoute hook. Fire-and-forget
  // registration leaves /ws a plain GET route — the handler then receives
  // (request, reply) instead of (socket, request) and every WS upgrade dies
  // with "socket.close is not a function" + HTTP 500.
  await app.register(websocket);
  // CORS restricted to the real UI origins. `origin: true` would reflect ANY
  // origin — combined with the filesystem endpoints that is an open door.
  await app.register(cors, { origin: allowedOrigins, credentials: false });

  // Security pipeline (order matters): foreign origins are refused outright,
  // then rate limits apply (so token brute-force cannot run unbounded), then
  // authentication. /api/health stays public as the liveness probe.
  app.addHook("onRequest", originCheckHook(allowedOrigins));
  const limiter = new RateLimiter(60_000, sec.requestsPerMinute ?? 600);
  app.addHook("onRequest", rateLimitHook(limiter));
  app.addHook("onRequest", authHook(apiToken));

  void options;

  const MAX_CONCURRENT_RUNS = sec.maxConcurrentRuns ?? Number(process.env.VIBEFIX_MAX_ACTIVE_RUNS ?? 4);

  /** Decode + validate the project path segment of a scoped URL. */
  const decodeProject = (enc: string, reply: import("fastify").FastifyReply): string | null => {
    const repoPath = decodePath(enc);
    if (!path.isAbsolute(repoPath)) {
      reply.code(400).send({ error: "invalid project path" });
      return null;
    }
    return repoPath;
  };

  /** Events from a run directory on disk. */
  const diskEvents = async (runDir: string, since: number) => {
    let content: string;
    try {
      content = await fs.readFile(path.join(runDir, "events.ndjson"), "utf8");
    } catch {
      return [];
    }
    const events: AgentExecutionEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AgentExecutionEvent;
        if (parsed.seq > since) events.push(parsed);
      } catch {
        // skip corrupt line
      }
    }
    return events;
  };

  const diskState = async (runDir: string): Promise<unknown | null> => {
    try {
      return JSON.parse(await fs.readFile(path.join(runDir, "state.json"), "utf8"));
    } catch {
      return null;
    }
  };

  /** Read-only evidence reader over a run directory on disk. */
  const diskEvidence = (runDir: string) => new EvidenceStore({ evidenceDir: path.join(runDir, "evidence") } as never);

  // ---------- health check ----------
  app.get("/api/health", async () => {
    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      activeRuntimes: registry.activeRuntimeCount(),
    };
  });

  // ---------- catalog ----------
  app.get("/api/agents", async () => AGENT_DEFINITIONS);

  // ---------- GitHub clone ----------
  const cloneLimiter = new RateLimiter(60_000, sec.clonesPerMinute ?? 10);
  let activeClones = 0;

  app.post<{ Body: { url: string; token?: string } }>("/api/projects/clone", async (req, reply) => {
    const { url, token } = req.body ?? {};
    const parsed = parseCloneUrl(typeof url === "string" ? url.trim() : "");
    if (!parsed) {
      return reply.code(400).send({ error: "provide an HTTPS GitHub URL like https://github.com/owner/repo" });
    }
    if (token !== undefined && (typeof token !== "string" || token.length === 0 || token.length > 4096)) {
      return reply.code(400).send({ error: "invalid token" });
    }
    if (!cloneLimiter.allow(req.ip ?? "unknown")) {
      return reply
        .code(429)
        .header("retry-after", String(cloneLimiter.retryAfterSeconds(req.ip ?? "unknown")))
        .send({ error: "too many clone requests — try again shortly" });
    }
    const maxConcurrentClones = sec.maxConcurrentClones ?? 2;
    if (activeClones >= maxConcurrentClones) {
      return reply.code(429).send({ error: "a clone is already in progress — try again when it finishes" });
    }

    await fs.mkdir(clonesDir(), { recursive: true });
    // Atomic reservation: mkdir fails with EEXIST if the name is taken, so
    // two concurrent clones can never pick the same target (the old
    // stat-then-use loop had exactly that race).
    const base = `${parsed.owner}-${parsed.name}`;
    let target: string | null = null;
    for (let n = 1; n <= 999; n++) {
      const candidate = path.join(clonesDir(), n === 1 ? base : `${base}-${n}`);
      try {
        await fs.mkdir(candidate, { recursive: false });
        target = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    if (!target) return reply.code(500).send({ error: "cannot allocate a clone directory" });

    activeClones++;
    let credFile: string | null = null;
    try {
      const args = ["clone"];
      const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
      if (token) {
        // The token NEVER appears on the command line (process args are
        // visible to other local processes and crash reports). It travels
        // through a 0600 git-credential-store file deleted right after.
        credFile = path.join(clonesDir(), `.credentials-${process.pid}-${randomUUID()}`);
        await fs.writeFile(credFile, credentialFileBody(parsed.host, token), { mode: 0o600 });
        args.push("-c", "credential.helper=", "-c", `credential.helper=store --file=${credFile}`);
      }
      // Canonical clean URL — no credentials, even if the caller sent some.
      args.push(`https://${parsed.host}/${parsed.owner}/${parsed.name}`, target);
      const res = await runCommand("git", args, { cwd: clonesDir(), timeoutMs: 600_000, env });
      if (res.code !== 0) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        return reply.code(400).send({ error: `git clone failed: ${scrubSecret(res.stderr.slice(0, 300), token)}` });
      }
      return { repoPath: target, name: path.basename(target) };
    } finally {
      activeClones--;
      if (credFile) await fs.rm(credFile, { force: true }).catch(() => undefined);
    }
  });

  // ---------- local folder picker ----------
  // NOTE: authenticated (bearer token) by the global hook — the token is the
  // boundary between "local desktop user" and everything else. Constrained
  // browse roots would break the whole-disk folder picker; see README.

  /** Windows drive roots (C:\ … Z:\) that actually exist. Cheap probe. */
  const listDrives = async (): Promise<string[]> => {
    if (process.platform !== "win32") return [];
    const drives: string[] = [];
    for (let code = 67; code <= 90; code++) {
      const root = `${String.fromCharCode(code)}:\\`;
      try {
        await fs.access(root);
        drives.push(root);
      } catch {
        // drive not present
      }
    }
    return drives;
  };

  app.get("/api/fs/browse", async (req, reply) => {
    const requested = (req.query as { path?: string }).path;
    if (requested !== undefined && !path.isAbsolute(requested)) {
      return reply.code(400).send({ error: "path must be absolute" });
    }
    const dir = requested && requested.trim().length > 0 ? path.resolve(requested) : homedir();
    // On Windows a drive root's dirname is itself, so "up" can never cross
    // drives — return the drive list so the picker can jump between them.
    const drives = await listDrives();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { path: dir, parent: path.dirname(dir), dirs: [], gitDirs: [], drives, error: "cannot read this location" };
    }
    const dirs = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !["node_modules", "windows", "$recycle.bin", "system volume information"].includes(e.name.toLowerCase()),
      )
      .map((e) => e.name)
      .sort();
    // Flag git repos so the picker can show which folders are openable —
    // VibeFix refuses non-git folders ("needs git for worktrees").
    const gitDirs = new Set<string>();
    await Promise.all(
      dirs.map(async (name) => {
        try {
          await fs.access(path.join(dir, name, ".git"));
          gitDirs.add(name);
        } catch {
          // not a repo
        }
      }),
    );
    return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs, gitDirs: [...gitDirs], drives };
  });

  // ---------- repo codebase viewer ----------

  /** Resolve the repo root, rejecting anything that is not a real directory. */
  const repoRoot = async (enc: string, reply: import("fastify").FastifyReply): Promise<string | null> => {
    const repoPath = decodeProject(enc, reply);
    if (!repoPath) return null;
    try {
      const stat = await fs.stat(repoPath);
      if (!stat.isDirectory()) throw new Error("not a directory");
      return repoPath;
    } catch {
      reply.code(400).send({ error: `repository path does not exist: ${repoPath}` });
      return null;
    }
  };

  app.get("/api/projects/:enc/tree", async (req, reply) => {
    const repoPath = await repoRoot((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    try {
      const snapshot = await new NodeFsFacts().snapshot(repoPath);
      return {
        files: snapshot.files
          .filter((f) => f.sizeBytes < 2_000_000)
          .map((f) => ({ path: f.path, language: f.language, loc: f.loc }))
          .slice(0, 5_000),
        summary: {
          languages: snapshot.languages,
          frameworks: snapshot.frameworks.map((f) => f.name),
          totalLoc: snapshot.totalLoc,
          entrypoints: snapshot.entrypoints,
        },
      };
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  app.get("/api/projects/:enc/file", async (req, reply) => {
    const repoPath = await repoRoot((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    const rel = (req.query as { path?: string }).path ?? "";
    // Containment: path.relative, never a string prefix — "C:\repos\project"
    // as a prefix also matches "C:\repos\project-secrets". Symlinks inside
    // the repo that point outside are resolved and re-checked via realpath.
    let rootReal: string;
    try {
      rootReal = await fs.realpath(path.resolve(repoPath));
    } catch {
      return reply.code(400).send({ error: "repository not found" });
    }
    const abs = path.resolve(rootReal, rel);
    if (!isPathInside(rootReal, abs)) {
      return reply.code(400).send({ error: "path escapes the repository" });
    }
    const real = await fs.realpath(abs).catch(() => null);
    if (real && !isPathInside(rootReal, real)) {
      return reply.code(400).send({ error: "path escapes the repository" });
    }
    try {
      const stat = await fs.stat(abs);
      if (stat.size > 500_000) return { path: rel, content: "(file too large to display)", truncated: true };
      return { path: rel, content: await fs.readFile(abs, "utf8"), truncated: false };
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
  });

  // ---------- open a previous run for viewing/resume ----------
  app.post("/api/projects/:enc/runs/:runId/open", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    if (!isValidRunId(runId)) return reply.code(400).send({ error: "invalid run id" });
    const repoPath = decodeProject(enc, reply);
    if (!repoPath) return reply;
    try {
      const manager = await registry.open(repoPath);
      const runtime = await manager.loadRun(runId);
      registry.registerRuntime(runtime, manager.repoPath);
      const state = runtime.snapshot();

      // A run whose on-disk status is "running" was interrupted by a server
      // restart — resume it so the UI actually progresses.
      if (state.status === "running") {
        console.log(`[VibeFix] Resuming interrupted run ${runId} from phase ${state.phase}`);
        registry.track(runId, runtime.resume());
      } else {
        console.log(`[VibeFix] Loading completed run ${runId} for viewing`);
      }

      return { runId, state };
    } catch (err) {
      console.error(`[VibeFix] Failed to open run ${runId}:`, err);
      return reply.code(404).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ---------- project ----------
  app.post<{ Body: { repoPath: string } }>("/api/projects", async (req, reply) => {
    const { repoPath } = req.body ?? {};
    if (!repoPath || !path.isAbsolute(repoPath)) return reply.code(400).send({ error: "absolute repoPath is required" });
    try {
      const manager = await registry.open(repoPath);
      const runs = await manager.listRuns();
      return {
        repoPath: manager.repoPath,
        encoded: encodePath(manager.repoPath),
        runs: runs.map((r) => ({ runId: r.runId, status: r.state.status, phase: r.state.phase, createdAt: r.state.createdAt })),
      };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get("/api/projects/:enc/config", async (req, reply) => {
    const repoPath = decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    try {
      const config = await loadRepoConfig(repoPath);
      return config;
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.put("/api/projects/:enc/config", async (req, reply) => {
    const repoPath = decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    try {
      const config = RepoConfigSchema.parse(req.body);
      await saveRepoConfig(repoPath, config);
      // Apply live: running runs share these objects by reference.
      const manager = registry.peek(repoPath);
      manager?.updateConfig(config);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  // ---------- runs (project-scoped: every runId is resolved THROUGH its project) ----------

  app.post<{ Params: { enc: string }; Body: { mode?: RefactoringMode } }>(
    "/api/projects/:enc/runs",
    async (req, reply) => {
      const repoPath = decodeProject(req.params.enc, reply);
      if (!repoPath) return reply;
      const mode = req.body?.mode === "architecture" || req.body?.mode === "modernization" ? req.body.mode : "minimal";
      if (registry.activeRunCount() >= MAX_CONCURRENT_RUNS) {
        return reply.code(429).send({
          error: `run ceiling reached (${MAX_CONCURRENT_RUNS} active runs) — wait for or abort a running run first`,
        });
      }
      try {
        const manager = await registry.open(repoPath);
        const { runtime } = await manager.createRun(mode);
        registry.registerRuntime(runtime, manager.repoPath);
        registry.track(runtime.runId, runtime.dispatch({ type: "START" }));
        return { runId: runtime.runId, state: runtime.snapshot() };
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  app.get("/api/projects/:enc/runs", async (req, reply) => {
    const repoPath = decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    const manager = registry.peek(repoPath);
    if (!manager) return { runs: [] };
    const runs = await manager.listRuns();
    return { runs: runs.map((r) => ({ runId: r.runId, status: r.state.status, phase: r.state.phase, createdAt: r.state.createdAt })) };
  });

  /**
   * Resolve a scoped run reference. A run is either LIVE in this server
   * process (and then its registered repoPath must match the URL's project)
   * or durable on disk (and then its directory must live under THIS
   * project's runs/). Anything else is a 404 — runs of one project are not
   * reachable through another project's URL.
   */
  const resolveRun = async (
    enc: string,
    runId: string,
    reply: import("fastify").FastifyReply,
  ): Promise<{ repoPath: string; runtime?: OrchestratorRuntime; runDir?: string } | null> => {
    if (!isValidRunId(runId)) {
      reply.code(400).send({ error: "invalid run id" });
      return null;
    }
    const repoPath = decodeProject(enc, reply);
    if (!repoPath) return null;
    const entry = registry.runtimeForProject(runId, repoPath);
    if (entry) return { repoPath, runtime: entry.runtime };
    const runDir = runPaths(repoPath, runId).runDir;
    if (await fs.stat(runDir).then(() => true).catch(() => false)) return { repoPath, runDir };
    reply.code(404).send({ error: "unknown run for this project" });
    return null;
  };

  app.get("/api/projects/:enc/runs/:runId", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    if (scope.runtime) return scope.runtime.snapshot();
    const state = scope.runDir ? await diskState(scope.runDir) : null;
    if (state) return state;
    return reply.code(404).send({ error: "unknown run" });
  });

  app.get("/api/projects/:enc/runs/:runId/usage", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    // Usage is metered by the live runtime only — readonly/disk runs report zeroes.
    if (!scope.runtime) return { total: 0, byAgent: {}, byProvider: {} };
    return scope.runtime.usage;
  });

  app.get("/api/projects/:enc/runs/:runId/events", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const since = Number((req.query as { since?: string }).since ?? 0);
    const sinceSeq = Number.isFinite(since) ? since : 0;
    // Live runtime streams from memory; otherwise the durable on-disk log
    // serves the same events (server restart / browsing an old run).
    if (!scope.runtime) return { events: await diskEvents(scope.runDir!, sinceSeq) };
    return { events: await scope.runtime.events.eventsSince(sinceSeq) };
  });

  app.post<{ Params: { enc: string; runId: string }; Body: { mode?: RefactoringMode; approvedProposalIds?: string[] } }>(
    "/api/projects/:enc/runs/:runId/approve",
    async (req, reply) => {
      const { enc, runId } = req.params;
      const scope = await resolveRun(enc, runId, reply);
      if (!scope) return reply;
      if (!scope.runtime) return reply.code(409).send({ error: "run is not live in this server — open it first" });
      const runtime = scope.runtime;
      const state = runtime.snapshot();
      if (state.phase !== "awaitingApproval") {
        return reply.code(409).send({ error: `run is in phase '${state.phase}', not awaitingApproval` });
      }
      const backlogArtifact = await runtime.store.latest("backlog");
      const backlog = backlogArtifact ? BacklogArtifactSchema.safeParse(backlogArtifact.data) : null;
      const approved =
        req.body?.approvedProposalIds ??
        (backlog?.success ? backlog.data.proposals.map((p) => p.proposalId) : []) ??
        [];
      const mode = req.body?.mode ?? state.mode;

      try {
        await registry.track(runId, runtime.dispatch({ type: "CHECKPOINT_APPROVED", mode, approvedProposalIds: approved }));
        return { ok: true, approved, mode };
      } catch (err) {
        console.error(`[VibeFix] Checkpoint approval failed for run ${runId}:`, err);
        return reply.code(500).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  app.post("/api/projects/:enc/runs/:runId/reject", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    if (!scope.runtime) return reply.code(409).send({ error: "run is not live in this server — open it first" });
    const state = scope.runtime.snapshot();
    if (state.phase !== "awaitingApproval") {
      return reply.code(409).send({ error: `run is in phase '${state.phase}', not awaitingApproval` });
    }
    registry.track(runId, scope.runtime.dispatch({ type: "CHECKPOINT_REJECTED" }));
    return { ok: true };
  });

  app.post("/api/projects/:enc/runs/:runId/abort", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    if (!scope.runtime) return reply.code(409).send({ error: "run is not live in this server — open it first" });
    registry.track(runId, scope.runtime.dispatch({ type: "ABORT" }));
    return { ok: true };
  });

  app.post("/api/projects/:enc/runs/:runId/resume", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    if (!scope.runtime) return reply.code(409).send({ error: "run is not live in this server — open it first" });
    registry.track(runId, scope.runtime.resume());
    return { ok: true };
  });

  app.get("/api/projects/:enc/runs/:runId/findings", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const findings = [];
    for (const artifact of await store.list(undefined, "findings")) {
      try {
        findings.push(...FindingsArtifactSchema.parse(artifact.data).findings);
      } catch {
        // skip
      }
    }
    return { findings };
  });

  app.get("/api/projects/:enc/runs/:runId/intelligence", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });

    const graphArt = await store.latest("knowledge-graph");
    const intentArt = await store.latest("product-intent");
    const surveyArt = await store.latest("test-survey");
    const findings: Array<{ category: string; risk: { band: string; value: number } }> = [];
    for (const artifact of await store.list(undefined, "findings")) {
      try {
        findings.push(...FindingsArtifactSchema.parse(artifact.data).findings);
      } catch {
        // skip
      }
    }

    const byCat: Record<string, number> = {};
    const byBand: Record<string, number> = { low: 0, medium: 0, high: 0, forbidden: 0 };
    for (const f of findings) {
      byCat[f.category] = (byCat[f.category] ?? 0) + 1;
      byBand[f.risk.band] = (byBand[f.risk.band] ?? 0) + 1;
    }

    // Health scores: 100 minus weighted pressure from findings (Idea §28).
    const pressure = (byBand.forbidden ?? 0) * 12 + (byBand.high ?? 0) * 6 + (byBand.medium ?? 0) * 2 + (byBand.low ?? 0);
    const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
    const survey = surveyArt ? TestSurveyArtifactSchema.safeParse(surveyArt.data) : null;
    const testingScore = survey?.success
      ? clamp(
          (survey.data.canTest ? 40 : 0) +
            (survey.data.testFileCount > 0 ? 30 : 0) +
            Math.min(30, survey.data.testFileCount * 3) -
            (survey.data.untestedPaths.length > 5 ? 15 : 0),
        )
      : 40;

    return {
      graph: graphArt ? KnowledgeGraphSchema.safeParse(graphArt.data).data ?? null : null,
      intent: intentArt ? ProductIntentSchema.safeParse(intentArt.data).data ?? null : null,
      survey: survey?.success ? survey.data : null,
      findingCounts: { total: findings.length, byCategory: byCat, byBand },
      health: {
        architecture: clamp(100 - (byCat.architecture ?? 0) * 8 - pressure * 0.3),
        maintainability: clamp(100 - (byCat.smell ?? 0) * 5 - (byCat.consistency ?? 0) * 6),
        testing: testingScore,
        security: clamp(100 - (byCat.security ?? 0) * 15),
        dependencyHygiene: clamp(100 - (byCat.dependency ?? 0) * 10),
        documentation: clamp(100 - (byCat.documentation ?? 0) * 8),
      },
    };
  });

  app.get("/api/projects/:enc/runs/:runId/backlog", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const backlog = await store.latest("backlog");
    if (!backlog) return { proposals: [], unaddressedFindings: [] };
    try {
      return BacklogArtifactSchema.parse(backlog.data);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get("/api/projects/:enc/runs/:runId/ledger", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const ledgerFile = scope.runtime ? runPaths(scope.repoPath, runId).ledgerFile : path.join(scope.runDir!, "ledger.json");
    return await fs
      .readFile(ledgerFile, "utf8")
      .then((t) => JSON.parse(t) as { entries: ChangeLedgerEntry[] })
      .catch(() => ({ entries: [] as ChangeLedgerEntry[] }));
  });

  app.get("/api/projects/:enc/runs/:runId/report", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const report = await store.latest("report");
    if (!report) return reply.code(404).send({ error: "report not ready" });
    return ReportArtifactSchema.parse(report.data);
  });

  // ---------- websocket ----------
  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    // NOTE: parse the raw URL — req.query is not reliably populated for
    // proxied websocket upgrades in this @fastify/websocket version, and
    // reading it crashed every /ws request with a 500.
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const runId = url.searchParams.get("runId") ?? undefined;
    const enc = url.searchParams.get("enc") ?? undefined;
    const sinceParam = Number(url.searchParams.get("since") ?? 0);
    const since = Number.isFinite(sinceParam) ? sinceParam : 0;
    const send = (data: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
    };
    // Defense in depth: the global auth hook already gated the upgrade, but
    // verify again here (query token or header) before touching any state.
    const presented =
      url.searchParams.get("token") ??
      (typeof req.headers["authorization"] === "string" && req.headers["authorization"].startsWith("Bearer ")
        ? req.headers["authorization"].slice(7)
        : null);
    if (!runId || !enc || !isValidRunId(runId)) {
      socket.close?.(4000, "runId and enc (project) are required");
      return;
    }
    if (!presented || !tokenEquals(presented, apiToken)) {
      socket.close?.(4401, "unauthorized");
      return;
    }
    const repoPath = decodePath(enc);
    if (!path.isAbsolute(repoPath)) {
      socket.close?.(4000, "invalid project path");
      return;
    }
    const entry = registry.runtimeForProject(runId, repoPath);
    if (!entry) {
      // No live runtime for THIS project (server restarted / old run): serve
      // the durable on-disk snapshot + event log once, then keep the socket
      // open. The UI's REST polling keeps it fresh — closing here used to put
      // the UI into an endless close/reconnect "connecting" loop.
      const runDir = runPaths(repoPath, runId).runDir;
      void Promise.all([diskState(runDir), diskEvents(runDir, since)]).then(([state, events]) => {
        if (state) send({ t: "snapshot", state });
        for (const event of events) send({ t: "event", event, seq: event.seq });
        send({ t: "readonly", runId });
      });
      return;
    }
    const runtime = entry.runtime;
    // Snapshot + replay, then live.
    send({ t: "snapshot", state: runtime.snapshot() });
    void runtime.events.eventsSince(since).then((events) => {
      for (const event of events) send({ t: "event", event, seq: event.seq });
    });
    const unsubscribe = runtime.events.subscribe((event: AgentExecutionEvent) => {
      send({ t: "event", event, seq: event.seq });
      // Snapshot on state-changing events so the UI can never go stale.
      if (SNAPSHOT_EVENTS.has(event.type)) {
        send({ t: "snapshot", state: runtime.snapshot() });
        send({ t: "usage", usage: runtime.usage });
      }
    });
    socket.on("close", () => unsubscribe());
  });

  return app;
}
