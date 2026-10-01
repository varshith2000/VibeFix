import { RunManager, type OrchestratorRuntime } from "@vibefix/core";
import { vibefixExecutorFactory } from "@vibefix/agents";
import type { RepoConfig, RunState } from "@vibefix/schemas";
import type { AgentExecutionEvent } from "@vibefix/schemas";

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

/** Events that put a run into a state where its runtime is no longer needed. */
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.aborted", "run.nochanges"]);

export interface BackgroundFailure {
  runId: string;
  message: string;
  ts: string;
}

/**
 * Holds opened projects and their active runs. One RunManager per repo path.
 * Runtimes are registered while a run is live and UNREGISTERED when the run
 * reaches a terminal state (after background work settles) — the durable
 * on-disk run dir keeps serving state/events/evidence, so nothing goes blind,
 * but completed runs no longer accumulate in memory forever or inflate the
 * health endpoint's active-runtime count.
 */
export class ProjectRegistry {
  private readonly managers = new Map<string, RunManager>();
  private readonly runtimes = new Map<string, { runtime: OrchestratorRuntime; repoPath: string }>();
  private readonly background = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, BackgroundFailure>();

  /** The canonical comparison key for "is this run's project the same repo?". */
  keyFor(repoPath: string): string {
    return registryKey(repoPath);
  }

  async open(repoPath: string, options?: { initIfMissing?: boolean }): Promise<RunManager> {
    const key = registryKey(repoPath);
    const existing = this.managers.get(key);
    if (existing) return existing;
    const manager = await RunManager.open(repoPath, vibefixExecutorFactory(process.env), options);
    this.managers.set(key, manager);
    return manager;
  }

  peek(repoPath: string): RunManager | undefined {
    return this.managers.get(registryKey(repoPath));
  }

  registerRuntime(runtime: OrchestratorRuntime, repoPath: string): void {
    this.runtimes.set(runtime.runId, { runtime, repoPath });
    this.watchForTerminal(runtime);
  }

  /**
   * Drop the runtime once its run is terminal AND its background work has
   * settled. Everything the API serves afterwards comes from disk, which is
   * durable and identical for terminal runs.
   */
  private watchForTerminal(runtime: OrchestratorRuntime): void {
    const drop = () => {
      void this.settle(runtime.runId)
        .catch(() => undefined)
        .then(() => {
          // Guard against unregistering a run that somehow restarted (resume()
          // no-ops on terminal states, so this is defensive only).
          try {
            const status = runtime.snapshot().status;
            if (status === "completed" || status === "failed" || status === "aborted") {
              this.runtimes.delete(runtime.runId);
              this.background.delete(runtime.runId);
            }
          } catch {
            this.runtimes.delete(runtime.runId);
            this.background.delete(runtime.runId);
          }
        });
    };
    try {
      if (isTerminalStatus(runtime.snapshot().status)) {
        drop(); // registered already-terminal (e.g. /open on a finished run)
        return;
      }
    } catch {
      // snapshot broken — leave registered; settle paths still work
    }
    try {
      const unsubscribe = runtime.events.subscribe((event: AgentExecutionEvent) => {
        if (!TERMINAL_EVENTS.has(event.type)) return;
        unsubscribe();
        drop();
      });
    } catch {
      // A runtime without a usable event bus (test doubles, broken state) —
      // registration still works; cleanup then happens on next server touch.
    }
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

  /** Last recorded background failure for a run, if any. */
  failureFor(runId: string): BackgroundFailure | undefined {
    return this.failures.get(runId);
  }

  backgroundFailureCount(): number {
    return this.failures.size;
  }

  /**
   * Runs a promise (e.g. dispatch(START) / resume) in the background,
   * remembering it so tests can await completion (settle). Failures are NOT
   * swallowed silently: the run is force-failed through the reducer (FATAL →
   * status "failed", run.failed event, worktree cleanup) and the failure is
   * recorded for the health endpoint and API surfaces.
   */
  track(runId: string, promise: Promise<void>): Promise<void> {
    const wrapped = promise.catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[vibefix] run ${runId} background task failed:`, err);
      if (this.failures.size >= 200) {
        // bounded: drop the oldest recorded failure (Map keeps insertion order)
        const oldest = this.failures.keys().next().value;
        if (oldest !== undefined) this.failures.delete(oldest);
      }
      this.failures.set(runId, { runId, message, ts: new Date().toISOString() });
      // Persist the failure into run state — a run whose dispatch machinery
      // died must never keep showing "running". FATAL is a no-op if the run
      // already reached a terminal state.
      const entry = this.runtimes.get(runId);
      if (entry) {
        await entry.runtime
          .dispatch({ type: "FATAL", message: `background task failed: ${message.slice(0, 280)}` })
          .catch((fatalErr) =>
            console.error(`[vibefix] run ${runId}: could not persist FATAL after background failure:`, fatalErr),
          );
      }
    });
    const previous = this.background.get(runId);
    const combined = previous ? previous.then(() => wrapped) : wrapped;
    this.background.set(runId, combined);
    return combined;
  }

  async settle(runId: string): Promise<void> {
    await this.background.get(runId);
  }

  /** Stop accepting work only after every tracked run has settled. */
  async shutdown(): Promise<void> {
    const aborts: Promise<void>[] = [];
    for (const [runId, entry] of this.runtimes) {
      try {
        const status = entry.runtime.snapshot().status;
        if (status === "running" || status === "paused" || status === "awaitingApproval") {
          aborts.push(entry.runtime.dispatch({ type: "ABORT" }).catch(() => undefined));
        }
      } catch { /* broken runtime is handled by persisted recovery */ }
      void runId;
    }
    await Promise.allSettled(aborts);
    await Promise.allSettled([...this.background.values()]);
  }
}

function isTerminalStatus(status: RunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/** Shared helper: encode a repo path for use in URLs. */
export function encodePath(repoPath: string): string {
  return Buffer.from(repoPath, "utf8").toString("base64url");
}

export function decodePath(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

export type { RunState, RepoConfig };
