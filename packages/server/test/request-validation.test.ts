import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";
import type { OrchestratorRuntime } from "@vibefix/core";

const TOKEN = "request-validation-test-token";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let home: string;
let app: FastifyInstance;
let registry: ProjectRegistry;

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "vibefix-request-validation-"));
  process.env.VIBEFIX_HOME = home;
  registry = new ProjectRegistry();
  app = await buildApp(registry, { security: { token: TOKEN } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.VIBEFIX_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("request body validation", () => {
  it("rejects malformed clone and project registration bodies with field paths", async () => {
    const clone = await app.inject({ method: "POST", url: "/api/projects/clone", headers: auth, payload: { url: 12 } });
    expect(clone.statusCode).toBe(400);
    expect(clone.json().issues).toContainEqual(expect.objectContaining({ path: "url" }));

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { repoPath: path.join(home, "repo"), initGit: "yes" },
    });
    expect(project.statusCode).toBe(400);
    expect(project.json().issues).toContainEqual(expect.objectContaining({ path: "initGit" }));
  });

  it("rejects unknown and invalid approval fields before dispatch", async () => {
    let dispatches = 0;
    const repoPath = path.join(home, "approval-repo");
    const runtime = {
      runId: "run_validation001",
      snapshot: () => ({ runId: "run_validation001", phase: "awaitingApproval", status: "awaitingApproval", mode: "minimal" }),
      dispatch: async () => { dispatches += 1; },
      store: { latest: async () => null },
    } as unknown as OrchestratorRuntime;
    registry.registerRuntime(runtime, repoPath);

    const payload = JSON.stringify({ mode: "unsafe", approvedProposalIds: [42], unexpected: true });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${b64(repoPath)}/runs/run_validation001/approve`,
      headers: auth,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "mode" }),
      expect.objectContaining({ path: "approvedProposalIds.0" }),
      expect.objectContaining({ path: "unexpected" }),
    ]));
    expect(dispatches).toBe(0);
  });

  it("rejects an explicitly supplied __proto__ field", async () => {
    const body = JSON.stringify({ repoPath: path.join(home, "repo"), ["__proto__"]: { polluted: true } });
    const response = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: body });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Bad Request");
  });
});