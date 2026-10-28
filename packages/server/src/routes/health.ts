import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { AGENT_DEFINITIONS } from "@vibefix/agents";
import { vibefixHome } from "@vibefix/core";
import { redactUnknown } from "@vibefix/schemas";
import type { ServerContext } from "../context.js";

const require = createRequire(import.meta.url);
let SERVER_VERSION = "0.1.0";
try {
  const pkg = require("../../package.json") as { version?: string };
  if (typeof pkg.version === "string" && pkg.version.length > 0) {
    SERVER_VERSION = pkg.version;
  }
} catch {
  // fallback
}

export function registerHealthRoutes(app: FastifyInstance, context: ServerContext): void {
  const { registry } = context;

  app.get("/api/health", async () => ({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: SERVER_VERSION,
    activeRuntimes: registry.activeRuntimeCount(),
    backgroundFailures: registry.backgroundFailureCount(),
  }));

  app.get("/api/ready", async () => ({
    status: "ready",
    timestamp: new Date().toISOString(),
    version: SERVER_VERSION,
    activeRuns: registry.activeRunCount(),
    maxConcurrentRuns: context.maxConcurrentRuns,
  }));

  app.get("/api/metrics", async () => {
    const homeDir = process.env.VIBEFIX_HOME ?? vibefixHome();
    const diskUsageBytes = await context.measureDirectoryBytes(homeDir, new Set());
    return {
      timestamp: new Date().toISOString(),
      activeRuntimes: registry.activeRuntimeCount(),
      activeRuns: registry.activeRunCount(),
      backgroundFailures: registry.backgroundFailureCount(),
      diskUsageBytes,
      maxDiskBytes: context.maxDiskBytes,
      maxConcurrentRuns: context.maxConcurrentRuns,
    };
  });

  app.get("/api/diagnostics", async () => {
    const homeDir = process.env.VIBEFIX_HOME ?? vibefixHome();
    const diskUsageBytes = await context.measureDirectoryBytes(homeDir, new Set());
    const auditLog = await context.readAuditLog();
    return redactUnknown({
      generatedAt: new Date().toISOString(),
      version: SERVER_VERSION,
      platform: process.platform,
      nodeVersion: process.version,
      activeRuntimes: registry.activeRuntimeCount(),
      activeRuns: registry.activeRunCount(),
      backgroundFailures: registry.backgroundFailureCount(),
      diskUsageBytes,
      limits: {
        maxConcurrentRuns: context.maxConcurrentRuns,
        maxConcurrentClones: context.maxConcurrentClones,
        maxRepoBytes: context.maxRepoBytes,
        maxDiskBytes: context.maxDiskBytes,
        retentionMaxRuns: context.retentionMaxRuns,
      },
      recentAudit: auditLog.slice(-50),
    });
  });

  app.get("/api/audit", async () => ({
    entries: await context.readAuditLog(),
  }));

  app.get("/api/agents", async () => AGENT_DEFINITIONS);
}
