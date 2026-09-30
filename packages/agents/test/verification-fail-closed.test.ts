import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "@vibefix/adapters";
import type { AgentExecutionContext } from "../src/contract.js";
import { BehaviorVerifier } from "../src/agents/verifier.js";
import { PrincipleReviewer } from "../src/agents/principle-reviewer.js";
import { decide, isAffirmativeDecision } from "../src/runtime/decision-agent.js";

async function makeChangedWorktree(): Promise<{ parent: string; worktree: string; baseCommit: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), "vibefix-fail-closed-"));
  const worktree = path.join(parent, "worktree");
  await mkdir(path.join(worktree, "src"), { recursive: true });
  const runGit = async (...args: string[]) => {
    const result = await runCommand("git", args, { cwd: worktree });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  };
  await runGit("init");
  await runGit("config", "user.email", "test@example.invalid");
  await runGit("config", "user.name", "Test");
  await writeFile(path.join(worktree, "src", "index.ts"), "export const value = 1;\n");
  await runGit("add", ".");
  await runGit("commit", "-m", "baseline");
  const base = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktree });
  if (base.code !== 0) throw new Error(base.stderr || base.stdout);
  await writeFile(path.join(worktree, "src", "index.ts"), "export const value = 2;\n");
  return { parent, worktree, baseCommit: base.stdout.trim() };
}

function makeContext(worktreePath: string, baseCommit: string, captured: unknown[]): AgentExecutionContext {
  return {
    def: { agentId: "test-agent" } as AgentExecutionContext["def"],
    runState: { runId: "run_failclosed01", mode: "minimal" } as AgentExecutionContext["runState"],
    repoPath: worktreePath,
    worktree: { path: worktreePath, baseCommit } as AgentExecutionContext["worktree"],
    proposal: {
      proposalId: "RFC-001",
      title: "Change a value",
      problem: "The value needs changing.",
      evidence: ["FND-001"],
      filesInScope: ["src/**"],
      filesOutOfScope: [],
      risk: { value: 10, band: "low", factors: [] },
      expectedBenefit: ["Improve the value"],
      constraints: [],
      minimalChange: true,
      testsRequired: [],
      rollbackStrategy: { type: "discardWorktree" },
      approvalStatus: "approved",
      priority: 1,
      allowedInModes: ["minimal"],
    } as AgentExecutionContext["proposal"],
    store: {
      latest: async () => null,
      write: async (input: { data: unknown }) => {
        captured.push(input.data);
        return { artifactId: "artifact-test" };
      },
    } as unknown as AgentExecutionContext["store"],
    tools: { runner: { runCommand: async () => ({ ok: true, outputTail: "" }) } } as unknown as AgentExecutionContext["tools"],
    progress: async () => undefined,
  };
}

