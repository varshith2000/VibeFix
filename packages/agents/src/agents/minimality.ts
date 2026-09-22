import {
  BacklogArtifactSchema,
  ProductIntentSchema,
  type BacklogArtifact,
  type ChangeProposal,
} from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { decide } from "../runtime/decision-agent.js";

/**
 * Minimality Agent — anti-overengineering gate. Challenges every proposal:
 * fewer files? fewer lines? without API/dependency changes? Reject or shrink
 * scope before the user checkpoint.
 */
export class MinimalityAgent implements VibeFixAgent {
  definition = definitionFor("minimality");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("challenging backlog for overengineering");
      const backlogArt = await ctx.store.latest("backlog");
      if (!backlogArt) return failed(new Error("no backlog to review"));
      const backlog = BacklogArtifactSchema.parse(backlogArt.data);

      const intentArt = await ctx.store.latest("product-intent");
      const intent = intentArt ? ProductIntentSchema.safeParse(intentArt.data) : null;
      const constraints = intent?.success ? intent.data.intentConstraints : [];

      const kept: ChangeProposal[] = [];
      const deferred: BacklogArtifact["unaddressedFindings"] = [...backlog.unaddressedFindings];

      for (const p of backlog.proposals) {
        // Deterministic minimality rules first.
        const scopeTooWide = p.filesInScope.some((g) => g.endsWith("/**") && !g.includes("/"));
        const manyGlobs = p.filesInScope.length > 8;
        const highRiskAmbitious =
          p.risk.band === "high" &&
          (p.title.includes("extract service") || p.title.includes("introduce boundary"));

        if (scopeTooWide || manyGlobs) {
          // Shrink scope to first 3 concrete globs when possible.
          const shrunk = {
            ...p,
            filesInScope: p.filesInScope.slice(0, 3),
            constraints: uniqueConstraints([...p.constraints, "minimal-diff", "no-new-abstractions"]),
            minimalChange: true,
            expectedBenefit: [...p.expectedBenefit, "scope shrunk by Minimality Agent"],
          };
          kept.push(shrunk);
          continue;
        }

        if (highRiskAmbitious && ctx.runState.mode === "minimal") {
          deferred.push({
            findingId: p.evidence[0] ?? p.proposalId,
            reason: "Minimality: high-risk architectural change deferred in minimal mode",
          });
          continue;
        }

        kept.push({
          ...p,
          constraints: uniqueConstraints([...p.constraints, "minimal-diff"]),
        });
      }

      // Optional LLM challenge for remaining proposals — binary keep/defer.
      if (ctx.decision && kept.length > 0) {
        const answers = await decide(ctx, {
          context:
            "You are the Minimality Agent. Reject proposals that over-engineer. " +
            "Prefer extract-function over new service layers when call sites are few.\n\n" +
            `INTENT CONSTRAINTS:\n${constraints.join("\n")}\n\n` +
            kept.map((p) => `${p.proposalId}: ${p.title} | scope=${p.filesInScope.join(",")} | risk=${p.risk.band}`).join("\n"),
          questions: [
            {
              type: "choice",
              question: "Should the backlog keep these proposals (yes) or defer the most ambitious one (no)?",
              choices: ["yes", "no"],
              allowNoul: true,
              rubric: "yes = keep all; no = defer the highest-risk proposal as over-engineered",
            },
          ],
        });
        const answer = answers.answers[0];
        if (answer?.kind === "choice" && answer.choice === "no" && kept.length > 1) {
          // Defer the highest-risk proposal only.
          kept.sort((a, b) => a.risk.value - b.risk.value);
          const removed = kept.pop();
          if (removed) {
            deferred.push({
              findingId: removed.evidence[0] ?? removed.proposalId,
              reason: `Minimality deferred: ${answer.rationale ?? "over-engineered relative to call-site count"}`,
            });
          }
        }
      }

      // Never wipe a non-empty backlog — if every proposal was deferred, keep
      // the lowest-risk original so the checkpoint still has something to show.
      if (kept.length === 0 && backlog.proposals.length > 0) {
        const rescue = [...backlog.proposals].sort((a, b) => a.risk.value - b.risk.value)[0]!;
        kept.push({
          ...rescue,
          constraints: uniqueConstraints([...rescue.constraints, "minimal-diff"]),
          expectedBenefit: [...rescue.expectedBenefit, "rescued by Minimality (empty-backlog guard)"],
        });
      }

      const artifact = await ctx.store.write({
        kind: "backlog",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: {
          proposals: kept,
          unaddressedFindings: deferred,
          notes: ["minimality-reviewed", `kept ${kept.length}, deferred extras into unaddressed`],
        } satisfies BacklogArtifact,
      });
      await ctx.progress(`minimality: ${kept.length} proposals remain`);
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}

function uniqueConstraints<T extends string>(arr: T[]): T[] {
  return [...new Set(arr)];
}
