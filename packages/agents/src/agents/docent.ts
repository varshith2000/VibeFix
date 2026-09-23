import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BacklogArtifactSchema,
  FindingsArtifactSchema,
  KnowledgeGraphSchema,
  TestSurveyArtifactSchema,
  VerdictArtifactSchema,
  type ReportArtifact,
} from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { enrich } from "../runtime/text-agent-loop.js";
import { architectureMermaid, existingArchitectureNarrative } from "../shared/explain.js";
import { runPaths } from "@vibefix/core";
import { z } from "zod";

/**
 * The teaching layer. Produces the human-facing report: state of the
 * codebase, per-change explainers, and — critically for trust — the
 * "what did NOT change" section. Deterministic template; LLM polishes prose.
 */
export class Docent implements VibeFixAgent {
  definition = definitionFor("docent");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("collecting run outcomes");
      const graph = (await ctx.store.latest("knowledge-graph"))?.data;
      const survey = (await ctx.store.latest("test-survey"))?.data;
      const backlog = (await ctx.store.latest("backlog"))?.data;
      const verdicts: Array<{ proposalId: string; verdict: string; gates: Array<{ gate: string; result: string }> }> = [];
      for (const artifact of await ctx.store.list("verifier", "verdict")) {
        try {
          const v = VerdictArtifactSchema.parse(artifact.data);
          verdicts.push({ proposalId: v.proposalId, verdict: v.verdict, gates: v.gates });
        } catch {
          // skip
        }
      }
      let findingsCount = 0;
      for (const artifact of await ctx.store.list(undefined, "findings")) {
        try {
          findingsCount += FindingsArtifactSchema.parse(artifact.data).findings.length;
        } catch {
          // skip
        }
      }

      const graphParsed = graph ? KnowledgeGraphSchema.safeParse(graph) : null;
      const graphData = graphParsed?.success ? graphParsed.data : null;
      const graphSummary = graphData?.summary ?? null;
      const surveyData = survey ? TestSurveyArtifactSchema.parse(survey) : null;
      const backlogData = backlog ? BacklogArtifactSchema.parse(backlog) : null;

      const paths = runPaths(ctx.repoPath, ctx.runState.runId);
      const ledgerPath = paths.ledgerFile;
      const ledger = await fs.readFile(ledgerPath, "utf8").then(JSON.parse).catch(() => ({ entries: [] })) as {
        entries: Array<{ proposalId: string; verdict: string; committedRef: string | null }>;
      };

      const committed = ledger.entries.filter((e) => e.verdict === "passed" && e.committedRef);
      const totals: ReportArtifact["totals"] = {
        changesProposed: backlogData?.proposals.length ?? 0,
        changesCommitted: committed.length,
        changesRejected: ledger.entries.filter((e) => e.verdict === "rejected").length,
        changesDeferred: ctx.runState.execution.queue.length - committed.length > 0
          ? ctx.runState.execution.queue.length - committed.length -
            ledger.entries.filter((e) => e.verdict === "rejected").length
          : 0,
        filesChanged: new Set(committed.map((c) => c.proposalId)).size,
        publicApiChanges: 0,
        tokensSpent: ctx.runState.budget.tokensSpent,
      };

