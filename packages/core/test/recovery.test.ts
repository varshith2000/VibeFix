import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "@vibefix/adapters";
import { createInitialRunState } from "@vibefix/domain";
import { DEFAULT_MODEL_ROUTING, RepoConfigSchema, type AgentDefinition } from "@vibefix/schemas";
import { RunManager, WorktreeManager, projectDir, runPaths } from "../src/index.js";

async function initGitRepo(root: string): Promise<void> {
  const git = (args: string[]) => runCommand("git", args, { cwd: root });
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
  ]) {
    expect((await git(args)).code).toBe(0);
  }
  await writeFile(path.join(root, "src.ts"), "export const x = 1;\n", "utf8");
  expect((await git(["add", "."])).code).toBe(0);
  expect((await git(["commit", "-m", "init"])).code).toBe(0);
}

describe("restart recovery and landing recovery (GATE-07: REL-07, REL-08, SAFE-13, SAFE-15)", () => {
  it("detects a killed mid-run process as interrupted and resumes to completion without losing state (REL-07 / REL-08)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-gate07-kill-run-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await initGitRepo(root);
      const runId = "run_gate07kill01";
      const p = runPaths(root, runId);
      await mkdir(p.runDir, { recursive: true });

      const docentDef: AgentDefinition = {
        agentId: "docent",
        label: "Docent",
        role: "report",
        phase: "report",
        capability: "TextGeneration",
        permission: "read-only",
        produces: ["report"],
        consumes: [],
        runsInPool: null,
        freshContext: false,
      };
      const state = createInitialRunState({
        runId,
        repoPath: root,
        mode: "minimal",
        agentIds: [docentDef.agentId],
      });
      state.status = "running";
      state.phase = "report";

      child = spawn(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.env.STATE_FILE, process.env.STATE_JSON); process.stdout.write('ready'); setInterval(() => {}, 1000);",
        ],
        {
          env: { ...process.env, STATE_FILE: p.stateFile, STATE_JSON: JSON.stringify(state) },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      await new Promise<void>((resolve, reject) => {
        child?.stdout?.once("data", () => resolve());
        child?.once("error", reject);
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child?.once("close", () => resolve()));

      const config = RepoConfigSchema.parse({ routing: DEFAULT_MODEL_ROUTING });
      let executedReport = 0;
      const executorFactory = () =>
        ({
          definitions: () => [docentDef],
          execute: async () => {
            executedReport += 1;
            return { outcome: "passed", artifactIds: [] };
          },
        }) as never;

      const manager = await RunManager.open(root, executorFactory, { config });
      const runtime = await manager.loadRun(runId);

      // REL-08: Persisted "running" state reloads as "interrupted"
      expect(runtime.snapshot().status).toBe("interrupted");
      const onDiskInterrupted = JSON.parse(await readFile(p.stateFile, "utf8")) as { status: string };
      expect(onDiskInterrupted.status).toBe("interrupted");

      // REL-07: Explicit resume continues from persisted phase and completes
      await runtime.resume();
      expect(executedReport).toBe(1);
      expect(runtime.snapshot().status).toBe("completed");
      expect(runtime.snapshot().phase).toBe("completed");
    } finally {
      if (child && !child.killed) child.kill("SIGKILL");
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("recovers from a process killed mid-cherry-pick during landing and restores a clean user branch (SAFE-15)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-gate07-kill-land-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
    try {
      await initGitRepo(root);
      const git = (args: string[]) => runCommand("git", args, { cwd: root });

      expect((await git(["checkout", "-b", "vibefix/rfc-001-a0"])).code).toBe(0);
      await writeFile(path.join(root, "src.ts"), "export const x = 2;\n", "utf8");
      expect((await git(["commit", "-am", "feature change"])).code).toBe(0);
      const featureRef = (await git(["rev-parse", "HEAD"])).stdout.trim();

      expect((await git(["checkout", "main"])).code).toBe(0);
      await writeFile(path.join(root, "src.ts"), "export const x = 3;\n", "utf8");
      expect((await git(["commit", "-am", "conflicting main change"])).code).toBe(0);
      const mainHeadBefore = (await git(["rev-parse", "HEAD"])).stdout.trim();

      // Simulate a crash mid-cherry-pick (CHERRY_PICK_HEAD left on disk + landing-journal.json present)
      expect((await git(["cherry-pick", featureRef])).code).not.toBe(0);
      const journal = path.join(projectDir(root), "landing-journal.json");
      await mkdir(path.dirname(journal), { recursive: true });
      await writeFile(journal, JSON.stringify({ proposalId: "RFC-001", ref: featureRef, baseCommit: mainHeadBefore }), "utf8");

      const config = RepoConfigSchema.parse({ routing: DEFAULT_MODEL_ROUTING });
      await RunManager.open(root, () => ({ definitions: () => [], execute: async () => ({ outcome: "passed", artifactIds: [] }) }) as never, {
        config,
      });

      expect((await git(["status", "--porcelain"])).stdout.trim()).toBe("");
      expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(mainHeadBefore);
      await expect(access(journal)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("verifies worktree removal on discard and surfaces E_DISCARD_FAILED if removal is blocked (SAFE-13)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-gate07-discard-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, ".vibefix-home");
    try {
      await initGitRepo(root);
      const wm = new WorktreeManager(root);
      const handle = await wm.create("RFC-001", 0);
      await wm.discard(handle);
      await expect(access(handle.path)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

