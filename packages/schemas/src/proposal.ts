import { z } from "zod";
import { RefactoringModeSchema } from "./mode.js";
import { RiskScoreSchema } from "./finding.js";

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "deferred",
  "implemented",
  "rolledBack",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ConstraintSchema = z.enum([
  "no-public-api-change",
  "no-dependency-changes",
  "no-schema-changes",
  "no-behavior-change",
  "no-new-abstractions",
  "minimal-diff",
]);
export type Constraint = z.infer<typeof ConstraintSchema>;

export const RollbackStrategySchema = z.object({
  type: z.enum(["discardWorktree", "revertCommit"]),
});
export type RollbackStrategy = z.infer<typeof RollbackStrategySchema>;

/**
 * Human-facing explanation attached to a proposal by Synthesis: what exists
 * today, what will exist after, and why the difference matters. Optional so
 * older artifacts keep decoding (additive schema evolution).
 */
export const ProposalExplanationSchema = z.object({
  currentState: z.string().describe("How this part of the system works today"),
  proposedState: z.string().describe("How it will work after this change"),
  whyItMatters: z.string().describe("The engineering principle and concrete consequence"),
});
export type ProposalExplanation = z.infer<typeof ProposalExplanationSchema>;

/**
 * The Change Proposal — the atomic unit of transformation. Agents don't "edit
 * code"; they operate on these. Everything the firewall, engineer, verifiers,
 * ledger and report read is declared here up front.
 */
export const ChangeProposalSchema = z.object({
  proposalId: z.string().regex(/^RFC-[0-9]{3,}$/),
  title: z.string().min(1),
  problem: z.string().min(1),
  /** Findings this proposal resolves. */
  evidence: z.array(z.string()).min(1),
  /** Glob patterns (POSIX, repo-relative). The firewall allows writes ONLY here. */
  filesInScope: z.array(z.string()).min(1),
  filesOutOfScope: z.array(z.string()),
  risk: RiskScoreSchema,
  expectedBenefit: z.array(z.string()).min(1),
  constraints: z.array(ConstraintSchema),
  minimalChange: z.boolean(),
  testsRequired: z.array(z.string()),
  rollbackStrategy: RollbackStrategySchema,
  approvalStatus: ApprovalStatusSchema,
  /** priority = impact ÷ risk; higher = earlier in the backlog. */
  priority: z.number(),
  allowedInModes: z.array(RefactoringModeSchema).min(1),
  explanation: ProposalExplanationSchema.optional(),
  /** Mermaid diagram contrasting before/after, when a picture earns its place. */
  beforeAfterDiagram: z.string().optional(),
});
export type ChangeProposal = z.infer<typeof ChangeProposalSchema>;

export const BacklogArtifactSchema = z.object({
  proposals: z.array(ChangeProposalSchema),
  /** Findings deliberately not addressed this run, with reasons. */
  unaddressedFindings: z.array(z.object({ findingId: z.string(), reason: z.string() })),
  notes: z.array(z.string()).optional(),
});
export type BacklogArtifact = z.infer<typeof BacklogArtifactSchema>;

export const LedgerVerdictSchema = z.enum(["pending", "passed", "rejected", "deferred"]);
export type LedgerVerdict = z.infer<typeof LedgerVerdictSchema>;

export const ChangeLedgerEntrySchema = z.object({
  ledgerId: z.string().regex(/^led_[0-9a-z]+$/),
  proposalId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  worktreePath: z.string().nullable(),
  baseCommit: z.string().nullable(),
  diff: z.string(),
  verdict: LedgerVerdictSchema,
  verifierNotes: z.array(z.string()),
  committedRef: z.string().nullable(),
  ts: z.string().datetime(),
});
export type ChangeLedgerEntry = z.infer<typeof ChangeLedgerEntrySchema>;

/** Attempt record written by the engineer (its reasoning lives ONLY here, never shown to verifiers). */
export const ChangeAttemptArtifactSchema = z.object({
  proposalId: z.string(),
  attempt: z.number().int().nonnegative(),
  worktreePath: z.string(),
  rationale: z.string(),
  filesTouched: z.array(z.string()),
});
export type ChangeAttemptArtifact = z.infer<typeof ChangeAttemptArtifactSchema>;

export const GateResultSchema = z.object({
  gate: z.enum(["firewall-scope", "characterization-suite", "regression-suite", "public-api-surface"]),
  result: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"]),
  details: z.string(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

/** Fresh-context verdict from the Behavior Equivalence Verifier. */
export const VerdictArtifactSchema = z.object({
  proposalId: z.string(),
  attempt: z.number().int().nonnegative(),
  verdict: z.enum(["passed", "rejected"]),
  gates: z.array(GateResultSchema),
  /** Residual judgment: "is the diff behavior-preserving where tests can't see?" */
  residualRationale: z.string(),
  rejectionReasons: z.array(z.string()),
});
export type VerdictArtifact = z.infer<typeof VerdictArtifactSchema>;

export const BehavioralBaselineArtifactSchema = z.object({
  harnessBranch: z.string(),
  testFiles: z.array(z.string()),
  /** Test results snapshot — the ground truth the verifier compares against. */
  baselineResults: z.unknown(),
  excluded: z.array(z.object({ test: z.string(), reason: z.string() })),
  publicApiSurface: z.array(z.string()).describe("exports/endpoints pinned at baseline"),
});
export type BehavioralBaselineArtifact = z.infer<typeof BehavioralBaselineArtifactSchema>;
