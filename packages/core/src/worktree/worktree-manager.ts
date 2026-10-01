import { promises as fs } from "node:fs";
import path from "node:path";
import { GitTool } from "@vibefix/adapters";
import { worktreesDir } from "../store/paths.js";
import { debug, info, warn, error } from "../util/logger.js";

export interface WorktreeHandle {
  proposalId: string;
  attempt: number;
  branch: string;
  path: string;
  baseCommit: string | null;
}

/**
 * Git worktrees are the transactional layer: every attempt runs in an isolated
 * worktree; pass = single commit cherry-picked to the user's branch; fail =
 * worktree discarded. The user's main checkout is never dirtied.
 */
export class WorktreeManager {
  private readonly git: GitTool;

  constructor(private readonly repoPath: string) {
    this.git = new GitTool(repoPath);
  }

  /** Worktrees live in the central workspace, never inside the target repo. */
  private get worktreesRoot(): string {
    return worktreesDir(this.repoPath);
  }

  async create(proposalId: string, attempt: number): Promise<WorktreeHandle> {
    const slug = `${proposalId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-a${attempt}`;
    const branch = `vibefix/${slug}`;
    const wtPath = path.join(this.worktreesRoot, slug);
    
    debug("worktree", `Creating worktree for proposal ${proposalId}, attempt ${attempt}`);
    
    try {
      const baseCommit = await this.git.headCommit();
      if (!baseCommit) throw new Error("cannot create a worktree without a base commit");
      await fs.mkdir(path.dirname(wtPath), { recursive: true });
      const res = await this.git.addWorktree(wtPath, branch);
      if (res.code !== 0) {
        error("worktree", `Worktree add failed for ${slug}: ${res.stderr}\n${res.stdout}`);
        throw new Error(`worktree add failed: ${res.stderr}\n${res.stdout}`);
      }
      const worktreeHead = await new GitTool(wtPath).headCommit();
      if (worktreeHead !== baseCommit) {
        await this.git.removeWorktree(wtPath, true).catch(() => undefined);
        await this.git.deleteBranch(branch, true).catch(() => undefined);
        throw new Error(`worktree base moved during creation (expected ${baseCommit}, got ${worktreeHead ?? "none"})`);
      }
      info("worktree", `Successfully created worktree ${slug} at ${wtPath}`);
      return { proposalId, attempt, branch, path: wtPath, baseCommit };
    } catch (err) {
      error("worktree", `Failed to create worktree for ${slug}:`, err);
      throw err;
    }
  }

  /** Diff of uncommitted changes inside the worktree. */
  async diff(handle: WorktreeHandle): Promise<string> {
    return this.git.diffHead(handle.path);
  }

  async changedFiles(handle: WorktreeHandle): Promise<string[]> {
    return this.git.pendingChangedFiles(handle.path);
  }

  /** Diff of the exact committed attempt, never the now-clean working tree. */
  async committedDiff(handle: WorktreeHandle, ref = "HEAD"): Promise<string> {
    if (!handle.baseCommit) throw new Error("worktree has no recorded base commit");
    return this.git.diffBetween(handle.baseCommit, ref, handle.path);
  }

  /** Commit everything inside the worktree; returns the commit ref. */
  async commit(handle: WorktreeHandle, message: string): Promise<{ ok: boolean; ref: string | null }> {
    return this.git.commitAll(message, handle.path);
  }

  /**
   * Land a passed attempt on the user's branch: the engineer's single worktree
   * commit is cherry-picked (never a branch merge). On cherry-pick conflict
   * the attempt is treated as failed and the user's branch left untouched.
   */
  async landOnMainBranch(handle: WorktreeHandle, ref: string): Promise<{ ok: boolean; conflict: boolean }> {
    if (!handle.baseCommit) throw new Error("cannot land a worktree without a recorded base commit");
    const currentHead = await this.git.headCommit();
    if (currentHead !== handle.baseCommit) {
      warn("worktree", `Refusing to land ${handle.proposalId}: user branch moved from ${handle.baseCommit} to ${currentHead}`);
      return { ok: false, conflict: true };
    }
    const pick = await this.git.cherryPick(ref);
    if (pick.code === 0) return { ok: true, conflict: false };
    const abort = await this.git.cherryPickAbort();
    if (abort.code !== 0) {
      throw new Error(`cherry-pick failed and abort could not restore the user branch: ${abort.stderr || abort.stdout}`);
    }
    return { ok: false, conflict: true };
  }

  async discard(handle: WorktreeHandle): Promise<void> {
    await this.git.removeWorktree(handle.path, true).catch(() => undefined);
    await this.git.deleteBranch(handle.branch, true).catch(() => undefined);
  }

  /** Best-effort cleanup of all vibefix worktrees (abort, CLI clean, exit). */
  async cleanupAll(): Promise<void> {
    const dir = this.worktreesRoot;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      debug("worktree", `No worktrees directory found at ${dir}`);
      return;
    }
    
    info("worktree", `Cleaning up ${entries.length} worktrees in ${dir}`);
    
    const cleanupErrors: Array<{ entry: string; error: string }> = [];
    
    for (const entry of entries) {
      const wtPath = path.join(dir, entry);
      try {
        await this.git.removeWorktree(wtPath, true);
        await this.git.deleteBranch(`vibefix/${entry}`, true);
        debug("worktree", `Successfully cleaned up worktree ${entry}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        cleanupErrors.push({ entry, error: errorMsg });
        warn("worktree", `Failed to cleanup worktree ${entry}: ${errorMsg}`);
      }
    }
    
    if (cleanupErrors.length > 0) {
      warn("worktree", `Cleanup completed with ${cleanupErrors.length} errors out of ${entries.length} worktrees`);
    } else {
      info("worktree", `Successfully cleaned up all ${entries.length} worktrees`);
    }
  }

}
