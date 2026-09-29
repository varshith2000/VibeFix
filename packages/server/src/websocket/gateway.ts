import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import path from "node:path";
import { runPaths } from "@vibefix/core";
import { decodePath } from "../projects.js";
import { tokenEquals } from "../auth/token-auth.js";
import { isValidRunId } from "../policies/resource-policy.js";
import type { ServerContext } from "../context.js";
import { bridgeReplayToLive } from "./replay.js";
import { SNAPSHOT_EVENTS } from "./protocol.js";

export function registerWebsocketGateway(app: FastifyInstance, context: ServerContext): void {
  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const runId = url.searchParams.get("runId") ?? undefined;
    const enc = url.searchParams.get("enc") ?? undefined;
    const sinceValue = Number(url.searchParams.get("since") ?? 0);
    const since = Number.isFinite(sinceValue) ? sinceValue : 0;
    const send = (data: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
    };
    const presented = url.searchParams.get("token") ??
      (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice(7) : null);
    if (!runId || !enc || !isValidRunId(runId)) {
      socket.close?.(4000, "runId and enc (project) are required");
      return;
    }
    if (!presented || !tokenEquals(presented, context.apiToken)) {
      socket.close?.(4401, "unauthorized");
      return;
    }
    const repoPath = decodePath(enc);
    if (!path.isAbsolute(repoPath)) {
      socket.close?.(4000, "invalid project path");
      return;
    }
    const entry = context.registry.runtimeForProject(runId, repoPath);
    if (!entry) {
      const runDir = runPaths(repoPath, runId).runDir;
      void Promise.all([context.diskState(runDir), context.diskReplay(runDir, since)]).then(([state, replay]) => {
        if (state?.ok) send({ t: "snapshot", state: state.state });
        else if (state && !state.ok) send({ t: "degraded", reason: `run state degraded: ${state.reason}` });
        for (const event of replay.events) send({ t: "event", event, seq: event.seq });
        if (replay.corruptLines > 0) send({ t: "degraded", reason: `${replay.corruptLines} corrupt event line(s) were skipped`, corruptLineCount: replay.corruptLines });
        send({ t: "readonly", runId });
      });
      return;
    }
    const runtime = entry.runtime;
    send({ t: "snapshot", state: runtime.snapshot() });
    if (runtime.events.degraded) {
      send({
        t: "degraded",
        reason: `${runtime.events.persistenceFailures} event(s) were emitted but never persisted — replay after restart may be incomplete`,
        persistenceFailures: runtime.events.persistenceFailures,
      });
    }
    const unsubscribe = bridgeReplayToLive({
      source: runtime.events,
      since,
      send,
      onLiveEvent: (event) => {
        if (SNAPSHOT_EVENTS.has(event.type)) {
          send({ t: "snapshot", state: runtime.snapshot() });
          send({ t: "usage", usage: runtime.usage });
        }
      },
    });
    socket.on("close", () => unsubscribe());
  });
}
