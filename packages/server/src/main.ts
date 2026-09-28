import { buildApp } from "./app.js";
import { ProjectRegistry } from "./projects.js";
import { loadEnvFile } from "./env.js";
import { assertBindingAllowed, tokenFilePath } from "./security.js";
import { pathToFileURL } from "node:url";

loadEnvFile(); // keys live in .env at the workspace root (gitignored)

const PORT = Number(process.env.VIBEFIX_PORT ?? 8630);
const HOST = process.env.VIBEFIX_HOST ?? "127.0.0.1";

export async function main(): Promise<void> {
  // Loopback by default. Binding anything wider requires BOTH an explicit
  // opt-in (VIBEFIX_ALLOW_REMOTE=1) and a strong explicit token — the API
  // reads the filesystem and modifies code; it must never leak by accident.
  try {
    assertBindingAllowed(HOST);
  } catch (err) {
    console.error(`[vibefix] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const registry = new ProjectRegistry();
  const app = await buildApp(registry);
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`VibeFix control plane listening on http://${HOST}:${PORT}`);
    console.log(`API token: VIBEFIX_API_TOKEN or ${tokenFilePath()} (the Vite dev proxy injects it automatically)`);
    console.log(`UI dev server expected on http://localhost:5173 (vite proxy -> :${PORT})`);
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
