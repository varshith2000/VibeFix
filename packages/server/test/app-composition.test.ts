import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";

const TOKEN = "app-composition-test-token";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(new ProjectRegistry(), { security: { token: TOKEN } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("app route composition", () => {
  it("keeps health public and catalog routes authenticated", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("healthy");

    const unauthorized = await app.inject({ method: "GET", url: "/api/agents" });
    expect(unauthorized.statusCode).toBe(401);

    const catalog = await app.inject({ method: "GET", url: "/api/agents", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(catalog.statusCode).toBe(200);
    expect(Array.isArray(catalog.json())).toBe(true);
  });
});