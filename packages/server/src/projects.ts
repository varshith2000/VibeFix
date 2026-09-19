import { RunManager, type OrchestratorRuntime } from "@vibefix/core";
import { vibefixExecutorFactory } from "@vibefix/agents";
import type { RepoConfig, RunState } from "@vibefix/schemas";

/**
 * Holds opened projects and their active runs. One RunManager per repo path;
 * runtimes are kept after creation so the UI can poll/stream even mid-phase.
 */
export class ProjectRegistry {
  private readonly managers = new Map<string, RunManager>();
  private readonly runtimes = new Map<string, { runtime: OrchestratorRuntime; repoPath: string }>();
  private readonly background = new Map<string, Promise<void>>();

  async open(repoPath: string): Promise<RunManager> {
    const key = repoPath.toLowerCase();
    const existing = this.managers.get(key);
    if (existing) return existing;
    const manager = await RunManager.open(repoPath, vibefixExecutorFactory(process.env));
    this.managers.set(key, manager);
    return manager;
  }

  peek(repoPath: string): RunManager | undefined {
    return this.managers.get(repoPath.toLowerCase());
  }

  registerRuntime(runtime: OrchestratorRuntime, repoPath: string): void {
    this.runtimes.set(runtime.runId, { runtime, repoPath });
  }

  runtime(runId: string): { runtime: OrchestratorRuntime; repoPath: string } | undefined {
    return this.runtimes.get(runId);
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
