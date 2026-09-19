import type { TestSurveyArtifact } from "@vibefix/schemas";
import { passed, failed, type AgentExecutionContext, type VibeFixAgent } from "../contract.js";
import { definitionFor } from "../definitions.js";

/**
 * Determines what safety net exists. Deterministic: framework/test detection
 * + command availability. The key output is the flags downstream agents use:
 * canTest? canBuild? — and untestedPaths, which drives "what's missing".
 */
export class TestSurveyor implements VibeFixAgent {
  definition = definitionFor("test-surveyor");

  async execute(ctx: AgentExecutionContext) {
    try {
      await ctx.progress("surveying test infrastructure");
      const { snapshot } = ctx.tools;
      const commands = ctx.tools.runner.detectCommands(ctx.repoPath);

      const testFiles = snapshot.files.filter(
        (f) =>
          /\.test\.[jt]sx?$/.test(f.path) ||
          /\.spec\.[jt]sx?$/.test(f.path) ||
          /^tests?\//.test(f.path) ||
          /_test\.(go|py)$/.test(f.path) ||
          /test_.*\.py$/.test(f.path),
      );
      const codeFiles = snapshot.files.filter((f) => /\.(ts|tsx|js|jsx|py|go|rs)$/.test(f.path));
      const testedPaths = testFiles.map((f) => f.path);
      const codeDirs = new Set(
        codeFiles
          .filter((f) => !f.path.includes("test") && !f.path.includes("spec"))
          .map((f) => (f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".")),
      );
      const testedDirs = new Set(testedPaths.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".")));
      const untestedPaths = [...codeDirs].filter((d) => ![...testedDirs].some((t) => d === t || d.startsWith(`${t}/`) || t.startsWith(`${d}/`)));

      const survey: TestSurveyArtifact = {
        frameworks: snapshot.testFrameworks,
        testFileCount: testFiles.length,
        testCount: testFiles.length, // best effort until a runner parses results
        canInstall: commands.install !== undefined,
        canBuild: commands.build !== undefined,
        canTest: commands.test !== undefined,
        coveragePercent: null,
        testedPaths,
        untestedPaths,
        notes: [
          testFiles.length === 0
            ? "NO TESTS DETECTED — Phase C must pin current behavior before any refactoring"
            : `${testFiles.length} test files detected`,
        ],
      };

      await ctx.progress(`${testFiles.length} test files; canTest=${survey.canTest}`);
      const artifact = await ctx.store.write({
        kind: "test-survey",
        producer: ctx.def.agentId,
        runId: ctx.runState.runId,
        data: survey,
      });
      return passed([artifact.artifactId]);
    } catch (err) {
      return failed(err);
    }
  }
}
