import type { AgentDefinition, ChangeProposal, RunState } from "@vibefix/schemas";
import type { ChangeFirewall } from "../worktree/firewall.js";
import type { WorktreeHandle } from "../worktree/worktree-manager.js";

export interface AgentExecutionOutcome {
  outcome: "passed" | "failed" | "rejected";
  artifactIds: string[];
  reason?: string;
  error?: string;
}

/** Everything an execution-phase agent might need. Optional fields are set by the runtime. */
export interface AgentExecutionInput {
  runState: RunState;
  /** Current proposal — set for harness/execution/verification agents. */
  proposal?: ChangeProposal;
  worktree?: WorktreeHandle;
  firewall?: ChangeFirewall;
  attempt?: number;
  forbiddenZones?: string[];
}

/**
 * The port the agents package implements. Core never imports agents —
 * the composition root wires a real executor; tests wire fakes.
 */
export interface AgentExecutorPort {
  definitions(): AgentDefinition[];
  execute(definition: AgentDefinition, input: AgentExecutionInput): Promise<AgentExecutionOutcome>;
}
