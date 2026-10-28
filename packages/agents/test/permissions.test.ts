import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFsFacts, runCommand } from "@vibefix/adapters";
import { AGENT_DEFINITIONS } from "../src/definitions.js";
import { BehaviorVerifier } from "../src/agents/verifier.js";
import { RegressionSentinel } from "../src/agents/regression-sentinel.js";
import { SecurityAgent } from "../src/agents/security-agent.js";
import { HarnessBuilder } from "../src/agents/harness-builder.js";
import type { AgentExecutionContext } from "../src/contract.js";
import { lintSource, lintWorkspace } from "../../../scripts/lint.mjs";

describe("single-writer permissions, static lint rules, and verifier diff gates (GATE-03, GATE-09, SAFE-04, SAFE-09, RES-02, RES-03)", () => {
  it("grants worktree-write permission exclusively to the engineer agent (SAFE-04)", () => {
    const writers = AGENT_DEFINITIONS.filter((d) => d.permission === "worktree-write");
    expect(writers).toHaveLength(1);
    expect(writers[0]?.agentId).toBe("engineer");
  });

  it("enforces static AST lint rules across the workspace and catches planted violations (GATE-03 / SAFE-04 / DAT-04)", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const { filesChecked, violations } = await lintWorkspace(repoRoot);
    expect(filesChecked).toBeGreaterThan(50);
    expect(violations).toEqual([]);

    // Planted SAFE-04 violation: non-engineer agent importing node:fs
    const fsViolation = lintSource(
      "packages/agents/src/agents/cartographer.ts",
      'import { promises as fs } from "node:fs";\nexport const x = fs;\n',
    );
    expect(fsViolation.some((v) => v.includes("[SAFE-04]"))).toBe(true);

    // Allowed SAFE-04 exception: engineer.ts importing node:fs
    const engineerAllowed = lintSource(
      "packages/agents/src/agents/engineer.ts",
      'import { promises as fs } from "node:fs";\nexport const x = fs;\n',
    );
    expect(engineerAllowed).toEqual([]);

    // Planted DAT-04 violation: passing raw prompt identifier to logger
    const promptViolation = lintSource(
      "packages/agents/src/runtime/text-agent-loop.ts",
      "const planPrompt = 'secret';\ninfo('agent', planPrompt);\n",
    );
    expect(promptViolation.some((v) => v.includes("[DAT-04]"))).toBe(true);
  }, 25_000);

  it("rejects out-of-scope and forbidden-zone changes in the final committed diff (SAFE-09)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-verifier-diff-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      const git = (args: string[]) => runCommand("git", args, { cwd: root });
      await git(["init", "-b", "main"]);
      await git(["config", "user.email", "test@example.invalid"]);
      await git(["config", "user.name", "Test"]);
      await writeFile(path.join(root, "src", "allowed.ts"), "export const a = 1;\n", "utf8");
      await writeFile(path.join(root, "src", "forbidden.ts"), "export const b = 1;\n", "utf8");
      await git(["add", "."]);
      await git(["commit", "-m", "base"]);
      const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();

      // Modify a file explicitly listed in filesOutOfScope / forbiddenZones
      await writeFile(path.join(root, "src", "forbidden.ts"), "export const b = 2;\n", "utf8");
      await git(["add", "-A"]);
      await git(["commit", "-m", "planted violation"]);

      const captured: unknown[] = [];
      const ctx: AgentExecutionContext = {
        def: { agentId: "verifier" } as never,
        runState: { runId: "run_safe09", mode: "minimal" } as never,
        repoPath: root,
        worktree: {
          proposalId: "RFC-001",
          attempt: 0,
          branch: "vibefix/rfc-001-a0",
          path: root,
          baseCommit,
        },
        proposal: {
          proposalId: "RFC-001",
          title: "Scoped change",
          problem: "Test",
          evidence: ["FND-001"],
          filesInScope: ["src/**"],
          filesOutOfScope: ["src/forbidden.ts"],
          risk: { value: 10, band: "low", factors: [] },
          expectedBenefit: ["ok"],
          constraints: [],
          minimalChange: true,
          testsRequired: [],
          rollbackStrategy: { type: "discardWorktree" },
          approvalStatus: "approved",
          priority: 1,
          allowedInModes: ["minimal"],
        },
        forbiddenZones: ["src/forbidden.ts"],
        store: {
          latest: async () => null,
          write: async (input: { data: unknown }) => {
            captured.push(input.data);
            return { artifactId: "art_1" } as never;
          },
        } as never,
        tools: {
          fs: new NodeFsFacts(),
          runner: { detectCommands: () => ({}), runCommand: async () => ({ ok: true, outputTail: "" }) } as never,
          snapshot: { files: [] } as never,
          importEdges: [],
          importGraphAnalyzer: "ts-module-resolution",
          metrics: { files: [], functions: [], duplications: [], deadCodeCandidates: [], analyzer: "ts-ast" },
        },
        progress: async () => undefined,
      };

      const verifierRes = await new BehaviorVerifier().execute(ctx);
      expect(verifierRes.outcome).toBe("rejected");
      expect(captured[0]).toMatchObject({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "firewall-scope", result: "FAIL" }),
        ]),
      });

      const sentinelCaptured: unknown[] = [];
      ctx.store = {
        latest: async () => null,
        write: async (input: { data: unknown }) => {
          sentinelCaptured.push(input.data);
          return { artifactId: "art_2" } as never;
        },
      } as never;
      const sentinelRes = await new RegressionSentinel().execute(ctx);
      expect(sentinelRes.outcome).toBe("rejected");
      expect(sentinelCaptured[0]).toMatchObject({
        gates: expect.arrayContaining([
          expect.objectContaining({ gate: "firewall-scope", result: "FAIL" }),
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discloses file-count and file-size truncation as degraded metadata (RES-02 / RES-03)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-caps-"));
    try {
      const captured: Array<{ kind: string; data: unknown }> = [];
      const manyFiles = Array.from({ length: 405 }, (_, i) => ({
        path: `src/f${i}.ts`,
        sizeBytes: 100,
        language: "typescript",
        loc: 10,
      }));
      const ctx: AgentExecutionContext = {
        def: { agentId: "test" } as never,
        runState: { runId: "run_caps01", mode: "minimal" } as never,
        repoPath: root,
        store: {
          latest: async () => null,
          write: async (input: { kind: string; data: unknown }) => {
            captured.push({ kind: input.kind, data: input.data });
            return { artifactId: "art_cap" } as never;
          },
        } as never,
        tools: {
          fs: {
            readFile: async (_r: string, rel: string) => (rel === "src/f0.ts" ? "x".repeat(205_000) : "export const v = 1;\n"),
            snapshot: async () => ({ files: manyFiles }) as never,
            exists: async () => true,
          },
          runner: { detectCommands: () => ({}), runCommand: async () => ({ ok: true, outputTail: "" }) } as never,
          snapshot: { files: manyFiles } as never,
          importEdges: [],
          importGraphAnalyzer: "ts-module-resolution",
          metrics: { files: [], functions: [], duplications: [], deadCodeCandidates: [], analyzer: "ts-ast" },
        },
        progress: async () => undefined,
      };

      await new HarnessBuilder().execute(ctx);
      const baseline = captured.find((c) => c.kind === "behavioral-baseline")?.data as {
        excluded: Array<{ test: string; reason: string }>;
      };
      expect(baseline.excluded).toContainEqual(expect.objectContaining({ test: "truncatedAt:400" }));

      await new SecurityAgent().execute(ctx);
      const secFindings = captured.find((c) => c.kind === "findings")?.data as { notes: string[] };
      expect(secFindings.notes.some((n) => n.includes("degraded: skipped 1 oversized file(s)"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks command execution when executionPolicy is disabled and fails closed with NOT_APPLICABLE (policy) (SEC-12)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-exec-policy-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      const git = (args: string[]) => runCommand("git", args, { cwd: root });
      await git(["init", "-b", "main"]);
      await git(["config", "user.email", "test@example.invalid"]);
      await git(["config", "user.name", "Test"]);
      await writeFile(path.join(root, "src", "allowed.ts"), "export const a = 1;\n", "utf8");
      await git(["add", "."]);
      await git(["commit", "-m", "base"]);
      const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(root, "src", "allowed.ts"), "export const a = 2;\n", "utf8");
      await git(["add", "-A"]);
      await git(["commit", "-m", "valid change"]);

      const captured: unknown[] = [];
      const policyBlockedRunner = {
        detectCommands: () => ({ test: "npm test", build: "npm run build" }),
        runCommand: async (_r: string, command: string) => ({
          ok: false,
          command,
          exitCode: 126,
          outputTail: "command execution blocked by repository executionPolicy; set executionPolicy.allowCommandExecution=true to run repository scripts",
          durationMs: 0,
        }),
      };
      const ctx: AgentExecutionContext = {
        def: { agentId: "verifier" } as never,
        runState: { runId: "run_sec12", mode: "minimal" } as never,
        repoPath: root,
        worktree: { proposalId: "RFC-001", attempt: 0, branch: "vibefix/rfc-001-a0", path: root, baseCommit },
        proposal: {
          proposalId: "RFC-001",
          title: "Scoped change",
          problem: "Test",
          evidence: ["FND-001"],
          filesInScope: ["src/**"],
          filesOutOfScope: [],
          risk: { value: 10, band: "low", factors: [] },
          expectedBenefit: ["ok"],
          constraints: [],
          minimalChange: true,
          testsRequired: [],
          rollbackStrategy: { type: "discardWorktree" },
          approvalStatus: "approved",
          priority: 1,
          allowedInModes: ["minimal"],
        },
        forbiddenZones: [],
        store: {
          latest: async (kind: string) =>
            kind === "behavioral-baseline"
              ? ({
                  data: {
                    harnessBranch: "main",
                    testFiles: ["src/allowed.test.ts"],
                    excluded: [],
                    publicApiSurface: [],
                    baselineResults: {
                      suiteAvailable: true,
                      ok: false,
                      outputTail: "command execution blocked by execution policy",
                    },
                  },
                } as never)
              : null,
          write: async (input: { data: unknown }) => {
            captured.push(input.data);
            return { artifactId: "art_sec12" } as never;
          },
        } as never,
        tools: {
          fs: new NodeFsFacts(),
          runner: policyBlockedRunner as never,
          snapshot: { files: [] } as never,
          importEdges: [],
          importGraphAnalyzer: "ts-module-resolution",
          metrics: { files: [], functions: [], duplications: [], deadCodeCandidates: [], analyzer: "ts-ast" },
        },
        progress: async () => undefined,
      };

      const res = await new RegressionSentinel().execute(ctx);
      expect(res.outcome).toBe("rejected");
      const gates = (captured[0] as { gates: Array<{ gate: string; result: string; details: string }> }).gates;
      expect(gates.some((g) => g.result === "FAIL" && g.details.includes("NOT_APPLICABLE (policy)"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

