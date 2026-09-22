/**
 * One-off smoke test: verifies the REAL provider chain end-to-end using the
 * shipped DEFAULT_MODEL_ROUTING and keys from .env. Run: node scripts/smoke-real-providers.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MODEL_ROUTING, RepoConfigSchema } from "../packages/schemas/dist/index.js";
import { LlmRouter } from "../packages/llm/dist/index.js";
import { z } from "../packages/llm/node_modules/zod/index.js";

// mimic loadEnvFile()
for (const line of readFileSync(resolve(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const config = RepoConfigSchema.parse({ routing: structuredClone(DEFAULT_MODEL_ROUTING) });
const router = new LlmRouter(config.routing, process.env);

const text = router.text("engineer");
console.log("engineer route ->", text.providerId, text.model);
const r = await text.complete({
  system: "You are a terse refactoring assistant. Reply with JSON only.",
  messages: [{ role: "user", content: 'File a.ts has a 120-line function `doStuff` that mixes parsing and printing. Reply {"ok":true,"suggestion":"..."} with one short suggestion.' }],
  responseSchema: z.object({ ok: z.boolean(), suggestion: z.string() }),
  maxTokens: 2048,
  temperature: 0.2,
});
console.log("gemini structured reply ->", JSON.stringify(r.structured), `(${r.usage.totalTokens} tokens)`);

const decision = router.decision("risk-assessor");
console.log("risk-assessor route ->", decision.providerId, decision.model);
const d = await decision.decide({
  context: "Function foo (400 lines, cyclomatic 31) has zero test coverage and is called from 6 modules.",
  questions: [
    { type: "choice", question: "Approve refactor proposal?", choices: ["approve", "revise", "reject"], rubric: "reject if risk is unmanaged" },
    { type: "score", question: "Score refactor risk", items: ["foo"], scale: { min: 1, max: 10 }, rubric: "10 = catastrophic" },
  ],
});
console.log("openrouter decision ->", JSON.stringify(d.answers), `(${d.usage.totalTokens} tokens)`);

// Text fallback (openrouter-text) — what the engineer chain uses when Gemini is down.
const { OpenRouterTextClient } = await import("../packages/llm/dist/index.js");
const ort = new OpenRouterTextClient(
  config.routing.providers.find((p) => p.providerId === "openrouter-text"),
  process.env.OPENROUTER_API_KEY,
);
const ortResult = await ort.complete({
  system: "Reply JSON only.",
  messages: [{ role: "user", content: 'Reply {"ok":true,"note":"fallback works"}' }],
  responseSchema: (await import("../packages/llm/node_modules/zod/index.js")).z.object({ ok: z.boolean(), note: z.string() }),
  maxTokens: 2048,
});
console.log("openrouter-text fallback ->", JSON.stringify(ortResult.structured));
console.log("SMOKE OK: real providers responding (gemini + openrouter decision + openrouter-text fallback)");
