import { promises as fs } from "node:fs";
import path from "node:path";
import { GitTool } from "@vibefix/adapters";
import type { ProductIntent } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { enrich } from "../runtime/text-agent-loop.js";
import { z } from "zod";

/**
 * Historian — read-only intent inference from git history, README, and
 * TODO/FIXME markers. Produces the Product Intent Document that every later
 * agent must respect ("don't deviate from the product's soul").
 */
export class Historian implements VibeFixAgent {
  definition = definitionFor("historian");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("reading history and documentation");
      const git = new GitTool(ctx.repoPath);
      const commits = await git.recentLog(50);
      const hotPaths = await git.hotPaths(25);
      const sources: string[] = [];

      let readme = "";
      for (const name of ["README.md", "readme.md", "README", "docs/README.md"]) {
        try {
          readme = await fs.readFile(path.join(ctx.repoPath, ...name.split("/")), "utf8");
          sources.push(name);
          break;
        } catch {
          // try next
        }
      }

      const packageHints: string[] = [];
      for (const name of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
        try {
          const raw = await fs.readFile(path.join(ctx.repoPath, name), "utf8");
          sources.push(name);
          if (name === "package.json") {
            const pkg = JSON.parse(raw) as { name?: string; description?: string };
            if (pkg.name) packageHints.push(`package name: ${pkg.name}`);
            if (pkg.description) packageHints.push(`description: ${pkg.description}`);
          } else {
            packageHints.push(`${name} present`);
          }
        } catch {
          // absent
        }
      }

      const todoHits = ctx.tools.metrics.deadCodeCandidates.slice(0, 20).map(
        (d) => `${d.file}:${d.startLine} ${d.hint}`,
      );

      // Deterministic baseline intent from facts.
      const coreDirs = inferCoreAreas(ctx.tools.snapshot.files.map((f) => f.path));
      const frozen = inferFrozen(ctx.tools.snapshot.files.map((f) => f.path));
      let intent: ProductIntent = {
        productSummary:
          packageHints.find((h) => h.startsWith("description:"))?.replace("description: ", "") ||
          (readme ? summarizeReadme(readme) : "Undocumented repository — intent inferred from structure and history only."),
        coreAreas: coreDirs,
        frozenAreas: frozen,
        activeChurnAreas: uniqueDirs(hotPaths).slice(0, 12),
        intentConstraints: [
          "Preserve existing user-facing behavior unless explicitly approved",
          "Respect existing architectural conventions rather than imposing a new paradigm",
          ...(frozen.length > 0 ? [`Treat as do-not-touch unless approved: ${frozen.slice(0, 5).join(", ")}`] : []),
        ],
        sources: [
          ...sources,
          ...(commits.length > 0 ? [`git log (${commits.length} recent commits)`] : []),
          ...(todoHits.length > 0 ? [`${todoHits.length} TODO/FIXME markers`] : []),
        ],
        notes: [
          ...(commits.slice(0, 8).map((c) => `commit: ${c}`)),
          ...packageHints,
        ],
      };

      const refined = await enrich(ctx, {
        system:
          "You are the Historian agent. Infer product intent from evidence only. " +
          "Do not invent features. Return a Product Intent Document that later refactoring agents must respect.",
        prompt: JSON.stringify({
          readme: readme.slice(0, 6_000),
          recentCommits: commits.slice(0, 30),
          hotPaths: hotPaths.slice(0, 20),
          todos: todoHits.slice(0, 15),
          draft: intent,
        }),
        schema: z.object({
          productSummary: z.string(),
          coreAreas: z.array(z.string()),
          frozenAreas: z.array(z.string()),
          activeChurnAreas: z.array(z.string()),
          intentConstraints: z.array(z.string()),
        }),
      });
      if (refined) {
        intent = {
          ...intent,
          productSummary: refined.productSummary || intent.productSummary,
          coreAreas: refined.coreAreas.length > 0 ? refined.coreAreas : intent.coreAreas,
          frozenAreas: refined.frozenAreas.length > 0 ? refined.frozenAreas : intent.frozenAreas,
          activeChurnAreas:
            refined.activeChurnAreas.length > 0 ? refined.activeChurnAreas : intent.activeChurnAreas,
          intentConstraints:
            refined.intentConstraints.length > 0 ? refined.intentConstraints : intent.intentConstraints,
        };
      }

      const artifact = await ctx.store.write({
        kind: "product-intent",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: intent,
      });
      await ctx.progress(`intent: ${intent.productSummary.slice(0, 80)}`);
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}

function summarizeReadme(md: string): string {
  const lines = md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("```") && !l.startsWith("!["));
  return lines.slice(0, 3).join(" ").slice(0, 400) || "See README for product description.";
}

function inferCoreAreas(files: string[]): string[] {
  const dirs = uniqueDirs(files);
  const preferred = dirs.filter((d) =>
    /^(src|app|lib|packages|server|api|core|backend|frontend|web|services)\b/.test(d),
  );
  return (preferred.length > 0 ? preferred : dirs).slice(0, 10);
}

function inferFrozen(files: string[]): string[] {
  const frozen: string[] = [];
  for (const f of files) {
    if (/(^|\/)(vendor|third_party|generated|migrations|dist|build|node_modules)\//.test(f)) {
      const top = f.split("/").slice(0, 2).join("/");
      if (!frozen.includes(top)) frozen.push(top);
    }
  }
  return frozen.slice(0, 15);
}

function uniqueDirs(paths: string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    const parts = p.replace(/\\/g, "/").split("/");
    if (parts.length >= 2) set.add(parts.slice(0, 2).join("/"));
    else if (parts[0]) set.add(parts[0]);
  }
  return [...set];
}
