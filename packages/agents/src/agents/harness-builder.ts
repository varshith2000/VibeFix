import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BehavioralBaselineArtifact,
  CharacterizationPlan,
} from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";

const EXPORT_PATTERNS = [
  /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+default\s+([A-Za-z_$][\w$]*)/g,
  /exports\.([A-Za-z_$][\w$]*)\s*=/g,
  /^def\s+([A-Za-z_][\w]*)\s*\(/gm,
  /^class\s+([A-Za-z_][\w]*)/gm,
];

/** CommonJS module.exports — pinned as a single surface symbol per file. */
const CJS_MODULE_EXPORT = /module\.exports\s*=/;

/**
 * Pins current behavior BEFORE any refactoring. MVP pins two things:
 *  1. the public API surface (exported symbols of every in-scope file), and
 *  2. the existing test suite result (if runnable) as the baseline snapshot.
 * Characterization test *generation* lands next milestone; the surface pin
 * already makes API drift detectable and rejectable.
 */
export class HarnessBuilder implements VibeFixAgent {
  definition = definitionFor("harness-builder");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("extracting public API surface");
      const surface: string[] = [];
      const codeFiles = ctx.tools.snapshot.files.filter(
        (f) => /\.(ts|tsx|js|jsx|py)$/.test(f.path) && f.loc > 0 && f.loc < 5_000,
      );
      for (const file of codeFiles.slice(0, 400)) {
        let content: string;
        try {
          content = await fs.readFile(path.join(ctx.repoPath, ...file.path.split("/")), "utf8");
        } catch {
          continue;
        }
        for (const pattern of EXPORT_PATTERNS) {
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(content)) !== null) {
            surface.push(`${file.path}::${m[1]}`);
          }
        }
        if (CJS_MODULE_EXPORT.test(content)) surface.push(`${file.path}::module.exports`);
      }
      surface.sort();

      const commands = ctx.tools.runner.detectCommands(ctx.repoPath);
      await ctx.progress(commands.test ? "running existing suite for baseline" : "no runnable suite; pinning surface only");
      let baselineResults: unknown = { suiteAvailable: false };
      if (commands.test) {
        const run = await ctx.tools.runner.runCommand(ctx.repoPath, commands.test, 300_000);
        baselineResults = {
          suiteAvailable: true,
          command: commands.test,
          ok: run.ok,
          exitCode: run.exitCode,
          outputTail: run.outputTail.slice(-4_000),
        };
      }

      const plan: CharacterizationPlan = {
        branch: "vibefix/harness",
        testFiles: [],
        publicApiSurface: surface,
        excluded: [],
      };
      const baseline: BehavioralBaselineArtifact = {
        harnessBranch: "vibefix/harness",
        testFiles: ctx.tools.snapshot.files.filter((f) => /\.test\.[jt]sx?$|\.spec\.[jt]sx?$/.test(f.path)).map((f) => f.path),
        baselineResults,
        excluded: [],
        publicApiSurface: surface,
      };

      const planArtifact = await ctx.store.write({
        kind: "characterization-plan",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: plan,
      });
      const baselineArtifact = await ctx.store.write({
        kind: "behavioral-baseline",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: baseline,
      });
      await ctx.progress(`pinned ${surface.length} public symbols`);
      return passed([planArtifact.artifactId, baselineArtifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
