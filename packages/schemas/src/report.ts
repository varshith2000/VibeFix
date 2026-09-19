import { z } from "zod";

/** Docent's final output. `report.md` is rendered; this is the structured twin. */
export const ReportArtifactSchema = z.object({
  stateOfCodebase: z.string(),
  changeExplainers: z.array(
    z.object({
      proposalId: z.string(),
      what: z.string(),
      why: z.string(),
      principle: z.string(),
      deliberatelyNotTouched: z.array(z.string()),
    }),
  ),
  whatDidNotChange: z.array(z.string()),
  learningSummary: z.string(),
  totals: z.object({
    changesProposed: z.number().int(),
    changesCommitted: z.number().int(),
    changesRejected: z.number().int(),
    changesDeferred: z.number().int(),
    filesChanged: z.number().int(),
    publicApiChanges: z.number().int(),
    tokensSpent: z.number().int(),
  }),
});
export type ReportArtifact = z.infer<typeof ReportArtifactSchema>;
