import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = process.env.VIBEFIX_PORT ?? "8630";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
      "/ws": { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
    },
  },
});
