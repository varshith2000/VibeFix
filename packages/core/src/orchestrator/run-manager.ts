import { promises as fs } from "node:fs";
import path from "node:path";
import { GitTool } from "@vibefix/adapters";
import type { Budgets, RepoConfig, RefactoringMode, RunState } from "@vibefix/schemas";
import { DEFAULT_MODEL_ROUTING, RepoConfigSchema } from "@vibefix/schemas";
import { BudgetMeter } from "../budget.js";
import { runId } from "../util/ids.js";
import { EventLog } from "../store/event-log.js";
import { EvidenceStore } from "../store/evidence-store.js";
import { configPath, runPaths, runsDir } from "../store/paths.js";
import type { AgentExecutorPort } from "./ports.js";
import { OrchestratorRuntime } from "./runtime.js";
import { createInitialRunState } from "./state.js";
import { WorktreeManager } from "../worktree/worktree-manager.js";

/** Per-run services the executor factory binds into agent contexts. */
export interface RunServices {
  runId: string;
  repoPath: string;
  store: EvidenceStore;
  events: EventLog;
  meter: BudgetMeter;
  config: RepoConfig;
}

/** Executors are per-run: the factory receives that run's services. */
export type ExecutorFactory = (services: RunServices) => AgentExecutorPort;

/**
 * Owns the run lifecycle: validating the target repo, creating/loading runs,
 * wiring runtime dependencies. One RunManager per open project (repo path).
 */
export class RunManager {
  private readonly git: GitTool;

  private constructor(
    public readonly repoPath: string,
    private readonly executorFactory: ExecutorFactory,
    private readonly config: RepoConfig,
    private readonly onBudgetWarn?: (runId: string) => void,
  ) {
    this.git = new GitTool(repoPath);
  }

  static async open(
    repoPath: string,
    executorFactory: ExecutorFactory,
    options?: { config?: RepoConfig; onBudgetWarn?: (runId: string) => void },
  ): Promise<RunManager> {
    const absolute = path.resolve(repoPath);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`'${repoPath}' is not a directory`);
    }
    const git = new GitTool(absolute);
    if (!(await git.isRepo())) {
      throw new Error(`'${repoPath}' is not a git repository (VibeFix needs git for worktrees)`);
    }
    const config = options?.config ?? (await loadRepoConfig(absolute));
    return new RunManager(absolute, executorFactory, config, options?.onBudgetWarn);
  }

  get routing(): RepoConfig {
    return this.config;
  }

  /**
   * Live config update (Settings panel PUT). Mutates IN PLACE so running
   * runs see it: routes/providers are read per LLM call, and the budgets
   * object is shared by reference with active BudgetMeters and the reducer.
   */
  updateConfig(next: RepoConfig): void {
    this.config.routing.providers = next.routing.providers;
    this.config.routing.routes = next.routing.routes;
    // Field-by-field: the budgets object is shared by reference with live runs.
    this.config.routing.budgets.runMaxTokens = next.routing.budgets.runMaxTokens;
    this.config.routing.budgets.agentMaxTokens = next.routing.budgets.agentMaxTokens;
    this.config.routing.budgets.maxChangesPerRun = next.routing.budgets.maxChangesPerRun;
    this.config.routing.budgets.maxRetriesPerChange = next.routing.budgets.maxRetriesPerChange;
    this.config.routing.budgets.warnFraction = next.routing.budgets.warnFraction;
    this.config.defaultMode = next.defaultMode;
    this.config.protectedPaths = next.protectedPaths;
    this.config.analyzer = next.analyzer;
  }

  /** A dirty tree would mix user edits with refactors — refuse. */
  async assertClean(): Promise<void> {
    if (!(await this.git.isClean())) {
      throw new Error("working tree is not clean — commit or stash your changes first");
    }
  }

  async listRuns(): Promise<Array<{ runId: string; state: RunState }>> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(runsDir(this.repoPath), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Array<{ runId: string; state: RunState }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      try {
        const stateFile = path.join(runsDir(this.repoPath), entry.name, "state.json");
        const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as RunState;
        out.push({ runId: entry.name, state });
      } catch {
        // corrupt/partial run: skip listing
      }
    }
    return out.sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
  }

  async createRun(mode: RefactoringMode): Promise<{ runtime: OrchestratorRuntime; state: RunState }> {
    await this.assertClean();
    const id = runId();
    const paths = runPaths(this.repoPath, id);
    await fs.mkdir(paths.runDir, { recursive: true });
    const probe = this.executorFactory({
      runId: id,
      repoPath: this.repoPath,
      store: new EvidenceStore(paths),
      events: new EventLog(paths),
      meter: new BudgetMeter(this.config.routing.budgets),
      config: this.config,
    });
    const agentIds = probe.definitions().map((d) => d.agentId);
    const state = createInitialRunState({ runId: id, repoPath: this.repoPath, mode, agentIds });
    const runtime = this.buildRuntime(id, state);
    await fs.writeFile(paths.stateFile, JSON.stringify(state, null, 2), "utf8");
    return { runtime, state };
  }

  async loadRun(runId: string): Promise<OrchestratorRuntime> {
    const paths = runPaths(this.repoPath, runId);
    const raw = JSON.parse(await fs.readFile(paths.stateFile, "utf8"));
    const state = raw as RunState;
    // Heal stale "running" states: nothing executes while paused or terminal,
    // so any agent still marked running was orphaned by a crash/restart.
    if (state.status !== "running" && state.status !== "paused") {
      for (const [id, s] of Object.entries(state.agentStates)) {
        if (s === "running") state.agentStates[id] = "failed";
      }
    }
    return this.buildRuntime(runId, state);
  }

  private buildRuntime(runId: string, state: RunState): OrchestratorRuntime {
    const paths = runPaths(this.repoPath, runId);
    const store = new EvidenceStore(paths);
    const events = new EventLog(paths);
    const budgets: Budgets = this.config.routing.budgets;
    const meter = new BudgetMeter(budgets);
    if (this.onBudgetWarn) {
      const runIdCopy = runId;
      meter.onWarn(() => this.onBudgetWarn?.(runIdCopy));
    }
    const executor = this.executorFactory({
      runId,
      repoPath: this.repoPath,
      store,
      events,
      meter,
      config: this.config,
    });
    return new OrchestratorRuntime(
      {
        paths,
        store,
        events,
        executor,
        worktrees: new WorktreeManager(this.repoPath),
        meter,
        budgets,
      },
      state,
    );
  }
}

export async function loadRepoConfig(repoPath: string): Promise<RepoConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(repoPath), "utf8"));
    const parsed = RepoConfigSchema.parse(raw);
    // Mock providers were removed from the product; a persisted config still
    // routing to them predates that and silently degrades every agent to
    // deterministic demo output. Reset routing to the real-model defaults —
    // UI edits made since (provider toggles, model picks) are re-applied there.
    const routesToMock = Object.values(parsed.routing.routes).some(
      (r) => r.providerId.startsWith("mock-") || r.fallbackProviderId?.startsWith("mock-"),
    );
    if (routesToMock) {
      return { ...parsed, routing: structuredClone(DEFAULT_MODEL_ROUTING) };
    }
    return parsed;
  } catch {
    // No config yet: real-models-only defaults, gated by API keys in the env.
    return RepoConfigSchema.parse({ routing: DEFAULT_MODEL_ROUTING });
  }
}

export async function saveRepoConfig(repoPath: string, config: RepoConfig): Promise<void> {
  const configFile = configPath(repoPath);
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), "utf8");
}
