import { promises as fs } from "node:fs";
import {
  BacklogArtifactSchema,
  FindingsArtifactSchema,
  RiskAssessmentsArtifactSchema,
  type AgentDefinition,
  type Budgets,
  type ChangeLedgerEntry,
  type ChangeProposal,
  type RunState,
} from "@vibefix/schemas";
import { ledgerId } from "../util/ids.js";
import { atomicWrite } from "../store/evidence-store.js";
import type { EventLog } from "../store/event-log.js";
import type { EvidenceStore } from "../store/evidence-store.js";
import type { RunPaths } from "../store/paths.js";
import type { BudgetMeter } from "../budget.js";
import { reduce } from "@vibefix/domain";
import type { AgentExecutorPort, AgentExecutionInput, AgentExecutionOutcome } from "./ports.js";
import type { RunEvent } from "@vibefix/domain";
import type { WorktreeManager, WorktreeHandle } from "../worktree/worktree-manager.js";
import { ChangeFirewall } from "../worktree/firewall.js";
import type { RunLock } from "../store/run-lock.js";
import { debug, info, warn, error } from "../util/logger.js";

const POOL_CONCURRENCY = 3;

/**
 * Executes reducer effects: runs agent pools, drives the execution loop
 * (worktree -> engineer -> verifier -> verdict), persists state atomically,
 * streams events. Resumable: an agent whose artifacts already exist is
 * skipped by the executor layer (never re-billed).
 */
export class OrchestratorRuntime {
  private state: RunState;
  private readonly defs: AgentDefinition[];
  private backlog: ChangeProposal[] | null = null;

  constructor(
    private readonly deps: {
      paths: RunPaths;
      store: EvidenceStore;
      events: EventLog;
      executor: AgentExecutorPort;
      worktrees: WorktreeManager;
      meter: BudgetMeter;
      budgets: Budgets;
      /** Config-level do-not-touch globs merged with Risk Assessor zones. */
      protectedPaths?: string[];
      lock?: RunLock;
    },
    initialState: RunState,
  ) {
    this.state = initialState;
    this.defs = deps.executor.definitions();
  }

  get runId(): string {
    return this.state.runId;
  }

  /** Read access for the server layer (WS bridge, REST artifact reads). */
  get events(): EventLog {
    return this.deps.events;
  }

  get store(): EvidenceStore {
    return this.deps.store;
  }

  get usage(): { total: number; byAgent: Record<string, number>; byProvider: Record<string, number> } {
    return this.deps.meter.usage();
  }

  get meter(): BudgetMeter {
    return this.deps.meter;
  }

  snapshot(): RunState {
    return structuredClone(this.state);
  }

