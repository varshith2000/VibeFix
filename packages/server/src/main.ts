import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { ProjectRegistry } from "./projects.js";
import { loadEnvFile } from "./env.js";
import { assertBindingAllowed } from "./auth/permissions.js";
import { tokenFilePath } from "./auth/token-auth.js";
import { pathToFileURL } from "node:url";

loadEnvFile(); // keys live in .env at the workspace root (gitignored)

export function resolveListenConfig(env: Record<string, string | undefined> = process.env): { host: string; port: number } {
  const host = env.VIBEFIX_HOST ?? "127.0.0.1";
  const port = Number(env.VIBEFIX_PORT ?? 8630);
  assertBindingAllowed(host, env);
  return { host, port };
}

export interface ShutdownHandlerOptions {
  app: FastifyInstance;
  registry: ProjectRegistry;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

export function createShutdownHandler(
  appOrOptions: FastifyInstance | ShutdownHandlerOptions,
  maybeRegistry?: ProjectRegistry,
): (signal: string) => Promise<void> {
  const isOpts = "app" in appOrOptions && "registry" in appOrOptions && !("listen" in appOrOptions);
  const app = isOpts ? (appOrOptions as ShutdownHandlerOptions).app : (appOrOptions as FastifyInstance);
  const registry = isOpts ? (appOrOptions as ShutdownHandlerOptions).registry : maybeRegistry!;
  const customTimeoutMs = isOpts ? (appOrOptions as ShutdownHandlerOptions).timeoutMs : undefined;
  const exit = isOpts ? (appOrOptions as ShutdownHandlerOptions).exit : undefined;

  let shuttingDown = false;
  return async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[vibefix] ${signal} received; draining requests and runs before shutdown`);
    const timeoutMs = customTimeoutMs ?? Number(process.env.VIBEFIX_SHUTDOWN_TIMEOUT_MS ?? 10_000);
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        console.error(`[vibefix] graceful shutdown exceeded ${timeoutMs}ms`);
        process.exitCode = 1;
        resolve();
      }, timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([
        (async () => {
          await registry.shutdown();
          await app.close();
        })(),
        timeout,
      ]);
      if (exit) exit(timedOut ? 1 : 0);
    } catch (err) {
      console.error(`[vibefix] graceful shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      if (exit) exit(1);
    }
  };
}

export async function main(): Promise<void> {
  let host: string;
  let port: number;
  // Loopback by default. Binding anything wider requires BOTH an explicit
  // opt-in (VIBEFIX_ALLOW_REMOTE=1) and a strong explicit token — the API
  // reads the filesystem and modifies code; it must never leak by accident.
  try {
    ({ host, port } = resolveListenConfig(process.env));
  } catch (err) {
    console.error(`[vibefix] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const registry = new ProjectRegistry();
  const app = await buildApp(registry);
  const shutdown = createShutdownHandler(app, registry);
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  try {
    await app.listen({ port, host });
    console.log(`VibeFix control plane listening on http://${host}:${port}`);
    console.log(`API token: VIBEFIX_API_TOKEN or ${tokenFilePath()} (the Vite dev proxy injects it automatically)`);
    console.log(`UI dev server expected on http://localhost:5173 (vite proxy -> :${port})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when executed directly (`node dist/main.js`). This module
// is re-exported through index.ts, so an unguarded call would start the
// server as a side effect of ANY import of @vibefix/server (the CLI's
// `loadEnvFile` import did exactly that).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
