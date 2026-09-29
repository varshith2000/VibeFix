import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { CloneProjectRequestSchema, OpenProjectRequestSchema, RepoConfigSchema, parseRequestBody } from "@vibefix/schemas";
import { clonesDir, loadRepoConfig, saveRepoConfig } from "@vibefix/core";
import { runCommand } from "@vibefix/adapters";
import { encodePath } from "../projects.js";
import { credentialFileBody, parseCloneUrl, scrubSecret } from "../policies/resource-policy.js";
import type { ServerContext } from "../context.js";

export function registerProjectRoutes(app: FastifyInstance, context: ServerContext): void {
  const { registry } = context;
  app.post<{ Body: { url: string; token?: string } }>("/api/projects/clone", async (req, reply) => {
    const body = parseRequestBody(CloneProjectRequestSchema, req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid request body", issues: body.issues });
    const { url, token } = body.data;
    const parsed = parseCloneUrl(url);
    if (!parsed) return reply.code(400).send({ error: "provide an HTTPS GitHub URL like https://github.com/owner/repo" });
    if (token !== undefined && (typeof token !== "string" || token.length === 0 || token.length > 4096)) {
      return reply.code(400).send({ error: "invalid token" });
    }
    const ip = req.ip ?? "unknown";
    if (!context.cloneLimiter.allow(ip)) {
      return reply.code(429).header("retry-after", String(context.cloneLimiter.retryAfterSeconds(ip)))
        .send({ error: "too many clone requests — try again shortly" });
    }
    if (!context.reserveClone()) return reply.code(429).send({ error: "a clone is already in progress — try again when it finishes" });
    let credFile: string | null = null;
    try {
      await fs.mkdir(clonesDir(), { recursive: true });
      const base = `${parsed.owner}-${parsed.name}`;
      let target: string | null = null;
      for (let n = 1; n <= 999; n++) {
        const candidate = path.join(clonesDir(), n === 1 ? base : `${base}-${n}`);
        try {
          await fs.mkdir(candidate, { recursive: false });
          target = candidate;
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      if (!target) return reply.code(500).send({ error: "cannot allocate a clone directory" });
      const args = ["clone"];
      const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
      if (token) {
        credFile = path.join(clonesDir(), `.credentials-${process.pid}-${randomUUID()}`);
        await fs.writeFile(credFile, credentialFileBody(parsed.host, token), { mode: 0o600 });
        args.push("-c", "credential.helper=", "-c", `credential.helper=store --file=${credFile}`);
      }
      args.push(`https://${parsed.host}/${parsed.owner}/${parsed.name}`, target);
      const result = await runCommand("git", args, { cwd: clonesDir(), timeoutMs: 600_000, env });
      if (result.code !== 0) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        return reply.code(400).send({ error: `git clone failed: ${scrubSecret(result.stderr.slice(0, 300), token)}` });
      }
      return { repoPath: target, name: path.basename(target) };
    } finally {
      context.releaseClone();
      if (credFile) await fs.rm(credFile, { force: true }).catch(() => undefined);
    }
  });

  app.post<{ Body: { repoPath: string; initGit?: boolean } }>("/api/projects", async (req, reply) => {
    const body = parseRequestBody(OpenProjectRequestSchema, req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid request body", issues: body.issues });
    const { repoPath, initGit } = body.data;
    if (!repoPath || !path.isAbsolute(repoPath)) return reply.code(400).send({ error: "absolute repoPath is required" });
    try {
      const manager = await registry.open(repoPath, { initIfMissing: initGit === true });
      const runs = await manager.listRuns();
      return {
        repoPath: manager.repoPath,
        encoded: encodePath(manager.repoPath),
        runs: runs.map((run) => ({ runId: run.runId, status: run.state.status, phase: run.state.phase, createdAt: run.state.createdAt })),
      };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get("/api/projects/:enc/config", async (req, reply) => {
    const repoPath = context.decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    try { return await loadRepoConfig(repoPath); }
    catch (err) { return reply.code(500).send({ error: String(err) }); }
  });

  app.put("/api/projects/:enc/config", async (req, reply) => {
    const repoPath = context.decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    try {
      const body = parseRequestBody(RepoConfigSchema, req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid request body", issues: body.issues });
      await saveRepoConfig(repoPath, body.data);
      registry.peek(repoPath)?.updateConfig(body.data);
      return { ok: true };
    } catch (err) { return reply.code(400).send({ error: String(err) }); }
  });
}