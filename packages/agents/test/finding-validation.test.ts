import { describe, it, expect } from "vitest";
import { findingFingerprint, validateLlmFindingAgainstRepo, makeFinding } from "../src/shared/findings.js";

const FILES = ["src/app.ts", "src/lib/util.ts", "components/Button.tsx"];

const candidate = (overrides: Partial<Parameters<typeof validateLlmFindingAgainstRepo>[0][number]> = {}) => ({
  title: "Mixed responsibilities in app module",
  location: "src/app.ts:42",
  evidence: ["src/app.ts renders UI and runs SQL"],
  impact: "Layers are entangled.",
  recommendedChangeCategory: "extract-service" as const,
  confidence: 0.8,
  ...overrides,
});

describe("findingFingerprint (content dedupe, not title dedupe)", () => {
  it("uses stable finding IDs independent of process-global ordering", () => {
    const input = {
      title: "Stable",
      location: "src/app.ts:12",
      evidence: ["src/app.ts has a cycle"],
      impact: "impact",
      category: "architecture" as const,
      recommendedChangeCategory: "introduce-boundary" as const,
    };
    const first = makeFinding(input);
    makeFinding({ ...input, location: "src/other.ts" });
    const repeated = makeFinding(input);
    expect(repeated.findingId).toBe(first.findingId);
  });

  it("same defect with different titles merges", () => {
    const a = { category: "architecture", location: "src/app.ts:42", evidence: ["imports db", "renders ui"], recommendedChangeCategory: "extract-service" };
    const b = { category: "architecture", location: "src/app.ts", evidence: ["renders ui", "imports db"], recommendedChangeCategory: "extract-service" };
    expect(findingFingerprint(a)).toBe(findingFingerprint(b));
  });

  it("different locations never merge", () => {
    const a = { category: "architecture", location: "src/app.ts", evidence: ["x"], recommendedChangeCategory: "extract-service" };
    const b = { category: "architecture", location: "src/lib/util.ts", evidence: ["x"], recommendedChangeCategory: "extract-service" };
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(b));
  });

  it("different categories or recommendations never merge", () => {
    const base = { location: "src/app.ts", evidence: ["x"] };
    expect(findingFingerprint({ ...base, category: "architecture", recommendedChangeCategory: "extract-service" })).not.toBe(
      findingFingerprint({ ...base, category: "smell", recommendedChangeCategory: "extract-service" }),
    );
    expect(findingFingerprint({ ...base, category: "architecture", recommendedChangeCategory: "extract-service" })).not.toBe(
      findingFingerprint({ ...base, category: "architecture", recommendedChangeCategory: "move-code" }),
    );
  });

  it("works on produced findings end-to-end", () => {
    const f1 = makeFinding({ title: "A", location: "src/app.ts:1", evidence: ["e1"], impact: "i", category: "smell", recommendedChangeCategory: "none" });
    const f2 = makeFinding({ title: "Completely different wording", location: "src/app.ts:2", evidence: ["e1"], impact: "i", category: "smell", recommendedChangeCategory: "none" });
    expect(findingFingerprint(f1)).toBe(findingFingerprint(f2));
  });
});

describe("validateLlmFindingAgainstRepo (hallucination guard)", () => {
  it("rejects a location that does not exist in the snapshot", () => {
    const verdict = validateLlmFindingAgainstRepo(candidate({ location: "src/hallucinated.ts:1" }), FILES);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toContain("src/hallucinated.ts");
  });

  it("accepts a known file location and marks it validated when evidence cites a real file", () => {
    const verdict = validateLlmFindingAgainstRepo(candidate(), FILES);
    expect(verdict).toEqual({ accepted: true, analyzer: "llm-validated" });
  });

  it("demotes findings whose evidence references no known file", () => {
    const verdict = validateLlmFindingAgainstRepo(candidate({ evidence: ["the app module mixes everything"] }), FILES);
    expect(verdict).toEqual({ accepted: true, analyzer: "llm-unverified" });
  });

  it("accepts a directory-level location that is a prefix of known files", () => {
    const verdict = validateLlmFindingAgainstRepo(candidate({ location: "src/lib" }), FILES);
    // Default evidence cites src/app.ts, so it still counts as validated.
    expect(verdict).toEqual({ accepted: true, analyzer: "llm-validated" });
    // And with evidence that cites nothing real, the same location is kept
    // but demoted to unverified.
    const demoted = validateLlmFindingAgainstRepo(
      candidate({ location: "src/lib", evidence: ["this directory mixes concerns"] }),
      FILES,
    );
    expect(demoted).toEqual({ accepted: true, analyzer: "llm-unverified" });
  });
});
