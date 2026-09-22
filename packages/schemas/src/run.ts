import { z } from "zod";
import { AgentRunStatusSchema } from "./agent.js";
import { RefactoringModeSchema } from "./mode.js";

export const RunPhaseSchema = z.enum([
  "init",
  "recon",
  "diagnosis",
  "riskAssessment",
  "synthesis",
  "minimality",
  "awaitingApproval",
  "harness",
  "execution",
  "report",
  "completed",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

/** Ordered phases — used by the UI graph layout and resume validation. */
export const RUN_PHASES: readonly RunPhase[] = [
  "init",
  "recon",
  "diagnosis",
  "riskAssessment",
  "synthesis",
  "minimality",
  "awaitingApproval",
  "harness",
  "execution",
  "report",
  "completed",
];

export const RunStatusSchema = z.enum([
  "running",
  "paused",
  "awaitingApproval",
  "aborted",
  "failed",
  "completed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ExecutionStageSchema = z.enum(["implement", "verify", "commit", "rollback", "defer"]);
export type ExecutionStage = z.infer<typeof ExecutionStageSchema>;

export const RunBudgetSchema = z.object({
  tokensSpent: z.number().int().nonnegative(),
  changesCommitted: z.number().int().nonnegative(),
  retriesUsed: z.number().int().nonnegative(),
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;

/**
 * The single source of truth for a run's progress, persisted atomically
 * after every reducer transition. Everything else is derivable from the
 * evidence store; this file exists so resume is O(1) and the UI can snapshot.
 */
export const RunStateSchema = z.object({
  runId: z.string().regex(/^run_[0-9a-z]+$/),
  /** Absolute, OS-native path to the target repository. The ONLY non-portable path in the store. */
  repoPath: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  mode: RefactoringModeSchema,
  agentStates: z.record(z.string(), AgentRunStatusSchema),
  execution: z.object({
    /** Approved proposalIds in priority order. */
    queue: z.array(z.string()),
    currentIndex: z.number().int().nonnegative(),
    /** Retry attempt for the current proposal (0 = first try). */
    attempt: z.number().int().nonnegative(),
    stage: ExecutionStageSchema,
  }),
  approval: z.object({
    requested: z.boolean(),
    decidedAt: z.string().datetime().nullable(),
    approvedItems: z.array(z.string()),
    mode: RefactoringModeSchema.nullable(),
  }),
  budget: RunBudgetSchema,
  error: z.string().nullable(),
  schemaVersion: z.literal(1),
});
export type RunState = z.infer<typeof RunStateSchema>;
