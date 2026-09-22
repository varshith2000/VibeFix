import { describe, expect, it } from "vitest";
import { createInitialRunState, reduce } from "../src/index.js";
import type { AgentRegistrySnapshot, RunEvent } from "../src/orchestrator/state.js";

const registry: AgentRegistrySnapshot = {
  agentIdsByPool: (pool) =>
    pool === "recon"
      ? ["cartographer", "historian", "test-surveyor"]
      : pool === "diagnosis"
        ? ["smell-detector", "arch-auditor", "consistency-sentinel", "security-agent"]
        : ["verifier", "principle-reviewer", "regression-sentinel"],
  agentIdByPhase: (phase) => {
    const map: Record<string, string> = {
      riskAssessment: "risk-assessor",
      synthesis: "synthesis",
      minimality: "minimality",
      harness: "harness-builder",
      report: "docent",
    };
    return map[phase] ?? null;
  },
};

const agentIds = [
  "cartographer",
  "historian",
  "test-surveyor",
  "smell-detector",
  "arch-auditor",
  "consistency-sentinel",
  "security-agent",
  "risk-assessor",
  "synthesis",
  "minimality",
  "harness-builder",
  "engineer",
  "verifier",
  "principle-reviewer",
  "regression-sentinel",
  "docent",
];

const budgets = { maxRetriesPerChange: 2, maxChangesPerRun: 10 };

function makeState() {
  return createInitialRunState({ runId: "run_test", repoPath: "/tmp/repo", mode: "minimal", agentIds });
}

function drive(state: ReturnType<typeof makeState>, events: RunEvent[]) {
  let current = state;
  for (const event of events) {
    const result = reduce(current, event, registry, budgets);
    current = result.state;
  }
  return current;
}

/** Reach awaitingApproval through the full analysis path including minimality. */
function toAwaitingApproval() {
  return drive(makeState(), [
    { type: "START" },
    { type: "PHASE_COMPLETED", phase: "recon" },
    { type: "PHASE_COMPLETED", phase: "diagnosis" },
    { type: "PHASE_COMPLETED", phase: "riskAssessment" },
    { type: "PHASE_COMPLETED", phase: "synthesis" },
    { type: "PHASE_COMPLETED", phase: "minimality" },
  ]);
}

