import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeTestRunner, runCommand } from "../src/index.js";

describe("child process timeout and cleanup (REL-12 / RES-06)", () => {
  it("terminates a hung child process and returns non-ok result on timeout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibefix-runner-timeout-"));
    try {
      const script = path.join(dir, "hang.js");
      await writeFile(script, "setInterval(() => {}, 1000);\n", "utf8");
      const runner = new NodeTestRunner();
      const started = Date.now();
      const result = await runner.runCommand(dir, `"${process.execPath}" "${script}"`, 300);
      const elapsed = Date.now() - started;

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(-1);
      expect(result.outputTail).toContain("timed out");
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("terminates a parent that spawns a grandchild process within timeout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vibefix-runner-tree-"));
    try {
      const childScript = path.join(dir, "grandchild.js");
      const parentScript = path.join(dir, "parent.js");
      await writeFile(childScript, "setInterval(() => {}, 1000);\n", "utf8");
      await writeFile(
        parentScript,
        `const { spawn } = require("node:child_process");
         spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "inherit" });
         setInterval(() => {}, 1000);\n`,
        "utf8",
      );

      const res = await runCommand(process.execPath, [parentScript], { cwd: dir, timeoutMs: 400 });
      expect(res.code).toBe(-1);
      expect(res.stderr).toContain("timed out");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
