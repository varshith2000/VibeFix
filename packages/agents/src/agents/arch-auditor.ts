import type { FindingsArtifact } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { makeFinding } from "../shared/findings.js";

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

      await ctx.progress(`${findings.length} architecture findings`);
      const artifact = await ctx.store.write({
        kind: "findings",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: { findings, notes: ["import-graph analysis"] } satisfies FindingsArtifact,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