describe("reducer transition table", () => {
  it("START moves init -> recon and spawns the recon pool", () => {
    const { state, effects } = reduce(makeState(), { type: "START" }, registry, budgets);
    expect(state.phase).toBe("recon");
    expect(state.status).toBe("running");
    expect(effects).toContainEqual({
      effect: "SpawnPool",
      pool: "recon",
      agentIds: ["cartographer", "historian", "test-surveyor"],
    });
  });

  it("START is idempotent outside init", () => {
    const started = drive(makeState(), [{ type: "START" }]);
    const again = reduce(started, { type: "START" }, registry, budgets);
    expect(again.state.phase).toBe("recon");
    expect(again.effects).toHaveLength(0);
  });

  it("full happy path: recon -> diagnosis -> risk -> synthesis -> minimality -> awaitingApproval", () => {
    const state = toAwaitingApproval();
    expect(state.phase).toBe("awaitingApproval");
    expect(state.status).toBe("awaitingApproval");
    expect(state.approval.requested).toBe(true);
  });

  it("synthesis enters minimality before the checkpoint", () => {
    const afterSynthesis = drive(makeState(), [
      { type: "START" },
      { type: "PHASE_COMPLETED", phase: "recon" },
      { type: "PHASE_COMPLETED", phase: "diagnosis" },
      { type: "PHASE_COMPLETED", phase: "riskAssessment" },
      { type: "PHASE_COMPLETED", phase: "synthesis" },
    ]);
    expect(afterSynthesis.phase).toBe("minimality");
  });

  it("stale PHASE_COMPLETED is ignored (wrong phase)", () => {
    const state = drive(makeState(), [{ type: "START" }, { type: "PHASE_COMPLETED", phase: "diagnosis" }]);
    expect(state.phase).toBe("recon");
  });

  it("CHECKPOINT_APPROVED builds the execution queue and enters harness", () => {
    const awaiting = toAwaitingApproval();
    const state = drive(awaiting, [
      { type: "CHECKPOINT_APPROVED", mode: "architecture", approvedProposalIds: ["RFC-001", "RFC-002", "RFC-003"] },
    ]);
    expect(state.phase).toBe("harness");
    expect(state.mode).toBe("architecture");
    expect(state.execution.queue).toEqual(["RFC-001", "RFC-002", "RFC-003"]);
  });

  it("CHECKPOINT_APPROVED is only valid in awaitingApproval", () => {
    const { state } = reduce(makeState(), { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: [] }, registry, budgets);
    expect(state.phase).toBe("init");
  });

  it("CHECKPOINT_REJECTED invokes docent while staying aborted", () => {
    const awaiting = toAwaitingApproval();
    const { state, effects } = reduce(awaiting, { type: "CHECKPOINT_REJECTED" }, registry, budgets);
    expect(state.status).toBe("aborted");
    expect(state.phase).toBe("report");
    expect(effects).toContainEqual({ effect: "InvokeAgent", agentId: "docent" });
  });

  it("empty approval queue skips execution and goes to report", () => {
    const awaiting = drive(toAwaitingApproval(), [
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: [] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    expect(awaiting.phase).toBe("report");
  });

  it("GATE_VERDICT passed advances the queue; rejected retries then defers", () => {
    const inExecution = () =>
      drive(toAwaitingApproval(), [
        { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001", "RFC-002"] },
        { type: "PHASE_COMPLETED", phase: "harness" },
      ]);

    const afterPass = drive(inExecution(), [{ type: "GATE_VERDICT", proposalId: "RFC-001", verdict: "passed" }]);
    expect(afterPass.execution.currentIndex).toBe(1);
    expect(afterPass.budget.changesCommitted).toBe(1);

    const afterRejects = drive(afterPass, [
      { type: "GATE_VERDICT", proposalId: "RFC-002", verdict: "rejected" },
      { type: "GATE_VERDICT", proposalId: "RFC-002", verdict: "rejected" },
      { type: "GATE_VERDICT", proposalId: "RFC-002", verdict: "rejected" },
    ]);
    expect(afterRejects.execution.stage).toBe("defer");
    expect(afterRejects.phase).toBe("report");
  });

  it("ignores stale gate verdicts for non-current proposals", () => {
    const inExecution = drive(toAwaitingApproval(), [
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001", "RFC-002"] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    const { state } = reduce(inExecution, { type: "GATE_VERDICT", proposalId: "RFC-999", verdict: "passed" }, registry, budgets);
    expect(state.execution.currentIndex).toBe(0);
    expect(state.budget.changesCommitted).toBe(0);
  });

  it("rejected verdict emits retry effect with incremented attempt", () => {
    const inExecution = drive(toAwaitingApproval(), [
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001"] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    const { state, effects } = reduce(inExecution, { type: "GATE_VERDICT", proposalId: "RFC-001", verdict: "rejected" }, registry, budgets);
    expect(state.execution.attempt).toBe(1);
    expect(effects).toContainEqual({ effect: "ExecuteProposal", proposalId: "RFC-001", attempt: 1 });
  });

  it("maxChangesPerRun stops the loop after the budget", () => {
    const customBudgets = { maxRetriesPerChange: 2, maxChangesPerRun: 1 };
    let state = drive(toAwaitingApproval(), [
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001", "RFC-002"] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    const after = reduce(state, { type: "GATE_VERDICT", proposalId: "RFC-001", verdict: "passed" }, registry, customBudgets);
    expect(after.state.phase).toBe("report");
    expect(after.state.budget.changesCommitted).toBe(1);
  });
});
