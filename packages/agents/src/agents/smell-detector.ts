import type { FindingsArtifact } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { makeFinding } from "../shared/findings.js";
import { enrich } from "../runtime/text-agent-loop.js";
import { z } from "zod";

const DEDUP_LIMIT = 20;
const LONG_FUNCTION_THRESHOLD = 60;

/**
 * Function/class-level smells from deterministic metrics: duplication
 * clusters, long functions, long files, TODO/FIXME debt. The LLM, when
 * available, refines impact wording — the findings themselves are facts.
 */
export class SmellDetector implements VibeFixAgent {
  definition = definitionFor("smell-detector");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("computing code metrics");
      const { metrics } = ctx.tools;
      const findings: FindingsArtifact["findings"] = [];

      for (const fn of metrics.functions.filter((f) => f.lines >= LONG_FUNCTION_THRESHOLD).slice(0, 15)) {
        findings.push(
          makeFinding({
            title: `Long function: ${fn.name ?? "anonymous"} (${fn.lines} lines, depth ${fn.maxDepth})`,
            location: `${fn.file}:${fn.startLine}`,
            evidence: [
              `function spans ${fn.lines} lines`,
              `max nesting depth ${fn.maxDepth}`,
              `measured by ${fn.analyzer === "ts-ast" ? "TypeScript compiler AST" : "regex heuristic (low confidence)"}`,
            ],
            impact:
              fn.maxDepth >= 5
                ? "High nesting + length make this function hard to test and easy to break silently."
                : "Long functions concentrate multiple responsibilities and are hard to test in isolation.",
            category: "smell",
            recommendedChangeCategory: "extract-function",
            // AST measurements are exact; regex measurements are known to
            // mismeasure braces in strings/comments — trust them less.
            confidence: fn.analyzer === "ts-ast" ? 0.9 : 0.5,
            analyzer: fn.analyzer,
            parserStatus: fn.analyzer === "ts-ast" ? "typescript compiler AST" : "regex fallback",
          }),
        );
      }

      for (const cluster of metrics.duplications.slice(0, DEDUP_LIMIT)) {
        findings.push(
          makeFinding({
            title: `Duplicated block (${cluster.lines} lines x ${cluster.occurrences.length} occurrences)`,
            location: `${cluster.occurrences[0]?.file ?? "?"}:${cluster.occurrences[0]?.startLine ?? 0}`,
            evidence: cluster.occurrences.map((o) => `${o.file}:${o.startLine}`),
            impact: "Copy-pasted logic drifts apart over time; a fix applied to one copy silently misses the others.",
            category: "smell",
            recommendedChangeCategory: "deduplicate",
            analyzer: "duplication-scan",
            parserStatus: "normalized line-window hashing (exact text match)",
          }),
        );
      }

      for (const file of metrics.longFiles.slice(0, 10)) {
        findings.push(
          makeFinding({
            title: `God file: ${file.file} (${file.loc} lines)`,
            location: file.file,
            evidence: [`${file.loc} lines in a single file`],
            impact: "A file this large almost certainly mixes concerns; every change risks unrelated breakage.",
            category: "architecture",
            recommendedChangeCategory: "extract-module",
            analyzer: "line-count",
          }),
        );
      }

      if (metrics.deadCodeCandidates.length > 0) {
        findings.push(
          makeFinding({
            title: `${metrics.deadCodeCandidates.length} TODO/FIXME/HACK markers`,
            location: metrics.deadCodeCandidates[0]?.file ?? "",
            evidence: metrics.deadCodeCandidates
              .slice(0, 10)
              .map((d) => `${d.file}:${d.startLine} ${d.hint}`),
            impact: "Marked debt indicates known fragile areas — worth listing before touching anything.",
            category: "documentation",
            recommendedChangeCategory: "none",
          }),
        );
      }

      // Optional LLM refinement of impact wording (graceful no-op on mock/offline).
      const refined = await enrich(ctx, {
        system: "You refine code-quality finding descriptions. Keep IDs stable. Return the same findings array.",
        prompt: JSON.stringify({ findings: findings.map(({ risk, ...rest }) => rest) },
        ),
        schema: z.object({ findings: z.array(z.object({ findingId: z.string(), impact: z.string(), confidence: z.number().min(0).max(1) })) }),
      });
      if (refined) {
        for (const r of refined.findings) {
          const target = findings.find((f) => f.findingId === r.findingId);
          if (target) {
            target.impact = r.impact;
            target.confidence = r.confidence;
          }
        }
      }

      await ctx.progress(`${findings.length} smell findings`);
      const artifact = await ctx.store.write({
        kind: "findings",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: { findings, notes: ["deterministic metrics scan"] } satisfies FindingsArtifact,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
