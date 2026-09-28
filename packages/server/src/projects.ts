import { RunManager, type OrchestratorRuntime } from "@vibefix/core";
import { vibefixExecutorFactory } from "@vibefix/agents";
import type { RepoConfig, RunState } from "@vibefix/schemas";

/**
 * Case-fold registry keys ONLY on Windows: on case-sensitive filesystems
 * /home/u/App and /home/u/app are different repositories and must not share
 * a RunManager. Matches core's projectKey folding rule.
 */
function registryKey(repoPath: string): string {
  const resolved = repoPath.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const ACTIVE_STATUSES = new Set(["running", "paused", "awaitingApproval"]);

/**
 * Holds opened projects and their active runs. One RunManager per repo path;
 * runtimes are kept after creation so the UI can poll/stream even mid-phase.
 */
export class ProjectRegistry {
  private readonly managers = new Map<string, RunManager>();
  private readonly runtimes = new Map<string, { runtime: OrchestratorRuntime; repoPath: string }>();
  private readonly background = new Map<string, Promise<void>>();

  /** The canonical comparison key for "is this run's project the same repo?". */
  keyFor(repoPath: string): string {
    return registryKey(repoPath);
  }

  async open(repoPath: string): Promise<RunManager> {
    const key = registryKey(repoPath);
    const existing = this.managers.get(key);
    if (existing) return existing;
    const manager = await RunManager.open(repoPath, vibefixExecutorFactory(process.env));
    this.managers.set(key, manager);
    return manager;
  }

  peek(repoPath: string): RunManager | undefined {
    return this.managers.get(registryKey(repoPath));
  }

  registerRuntime(runtime: OrchestratorRuntime, repoPath: string): void {
    this.runtimes.set(runtime.runId, { runtime, repoPath });
  }

  runtime(runId: string): { runtime: OrchestratorRuntime; repoPath: string } | undefined {
    return this.runtimes.get(runId);
  }

  /** The live runtime for `runId` IF it belongs to `repoPath`, else undefined. */
  runtimeForProject(runId: string, repoPath: string): { runtime: OrchestratorRuntime; repoPath: string } | undefined {
    const entry = this.runtimes.get(runId);
    if (!entry) return undefined;
    return registryKey(entry.repoPath) === registryKey(repoPath) ? entry : undefined;
  }

  activeRuntimeCount(): number {
    return this.runtimes.size;
  }

  /** Runs currently consuming the machine (not terminal) — for run ceilings. */
  activeRunCount(): number {
    let n = 0;
    for (const { runtime } of this.runtimes.values()) {
      try {
        if (ACTIVE_STATUSES.has(runtime.snapshot().status)) n++;
      } catch {
        // runtime in a broken state — do not let it block the ceiling forever
      }
    }
    return n;
  }

  /**
   * Runs a promise (e.g. dispatch(START) / approve / resume) in the background,
   * remembering it so errors surface in logs and tests can await completion.
   */
  track(runId: string, promise: Promise<void>): Promise<void> {
    const wrapped = promise.catch((err) => {
      console.error(`[vibefix] run ${runId} background task failed:`, err);
    });
    const previous = this.background.get(runId);
    const combined = previous ? previous.then(() => wrapped) : wrapped;
    this.background.set(runId, combined);
    return combined;
  }

  async settle(runId: string): Promise<void> {
    await this.background.get(runId);
  }
}

/** Shared helper: encode a repo path for use in URLs. */
export function encodePath(repoPath: string): string {
  return Buffer.from(repoPath, "utf8").toString("base64url");
}

export function decodePath(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

export type { RunState, RepoConfig };
