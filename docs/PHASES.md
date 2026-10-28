# VibeFix Repair Program — Phase Status

This file tracks the repair program defined in `docs/risks-improvemts.md`
("Recommended repair order") and the subsequent Production Gate Closure
(`GATE-01` through `GATE-14` in `docs/production-contract.md` v3.2).

Verification baseline for everything below: `pnpm verify`
(`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`)
is green (25 test files, 160 passing tests, 148 files AST-linted), and CI
(`.github/workflows/ci.yml`) runs the same chain on Ubuntu and Windows.

---

## Phase 1 — Make the project verifiable ✅ (done 2026-09-28)

| Item | Result |
|---|---|
| Clean-checkout install | `pnpm install --frozen-lockfile` verified |
| Typecheck that cannot silently do nothing | Every package has a `typecheck` script; root `typecheck`/`build` include `@vibefix/ui` |
| One-command verification | Root `verify` script: install → lint → typecheck → test → build |
| CI | `.github/workflows/ci.yml` — pnpm 9 / Node 20, Ubuntu + Windows matrix |
| Fixture-repo E2E | `packages/core/test/e2e.test.ts`: full run over the small-mess fixture + worktree-cleanup-on-rejection |

---

## Phase 2 — Close the security boundary ✅ (done 2026-09-28)

| Item | Result |
|---|---|
| Security modules | `packages/server/src/auth` and `packages/server/src/policies` |
| Auth on every endpoint | All routes except `GET /api/health` and `GET /api/ready` require `Authorization: Bearer`, `X-VibeFix-Token`, or `?token=` (WS) |
| Binding guard | Default loopback (`127.0.0.1:8630`); non-loopback `VIBEFIX_HOST` refuses to start without BOTH `VIBEFIX_ALLOW_REMOTE=1` and an explicit ≥16-char token |
| CORS / origins | Only configured UI origins; foreign `Origin` headers get 403 regardless of CORS |
| Path containment | `/file` and `/api/fs/browse`: `fs.realpath` + `path.relative` containment with symlink/junction re-check |
| Project-scoped runs | Every run route is `/api/projects/:enc/runs/:runId/...`; `resolveRun` verifies live-runtime↔project match or on-disk location |
| Secure Git credentials | `routes/projects.ts` uses a `0600` git-credential-store temp file (deleted in `finally`), never argv; clean canonical clone URL; stderr scrubbed |
| Rate/resource limits | 600 req/min global, 10 clones/min, ≤2 concurrent clones, ≤4 active runs (`VIBEFIX_MAX_ACTIVE_RUNS`), 1 MiB body limit |

---

## Phase 3 — Fix runtime correctness ✅ (done 2026-09-28)

| Item | Result |
|---|---|
| No more silent approval success | `POST .../approve` awaits `runtime.dispatch(...)` directly in try/catch — a failed approval is an HTTP 500 |
| Background failures persisted | `ProjectRegistry.track()` records failures and force-fails the run through the reducer (`FATAL` → status `failed`) |
| Terminal runtimes unregistered | `registerRuntime` drops terminal runtimes after background work settles |
| WS replay/subscribe race fixed | `bridgeReplayToLive` subscribes FIRST into a buffer, replays history, flushes the buffer (dedup by `eventId`), then goes live |
| Sequence-gap recovery (UI) | `store.ts` passes `since=${lastSeq}` on WS connect and triggers `resyncAfterGap()` on sequence gaps |
| Explicit degradation | `EventLog`, `EvidenceStore`, and REST/WS routes report corrupt lines, corrupt `state.json`, and failed appends explicitly |
| Idempotency keys | `approve` / `reject` / `abort` / `resume` serialize requests per key in a critical section (`withIdempotency`) and persist outcomes to `VIBEFIX_HOME/idempotency.json` |

---

## Phase 4 — Improve analysis quality ✅ (done 2026-09-29)

| Item | Result |
|---|---|
| Parser-backed metrics | `packages/adapters/src/tools/code-metrics.ts` (`ts-ast` + labeled `regex-heuristic` fallback) |
| TS module resolution for imports | `packages/adapters/src/tools/import-graph.ts` (`TsImportGraph` with `ts.resolveModuleName`) |
| LLM finding validation & fingerprints | `packages/agents/src/shared/findings.ts` (`validateLlmFindingAgainstRepo`, `findingFingerprint`) |
| Opt-in git initialization | `GitTool.initBaseline` + `POST /api/projects { repoPath, initGit: true }` |

---

## Phase 5 — Align documentation with reality ✅ (done 2026-09-29)

Rewrote `AGENTS.md`, revised `docs/production-contract.md` to v3.1, and preserved the historical audit/review records.

---

## Phase 6 — Close all remaining production contract gates (`GATE-01`..`GATE-14`) ✅ (done 2026-10-27)

