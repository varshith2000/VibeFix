import type { FastifyInstance } from "fastify";
import { FindingsArtifactSchema, KnowledgeGraphSchema, ProductIntentSchema, TestSurveyArtifactSchema } from "@vibefix/schemas";
import type { ServerContext } from "../context.js";

export function registerFindingRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get("/api/projects/:enc/runs/:runId/findings", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? context.diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const findings = [];
    for (const artifact of await store.list(undefined, "findings")) {
      try { findings.push(...FindingsArtifactSchema.parse(artifact.data).findings); } catch { /* skip invalid artifact */ }
    }
    return { findings };
  });

  app.get("/api/projects/:enc/runs/:runId/intelligence", async (req, reply) => {
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    const store = scope.runtime?.store ?? (scope.runDir ? context.diskEvidence(scope.runDir) : null);
    if (!store) return reply.code(404).send({ error: "unknown run" });
    const graphArt = await store.latest("knowledge-graph");
    const intentArt = await store.latest("product-intent");
    const surveyArt = await store.latest("test-survey");
    const findings: Array<{ category: string; risk: { band: string; value: number } }> = [];
    for (const artifact of await store.list(undefined, "findings")) {
      try { findings.push(...FindingsArtifactSchema.parse(artifact.data).findings); } catch { /* skip invalid artifact */ }
    }
    const byCat: Record<string, number> = {};
    const byBand: Record<string, number> = { low: 0, medium: 0, high: 0, forbidden: 0 };
    for (const finding of findings) {
      byCat[finding.category] = (byCat[finding.category] ?? 0) + 1;
      byBand[finding.risk.band] = (byBand[finding.risk.band] ?? 0) + 1;
    }
    const pressure = (byBand.forbidden ?? 0) * 12 + (byBand.high ?? 0) * 6 + (byBand.medium ?? 0) * 2 + (byBand.low ?? 0);
    const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
    const survey = surveyArt ? TestSurveyArtifactSchema.safeParse(surveyArt.data) : null;
    const testingScore = survey?.success
      ? clamp((survey.data.canTest ? 40 : 0) + (survey.data.testFileCount > 0 ? 30 : 0) + Math.min(30, survey.data.testFileCount * 3) - (survey.data.untestedPaths.length > 5 ? 15 : 0))
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
}