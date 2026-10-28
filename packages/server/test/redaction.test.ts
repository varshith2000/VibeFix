import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BudgetMeter,
  EventLog,
  EvidenceStore,
  OrchestratorRuntime,
  createInitialRunState,
  runPaths,
} from "@vibefix/core";
import { buildApp } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";
import { scrubSecret } from "../src/security.js";

async function readAllFilesUnder(dir: string): Promise<Array<{ file: string; content: string }>> {
  const out: Array<{ file: string; content: string }> = [];
  const walk = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full, "utf8").catch(() => "");
        out.push({ file: full, content });
      }
    }
  };
  await walk(dir);
  return out;
}

describe("end-to-end planted secret canary across all persisted artifacts and diagnostics (GATE-11: SEC-10, DAT-02, DAT-03, DAT-07)", () => {
  it("never persists planted credential canaries in events, state, evidence, ledger, report, or diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vibefix-canary-e2e-"));
    const home = path.join(root, "vibefix-home");
    const repo = path.join(root, "repo");
    const prevHome = process.env.VIBEFIX_HOME;
    process.env.VIBEFIX_HOME = home;

    const CANARY_BEARER = "canaryBearerSecretToken_998877665544332211";
    const CANARY_OPENAI = "sk-proj-canaryOpenAiSecretKey9876543210abcdef";
    const CANARY_GH = "ghp_canaryGithubPersonalAccessToken123456";
    const CANARY_ENV = "superSecretCanaryEnvValue_ABCDEF1234567890";
    const CANARY_URL_PASS = "canaryUrlPassword_777888999";

    try {
      await mkdir(repo, { recursive: true });
      await writeFile(path.join(repo, ".env"), `OPENAI_API_KEY=${CANARY_OPENAI}\nSECRET_KEY=${CANARY_ENV}\n`, "utf8");

      const runId = "run_canary0001";
      const paths = runPaths(repo, runId);
      await mkdir(paths.runDir, { recursive: true });

      const store = new EvidenceStore(paths);
      const events = new EventLog(paths);
      const budgets = { runMaxTokens: 50_000, maxChangesPerRun: 2, maxRetriesPerChange: 0, warnFraction: 0.8 };
      const meter = new BudgetMeter(budgets);

      // 1. Append events containing planted secrets in message and structured payload
      await events.append(runId, "log", {
        message: `Provider failed with Authorization: Bearer ${CANARY_BEARER} and OPENAI_API_KEY=${CANARY_OPENAI}`,
        payload: {
          apiToken: CANARY_GH,
          nested: `https://user:${CANARY_URL_PASS}@github.com/org/repo.git`,
        },
      });

      // 2. Write evidence artifacts containing planted secrets
      await store.write({
        kind: "findings",
        producer: "security-agent",
        runId,
        data: {
          findings: [
            {
              findingId: "FND-001",
              title: "Leaked key",
              category: "security",
              severity: "high",
              confidence: 0.9,
              location: "src/config.ts",
              evidence: [`Found API_KEY=${CANARY_ENV} and ${CANARY_GH}`],
              impact: "Credential exposure",
              risk: { value: 75, band: "high", factors: [] },
              proposedChangeId: null,
              recommendedChangeCategory: "none",
            },
          ],
          notes: [`Authorization: Bearer ${CANARY_BEARER}`],
        },
      });

      // 3. Write markdown report containing planted secrets
      await store.writeReportMarkdown(
        `# Report\nEncountered error with token ${CANARY_OPENAI} and SECRET_KEY=${CANARY_ENV}\n`,
      );

      // 4. Persist run state with a secret inside the error message
      const state = createInitialRunState({ runId, repoPath: repo, mode: "minimal", agentIds: [] });
      const runtime = new OrchestratorRuntime(
        {
          paths,
          store,
          events,
          executor: { definitions: () => [], execute: async () => ({ outcome: "passed", artifactIds: [] }) },
          worktrees: { cleanupAll: async () => undefined } as never,
          meter,
          budgets,
        },
        state,
      );
      await runtime.dispatch({
        type: "FATAL",
        message: `provider error: Authorization: Bearer ${CANARY_BEARER} / ${CANARY_OPENAI}`,
      });

      // 5. Verify clone stderr scrubbing and diagnostics bundle redaction
      const scrubbedClone = scrubSecret(
        `fatal: Authentication failed for 'https://x-access-token:${CANARY_GH}@github.com/o/r.git/'`,
        CANARY_GH,
      );
      expect(scrubbedClone).not.toContain(CANARY_GH);

      const registry = new ProjectRegistry();
      const app = await buildApp(registry, { security: { token: "diag-token-123456" } });
      await app.ready();
      try {
        const diagRes = await app.inject({
          method: "GET",
          url: "/api/diagnostics",
          headers: { authorization: "Bearer diag-token-123456" },
        });
        expect(diagRes.statusCode).toBe(200);
        const diagText = diagRes.body;
        expect(diagText).not.toContain(CANARY_BEARER);
        expect(diagText).not.toContain(CANARY_OPENAI);
        expect(diagText).not.toContain(CANARY_GH);
        expect(diagText).not.toContain(CANARY_ENV);
        expect(diagText).not.toContain(CANARY_URL_PASS);
      } finally {
        await app.close();
      }

      // 6. Scan every persisted file under VIBEFIX_HOME for any raw canary
      const persistedFiles = await readAllFilesUnder(home);
      expect(persistedFiles.length).toBeGreaterThanOrEqual(4);
      for (const { file, content } of persistedFiles) {
        expect(content, `canary leaked in ${file}`).not.toContain(CANARY_BEARER);
        expect(content, `canary leaked in ${file}`).not.toContain(CANARY_OPENAI);
        expect(content, `canary leaked in ${file}`).not.toContain(CANARY_GH);
        expect(content, `canary leaked in ${file}`).not.toContain(CANARY_ENV);
        expect(content, `canary leaked in ${file}`).not.toContain(CANARY_URL_PASS);
      }
    } finally {
      if (prevHome === undefined) delete process.env.VIBEFIX_HOME;
      else process.env.VIBEFIX_HOME = prevHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
