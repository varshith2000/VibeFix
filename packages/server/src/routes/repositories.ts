import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { NodeFsFacts } from "@vibefix/adapters";
import { isPathInside } from "../policies/path-policy.js";
import type { ServerContext } from "../context.js";

function isBrowseRoot(pathname: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathname === root || isPathInside(root, pathname));
}

async function repoRoot(enc: string, reply: import("fastify").FastifyReply, context: ServerContext): Promise<string | null> {
  const repoPath = context.decodeProject(enc, reply);
  if (!repoPath) return null;
  try {
    const stat = await fs.stat(repoPath);
    if (!stat.isDirectory()) throw new Error("not a directory");
    return repoPath;
  } catch {
    reply.code(400).send({ error: `repository path does not exist: ${repoPath}` });
    return null;
  }
}

export function registerRepositoryRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get("/api/fs/browse", async (req, reply) => {
    const requested = (req.query as { path?: string }).path;
    if (requested !== undefined && !path.isAbsolute(requested)) return reply.code(400).send({ error: "path must be absolute" });
    const dir = requested && requested.trim().length > 0 ? path.resolve(requested) : path.resolve(homedir());
    if (!isBrowseRoot(dir, context.allowedBrowseRoots)) {
      return reply.code(403).send({ error: "browse path is outside the allowed browse roots" });
    }
    const drives = context.allowedBrowseRoots;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return { path: dir, parent: path.dirname(dir), dirs: [], gitDirs: [], drives, error: "cannot read this location" }; }
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") &&
      !["node_modules", "windows", "$recycle.bin", "system volume information"].includes(entry.name.toLowerCase()))
      .map((entry) => entry.name).sort();
    const gitDirs = new Set<string>();
    await Promise.all(dirs.map(async (name) => {
      try { await fs.access(path.join(dir, name, ".git")); gitDirs.add(name); } catch { /* not a repo */ }
    }));
    return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs, gitDirs: [...gitDirs], drives };
  });

  app.get("/api/projects/:enc/tree", async (req, reply) => {
    const root = await repoRoot((req.params as { enc: string }).enc, reply, context);
    if (!root) return reply;
    try {
      const snapshot = await new NodeFsFacts().snapshot(root);
      return {
        files: snapshot.files.filter((file) => file.sizeBytes < 2_000_000)
          .map((file) => ({ path: file.path, language: file.language, loc: file.loc })).slice(0, 5_000),
        summary: { languages: snapshot.languages, frameworks: snapshot.frameworks.map((framework) => framework.name), totalLoc: snapshot.totalLoc, entrypoints: snapshot.entrypoints },
      };
    } catch (err) { return reply.code(400).send({ error: String(err) }); }
  });

  app.get("/api/projects/:enc/file", async (req, reply) => {
    const root = await repoRoot((req.params as { enc: string }).enc, reply, context);
    if (!root) return reply;
    const rel = (req.query as { path?: string }).path ?? "";
    let rootReal: string;
    try { rootReal = await fs.realpath(path.resolve(root)); }
    catch { return reply.code(400).send({ error: "repository not found" }); }
    const abs = path.resolve(rootReal, rel);
    if (!isPathInside(rootReal, abs)) return reply.code(400).send({ error: "path escapes the repository" });
    const real = await fs.realpath(abs).catch(() => null);
    if (real && !isPathInside(rootReal, real)) return reply.code(400).send({ error: "path escapes the repository" });
    try {
      const stat = await fs.stat(abs);
      if (stat.size > 500_000) return { path: rel, content: "(file too large to display)", truncated: true };
      return { path: rel, content: await fs.readFile(abs, "utf8"), truncated: false };
    } catch { return reply.code(404).send({ error: "file not found" }); }
  });
}
