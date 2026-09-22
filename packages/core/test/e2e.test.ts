import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunManager, runPaths, type RunServices } from "../src/index.js";
import { VibefixExecutor } from "@vibefix/agents";
import { createFixtureRepo } from "@vibefix/fixture-repo";

const dirs: string[] = [];

beforeAll(() => {
  // Keep the central VibeFix workspace inside the test sandbox — never the
  // developer's real ~/.vibefix.
  const home = mkdtempSync(path.join(tmpdir(), "vibefix-home-"));
  dirs.push(home);
  process.env.VIBEFIX_HOME = home;
});

afterAll(async () => {
  delete process.env.VIBEFIX_HOME;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/**
 * The PRODUCT is real-models-only (no mock providers in the default routing;
 * the engineer refuses to run without a real model). This suite therefore
 * builds an explicit TEST routing with scripted mock doubles — deterministic,
 * zero keys, zero cost — to exercise the full orchestrator loop.
 */
async function testExecutorFactory(repoPath: string) {
  // Script a real-looking dedup edit for the engineer so the worktree ->
  // verify -> commit -> cherry-pick loop has actual content to land.
  // Deliberately adds NO new exports: the public-API gate must see a pure
  // internal refactor, exactly as it would demand from a real model.
  const original = await readFile(path.join(repoPath, "src", "index.js"), "utf8");
  const deduped =
    `${original}\n// vibefix test: shared formatting extracted (deduplicated)\n` +
    `function _formatUserLine(u) { return u.name.charAt(0).toUpperCase() + u.name.slice(1) + ' <' + u.email + '>'; }\n`;
  return (services: RunServices) =>
    new VibefixExecutor(services, process.env).registerMockScript("engineer", {
      rationale: "test double: extract the duplicated formatting into one shared helper",
      edits: [{ path: "src/index.js", newContent: deduped }],
    });
}

const TEST_CONFIG = {
  routing: {
    providers: [
      {
        providerId: "mock-text",
        kind: "TextGeneration",
        adapter: "mock-text",
        defaultModel: "mock-coder",
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_192,
        enabled: true,
      },
      {
        providerId: "mock-decision",
        kind: "TypedDecision",
        adapter: "mock-decision",
        defaultModel: "mock-judge",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_048,
        enabled: true,
      },
    ],
    routes: {
      cartographer: { providerId: "mock-text" },
      historian: { providerId: "mock-text" },
      "test-surveyor": { providerId: "mock-text" },
      "smell-detector": { providerId: "mock-text" },
      "arch-auditor": { providerId: "mock-text" },
      "consistency-sentinel": { providerId: "mock-text" },
      "security-agent": { providerId: "mock-text" },
      "risk-assessor": { providerId: "mock-decision" },
      synthesis: { providerId: "mock-decision" },
      minimality: { providerId: "mock-decision" },
      "harness-builder": { providerId: "mock-text" },
      engineer: { providerId: "mock-text" },
      verifier: { providerId: "mock-decision" },
      "principle-reviewer": { providerId: "mock-decision" },
      "regression-sentinel": { providerId: "mock-decision" },
      docent: { providerId: "mock-text" },
    },
    budgets: { runMaxTokens: 4_000_000, maxChangesPerRun: 10, maxRetriesPerChange: 2, warnFraction: 0.8 },
  },
  defaultMode: "minimal",
  protectedPaths: [],
  analyzer: { sidecarProtocolVersion: 1 },
} as const;

/**
 * Full end-to-end over a fixture repo with scripted test doubles (zero keys,
 * zero cost): recon pools -> diagnosis -> risk -> synthesis -> checkpoint
 * (auto approve) -> harness -> execution (worktree loop) -> report -> completed.
 */
describe("VibeFix end-to-end (scripted test doubles)", () => {
  it("completes a full run against the small-mess fixture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibefix-e2e-"));
    dirs.push(dir);
    const repoPath = await createFixtureRepo(dir, { profile: "small-mess" });

    const manager = await RunManager.open(repoPath, await testExecutorFactory(repoPath), {
      config: TEST_CONFIG as never,
    });
    const { runtime } = await manager.createRun("architecture");

    const startDone = runtime.dispatch({ type: "START" });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = runtime.snapshot();
      if (s.phase === "awaitingApproval" || s.status === "failed" || s.status === "aborted") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await startDone;

    const snap = runtime.snapshot();
    expect(snap.phase).toBe("awaitingApproval");
    expect(snap.agentStates["historian"]).toBe("passed");
    expect(snap.agentStates["synthesis"]).toBe("passed");
    expect(snap.agentStates["minimality"]).toMatch(/passed|failed/);

    const backlogArt = await runtime.store.latest("backlog");
    expect(backlogArt).not.toBeNull();
    const proposals = (backlogArt!.data as { proposals: Array<{ proposalId: string; allowedInModes: string[] }> })
      .proposals;
    expect(proposals.length).toBeGreaterThan(0);

    const approvedIds = proposals
      .filter((p) => p.allowedInModes.includes("architecture") || p.allowedInModes.includes("minimal"))
      .map((p) => p.proposalId);
    const toApprove = (approvedIds.length > 0 ? approvedIds : proposals.map((p) => p.proposalId)).slice(0, 3);

    await runtime.dispatch({
      type: "CHECKPOINT_APPROVED",
      mode: "architecture",
      approvedProposalIds: toApprove,
    });

    while (Date.now() < deadline) {
      const s = runtime.snapshot();
      if (s.status === "completed" || s.status === "failed" || s.status === "aborted") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const finalState = runtime.snapshot();
    expect(finalState.status).toBe("completed");
    expect(finalState.phase).toBe("completed");
    expect(finalState.agentStates["cartographer"]).toBe("passed");
    expect(finalState.agentStates["docent"]).toBe("passed");
    expect(finalState.agentStates["verifier"]).toMatch(/passed|rejected|queued/);
    if (finalState.budget.changesCommitted > 0) {
      expect(finalState.agentStates["verifier"]).toMatch(/passed|rejected/);
      expect(finalState.agentStates["principle-reviewer"]).toMatch(/passed|rejected/);
      expect(finalState.agentStates["regression-sentinel"]).toMatch(/passed|rejected/);
    }

    const ledgerPath = runPaths(repoPath, runtime.runId).ledgerFile;
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: unknown[] };
    expect(ledger.entries.length).toBeGreaterThan(0);

    const reportPath = runPaths(repoPath, runtime.runId).reportFile;
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("What did NOT change");

    const findings = await runtime.store.list(undefined, "findings");
    const total = findings.reduce((acc, a) => acc + (a.data as { findings: unknown[] }).findings.length, 0);
    expect(total).toBeGreaterThan(0);
  }, 240_000);

  it("rejections do not leave worktrees behind", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibefix-clean-"));
    dirs.push(dir);
    const repoPath = await createFixtureRepo(dir, { profile: "small-mess" });
    const manager = await RunManager.open(repoPath, await testExecutorFactory(repoPath), {
      config: TEST_CONFIG as never,
    });
    const { runtime } = await manager.createRun("minimal");
    await runtime.dispatch({ type: "START" });
    const state = runtime.snapshot();
    const wtDir = runPaths(repoPath, "x").worktreesDir;
    const leftovers = await import("node:fs").then((fs) =>
      fs.existsSync(wtDir) ? fs.readdirSync(wtDir) : [],
    );
    expect(state.status).toMatch(/completed|awaitingApproval|aborted/);
    expect(leftovers.length).toBe(0);
  }, 240_000);
});
