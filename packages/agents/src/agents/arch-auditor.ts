import type { FindingsArtifact } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { makeFinding } from "../shared/findings.js";
import { enrich } from "../runtime/text-agent-loop.js";
import { z } from "zod";

/** DFS cycle detection over the resolved import graph. */
function findCycles(edges: Array<{ from: string; to: string }>): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();

  function dfs(node: string, stack: string[]): void {
    if (cycles.length >= 10) return;
    const status = state.get(node);
    if (status === "done") return;
    if (status === "visiting") {
      const start = stack.indexOf(node);
      if (start !== -1) cycles.push([...stack.slice(start), node]);
      return;
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) dfs(next, stack);
    stack.pop();
    state.set(node, "done");
  }

  for (const node of adjacency.keys()) dfs(node, []);
  return cycles;
}

/**
 * High-level architecture violations from the import graph: circular
 * dependencies, god modules (fan-in/fan-out extremes), UI-reaching-into-data
 * heuristics. Deterministic; every finding cites graph evidence.
 */
export class ArchitectureAuditor implements VibeFixAgent {
  definition = definitionFor("arch-auditor");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("analyzing dependency structure");
      const edges = ctx.tools.importEdges.filter((e) => e.resolved);
      const findings: FindingsArtifact["findings"] = [];

      const cycles = findCycles(edges.map((e) => ({ from: e.from, to: e.to })));
      for (const cycle of cycles) {
        findings.push(
          makeFinding({
            title: `Circular dependency (${cycle.length - 1} modules)`,
            location: cycle[0] ?? "",
            evidence: cycle.map((f, i) => (i === 0 ? f : `  -> imports ${f}`)),
            impact: "Circular modules cannot be loaded, tested or reasoned about in isolation; changes propagate unpredictably.",
            category: "architecture",
            recommendedChangeCategory: "introduce-boundary",
          }),
        );
      }

      // Fan-in / fan-out god modules.
      const fanIn = new Map<string, number>();
      const fanOut = new Map<string, number>();
      for (const e of edges) {
        fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
        fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
      }
      for (const [file, count] of [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        if (count < 6) continue;
        findings.push(
          makeFinding({
            title: `God module: ${file} imported by ${count} files`,
            location: file,
            evidence: [`${count} incoming imports (fan-in)`, "detected in import graph"],
            impact: "This module is a change amplifier — one modification ripples into every importer.",
            category: "architecture",
            recommendedChangeCategory: "extract-module",
          }),
        );
      }
      for (const [file, count] of [...fanOut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        if (count < 10) continue;
        findings.push(
          makeFinding({
            title: `High fan-out: ${file} imports ${count} modules`,
            location: file,
            evidence: [`${count} outgoing imports (fan-out)`],
            impact: "A module reaching everywhere depends on everything — it cannot be moved or isolated safely.",
            category: "architecture",
            recommendedChangeCategory: "introduce-boundary",
          }),
        );
      }

      // Layering heuristic: UI files reaching directly into db/persistence.
      const uiFiles = ctx.tools.snapshot.files.filter((f) => /\.(tsx|jsx)$/.test(f.path) || /components?\//.test(f.path));
      for (const ui of uiFiles) {
        const badImports = edges.filter(
          (e) =>
            e.from === ui.path &&
            (/(^|\/)(db|database|sql|repositories?|prisma|models?)\//.test(e.to) || /\.(sql)$/.test(e.to)),
        );
        if (badImports.length > 0) {
          findings.push(
            makeFinding({
              title: `UI layer directly imports persistence (${badImports.length} imports)`,
              location: ui.path,
              evidence: badImports.map((e) => `${ui.path} -> ${e.to}`),
              impact: "Presentation code owning data access violates separation of concerns; persistence changes break the UI.",
              category: "architecture",
              recommendedChangeCategory: "extract-service",
            }),
          );
        }
      }

      await ctx.progress(`${findings.length} deterministic architecture findings, asking the architect model for more`);

      // LLM discovery pass: the deterministic heuristics only catch cycles,
      // fan extremes and UI->db imports. A senior architect reading the same
      // graph also spots missing abstractions, mixed layers inside one
      // module, business logic in controllers, and de-facto god directories —
      // patterns that have no cheap regex. Deterministic findings always
      // survive; this pass only ADDS.
      const digest = {
        frameworks: ctx.tools.snapshot.frameworks.map((f) => f.name),
        entrypoints: ctx.tools.snapshot.entrypoints.slice(0, 10),
        modulesByDirectory: [...new Set(ctx.tools.snapshot.files.map((f) => f.path.split("/").slice(0, 2).join("/")))].slice(0, 40),
        topFanIn: [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
        topFanOut: [...fanOut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
        importEdges: edges.slice(0, 250).map((e) => `${e.from} -> ${e.to}`),
      };
      const discovered = await enrich(ctx, {
        system:
          "You are a principal software architect reviewing a codebase's dependency structure. " +
          "Report ONLY real structural problems you can point to in the evidence — never style nits. " +
          "Each finding must cite specific files from the provided graph. If the architecture is sound, return an empty list.",
        prompt:
          "Identify architectural problems in this codebase digest that the graph metrics alone would miss: " +
          "leaky layering, missing abstraction over a dependency knot, business logic far from its data, " +
          "modules mixing concerns, unstable interfaces many files depend on.\n\n" +
          JSON.stringify(digest),
        schema: z.object({
          findings: z.array(
            z.object({
              title: z.string().min(1),
              location: z.string().min(1),
              evidence: z.array(z.string().min(1)).min(1),
              impact: z.string().min(1),
              recommendedChangeCategory: z.enum([
                "extract-module",
                "extract-service",
                "introduce-boundary",
                "move-code",
                "rename",
                "none",
              ]),
              confidence: z.number().min(0).max(1),
            }),
          ),
        }),
        maxTokens: 2_048,
      });
      if (discovered) {
        const knownTitles = new Set(findings.map((f) => f.title.toLowerCase()));
        for (const d of discovered.findings.slice(0, 10)) {
          if (knownTitles.has(d.title.toLowerCase())) continue;
          findings.push(
            makeFinding({
              title: d.title,
              location: d.location,
              evidence: d.evidence.slice(0, 8),
              impact: d.impact,
              category: "architecture",
              recommendedChangeCategory: d.recommendedChangeCategory,
              confidence: d.confidence,
            }),
          );
        }
        await ctx.progress(`architect model added ${findings.length} total architecture findings`);
      }

      const artifact = await ctx.store.write({
        kind: "findings",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: { findings, notes: ["import-graph analysis", "llm architect discovery pass"] } satisfies FindingsArtifact,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
