import { z } from "zod";

export const AgentExecutionEventTypeSchema = z.enum([
  "phase.entered",
  "phase.completed",
  "agent.queued",
  "agent.started",
  "agent.progress",
  "agent.completed",
  "agent.failed",
  "agent.rejected",
  "checkpoint.awaitingApproval",
  "checkpoint.approved",
  "proposal.verdict",
  "ledger.updated",
  "budget.warning",
  "run.aborted",
  "run.nochanges",
  "run.completed",
  "run.failed",
  "log",
]);
export type AgentExecutionEventType = z.infer<typeof AgentExecutionEventTypeSchema>;

/**
 * Append-only event stream entry. Persisted as NDJSON (one per line, seq = line
 * number) and bridged live to the UI over WebSocket. `payload` is intentionally
 * open — each event type carries its own shape; consumers treat it as data.
 */
export const AgentExecutionEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  ts: z.string().datetime(),
  /** Monotonic sequence number within the run = line number in events.ndjson. */
  seq: z.number().int().nonnegative(),
  type: AgentExecutionEventTypeSchema,
  agentId: z.string().optional(),
  proposalId: z.string().optional(),
  message: z.string().optional(),
  payload: z.unknown().optional(),
});
export type AgentExecutionEvent = z.infer<typeof AgentExecutionEventSchema>;

/** Progress sub-events streamed from inside a running agent (tool calls, LLM turns). */
export const AgentProgressSchema = z.object({
  agentId: z.string(),
  step: z.string().min(1),
  detail: z.string().optional(),
});
export type AgentProgress = z.infer<typeof AgentProgressSchema>;
