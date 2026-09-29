import { promises as fs } from "node:fs";
import path from "node:path";
import { GitTool } from "@vibefix/adapters";
import { globMatchAny } from "@vibefix/core";
import {
  BehavioralBaselineArtifactSchema,
  type BehavioralBaselineArtifact,
  type GateResult,
  type VerdictArtifact,
} from "@vibefix/schemas";
import { passed, rejected, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { decide, isAffirmativeDecision } from "../runtime/decision-agent.js";

/**
 * Fresh-context Behavior Equivalence Verifier. Gates are CODE, not prompts:
 *  (a) firewall-scope: every changed file is inside filesInScope
 *  (b) regression-suite: existing suite result in the worktree matches baseline
 *  (c) public-api-surface: exported symbols unchanged vs the pinned baseline
 * The TypedDecision residual adjudicates only what tests cannot see.
 * This agent never receives the engineer's reasoning — structurally.
 */
export class BehaviorVerifier implements VibeFixAgent {
  definition = definitionFor("verifier");

  async execute(ctx: AgentExecutionContext) {
    if (!ctx.proposal || !ctx.worktree) {
      return rejected("verifier requires a proposal and worktree");
    }
    const { proposal, worktree } = ctx;
    try {
      await ctx.progress("running deterministic gates");
      const gates: GateResult[] = [];

      // (a) firewall-scope
      const git = new GitTool(worktree.path);
      const changed = await git.changedFiles(worktree.path);
      const outOfScope = changed.filter((f) => !globMatchAny(proposal.filesInScope, f.replace(/\\/g, "/")));
      gates.push({
        gate: "firewall-scope",
        result: outOfScope.length === 0 ? "PASS" : "FAIL",
        details:
          outOfScope.length === 0
            ? `${changed.length} changed files all within declared scope`
            : `out-of-scope changes: ${outOfScope.join(", ")}`,
      });

      // (b) regression-suite
      const baselineArtifact = await ctx.store.latest("behavioral-baseline");
      const baseline: BehavioralBaselineArtifact | null = baselineArtifact
        ? BehavioralBaselineArtifactSchema.parse(baselineArtifact.data)
        : null;
      const baselineRun = baseline?.baselineResults as
        | { suiteAvailable: boolean; ok?: boolean; command?: string }
        | undefined;
      if (!baselineRun?.suiteAvailable) {
        gates.push({
          gate: "regression-suite",
          result: "NOT_APPLICABLE",
          details: "no runnable suite at baseline; relying on surface + residual checks",
        });
      } else {
        const run = await ctx.tools.runner.runCommand(worktree.path, baselineRun.command ?? "npm test", 300_000);
        const baselineOk = baselineRun.ok === true;
        gates.push({
          gate: "regression-suite",
          result: run.ok === baselineOk ? "PASS" : "FAIL",
          details:
            run.ok === baselineOk
              ? `suite outcome unchanged (ok=${run.ok})`
              : `suite flipped: baseline ok=${baselineOk}, worktree ok=${run.ok}\n${run.outputTail.slice(-1_500)}`,
        });
      }

      // (c) public-api-surface — compare exports of changed files vs baseline.
      const surfaceDiff = await this.surfaceDrift(ctx, worktree.path, changed, baseline);
      gates.push({
        gate: "public-api-surface",
        result: surfaceDiff.length === 0 ? "PASS" : proposal.constraints.includes("no-public-api-change") ? "FAIL" : "PASS",
        details:
          surfaceDiff.length === 0
            ? "public API surface unchanged"
            : `surface drift: ${surfaceDiff.slice(0, 10).join(", ")}`,
      });

      let residual = "all deterministic gates passed";

      // Residual adjudication is mandatory: unavailable or inconclusive
      // decision capability must never turn a change into a pass.
      if (!gates.some((g) => g.result === "FAIL")) {
        const diff = await git.diffHead(worktree.path);
        const answers = await decide(ctx, {
          context:
            "You are the final behavior-preservation check. You see ONLY the diff, the proposal and the gates — " +
            "never the author's reasoning. Question: is this diff behavior-preserving?\n\n" +
            `PROPOSAL: ${proposal.title} (${proposal.proposalId})\n` +
            `CONSTRAINTS: ${proposal.constraints.join(", ")}\n` +
            `GATES: ${gates.map((g) => `${g.gate}=${g.result}`).join(", ")}\n` +
            `DIFF:\n${diff.slice(0, 12_000)}`,
          questions: [
            {
              type: "choice",
              question: "Is this diff behavior-preserving (no observable behavior change)?",
              choices: ["yes", "no"],
              allowNoul: true,
              rubric:
                "yes = pure structural change (move/rename/extract), identical outputs and side effects; " +
                "no = any observable behavior change, removed fallback, changed ordering, altered API",
            },
          ],
        });
        const answer = answers.answers[0];
        const affirmative = isAffirmativeDecision(answers.degraded, answer);
        gates.push({
          gate: "behavior-preservation-decision",
          result: affirmative ? "PASS" : "FAIL",
          details: affirmative
            ? answer?.kind === "choice" && answer.rationale
              ? answer.rationale
              : "decision provider affirmed behavior preservation"
            : answers.degraded
              ? "decision provider unavailable; verification failed closed"
              : answer?.kind === "choice"
                ? answer.rationale ?? "decision provider rejected behavior preservation"
                : answer?.kind === "noul"
                  ? answer.reason
                  : "decision provider returned no usable answer",
        });
        if (!affirmative) residual = gates[gates.length - 1]!.details;
        else if (answer?.kind === "choice" && answer.rationale) residual = answer.rationale;
        void diff;
      }

      const hardFail = gates.some((g) => g.result === "FAIL");
      const verdict: VerdictArtifact["verdict"] = hardFail ? "rejected" : "passed";

      const artifactData: VerdictArtifact = {
        proposalId: proposal.proposalId,
        attempt: ctx.attempt ?? 0,
        verdict,
        gates,
        residualRationale: residual,
        rejectionReasons: gates.filter((g) => g.result === "FAIL").map((g) => `${g.gate}: ${g.details}`),
      };
      const artifact = await ctx.store.write({
        kind: "verdict",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: artifactData,
      });
      await ctx.progress(`verdict: ${verdict}`);
      if (verdict === "rejected") {
        return rejected(gates.find((g) => g.result === "FAIL")?.details ?? residual);
      }
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }

  private async surfaceDrift(
    ctx: AgentExecutionContext,
    worktreePath: string,
    changed: string[],
    baseline: BehavioralBaselineArtifact | null,
  ): Promise<string[]> {
    if (!baseline) return [];
    const EXPORT_PATTERNS = [
      /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
    ];
    const baselineSet = new Set(baseline.publicApiSurface);
    const drift: string[] = [];
    for (const file of changed) {
      let content: string;
      try {
        content = await fs.readFile(path.join(worktreePath, ...file.split("/")), "utf8");
      } catch {
        continue; // deleted file: surface removal detected by baseline diff below
      }
      for (const pattern of EXPORT_PATTERNS) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(content)) !== null) {
          const symbol = `${file.replace(/\\/g, "/")}::${m[1]}`;
          if (!baselineSet.has(symbol)) drift.push(`+${symbol}`);
        }
      }
    }
    // Removed symbols: any baseline symbol in a changed file that vanished.
    const changedSet = new Set(changed.map((c) => c.replace(/\\/g, "/")));
    for (const symbol of baselineSet) {
      const file = symbol.split("::")[0] ?? "";
      if (changedSet.has(file)) {
        let content: string;
        try {
          content = await fs.readFile(path.join(worktreePath, ...file.split("/")), "utf8");
        } catch {
          drift.push(`-${symbol}`);
          continue;
        }
        const name = symbol.split("::")[1] ?? "";
        if (!content.includes(name)) drift.push(`-${symbol}`);
      }
    }
    void ctx;
    return [...new Set(drift)];
  }
}
