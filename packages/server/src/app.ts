import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
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
import { loadRepoConfig, saveRepoConfig, runPaths, clonesDir, vibefixHome, EvidenceStore } from "@vibefix/core";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ProjectRegistry, decodePath, encodePath } from "./projects.js";

export interface BuildAppOptions {
  /** Auto-approve checkpoints in mock/demo mode. Default false. */
  autoApproveMock?: boolean;
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

export function buildApp(registry: ProjectRegistry, options: BuildAppOptions = {}) {
  const app = Fastify({ logger: { level: process.env.VIBEFIX_LOG ?? "info" } });
  void app.register(websocket);
  void app.register(cors, { origin: true });

  void options;

  /**
   * Locate a run's directory on disk when no live runtime is registered
   * (server restarted, or the user is browsing an old run). Everything a run
   * produced is durable on disk — the API should never go blind to it.
   */
  const findRunDir = async (runId: string): Promise<string | null> => {
    const projectsRoot = path.join(vibefixHome(), "projects");
    let projectDirs: string[] = [];
    try {
      projectDirs = (await fs.readdir(projectsRoot)).map((d) => path.join(projectsRoot, d));
    } catch {
      return null;
    }
    for (const dir of projectDirs) {
      const runDir = path.join(dir, "runs", runId);
      if (await fs.stat(runDir).then(() => true).catch(() => false)) return runDir;
    }
    return null;
  };

  /** Events from disk for runs without a live runtime. */
  const diskEvents = async (runId: string, since: number) => {
    const runDir = await findRunDir(runId);
    if (!runDir) return [];
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

  const diskState = async (runId: string): Promise<unknown | null> => {
    const runDir = await findRunDir(runId);
    if (!runDir) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(runDir, "state.json"), "utf8"));
    } catch {
      return null;
    }
  };

  /** Read-only evidence reader over a run directory on disk. */
  const diskEvidence = async (runId: string) => {
    const runDir = await findRunDir(runId);
    if (!runDir) return null;
    return new EvidenceStore({ evidenceDir: path.join(runDir, "evidence") } as never);
  };

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
  app.post<{ Body: { url: string; token?: string } }>("/api/projects/clone", async (req, reply) => {
    const { url, token } = req.body;
    if (!url || !/^https:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/)?$/.test(url.replace(/\.git$/, ""))) {
      return reply.code(400).send({ error: "provide a GitHub URL like https://github.com/owner/repo" });
    }
    const name = url.replace(/\/$/, "").split("/").pop()!.replace(/\.git$/, "");
    await fs.mkdir(clonesDir(), { recursive: true });
    let target = path.join(clonesDir(), name);
    let n = 2;
    while (await fs.stat(target).then(() => true).catch(() => false)) {
      target = path.join(clonesDir(), `${name}-${n++}`);
    }
    // Token (optional, private repos) is injected into the clone URL only — never logged or stored.
    const cloneUrl = token ? url.replace("https://", `https://x-access-token:${encodeURIComponent(token)}@`) : url;
    const res = await runCommand("git", ["clone", cloneUrl, target], { cwd: clonesDir(), timeoutMs: 300_000 });
    if (res.code !== 0) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      return reply.code(400).send({ error: `git clone failed: ${res.stderr.slice(0, 300)}` });
    }
    return { repoPath: target, name: path.basename(target) };
  });

  // ---------- local folder picker ----------
  app.get("/api/fs/browse", async (req) => {
    const requested = (req.query as { path?: string }).path;
    const dir = requested && requested.trim().length > 0 ? path.resolve(requested) : homedir();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { path: dir, parent: path.dirname(dir), dirs: [], error: "cannot read this location" };
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
    return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs };
  });

  // ---------- repo codebase viewer ----------
  app.get("/api/projects/:enc/tree", async (req, reply) => {
    const repoPath = decodePath((req.params as { enc: string }).enc);
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
    const repoPath = decodePath((req.params as { enc: string }).enc);
    const rel = (req.query as { path?: string }).path ?? "";
    const abs = path.resolve(repoPath, rel);
    if (!abs.startsWith(path.resolve(repoPath))) {
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
    try {
      const manager = await registry.open(decodePath(enc));
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
    const { repoPath } = req.body;
    if (!repoPath) return reply.code(400).send({ error: "repoPath is required" });
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
    const { enc } = req.params as { enc: string };
    try {
      const config = await loadRepoConfig(decodePath(enc));
      return config;
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.put("/api/projects/:enc/config", async (req, reply) => {
    const { enc } = req.params as { enc: string };
    const repoPath = decodePath(enc);
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

  // ---------- runs ----------
  app.post<{ Params: { enc: string }; Body: { mode?: RefactoringMode } }>(
    "/api/projects/:enc/runs",
    async (req, reply) => {
      const { enc } = req.params;
      const mode = req.body?.mode === "architecture" || req.body?.mode === "modernization" ? req.body.mode : "minimal";
      try {
        const manager = await registry.open(decodePath(enc));
        const { runtime } = await manager.createRun(mode);
        registry.registerRuntime(runtime, manager.repoPath);
        registry.track(runtime.runId, runtime.dispatch({ type: "START" }));
        return { runId: runtime.runId, state: runtime.snapshot() };
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  app.get("/api/projects/:enc/runs", async (req) => {
    const { enc } = req.params as { enc: string };
    const manager = registry.peek(decodePath(enc));
    if (!manager) return { runs: [] };
    const runs = await manager.listRuns();
    return { runs: runs.map((r) => ({ runId: r.runId, status: r.state.status, phase: r.state.phase, createdAt: r.state.createdAt })) };
  });

  const getRuntime = (runId: string) => registry.runtime(runId)?.runtime;

  app.get("/api/runs/:runId", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const runtime = getRuntime(runId);
    if (runtime) return runtime.snapshot();
    const state = await diskState(runId);
    if (state) return state;
    return reply.code(404).send({ error: "unknown run" });
  });

  app.get("/api/runs/:runId/usage", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    if (!entry) return reply.code(404).send({ error: "unknown run" });
    return entry.runtime.usage;
  });

  app.get("/api/runs/:runId/events", async (req) => {
    const { runId } = req.params as { runId: string };
    const since = Number((req.query as { since?: string }).since ?? 0);
    const sinceSeq = Number.isFinite(since) ? since : 0;
    const runtime = getRuntime(runId);
    // Live runtime streams from memory; otherwise the durable on-disk log
    // serves the same events (server restart / browsing an old run).
    if (!runtime) return { events: await diskEvents(runId, sinceSeq) };
    return { events: await runtime.events.eventsSince(sinceSeq) };
  });

  app.post<{ Params: { runId: string }; Body: { mode?: RefactoringMode; approvedProposalIds?: string[] } }>(
    "/api/runs/:runId/approve",
    async (req, reply) => {
      const { runId } = req.params;
      const runtime = getRuntime(runId);
      if (!runtime) return reply.code(404).send({ error: "unknown run" });
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

  app.post("/api/runs/:runId/reject", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const runtime = getRuntime(runId);
    if (!runtime) return reply.code(404).send({ error: "unknown run" });
    const state = runtime.snapshot();
    if (state.phase !== "awaitingApproval") {
      return reply.code(409).send({ error: `run is in phase '${state.phase}', not awaitingApproval` });
    }
    registry.track(runId, runtime.dispatch({ type: "CHECKPOINT_REJECTED" }));
    return { ok: true };
  });

  app.post("/api/runs/:runId/abort", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const runtime = getRuntime(runId);
    if (!runtime) return reply.code(404).send({ error: "unknown run" });
    registry.track(runId, runtime.dispatch({ type: "ABORT" }));
    return { ok: true };
  });

  app.post("/api/runs/:runId/resume", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    if (!entry) return reply.code(404).send({ error: "unknown run" });
    registry.track(runId, entry.runtime.resume());
    return { ok: true };
  });

  app.get("/api/runs/:runId/findings", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    const store = entry?.runtime.store ?? (await diskEvidence(runId));
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

  app.get("/api/runs/:runId/intelligence", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    const store = entry?.runtime.store ?? (await diskEvidence(runId));
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

  app.get("/api/runs/:runId/backlog", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    const store = entry?.runtime.store ?? (await diskEvidence(runId));
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const backlog = await store.latest("backlog");
    if (!backlog) return { proposals: [], unaddressedFindings: [] };
    try {
      return BacklogArtifactSchema.parse(backlog.data);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get("/api/runs/:runId/ledger", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    if (!entry) {
      // Durable on disk even without a live runtime.
      const runDir = await findRunDir(runId);
      const ledger = runDir
        ? await fs
            .readFile(path.join(runDir, "ledger.json"), "utf8")
            .then((t) => JSON.parse(t) as { entries: ChangeLedgerEntry[] })
            .catch(() => ({ entries: [] as ChangeLedgerEntry[] }))
        : { entries: [] as ChangeLedgerEntry[] };
      return ledger;
    }
    const paths = runPaths(entry.runtime.snapshot().repoPath, runId);
    const ledger = await fs
      .readFile(paths.ledgerFile, "utf8")
      .then((t) => JSON.parse(t) as { entries: ChangeLedgerEntry[] })
      .catch(() => ({ entries: [] }));
    return ledger;
  });

  app.get("/api/runs/:runId/report", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    const store = entry?.runtime.store ?? (await diskEvidence(runId));
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
    const sinceParam = Number(url.searchParams.get("since") ?? 0);
    const since = Number.isFinite(sinceParam) ? sinceParam : 0;
    const send = (data: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
    };
    if (!runId) {
      socket.close(4000, "runId required");
      return;
    }
    const entry = registry.runtime(runId);
    if (!entry) {
      // No live runtime (server restarted / old run): serve the durable
      // on-disk snapshot + event log once, then keep the socket open. The
      // UI's REST polling keeps it fresh — closing here used to put the UI
      // into an endless close/reconnect "connecting" loop.
      void Promise.all([diskState(runId), diskEvents(runId, since)]).then(([state, events]) => {
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