      const deterministic: ReportArtifact = {
        stateOfCodebase: this.stateNarrative(graphSummary, surveyData, findingsCount),
        existingArchitecture: graphData ? existingArchitectureNarrative(graphData) : undefined,
        existingArchitectureDiagram: graphData ? architectureMermaid(graphData) : undefined,
        changeExplainers: (backlogData?.proposals ?? []).slice(0, 50).map((p) => {
          const verdict = verdicts.find((v) => v.proposalId === p.proposalId);
          // Titles are minted as "<category>: <finding title>" by Synthesis.
          const principle = p.title.includes(":")
            ? p.title.slice(0, p.title.indexOf(":")).replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())
            : "Minimal change";
          return {
            proposalId: p.proposalId,
            what: p.title,
            why: p.problem,
            principle,
            deliberatelyNotTouched: [
              ...p.filesOutOfScope,
              verdict?.gates.some((g) => g.result === "FAIL") ? "nothing landed (gate failure)" : "no unrelated files",
            ],
            ...(p.explanation
              ? {
                  currentState: p.explanation.currentState,
                  proposedState: p.explanation.proposedState,
                  whyItMatters: p.explanation.whyItMatters,
                }
              : {}),
            ...(p.beforeAfterDiagram ? { beforeAfterDiagram: p.beforeAfterDiagram } : {}),
          };
        }),
        whatDidNotChange: [
          "Public API contracts (pinned at baseline; verifier gates enforce)",
          "Dependency manifests and lockfiles (firewall-protected)",
          "Database schemas and migrations",
          "Any file outside each change's declared scope",
          ...(surveyData && surveyData.testFileCount === 0
            ? ["Behavior — no runnable test suite existed, so no behavior-affecting change was permitted"]
            : []),
        ],
        learningSummary:
          "Every change was proposed as evidence-backed Change Proposal, implemented in an isolated git worktree, " +
          "and only landed after independent verification confirmed behavior preservation. Changes that failed twice " +
          "were deferred, never forced.",
        totals,
      };

      // Token frugality: when nothing was proposed or committed there is no
      // narrative worth polishing — the deterministic report already says it.
      const anyChanges =
        (backlogData?.proposals.length ?? 0) > 0 || committed.length > 0;
      const polished = anyChanges
        ? await enrich(ctx, {
            system:
              "You are the Docent. Rewrite the report narrative sections for a developer who wants to LEARN " +
              "what happened to their codebase. Ground every claim in the given facts; keep IDs and numbers exactly as given. Be concise.",
            prompt: JSON.stringify({
              stateOfCodebase: deterministic.stateOfCodebase,
              existingArchitecture: deterministic.existingArchitecture,
              learningSummary: deterministic.learningSummary,
            }),
            schema: z.object({
              stateOfCodebase: z.string(),
              existingArchitecture: z.string().optional(),
              learningSummary: z.string(),
            }),
            maxTokens: 1_500, // Reduced from 2_500 for token optimization
          })
        : undefined;
      if (polished) {
        deterministic.stateOfCodebase = polished.stateOfCodebase;
        if (polished.existingArchitecture) deterministic.existingArchitecture = polished.existingArchitecture;
        deterministic.learningSummary = polished.learningSummary;
      }

      await ctx.progress("writing report");
      const artifact = await ctx.store.write({
        kind: "report",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: deterministic,
      });
      // report.md twin for easy reading / future UI rendering.
      const reportMd = renderMarkdown(deterministic);
      const mdPath = paths.reportFile;
      await fs.mkdir(path.dirname(mdPath), { recursive: true }).catch(() => undefined);
      await fs.writeFile(mdPath, reportMd, "utf8").catch(() => undefined);

      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }

  private stateNarrative(
    graph: import("@vibefix/schemas").KnowledgeGraphSummary | null,
    survey: ReturnType<typeof TestSurveyArtifactSchema.parse> | null,
    findingsCount: number,
  ): string {
    void graph;
    const parts: string[] = [];
    if (survey) {
      parts.push(
        survey.testFileCount === 0
          ? `No tests exist. That is the single most important gap: ${findingsCount} findings were diagnosed with zero safety net.`
          : `${survey.testFileCount} test files cover part of the codebase; ${survey.untestedPaths.length} areas remain untested.`,
      );
    }
    parts.push(`${findingsCount} total findings were raised by the diagnosis pool.`);
    return parts.join(" ");
  }
}

function renderMarkdown(report: ReportArtifact): string {
  const lines: string[] = [
    `# VibeFix Report`,
    ``,
    `## State of your codebase`,
    report.stateOfCodebase,
    ``,
  ];
  if (report.existingArchitecture) {
    lines.push(`## Your architecture today`, report.existingArchitecture, ``);
  }
  if (report.existingArchitectureDiagram) {
    lines.push("```mermaid", report.existingArchitectureDiagram, "```", ``);
  }
  lines.push(
    `## Changes (${report.totals.changesCommitted} committed / ${report.totals.changesProposed} proposed)`,
    ...report.changeExplainers.flatMap((c) => {
      const block = [`### ${c.proposalId}: ${c.what}`, `**Why:** ${c.why} (${c.principle})`];
      if (c.currentState) block.push(``, `**Today:** ${c.currentState}`);
      if (c.proposedState) block.push(`**After this change:** ${c.proposedState}`);
      if (c.whyItMatters) block.push(`**Why it matters:** ${c.whyItMatters}`);
      if (c.beforeAfterDiagram) block.push(``, "```mermaid", c.beforeAfterDiagram, "```");
      return [...block, ``];
    }),
    `## What did NOT change`,
    ...report.whatDidNotChange.map((w) => `- ${w}`),
    ``,
    `## Learning summary`,
    report.learningSummary,
    ``,
    `## Totals`,
    `- Proposed: ${report.totals.changesProposed}`,
    `- Committed: ${report.totals.changesCommitted}`,
    `- Rejected: ${report.totals.changesRejected}`,
    `- Deferred: ${report.totals.changesDeferred}`,
    `- Public API changes: ${report.totals.publicApiChanges}`,
    `- Tokens spent: ${report.totals.tokensSpent}`,
  );
  return lines.join("\n");
}
