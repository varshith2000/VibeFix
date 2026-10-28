# VibeFix — Agent & Engineering Guide

> **How to read this document (repair-program rule):** a feature is listed as
> **Implemented** only when a passing test in this repository covers it (or its
> failure scenario). The enforceable contract and its gate list live in
> `docs/production-contract.md` (v3.2); the testable acceptance matrix lives in
> `docs/production-acceptance-criteria.md` (v3.0); the repair-program status
> file is `docs/PHASES.md`. All 14 contract release gates (`GATE-01` through
> `GATE-14`) are green and verified by `pnpm verify` for the supported
> local-first, single-operator scope (`docs/production-contract.md` §1.1).

## What VibeFix is

A local-first, multi-agent refactoring control plane for vibe-coded
repositories: a deterministic pipeline of narrow agents whose prime directive
is behavior preservation (Understand → Preserve → Improve → Verify →
Explain). Changes land only through firewalled git worktrees after a
structurally blinded verification pool and an explicit human checkpoint.

**Local-only security assumption (explicit):** one operator, one trusted
machine. The API requires a bearer token and binds loopback by default, but
VibeFix is **not** designed against a malicious local user or process — a
local process that can read `~/.vibefix/server-token` can drive the API.
Remote exposure additionally requires `VIBEFIX_ALLOW_REMOTE=1` plus an
explicit `VIBEFIX_API_TOKEN` (see the contract, SEC-02). Multi-user, hosted,
and multi-tenant deployment are out of scope.

## Implemented (test-proven)

Each row names its proving test. If you change one of these behaviors,
change or extend that test in the same commit.

| Capability | Where | Proving test |
|---|---|---|
| Verifiable build/lint/typecheck/test baseline (`GATE-01..05`) | root `verify` script (`install --frozen-lockfile` → `lint` → `typecheck` → `test` → `build`, incl. UI); `scripts/lint.mjs` | locally green (`pnpm verify`); `.github/workflows/ci.yml` (Ubuntu + Windows matrix); `packages/agents/test/permissions.test.ts` |
| Deterministic reducer state machine (guards, retries, defers, checkpoint gating) | `packages/domain/src/reducer.ts`; compatibility export from `core` | `packages/core/test/reducer.test.ts` |
| Change Firewall (scope deny-by-default, protected paths, lockfiles, cumulative per-proposal violations, final-diff verification) | `packages/core/src/worktree/firewall.ts`; `verifier.ts`; `regression-sentinel.ts` | `packages/core/test/firewall.test.ts`; `packages/agents/test/permissions.test.ts` |
| Single-writer capability enforcement (`engineer` only) + post-approval proposal scope SHA-256 verification (`E_SCOPE_MUTATED`) | `packages/agents/src/definitions.ts`; `scripts/lint.mjs`; `packages/core/src/orchestrator/runtime.ts` | `packages/agents/test/permissions.test.ts`; `packages/core/test/primary-tree.test.ts` |
| Primary working-tree invariance (no pre-approval edits to `.git/config` or `node_modules`; isolated worktree for baseline harness) | `worktree-manager.ts`; `harness-builder.ts` | `packages/core/test/primary-tree.test.ts` |
| Artifact, run-state, and event schema versioning + migration walk rejection (`MIG-01..06`) | `packages/schemas/src/migrations.ts` | `packages/schemas/test/roundtrip.test.ts` |
| Full pipeline end-to-end over a fixture repo (real git worktrees, landing, cleanup-on-rejection) | executor + orchestrator | `packages/core/test/e2e.test.ts` |
| Reducer/domain and server boundaries (domain state machine; composed route plugins; dedicated auth, policy, and WebSocket modules) | `packages/domain`; `packages/server/src/routes`; `auth`; `policies`; `websocket`; `app.ts` | `packages/core/test/reducer.test.ts`; `packages/server/test/app-composition.test.ts` |
| Deterministic hostile, large, and failing repository fixtures | `packages/test-fixtures` | `packages/test-fixtures/test/profiles.test.ts` |
| Bearer-token auth on every endpoint except `/api/health` and `/api/ready`; timing-safe compare | `packages/server/src/auth/token-auth.ts`; compatibility exports in `security.ts` | `packages/server/test/security.test.ts` (auth block) |
| Default loopback bind (`127.0.0.1:8630`) and remote binding guard (`VIBEFIX_ALLOW_REMOTE=1` + ≥16-char `VIBEFIX_API_TOKEN`) | `main.ts` `resolveListenConfig`; `auth/permissions.ts` `assertBindingAllowed` | `packages/server/test/bind.test.ts`; `packages/server/test/security.test.ts` |
| CORS allowlist + foreign-`Origin` refusal (DNS-rebinding/CSRF) | `policies/origin-policy.ts` | `packages/server/test/security.test.ts` (origin block) |
| Path containment by `path.relative` + symlink/junction `fs.realpath` re-check across `/file`, `/api/fs/browse`, and `engineer.ts` | `policies/path-policy.ts`; `routes/repositories.ts`; `engineer.ts` | `packages/server/test/security.test.ts`; `packages/agents/test/engineer-containment.test.ts` |
| Project-scoped run URLs; cross-project run access is 404; `runId` shape validation | `context.ts` `resolveRun`; `policies/resource-policy.ts` | `packages/server/test/security.test.ts` (project-scoped runs block) |
| Secure git clone credentials: token via `0600` credential-store file (never argv, never `.git/config`), atomic target reservation, stderr scrubbing | `routes/projects.ts`; `policies/resource-policy.ts` | `packages/server/test/security.test.ts` (clone block) |
| End-to-end secret redaction across logs, events, state, evidence, ledger, markdown reports, provider boundaries, and `/api/diagnostics` (`GATE-11`) | `packages/schemas/src/redaction.ts`; `evidence-store.ts`; `event-log.ts`; `runtime.ts`; `routes/health.ts` | `packages/server/test/redaction.test.ts`; `packages/schemas/test/redaction.test.ts`; `packages/agents/test/provider-redaction.test.ts` |
| Execution policy default-deny (`allowCommandExecution: false` blocks repo scripts and fails closed with `NOT_APPLICABLE (policy)`) | `config.ts`; `executor.ts`; `verifier.ts`; `regression-sentinel.ts` | `packages/agents/test/permissions.test.ts` |
| Resource & cost limits (`RES-01..16`), retention sweep (`POST /api/projects/:enc/sweep`), run/project deletion (`DELETE`), and structured audit log (`GET /api/audit`) | `routing.ts`; `budget.ts`; `runtime.ts`; `worktree-manager.ts`; `context.ts`; `routes/projects.ts`; `routes/runs.ts` | `packages/core/test/primary-tree.test.ts`; `packages/server/test/security.test.ts`; `packages/adapters/test/test-runner.test.ts` |
| Approval failures return HTTP 500; background dispatch failures force-fail the run (`FATAL`) and are counted in `/api/health` | `routes/approvals.ts`; `projects.ts` `track()` | `packages/server/test/runtime-correctness.test.ts` |
| Terminal runtimes are unregistered after background settle; graceful shutdown drains active runs (`createShutdownHandler`) | `projects.ts` `watchForTerminal`; `main.ts` `createShutdownHandler` | `packages/server/test/runtime-correctness.test.ts` |
| WS replay→live handoff without loss or duplication (subscribe-first bridge + socket reconnect with `since=lastSeq`, `GATE-08`) | `packages/server/src/websocket/replay.ts`; `gateway.ts`; `ui/src/store.ts` | `packages/server/test/runtime-correctness.test.ts` |
| Serialized, durable idempotency keys on approve/reject/abort/resume (`withIdempotency`) | `routes/approvals.ts`; `context.ts` | `packages/server/test/runtime-correctness.test.ts` |
| Durable run recovery (`GATE-07`): kill-mid-run detection (`interrupted`), explicit `resume()`, kill-mid-landing cherry-pick recovery (`landing-journal.json`), post-discard verification (`E_DISCARD_FAILED`), and single-writer `.run.lock` | `store/event-log.ts`; `store/run-lock.ts`; `orchestrator/run-manager.ts`; `worktree/worktree-manager.ts` | `packages/core/test/recovery.test.ts`; `packages/core/test/durable-correctness.test.ts` |
| Health, readiness, metrics, and redacted diagnostics endpoints (`/api/health`, `/api/ready`, `/api/metrics`, `/api/diagnostics`) | `packages/server/src/routes/health.ts` | `packages/server/test/runtime-correctness.test.ts`; `packages/server/test/redaction.test.ts` |
| TS-AST code metrics with analyzer labels (`ts-ast` / `regex-heuristic`) and TypeScript module-resolution import graph | `adapters/src/tools/code-metrics.ts`; `import-graph.ts` | `packages/adapters/test/analysis.test.ts` |
| LLM findings validated against the file snapshot + content fingerprints for dedupe | `agents/src/shared/findings.ts` | `packages/agents/test/finding-validation.test.ts` |
| Opt-in git initialization for git-less projects (`GitTool.initBaseline`) | `adapters` `GitTool.initBaseline`; `run-manager.ts` | `packages/server/test/open-project.test.ts` |

