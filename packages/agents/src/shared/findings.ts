import { createHash } from "node:crypto";
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
  /** Provenance: "ts-ast" | "regex-heuristic" | "import-graph" | "llm-validated" | "llm-unverified" | ... */
  analyzer?: string;
  /** Parser/probe status, e.g. "typescript-5 AST" or "regex fallback". */
  parserStatus?: string;
}): Finding {
  const stableKey = [
    input.category,
    input.location.trim().replace(/\\/g, "/").replace(/:\d+$/, "").toLowerCase(),
    input.recommendedChangeCategory,
    [...input.evidence].map((line) => line.trim().replace(/\s+/g, " ").toLowerCase()).sort().join("|"),
  ].join("\u0000");
  const numericId = BigInt(`0x${createHash("sha256").update(stableKey).digest("hex").slice(0, 15)}`)
    % 1_000_000_000_000n;
  return {
    // Content-derived IDs survive concurrency and process restart. The schema
    // keeps its historical numeric FND shape for artifact compatibility.
    findingId: `FND-${numericId.toString().padStart(12, "0")}`,
    title: input.title,
    location: input.location,
    evidence: input.evidence,
    impact: input.impact,
    confidence: input.confidence ?? 0.7,
    category: input.category,
    recommendedChangeCategory: input.recommendedChangeCategory,
    ...(input.analyzer !== undefined ? { analyzer: input.analyzer } : {}),
    ...(input.parserStatus !== undefined ? { parserStatus: input.parserStatus } : {}),
    risk: {
      value: 50,
      band: "medium",
      factors: [{ key: "pending-assessment", weight: 0, note: "placeholder until risk-assessor runs" }],
    },
    proposedChangeId: null,
  };
}

/**
 * Content fingerprint for finding deduplication. Title matching is too
 * shallow: same defect + different wording survives, different defect +
 * similar wording merges. The fingerprint is category + normalized location
 * + normalized evidence + recommendation — two findings with the same
 * fingerprint describe the same problem regardless of how they are titled.
 */
export function findingFingerprint(input: {
  category: string;
  location: string;
  evidence: string[];
  recommendedChangeCategory: string;
}): string {
  const normalizeLocation = (loc: string) => loc.trim().replace(/\\/g, "/").replace(/:\d+$/, "").toLowerCase();
  const normalizeEvidence = (lines: string[]) =>
    lines
      .map((l) => l.trim().replace(/\s+/g, " ").toLowerCase())
      .filter(Boolean)
      .sort()
      .join("|");
  return createHash("sha1")
    .update(
      [
        input.category.toLowerCase(),
        normalizeLocation(input.location),
        normalizeEvidence(input.evidence),
        input.recommendedChangeCategory.toLowerCase(),
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Shape of an LLM-discovered finding before validation. */
export interface LlmFindingCandidate {
  title: string;
  location: string;
  evidence: string[];
  impact: string;
  recommendedChangeCategory: RecommendedChangeCategory;
  confidence: number;
}

export type LlmValidationVerdict =
  | { accepted: true; analyzer: "llm-validated" | "llm-unverified" }
  | { accepted: false; reason: string };

/**
 * Post-validate a model-produced finding against repository facts BEFORE it
 * enters the evidence store. The model is instructed to cite real files, but
 * instructions are not validation:
 *
 * - The location must be a file that exists in the snapshot (a path prefix
 *   match, because locations carry ":line" suffixes and sometimes a parent
 *   directory for directory-level findings).
 * - If none of the evidence strings reference a known file, the finding is
 *   kept but demoted to "llm-unverified" (lower trust downstream).
 * - An unknown location is REJECTED — hallucinated paths must never become
 *   findings that the Engineer then "fixes".
 */
export function validateLlmFindingAgainstRepo(
  candidate: LlmFindingCandidate,
  knownFiles: string[],
): LlmValidationVerdict {
  const normalizedKnown = new Set(knownFiles.map((f) => f.replace(/\\/g, "/").toLowerCase()));
  const locationPath = candidate.location.trim().replace(/:\d+$/, "").replace(/\\/g, "/").toLowerCase();

  const locationKnown =
    normalizedKnown.has(locationPath) || [...normalizedKnown].some((f) => f.startsWith(`${locationPath}/`));
  if (!locationKnown) {
    return { accepted: false, reason: `location '${candidate.location}' does not exist in the repository snapshot` };
  }

  const evidenceMentionsKnownFile = candidate.evidence.some((line) => {
    const lower = line.toLowerCase();
    return [...normalizedKnown].some((f) => lower.includes(f));
  });
  return { accepted: true, analyzer: evidenceMentionsKnownFile ? "llm-validated" : "llm-unverified" };
}
