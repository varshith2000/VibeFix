#!/usr/bin/env node
import { RunManager, WorktreeManager } from "@vibefix/core";
import { vibefixExecutorFactory } from "@vibefix/agents";
import { loadEnvFile } from "@vibefix/server";
import type { RefactoringMode } from "@vibefix/schemas";

loadEnvFile(); // keys from .env at the workspace root, if present

const HELP = `vibefix — multi-agent refactoring control plane

Usage:
  vibefix serve [port]              Start the control-plane server (default 8630)
  vibefix run <repoPath> [--mode minimal|architecture|modernization] [--yes]
                                     Headless run; --yes auto-approves the backlog
  vibefix clean <repoPath>          Remove stale vibefix worktrees in a repo
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "serve": {
      process.env.VIBEFIX_PORT = String(Number(rest[0] ?? process.env.VIBEFIX_PORT ?? 8630));
      const { serveMain } = await import("@vibefix/server");
      void serveMain();
      return;
    }
    case "run": {
      const repoPath = rest[0];
      if (!repoPath) {
        console.error("repoPath required");
        process.exit(1);
      }
      const modeIdx = rest.indexOf("--mode");
      const mode = (modeIdx !== -1 ? rest[modeIdx + 1] : "minimal") as RefactoringMode;
      const autoApprove = rest.includes("--yes");
      await headlessRun(repoPath, mode, autoApprove);
      return;
    }
    case "clean": {
      const repoPath = rest[0];
      if (!repoPath) {
        console.error("repoPath required");
        process.exit(1);
      }
      await new WorktreeManager(repoPath).cleanupAll();
      console.log("worktrees cleaned");
      return;
    }
    default:
      console.log(HELP);
      process.exit(command ? 1 : 0);
  }
}

async function headlessRun(repoPath: string, mode: RefactoringMode, autoApprove: boolean): Promise<void> {
  const manager = await RunManager.open(repoPath, vibefixExecutorFactory(process.env));
  const { runtime } = await manager.createRun(mode);
  const unsubscribe = runtime.events.subscribe((event) => {
    console.log(`[${event.type}]${event.agentId ? ` ${event.agentId}` : ""}${event.message ? ` — ${event.message}` : ""}`);
    if (event.type === "checkpoint.awaitingApproval" && autoApprove) {
      void runtime.store.latest("backlog").then((artifact) => {
        const proposals = artifact ? (artifact.data as { proposals: Array<{ proposalId: string }> }).proposals : [];
        void runtime.dispatch({
          type: "CHECKPOINT_APPROVED",
          mode,
          approvedProposalIds: proposals.map((p) => p.proposalId),
        });
      });
    }
  });
  try {
    await runtime.dispatch({ type: "START" });
    if (!autoApprove && runtime.snapshot().status === "awaitingApproval") {
      console.log("\nRun paused at the checkpoint. Approve via the UI (vibefix serve) and POST /api/runs/:id/approve.");
    }
  } finally {
    unsubscribe();
  }
}

void main();
