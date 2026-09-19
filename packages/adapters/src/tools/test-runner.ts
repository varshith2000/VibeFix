import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { TestRunner, TestRunResult } from "../capabilities.js";
import { runCommand } from "./git.js";

function packageManagerFor(root: string): string {
  const checks: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, pm] of checks) {
    if (existsSync(path.join(root, file))) return pm;
  }
  return "npm";
}

function readPackageJson(root: string): Record<string, unknown> | null {
  const p = path.join(root, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Detects runnable install/build/test/typecheck commands from manifests. */
export class NodeTestRunner implements TestRunner {
  detectCommands(root: string): { install?: string; build?: string; test?: string; typecheck?: string } {
    const pkg = readPackageJson(root);
    if (!pkg) {
      if (existsSync(path.join(root, "pytest.ini")) || existsSync(path.join(root, "pyproject.toml"))) {
        return { test: "pytest" };
      }
      return {};
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const pm = packageManagerFor(root);
    const runner = pm === "pnpm" ? "pnpm" : pm === "yarn" ? "yarn" : pm === "bun" ? "bun" : "npx";
    const out: { install?: string; build?: string; test?: string; typecheck?: string } = {
      install: `${pm} install`,
    };
    if (typeof scripts.build === "string") out.build = `${runner} run build`;
    if (typeof scripts.test === "string") out.test = `${runner} run test`;
    if (typeof scripts.typecheck === "string") out.typecheck = `${runner} run typecheck`;
    else if (typeof scripts.tsc === "string") out.typecheck = `${runner} run tsc`;
    return out;
  }

  async runCommand(root: string, command: string, timeoutMs = 300_000): Promise<TestRunResult> {
    const started = Date.now();
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    if (!cmd) {
      return { ok: false, command, exitCode: -1, outputTail: "empty command", durationMs: 0 };
    }
    const res = await runCommand(cmd, args, { cwd: root, timeoutMs });
    const output = `${res.stdout}\n${res.stderr}`.trim();
    return {
      ok: res.code === 0,
      command,
      exitCode: res.code,
      outputTail: output.length > 8_000 ? `...${output.slice(-8_000)}` : output,
      durationMs: Date.now() - started,
    };
  }
}
