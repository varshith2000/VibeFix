import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { CloneProjectRequestSchema, OpenProjectRequestSchema, RepoConfigSchema, parseRequestBody } from "@vibefix/schemas";
import { WorktreeManager, clonesDir, loadRepoConfig, projectDir, saveRepoConfig, vibefixHome } from "@vibefix/core";
import { runCommand } from "@vibefix/adapters";
import { encodePath } from "../projects.js";
import { isPathInside } from "../policies/path-policy.js";
import { credentialFileBody, parseCloneUrl, scrubSecret } from "../policies/resource-policy.js";
import type { ServerContext } from "../context.js";

export function registerProjectRoutes(app: FastifyInstance, context: ServerContext): void {
  const { registry } = context;
  app.post<{ Body: { url: string; token?: string } }>("/api/projects/clone", async (req, reply) => {
    const body = parseRequestBody(CloneProjectRequestSchema, req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid request body", code: "E_INVALID_BODY", issues: body.issues });
    const { url, token } = body.data;
    const parsed = parseCloneUrl(url);
    if (!parsed) {
      await context.audit({ action: "project.clone", result: "denied", errorCode: "E_INVALID_URL", detail: url });
      return reply.code(400).send({ error: "provide an HTTPS GitHub URL like https://github.com/owner/repo" });
    }
    if (token !== undefined && (typeof token !== "string" || token.length === 0 || token.length > 4096)) {
      return reply.code(400).send({ error: "invalid token" });
    }
    const homeDir = process.env.VIBEFIX_HOME ?? vibefixHome();
    const diskBytes = await context.measureDirectoryBytes(homeDir, new Set());
    if (diskBytes >= context.maxDiskBytes) {
      await context.audit({ action: "project.clone", result: "denied", errorCode: "E_DISK_BUDGET" });
      return reply.code(507).send({
        error: `E_DISK_BUDGET: VibeFix workspace usage (${diskBytes} bytes) reached limit (${context.maxDiskBytes} bytes) — delete old runs or run retention sweep`,
        code: "E_DISK_BUDGET",
      });
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
        const scrubbed = scrubSecret(result.stderr.slice(0, 300), token);
        await context.audit({ action: "project.clone", result: "error", errorCode: "E_CLONE_FAILED", detail: scrubbed });
        return reply.code(400).send({ error: `git clone failed: ${scrubbed}` });
      }
      await context.audit({ action: "project.clone", result: "ok", projectId: target });
      return { repoPath: target, name: path.basename(target) };
    } finally {
      context.releaseClone();
      if (credFile) await fs.rm(credFile, { force: true }).catch(() => undefined);
    }
  });

  app.post<{ Body: { repoPath: string; initGit?: boolean } }>("/api/projects", async (req, reply) => {
    const body = parseRequestBody(OpenProjectRequestSchema, req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid request body", code: "E_INVALID_BODY", issues: body.issues });
    const { repoPath, initGit } = body.data;
    if (!repoPath || !path.isAbsolute(repoPath)) return reply.code(400).send({ error: "absolute repoPath is required" });
    const repoBytes = await context.measureDirectoryBytes(repoPath);
    if (repoBytes > context.maxRepoBytes) {
      await context.audit({ action: "project.open", result: "denied", projectId: repoPath, errorCode: "E_REPO_TOO_LARGE" });
      return reply.code(400).send({
        error: `E_REPO_TOO_LARGE: repository size (${repoBytes} bytes) exceeds limit (${context.maxRepoBytes} bytes)`,
        code: "E_REPO_TOO_LARGE",
      });
    }
    try {
      const manager = await registry.open(repoPath, { initIfMissing: initGit === true });
      const runs = await manager.listRuns();
      await context.audit({ action: "project.open", result: "ok", projectId: manager.repoPath });
      return {
        repoPath: manager.repoPath,
        encoded: encodePath(manager.repoPath),
        runs: runs.map((run) => ({ runId: run.runId, status: run.state.status, phase: run.state.phase, createdAt: run.state.createdAt })),
      };
    } catch (err) {
      await context.audit({ action: "project.open", result: "error", projectId: repoPath, detail: String(err) });
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
      if (!body.success) return reply.code(400).send({ error: "invalid request body", code: "E_INVALID_BODY", issues: body.issues });
      await saveRepoConfig(repoPath, body.data);
      registry.peek(repoPath)?.updateConfig(body.data);
      await context.audit({ action: "config.update", result: "ok", projectId: repoPath });
      return { ok: true };
    } catch (err) { return reply.code(400).send({ error: String(err) }); }
  });

  app.post("/api/projects/:enc/sweep", async (req, reply) => {
    const repoPath = context.decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    const maxRunsQuery = Number((req.query as { maxRuns?: string }).maxRuns ?? context.retentionMaxRuns);
    const maxRuns = Number.isFinite(maxRunsQuery) && maxRunsQuery >= 0 ? maxRunsQuery : context.retentionMaxRuns;
    const { removedRuns } = await context.sweepRetention(repoPath, maxRuns);
    await context.audit({ action: "retention.sweep", result: "ok", projectId: repoPath, detail: `removed ${removedRuns.length} run(s)` });
    return { ok: true, removedRuns };
  });

  app.delete("/api/projects/:enc", async (req, reply) => {
    const repoPath = context.decodeProject((req.params as { enc: string }).enc, reply);
    if (!repoPath) return reply;
    try {
      await new WorktreeManager(repoPath).cleanupAll().catch(() => undefined);
      registry.removeProject(repoPath);
      const pDir = projectDir(repoPath);
      await fs.rm(pDir, { recursive: true, force: true });
      if (isPathInside(clonesDir(), repoPath)) {
        await fs.rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
      }
      await context.audit({ action: "project.delete", result: "ok", projectId: repoPath });
      return { ok: true };
    } catch (err) {
      await context.audit({ action: "project.delete", result: "error", projectId: repoPath, errorCode: "E_DELETE_PARTIAL", detail: String(err) });
      return reply.code(500).send({ error: String(err), code: "E_DELETE_PARTIAL" });
    }
  });
}
