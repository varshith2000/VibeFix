import type {
  AgentRunStatus,
  ChangeProposal,
  RefactoringMode,
  RunState,
} from "@vibefix/schemas";

/**
 * Commands fed into the reducer. Everything the system can do is one of these.
 * Runtime dispatches them; reduce() is pure and returns effects to perform.
 */
export type RunEvent =
  | { type: "START" }
  | { type: "AGENT_STARTED"; agentId: string }
  | { type: "PHASE_COMPLETED"; phase: RunState["phase"] }
  | {
      type: "AGENT_RESULT";
      agentId: string;
      outcome: "passed" | "failed" | "rejected";
      artifactIds: string[];
    }
  | { type: "CHECKPOINT_APPROVED"; mode: RefactoringMode; approvedProposalIds: string[] }
  | { type: "CHECKPOINT_REJECTED" }
  | { type: "GATE_VERDICT"; proposalId: string; verdict: "passed" | "rejected"; reason?: string }
  | { type: "ABORT" }
  | { type: "BUDGET_EXCEEDED" }
  | { type: "FATAL"; message: string };

/** Effects the runtime performs. The reducer never does I/O itself. */
export type Effect =
  | {
      effect: "EmitEvent";
      type: import("@vibefix/schemas").AgentExecutionEventType;
      agentId?: string;
      proposalId?: string;
      message?: string;
      payload?: unknown;
    }
  | { effect: "SpawnPool"; pool: "recon" | "diagnosis"; agentIds: string[] }
  | { effect: "InvokeAgent"; agentId: string }
  | { effect: "ExecuteProposal"; proposalId: string; attempt: number }
  | { effect: "PauseForApproval" }
  | { effect: "CleanupWorktrees" };

export interface AgentRegistrySnapshot {
  agentIdsByPool(pool: "recon" | "diagnosis"): string[];
  agentIdByPhase(phase: "riskAssessment" | "synthesis" | "harness" | "report"): string | null;
}

export function createInitialRunState(input: {
  runId: string;
  repoPath: string;
  mode: RefactoringMode;
  agentIds: string[];
}): RunState {
  const now = new Date().toISOString();
  const agentStates: Record<string, AgentRunStatus> = {};
  for (const id of input.agentIds) agentStates[id] = "queued";
  return {
    runId: input.runId,
    repoPath: input.repoPath,
    createdAt: now,
    updatedAt: now,
    status: "running",
    phase: "init",
    mode: input.mode,
    agentStates,
    execution: { queue: [], currentIndex: 0, attempt: 0, stage: "implement" },
    approval: { requested: false, decidedAt: null, approvedItems: [], mode: null },
    budget: { tokensSpent: 0, changesCommitted: 0, retriesUsed: 0 },
    error: null,
    schemaVersion: 1,
  };
}

export function cloneState(state: RunState): RunState {
  return structuredClone(state);
}

export type { ChangeProposal };