describe("verification fails closed without a decision provider", () => {
  it("returns noul instead of an affirmative fallback answer", async () => {
    const result = await decide(
      {
        def: { agentId: "test-agent" },
        progress: async () => undefined,
      } as unknown as AgentExecutionContext,
      {
        context: "test",
        questions: [{ type: "choice", question: "Pass?", choices: ["yes", "no"] }],
      },
    );
    expect(result.degraded).toBe(true);
    expect(result.answers[0]?.kind).toBe("noul");
    expect(isAffirmativeDecision(result.degraded, result.answers[0])).toBe(false);
    expect(isAffirmativeDecision(false, { questionIndex: 0, kind: "choice", choice: "yes" })).toBe(true);
    expect(isAffirmativeDecision(false, { questionIndex: 0, kind: "choice", choice: "no" })).toBe(false);
  });

  it.each([
    ["behavior verifier", () => new BehaviorVerifier()],
    ["principle reviewer", () => new PrincipleReviewer()],
  ])("rejects changes when the %s has no decision provider", async (_name, createAgent) => {
    const { parent, worktree, baseCommit } = await makeChangedWorktree();
    const captured: unknown[] = [];
    try {
      const result = await createAgent().execute(makeContext(worktree, baseCommit, captured));
      expect(result.outcome).toBe("rejected");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ verdict: "rejected" });
      expect(captured[0]).toMatchObject({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "behavior-preservation-decision", result: "FAIL" }),
        ]),
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reviews the committed attempt against its recorded base commit", async () => {
    const { parent, worktree, baseCommit } = await makeChangedWorktree();
    const captured: unknown[] = [];
    const decisionContexts: string[] = [];
    try {
      const add = await runCommand("git", ["add", "-A"], { cwd: worktree });
      expect(add.code).toBe(0);
      const commit = await runCommand("git", ["commit", "-m", "attempt"], { cwd: worktree });
      expect(commit.code).toBe(0);

      const ctx = makeContext(worktree, baseCommit, captured);
      ctx.decision = {
        kind: "TypedDecision",
        providerId: "test-decision",
        model: "test",
        decide: async (request) => {
          decisionContexts.push(request.context);
          return {
            answers: [{ questionIndex: 0, kind: "choice", choice: "yes", rationale: "reviewed actual diff" }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            model: "test",
            providerId: "test-decision",
          };
        },
      };

      const result = await new BehaviorVerifier().execute(ctx);
      expect(result.outcome).toBe("passed");
      expect(decisionContexts).toHaveLength(1);
      expect(decisionContexts[0]).toContain("-export const value = 1;");
      expect(decisionContexts[0]).toContain("+export const value = 2;");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("fails closed when the baseline suite was already red", async () => {
    const { parent, worktree, baseCommit } = await makeChangedWorktree();
    const captured: unknown[] = [];
    try {
      await runCommand("git", ["add", "-A"], { cwd: worktree });
      await runCommand("git", ["commit", "-m", "attempt"], { cwd: worktree });
      const ctx = makeContext(worktree, baseCommit, captured);
      ctx.store = {
        latest: async (kind: string) => kind === "behavioral-baseline"
          ? { data: {
              harnessBranch: "baseline",
              testFiles: ["src/index.test.ts"],
              baselineResults: { suiteAvailable: true, ok: false, command: "npm test" },
              excluded: [],
              publicApiSurface: ["src/index.ts::value"],
            } }
          : null,
        write: async (input: { data: unknown }) => {
          captured.push(input.data);
          return { artifactId: "artifact-test" };
        },
      } as unknown as AgentExecutionContext["store"];

      const result = await new BehaviorVerifier().execute(ctx);
      expect(result.outcome).toBe("rejected");
      expect(captured[0]).toMatchObject({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "regression-suite", result: "FAIL" }),
        ]),
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("detects removal of an export even when the identifier remains in the file", async () => {
    const { parent, worktree, baseCommit } = await makeChangedWorktree();
    const captured: unknown[] = [];
    try {
      await writeFile(path.join(worktree, "src", "index.ts"), "const value = 2;\nconsole.log(value);\n");
      await runCommand("git", ["add", "-A"], { cwd: worktree });
      await runCommand("git", ["commit", "-m", "attempt"], { cwd: worktree });
      const ctx = makeContext(worktree, baseCommit, captured);
      ctx.proposal = { ...ctx.proposal!, constraints: ["no-public-api-change"] };
      ctx.store = {
        latest: async (kind: string) => kind === "behavioral-baseline"
          ? { data: {
              harnessBranch: "baseline",
              testFiles: [],
              baselineResults: { suiteAvailable: false },
              excluded: [],
              publicApiSurface: ["src/index.ts::value"],
            } }
          : null,
        write: async (input: { data: unknown }) => {
          captured.push(input.data);
          return { artifactId: "artifact-test" };
        },
      } as unknown as AgentExecutionContext["store"];

      const result = await new BehaviorVerifier().execute(ctx);
      expect(result.outcome).toBe("rejected");
      expect(captured[0]).toMatchObject({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "public-api-surface", result: "FAIL" }),
        ]),
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