  /**
   * Feed a command into the reducer, persist, perform effects. The
   * reduce→assign→persist section is SERIALIZED through a promise chain: pool
   * agents dispatch concurrently, and concurrent persist()/rename() calls on
   * Windows collide (EPERM) — a lost dispatch used to leave agents stuck
   * "running" forever with no events. Effects run OUTSIDE the lock because
   * they recursively dispatch (SpawnPool → agent dispatches), which would
   * deadlock against a lock held across effect execution.
   */
  dispatch(event: RunEvent): Promise<void> {
    const eventId = `${event.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    debug("orchestrator", `Dispatching event ${eventId} of type ${event.type}`);
    
    const locked = this.dispatchQueue.then(() => this.reduceAndPersist(event));
    // Keep the queue alive even if one dispatch fails; the error propagates
    // to the caller, subsequent dispatches still run.
    this.dispatchQueue = locked.then(
      () => {
        debug("orchestrator", `Event ${eventId} completed successfully`);
        return undefined;
      },
      (err) => {
        error("orchestrator", `Dispatch queue error for event ${eventId}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      },
    );
    return locked.then((effects) => {
      debug("orchestrator", `Performing ${effects.length} effects for event ${eventId}`);
      return this.performEffects(effects).finally(async () => {
        if (this.state.status === "completed" || this.state.status === "aborted" || this.state.status === "failed") {
          await this.deps.lock?.release();
        }
      });
    });
  }

  private dispatchQueue: Promise<void> = Promise.resolve();

  private async reduceAndPersist(event: RunEvent): Promise<ReturnType<typeof reduce>["effects"]> {
    if (this.state.status === "completed" || this.state.status === "aborted" || this.state.status === "failed") {
      if (event.type !== "ABORT") {
        debug("orchestrator", `Ignoring event ${event.type} for terminal run ${this.runId}`);
        return []; // terminal: ignore stale work
      }
    }
    
    debug("orchestrator", `Processing event ${event.type} for run ${this.runId}`);
    
    const { state, effects } = reduce(
      this.state,
      event,
      registryFrom(this.defs),
      { maxRetriesPerChange: this.deps.budgets.maxRetriesPerChange, maxChangesPerRun: this.deps.budgets.maxChangesPerRun },
    );
    this.state = state;
    this.state.budget.tokensSpent = this.deps.meter.tokens; // runtime-owned field
    try {
      await this.persist();
      debug("orchestrator", `Successfully persisted state for event ${event.type}`);
    } catch (err) {
      error("orchestrator", `Persistence failed for event ${event.type}:`, err);
      throw err; // Let the caller handle the error
    }
    return effects;
  }

  private async performEffects(effects: ReturnType<typeof reduce>["effects"]): Promise<void> {
    for (const effect of effects) {
      try {
        switch (effect.effect) {
          case "EmitEvent":
            await this.deps.events.append(this.runId, effect.type, {
              agentId: effect.agentId,
              message: effect.message,
              payload: effect.payload,
            });
            break;
          case "SpawnPool":
            await this.runPool(effect.pool, effect.agentIds);
            break;
          case "InvokeAgent":
            await this.runSequentialAgent(effect.agentId);
            break;
          case "ExecuteProposal":
            await this.executeProposal(effect.proposalId, effect.attempt);
            break;
          case "PauseForApproval":
            break; // state persisted; server serves the checkpoint
          case "CleanupWorktrees":
            await this.deps.worktrees.cleanupAll().catch(() => undefined);
            break;
        }
      } catch (err) {
        console.error(`[VibeFix] Effect execution failed for ${effect.effect}:`, err);
        // Effects drive the state machine. Swallowing one leaves persisted
        // state claiming work is active even though no worker remains. Let the
        // server's background tracker convert the failure into a durable FATAL.
        throw err;
      }
      if (this.deps.meter.exceeded) {
        await this.dispatch({ type: "BUDGET_EXCEEDED" });
        return;
      }
    }
  }

  private defById(agentId: string): AgentDefinition {
    const def = this.defs.find((d) => d.agentId === agentId);
    if (!def) throw new Error(`unknown agent '${agentId}'`);
    return def;
  }

  private async runPool(pool: "recon" | "diagnosis", agentIds: string[]): Promise<void> {
    const phase = pool === "recon" ? "recon" : "diagnosis";
    const pending = agentIds.filter((id) => !isTerminal(this.state.agentStates[id]));
    await this.withEvents(
      pending.map(
        (id) => () =>
          this.runAgentGuarded(id, {
            runState: this.snapshot(),
          }),
      ),
    );
    if (pool === "diagnosis" && (await this.countFindings()) === 0) {
      // Nothing was found — risk assessor, synthesis, minimality and the
      // checkpoint would all no-op. Skip straight to the report.
      await this.dispatch({
        type: "SKIP_TO_REPORT",
        reason: "diagnosis produced 0 findings — nothing to change in this codebase",
      });
      return;
    }
    await this.dispatch({ type: "PHASE_COMPLETED", phase });
  }

  /** Total findings across every diagnosis agent's artifacts. */
  private async countFindings(): Promise<number> {
    let n = 0;
    for (const artifact of await this.deps.store.list(undefined, "findings")) {
      try {
        n += FindingsArtifactSchema.parse(artifact.data).findings.length;
      } catch {
        // malformed artifact — contributes nothing
      }
    }
    return n;
  }

  /** Proposals in the latest backlog artifact; null when unreadable/absent. */
  private async backlogSize(): Promise<number | null> {
    const artifact = await this.deps.store.latest("backlog");
    if (!artifact) return null;
    try {
      return BacklogArtifactSchema.parse(artifact.data).proposals.length;
    } catch {
      return null;
    }
  }

  private async runSequentialAgent(agentId: string): Promise<void> {
    const def = this.defById(agentId);
    const input: AgentExecutionInput = { runState: this.snapshot() };
    await this.runAgentGuarded(agentId, input);
    const phase = def.phase;
    if (phase === "synthesis" && (await this.backlogSize()) === 0) {
      // Findings existed but none survived into a proposal — minimality and
      // the checkpoint have an empty backlog. Skip to the report.
      await this.dispatch({
        type: "SKIP_TO_REPORT",
        reason: "synthesis produced 0 proposals — nothing to change in this codebase",
      });
      return;
    }
    if (phase === "riskAssessment" || phase === "synthesis" || phase === "minimality" || phase === "harness" || phase === "report") {
      await this.dispatch({ type: "PHASE_COMPLETED", phase });
    }
  }

  private async runAgentGuarded(agentId: string, input: AgentExecutionInput): Promise<void> {
    const def = this.defById(agentId);
    try {
      await this.dispatch({ type: "AGENT_STARTED", agentId });
      let outcome: AgentExecutionOutcome;
      try {
        outcome = await this.deps.executor.execute(def, input);
      } catch (err) {
        outcome = { outcome: "failed", artifactIds: [], error: String(err) };
      }
      await this.dispatch({
        type: "AGENT_RESULT",
        agentId,
        outcome: outcome.outcome,
        artifactIds: outcome.artifactIds,
      });
    } catch (err) {
      // The dispatch machinery itself failed (persist I/O, etc). NEVER leave
      // the agent stuck "running": force a terminal state and tell the world
      // directly through the event log.
      this.state.agentStates[agentId] = "failed";
      await this.deps.events
        .append(this.runId, "agent.failed", {
          agentId,
          message: `orchestrator error while running '${agentId}': ${String(err instanceof Error ? err.message : err).slice(0, 300)}`,
        })
        .catch(() => undefined);
      console.error(`[vibefix] run ${this.runId}: dispatch failed for ${agentId}:`, err);
    }
  }

  /**
   * The transformation loop, one proposal at a time:
   * fresh worktree -> engineer (firewalled) -> commit -> verifier gates ->
   * passed: cherry-pick to user branch | rejected: discard, budgeted retry.
   */
  private async executeProposal(proposalId: string, attempt: number): Promise<void> {
    const proposal = await this.loadProposal(proposalId);
    if (!proposal) {
      await this.dispatch({ type: "FATAL", message: `proposal ${proposalId} not found in backlog` });
      return;
    }
    const engineer = this.defs.find((d) => d.permission === "worktree-write");
    if (!engineer) {
      await this.dispatch({ type: "FATAL", message: "engineer agent missing from registry" });
      return;
    }

    const handle = await this.deps.worktrees.create(proposalId, attempt);
    const zones = await this.forbiddenZones();
    const priorViolations = (await this.deps.store.list(undefined, "firewall-violation"))
      .reduce((count, artifact) => {
        const data = artifact.data as { proposalId?: unknown };
        return data.proposalId === proposalId ? count + 1 : count;
      }, 0);
    const firewall = new ChangeFirewall(proposal, zones, priorViolations);
    const baseInput: AgentExecutionInput = {
      runState: this.snapshot(),
      proposal,
      attempt,
      forbiddenZones: zones,
    };

    await this.deps.events.append(this.runId, "agent.progress", {
      agentId: engineer.agentId,
      message: `attempt ${attempt}: implementing in worktree`,
      proposalId,
    });

    await this.dispatch({ type: "AGENT_STARTED", agentId: engineer.agentId });
    const engineerOutcome = await this.safeExecute(engineer, { ...baseInput, worktree: handle, firewall });
    await this.dispatch({
      type: "AGENT_RESULT",
      agentId: engineer.agentId,
      outcome: engineerOutcome.outcome === "passed" ? "passed" : engineerOutcome.outcome,
      artifactIds: engineerOutcome.artifactIds,
    });

    // Firewall auto-reject or engineer refusal: no commit, straight to verdict.
    if (engineerOutcome.outcome !== "passed") {
      const diff = await this.deps.worktrees.diff(handle).catch(() => "");
      await this.appendLedger({
        proposalId, attempt, handle, diff,
        verdict: "rejected",
        verifierNotes: [engineerOutcome.reason ?? engineerOutcome.error ?? "engineer did not produce a passing attempt"],
      });
      await this.deps.worktrees.discard(handle).catch(() => undefined);
      await this.dispatch({ type: "GATE_VERDICT", proposalId, verdict: "rejected", reason: engineerOutcome.reason });
      return;
    }

    if (this.executionWasCancelled()) {
      await this.deps.worktrees.discard(handle).catch(() => undefined);
      return;
    }

    const pendingFiles = await this.deps.worktrees.changedFiles(handle);
    const pendingDiff = await this.deps.worktrees.diff(handle).catch(() => "");
    if (pendingFiles.length === 0) {
      // Empty diff is a FAILED attempt — never auto-pass a no-op as "safe".
      await this.appendLedger({
        proposalId, attempt, handle, diff: "",
        verdict: "rejected",
        verifierNotes: ["engineer produced an empty diff — no structural change to verify"],
      });
      await this.deps.worktrees.discard(handle).catch(() => undefined);
      await this.dispatch({
        type: "GATE_VERDICT",
        proposalId,
        verdict: "rejected",
        reason: "empty diff — nothing to verify",
      });
      return;
    }

    const commit = await this.deps.worktrees.commit(handle, `vibefix: ${proposal.title} (${proposalId})`);
    if (!commit.ok || !commit.ref) {
      await this.appendLedger({
        proposalId, attempt, handle,
        diff: pendingDiff || `pending files:\n${pendingFiles.join("\n")}`,
        verdict: "rejected",
        verifierNotes: ["failed to commit the worktree"],
      });
      await this.deps.worktrees.discard(handle).catch(() => undefined);
      await this.dispatch({ type: "GATE_VERDICT", proposalId, verdict: "rejected", reason: "commit failed" });
      return;
    }
    const diff = await this.deps.worktrees.committedDiff(handle, commit.ref);
    if (diff.trim().length === 0) {
      await this.appendLedger({
        proposalId, attempt, handle, diff: "",
        verdict: "rejected",
        verifierNotes: ["committed attempt has no diff from its recorded base commit"],
      });
      await this.deps.worktrees.discard(handle).catch(() => undefined);
      await this.dispatch({ type: "GATE_VERDICT", proposalId, verdict: "rejected", reason: "empty committed diff" });
      return;
    }

    if (this.executionWasCancelled()) {
      await this.deps.worktrees.discard(handle).catch(() => undefined);
      return;
    }

    const verifiers = this.defs
      .filter((d) => d.runsInPool === "verification" || d.phase === "verification")
      .sort((a, b) => (a.gateOrder ?? 99) - (b.gateOrder ?? 99));
    const pool = [...new Map(verifiers.map((v) => [v.agentId, v])).values()];
    if (pool.length === 0) {
      await this.dispatch({ type: "FATAL", message: "no verification agents in registry" });
      return;
    }

    const notes: string[] = [];
    let allPassed = true;
    for (const gate of pool) {
      await this.dispatch({ type: "AGENT_STARTED", agentId: gate.agentId });
      const outcome = await this.safeExecute(gate, { ...baseInput, worktree: handle });
      await this.dispatch({
        type: "AGENT_RESULT",
        agentId: gate.agentId,
        outcome: outcome.outcome === "passed" ? "passed" : "rejected",
        artifactIds: outcome.artifactIds,
      });
      if (outcome.outcome !== "passed") {
        allPassed = false;
        notes.push(`${gate.agentId}: ${outcome.reason ?? outcome.error ?? "rejected"}`);
        break; // fail-fast; remaining gates unnecessary
      }
      notes.push(`${gate.agentId}: passed`);
      if (this.executionWasCancelled()) {
        await this.deps.worktrees.discard(handle).catch(() => undefined);
        return;
      }
    }

    if (allPassed) {
      if (this.executionWasCancelled()) {
        await this.deps.worktrees.discard(handle).catch(() => undefined);
        return;
      }
      const landed = await this.deps.worktrees.landOnMainBranch(handle, commit.ref);
      await this.appendLedger({
        proposalId, attempt, handle, diff,
        verdict: landed.ok ? "passed" : "rejected",
        verifierNotes: landed.ok ? notes : [...notes, "cherry-pick conflict; user branch untouched"],
        committedRef: landed.ok ? commit.ref : null,
      });
      await this.deps.worktrees.discard(handle).catch(() => undefined);
      await this.dispatch({
        type: "GATE_VERDICT",
        proposalId,
        verdict: landed.ok ? "passed" : "rejected",
        reason: landed.ok ? undefined : "landing conflict",
      });
      return;
    }

    await this.appendLedger({
      proposalId, attempt, handle, diff,
      verdict: "rejected",
      verifierNotes: notes,
    });
    await this.deps.worktrees.discard(handle).catch(() => undefined);
    await this.dispatch({
      type: "GATE_VERDICT",
      proposalId,
      verdict: "rejected",
      reason: notes.find((n) => !n.endsWith(": passed")) ?? "verification pool rejected",
    });
  }

  private executionWasCancelled(): boolean {
    return this.state.status === "aborted" || this.state.status === "failed";
  }

  private async safeExecute(def: AgentDefinition, input: AgentExecutionInput): Promise<AgentExecutionOutcome> {
    try {
      return await this.deps.executor.execute(def, input);
    } catch (err) {
      return { outcome: "failed", artifactIds: [], error: String(err) };
    }
  }

  private async loadProposal(proposalId: string): Promise<ChangeProposal | null> {
    // Always re-read latest backlog (minimality rewrites it after synthesis).
    const artifact = await this.deps.store.latest("backlog");
    if (artifact) {
      try {
        const parsed = BacklogArtifactSchema.parse(artifact.data);
        this.backlog = parsed.proposals;
        const hit = parsed.proposals.find((p) => p.proposalId === proposalId);
        if (hit) return hit;
      } catch {
        // fall through to full scan
      }
    }
    // Fallback: scan every backlog artifact (synthesis vs minimality).
    for (const art of await this.deps.store.list(undefined, "backlog")) {
      try {
        const parsed = BacklogArtifactSchema.parse(art.data);
        const hit = parsed.proposals.find((p) => p.proposalId === proposalId);
        if (hit) {
          this.backlog = parsed.proposals;
          return hit;
        }
      } catch {
        // skip
      }
    }
    return null;
  }

  private forbiddenZonesCache: string[] | null = null;

  /** Do-not-touch globs: Risk Assessor zones ∪ config.protectedPaths. */
  private async forbiddenZones(): Promise<string[]> {
    if (this.forbiddenZonesCache) return this.forbiddenZonesCache;
    const artifact = await this.deps.store.latest("risk-assessments");
    let zones: string[] = [...(this.deps.protectedPaths ?? [])];
    if (artifact) {
      try {
        const parsed = RiskAssessmentsArtifactSchema.parse(artifact.data);
        zones = [...new Set([...zones, ...parsed.forbiddenZones])];
      } catch {
        // keep protectedPaths only
      }
    }
    this.forbiddenZonesCache = zones;
    return zones;
  }

  private async appendLedger(input: {
    proposalId: string;
    attempt: number;
    handle: WorktreeHandle;
    diff: string;
    verdict: ChangeLedgerEntry["verdict"];
    verifierNotes: string[];
    committedRef?: string | null;
  }): Promise<void> {
    const entry: ChangeLedgerEntry = {
      ledgerId: ledgerId(),
      proposalId: input.proposalId,
      attempt: input.attempt,
      worktreePath: input.handle.path,
      baseCommit: input.handle.baseCommit,
      diff: input.diff.length > 200_000 ? `${input.diff.slice(0, 200_000)}\n... (truncated)` : input.diff,
      verdict: input.verdict,
      verifierNotes: input.verifierNotes,
      committedRef: input.committedRef ?? null,
      ts: new Date().toISOString(),
    };
    // Ledger is append-list; read-modify-write under single-writer runtime.
    let entries: ChangeLedgerEntry[] = [];
    try {
      const raw = JSON.parse(await fs.readFile(this.deps.paths.ledgerFile, "utf8"));
      entries = (raw as { entries?: ChangeLedgerEntry[] }).entries ?? [];
    } catch {
      entries = [];
    }
    entries.push(entry);
    await atomicWrite(this.deps.paths.ledgerFile, JSON.stringify({ entries }, null, 2));
    await this.deps.events.append(this.runId, "ledger.updated", {
      proposalId: input.proposalId,
      message: input.verdict,
    });
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.deps.paths.stateFile, JSON.stringify(this.state, null, 2));
  }

  /** Run tasks with a concurrency cap; all failures captured, never thrown. */
  private async withEvents(tasks: Array<() => Promise<void>>): Promise<void> {
    const queue = [...tasks];
    const workers = Array.from({ length: Math.min(POOL_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (task) await task().catch(() => undefined);
      }
    });
    await Promise.all(workers);
  }

  /**
   * Resume after a process restart. Agents with existing artifacts are cheap
   * no-ops (executor checks evidence presence); stale worktrees are discarded.
   */
  async resume(): Promise<void> {
    const s = this.state;
    if (s.status === "awaitingApproval" || s.status === "completed" || s.status === "aborted" || s.status === "failed") {
      return; // waiting on user, or terminal
    }
    if (s.status === "interrupted") {
      this.state.status = "running";
      this.state.error = null;
      await this.persist();
    }
    await this.deps.worktrees.cleanupAll().catch(() => undefined);
    switch (s.phase) {
      case "init":
        return this.dispatch({ type: "START" });
      case "recon":
        return this.resumePool("recon");
      case "diagnosis":
        return this.resumePool("diagnosis");
      case "riskAssessment":
      case "synthesis":
      case "minimality":
      case "harness":
      case "report": {
        const def = this.defs.find((d) => d.phase === s.phase);
        if (!def) return this.dispatch({ type: "PHASE_COMPLETED", phase: s.phase });
        if (isTerminal(s.agentStates[def.agentId])) {
          return this.dispatch({ type: "PHASE_COMPLETED", phase: s.phase });
        }
        return this.runSequentialAgent(def.agentId);
      }
      case "execution": {
        const proposalId = s.execution.queue[s.execution.currentIndex];
        if (proposalId === undefined) {
          // Queue drained — enter report via Docent, not a phantom PHASE_COMPLETED.
          const docent = this.defs.find((d) => d.phase === "report");
          if (docent && !isTerminal(s.agentStates[docent.agentId])) {
            return this.runSequentialAgent(docent.agentId);
          }
          return this.dispatch({ type: "PHASE_COMPLETED", phase: "report" });
        }
        return this.executeProposal(proposalId, s.execution.attempt);
      }
      default:
        return;
    }
  }

  private async resumePool(pool: "recon" | "diagnosis"): Promise<void> {
    const ids = this.defs.filter((d) => d.runsInPool === pool).map((d) => d.agentId);
    const pending = ids.filter((id) => !isTerminal(this.state.agentStates[id]));
    if (pending.length === 0) {
      return this.dispatch({ type: "PHASE_COMPLETED", phase: pool });
    }
    await this.withEvents(
      pending.map((id) => () => this.runAgentGuarded(id, { runState: this.snapshot() })),
    );
    await this.dispatch({ type: "PHASE_COMPLETED", phase: pool });
  }
}

function isTerminal(status: RunState["agentStates"][string] | undefined): boolean {
  return (
    status === "passed" || status === "failed" || status === "rejected" || status === "skipped" || status === "deferred"
  );
}

function registryFrom(defs: AgentDefinition[]) {
  return {
    agentIdsByPool: (pool: "recon" | "diagnosis" | "verification") =>
      defs.filter((d) => d.runsInPool === pool).map((d) => d.agentId),
    agentIdByPhase: (phase: "riskAssessment" | "synthesis" | "minimality" | "harness" | "report") =>
      defs.find((d) => d.phase === phase)?.agentId ?? null,
  };
}
