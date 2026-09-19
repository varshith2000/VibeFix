import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import type { WebSocket } from "ws";
import {
  BacklogArtifactSchema,
  FindingsArtifactSchema,
  RepoConfigSchema,
  ReportArtifactSchema,
  type AgentExecutionEvent,
  type ChangeLedgerEntry,
  type RefactoringMode,
} from "@vibefix/schemas";
import { AGENT_DEFINITIONS } from "@vibefix/agents";
import { NodeFsFacts, runCommand } from "@vibefix/adapters";
import { loadRepoConfig, saveRepoConfig, runPaths, clonesDir } from "@vibefix/core";
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
  "run.completed",
  "run.failed",
]);

export function buildApp(registry: ProjectRegistry, options: BuildAppOptions = {}) {
  const app = Fastify({ logger: { level: process.env.VIBEFIX_LOG === "debug" ? "debug" : "warn" } });
  void app.register(websocket);
  void app.register(cors, { origin: true });

  void options;

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
      return { runId, state: runtime.snapshot() };
    } catch (err) {
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
    if (!runtime) return reply.code(404).send({ error: "unknown run (restart server?)" });
    return runtime.snapshot();
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
    const runtime = getRuntime(runId);
    if (!runtime) return { events: [] };
    return { events: await runtime.events.eventsSince(Number.isFinite(since) ? since : 0) };
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
      registry.track(runId, runtime.dispatch({ type: "CHECKPOINT_APPROVED", mode, approvedProposalIds: approved }));
      return { ok: true, approved, mode };
    },
  );

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
    if (!entry) return reply.code(404).send({ error: "unknown run" });
    const findings = [];
    for (const artifact of await entry.runtime.store.list(undefined, "findings")) {
      try {
        findings.push(...FindingsArtifactSchema.parse(artifact.data).findings);
      } catch {
        // skip
      }
    }
    return { findings };
  });

  app.get("/api/runs/:runId/backlog", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const entry = registry.runtime(runId);
    if (!entry) return reply.code(404).send({ error: "unknown run" });
    const backlog = await entry.runtime.store.latest("backlog");
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
    if (!entry) return reply.code(404).send({ error: "unknown run" });
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
    if (!entry) return reply.code(404).send({ error: "unknown run" });
    const report = await entry.runtime.store.latest("report");
    if (!report) return reply.code(404).send({ error: "report not ready" });
    return ReportArtifactSchema.parse(report.data);
  });

  // ---------- websocket ----------
  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    const query = req.query as { runId?: string; since?: string };
    const runId = query.runId;
    if (!runId) {
      socket.close(4000, "runId required");
      return;
    }
    const entry = registry.runtime(runId);
    if (!entry) {
      socket.close(4004, "unknown run");
      return;
    }
    const runtime = entry.runtime;
    const send = (data: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
    };
    // Snapshot + replay, then live.
    send({ t: "snapshot", state: runtime.snapshot() });
    const since = Number(query.since ?? 0);
    void runtime.events.eventsSince(Number.isFinite(since) ? since : 0).then((events) => {
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
