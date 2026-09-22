import {
  FindingsArtifactSchema,
  TestSurveyArtifactSchema,
  type Finding,
  type RiskAssessmentsArtifact,
  type RiskBand,
} from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { decide } from "../runtime/decision-agent.js";

function bandFor(score: number): RiskBand {
  if (score >= 85) return "forbidden";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

/**
 * The pessimist. Scores every finding via TypedDecision (Jev-style calibrated
 * scoring) with deterministic evidence factors blended in: untested paths and
 * churn markers push scores up; tests pull them down. Declares forbidden zones.
 */
export class RiskAssessor implements VibeFixAgent {
  definition = definitionFor("risk-assessor");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("collecting findings to assess");
      const findingsArtifact = await ctx.store.latest("findings");
      const surveyArtifact = await ctx.store.latest("test-survey");
      // Findings come from two diagnosis agents; merge all their artifacts.
      const allFindings: Finding[] = [];
      for (const artifact of await ctx.store.list(undefined, "findings")) {
        try {
          allFindings.push(...FindingsArtifactSchema.parse(artifact.data).findings);
        } catch {
          // skip malformed
        }
      }
      const survey = surveyArtifact
        ? TestSurveyArtifactSchema.parse(surveyArtifact.data)
        : null;

      const untestedDirs = survey?.untestedPaths ?? [];
      const noTests = survey !== null && survey.testFileCount === 0;

      await ctx.progress(`scoring ${allFindings.length} findings`);
      const items = allFindings.map((f) => `${f.findingId}: ${f.title} @ ${f.location}`);
      const answers = await decide(ctx, {
        context:
          "Risk-assess each finding for a refactoring run. Prime directive: behavior preservation. " +
          "High risk = touching this is likely to break behavior or is too entangled to change safely. " +
          "No tests anywhere increases every score by 20.\n\n" +
          `TEST SAFETY NET: ${noTests ? "NO TESTS EXIST" : `${survey?.testFileCount ?? 0} test files`}\n` +
          `UNTESTED AREAS: ${untestedDirs.slice(0, 30).join(", ") || "unknown"}`,
        questions: [
          {
            type: "score",
            question: "Score each finding 0 (trivially safe to fix) to 100 (do not touch)",
            items,
            scale: { min: 0, max: 100 },
            rubric:
              "higher = more files affected, public API/db/auth touched, no test coverage, high fan-in",
          },
        ],
      });
      const llmScores = answers.answers[0]?.kind === "score" ? answers.answers[0].scores : undefined;

      const assessments: RiskAssessmentsArtifact["assessments"] = {};
      const forbiddenZones: string[] = [];
      allFindings.forEach((finding, i) => {
        const llmScore = llmScores?.[i];
        const deterministic = this.deterministicBaseline(finding, noTests, untestedDirs);
        let value = llmScore !== undefined ? Math.round(0.6 * llmScore + 0.4 * deterministic) : deterministic;
        // Mechanical cleanups should almost never be untouchable — LLM pessimism
        // alone must not ban every smell on an untested repo.
        const mechanical =
          finding.recommendedChangeCategory === "extract-function" ||
          finding.recommendedChangeCategory === "deduplicate" ||
          finding.recommendedChangeCategory === "rename" ||
          finding.recommendedChangeCategory === "restyle-consistency" ||
          finding.recommendedChangeCategory === "delete-dead-code";
        if (mechanical && value >= 85) value = 75;
        const band = bandFor(value);
        assessments[finding.findingId] = {
          value,
          band,
          factors: [
            ...(llmScore !== undefined
              ? [{ key: "calibrated-assessment", weight: 0.6, note: `scored ${llmScore}` }]
              : [{ key: "calibrated-assessment", weight: 0, note: "provider unavailable; deterministic only" }]),
            { key: "testCoverage", weight: noTests ? 20 : 0, note: noTests ? "no tests exist" : "tests present" },
          ],
          rationale: `risk ${value}/100 (${band})`,
        };
        finding.risk = assessments[finding.findingId]!;
        if (band === "forbidden") {
          const file = finding.location.split(":")[0] ?? finding.location;
          if (file) forbiddenZones.push(file);
        }
      });

      const artifact = await ctx.store.write({
        kind: "risk-assessments",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: {
          assessments,
          forbiddenZones: [...new Set(forbiddenZones)],
          rationale: answers.degraded
            ? "deterministic baselines (no decision provider available)"
            : "calibrated scores blended with deterministic factors",
        } satisfies RiskAssessmentsArtifact,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }

  private deterministicBaseline(finding: Finding, noTests: boolean, untestedDirs: string[]): number {
    let score = 40;
    const file = finding.location.split(":")[0] ?? "";
    if (noTests) score += 20;
    if (untestedDirs.some((d) => file.startsWith(d))) score += 10;
    if (finding.category === "architecture") score += 15;
    if (finding.recommendedChangeCategory === "delete-dead-code") score -= 10;
    if (finding.recommendedChangeCategory === "deduplicate") score -= 5;
    if (finding.recommendedChangeCategory === "none") score += 10;
    return Math.max(0, Math.min(100, score));
  }
}
