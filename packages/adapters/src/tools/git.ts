import { spawn } from "node:child_process";
import path from "node:path";
import type { CommandRunner, ProcessResult } from "../capabilities.js";

/** Spawn a command, capture stdout/stderr, enforce a timeout. Windows-safe. */
export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<ProcessResult> {
  // Plain executables (git.exe, node.exe) spawn directly — no shell, so args
  // with spaces/quotes survive. Only cmd shims (npm/pnpm/yarn) need a shell,
  // and there every arg is double-quoted.
  const needsShell = process.platform === "win32" && /\.(cmd|bat|com)$/i.test(command);
  const child = spawn(command, args, {
    cwd: options.cwd,
    windowsHide: true,
    ...(needsShell ? { shell: true, args: args.map(quoteForCmd) } : {}),
  });
  let stdout = "";
  let stderr = "";
  let settled = false;

  const timer = setTimeout(() => {
    if (!settled) child.kill("SIGKILL");
  }, options.timeoutMs ?? 60_000);

  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
    if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000);
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
  });

  function quoteForCmd(arg: string): string {
    return `"${arg.replace(/"/g, '""')}"`;
  }

  const code: number = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c ?? (child.exitCode ?? -1)));
    child.on("error", () => resolve(-1));
  });
  settled = true;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export class ShellRunner implements CommandRunner {
  run(command: string, args: string[], options: { cwd: string; timeoutMs?: number }): Promise<ProcessResult> {
    return runCommand(command, args, options);
  }
}

/** Thin git facade. Worktree lifecycle lives in core; this is the primitive. */
export class GitTool {
  constructor(private readonly root: string) {}

  private git(args: string[], timeoutMs = 30_000): Promise<ProcessResult> {
    return runCommand("git", args, { cwd: this.root, timeoutMs });
  }

  async isRepo(): Promise<boolean> {
    const res = await this.git(["rev-parse", "--is-inside-work-tree"]);
    return res.code === 0 && res.stdout.trim() === "true";
  }

  async isClean(): Promise<boolean> {
    const res = await this.git(["status", "--porcelain"]);
    return res.code === 0 && res.stdout.trim().length === 0;
  }

  async currentBranch(): Promise<string | null> {
    const res = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  async headCommit(): Promise<string | null> {
    const res = await this.git(["rev-parse", "HEAD"]);
    return res.code === 0 ? res.stdout.trim() : null;
  }

  async addWorktree(worktreePath: string, branchName: string): Promise<ProcessResult> {
    // Ensure Windows long-path tolerance inside this repo's config.
    await this.git(["config", "core.longpaths", "true"]);
    return this.git(["worktree", "add", "-b", branchName, path.resolve(worktreePath)]);
  }

  async removeWorktree(worktreePath: string, force = true): Promise<ProcessResult> {
    return this.git(["worktree", "remove", path.resolve(worktreePath), ...(force ? ["--force"] : [])]);
  }

  async deleteBranch(branchName: string, force = true): Promise<ProcessResult> {
    return this.git(["branch", ...(force ? ["-D"] : ["-d"]), branchName]);
  }

  /** Uncommitted diff of the worktree cwd (vs HEAD). */
  async diffHead(cwd?: string): Promise<string> {
    const res = cwd
      ? await runCommand("git", ["diff", "HEAD"], { cwd, timeoutMs: 30_000 })
      : await this.git(["diff", "HEAD"]);
    return res.code === 0 ? res.stdout : "";
  }

  async changedFiles(cwd?: string): Promise<string[]> {
    const res = cwd
      ? await runCommand("git", ["diff", "--name-only", "HEAD"], { cwd, timeoutMs: 30_000 })
      : await this.git(["diff", "--name-only", "HEAD"]);
    if (res.code !== 0) return [];
    return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  async commitAll(message: string, cwd?: string): Promise<{ ok: boolean; ref: string | null }> {
    const target = cwd ?? this.root;
    const add = await runCommand("git", ["add", "-A"], { cwd: target });
    if (add.code !== 0) return { ok: false, ref: null };
    const commit = await runCommand("git", ["commit", "-m", message], { cwd: target });
    const ref = await runCommand("git", ["rev-parse", "HEAD"], { cwd: target });
    return { ok: commit.code === 0, ref: ref.code === 0 ? ref.stdout.trim() : null };
  }

  /** Cherry-pick one commit from a worktree branch onto the current branch. */
  async cherryPick(ref: string): Promise<ProcessResult> {
    return this.git(["cherry-pick", ref]);
  }

  async cherryPickAbort(): Promise<ProcessResult> {
    return this.git(["cherry-pick", "--abort"]);
  }
}
