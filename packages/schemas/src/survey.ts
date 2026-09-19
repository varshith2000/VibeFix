import { z } from "zod";

/** Test Surveyor's map of the existing safety net. */
export const TestSurveyArtifactSchema = z.object({
  frameworks: z.array(z.string()),
  testFileCount: z.number().int().nonnegative(),
  testCount: z.number().int().nonnegative().describe("Best-effort count of test cases"),
  canInstall: z.boolean(),
  canBuild: z.boolean(),
  canTest: z.boolean(),
  coveragePercent: z.number().min(0).max(100).nullable(),
  testedPaths: z.array(z.string()),
  /** Critical paths with no coverage — feeds "what's missing". */
  untestedPaths: z.array(z.string()),
  notes: z.array(z.string()).optional(),
});
export type TestSurveyArtifact = z.infer<typeof TestSurveyArtifactSchema>;

/** Harness Builder's plan for pinning current behavior before any refactor. */
export const CharacterizationPlanSchema = z.object({
  branch: z.string(),
  testFiles: z.array(
    z.object({
      /** Where the characterization test file is written (repo-relative, POSIX). */
      path: z.string(),
      /** Behaviors pinned by this file. */
      pins: z.array(z.string()),
    }),
  ),
  publicApiSurface: z.array(z.string()),
  excluded: z.array(z.object({ test: z.string(), reason: z.string() })),
});
export type CharacterizationPlan = z.infer<typeof CharacterizationPlanSchema>;

/** Firewall violation record. Two violations in one attempt = auto-reject. */
export const FirewallViolationSchema = z.object({
  proposalId: z.string(),
  attempt: z.number().int().nonnegative(),
  path: z.string().describe("The blocked write target (POSIX, repo-relative)"),
  reason: z.string(),
  ts: z.string().datetime(),
});
export type FirewallViolation = z.infer<typeof FirewallViolationSchema>;
