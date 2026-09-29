export const SNAPSHOT_EVENTS = new Set([
  "phase.entered", "phase.completed", "agent.started", "agent.completed", "agent.failed", "agent.rejected",
  "checkpoint.awaitingApproval", "checkpoint.approved", "proposal.verdict", "ledger.updated", "run.aborted",
  "run.nochanges", "run.completed", "run.failed",
]);