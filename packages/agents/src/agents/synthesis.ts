import {
  FindingsArtifactSchema,
  RiskAssessmentsArtifactSchema,
  type BacklogArtifact,
  type ChangeProposal,
  type Constraint,
  type Finding,
  type FindingsArtifact,
  type RefactoringMode,
} from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { decide } from "../runtime/decision-agent.js";
import { categoryExplanation, beforeAfterMermaid } from "../shared/explain.js";

const SCOPE_TEMPLATES: Record<string, (f: Finding) => string[]> = {
  "extract-function": (f) => [fileOf(f)],
  "extract-module": (f) => [fileOf(f), `${dirOf(f)}/**`],
  "extract-service": (f) => [fileOf(f), `${dirOf(f)}/**`],
  "rename": (f) => [fileOf(f)],
  "move-code": (f) => [fileOf(f), `${dirOf(f)}/**`],
  "delete-dead-code": (f) => [fileOf(f)],
  "deduplicate": (f) => unique(f.evidence.map((loc) => loc.split(":")[0] ?? "")).filter(Boolean),
  "introduce-boundary": (f) => [fileOf(f), `${dirOf(f)}/**`],
  "add-tests": (f) => [`${dirOf(f) || "."}/**`],
  "restyle-consistency": (f) => [fileOf(f)],
  "none": (f) => [fileOf(f)],
};

function fileOf(f: Finding): string {
  return f.location.split(":")[0] ?? f.location;
}
function dirOf(f: Finding): string {
  const file = fileOf(f);
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
}
function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Chief Diagnostician. The merge/dedupe is deterministic code; TypedDecision
 * ranks the resulting proposals (impact ÷ risk). Produces the backlog the
 * user approves at the checkpoint.
 */
export class Synthesis implements VibeFixAgent {
  definition = definitionFor("synthesis");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("merging diagnosis findings");
      const findings: Finding[] = [];
      for (const artifact of await ctx.store.list(undefined, "findings")) {
        try {
          findings.push(...FindingsArtifactSchema.parse(artifact.data).findings);
        } catch {
          // skip malformed
        }
      }
      const riskArtifact = await ctx.store.latest("risk-assessments");
      const risks = riskArtifact ? RiskAssessmentsArtifactSchema.parse(riskArtifact.data).assessments : {};

      // Dedupe: same category + same file = one finding (keep highest evidence count).
      const byKey = new Map<string, Finding>();
      for (const f of findings) {
        const key = `${f.category}::${f.recommendedChangeCategory}::${fileOf(f)}`;
        const existing = byKey.get(key);
        if (!existing || f.evidence.length > existing.evidence.length) byKey.set(key, f);
      }
      const merged = [...byKey.values()];

      // Drop do-not-touch findings into unaddressed.
      const proposals: ChangeProposal[] = [];
      const unaddressed: BacklogArtifact["unaddressedFindings"] = [];
      merged.forEach((f, i) => {
        const risk = risks[f.findingId] ?? f.risk;
        f.risk = risk;
        if (risk.band === "forbidden" || f.recommendedChangeCategory === "none") {
          unaddressed.push({
            findingId: f.findingId,
            reason: f.recommendedChangeCategory === "none"
              ? "informational finding; no safe mechanical change maps to it"
              : `risk band 'forbidden' (${risk.value}/100)`,
          });
          return;
        }
        const scopeTemplate = SCOPE_TEMPLATES[f.recommendedChangeCategory] ?? SCOPE_TEMPLATES["none"]!;
        const scope = unique(scopeTemplate(f)).filter((s) => s.length > 0);
        const explanation = categoryExplanation(f);
        const diagram = beforeAfterMermaid(f, scope.length > 0 ? scope : [fileOf(f)]);
        const constraints: Constraint[] = ["no-public-api-change", "no-dependency-changes", "no-behavior-change"];
        const architectural =
          f.recommendedChangeCategory === "extract-service" ||
          f.recommendedChangeCategory === "introduce-boundary" ||
          f.recommendedChangeCategory === "extract-module" ||
          f.category === "architecture";
        const mechanical =
          f.recommendedChangeCategory === "extract-function" ||
          f.recommendedChangeCategory === "deduplicate" ||
          f.recommendedChangeCategory === "rename" ||
          f.recommendedChangeCategory === "delete-dead-code" ||
          f.recommendedChangeCategory === "restyle-consistency";
        let modes: RefactoringMode[];
        // Forbidden findings are already deferred above; remaining bands are low|medium|high.
        if (risk.band === "high") {
          modes = ["architecture", "modernization"];
        } else if (architectural && risk.band === "medium") {
          modes = ["architecture", "modernization"];
        } else if (mechanical && risk.band === "low") {
          modes = ["minimal", "architecture", "modernization"];
          constraints.push("minimal-diff", "no-new-abstractions");
        } else if (mechanical) {
          modes = ["minimal", "architecture", "modernization"];
          constraints.push("minimal-diff");
        } else {
          modes = ["minimal", "architecture", "modernization"];
        }
        if (f.category === "security") {
          // Security findings stay informational unless modernization mode.
          modes = ["modernization"];
        }
        proposals.push({
          proposalId: `RFC-${String(i + 1).padStart(3, "0")}`,
          title: `${f.recommendedChangeCategory.replace(/-/g, " ")}: ${f.title}`.slice(0, 120),
          problem: f.impact,
          evidence: [f.findingId],
          filesInScope: scope.length > 0 ? scope : [fileOf(f)],
          filesOutOfScope: ["**/*.lock", "package.json"],
          risk,
          expectedBenefit: [`resolves ${f.findingId} (${f.category})`],
          constraints,
          minimalChange: true,
          testsRequired: [],
          rollbackStrategy: { type: "discardWorktree" },
          approvalStatus: "pending",
          priority: 0,
          allowedInModes: modes,
          explanation,
          ...(diagram ? { beforeAfterDiagram: diagram } : {}),
        });
        f.proposedChangeId = `RFC-${String(i + 1).padStart(3, "0")}`;
      });

      await ctx.progress(`ranking ${proposals.length} proposals`);
      if (proposals.length > 0) {
        const answers = await decide(ctx, {
          context:
            "Rank refactoring proposals by benefit ÷ risk for a behavior-preserving run. " +
            "Low-risk mechanical wins (dedupe, extract) rank HIGH; risky architectural moves rank LOW.\n\n" +
            proposals
              .map((p) => `${p.proposalId}: ${p.title} | risk ${p.risk.value}/100 (${p.risk.band})`)
              .join("\n"),
          questions: [
            {
              type: "score",
              question: "Score each proposal 0-100 on priority (higher = should run first)",
              items: proposals.map((p) => p.proposalId),
              scale: { min: 0, max: 100 },
              rubric: "benefit ÷ risk, favoring small safe diffs over ambitious restructuring",
            },
          ],
        });
        const scores = answers.answers[0]?.kind === "score" ? answers.answers[0].scores : undefined;
        proposals.forEach((p, i) => {
          const fallbackPriority = (100 - p.risk.value) / 100;
          p.priority = scores?.[i] !== undefined ? scores[i]! / 100 : fallbackPriority;
        });
        proposals.sort((a, b) => b.priority - a.priority);
      }

      // Rewrite evidence findings with proposedChangeId links + assessed risks.
      await ctx.store.write({
        kind: "findings",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: { findings: merged, notes: ["synthesis-merged"] } satisfies FindingsArtifact,
      });

      const artifact = await ctx.store.write({
        kind: "backlog",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: { proposals, unaddressedFindings: unaddressed } satisfies BacklogArtifact,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
