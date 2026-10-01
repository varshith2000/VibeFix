import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";
import { projectKey, runPaths } from "@vibefix/core";
import {
  assertBindingAllowed,
  credentialFileBody,
  getApiToken,
  isPathInside,
  isValidRunId,
  parseCloneUrl,
  scrubSecret,
  tokenEquals,
  tokenFilePath,
} from "../src/security.js";

const TOKEN = "test-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };

let home: string;
let app: FastifyInstance;

const b64 = (p: string) => Buffer.from(p, "utf8").toString("base64url");

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "vibefix-sec-"));
  process.env.VIBEFIX_HOME = home;
  app = await buildApp(new ProjectRegistry(), { security: { token: TOKEN } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe("authentication", () => {
  it("rejects requests without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: { authorization: "Bearer nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the correct token via Bearer header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("accepts the correct token via X-VibeFix-Token header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: { "x-vibefix-token": TOKEN } });
    expect(res.statusCode).toBe(200);
  });

  it("keeps the health probe public (liveness without credentials)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("healthy");
  });

  it("tokenEquals handles length mismatches without throwing", () => {
    expect(tokenEquals("short", TOKEN)).toBe(false);
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects an unauthenticated real WebSocket upgrade", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const wsUrl = address.replace(/^http/, "ws") + `/ws?runId=run_socketauth01&enc=${b64(home)}`;
      const result = await new Promise<number | string>((resolve) => {
        const socket = new WebSocket(wsUrl);
        const timer = setTimeout(() => { socket.terminate(); resolve("timeout"); }, 3_000);
        socket.once("unexpected-response", (_request, response) => {
          clearTimeout(timer);
          resolve(response.statusCode);
        });
        socket.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        socket.once("error", () => {
          // Fastify may reject the upgrade before a WebSocket close frame.
          clearTimeout(timer);
          resolve("error");
        });
      });
      expect([401, 4401, "error"]).toContain(result);
    } finally {
      await app.close();
      app = await buildApp(new ProjectRegistry(), { security: { token: TOKEN } });
      await app.ready();
    }
  });
});

describe("origin enforcement (DNS rebinding / CSRF)", () => {
  it("blocks requests carrying a foreign Origin header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows the configured UI origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows non-browser clients (no Origin header)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("CORS preflight only advertises the allowed origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/agents",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});

describe("filesystem path containment", () => {
  let project: string;
  let sibling: string;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-paths-"));
    project = path.join(root, "project");
    sibling = path.join(root, "project-secrets");
    await mkdir(project, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(project, "a.txt"), "inside");
    await writeFile(path.join(sibling, "secret.txt"), "SECRET");
  });

  it("serves a file inside the repository", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(project)}/file?path=${encodeURIComponent("a.txt")}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe("inside");
  });

  it("rejects ../ traversal out of the repository", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(project)}/file?path=${encodeURIComponent("../project-secrets/secret.txt")}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not serve the prefix-collision sibling (project vs project-secrets)", async () => {
    // A naive startsWith() check would PASS the "../project-secrets" form of
    // this URL — that traversal case is pinned above. This form resolves to a
    // (nonexistent) child INSIDE the repo and must simply not find a file —
    // either way the sibling's content is unreachable.
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(project)}/file?path=${encodeURIComponent(path.basename(sibling) + "/secret.txt")}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("SECRET");
  });

  it("rejects absolute paths outside the repository", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(project)}/file?path=${encodeURIComponent(path.join(sibling, "secret.txt"))}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a nonexistent repository path", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(path.join(project, "does-not-exist"))}/file?path=a.txt`,
      headers: auth,
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("isPathInside is a containment check, not a prefix check", () => {
    expect(isPathInside(project, path.join(project, "a.txt"))).toBe(true);
    expect(isPathInside(project, sibling)).toBe(false);
    expect(isPathInside(project, project)).toBe(false);
  });
});

