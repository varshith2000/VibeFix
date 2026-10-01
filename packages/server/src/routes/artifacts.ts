import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { BacklogArtifactSchema, ReportArtifactSchema, type ChangeLedgerEntry } from "@vibefix/schemas";
import { runPaths } from "@vibefix/core";
import type { ServerContext } from "../context.js";

export function registerArtifactRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get("/api/projects/:enc/runs/:runId/backlog", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? context.diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const backlog = await store.latest("backlog");
    if (!backlog) {
      if (store.degraded) return reply.code(500).send({ error: "evidence degraded", degraded: true, corruptArtifacts: store.corruptArtifacts });
      return { proposals: [], unaddressedFindings: [] };
    }
    try { return BacklogArtifactSchema.parse(backlog.data); }
    catch (err) { return reply.code(500).send({ error: String(err) }); }
  });

  app.get("/api/projects/:enc/runs/:runId/ledger", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const file = scope.runtime ? runPaths(scope.repoPath, runId).ledgerFile : path.join(scope.runDir!, "ledger.json");
    return await fs.readFile(file, "utf8")
      .then((text) => JSON.parse(text) as { entries: ChangeLedgerEntry[] })
      .catch(() => ({ entries: [] as ChangeLedgerEntry[] }));
  });

  app.get("/api/projects/:enc/runs/:runId/report", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? context.diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const report = await store.latest("report");
    if (!report) {
      if (store.degraded) return reply.code(500).send({ error: "evidence degraded", degraded: true, corruptArtifacts: store.corruptArtifacts });
      return reply.code(404).send({ error: "report not ready" });
    }
    return ReportArtifactSchema.parse(report.data);
  });
}
