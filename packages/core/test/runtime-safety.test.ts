import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialRunState } from "@vibefix/domain";
import type { AgentDefinition, ChangeProposal } from "@vibefix/schemas";
import { BudgetMeter } from "../src/budget.js";
import { OrchestratorRuntime } from "../src/orchestrator/runtime.js";
import { runPaths } from "../src/store/paths.js";

const budgets = {
  runMaxTokens: 10_000,
  maxChangesPerRun: 2,
  maxRetriesPerChange: 0,
  warnFraction: 0.8,
};

const engineer: AgentDefinition = {
  agentId: "engineer",
  label: "Engineer",
  role: "test engineer",
  phase: "execution",
  capability: "TextGeneration",
  permission: "worktree-write",
  produces: ["change-attempt"],
  consumes: ["backlog"],
  runsInPool: null,
  freshContext: false,
};

const proposal: ChangeProposal = {
  proposalId: "RFC-001",
  title: "Test change",
  problem: "Test problem",
  evidence: ["FND-001"],
  filesInScope: ["src/**"],
  filesOutOfScope: [],
  risk: { value: 10, band: "low", factors: [] },
  expectedBenefit: ["test"],
  constraints: ["no-behavior-change"],
  minimalChange: true,
  testsRequired: [],
  rollbackStrategy: { type: "discardWorktree" },
  approvalStatus: "approved",
  priority: 1,
  allowedInModes: ["minimal"],
};

async function testPaths(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  // Keep this test hermetic: runPaths intentionally uses the process-level
  // VIBEFIX_HOME rather than placing state inside the target repository.
  const previousHome = process.env.VIBEFIX_HOME;
  process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
  const paths = runPaths(root, "run_safety001");
  await mkdir(paths.runDir, { recursive: true });
  return { root, paths, previousHome };
}

function restoreHome(previousHome: string | undefined) {
  if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
  else process.env.VIBEFIX_HOME = previousHome;
}

describe("orchestrator effect safety", () => {
  it("propagates effect failures instead of leaving a run silently stuck", async () => {
    const { root, paths, previousHome } = await testPaths("vibefix-effect-failure");
    try {
      const state = createInitialRunState({
        runId: "run_safety001",
        repoPath: root,
        mode: "minimal",
        agentIds: [],
      });
      const runtime = new OrchestratorRuntime(
        {
          paths,
          store: {} as never,
          events: { append: async () => { throw new Error("event disk unavailable"); } } as never,
          executor: { definitions: () => [], execute: async () => ({ outcome: "passed", artifactIds: [] }) },
          worktrees: {} as never,
          meter: new BudgetMeter(budgets),
          budgets,
        },
        state,
      );

      await expect(runtime.dispatch({ type: "START" })).rejects.toThrow("event disk unavailable");
    } finally {
      restoreHome(previousHome);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not commit or land an engineer result after the run is aborted", async () => {
    const { root, paths, previousHome } = await testPaths("vibefix-abort-race");
    try {
      const state = createInitialRunState({
        runId: "run_safety001",
        repoPath: root,
        mode: "minimal",
        agentIds: [engineer.agentId],
      });
      state.phase = "execution";
      state.execution = { queue: [proposal.proposalId], currentIndex: 0, attempt: 0, stage: "implement" };

      let releaseEngineer!: () => void;
      const engineerStarted = new Promise<void>((resolve) => { releaseEngineer = resolve; });
      let continueEngineer!: () => void;
      const engineerMayFinish = new Promise<void>((resolve) => { continueEngineer = resolve; });
      let commits = 0;
      let lands = 0;
      let discards = 0;
      const runtime = new OrchestratorRuntime(
        {
          paths,
          store: {
            latest: async (kind: string) => kind === "backlog"
              ? { data: { proposals: [proposal], unaddressedFindings: [] } }
              : null,
            list: async () => [],
          } as never,
          events: { append: async () => ({}) } as never,
          executor: {
            definitions: () => [engineer],
            execute: async () => {
              releaseEngineer();
              await engineerMayFinish;
              return { outcome: "passed", artifactIds: ["attempt"] } as const;
            },
          },
          worktrees: {
            cleanupAll: async () => undefined,
            create: async () => ({
              proposalId: proposal.proposalId,
              attempt: 0,
              branch: "vibefix/test",
              path: root,
              baseCommit: "base",
            }),
            discard: async () => { discards += 1; },
            commit: async () => { commits += 1; return { ok: true, ref: "commit" }; },
            landOnMainBranch: async () => { lands += 1; return { ok: true, conflict: false }; },
          } as never,
          meter: new BudgetMeter(budgets),
          budgets,
        },
        state,
      );

      const execution = runtime.resume();
      await engineerStarted;
      await runtime.dispatch({ type: "ABORT" });
      continueEngineer();
      await execution;

      expect(runtime.snapshot().status).toBe("aborted");
      expect(commits).toBe(0);
      expect(lands).toBe(0);
      expect(discards).toBeGreaterThan(0);
    } finally {
      restoreHome(previousHome);
      await rm(root, { recursive: true, force: true });
    }
  });
});
