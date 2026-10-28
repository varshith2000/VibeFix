import type { FastifyInstance } from "fastify";
import { ApproveRunRequestSchema, BacklogArtifactSchema, IdempotentCommandRequestSchema, parseRequestBody } from "@vibefix/schemas";
import type { ServerContext } from "../context.js";

export function registerApprovalRoutes(app: FastifyInstance, context: ServerContext): void {
  const { registry } = context;
  app.post<{ Params: { enc: string; runId: string }; Body: { mode?: "minimal" | "balanced" | "comprehensive"; approvedProposalIds?: string[] } }>(
    "/api/projects/:enc/runs/:runId/approve", async (req, reply) => {
      const body = parseRequestBody(ApproveRunRequestSchema, req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid request body", code: "E_INVALID_BODY", issues: body.issues });
      const { enc, runId } = req.params;
      const scope = await context.resolveRun(enc, runId, reply);
      if (!scope) return reply;
      if (!scope.runtime) return reply.code(409).send({ error: "run is not live in this server — open it first" });
      const runtime = scope.runtime;

      const outcome = await context.withIdempotency(runId, req, async () => {
        const state = runtime.snapshot();
        if (state.phase !== "awaitingApproval") {
          return { status: 409, body: { error: `run is in phase '${state.phase}', not awaitingApproval` } };
        }
        const backlogArtifact = await runtime.store.latest("backlog");
        const backlog = backlogArtifact ? BacklogArtifactSchema.safeParse(backlogArtifact.data) : null;
        const approved = body.data.approvedProposalIds ?? (backlog?.success ? backlog.data.proposals.map((proposal) => proposal.proposalId) : []) ?? [];
        const mode = body.data.mode ?? state.mode;
        try {
          await runtime.dispatch({ type: "CHECKPOINT_APPROVED", mode, approvedProposalIds: approved });
          await context.audit({ action: "run.approve", result: "ok", projectId: scope.repoPath, runId, detail: `approved ${approved.length}` });
          return { status: 200, body: { ok: true, approved, mode } };
        } catch (err) {
          console.error(`[VibeFix] Checkpoint approval failed for run ${runId}:`, err);
          await context.audit({ action: "run.approve", result: "error", projectId: scope.repoPath, runId, detail: String(err) });
          return { status: 500, body: { error: String(err instanceof Error ? err.message : err) } };
        }
      });

      if (outcome.replayed) reply.header("x-idempotent-replay", "true");
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  const command = async (type: "CHECKPOINT_REJECTED" | "ABORT" | "RESUME", req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const parsed = parseRequestBody(IdempotentCommandRequestSchema, req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid request body", code: "E_INVALID_BODY", issues: parsed.issues });
    const { enc, runId } = req.params as { enc: string; runId: string };
    const scope = await context.resolveRun(enc, runId, reply);
    if (!scope) return reply;
    if (!scope.runtime) return reply.code(409).send({ error: "run is not live in this server — open it first" });

    const outcome = await context.withIdempotency(runId, req, async () => {
      if (type === "CHECKPOINT_REJECTED" && scope.runtime!.snapshot().phase !== "awaitingApproval") {
        return { status: 409, body: { error: `run is in phase '${scope.runtime!.snapshot().phase}', not awaitingApproval` } };
      }
      const dispatch = type === "RESUME" ? scope.runtime!.resume() : scope.runtime!.dispatch({ type });
      await registry.track(runId, dispatch);
      const actionName = type === "CHECKPOINT_REJECTED" ? "run.reject" : type === "ABORT" ? "run.abort" : "run.resume";
      await context.audit({ action: actionName, result: "ok", projectId: scope.repoPath, runId });
      return { status: 200, body: { ok: true } };
    });

    if (outcome.replayed) reply.header("x-idempotent-replay", "true");
    return reply.code(outcome.status).send(outcome.body);
  };
  app.post("/api/projects/:enc/runs/:runId/reject", (req, reply) => command("CHECKPOINT_REJECTED", req, reply));
  app.post("/api/projects/:enc/runs/:runId/abort", (req, reply) => command("ABORT", req, reply));
  app.post("/api/projects/:enc/runs/:runId/resume", (req, reply) => command("RESUME", req, reply));
}
