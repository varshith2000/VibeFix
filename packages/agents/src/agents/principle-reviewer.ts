import { GitTool } from "@vibefix/adapters";
import { globMatchAny } from "@vibefix/core";
import type { GateResult, VerdictArtifact } from "@vibefix/schemas";
import { passed, rejected, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { decide } from "../runtime/decision-agent.js";

/**
 * Principle Compliance Reviewer — fresh-context devil's advocate.
 * Does this diff actually follow the stated principle? Is it minimal?
 * Never sees the engineer's rationale.
 */
export class PrincipleReviewer implements VibeFixAgent {
  definition = definitionFor("principle-reviewer");

  async execute(ctx: AgentExecutionContext) {
    if (!ctx.proposal || !ctx.worktree) {
      return rejected("principle-reviewer requires a proposal and worktree");
    }
    const { proposal, worktree } = ctx;
    try {
      await ctx.progress("reviewing principle compliance");
      const git = new GitTool(worktree.path);
      const diff = await git.diffHead(worktree.path);
      const changed = await git.changedFiles(worktree.path);
      const gates: GateResult[] = [];

      // Deterministic: no drive-by files outside scope (reinforces firewall).
      const outOfScope = changed.filter((f) => !globMatchAny(proposal.filesInScope, f.replace(/\\/g, "/")));
      gates.push({
        gate: "firewall-scope",
        result: outOfScope.length === 0 ? "PASS" : "FAIL",
        details: outOfScope.length === 0 ? "scope respected" : `drive-by files: ${outOfScope.join(", ")}`,
      });

      // Deterministic: diff size budget for minimal-diff constraint.
      const lines = diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length;
      const tooLarge = proposal.constraints.includes("minimal-diff") && lines > 400;
      gates.push({
        gate: "principle-compliance",
        result: tooLarge ? "FAIL" : "PASS",
        details: tooLarge
          ? `diff touches ~${lines} lines — exceeds minimal-diff budget`
          : `diff size ~${lines} lines within minimality budget`,
      });

      let verdict: VerdictArtifact["verdict"] = gates.some((g) => g.result === "FAIL") ? "rejected" : "passed";
      let residual = "principle checks passed";

      if (verdict === "passed" && ctx.decision) {
        const answers = await decide(ctx, {
          context:
            "You are an independent Principle Compliance Reviewer. You did NOT write this change.\n" +
            "Ask: does the diff match the proposal? Is it minimal? Does it invent unnecessary abstractions?\n\n" +
            `PROPOSAL: ${proposal.title}\nPROBLEM: ${proposal.problem}\n` +
            `CONSTRAINTS: ${proposal.constraints.join(", ")}\n` +
            `EXPECTED BENEFIT: ${proposal.expectedBenefit.join("; ")}\n` +
            `DIFF:\n${diff.slice(0, 10_000)}`,
          questions: [
            {
              type: "choice",
              question: "Does this diff comply with the stated principle and stay minimal?",
              choices: ["yes", "no"],
              allowNoul: true,
              rubric:
                "yes = matches proposal, no scope creep, no new unnecessary abstractions; " +
                "no = drive-by edits, redesign, or principle mismatch",
            },
          ],
        });
        const answer = answers.answers[0];
        if (answer?.kind === "choice" && answer.choice === "no") {
          verdict = "rejected";
          residual = answer.rationale ?? "principle reviewer veto";
        } else if (answer?.kind === "choice") {
          residual = answer.rationale ?? residual;
        }
      }

      const artifact = await ctx.store.write({
        kind: "verdict",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: {
          proposalId: proposal.proposalId,
          attempt: ctx.attempt ?? 0,
          verdict,
          gates,
          residualRationale: residual,
          rejectionReasons: gates.filter((g) => g.result === "FAIL").map((g) => `${g.gate}: ${g.details}`),
        } satisfies VerdictArtifact,
      });
      if (verdict === "rejected") {
        return rejected(residual);
      }
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
