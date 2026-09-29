import type { FastifyInstance } from "fastify";
import { AGENT_DEFINITIONS } from "@vibefix/agents";
import type { ServerContext } from "../context.js";

export function registerHealthRoutes(app: FastifyInstance, { registry }: ServerContext): void {
  app.get("/api/health", async () => ({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    activeRuntimes: registry.activeRuntimeCount(),
    backgroundFailures: registry.backgroundFailureCount(),
  }));
  app.get("/api/agents", async () => AGENT_DEFINITIONS);
}