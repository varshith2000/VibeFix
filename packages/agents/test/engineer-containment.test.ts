import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWorktreeWritePath } from "../src/agents/engineer.js";

describe("engineer write path containment", () => {
  it("rejects parent traversal and absolute paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-write-root-"));
    try {
      await expect(resolveWorktreeWritePath(root, "src/../../outside.txt")).rejects.toThrow("safe relative path");
      await expect(resolveWorktreeWritePath(root, path.join(root, "outside.txt"))).rejects.toThrow("safe relative path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked parent that points outside the worktree", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "vibefix-write-link-"));
    const root = path.join(parent, "worktree");
    const outside = path.join(parent, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      try {
        await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        if (process.platform === "win32") return;
        throw err;
      }
      await expect(resolveWorktreeWritePath(root, "linked/new.txt")).rejects.toThrow("outside the worktree");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});