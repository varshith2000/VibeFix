import { describe, expect, it } from "vitest";
import { createInitialRunState, reduce } from "../src/index.js";
import type { AgentRegistrySnapshot, RunEvent } from "../src/orchestrator/state.js";

const registry: AgentRegistrySnapshot = {
  agentIdsByPool: (pool) => (pool === "recon" ? ["cartographer", "test-surveyor"] : ["smell-detector", "arch-auditor"]),
  agentIdByPhase: (phase) =>
    phase === "riskAssessment"
      ? "risk-assessor"
      : phase === "synthesis"
        ? "synthesis"
        : phase === "harness"
          ? "harness-builder"
          : "docent",
};

const agentIds = [
  "cartographer",
  "test-surveyor",
  "smell-detector",
  "arch-auditor",
  "risk-assessor",
  "synthesis",
  "harness-builder",
  "engineer",
  "verifier",
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

describe("reducer transition table", () => {
  it("START moves init -> recon and spawns the recon pool", () => {
    const { state, effects } = reduce(makeState(), { type: "START" }, registry, budgets);
    expect(state.phase).toBe("recon");
    expect(state.status).toBe("running");
    expect(effects).toContainEqual({ effect: "SpawnPool", pool: "recon", agentIds: ["cartographer", "test-surveyor"] });
  });

  it("START is idempotent outside init", () => {
    const started = drive(makeState(), [{ type: "START" }]);
    const again = reduce(started, { type: "START" }, registry, budgets);
    expect(again.state.phase).toBe("recon");
    expect(again.effects).toHaveLength(0);
  });

  it("full happy path: recon -> diagnosis -> risk -> synthesis -> awaitingApproval", () => {
    const state = drive(makeState(), [
      { type: "START" },
      { type: "PHASE_COMPLETED", phase: "recon" },
      { type: "PHASE_COMPLETED", phase: "diagnosis" },
      { type: "PHASE_COMPLETED", phase: "riskAssessment" },
      { type: "PHASE_COMPLETED", phase: "synthesis" },
    ]);
    expect(state.phase).toBe("awaitingApproval");
    expect(state.status).toBe("awaitingApproval");
    expect(state.approval.requested).toBe(true);
  });

  it("stale PHASE_COMPLETED is ignored (wrong phase)", () => {
    const state = drive(makeState(), [{ type: "START" }, { type: "PHASE_COMPLETED", phase: "diagnosis" }]);
    expect(state.phase).toBe("recon");
  });

  it("CHECKPOINT_APPROVED builds the execution queue and enters harness", () => {
    const awaiting = drive(makeState(), [
      { type: "START" },
      { type: "PHASE_COMPLETED", phase: "recon" },
      { type: "PHASE_COMPLETED", phase: "diagnosis" },
      { type: "PHASE_COMPLETED", phase: "riskAssessment" },
      { type: "PHASE_COMPLETED", phase: "synthesis" },
    ]);
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

  it("empty approval queue skips execution and goes to report", () => {
    const awaiting = drive(makeState(), [
      { type: "START" },
      { type: "PHASE_COMPLETED", phase: "recon" },
      { type: "PHASE_COMPLETED", phase: "diagnosis" },
      { type: "PHASE_COMPLETED", phase: "riskAssessment" },
      { type: "PHASE_COMPLETED", phase: "synthesis" },
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: [] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    expect(awaiting.phase).toBe("report");
  });

  it("GATE_VERDICT passed advances the queue; rejected retries then defers", () => {
    const inExecution = () =>
      drive(makeState(), [
        { type: "START" },
        { type: "PHASE_COMPLETED", phase: "recon" },
        { type: "PHASE_COMPLETED", phase: "diagnosis" },
        { type: "PHASE_COMPLETED", phase: "riskAssessment" },
        { type: "PHASE_COMPLETED", phase: "synthesis" },
        { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001", "RFC-002"] },
        { type: "PHASE_COMPLETED", phase: "harness" },
      ]);

    // First proposal passes -> index advances to second.
    const afterPass = drive(inExecution(), [{ type: "GATE_VERDICT", proposalId: "RFC-001", verdict: "passed" }]);
    expect(afterPass.execution.currentIndex).toBe(1);
    expect(afterPass.budget.changesCommitted).toBe(1);

    // Second proposal: rejected three times (initial + 2 retries) -> deferred, queue drains -> report.
    const afterRejects = drive(afterPass, [
      { type: "GATE_VERDICT", proposalId: "RFC-002", verdict: "rejected" },
      { type: "GATE_VERDICT", proposalId: "RFC-002", verdict: "rejected" },
      { type: "GATE_VERDICT", proposalId: "RFC-002", verdict: "rejected" },
    ]);
    expect(afterRejects.execution.stage).toBe("defer");
    expect(afterRejects.phase).toBe("report");
  });

  it("ignores stale gate verdicts for non-current proposals", () => {
    const inExecution = drive(makeState(), [
      { type: "START" },
      { type: "PHASE_COMPLETED", phase: "recon" },
      { type: "PHASE_COMPLETED", phase: "diagnosis" },
      { type: "PHASE_COMPLETED", phase: "riskAssessment" },
      { type: "PHASE_COMPLETED", phase: "synthesis" },
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001", "RFC-002"] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    const { state } = reduce(inExecution, { type: "GATE_VERDICT", proposalId: "RFC-999", verdict: "passed" }, registry, budgets);
    expect(state.execution.currentIndex).toBe(0);
    expect(state.budget.changesCommitted).toBe(0);
  });

  it("rejected verdict emits retry effect with incremented attempt", () => {
    const inExecution = drive(makeState(), [
      { type: "START" },
      { type: "PHASE_COMPLETED", phase: "recon" },
      { type: "PHASE_COMPLETED", phase: "diagnosis" },
      { type: "PHASE_COMPLETED", phase: "riskAssessment" },
      { type: "PHASE_COMPLETED", phase: "synthesis" },
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001"] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    const { state, effects } = reduce(inExecution, { type: "GATE_VERDICT", proposalId: "RFC-001", verdict: "rejected" }, registry, budgets);
    expect(state.execution.attempt).toBe(1);
    expect(effects).toContainEqual({ effect: "ExecuteProposal", proposalId: "RFC-001", attempt: 1 });
  });

  it("maxChangesPerRun stops the loop after the budget", () => {
    const customBudgets = { maxRetriesPerChange: 2, maxChangesPerRun: 1 };
    let state = drive(makeState(), [
      { type: "START" },
      { type: "PHASE_COMPLETED", phase: "recon" },
      { type: "PHASE_COMPLETED", phase: "diagnosis" },
      { type: "PHASE_COMPLETED", phase: "riskAssessment" },
      { type: "PHASE_COMPLETED", phase: "synthesis" },
      { type: "CHECKPOINT_APPROVED", mode: "minimal", approvedProposalIds: ["RFC-001", "RFC-002"] },
      { type: "PHASE_COMPLETED", phase: "harness" },
    ]);
    state = reduce(state, { type: "GATE_VERDICT", proposalId: "RFC-001", verdict: "passed" }, registry, customBudgets).state;
    expect(state.phase).toBe("report");
    expect(state.budget.changesCommitted).toBe(1);
  });

  it("failed pool agents degrade, not abort", () => {
    const state = drive(makeState(), [
      { type: "START" },
      { type: "AGENT_STARTED", agentId: "cartographer" },
      { type: "AGENT_RESULT", agentId: "cartographer", outcome: "failed", artifactIds: [] },
    ]);
    expect(state.status).toBe("running");
    expect(state.agentStates["cartographer"]).toBe("failed");
  });

  it("ABORT marks aborted and schedules cleanup", () => {
    const { state, effects } = reduce(drive(makeState(), [{ type: "START" }]), { type: "ABORT" }, registry, budgets);
    expect(state.status).toBe("aborted");
    expect(effects).toContainEqual({ effect: "CleanupWorktrees" });
  });

  it("BUDGET_EXCEEDED aborts", () => {
    const { state } = reduce(makeState(), { type: "BUDGET_EXCEEDED" }, registry, budgets);
    expect(state.status).toBe("aborted");
    expect(state.error).toContain("budget");
  });

  it("FATAL marks failed", () => {
    const { state } = reduce(makeState(), { type: "FATAL", message: "disk exploded" }, registry, budgets);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("disk exploded");
  });

  it("AGENT_STARTED marks running; stale AGENT_RESULT ignored after terminal", () => {
    let state = drive(makeState(), [{ type: "START" }, { type: "AGENT_STARTED", agentId: "cartographer" }]);
    expect(state.agentStates["cartographer"]).toBe("running");
    state = drive(state, [{ type: "AGENT_RESULT", agentId: "cartographer", outcome: "passed", artifactIds: ["a"] }]);
    expect(state.agentStates["cartographer"]).toBe("passed");
    const after = reduce(state, { type: "AGENT_RESULT", agentId: "cartographer", outcome: "failed", artifactIds: [] }, registry, budgets);
    expect(after.state.agentStates["cartographer"]).toBe("passed");
  });
});
