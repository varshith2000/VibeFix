import { describe, expect, it } from "vitest";
import { ChangeFirewall } from "../src/index.js";
import { globMatch, globMatchAny } from "../src/util/glob.js";
import type { ChangeProposal } from "@vibefix/schemas";

function proposal(overrides: Partial<ChangeProposal> = {}): ChangeProposal {
  return {
    proposalId: "RFC-001",
    title: "test",
    problem: "test",
    evidence: ["FND-001"],
    filesInScope: ["src/auth/**", "src/utils.js"],
    filesOutOfScope: ["src/auth/legacy.js"],
    risk: { value: 20, band: "low", factors: [] },
    expectedBenefit: ["b"],
    constraints: [],
    minimalChange: true,
    testsRequired: [],
    rollbackStrategy: { type: "discardWorktree" },
    approvalStatus: "approved",
    priority: 1,
    allowedInModes: ["minimal"],
    ...overrides,
  };
}

describe("glob matching", () => {
  it("matches within-segment *", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/b.ts")).toBe(false);
  });
  it("matches across-segment **", () => {
    expect(globMatch("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/c.ts")).toBe(true);
  });
  it("does not let * cross segments", () => {
    expect(globMatchAny(["src/*"], "src/a/b")).toBe(false);
  });
});

describe("ChangeFirewall", () => {
  it("allows writes inside declared scope", () => {
    const fw = new ChangeFirewall(proposal());
    expect(fw.canWrite("src/auth/session.ts").allowed).toBe(true);
    expect(fw.canWrite("src/utils.js").allowed).toBe(true);
  });

  it("blocks writes outside scope", () => {
    const fw = new ChangeFirewall(proposal());
    expect(fw.canWrite("src/orders/orders.ts").allowed).toBe(false);
    expect(fw.canWrite("README.md").allowed).toBe(false);
  });

  it("blocks explicitly out-of-scope files even inside a scope glob", () => {
    const fw = new ChangeFirewall(proposal());
    const decision = fw.canWrite("src/auth/legacy.js");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("out of scope");
  });

  it("always protects git/vibefix/lockfiles", () => {
    const fw = new ChangeFirewall(proposal({ filesInScope: ["**"] }));
    expect(fw.canWrite(".git/config").allowed).toBe(false);
    expect(fw.canWrite(".vibefix/runs/run_x/state.json").allowed).toBe(false);
    expect(fw.canWrite("pnpm-lock.yaml").allowed).toBe(false);
  });

  it("protects manifests unless explicitly in scope", () => {
    const fw = new ChangeFirewall(proposal());
    expect(fw.canWrite("package.json").allowed).toBe(false);
    const explicit = new ChangeFirewall(proposal({ filesInScope: ["package.json", "src/**"] }));
    expect(explicit.canWrite("package.json").allowed).toBe(true);
  });

  it("enforces extra forbidden zones from the Risk Assessor", () => {
    const fw = new ChangeFirewall(proposal({ filesInScope: ["src/**"] }), ["src/hot/**"]);
    expect(fw.canWrite("src/hothandler.ts").allowed).toBe(true); // not in the zone pattern
    expect(fw.canWrite("src/hot/billing.js").allowed).toBe(false);
  });

  it("auto-rejects after two violations", () => {
    const fw = new ChangeFirewall(proposal());
    expect(fw.recordViolation("x", "r").autoReject).toBe(false);
    expect(fw.recordViolation("y", "r").autoReject).toBe(true);
    expect(fw.violationCount).toBe(2);
  });

  it("continues the violation budget across retry attempts", () => {
    const retry = new ChangeFirewall(proposal(), [], 1);
    expect(retry.recordViolation("x", "r").autoReject).toBe(true);
    expect(retry.violationCount).toBe(2);
  });
});
