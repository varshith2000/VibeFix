import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog, EvidenceStore, RunLock, RunManager, WorktreeManager, projectDir, runPaths, type RunPaths } from "../src/index.js";
import { runCommand } from "@vibefix/adapters";
import { DEFAULT_MODEL_ROUTING, RepoConfigSchema } from "@vibefix/schemas";
import { createInitialRunState } from "@vibefix/domain";

function paths(root: string): RunPaths {
  return {
    repoPath: root, projectDir: root, runDir: root, stateFile: path.join(root, "state.json"),
    eventsFile: path.join(root, "events.ndjson"), evidenceDir: path.join(root, "evidence"),
    findingsFile: path.join(root, "findings.json"), backlogFile: path.join(root, "backlog.json"),
    ledgerFile: path.join(root, "ledger.json"), approvalFile: path.join(root, "approval.json"),
    reportFile: path.join(root, "report.md"), reportJsonFile: path.join(root, "report.json"),
    configFile: path.join(root, "config.json"), worktreesDir: path.join(root, "worktrees"),
    lockFile: path.join(root, ".run.lock"),
  };
}

describe("durable run primitives", () => {
  it("continues from the greatest persisted sequence, not the line count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-event-seq-"));
    try {
      const p = paths(root);
      await writeFile(p.eventsFile, JSON.stringify({ eventId: "old", runId: "run_x", seq: 7, ts: new Date().toISOString(), type: "log" }) + "\ncorrupt\n");
      const log = new EventLog(p);
      const event = await log.append("run_x", "log", { message: "next" });
      expect(event.seq).toBe(8);
      expect((await log.replaySince(0)).corruptLines).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("allows only one writer lease and removes it on release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-run-lock-"));
    try {
      const file = path.join(root, ".run.lock");
      const first = new RunLock(file);
      const second = new RunLock(file);
      await first.acquire();
      await expect(second.acquire()).rejects.toThrow("E_RUN_LOCKED");
      await first.release();
      await second.acquire();
      await second.release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("surfaces corrupt latest evidence instead of silently treating it as absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-evidence-corrupt-"));
    try {
      const p = paths(root);
      await mkdir(p.evidenceDir, { recursive: true });
      await writeFile(path.join(p.evidenceDir, "latest-report.json"), "{broken");
      const store = new EvidenceStore(p);
      expect(await store.latest("report")).toBeNull();
      expect(store.degraded).toBe(true);
      expect(store.corruptArtifacts).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("classifies a persisted running run as interrupted and requires explicit resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-recovery-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, "vibefix-home");
    try {
      for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]]) {
        const result = await runCommand("git", args, { cwd: root });
        expect(result.code).toBe(0);
      }
      const runId = "run_recovery01";
      const p = runPaths(root, runId);
      const state = createInitialRunState({ runId, repoPath: root, mode: "minimal", agentIds: [] });
      await mkdir(p.runDir, { recursive: true });
      state.status = "running";
      await writeFile(p.stateFile, JSON.stringify(state));
      const config = RepoConfigSchema.parse({ routing: DEFAULT_MODEL_ROUTING });
      const executorFactory = () => ({ definitions: () => [], execute: async () => ({ outcome: "passed", artifactIds: [] }) }) as never;
      const manager = await RunManager.open(root, executorFactory, { config });
      const runtime = await manager.loadRun(runId);
      expect(runtime.snapshot().status).toBe("interrupted");
      expect(JSON.parse(await (await import("node:fs/promises")).readFile(p.stateFile, "utf8")).status).toBe("interrupted");
      await runtime.resume();
      expect(runtime.snapshot().status).not.toBe("interrupted");
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a run written by a killed child process as interrupted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-kill-run-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, "vibefix-home");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]]) {
        expect((await runCommand("git", args, { cwd: root })).code).toBe(0);
      }
      const runId = "run_killed001";
      const p = runPaths(root, runId);
      const state = createInitialRunState({ runId, repoPath: root, mode: "minimal", agentIds: [] });
      state.status = "running";
      await mkdir(p.runDir, { recursive: true });
      child = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.STATE_FILE, process.env.STATE_JSON); process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        env: { ...process.env, STATE_FILE: p.stateFile, STATE_JSON: JSON.stringify(state) },
        stdio: ["ignore", "pipe", "ignore"],
      });
      await new Promise<void>((resolve, reject) => {
        child?.stdout?.once("data", () => resolve());
        child?.once("error", reject);
      });
      child.kill();
      await new Promise<void>((resolve) => child?.once("close", () => resolve()));

      const config = RepoConfigSchema.parse({ routing: DEFAULT_MODEL_ROUTING });
      const executorFactory = () => ({ definitions: () => [], execute: async () => ({ outcome: "passed", artifactIds: [] }) }) as never;
      const manager = await RunManager.open(root, executorFactory, { config });
      const runtime = await manager.loadRun(runId);
      expect(runtime.snapshot().status).toBe("interrupted");
    } finally {
      if (child && !child.killed) child.kill();
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts an interrupted cherry-pick before reopening the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-landing-recovery-"));
    const previousHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = path.join(root, "vibefix-home");
    try {
      const git = (args: string[]) => runCommand("git", args, { cwd: root });
      for (const args of [["init", "-b", "main"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]]) {
        expect((await git(args)).code).toBe(0);
      }
      await writeFile(path.join(root, "file.txt"), "base\n");
      expect((await git(["add", "."])).code).toBe(0);
      expect((await git(["commit", "-m", "base"])).code).toBe(0);
      expect((await git(["checkout", "-b", "feature"])).code).toBe(0);
      await writeFile(path.join(root, "file.txt"), "feature\n");
      expect((await git(["commit", "-am", "feature"])).code).toBe(0);
      const feature = (await git(["rev-parse", "HEAD"])).stdout.trim();
      expect((await git(["checkout", "main"])).code).toBe(0);
      await writeFile(path.join(root, "file.txt"), "main\n");
      expect((await git(["commit", "-am", "main"])).code).toBe(0);
      expect((await git(["cherry-pick", feature])).code).not.toBe(0);

      const journal = path.join(projectDir(root), "landing-journal.json");
      await mkdir(path.dirname(journal), { recursive: true });
      await writeFile(journal, JSON.stringify({ ref: feature }));
      await WorktreeManager.recoverLanding(root);

      expect((await git(["status", "--porcelain"])).stdout.trim()).toBe("");
      await expect(access(journal)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
