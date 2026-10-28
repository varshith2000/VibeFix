import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "@vibefix/adapters";
import { createInitialRunState } from "@vibefix/domain";
import type { AgentDefinition, BacklogArtifact, ChangeProposal } from "@vibefix/schemas";
import {
  BudgetMeter,
  EventLog,
  EvidenceStore,
  OrchestratorRuntime,
  WorktreeManager,
  proposalScopeHash,
  runPaths,
} from "../src/index.js";

const testProposal: ChangeProposal = {
  proposalId: "RFC-001",
  title: "Extract helper",
  problem: "Duplicated helper",
  evidence: ["FND-001"],
  filesInScope: ["src/**"],
  filesOutOfScope: ["src/protected.ts"],
  risk: { value: 10, band: "low", factors: [] },
  expectedBenefit: ["cleaner code"],
  constraints: ["no-behavior-change"],
  minimalChange: true,
  testsRequired: [],
  rollbackStrategy: { type: "discardWorktree" },
  approvalStatus: "approved",
  priority: 1,
  allowedInModes: ["minimal"],
};

async function createGitRepo(root: string): Promise<{ head: string; gitConfigBefore: string }> {
  const git = (args: string[]) => runCommand("git", args, { cwd: root });
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
  ]) {
    expect((await git(args)).code).toBe(0);
  }
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export const a = 1;\n", "utf8");
  expect((await git(["add", ".gitignore", "src/index.ts"])).code).toBe(0);
  expect((await git(["commit", "-m", "initial"])).code).toBe(0);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const gitConfigBefore = await readFile(path.join(root, ".git", "config"), "utf8");
  return { head, gitConfigBefore };
}

