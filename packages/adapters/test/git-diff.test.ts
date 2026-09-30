import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitTool, runCommand } from "../src/tools/git.js";

describe("GitTool attempt diffs", () => {
  it("detects untracked files before commit and includes them in the committed diff", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-git-diff-"));
    try {
      const git = async (...args: string[]) => {
        const result = await runCommand("git", args, { cwd: root });
        if (result.code !== 0) throw new Error(result.stderr || result.stdout);
        return result.stdout.trim();
      };
      await git("init");
      await git("config", "user.email", "test@example.invalid");
      await git("config", "user.name", "Test");
      await writeFile(path.join(root, "existing.ts"), "export const existing = true;\n");
      await git("add", "-A");
      await git("commit", "-m", "baseline");
      const baseCommit = await git("rev-parse", "HEAD");

      await writeFile(path.join(root, "new-module.ts"), "export const added = true;\n");
      const tool = new GitTool(root);
      expect(await tool.pendingChangedFiles()).toContain("new-module.ts");

      await git("add", "-A");
      await git("commit", "-m", "attempt");
      expect(await tool.changedFilesBetween(baseCommit)).toContain("new-module.ts");
      expect(await tool.diffBetween(baseCommit)).toContain("+export const added = true;");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
