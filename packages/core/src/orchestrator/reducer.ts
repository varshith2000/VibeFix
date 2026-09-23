import type { RunState } from "@vibefix/schemas";
import type { AgentRegistrySnapshot, Effect, RunEvent } from "./state.js";
import { cloneState } from "./state.js";

/**
 * The pure transition table. No I/O, no clock, no randomness — fully testable.
 * Failure philosophy:
 *  - Pool agents (recon/diagnosis/risk/synthesis): a failure degrades the run
 *    (missing evidence becomes unknowns downstream), never kills it.
 *  - Harness/report agents: failure aborts before any code is touched.
 *  - Execution gates: rejected -> retry (budgeted) -> defer. Never force.
 */
export function reduce(
  state: RunState,
  event: RunEvent,
  registry: AgentRegistrySnapshot,
  budgets: { maxRetriesPerChange: number; maxChangesPerRun: number },
): { state: RunState; effects: Effect[] } {
  const next = cloneState(state);
  const effects: Effect[] = [];
  next.updatedAt = new Date().toISOString(); // runtime stamps before persist

  switch (event.type) {
    case "START": {
      if (next.phase !== "init") break; // idempotent resume safety
      next.status = "running";
      next.phase = "recon";
      const agentIds = registry.agentIdsByPool("recon");
      for (const id of agentIds) next.agentStates[id] = "queued";
      effects.push({ effect: "EmitEvent", type: "phase.entered", message: "recon" });
      effects.push({ effect: "SpawnPool", pool: "recon", agentIds });
      break;
    }

    case "PHASE_COMPLETED": {
      if (next.phase !== event.phase) break; // stale completion (e.g. after abort)
      effects.push({ effect: "EmitEvent", type: "phase.completed", message: event.phase });
      switch (event.phase) {
        case "recon": {
          next.phase = "diagnosis";
          const agentIds = registry.agentIdsByPool("diagnosis");
          for (const id of agentIds) next.agentStates[id] = "queued";
          effects.push({ effect: "EmitEvent", type: "phase.entered", message: "diagnosis" });
          effects.push({ effect: "SpawnPool", pool: "diagnosis", agentIds });
          break;
        }
        case "diagnosis": {
          next.phase = "riskAssessment";
          const id = registry.agentIdByPhase("riskAssessment");
          if (id) {
            next.agentStates[id] = "queued";
            effects.push({ effect: "InvokeAgent", agentId: id });
          }
          break;
        }
        case "riskAssessment": {
          next.phase = "synthesis";
          const id = registry.agentIdByPhase("synthesis");
          if (id) {
            next.agentStates[id] = "queued";
            effects.push({ effect: "InvokeAgent", agentId: id });
          }
          break;
        }
        case "synthesis": {
          next.phase = "minimality";
          const id = registry.agentIdByPhase("minimality");
          if (id) {
            next.agentStates[id] = "queued";
            effects.push({ effect: "InvokeAgent", agentId: id });
          } else {
            // No minimality agent registered — fall through to checkpoint.
            next.phase = "awaitingApproval";
            next.status = "awaitingApproval";
            next.approval = { requested: true, decidedAt: null, approvedItems: [], mode: null };
            effects.push({ effect: "EmitEvent", type: "checkpoint.awaitingApproval" });
            effects.push({ effect: "PauseForApproval" });
          }
          break;
        }
        case "minimality": {
          next.phase = "awaitingApproval";
          next.status = "awaitingApproval";
          next.approval = { requested: true, decidedAt: null, approvedItems: [], mode: null };
          effects.push({ effect: "EmitEvent", type: "checkpoint.awaitingApproval" });
          effects.push({ effect: "PauseForApproval" });
          break;
        }
        case "harness": {
          next.phase = "execution";
          effects.push({ effect: "EmitEvent", type: "phase.entered", message: "execution" });
          const first = next.execution.queue[0];
          if (first !== undefined) {
            next.execution.stage = "implement";
            effects.push({ effect: "ExecuteProposal", proposalId: first, attempt: 0 });
          } else {
            // Nothing approved — skip straight to reporting.
            next.phase = "report";
            const docent = registry.agentIdByPhase("report");
            if (docent) effects.push({ effect: "InvokeAgent", agentId: docent });
          }
          break;
        }
        case "report": {
          next.phase = "completed";
          // Preserve aborted status when the user rejected the backlog.
          if (next.status !== "aborted") next.status = "completed";
          effects.push({ effect: "EmitEvent", type: "run.completed" });
          break;
        }
        default:
          break;
      }
      break;
    }

    case "AGENT_STARTED": {
      if (next.agentStates[event.agentId] === "deferred") break;
      next.agentStates[event.agentId] = "running";
      effects.push({ effect: "EmitEvent", type: "agent.started", agentId: event.agentId });
      break;
    }

    case "AGENT_RESULT": {
      const current = next.agentStates[event.agentId];
      if (current !== "running" && current !== "queued") break; // stale duplicate
      next.agentStates[event.agentId] = event.outcome === "passed" ? "passed" : event.outcome;
      effects.push({
        effect: "EmitEvent",
        type: event.outcome === "passed" ? "agent.completed" : event.outcome === "rejected" ? "agent.rejected" : "agent.failed",
        agentId: event.agentId,
        payload: { artifactIds: event.artifactIds },
      });
      break;
    }

    case "CHECKPOINT_APPROVED": {
      if (next.phase !== "awaitingApproval") break;
      next.status = "running";
      next.phase = "harness";
      next.mode = event.mode;
      next.approval = {
        requested: true,
        decidedAt: new Date().toISOString(),
        approvedItems: event.approvedProposalIds.slice(0, budgets.maxChangesPerRun),
        mode: event.mode,
      };
      next.execution = {
        queue: next.approval.approvedItems,
        currentIndex: 0,
        attempt: 0,
        stage: "implement",
      };
      effects.push({ effect: "EmitEvent", type: "checkpoint.approved", message: `${event.approvedProposalIds.length} proposals approved, mode=${event.mode}` });
      effects.push({ effect: "EmitEvent", type: "phase.entered", message: "harness" });
      const harness = registry.agentIdByPhase("harness");
      if (harness) {
        next.agentStates[harness] = "queued";
        effects.push({ effect: "InvokeAgent", agentId: harness });
      }
      break;
    }

    case "CHECKPOINT_REJECTED": {
      if (next.phase !== "awaitingApproval") break;
      next.status = "aborted";
      next.phase = "report";
      next.error = "user rejected the backlog";
      effects.push({ effect: "EmitEvent", type: "run.aborted", message: "user rejected the backlog" });
      const docent = registry.agentIdByPhase("report");
      if (docent) {
        next.agentStates[docent] = "queued";
        effects.push({ effect: "InvokeAgent", agentId: docent });
      }
      break;
    }

    case "GATE_VERDICT": {
      if (next.phase !== "execution") break;
      // Ignore stale verdicts (e.g. from a previous attempt racing an abort).
      const current = next.execution.queue[next.execution.currentIndex];
      if (current !== event.proposalId) break;
      effects.push({
        effect: "EmitEvent",
        type: "proposal.verdict",
        proposalId: event.proposalId,
        message: event.verdict,
        payload: { reason: event.reason },
      });
      const advanced = advanceExecution(next, event, budgets, effects);
      if (advanced === "queue-empty") {
        next.phase = "report";
        const docent = registry.agentIdByPhase("report");
        if (docent) {
          next.agentStates[docent] = "queued";
          effects.push({ effect: "InvokeAgent", agentId: docent });
        }
      }
      break;
    }

    case "SKIP_TO_REPORT": {
      // No findings / no proposals: the remaining analysis agents (risk,
      // synthesis, minimality, checkpoint) have nothing to work on. Mark them
      // skipped and let Docent produce the "nothing to change" report.
      const skippable = new Set(["diagnosis", "riskAssessment", "synthesis", "minimality"]);
      if (!skippable.has(next.phase)) break; // too late (already past analysis)
      const docent = registry.agentIdByPhase("report");
      for (const [id, status] of Object.entries(next.agentStates)) {
        if (id === docent) continue;
        if (status !== "passed" && status !== "failed" && status !== "rejected" && status !== "deferred") {
          next.agentStates[id] = "skipped";
        }
      }
      next.phase = "report";
      effects.push({ effect: "EmitEvent", type: "run.nochanges", message: event.reason });
      if (docent) {
        next.agentStates[docent] = "queued";
        effects.push({ effect: "InvokeAgent", agentId: docent });
      } else {
        next.phase = "completed";
        if (next.status !== "aborted") next.status = "completed";
        effects.push({ effect: "EmitEvent", type: "run.completed" });
      }
      break;
    }

    case "ABORT": {
      if (next.status === "completed" || next.status === "aborted") break;
      next.status = "aborted";
      next.error = "aborted by user";
      effects.push({ effect: "EmitEvent", type: "run.aborted", message: "aborted by user" });
      effects.push({ effect: "CleanupWorktrees" });
      break;
    }

    case "BUDGET_EXCEEDED": {
      next.status = "aborted";
      next.error = "token budget exhausted";
      effects.push({ effect: "EmitEvent", type: "run.aborted", message: "token budget exhausted" });
      effects.push({ effect: "CleanupWorktrees" });
      break;
    }

    case "FATAL": {
      next.status = "failed";
      next.error = event.message;
      effects.push({ effect: "EmitEvent", type: "run.failed", message: event.message });
      effects.push({ effect: "CleanupWorktrees" });
      break;
    }

    case "SKIP_TO_REPORT": {
      // Skip remaining analysis phases and go straight to report
      next.status = "running";
      next.phase = "report";
      next.error = null; // Clear any previous errors
      effects.push({ effect: "EmitEvent", type: "run.nochanges", message: event.reason });
      effects.push({ effect: "EmitEvent", type: "phase.entered", message: "report" });
      
      // Invoke the docent/report agent
      const docent = registry.agentIdByPhase("report");
      if (docent) {
        next.agentStates[docent] = "queued";
        effects.push({ effect: "InvokeAgent", agentId: docent });
      }
      break;
    }
  }

  return { state: next, effects };
}

