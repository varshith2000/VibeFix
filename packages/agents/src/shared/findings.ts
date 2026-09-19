import type { Finding, FindingCategory, RecommendedChangeCategory } from "@vibefix/schemas";

let counter = 0;
export function resetFindingCounter(): void {
  counter = 0;
}

export function nextFindingId(): string {
  counter += 1;
  return `FND-${String(counter).padStart(3, "0")}`;
}

/** Placeholder risk — the Risk Assessor overwrites it with a real score. */
export function makeFinding(input: {
  title: string;
  location: string;
  evidence: string[];
  impact: string;
  category: FindingCategory;
  recommendedChangeCategory: RecommendedChangeCategory;
  confidence?: number;
}): Finding {
  return {
    findingId: nextFindingId(),
    title: input.title,
    location: input.location,
    evidence: input.evidence,
    impact: input.impact,
    confidence: input.confidence ?? 0.7,
    category: input.category,
    recommendedChangeCategory: input.recommendedChangeCategory,
    risk: {
      value: 50,
      band: "medium",
      factors: [{ key: "pending-assessment", weight: 0, note: "placeholder until risk-assessor runs" }],
    },
    proposedChangeId: null,
  };
}
