import { buildApp } from "./app.js";
import { ProjectRegistry } from "./projects.js";
import { loadEnvFile } from "./env.js";

loadEnvFile(); // keys live in .env at the workspace root (gitignored)

const PORT = Number(process.env.VIBEFIX_PORT ?? 8630);
const HOST = process.env.VIBEFIX_HOST ?? "127.0.0.1";

export async function main(): Promise<void> {
  const registry = new ProjectRegistry();
  const app = buildApp(registry);
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`VibeFix control plane listening on http://${HOST}:${PORT}`);
    console.log(`UI dev server expected on http://localhost:5173 (vite proxy -> :${PORT})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