describe("filesystem browse roots", () => {
  it("rejects browsing outside explicitly allowed roots", async () => {
    const restricted = await buildApp(new ProjectRegistry(), {
      security: { token: TOKEN, allowedBrowseRoots: [home] },
    });
    await restricted.ready();
    try {
      const res = await restricted.inject({
        method: "GET",
        url: `/api/fs/browse?path=${encodeURIComponent(path.dirname(home))}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await restricted.close();
    }
  });
});

describe("project-scoped runs", () => {
  let repoA: string;
  let repoB: string;
  const runId = "run_testscoping01";

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-runs-"));
    repoA = path.join(root, "repo-a");
    repoB = path.join(root, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    // Durable run on disk for repoA only.
    const runDir = runPaths(repoA, runId).runDir;
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "state.json"), JSON.stringify({ runId, status: "completed" }));
    await writeFile(
      path.join(runDir, "events.ndjson"),
      JSON.stringify({ eventId: "e1", seq: 1, type: "agent.started" }) + "\n",
    );
  });

  it("serves a run through its own project", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${b64(repoA)}/runs/${runId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().runId).toBe(runId);
  });

  it("serves disk events through the scoped route", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(repoA)}/runs/${runId}/events?since=0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
  });

  it("does NOT serve repoA's run through repoB's URL", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${b64(repoB)}/runs/${runId}`, headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("cannot mutate (approve) another project's run either", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/${b64(repoB)}/runs/${runId}/approve`, headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("rejects malformed run ids (traversal / bad shape)", async () => {
    for (const bad of ["..%2F..%2Fstate", "run_abc", "notarun", "run_" + "x".repeat(65)]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${b64(repoA)}/runs/${bad}`,
        headers: auth,
      });
      // 400 = rejected by our validator, 404 = rejected by the router before
      // it could even match — either way the property holds: never a 200.
      expect([400, 404]).toContain(res.statusCode);
    }
  });

  it("isValidRunId pins the shape our id generator produces", () => {
    expect(isValidRunId("run_abc123")).toBe(true);
    expect(isValidRunId("run_ab")).toBe(false);
    expect(isValidRunId("../etc/passwd")).toBe(false);
    expect(isValidRunId("run_with-dash")).toBe(false);
  });

  it("projectKey is stable for the same path", () => {
    expect(projectKey(repoA)).toBe(projectKey(repoA));
    expect(projectKey(repoA)).not.toBe(projectKey(repoB));
  });
});

describe("git clone credential handling", () => {
  it("parseCloneUrl accepts plain GitHub URLs (.git optional)", () => {
    expect(parseCloneUrl("https://github.com/owner/repo")).toMatchObject({ owner: "owner", name: "repo" });
    expect(parseCloneUrl("https://www.github.com/owner/repo.git")).toMatchObject({ owner: "owner", name: "repo" });
  });

  it("parseCloneUrl rejects non-HTTPS, foreign hosts, and malformed paths", () => {
    expect(parseCloneUrl("http://github.com/owner/repo")).toBeNull();
    expect(parseCloneUrl("https://gitlab.com/owner/repo")).toBeNull();
    expect(parseCloneUrl("https://github.com/owner")).toBeNull();
    expect(parseCloneUrl("https://github.com/owner/repo/extra")).toBeNull();
    expect(parseCloneUrl("not a url")).toBeNull();
    expect(parseCloneUrl("https://github.com/own%20er/repo")).toBeNull();
  });

  it("parseCloneUrl rejects URLs with embedded credentials", () => {
    // These would otherwise smuggle a secret straight into the git argv.
    expect(parseCloneUrl("https://x-access-token:ghp_secret@github.com/owner/repo")).toBeNull();
    expect(parseCloneUrl("https://ghp_secret@github.com/owner/repo")).toBeNull();
  });

  it("scrubSecret removes the token from any text", () => {
    expect(scrubSecret("fatal: bad token ghp_abc123 stuff", "ghp_abc123")).not.toContain("ghp_abc123");
    expect(scrubSecret("no secrets here", "ghp_abc123")).toBe("no secrets here");
  });

  it("credentialFileBody matches the git-credential-store format", () => {
    const body = credentialFileBody("github.com", "ghp_tok");
    expect(body).toBe("protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghp_tok\n");
  });

  it("clone endpoint validates the URL before doing anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/clone",
      headers: { ...auth, "content-type": "application/json" },
      payload: { url: "https://gitlab.com/owner/repo" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("rate limiting", () => {
  it("returns 429 once the window is exhausted", async () => {
    const limited = await buildApp(new ProjectRegistry(), {
      security: { token: TOKEN, requestsPerMinute: 3 },
    });
    await limited.ready();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await limited.inject({ method: "GET", url: "/api/agents", headers: auth });
      codes.push(res.statusCode);
    }
    await limited.close();
    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});

describe("run ceiling (resource limit)", () => {
  it("refuses to exceed the configured max concurrent runs", async () => {
    // Direct registry manipulation: pretend one run is already active.
    const registry = new ProjectRegistry();
    const limited = await buildApp(registry, { security: { token: TOKEN, maxConcurrentRuns: 1 } });
    await limited.ready();
    const fakeRuntime = {
      runId: "run_fakefakefake",
      snapshot: () => ({ status: "running" }),
    } as never;
    registry.registerRuntime(fakeRuntime, path.join(home, "some-repo"));
    const res = await limited.inject({
      method: "POST",
      url: `/api/projects/${b64(path.join(home, "some-repo"))}/runs`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { mode: "minimal" },
    });
    await limited.close();
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("run ceiling");
  });
});

describe("binding guard", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ["VIBEFIX_ALLOW_REMOTE", "VIBEFIX_API_TOKEN"]) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("allows loopback binds without opt-in", () => {
    expect(() => assertBindingAllowed("127.0.0.1")).not.toThrow();
    expect(() => assertBindingAllowed("localhost")).not.toThrow();
    expect(() => assertBindingAllowed("::1")).not.toThrow();
  });

  it("refuses non-loopback binds by default", () => {
    expect(() => assertBindingAllowed("0.0.0.0")).toThrow(/refusing to bind/);
  });

  it("refuses non-loopback even with opt-in but no explicit token", () => {
    process.env.VIBEFIX_ALLOW_REMOTE = "1";
    delete process.env.VIBEFIX_API_TOKEN;
    expect(() => assertBindingAllowed("0.0.0.0")).toThrow(/refusing to bind/);
  });

  it("allows non-loopback only with opt-in AND a strong token", () => {
    process.env.VIBEFIX_ALLOW_REMOTE = "1";
    process.env.VIBEFIX_API_TOKEN = "a-strong-explicit-token";
    expect(() => assertBindingAllowed("0.0.0.0")).not.toThrow();
  });
});

describe("API token persistence", () => {
  it("generates once, then reuses the persisted value", async () => {
    const t1 = await getApiToken();
    expect(t1.length).toBeGreaterThanOrEqual(16);
    const persisted = (await readFile(tokenFilePath(), "utf8")).trim();
    expect(persisted).toBe(t1);
    const t2 = await getApiToken();
    expect(t2).toBe(t1);
  });

  it("VIBEFIX_API_TOKEN always wins over the file", async () => {
    const saved = process.env.VIBEFIX_API_TOKEN;
    process.env.VIBEFIX_API_TOKEN = "env-token-override-123456";
    try {
      expect(await getApiToken()).toBe("env-token-override-123456");
    } finally {
      if (saved === undefined) delete process.env.VIBEFIX_API_TOKEN;
      else process.env.VIBEFIX_API_TOKEN = saved;
    }
  });
});
