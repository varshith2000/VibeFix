import type {
  AgentDefinition,
  ChangeProposal,
  RunState,
} from "@vibefix/schemas";
import type { EvidenceStore, ChangeFirewall, WorktreeHandle } from "@vibefix/core";
import type { TextGenerationClient, TypedDecisionClient } from "@vibefix/llm";
import type { FsFacts, ImportEdge, RepoSnapshot, TestRunner } from "@vibefix/adapters";
import type { FileMetrics } from "@vibefix/adapters";

/** Deterministic tools every agent gets. Facts first, interpretation second. */
export interface AgentToolset {
  fs: FsFacts;
  runner: TestRunner;
  snapshot: RepoSnapshot;
  importEdges: ImportEdge[];
  /** Which analyzer built the graph ("ts-module-resolution" | "regex-heuristic"). */
  importGraphAnalyzer: string;
  metrics: FileMetrics;
}

/** Everything one agent invocation needs. Built by the executor per run. */
export interface AgentExecutionContext {
  def: AgentDefinition;
  runState: RunState;
  repoPath: string;
  store: EvidenceStore;
  tools: AgentToolset;
  /** Resolved per ModelRouting; absent when the routed provider is unavailable. */
  llm?: TextGenerationClient;
  decision?: TypedDecisionClient;
  proposal?: ChangeProposal;
  worktree?: WorktreeHandle;
  firewall?: ChangeFirewall;
  attempt?: number;
  forbiddenZones?: string[];
  progress(step: string, detail?: string): Promise<void>;
}

export interface AgentOutcomeCore {
  outcome: "passed" | "rejected" | "failed";
  artifactIds: string[];
  reason?: string;
  error?: string;
}

export interface VibeFixAgent {
  definition: AgentDefinition;
  execute(ctx: AgentExecutionContext): Promise<AgentOutcomeCore>;
}

export function passed(artifactIds: string[]): AgentOutcomeCore {
  return { outcome: "passed", artifactIds };
}

export function rejected(reason: string): AgentOutcomeCore {
  return { outcome: "rejected", artifactIds: [], reason };
}

export function failed(error: unknown): AgentOutcomeCore {
  return { outcome: "failed", artifactIds: [], error: String(error) };
}
