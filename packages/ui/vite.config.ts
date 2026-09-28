import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const API_PORT = process.env.VIBEFIX_PORT ?? "8630";

/**
 * The control-plane API requires a bearer token on every endpoint. The
 * browser must never know it — this proxy reads it from the same places the
 * server does (VIBEFIX_API_TOKEN env, else ~/.vibefix/server-token) and
 * injects the header on every proxied request, HTTP and WebSocket alike.
 */
const tokenFile = path.join(process.env.VIBEFIX_HOME ?? path.join(homedir(), ".vibefix"), "server-token");
let cached: { token: string | null; at: number } | null = null;
function apiToken(): string | null {
  if (process.env.VIBEFIX_API_TOKEN) return process.env.VIBEFIX_API_TOKEN;
  if (cached && Date.now() - cached.at < 2_000) return cached.token;
  let token: string | null = null;
  try {
    const t = readFileSync(tokenFile, "utf8").trim();
    token = t.length >= 16 ? t : null;
  } catch {
    token = null; // server not started yet / no token — request will 401, which is correct
  }
  cached = { token, at: Date.now() };
  return token;
}

/** Attach the token header to a proxy request object (http or ws upgrade). */
function withToken(proxyReq: { setHeader: (k: string, v: string) => void }): void {
  const token = apiToken();
  if (token) proxyReq.setHeader("authorization", `Bearer ${token}`);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", withToken);
        },
      },
      "/ws": {
        target: `ws://127.0.0.1:${API_PORT}`,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", withToken);
        },
      },
    },
  },
});
