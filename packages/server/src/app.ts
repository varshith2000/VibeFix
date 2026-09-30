import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { authHook, getApiToken } from "./auth/token-auth.js";
import { defaultAllowedOrigins, originCheckHook } from "./policies/origin-policy.js";
import { RateLimiter, rateLimitHook } from "./policies/resource-policy.js";
import { createServerContext, type BuildAppOptions } from "./context.js";
import { ProjectRegistry } from "./projects.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRepositoryRoutes } from "./routes/repositories.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerFindingRoutes } from "./routes/findings.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerWebsocketGateway } from "./websocket/gateway.js";
import { redactSecrets } from "@vibefix/schemas";

export type { BuildAppOptions } from "./context.js";

export async function buildApp(registry: ProjectRegistry, options: BuildAppOptions = {}) {
  const security = options.security ?? {};
  const apiToken = security.token ?? await getApiToken();
  const allowedOrigins = security.allowedOrigins ?? defaultAllowedOrigins();
  const app = Fastify({
    logger: {
      level: process.env.VIBEFIX_LOG ?? "info",
      serializers: {
        req(request) {
          const rawUrl = typeof request.url === "string" ? request.url : "";
          return {
            method: request.method,
            url: redactSecrets(rawUrl.replace(/([?&]token=)[^&]*/gi, "$1[REDACTED]")),
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
    bodyLimit: 1_000_000,
    maxParamLength: 1000,
  });

  await app.register(websocket);
  await app.register(cors, { origin: allowedOrigins, credentials: false });
  app.addHook("onRequest", originCheckHook(allowedOrigins));
  app.addHook("onRequest", rateLimitHook(new RateLimiter(60_000, security.requestsPerMinute ?? 600)));
  app.addHook("onRequest", authHook(apiToken));

  const context = createServerContext(registry, apiToken, options);
  registerHealthRoutes(app, context);
  registerProjectRoutes(app, context);
  registerRepositoryRoutes(app, context);
  registerRunRoutes(app, context);
  registerFindingRoutes(app, context);
  registerArtifactRoutes(app, context);
  registerApprovalRoutes(app, context);
  registerWebsocketGateway(app, context);
  return app;
}
