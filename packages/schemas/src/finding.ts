import { z } from "zod";

export const RiskBandSchema = z.enum(["low", "medium", "high", "forbidden"]);
export type RiskBand = z.infer<typeof RiskBandSchema>;

/** Factor keys the Risk Assessor weighs. Extensible without schema changes. */
export const RISK_FACTORS = [
  "filesAffected",
  "linesChanged",
  "publicApiTouched",
  "dbTouched",
  "authTouched",
  "depsChanged",
  "concurrency",
  "externalCalls",
  "testCoverage",
  "churn",
] as const;
export type RiskFactorKey = (typeof RISK_FACTORS)[number];

export const RiskFactorSchema = z.object({
  key: z.string().min(1),
  /** Contribution to the score, roughly -25..+35 each. */
  weight: z.number(),
  note: z.string().optional(),
});
export type RiskFactor = z.infer<typeof RiskFactorSchema>;

export const RiskScoreSchema = z.object({
  /** 0 (trivial) .. 100 (untouchable). */
  value: z.number().min(0).max(100),
  band: RiskBandSchema,
  factors: z.array(RiskFactorSchema),
  /** Plain-language justification shown in the UI. */
  rationale: z.string().optional(),
});
export type RiskScore = z.infer<typeof RiskScoreSchema>;

export const FindingCategorySchema = z.enum([
  "architecture",
  "smell",
  "testing",
  "consistency",
  "security",
  "dependency",
  "documentation",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FINDING_CATEGORIES: readonly FindingCategory[] = [
  "architecture",
  "smell",
  "testing",
  "consistency",
  "security",
  "dependency",
  "documentation",
];

export const RecommendedChangeCategorySchema = z.enum([
  "extract-function",
  "extract-module",
  "extract-service",
  "rename",
  "move-code",
  "delete-dead-code",
  "deduplicate",
  "introduce-boundary",
  "add-tests",
  "restyle-consistency",
  "none",
]);
export type RecommendedChangeCategory = z.infer<typeof RecommendedChangeCategorySchema>;

/**
 * A diagnosis finding. Evidence-first: every claim carries verifiable evidence
 * (file:line refs, counts, metric snapshots). No finding without evidence.
 */
export const FindingSchema = z.object({
  findingId: z.string().regex(/^FND-[0-9]{3,}$/),
  title: z.string().min(1),
  /** "src/routes/orders.ts:143" — POSIX repo-relative. */
  location: z.string(),
  /** Concrete, verifiable statements supporting the claim. */
  evidence: z.array(z.string()).min(1),
  impact: z.string().min(1).describe("Why this matters, in one or two sentences"),
  confidence: z.number().min(0).max(1),
  category: FindingCategorySchema,
  recommendedChangeCategory: RecommendedChangeCategorySchema,
  /** Assigned by the Risk Assessor; initial diagnosis agents leave a placeholder. */
  risk: RiskScoreSchema,
  /** Set by Synthesis when this finding is folded into a proposal. */
  proposedChangeId: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsArtifactSchema = z.object({
  findings: z.array(FindingSchema),
  notes: z.array(z.string()).optional(),
});
export type FindingsArtifact = z.infer<typeof FindingsArtifactSchema>;

export const RiskAssessmentsArtifactSchema = z.object({
  /** findingId -> assessed risk, overwriting the placeholder. */
  assessments: z.record(z.string(), RiskScoreSchema),
  /** Locations declared untouchable this run. Injected as constraints downstream. */
  forbiddenZones: z.array(z.string()),
  rationale: z.string().optional(),
});
export type RiskAssessmentsArtifact = z.infer<typeof RiskAssessmentsArtifactSchema>;