## Explicitly out-of-scope / unsupported (per contract §1.2)

- Multi-tenant, multi-user, or hosted SaaS deployment.
- OS-level process sandboxing (capability isolation is enforced via AST lint rules and injected handles; enabled repo commands execute on the host).
- Protection against a malicious local user or process running under the same OS account.
- Model-diverse verification across multiple external LLM providers by default (verification is structurally blinded and fails closed; see `SAFE-10`).
- Live external LLM provider smoke in CI (`scripts/smoke-real-providers.mjs` is manual because CI runs keyless with deterministic doubles).

## Operational limitations (standing)

- Node ≥ 20, git on PATH; pnpm 9 workspace.
- All run state under `~/.vibefix` (`VIBEFIX_HOME`); target repos are never modified before approval.
- LLM keys from the environment only; analysis runs keyless, code modification requires a routed real model (mocks are test-only).
- Retention sweep is triggered via `POST /api/projects/:enc/sweep` (default `retentionMaxRuns = 20`), and individual runs or projects can be deleted via `DELETE /api/projects/:enc/runs/:runId` and `DELETE /api/projects/:enc`.

## Debugging aids

```bash
pnpm verify                              # full chain CI runs (install -> lint -> typecheck -> test -> build)
curl http://127.0.0.1:8630/api/health    # liveness + activeRuntimes + backgroundFailures
curl http://127.0.0.1:8630/api/ready     # readiness + activeRuns + maxConcurrentRuns
```

API token: `VIBEFIX_API_TOKEN` env or `~/.vibefix/server-token` (delete to
rotate; the Vite dev proxy injects it automatically). See README "Security
model" and `.env.example` for every knob.
