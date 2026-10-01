import path from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/**
 * Central VibeFix workspace. Run state, worktrees and per-project config
 * live here — NEVER inside the target repo (that would dirty the user's
 * working tree and block subsequent runs). Override with VIBEFIX_HOME.
 */
export function vibefixHome(): string {
  return process.env.VIBEFIX_HOME ?? path.join(homedir(), ".vibefix");
}

/**
 * Stable per-project key: sha1 of the normalized absolute repo path.
 * Case-folded ONLY on Windows — /home/u/App and /home/u/app are distinct
 * repositories on case-sensitive filesystems and must not share a key.
 */
export function projectKey(repoPath: string): string {
  const resolved = path.resolve(repoPath).replace(/\\/g, "/");
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

export function projectDir(repoPath: string): string {
  return path.join(vibefixHome(), "projects", projectKey(repoPath));
}

/** Cloned GitHub repos land here. */
export function clonesDir(): string {
  return path.join(vibefixHome(), "repos");
}

/** All on-disk layout decisions live here. Artifact-internal paths stay POSIX. */
export interface RunPaths {
  repoPath: string;
  projectDir: string;
  runDir: string;
  stateFile: string;
  eventsFile: string;
  evidenceDir: string;
  findingsFile: string;
  backlogFile: string;
  ledgerFile: string;
  approvalFile: string;
  reportFile: string;
  reportJsonFile: string;
  configFile: string;
  worktreesDir: string;
  lockFile: string;
}

export function runsDir(repoPath: string): string {
  return path.join(projectDir(repoPath), "runs");
}

export function configPath(repoPath: string): string {
  return path.join(projectDir(repoPath), "config.json");
}

export function worktreesDir(repoPath: string): string {
  return path.join(projectDir(repoPath), "worktrees");
}

export function runPaths(repoPath: string, id: string): RunPaths {
  const dir = projectDir(repoPath);
  const runDir = path.join(dir, "runs", id);
  return {
    repoPath,
    projectDir: dir,
    runDir,
    stateFile: path.join(runDir, "state.json"),
    eventsFile: path.join(runDir, "events.ndjson"),
    evidenceDir: path.join(runDir, "evidence"),
    findingsFile: path.join(runDir, "findings.json"),
    backlogFile: path.join(runDir, "backlog.json"),
    ledgerFile: path.join(runDir, "ledger.json"),
    approvalFile: path.join(runDir, "approval.json"),
    reportFile: path.join(runDir, "report.md"),
    reportJsonFile: path.join(runDir, "report.json"),
    configFile: path.join(dir, "config.json"),
    worktreesDir: path.join(dir, "worktrees"),
    lockFile: path.join(runDir, ".run.lock"),
  };
}
