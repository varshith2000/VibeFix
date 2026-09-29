import type { FastifyReply, FastifyRequest } from "fastify";

export function originCheckHook(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0 && !allowed.has(origin)) {
      req.log.warn({ origin }, "blocked request with foreign Origin header");
      return reply.code(403).send({ error: `origin ${origin} is not allowed` });
    }
  };
}

export function defaultAllowedOrigins(): string[] {
  const fromEnv = process.env.VIBEFIX_UI_ORIGIN;
  if (fromEnv) return fromEnv.split(",").map((origin) => origin.trim()).filter(Boolean);
  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}