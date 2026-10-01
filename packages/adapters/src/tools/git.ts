import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner, ProcessResult } from "../capabilities.js";

/** Spawn a command, capture stdout/stderr, enforce a timeout. Windows-safe. */
export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<ProcessResult> {
  // Plain executables (git.exe, node.exe) spawn directly — no shell, so args
  // with spaces/quotes survive. Only cmd shims (npm/pnpm/yarn) need a shell,
  // and there every arg is double-quoted.
  const needsShell = process.platform === "win32" && /\.(cmd|bat|com)$/i.test(command);
  const child = spawn(command, args, {
    cwd: options.cwd,
    windowsHide: true,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    ...(needsShell ? { shell: true, args: args.map(quoteForCmd) } : {}),
  });
  let stdout = "";
  let stderr = "";
  let settled = false;

  const timer = setTimeout(() => {
    if (!settled) {
      if (process.platform === "win32" && child.pid) {
        // `npm.cmd`/`pnpm.cmd` are shell shims; killing only the parent can
        // orphan the actual repository test process. Kill the full tree.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.unref();
      } else {
        child.kill("SIGKILL");
      }
    }
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

  /**
   * Initialize git in a folder that has no repository, with a baseline commit
   * of the current contents (worktrees need at least one commit to branch
   * from). Local-only config is set so the commit succeeds even on machines
   * with no global git identity. Nothing existing is modified — a fresh .git
   * plus one commit is the entire footprint.
   */
  async initBaseline(): Promise<void> {
    let res = await this.git(["init", "-b", "main"]);
    if (res.code !== 0) {
      // Older git without -b: plain init, then rename whatever branch appeared.
      res = await this.git(["init"]);
      if (res.code !== 0) throw new Error(`git init failed: ${res.stderr.slice(0, 200)}`);
      await this.git(["branch", "-M", "main"]).catch(() => undefined);
    }
    await this.git(["config", "user.name", "VibeFix"]);
    await this.git(["config", "user.email", "vibefix@local"]);
    const add = await this.git(["add", "-A"]);
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.slice(0, 200)}`);
    const commit = await this.git(["commit", "-m", "vibefix: baseline snapshot before first run", "--allow-empty"]);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr.slice(0, 200)}`);
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

  /** Recent commit subjects for intent / churn inference. */
  async recentLog(limit = 40): Promise<string[]> {
    const res = await this.git(["log", `-${limit}`, "--pretty=format:%s"]);
    if (res.code !== 0) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** Paths touched most often in recent history (best-effort churn signal). */
  async hotPaths(limit = 30): Promise<string[]> {
    const res = await this.git(["log", "-40", "--name-only", "--pretty=format:"]);
    if (res.code !== 0) return [];
    const counts = new Map<string, number>();
    for (const line of res.stdout.split("\n")) {
      const p = line.trim().replace(/\\/g, "/");
      if (!p || p.startsWith(".")) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([p]) => p);
  }

  async addWorktree(worktreePath: string, branchName: string): Promise<ProcessResult> {
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

  /** Canonical diff for a committed worktree attempt. */
  async diffBetween(baseRef: string, headRef = "HEAD", cwd?: string): Promise<string> {
    const args = ["diff", "--binary", baseRef, headRef, "--"];
    const res = cwd
      ? await runCommand("git", args, { cwd, timeoutMs: 30_000 })
      : await this.git(args);
    if (res.code !== 0) {
      throw new Error(`git diff ${baseRef}..${headRef} failed: ${(res.stderr || res.stdout).slice(0, 500)}`);
    }
    return res.stdout;
  }

  async changedFiles(cwd?: string): Promise<string[]> {
    const res = cwd
      ? await runCommand("git", ["diff", "--name-only", "HEAD"], { cwd, timeoutMs: 30_000 })
      : await this.git(["diff", "--name-only", "HEAD"]);
    if (res.code !== 0) return [];
    return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** Changed paths for a committed attempt, including files newly added by it. */
  async changedFilesBetween(baseRef: string, headRef = "HEAD", cwd?: string): Promise<string[]> {
    const args = ["diff", "--name-only", baseRef, headRef, "--"];
    const res = cwd
      ? await runCommand("git", args, { cwd, timeoutMs: 30_000 })
      : await this.git(args);
    if (res.code !== 0) {
      throw new Error(`git diff --name-only ${baseRef}..${headRef} failed: ${(res.stderr || res.stdout).slice(0, 500)}`);
    }
    return res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** Pending paths before commit. `git diff` alone omits untracked files. */
  async pendingChangedFiles(cwd?: string): Promise<string[]> {
    const target = cwd ?? this.root;
    const res = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: target,
      timeoutMs: 30_000,
    });
    if (res.code !== 0) {
      throw new Error(`git status failed: ${(res.stderr || res.stdout).slice(0, 500)}`);
    }
    return res.stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((file) => {
        const renameTarget = file.includes(" -> ") ? file.split(" -> ").at(-1)! : file;
        return renameTarget.replace(/^"|"$/g, "").replace(/\\/g, "/");
      });
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

  async cherryPickInProgress(): Promise<boolean> {
    const location = await this.git(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
    if (location.code !== 0) return false;
    const marker = path.isAbsolute(location.stdout.trim())
      ? location.stdout.trim()
      : path.join(this.root, location.stdout.trim());
    try {
      await access(marker);
      return true;
    } catch {
      return false;
    }
  }
}
