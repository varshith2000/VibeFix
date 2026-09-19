import path from "node:path";

/** All on-disk layout decisions live here. Artifact-internal paths stay POSIX. */
export interface RunPaths {
  repoPath: string;
  vibefixDir: string;
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
}

export function runsDir(repoPath: string): string {
  return path.join(repoPath, ".vibefix", "runs");
}

export function configPath(repoPath: string): string {
  return path.join(repoPath, ".vibefix", "config.json");
}

export function runPaths(repoPath: string, id: string): RunPaths {
  const vibefixDir = path.join(repoPath, ".vibefix");
  const runDir = path.join(vibefixDir, "runs", id);
  return {
    repoPath,
    vibefixDir,
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
    configFile: path.join(vibefixDir, "config.json"),
    worktreesDir: path.join(vibefixDir, "worktrees"),
  };
}