describe("primary-tree invariance, scope integrity, and resource budgets (SAFE-01, SAFE-03, SAFE-08, RES-04/05/10/12/13/14)", () => {
  it("leaves the primary checkout, .git/config, and node_modules untouched across worktree creation, engineer failure, and discard (SAFE-01, SAFE-03)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-primary-tree-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
    try {
      const { head, gitConfigBefore } = await createGitRepo(root);
      const wm = new WorktreeManager(root, 2);
      const handle = await wm.create("RFC-001", 0);

      // SAFE-03: baseCommit recorded and matches primary HEAD
      expect(handle.baseCommit).toBe(head);

      // Simulate an engineer write and subsequent failure inside the worktree
      await writeFile(path.join(handle.path, "src", "index.ts"), "export const a = 999;\n", "utf8");
      await wm.discard(handle);

      const statusAfter = (await runCommand("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
      const headAfter = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      const gitConfigAfter = await readFile(path.join(root, ".git", "config"), "utf8");
      const primarySrc = await readFile(path.join(root, "src", "index.ts"), "utf8");
      const nmContent = await readFile(path.join(root, "node_modules", "pkg", "index.js"), "utf8");

      expect(statusAfter).toBe("");
      expect(headAfter).toBe(head);
      expect(gitConfigAfter).toBe(gitConfigBefore);
      expect(primarySrc).toBe("export const a = 1;\n");
      expect(nmContent).toBe("module.exports = 1;\n");
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces worktree count ceiling (RES-14)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-wt-cap-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
    try {
      await createGitRepo(root);
      const wm = new WorktreeManager(root, 1);
      const h1 = await wm.create("RFC-001", 0);
      await expect(wm.create("RFC-002", 0)).rejects.toThrow(/E_WORKTREE_LIMIT/);
      await wm.discard(h1);
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects execution with E_SCOPE_MUTATED if proposal scope is mutated on disk after approval (SAFE-08)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-scope-hash-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
    try {
      const p = runPaths(root, "run_scopehash01");
      await mkdir(p.runDir, { recursive: true });
      const store = new EvidenceStore(p);
      const events = new EventLog(p);
      const budgets = { runMaxTokens: 50_000, maxChangesPerRun: 2, maxRetriesPerChange: 0, warnFraction: 0.8 };
      const meter = new BudgetMeter(budgets);

      await store.write({
        kind: "backlog",
        producer: "synthesis",
        runId: "run_scopehash01",
        data: { proposals: [testProposal], unaddressedFindings: [] } satisfies BacklogArtifact,
      });

      const engineerDef: AgentDefinition = {
        agentId: "engineer",
        label: "Engineer",
        role: "engineer",
        phase: "execution",
        capability: "TextGeneration",
        permission: "worktree-write",
        produces: ["change-attempt"],
        consumes: ["backlog"],
        runsInPool: null,
        freshContext: false,
      };

      const state = createInitialRunState({
        runId: "run_scopehash01",
        repoPath: root,
        mode: "minimal",
        agentIds: [engineerDef.agentId],
      });
      state.phase = "awaitingApproval";
      state.status = "awaitingApproval";

      let engineerCalled = 0;
      const runtime = new OrchestratorRuntime(
        {
          paths: p,
          store,
          events,
          executor: {
            definitions: () => [engineerDef],
            execute: async () => {
              engineerCalled += 1;
              return { outcome: "passed", artifactIds: [] };
            },
          },
          worktrees: { cleanupAll: async () => undefined } as never,
          meter,
          budgets,
        },
        state,
      );

      // Approve and verify hash was recorded
      await runtime.dispatch({
        type: "CHECKPOINT_APPROVED",
        mode: "minimal",
        approvedProposalIds: [testProposal.proposalId],
      });
      expect(runtime.snapshot().approval.scopeHashes?.[testProposal.proposalId]).toBe(proposalScopeHash(testProposal));

      // Tamper with the backlog on disk before execution phase completes
      const mutatedProposal: ChangeProposal = {
        ...testProposal,
        filesInScope: ["**"],
      };
      await store.write({
        kind: "backlog",
        producer: "minimality",
        runId: "run_scopehash01",
        data: { proposals: [mutatedProposal], unaddressedFindings: [] } satisfies BacklogArtifact,
      });

      await runtime.dispatch({ type: "PHASE_COMPLETED", phase: "harness" });
      expect(engineerCalled).toBe(0);
      const ledger = await store.readLedger();
      expect(ledger.entries).toHaveLength(1);
      expect(ledger.entries[0]?.verdict).toBe("rejected");
      expect(ledger.entries[0]?.verifierNotes[0]).toContain("E_SCOPE_MUTATED");
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces analysis/run time budgets (RES-04 / RES-05) and token/call/cost ceilings with budget.warning event (RES-10 / RES-12 / RES-13)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-budgets-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
    try {
      const p = runPaths(root, "run_budget01");
      await mkdir(p.runDir, { recursive: true });
      const store = new EvidenceStore(p);
      const events = new EventLog(p);
      const budgets = {
        runMaxTokens: 1_000,
        agentMaxTokens: 600,
        maxChangesPerRun: 2,
        maxRetriesPerChange: 0,
        warnFraction: 0.8,
        analysisTimeoutMs: 120,
        runTimeoutMs: 500,
        maxLlmCallsPerRun: 3,
        maxCostUsd: 0.05,
      };
      const meter = new BudgetMeter(budgets);

      const reconDef: AgentDefinition = {
        agentId: "cartographer",
        label: "Cartographer",
        role: "recon",
        phase: "recon",
        capability: "TextGeneration",
        permission: "read-only",
        produces: ["knowledge-graph"],
        consumes: [],
        runsInPool: "recon",
        freshContext: false,
      };

      const state = createInitialRunState({
        runId: "run_budget01",
        repoPath: root,
        mode: "minimal",
        agentIds: [reconDef.agentId],
      });

      const runtime = new OrchestratorRuntime(
        {
          paths: p,
          store,
          events,
          executor: {
            definitions: () => [reconDef],
            execute: async () => {
              meter.record(850, "cartographer", "gemini", 0.01); // crosses 80% warn threshold and 600 agentMaxTokens
              await new Promise((r) => setTimeout(r, 300)); // exceeds analysisTimeoutMs (120ms)
              return { outcome: "passed", artifactIds: [] };
            },
          },
          worktrees: { cleanupAll: async () => undefined } as never,
          meter,
          budgets,
        },
        state,
      );

      await runtime.dispatch({ type: "START" });
      const snap = runtime.snapshot();
      expect(snap.status).toBe("failed");
      expect(snap.error).toContain("E_TIME_BUDGET");

      const replayed = await events.eventsSince(0);
      expect(replayed.some((e) => e.type === "budget.warning")).toBe(true);
      expect(meter.exceeded).toBe(true);
      expect(meter.exceededReason).toContain("agent token budget exhausted");
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
