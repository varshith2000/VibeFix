import type { FindingsArtifact } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";
import { makeFinding } from "../shared/findings.js";

/**
 * Consistency Sentinel — style and convention drift: mixed HTTP clients,
 * inconsistent error handling patterns, mixed naming, scattered config.
 * Deterministic heuristics; findings only, never fixes.
 */
export class ConsistencySentinel implements VibeFixAgent {
  definition = definitionFor("consistency-sentinel");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("scanning for convention drift");
      const findings: FindingsArtifact["findings"] = [];
      const files = ctx.tools.snapshot.files.filter((f) => /\.(ts|tsx|js|jsx|py)$/.test(f.path));

      const httpLibs = new Map<string, string[]>();
      const errorStyles = new Map<string, string[]>();
      const naming = { camel: 0, snake: 0, kebabFile: 0, pascalFile: 0 };
      const configFiles: string[] = [];

      for (const f of files.slice(0, 500)) {
        const content = await readSafe(ctx, f.path);
        if (!content) continue;

        for (const lib of ["axios", "node-fetch", "got", "superagent", "ky", "undici", "fetch("]) {
          if (content.includes(lib === "fetch(" ? "fetch(" : `from "${lib}"`) || content.includes(`require("${lib}")`) || content.includes(`'${lib}'`)) {
            const key = lib === "fetch(" ? "fetch" : lib;
            push(httpLibs, key, f.path);
          }
        }

        if (/throw new Error\(/.test(content)) push(errorStyles, "throw-Error", f.path);
        if (/\.status\s*\(\s*\d+/.test(content) || /res\.statusCode/.test(content)) push(errorStyles, "http-status", f.path);
        if (/Result<|>Err<|>Ok</.test(content)) push(errorStyles, "result-type", f.path);
        if (/try\s*\{/.test(content) && /catch\s*\(/.test(content)) push(errorStyles, "try-catch", f.path);

        const base = f.path.split("/").pop() ?? "";
        if (/^[a-z][a-zA-Z0-9]*\./.test(base)) naming.camel += 1;
        if (/_/.test(base)) naming.snake += 1;
        if (/-/.test(base)) naming.kebabFile += 1;
        if (/^[A-Z][a-zA-Z0-9]*\./.test(base)) naming.pascalFile += 1;

        if (/(^|\/)(config|settings|env)[./]/i.test(f.path) || /\.env/.test(f.path)) {
          configFiles.push(f.path);
        }
      }

      if (httpLibs.size >= 2) {
        const libs = [...httpLibs.keys()];
        findings.push(
          makeFinding({
            title: `Mixed HTTP clients: ${libs.join(", ")}`,
            location: httpLibs.get(libs[0]!)?.[0] ?? "",
            evidence: libs.map((l) => `${l}: ${httpLibs.get(l)?.length ?? 0} files`),
            impact: "Multiple HTTP stacks make retries, auth headers, and error handling inconsistent across the codebase.",
            category: "consistency",
            recommendedChangeCategory: "restyle-consistency",
            confidence: 0.85,
          }),
        );
      }

      if (errorStyles.size >= 3) {
        findings.push(
          makeFinding({
            title: `Inconsistent error handling (${errorStyles.size} styles)`,
            location: [...errorStyles.values()][0]?.[0] ?? "",
            evidence: [...errorStyles.entries()].map(([k, v]) => `${k}: ${v.length} files`),
            impact: "Callers cannot rely on a single error contract; failures surface differently by module.",
            category: "consistency",
            recommendedChangeCategory: "restyle-consistency",
            confidence: 0.75,
          }),
        );
      }

      const namingStyles = [naming.camel > 0, naming.snake > 0, naming.kebabFile > 0, naming.pascalFile > 0].filter(Boolean).length;
      if (namingStyles >= 3) {
        findings.push(
          makeFinding({
            title: "Mixed file naming conventions",
            location: files[0]?.path ?? "",
            evidence: [
              `camelCase-ish: ${naming.camel}`,
              `snake_case: ${naming.snake}`,
              `kebab-case: ${naming.kebabFile}`,
              `PascalCase: ${naming.pascalFile}`,
            ],
            impact: "Naming drift raises cognitive load and makes mechanical refactors (imports, barrels) brittle.",
            category: "consistency",
            recommendedChangeCategory: "rename",
            confidence: 0.65,
          }),
        );
      }

      if (configFiles.length >= 5) {
        findings.push(
          makeFinding({
            title: `Configuration scattered across ${configFiles.length} files`,
            location: configFiles[0] ?? "",
            evidence: configFiles.slice(0, 12),
            impact: "Settings live in many places; environment-specific behavior becomes hard to reason about.",
            category: "consistency",
            recommendedChangeCategory: "extract-module",
            confidence: 0.7,
          }),
        );
      }

      const artifact = await ctx.store.write({
        kind: "findings",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: { findings, notes: ["consistency-sentinel"] } satisfies FindingsArtifact,
      });
      await ctx.progress(`${findings.length} consistency findings`);
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}

function push(map: Map<string, string[]>, key: string, path: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(path)) list.push(path);
  map.set(key, list);
}

async function readSafe(ctx: AgentExecutionContext, rel: string): Promise<string | null> {
  try {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    return await fs.readFile(path.join(ctx.repoPath, ...rel.split("/")), "utf8");
  } catch {
    return null;
  }
}
