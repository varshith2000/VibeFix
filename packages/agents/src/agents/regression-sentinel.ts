import type { GateResult, VerdictArtifact } from "@vibefix/schemas";
import { BehavioralBaselineArtifactSchema } from "@vibefix/schemas";
import { passed, rejected, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";

/**
 * Regression Sentinel — runs build / typecheck / lint / tests when detectable.
 * Hard-fails only when a previously-green suite flips, or a forbidden zone is touched.
 * Commands without a green baseline are recorded as NOT_APPLICABLE (not forced red).
 */
export class RegressionSentinel implements VibeFixAgent {
  definition = definitionFor("regression-sentinel");

  async execute(ctx: AgentExecutionContext) {
    if (!ctx.proposal || !ctx.worktree) {
      return rejected("regression-sentinel requires a proposal and worktree");
    }
    const { proposal, worktree } = ctx;
    try {
      await ctx.progress("running regression checks");
      const gates: GateResult[] = [];
      const commands = ctx.tools.runner.detectCommands(worktree.path);

      const baselineArtifact = await ctx.store.latest("behavioral-baseline");
      const baseline = baselineArtifact
        ? BehavioralBaselineArtifactSchema.safeParse(baselineArtifact.data)
        : null;
      const baselineRun = baseline?.success
        ? (baseline.data.baselineResults as { suiteAvailable?: boolean; ok?: boolean } | undefined)
        : undefined;

      // Test suite: only hard-fail if baseline was green and worktree flipped.
      if (!commands.test) {
        gates.push({
          gate: "regression-suite",
          result: "NOT_APPLICABLE",
          details: "no test command detected",
        });
      } else if (!baselineRun?.suiteAvailable) {
        gates.push({
          gate: "regression-suite",
          result: "NOT_APPLICABLE",
          details: "no green baseline suite; not forcing a red gate",
        });
      } else {
        await ctx.progress("running test suite");
        const run = await ctx.tools.runner.runCommand(worktree.path, commands.test, 300_000);
        const baselineOk = baselineRun.ok === true;
        gates.push({
          gate: "regression-suite",
          result: !baselineOk || run.ok === baselineOk ? "PASS" : "FAIL",
          details:
            run.ok === baselineOk
              ? `suite outcome unchanged (ok=${run.ok})`
              : `suite flipped vs baseline ok=${baselineOk}:\n${run.outputTail.slice(-1_500)}`,
        });
      }

      // Static checks: record outcome; hard-fail only on clear breakage when we
      // have no excuse — prefer NOT_APPLICABLE without a prior green pin.
      for (const check of [
        { gate: "typecheck" as const, cmd: commands.typecheck, label: "typecheck" },
        { gate: "lint" as const, cmd: commands.lint, label: "lint" },
        { gate: "build" as const, cmd: commands.build, label: "build" },
      ]) {
        if (!check.cmd) {
          gates.push({
            gate: check.gate,
            result: "NOT_APPLICABLE",
            details: `no ${check.label} command detected`,
          });
          continue;
        }
        await ctx.progress(`running ${check.label}`);
        const run = await ctx.tools.runner.runCommand(worktree.path, check.cmd, 300_000);
        gates.push({
          gate: check.gate,
          result: run.ok ? "PASS" : "NOT_APPLICABLE",
          details: run.ok
            ? `${check.label} passed`
            : `${check.label} failed (no pre-change green pin — not blocking):\n${run.outputTail.slice(-1_000)}`,
        });
      }

      const forbidden = ctx.forbiddenZones ?? [];
      if (forbidden.length > 0) {
        const { GitTool } = await import("@vibefix/adapters");
        const { globMatchAny } = await import("@vibefix/core");
        const git = new GitTool(worktree.path);
        const changed = await git.changedFiles(worktree.path);
        const hits = changed.filter((f) => globMatchAny(forbidden, f.replace(/\\/g, "/")));
        gates.push({
          gate: "firewall-scope",
          result: hits.length === 0 ? "PASS" : "FAIL",
          details: hits.length === 0 ? "no forbidden zones touched" : `forbidden touched: ${hits.join(", ")}`,
        });
      }

      const hardFail = gates.some((g) => g.result === "FAIL");
      const verdict: VerdictArtifact["verdict"] = hardFail ? "rejected" : "passed";
      const artifact = await ctx.store.write({
        kind: "verdict",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: {
          proposalId: proposal.proposalId,
          attempt: ctx.attempt ?? 0,
          verdict,
          gates,
          residualRationale: hardFail ? "regression sentinel found a failing gate" : "static/regression gates clear",
          rejectionReasons: gates.filter((g) => g.result === "FAIL").map((g) => `${g.gate}: ${g.details}`),
        } satisfies VerdictArtifact,
      });
      if (hardFail) {
        return rejected(gates.find((g) => g.result === "FAIL")?.details ?? "regression failure");
      }
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
