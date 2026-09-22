import { z } from "zod";

/**
 * Historian output — the Product Intent Document every downstream agent must respect.
 * "Don't deviate from the product's soul."
 */
export const ProductIntentSchema = z.object({
  /** One-paragraph summary of what this product is supposed to do. */
  productSummary: z.string().min(1),
  /** Modules / directories that appear to be the product's core. */
  coreAreas: z.array(z.string()),
  /** Areas that look frozen / legacy — prefer not to touch. */
  frozenAreas: z.array(z.string()),
  /** Areas with active churn (recent commits, TODOs). */
  activeChurnAreas: z.array(z.string()),
  /** Hard constraints derived from intent (e.g. "preserve auth flows"). */
  intentConstraints: z.array(z.string()),
  /** Evidence sources used (README paths, commit subjects, TODO hits). */
  sources: z.array(z.string()),
  notes: z.array(z.string()).optional(),
});
export type ProductIntent = z.infer<typeof ProductIntentSchema>;
