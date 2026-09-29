import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";

const TOKEN = "test-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };

let home: string;
let app: FastifyInstance;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "vibefix-gitinit-"));
  process.env.VIBEFIX_HOME = home;
  app = await buildApp(new ProjectRegistry(), { security: { token: TOKEN } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe("opening a project without git trace", () => {
  let plainDir: string;

  beforeAll(async () => {
    plainDir = path.join(home, "no-git-project");
    await mkdir(plainDir, { recursive: true });
    await writeFile(path.join(plainDir, "index.js"), "console.log('hello');\n");
  });

  it("refuses without opt-in, with a hint about initGit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...auth, "content-type": "application/json" },
      payload: { repoPath: plainDir },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("initGit");
  });

  it("initializes a git repository with a baseline commit when initGit is set", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...auth, "content-type": "application/json" },
      payload: { repoPath: plainDir, initGit: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repoPath).toBe(plainDir);
    expect(res.json().runs).toEqual([]);
    // A real repository now exists, and the working tree is clean (baseline
    // commit) — ready for worktrees.
    const gitDir = await stat(path.join(plainDir, ".git")).then((s) => s.isDirectory()).catch(() => false);
    expect(gitDir).toBe(true);
  });

  it("subsequent opens need no initGit flag anymore", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...auth, "content-type": "application/json" },
      payload: { repoPath: plainDir },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a non-boolean initGit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...auth, "content-type": "application/json" },
      payload: { repoPath: plainDir, initGit: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});
