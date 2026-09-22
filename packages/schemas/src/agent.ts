import { z } from "zod";

/** The two capability kinds an agent can require from the LLM layer. */
export const CapabilityKindSchema = z.enum(["TextGeneration", "TypedDecision"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

/**
 * What an agent is allowed to touch.
 * - read-only:      may read repo + evidence, write only its own evidence artifacts
 * - evidence-write: may additionally write designated harness files (e.g. characterization tests)
 * - worktree-write: may modify tracked repo files, but ONLY inside a worktree behind the Change Firewall
 */
export const AgentPermissionSchema = z.enum(["read-only", "evidence-write", "worktree-write"]);
export type AgentPermission = z.infer<typeof AgentPermissionSchema>;

/** Which orchestrator phase an agent runs in. */
export const AgentPhaseSchema = z.enum([
  "recon",
  "diagnosis",
  "riskAssessment",
  "synthesis",
  "minimality",
  "harness",
  "execution",
  "verification",
  "report",
]);
export type AgentPhase = z.infer<typeof AgentPhaseSchema>;

/** Parallel pools. null = sequential agent scheduled directly by its phase. */
export const AgentPoolSchema = z.enum(["recon", "diagnosis", "verification"]);
export type AgentPool = z.infer<typeof AgentPoolSchema>;

export const ArtifactKindSchema = z.enum([
  "knowledge-graph",
  "product-intent",
  "test-survey",
  "findings",
  "risk-assessments",
  "backlog",
  "characterization-plan",
  "behavioral-baseline",
  "change-attempt",
  "verdict",
  "firewall-violation",
  "report",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * The static identity + contract of an agent. Registry data, not runtime state.
 * Adding a new agent = new definition + implementation + registry entry;
 * pools and the UI graph derive from these, so nothing else changes.
 */
export const AgentDefinitionSchema = z.object({
  agentId: z.string().regex(/^[a-z][a-z0-9-]*$/, "agentId must be kebab-case"),
  role: z.string().min(1).describe("Human-readable one-liner of what this agent owns"),
  phase: AgentPhaseSchema,
  capability: CapabilityKindSchema,
  permission: AgentPermissionSchema,
  /** Artifact kinds this agent writes. Must match what its execute() returns. */
  produces: z.array(ArtifactKindSchema),
  /** Artifact kinds this agent reads. Drives context-builder. */
  consumes: z.array(ArtifactKindSchema),
  /** Parallel pool this agent participates in, or null for sequential scheduling. */
  runsInPool: AgentPoolSchema.nullable(),
  /**
   * Fresh-context guarantee: the context builder structurally refuses to include
   * `change-attempt` reasoning for these agents. Verification agents must set true.
   */
  freshContext: z.boolean(),
  /** Ordering inside the verification gate set (reserved for future gate agents). */
  gateOrder: z.number().int().optional(),
  /** Which phases of the execution loop this agent participates in (execution-phase agents only). */
  label: z.string().min(1).describe("Short display label for the UI graph"),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "rejected",
  "skipped",
  "deferred",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