| Gate / Scope | What was delivered | Proving test / artifact |
|---|---|---|
| `GATE-03` Static AST Linter (`SAFE-04`, `DAT-04`, `SEC-12`) | Created `scripts/lint.mjs` enforcing TypeScript/JS syntax validity, `SAFE-04` (`node:fs` imports forbidden in `packages/agents/src` outside `engineer.ts`), `DAT-04` (raw prompt identifiers forbidden in logger/event calls), and `SEC-12` (no `eval()`). Wired into root `pnpm lint`, `pnpm verify`, and `.github/workflows/ci.yml`. | `pnpm lint`; `packages/agents/test/permissions.test.ts` |
| `GATE-06` Security Completion (`SEC-01`, `SEC-06`, `SEC-09`, `SEC-12`, `SEC-13`) | Added `resolveListenConfig` default loopback bind verification, symlink/junction `fs.realpath` escape rejection on `/file` and `/api/fs/browse`, `executionPolicy` fail-closed verification (`NOT_APPLICABLE (policy)`), and structured correlation-tagged audit logging (`VIBEFIX_HOME/audit.ndjson`, `GET /api/audit`). | `packages/server/test/bind.test.ts`; `packages/server/test/security.test.ts`; `packages/agents/test/permissions.test.ts` |
| `GATE-07` Restart & Landing Recovery (`REL-07`, `REL-08`, `SAFE-13`, `SAFE-15`) | Added process-level kill-mid-run (`SIGKILL`) recovery + `resume()` to completion test, kill-mid-cherry-pick landing journal recovery test, and post-discard worktree removal verification (`E_DISCARD_FAILED`). | `packages/core/test/recovery.test.ts`; `packages/core/test/durable-correctness.test.ts` |
| `GATE-08` WebSocket Replay & Reconnect (`REL-05`) | Updated UI client (`packages/ui/src/store.ts`) to pass `since=${lastSeq}` and added a full socket-level `/ws` reconnect + live interleave test. | `packages/server/test/runtime-correctness.test.ts` |
| `GATE-09` & `GATE-10` Firewall, Scope Integrity & Primary-Tree Invariance (`SAFE-01`, `SAFE-03`, `SAFE-08`, `SAFE-09`) | Isolated `HarnessBuilder` baseline execution in a temporary worktree, enforced SHA-256 proposal scope hash verification (`E_SCOPE_MUTATED`), enforced final committed diff firewall verification in `BehaviorVerifier` and `RegressionSentinel`, and proved primary-tree/git-config/`node_modules` invariance under failure injection. | `packages/core/test/primary-tree.test.ts`; `packages/agents/test/permissions.test.ts` |
| `GATE-11` End-to-End Secret Redaction Canary (`SEC-10`, `DAT-02`, `DAT-03`, `DAT-07`) | Expanded `redactSecrets`/`redactUnknown` across all credential patterns and wired redaction into `EvidenceStore.writeReportMarkdown`, `OrchestratorRuntime` state error & ledger persistence, and `GET /api/diagnostics`. Verified with planted canaries across every persisted file under `VIBEFIX_HOME`. | `packages/server/test/redaction.test.ts`; `packages/schemas/test/redaction.test.ts`; `packages/agents/test/provider-redaction.test.ts` |
| `GATE-12` Resource Limits, Retention & Observability (`RES-01..16`, `DAT-05/06`, `OBS-02..07`, `REL-12/13`, `MIG-02/03`) | Enforced numeric defaults for all resource limits (`maxRepoBytes = 500 MiB`, `maxDiskBytes = 2 GiB`, `analysisTimeoutMs = 600s`, `runTimeoutMs = 1800s`, `agentMaxTokens = 500k`, `maxLlmCallsPerRun = 120`, `maxCostUsd = $10`, `maxWorktreesPerRun = 8`), added retention sweep (`POST /api/projects/:enc/sweep`) and `DELETE` routes, hardened child-process tree termination, added `/api/ready`, `/api/metrics`, `/api/diagnostics`, and added `state.json`/`events.ndjson` schema versioning (`migrateRunState`, `migrateEvent`). | `packages/core/test/primary-tree.test.ts`; `packages/server/test/security.test.ts`; `packages/server/test/runtime-correctness.test.ts`; `packages/adapters/test/test-runner.test.ts`; `packages/schemas/test/roundtrip.test.ts` |
| `GATE-13` & `GATE-14` Contract & Acceptance Criteria Closure | Assigned named engineering owners (`@vibefix/security-eng`, `@vibefix/runtime-eng`, `@vibefix/safety-eng`, `@vibefix/platform-eng`) across all contract items and acceptance criteria, re-scored all 85 acceptance criteria to passing (0 open blockers), and reconciled `docs/production-contract.md` (v3.2), `docs/production-acceptance-criteria.md` (v3.0), `AGENTS.md`, and `docs/ui-redesign-and-production-plan.md`. | `docs/production-contract.md`; `docs/production-acceptance-criteria.md` |

## Bottom line

All six phases of the repair and gate-closure program are complete (25 test
files / 160 tests green, `pnpm verify` green). All 14 release gates (`GATE-01`
through `GATE-14`) in `docs/production-contract.md` v3.2 are green for the
supported local-first, single-operator scope.