/** Mutates execution cursor. Returns "queue-empty" when the loop is done. */
function advanceExecution(
  state: RunState,
  event: Extract<RunEvent, { type: "GATE_VERDICT" }>,
  budgets: { maxRetriesPerChange: number; maxChangesPerRun: number },
  effects: Effect[],
): "advanced" | "queue-empty" {
  if (event.verdict === "passed") {
    state.budget.changesCommitted += 1;
    state.execution.attempt = 0;
    state.execution.stage = "commit";
    return advanceIndex(state, effects, budgets);
  }

  // Rejected: budgeted retry, then defer. Never force a failing change.
  if (state.execution.attempt < budgets.maxRetriesPerChange) {
    state.execution.attempt += 1;
    state.budget.retriesUsed += 1;
    state.execution.stage = "implement";
    effects.push({
      effect: "ExecuteProposal",
      proposalId: event.proposalId,
      attempt: state.execution.attempt,
    });
    return "advanced";
  }

  state.execution.stage = "defer";
  effects.push({
    effect: "EmitEvent",
    type: "ledger.updated",
    proposalId: event.proposalId,
    message: "deferred after exhausting retry budget",
  });
  state.execution.attempt = 0;
  return advanceIndex(state, effects, budgets);
}

function advanceIndex(
  state: RunState,
  effects: Effect[],
  budgets: { maxChangesPerRun: number },
): "advanced" | "queue-empty" {
  state.execution.currentIndex += 1;
  if (state.execution.currentIndex >= state.execution.queue.length) {
    return "queue-empty";
  }
  if (state.budget.changesCommitted >= budgets.maxChangesPerRun) {
    return "queue-empty";
  }
  const nextProposal = state.execution.queue[state.execution.currentIndex];
  if (nextProposal !== undefined) {
    state.execution.stage = "implement";
    effects.push({
      effect: "ExecuteProposal",
      proposalId: nextProposal,
      attempt: 0,
    });
  }
  return "advanced";
}
