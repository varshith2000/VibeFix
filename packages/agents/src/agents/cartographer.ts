import type { KnowledgeGraph } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";

/**
 * Maps the codebase — no opinions, just facts. The graph itself is built
 * deterministically from the fs snapshot + import scan; the LLM only adds a
 * human-facing summary of what this codebase appears to be.
 */
export class Cartographer implements VibeFixAgent {
  definition = definitionFor("cartographer");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("building knowledge graph from file facts");
      const { snapshot, importEdges } = ctx.tools;

      const nodes: KnowledgeGraph["nodes"] = [
        { nodeId: "repo", nodeType: "repo", name: "repository" },
      ];
      const dirSet = new Set<string>();
      for (const file of snapshot.files) {
        nodes.push({
          nodeId: `file:${file.path}`,
          nodeType: file.language ? "file" : "config",
          path: file.path,
          name: file.path.split("/").pop() ?? file.path,
          meta: { loc: file.loc, language: file.language },
        });
        const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
        if (dir) dirSet.add(dir);
      }
      for (const dir of dirSet) {
        nodes.push({ nodeId: `module:${dir}`, nodeType: "module", path: dir, name: dir });
      }
      for (const entrypoint of snapshot.entrypoints) {
        nodes.push({ nodeId: `entry:${entrypoint}`, nodeType: "endpoint", path: entrypoint, name: entrypoint });
      }
      for (const framework of snapshot.frameworks) {
        nodes.push({
          nodeId: `ext:${framework.name}`,
          nodeType: "externalService",
          name: framework.name,
          meta: { evidence: framework.evidence },
        });
      }

      const edges: KnowledgeGraph["edges"] = importEdges
        .filter((e) => e.resolved)
        .map((e) => ({
          fromNodeId: `file:${e.from}`,
          toNodeId: `file:${e.to}`,
          edgeType: "imports" as const,
        }));
      for (const entrypoint of snapshot.entrypoints) {
        edges.push({ fromNodeId: "repo", toNodeId: `entry:${entrypoint}`, edgeType: "exposes" });
      }

      const graph: KnowledgeGraph = {
        summary: {
          languages: snapshot.languages.map((l) => `${l.language} (${l.loc} loc, ${l.fileCount} files)`),
          frameworks: snapshot.frameworks.map((f) => `${f.name} [${f.evidence}]`),
          entrypoints: snapshot.entrypoints,
          buildSystem: snapshot.buildSystem,
          packageManager: snapshot.packageManager,
          testFrameworks: snapshot.testFrameworks,
          loc: snapshot.totalLoc,
          fileCount: snapshot.files.length,
          unknowns: [],
        },
        nodes,
        edges,
      };

      await ctx.progress(`mapped ${nodes.length} nodes / ${edges.length} edges`);
      const artifact = await ctx.store.write({
        kind: "knowledge-graph",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: graph,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
