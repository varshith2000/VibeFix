import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentExecutionEvent } from "@vibefix/schemas";
import { buildApp } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";
import { EventLog, runPaths, type OrchestratorRuntime } from "@vibefix/core";
import { bridgeReplayToLive } from "../src/ws-replay.js";

const TOKEN = "test-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };

let home: string;
let app: FastifyInstance;
let registry: ProjectRegistry;

const b64 = (p: string) => Buffer.from(p, "utf8").toString("base64url");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal runtime double for endpoint-level tests. */
function fakeRuntime(overrides: {
  runId: string;
  repoPath: string;
  phase?: string;
  status?: string;
  dispatch?: (event: { type: string } & Record<string, unknown>) => Promise<void>;
  events?: Pick<EventLog, "subscribe" | "eventsSince">;
}): OrchestratorRuntime {
  let phase = overrides.phase ?? "awaitingApproval";
  let status = overrides.status ?? "awaitingApproval";
  const dispatchCalls: Array<{ type: string } & Record<string, unknown>> = [];
  const runtime = {
    runId: overrides.runId,
    snapshot: () => ({ runId: overrides.runId, phase, status, mode: "minimal" }),
    store: { latest: async () => null, list: async () => [] },
    dispatch: async (event: { type: string } & Record<string, unknown>) => {
      dispatchCalls.push(event);
      if (overrides.dispatch) return overrides.dispatch(event);
      if (event.type === "CHECKPOINT_APPROVED") {
        phase = "harness";
        status = "running";
      }
      if (event.type === "ABORT") status = "aborted";
      if (event.type === "FATAL") status = "failed";
    },
    resume: async () => undefined,
    usage: { total: 0, byAgent: {}, byProvider: {} },
    events:
      overrides.events ??
      ({
        subscribe: () => () => undefined,
        eventsSince: async () => [],
        replaySince: async () => ({ events: [], corruptLines: 0 }),
        persistenceFailures: 0,
        degraded: false,
      } as unknown as EventLog),
    // When a real event bus is supplied, react to terminal events like the
    // reducer would (the registry's cleanup checks the snapshot status).
    ...(overrides.events
      ? {
          __hook: overrides.events.subscribe?.((event: AgentExecutionEvent) => {
            if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.aborted" || event.type === "run.nochanges") {
              status = event.type === "run.failed" ? "failed" : event.type === "run.aborted" ? "aborted" : "completed";
              phase = "completed";
            }
          }),
        }
      : {}),
    __dispatchCalls: dispatchCalls,
  };
  return runtime as unknown as OrchestratorRuntime & { __dispatchCalls: typeof dispatchCalls };
}

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "vibefix-rc-"));
  process.env.VIBEFIX_HOME = home;
  registry = new ProjectRegistry();
  app = await buildApp(registry, { security: { token: TOKEN } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe("approval failure surfacing (no more silent ok:true)", () => {
  it("returns 500 when the dispatch itself fails", async () => {
    const repo = path.join(home, "repoA");
    const rt = fakeRuntime({
      runId: "run_approvefail1",
      repoPath: repo,
      dispatch: async () => {
        throw new Error("persist exploded");
      },
    });
    registry.registerRuntime(rt, repo);
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${b64(repo)}/runs/run_approvefail1/approve`,
      headers: { ...auth, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("persist exploded");
  });
});

describe("idempotency keys (approve / abort / resume)", () => {
  it("replays the original response for a repeated approve with the same key", async () => {
    const repo = path.join(home, "repoB");
    const rt = fakeRuntime({ runId: "run_idemapprove1", repoPath: repo });
    registry.registerRuntime(rt, repo);
    const url = `/api/projects/${b64(repo)}/runs/run_idemapprove1/approve`;
    const headers = { ...auth, "content-type": "application/json", "idempotency-key": "key-123" };

    const first = await app.inject({ method: "POST", url, headers, payload: { mode: "minimal" } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();

    const second = await app.inject({ method: "POST", url, headers, payload: { mode: "minimal" } });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(second.json()).toEqual(first.json());

    // The double fake runtime records every dispatch: exactly ONE approval.
    expect((rt as never as { __dispatchCalls: unknown[] }).__dispatchCalls.filter((c) => c.type === "CHECKPOINT_APPROVED")).toHaveLength(1);
  });

  it("without a key, a duplicate approve is a clean conflict (phase guard), not a double dispatch", async () => {
    const repo = path.join(home, "repoC");
    const rt = fakeRuntime({ runId: "run_idemapprove2", repoPath: repo });
    registry.registerRuntime(rt, repo);
    const url = `/api/projects/${b64(repo)}/runs/run_idemapprove2/approve`;
    const headers = { ...auth, "content-type": "application/json" };

    const first = await app.inject({ method: "POST", url, headers, payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url, headers, payload: {} });
    expect(second.statusCode).toBe(409);
    expect((rt as never as { __dispatchCalls: unknown[] }).__dispatchCalls.filter((c) => c.type === "CHECKPOINT_APPROVED")).toHaveLength(1);
  });

  it("abort honors idempotency keys too", async () => {
    const repo = path.join(home, "repoD");
    const rt = fakeRuntime({ runId: "run_idemabort01", repoPath: repo, phase: "diagnosis", status: "running" });
    registry.registerRuntime(rt, repo);
    const url = `/api/projects/${b64(repo)}/runs/run_idemabort01/abort`;
    const headers = { ...auth, "idempotency-key": "abort-key-1" };

    const first = await app.inject({ method: "POST", url, headers });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url, headers });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect((rt as never as { __dispatchCalls: unknown[] }).__dispatchCalls.filter((c) => c.type === "ABORT")).toHaveLength(1);
  });
});

describe("background failures are persisted, not swallowed", () => {
  it("track() force-fails the run via FATAL and records the failure", async () => {
    const repo = path.join(home, "repoE");
    const rt = fakeRuntime({ runId: "run_trackfail01", repoPath: repo, phase: "recon", status: "running" });
    registry.registerRuntime(rt, repo);

    await registry.track("run_trackfail01", Promise.reject(new Error("disk died mid-run")));
    await registry.settle("run_trackfail01");

    const calls = (rt as never as { __dispatchCalls: Array<{ type: string; message?: string }> }).__dispatchCalls;
    const fatal = calls.find((c) => c.type === "FATAL");
    expect(fatal).toBeDefined();
    expect(fatal?.message).toContain("disk died mid-run");
    expect(registry.failureFor("run_trackfail01")?.message).toContain("disk died mid-run");
  });

  it("health endpoint reports the background failure count", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().backgroundFailures).toBeGreaterThanOrEqual(1);
  });
});

describe("terminal runtimes are unregistered", () => {
  it("drops the runtime after run.completed (once background work settles)", async () => {
    const repo = path.join(home, "repoF");
    const dir = path.join(home, "runsF");
    await mkdir(dir, { recursive: true });
    const log = new EventLog({ eventsFile: path.join(dir, "events.ndjson") } as never);
    const rt = fakeRuntime({ runId: "run_unregterm01", repoPath: repo, phase: "report", status: "running", events: log });
    registry.registerRuntime(rt, repo);
    expect(registry.runtime("run_unregterm01")).toBeDefined();

    await log.append("run_unregterm01", "run.completed", { message: "done" });
    await wait(25); // drop() waits for the (empty) background chain, then deletes

    expect(registry.runtime("run_unregterm01")).toBeUndefined();
  });

  it("drops a runtime that is ALREADY terminal at registration (viewing an old run)", async () => {
    const repo = path.join(home, "repoG");
    const rt = fakeRuntime({ runId: "run_unregterm02", repoPath: repo, phase: "completed", status: "completed" });
    registry.registerRuntime(rt, repo);
    await wait(25);
    expect(registry.runtime("run_unregterm02")).toBeUndefined();
  });
});

describe("websocket replay/subscribe ordering", () => {
  it("delivers every event exactly once, including ones appended DURING replay", async () => {
    // Real EventLog over a real file — same code the server bridges.
    const bridgePaths = runPaths(path.join(home, "repoH"), "run_wsbridge001");
    await mkdir(path.dirname(bridgePaths.eventsFile), { recursive: true });
    const log = new EventLog(bridgePaths);
    await log.append("run_wsbridge001", "agent.started", { agentId: "cartographer" });
    await log.append("run_wsbridge001", "agent.completed", { agentId: "cartographer" });

    const frames: Array<{ t: string; seq?: number }> = [];
    const unsubscribe = bridgeReplayToLive({
      source: log,
      since: 0,
      send: (frame) => frames.push(frame as { t: string; seq?: number }),
    });
    // Events appended while the replay query is still in flight — these used
    // to be lost with the replay-then-subscribe ordering.
    await log.append("run_wsbridge001", "agent.started", { agentId: "historian" });
    await log.append("run_wsbridge001", "agent.completed", { agentId: "historian" });
    await wait(25);

    const eventFrames = frames.filter((f) => f.t === "event");
    const seqs = eventFrames.map((f) => f.seq);
    expect(seqs).toEqual([1, 2, 3, 4]); // none lost, none duplicated, in order
    unsubscribe();
  });
});

describe("explicit recovery degradation", () => {
  it("counts corrupt event lines instead of silently skipping them", async () => {
    const repo = path.join(home, "repoI");
    const runDir = runPaths(repo, "run_degraded001").runDir;
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "events.ndjson"),
      [
        JSON.stringify({ eventId: "e1", seq: 1, type: "agent.started" }),
        "{corrupt json !!!",
        JSON.stringify({ eventId: "e2", seq: 2, type: "agent.completed" }),
      ].join("\n") + "\n",
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(repo)}/runs/run_degraded001/events?since=0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(2);
    expect(body.corruptLineCount).toBe(1);
    expect(body.replayDegraded).toBe(true);
  });

  it("reports a corrupt state.json as degraded 500, not a silent 404", async () => {
    const repo = path.join(home, "repoJ");
    const runDir = runPaths(repo, "run_degraded002").runDir;
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "state.json"), "{ this is not json");
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(repo)}/runs/run_degraded002`,
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().degraded).toBe(true);
    expect(res.json().error).toContain("corrupt");
  });

  it("flags live events that were never persisted (persistence failure)", async () => {
    const repo = path.join(home, "repoK");
    // Point the log at a directory that does not exist: appends fail, but the
    // in-memory bus still delivers — the run must be reported as degraded.
    const log = new EventLog({ eventsFile: path.join(home, "no", "such", "dir", "events.ndjson") } as never);
    await log.append("run_degraded003", "agent.progress", { message: "emitted but not persisted" });
    expect(log.persistenceFailures).toBe(1);

    const rt = fakeRuntime({ runId: "run_degraded003", repoPath: repo, phase: "recon", status: "running", events: log });
    registry.registerRuntime(rt, repo);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${b64(repo)}/runs/run_degraded003/events?since=0`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().replayDegraded).toBe(true);
    expect(res.json().persistenceFailures).toBeGreaterThanOrEqual(1);
  });
});
