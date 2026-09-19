import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunManager } from "../src/index.js";
import { vibefixExecutorFactory } from "@vibefix/agents";
import { createFixtureRepo } from "@vibefix/fixture-repo";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/**
 * Full end-to-end over a fixture repo with mock providers (zero keys, zero
 * cost): recon pools -> diagnosis -> risk -> synthesis -> checkpoint (auto
 * approve) -> harness -> execution (worktree loop) -> report -> completed.
 */
describe("VibeFix end-to-end (mock providers)", () => {
  it("completes a full run against the small-mess fixture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibefix-e2e-"));
    dirs.push(dir);
    const repoPath = await createFixtureRepo(dir, { profile: "small-mess" });

    const manager = await RunManager.open(repoPath, vibefixExecutorFactory(process.env));
    const { runtime } = await manager.createRun("minimal");

    let approved = false;
    const unsubscribe = runtime.events.subscribe((event) => {
      if (event.type === "checkpoint.awaitingApproval" && !approved) {
        approved = true;
        void runtime.store.latest("backlog").then((artifact) => {
          const proposals = artifact
            ? (artifact.data as { proposals: Array<{ proposalId: string }> }).proposals
            : [];
          void runtime.dispatch({
            type: "CHECKPOINT_APPROVED",
            mode: "minimal",
            approvedProposalIds: proposals.map((p) => p.proposalId),
          });
        });
      }
    });

    await runtime.dispatch({ type: "START" });
    unsubscribe();

    // The auto-approve dispatch runs async inside the subscriber; wait for it.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = runtime.snapshot();
      if (s.status === "completed" || s.status === "failed" || s.status === "aborted") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const finalState = runtime.snapshot();
    expect(finalState.status).toBe("completed");
    expect(finalState.phase).toBe("completed");
    expect(finalState.agentStates["cartographer"]).toBe("passed");
    expect(finalState.agentStates["verifier"]).toMatch(/passed|rejected/);

    // Evidence store has real artifacts
    const backlog = await runtime.store.latest("backlog");
    expect(backlog).not.toBeNull();
    const proposals = (backlog!.data as { proposals: unknown[] }).proposals;
    expect(proposals.length).toBeGreaterThan(0);

    // Ledger + report exist on disk
    const ledgerPath = path.join(repoPath, ".vibefix", "runs", runtime.runId, "ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: unknown[] };
    expect(ledger.entries.length).toBeGreaterThan(0);

    const reportPath = path.join(repoPath, ".vibefix", "runs", runtime.runId, "report.md");
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("What did NOT change");

    // Findings exist and carry evidence
    const findings = await runtime.store.list(undefined, "findings");
    const total = findings.reduce((acc, a) => acc + (a.data as { findings: unknown[] }).findings.length, 0);
    expect(total).toBeGreaterThan(0);
  }, 240_000);

  it("rejections do not leave worktrees behind", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibefix-clean-"));
    dirs.push(dir);
    const repoPath = await createFixtureRepo(dir, { profile: "small-mess" });
    const manager = await RunManager.open(repoPath, vibefixExecutorFactory(process.env));
    const { runtime } = await manager.createRun("minimal");
    await runtime.dispatch({ type: "START" });
    const state = runtime.snapshot();
    const worktreesDir = path.join(repoPath, ".vibefix", "worktrees");
    const leftovers = await import("node:fs").then((fs) =>
      fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir) : [],
    );
    expect(state.status).toMatch(/completed|awaitingApproval|aborted/);
    expect(leftovers.length).toBe(0);
  }, 240_000);
});
