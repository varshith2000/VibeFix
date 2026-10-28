import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import { CreateRunRequestSchema, parseRequestBody } from "@vibefix/schemas";
import { runPaths, vibefixHome } from "@vibefix/core";
import { isValidRunId } from "../policies/resource-policy.js";
import type { ServerContext } from "../context.js";

export function registerRunRoutes(app: FastifyInstance, context: ServerContext): void {
  const { registry } = context;

  app.post("/api/projects/:enc/runs/:runId/open", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    if (!isValidRunId(runId)) return reply.code(400).send({ error: "invalid run id" });
    const repoPath = context.decodeProject(enc, reply);
    if (!repoPath) return reply;
    try {
      const manager = await registry.open(repoPath);
      const runtime = await manager.loadRun(runId);
      registry.registerRuntime(runtime, manager.repoPath);
      const state = runtime.snapshot();
      if (state.status === "interrupted") console.log(`[VibeFix] Loaded interrupted run ${runId}; explicit resume required`);
      else console.log(`[VibeFix] Loading run ${runId} for viewing`);
      await context.audit({ action: "run.open", result: "ok", projectId: repoPath, runId });
      return { runId, state };
    } catch (err) {
      console.error(`[VibeFix] Failed to open run ${runId}:`, err);
      return reply.code(404).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.post<{ Params: { enc: string }; Body: { mode?: "minimal" | "balanced" | "comprehensive" } }>(
    "/api/projects/:enc/runs", async (req, reply) => {
      const body = parseRequestBody(CreateRunRequestSchema, req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid request body", code: "E_INVALID_BODY", issues: body.issues });
      const repoPath = context.decodeProject(req.params.enc, reply);
      if (!repoPath) return reply;
      const mode = body.data.mode ?? "minimal";
      if (registry.activeRunCount() >= context.maxConcurrentRuns) {
        await context.audit({ action: "run.create", result: "denied", projectId: repoPath, errorCode: "E_RUN_LIMIT" });
        return reply.code(429).send({
          error: `run ceiling reached (${context.maxConcurrentRuns} active runs) — wait for or abort a running run first`,
          code: "E_RUN_LIMIT",
        });
      }
      const homeDir = process.env.VIBEFIX_HOME ?? vibefixHome();
      const diskBytes = await context.measureDirectoryBytes(homeDir, new Set());
      if (diskBytes >= context.maxDiskBytes) {
        await context.audit({ action: "run.create", result: "denied", projectId: repoPath, errorCode: "E_DISK_BUDGET" });
        return reply.code(507).send({
          error: `E_DISK_BUDGET: VibeFix workspace usage (${diskBytes} bytes) reached limit (${context.maxDiskBytes} bytes) — delete old runs or run retention sweep`,
          code: "E_DISK_BUDGET",
        });
      }
      try {
        const manager = await registry.open(repoPath);
        const { runtime } = await manager.createRun(mode);
        registry.registerRuntime(runtime, manager.repoPath);
        registry.track(runtime.runId, runtime.dispatch({ type: "START" }));
        await context.audit({ action: "run.create", result: "ok", projectId: repoPath, runId: runtime.runId });
        return { runId: runtime.runId, state: runtime.snapshot() };
      } catch (err) {
        await context.audit({ action: "run.create", result: "error", projectId: repoPath, detail: String(err) });
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  app.get("/api/projects/:enc/runs", async (req, reply) => {
    const repoPath = context.decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    const manager = registry.peek(repoPath);
    if (!manager) return { runs: [] };
    const runs = await manager.listRuns();
    return { runs: runs.map((run) => ({ runId: run.runId, status: run.state.status, phase: run.state.phase, createdAt: run.state.createdAt })) };
  });

  app.get("/api/projects/:enc/runs/:runId", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    if (scope.runtime) return scope.runtime.snapshot();
    const result = scope.runDir ? await context.diskState(scope.runDir) : null;
    if (result?.ok) return result.state;
    if (result && !result.ok) return reply.code(500).send({ error: `run state degraded: ${result.reason}`, degraded: true });
    return reply.code(404).send({ error: "unknown run" });
  });

  app.delete("/api/projects/:enc/runs/:runId", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    try {
      if (scope.runtime) {
        await scope.runtime.dispatch({ type: "ABORT" }).catch(() => undefined);
        await registry.settle(runId).catch(() => undefined);
      }
      registry.removeRun(runId);
      const rDir = scope.runDir ?? runPaths(scope.repoPath, runId).runDir;
      await fs.rm(rDir, { recursive: true, force: true });
      await context.audit({ action: "run.delete", result: "ok", projectId: scope.repoPath, runId });
      return { ok: true };
    } catch (err) {
      await context.audit({ action: "run.delete", result: "error", projectId: scope.repoPath, runId, errorCode: "E_DELETE_PARTIAL", detail: String(err) });
      return reply.code(500).send({ error: String(err), code: "E_DELETE_PARTIAL" });
    }
  });

  app.get("/api/projects/:enc/runs/:runId/usage", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    if (!scope.runtime) return { total: 0, byAgent: {}, byProvider: {} };
    return scope.runtime.usage;
  });

  app.get("/api/projects/:enc/runs/:runId/events", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const since = Number((req.query as { since?: string }).since ?? 0);
    const sinceSeq = Number.isFinite(since) ? since : 0;
    if (!scope.runtime) {
      const { events, corruptLines } = await context.diskReplay(scope.runDir!, sinceSeq);
      return { events, corruptLineCount: corruptLines, replayDegraded: corruptLines > 0 };
    }
    const log = scope.runtime.events;
    const { events, corruptLines } = await log.replaySince(sinceSeq);
    return {
      events,
      corruptLineCount: corruptLines,
      replayDegraded: corruptLines > 0 || log.degraded,
      persistenceFailures: log.persistenceFailures,
    };
  });
}
