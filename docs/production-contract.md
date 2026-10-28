# VibeFix Production Contract

**Version:** 3.2 — closes all remaining release gates (`GATE-01` through `GATE-14`), assigns named engineering owners (`@vibefix/security-eng`, `@vibefix/runtime-eng`, `@vibefix/safety-eng`, `@vibefix/platform-eng`), sets all numeric resource limits (`§5`), and links every enforced guarantee to its proving automated test. Supersedes v3.1.
**Date:** 2026-10-27
**Companion documents:** `docs/production-contract-audit.md` (historical pre-repair evidence), `docs/production-contract-review.md` (adversarial review), `docs/production-acceptance-criteria.md` (v3.0 re-scored testable criteria), `docs/PHASES.md` (repair-program and gate-closure status).
**Status of the product:** Production-ready for its supported local-first, single-operator scope (`§1.1`). All 14 release gates (`§10`, including `GATE-14`) are green and verified via `pnpm verify`.

**Normative rules for this document:**
1. An item may be marked **enforced** only when a passing test in this repository proves it.
2. Every item separates **Current** (verified behavior today), **Target** (required behavior before the item can be called enforced), and where relevant **Unsupported** (explicitly not provided — do not rely on it).
3. Every important item states its **failure behavior**: what happens, what the user sees, and what is persisted when the guarantee cannot be honored.
4. Every enforced item names its **enforcement location** (file/symbol) and its assigned **Owner** (`@vibefix/security-eng`, `@vibefix/runtime-eng`, `@vibefix/safety-eng`, or `@vibefix/platform-eng`).
5. Every resource limit in `§5` has a concrete numeric default and configuration knob enforced in code and covered by automated tests.

| Status | Definition |
|---|---|
| **enforced** | Implemented; a passing test in this repository asserts it. |
| **partially enforced** | Implemented, untested, and no known contradiction — or tested with a named remaining gap. |
| **contradicted** | The audit verified that current code violates the guarantee. |
| **planned** | Not implemented; the required work is named. |
| **unsupported** | Explicitly not provided in this release; stated so no one relies on it. |

**Trusted-environment assumption:** the API requires a bearer token on every endpoint except `/api/health` and `/api/ready`, binds loopback (`127.0.0.1`) by default, refuses non-loopback binding without explicit opt-in plus a strong token, restricts CORS to the UI origins, and refuses foreign `Origin` headers outright (`SEC-01…05`). The operating assumption is a **single trusted operator**: any local process running as the same OS user can read `~/.vibefix/server-token` (mode `0600`) and therefore drive the API, including approval. Protection against a malicious local user/process remains explicitly **unsupported** (see `§1.2`). A running server must be treated as privileged.

**Local-first single-user scope:** one operator, one machine. Multi-user, remote, and hosted deployment are out of scope (`§1.2`).

---

## 1. Product scope

### 1.1 Supported product (target deployment model)

1. **Local-first application.** All run state, evidence, worktrees, and clones live under the VibeFix home (`~/.vibefix`, override `VIBEFIX_HOME`), never inside the analyzed repository (`packages/core/src/store/paths.ts`). Baseline harness execution also runs in a temporary isolated worktree (`packages/agents/src/agents/harness-builder.ts`).
2. **Single-user deployment.** One operator, one machine; no multi-tenant identity model is claimed.
3. **Local server and UI.** Fastify control plane, default `127.0.0.1:8630` (`packages/server/src/main.ts`), plus a Vite/React UI proxied to it (the proxy injects the API token server-side).
4. **Optional external LLM providers.** Keys sourced from the environment (`packages/llm/src/router.ts`); analysis runs without keys; code modification requires a routed model.
5. **Repositories through approved paths.** Operator registers a local git repo (clean tree asserted, `run-manager.ts` `assertClean`) or clones from GitHub. **A folder with no git trace can be opened opt-in** (`initGit`): VibeFix initializes a repository with one baseline commit of the current contents (`GitTool.initBaseline`; tested in `packages/server/test/open-project.test.ts`).
6. **Isolated git worktrees for modifications** — directory-convention isolation under `~/.vibefix/projects/<key>/worktrees/` on `vibefix/*` branches (`worktree-manager.ts`). **This is not an OS-level sandbox** (see `SAFE-02`, `SAFE-04`).
7. **Human approval before code changes.** Execution starts only on `CHECKPOINT_APPROVED` (`reducer.ts`); CLI `--yes` is an explicit operator opt-in bypassing the human checkpoint only.
8. **Independent verification after changes** — *structurally blinded* verification (diff + proposal + gates, never the engineer's rationale). "Independent" does **not** mean diverse judges: all three verifiers may share one provider model by default (`SAFE-10`).

### 1.2 Explicitly out of scope / unsupported for the first production release

| Out of scope / unsupported | Consequence |
|---|---|
| Multi-tenant hosted SaaS | No tenancy, isolation, or quotas designed or claimed. |
| Anonymous remote access | Remote binding requires explicit opt-in + strong token (`SEC-02`, enforced); anything beyond that is **unsupported**. |
| Model-diverse verification (three different providers) | **Unsupported** this release: blinded structure only; single-provider correlation risk is documented (`SAFE-10`). |
| OS-level sandboxing of agent processes | **Unsupported**: `SAFE-04` enforces capability injection and static AST lint rules, not OS process isolation. |
| Protection against a malicious local user/process | **Unsupported**: the trusted-environment assumption above states the boundary. |
| Unrestricted execution of arbitrary repository scripts | Execution without an approved policy is denied by default (`SEC-12`, enforced). |
| Automatic merging without verification | No bypass exists or is planned. |
| Unrestricted filesystem access | Scoped-path access is enforced (`SEC-06..09`). |

---

## 2. Security contract

### SEC-01 — Server binds to 127.0.0.1 by default — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/main.ts` `resolveListenConfig` + `packages/server/src/auth/permissions.ts` `assertBindingAllowed`.
- **Current:** defaults to `127.0.0.1:8630` unless `VIBEFIX_HOST`/`VIBEFIX_PORT` override; any non-loopback override is gated by `assertBindingAllowed`.
- **Proving test:** `packages/server/test/bind.test.ts` (asserts `resolveListenConfig({})` and ephemeral server bind to `127.0.0.1`).
- **Failure behavior:** startup failure logs the refusal reason and exits non-zero (`process.exit(1)`).

### SEC-02 — Remote binding requires an explicit opt-in flag AND authentication — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/auth/permissions.ts` `assertBindingAllowed`, wired in `main.ts` `resolveListenConfig`.
- **Current:** a non-loopback host throws and exits **before listening** unless BOTH `VIBEFIX_ALLOW_REMOTE=1` and `VIBEFIX_API_TOKEN` (≥16 chars) are set; the refusal message names both conditions.
- **Proving test:** `packages/server/test/security.test.ts` (binding-guard block) and `packages/server/test/bind.test.ts`.
- **Failure behavior:** exit non-zero before binding; nothing listens.

### SEC-03 — Sensitive REST endpoints require authentication — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/auth/token-auth.ts` `authHook`/`getApiToken`/`tokenEquals` (SHA-256 + `timingSafeEqual`; token from `VIBEFIX_API_TOKEN` or a generated 32-byte value persisted mode `0600` at `~/.vibefix/server-token`).
- **Current:** every route except `GET /api/health` and `GET /api/ready` requires the token (`Authorization: Bearer`, `X-VibeFix-Token`, or `?token=` for WS).
- **Proving test:** `packages/server/test/security.test.ts` (auth block + token-persistence block).
- **Failure behavior:** HTTP 401, no state change.

### SEC-04 — WebSocket connections require authentication — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/auth/token-auth.ts` `authHook` + `packages/server/src/websocket/gateway.ts` (`4401` close check).
- **Current:** `/ws` is gated by both the `onRequest` auth hook and an in-handler token check that closes unauthorized sockets with `4401`.
- **Proving test:** `packages/server/test/security.test.ts` (drives a real unauthenticated WebSocket upgrade and observes the refusal).
- **Failure behavior:** upgrade refused / socket closed `4401`; no frames sent.

### SEC-05 — CORS uses an explicit allowlist — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/app.ts` + `packages/server/src/policies/origin-policy.ts` `originCheckHook`.
- **Current:** allowlist-only CORS (`localhost:5173`/`127.0.0.1:5173` or `VIBEFIX_UI_ORIGIN`) **and** any request carrying a foreign `Origin` header is refused with HTTP 403 outright (DNS-rebinding/CSRF defense).
- **Proving test:** `packages/server/test/security.test.ts` (origin enforcement block).
- **Failure behavior:** preflight denied; foreign-origin requests HTTP 403; no data returned.

### SEC-06 — Projects cannot access another project's files or runs — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/context.ts` `resolveRun`, `packages/server/src/routes/repositories.ts` (`/file` and `/api/fs/browse` with `fs.realpath` containment).
- **Current:** every run route resolves through `/api/projects/:enc/runs/:runId/*` with project-key and on-disk containment verification; `/api/fs/browse` resolves `fs.realpath` and rejects paths or symlinks escaping `allowedBrowseRoots` with `403 E_PATH_ESCAPE`.
- **Proving test:** `packages/server/test/security.test.ts` (filesystem containment, browse roots, symlink/junction escape, and project-scoped runs blocks).
- **Failure behavior:** HTTP 403/404; no cross-project data returned.

### SEC-07 — Run IDs are scoped to projects — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/context.ts` `resolveRun` + `packages/server/src/policies/resource-policy.ts` `isValidRunId`.
- **Proving test:** `packages/server/test/security.test.ts` (project-scoped runs block).
- **Failure behavior:** HTTP 400/404; no data returned, no mutation.

### SEC-08 — Repository-relative paths cannot escape the approved root — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/policies/path-policy.ts` `isPathInside` (`path.relative` containment) on `/api/projects/:enc/file`.
- **Proving test:** `packages/server/test/security.test.ts` (filesystem path containment block).
- **Failure behavior:** HTTP 400; no file read.

### SEC-09 — Symlink escapes are rejected — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/routes/repositories.ts` (`fs.realpath` re-check on `/file` and `/api/fs/browse`) and `packages/agents/src/agents/engineer.ts` (`resolveContainedTarget` with `fs.realpath` parent walk). Worktrees no longer create a `node_modules` junction.
- **Proving test:** `packages/server/test/security.test.ts` (symlink/junction escape on `/file` and `/api/fs/browse`) and `packages/agents/test/engineer-containment.test.ts`.
- **Failure behavior:** resolved-outside-root paths return HTTP 400/403 `E_PATH_ESCAPE`; engineer write throws `E_PATH_ESCAPE`; no read or write occurs.

### SEC-10 — Secrets are not written to logs, URLs, argv, reports, or persisted artifacts — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/schemas/src/redaction.ts` (`redactSecrets`, `redactUnknown`), wired into `logger.ts`, `event-log.ts`, `evidence-store.ts` (`write` and `writeReportMarkdown`), `runtime.ts` (`persistState` and `appendLedger`), `routes/health.ts` (`/api/diagnostics`), and provider boundaries (`text-agent-loop.ts`, `decision-agent.ts`).
- **Current:** all versioned credential patterns (Bearer/Basic headers, URL userinfo, `x-access-token:`, `sk-`, `ghp_`, `github_pat_`, `AKIA`, `KEY=value` env assignments, PEM private keys) are redacted before persistence or outbound transmission, and sensitive files (`.env*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`) are excluded from snapshots.
- **Proving test:** `packages/server/test/redaction.test.ts`, `packages/schemas/test/redaction.test.ts`, and `packages/agents/test/provider-redaction.test.ts`.
- **Failure behavior:** planted-secret canary failure breaks `pnpm test` (`GATE-11`); runtime occurrences are replaced with `[REDACTED]`.

### SEC-11 — Git credentials use a secure mechanism — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/routes/projects.ts` clone route + `packages/server/src/policies/resource-policy.ts` (`credentialFileBody`, `scrubSecret`, `parseCloneUrl`).
- **Proving test:** `packages/server/test/security.test.ts` (git clone credential handling block).
- **Failure behavior:** clone failure deletes the `0600` temp credential store in `finally` and returns scrubbed stderr; no credential persisted anywhere.

### SEC-12 — Untrusted repository code is not executed without an explicit execution policy — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/schemas/src/config.ts` (`executionPolicy.allowCommandExecution` defaults to `false`), `packages/agents/src/executor.ts` (`policyRunner`), `packages/agents/src/agents/verifier.ts`, and `packages/agents/src/agents/regression-sentinel.ts`.
- **Current:** repository commands are denied by default; when blocked by `executionPolicy`, verification gates record `FAIL` with `NOT_APPLICABLE (policy)` details and reject the attempt so unverified changes never land.
- **Proving test:** `packages/agents/test/permissions.test.ts` (`SEC-12` execution policy block).
- **Failure behavior:** unapproved command skipped, gate records `FAIL` (`NOT_APPLICABLE (policy)`), landing blocked.

### SEC-13 — All dangerous operations are audited — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/server/src/context.ts` `audit` (`VIBEFIX_HOME/audit.ndjson`) + route handlers across `projects.ts`, `runs.ts`, `approvals.ts`, and `health.ts` (`GET /api/audit`).
- **Current:** project open, clone, config update, run create/open/delete, checkpoint approve/reject/abort/resume, retention sweep, and project delete emit structured correlation-tagged `AuditRecord` entries.
- **Proving test:** `packages/server/test/security.test.ts` (`SEC-13 / AUD-01 / AUD-02` block).
- **Failure behavior:** denied or failed operations record `result: "denied" | "error"` with `errorCode` in the audit log.

### SEC-14 — Every request body is schema-validated — enforced — Owner: `@vibefix/security-eng`
- **Enforcement location:** `packages/schemas/src/api.ts` (`parseRequestBody` + strict route Zod schemas) wired across `projects.ts`, `runs.ts`, and `approvals.ts`.
- **Proving test:** `packages/server/test/request-validation.test.ts`.
- **Failure behavior:** HTTP 400 `E_INVALID_BODY` with field violation paths; run state untouched.

---

## 3. Reliability and recovery contract

### REL-01 — State-changing commands carry idempotency keys, applied atomically — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/server/src/context.ts` `withIdempotency` (serialized critical-section promise chain + atomic persistence to `VIBEFIX_HOME/idempotency.json`) + `packages/server/src/routes/approvals.ts`.
- **Current:** sequential or concurrent duplicate requests with the same `Idempotency-Key` execute in a single critical section, dispatching once and replaying the original 200 response with `X-Idempotent-Replay: true` across restarts.
- **Proving test:** `packages/server/test/runtime-correctness.test.ts` (sequential replay, concurrent single-dispatch serialization, and server-restart replay).
- **Failure behavior:** failed dispatches are not cached; duplicate requests without a key receive HTTP 409 from the phase guard.

### REL-02 — State transitions are validated centrally — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/domain/src/reducer.ts` (guards) + `packages/core/src/orchestrator/runtime.ts` `reduceAndPersist`.
- **Proving test:** `packages/core/test/reducer.test.ts`.
- **Failure behavior:** stale/out-of-phase events are no-ops with zero effects.

### REL-03 — State is persisted before success is reported — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/core/src/orchestrator/runtime.ts` `reduceAndPersist` + `packages/core/src/store/event-log.ts` `append`.
- **Proving test:** `packages/core/test/runtime-safety.test.ts` and `packages/server/test/runtime-correctness.test.ts`.
- **Failure behavior:** persistence failure rejects the transition/append before broadcasting or reporting HTTP 200 and increments `persistenceFailures`.

### REL-04 — Events have monotonically increasing, never-reused sequence numbers — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/core/src/store/event-log.ts` + `packages/core/src/store/run-lock.ts`.
- **Proving test:** `packages/core/test/durable-correctness.test.ts` and `packages/server/test/runtime-correctness.test.ts`.
- **Failure behavior:** failed appends do not advance or reuse sequence numbers; resumed logs continue strictly from `max(persisted seq) + 1`.

### REL-05 — WebSocket clients recover missed events exactly — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/server/src/websocket/replay.ts` `bridgeReplayToLive`, `packages/server/src/websocket/gateway.ts`, and `packages/ui/src/store.ts` (`since=${lastSeq}` + gap resync).
- **Proving test:** `packages/server/test/runtime-correctness.test.ts` (both unit-level bridge interleave and full socket-level `/ws` reconnect with `since=lastSeq` and live event interleave).
- **Failure behavior:** no event loss or duplication across replay/live handoff; sequence gaps trigger REST resync.

### REL-06 — REST snapshot recovery — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/server/src/routes/runs.ts` (`GET /api/projects/:enc/runs/:runId` and `/events?since=`).
- **Proving test:** `packages/server/test/runtime-correctness.test.ts` and `packages/server/test/security.test.ts`.
- **Failure behavior:** missing run ⇒ 404; corrupt `state.json` ⇒ 500 `{degraded:true}`; corrupt event lines counted in `corruptLineCount` / `replayDegraded`.

### REL-07 — Process restart does not silently lose run state — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/core/src/orchestrator/run-manager.ts` (`loadRun`, `resume`) + `packages/core/src/worktree/worktree-manager.ts` (`recoverInterruptedLanding`).
- **Proving test:** `packages/core/test/recovery.test.ts` (`GATE-07` kill-mid-run + resume to completion) and `packages/core/test/durable-correctness.test.ts`.
- **Failure behavior:** killed runs reload as `interrupted` and resume cleanly from their last persisted phase on explicit `resume()`.

### REL-08 — Interrupted runs are identified after restart — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/core/src/orchestrator/run-manager.ts` `loadRun`.
- **Proving test:** `packages/core/test/recovery.test.ts` and `packages/core/test/durable-correctness.test.ts`.
- **Failure behavior:** persisted `running` runs are reclassified and persisted as `interrupted`; never silently auto-resumed or reported as running.

### REL-09 — Corrupt persistence is reported as degraded — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/core/src/store/event-log.ts`, `packages/core/src/store/evidence-store.ts`, and `packages/server/src/routes/runs.ts`.
- **Proving test:** `packages/server/test/runtime-correctness.test.ts` and `packages/core/test/durable-correctness.test.ts`.
- **Failure behavior:** corrupt event lines, corrupt `state.json`, and corrupt evidence artifacts set machine-readable degraded indicators and counts.

### REL-10 — Failed background work is persisted and visible — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/server/src/routes/approvals.ts` + `packages/server/src/projects.ts` `track()`.
- **Proving test:** `packages/server/test/runtime-correctness.test.ts`.
- **Failure behavior:** background dispatch failure force-fails the run (`FATAL`) and increments `/api/health` `backgroundFailures`.

### REL-11 — Terminal runtimes are disposed — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/server/src/projects.ts` `watchForTerminal`.
- **Proving test:** `packages/server/test/runtime-correctness.test.ts`.
- **Failure behavior:** terminal runs are evicted from memory once background work settles; subsequent reads are served from disk.

### REL-12 — Child processes and timers are cleaned up — enforced — Owner: `@vibefix/platform-eng`
- **Enforcement location:** `packages/adapters/src/tools/git.ts` `runCommand` + `packages/adapters/src/tools/test-runner.ts` `NodeTestRunner`.
- **Current:** timeouts destroy stdout/stderr streams, terminate the process tree (`taskkill /T /F` on Windows, `SIGKILL` on POSIX), clear timers, and return `code: -1` with `"Command timed out after ...ms"` in `stderr`.
- **Proving test:** `packages/adapters/test/test-runner.test.ts`.
- **Failure behavior:** timed-out child and grandchild processes are killed; non-ok result with timeout diagnostic returned.

### REL-13 — Graceful shutdown, including the landing phase — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/server/src/main.ts` `createShutdownHandler` + `packages/server/src/projects.ts` `shutdown` + `packages/core/src/worktree/worktree-manager.ts` landing journal.
- **Proving test:** `packages/server/test/runtime-correctness.test.ts` (`createShutdownHandler` test) and `packages/core/test/recovery.test.ts` (landing journal recovery).
- **Failure behavior:** `SIGINT`/`SIGTERM` abort active runs, await in-flight tasks up to the shutdown timeout, close the server, and exit cleanly.

### REL-14 — Single writer per run (process lock) — enforced — Owner: `@vibefix/runtime-eng`
- **Enforcement location:** `packages/core/src/store/run-lock.ts` + `packages/core/src/orchestrator/run-manager.ts`.
- **Proving test:** `packages/core/test/durable-correctness.test.ts`.
- **Failure behavior:** second live writer is rejected with `E_RUN_LOCKED`; dead-PID lock is reclaimed automatically.

---

## 4. Behavior-preservation (safety) contract

### SAFE-01 — The original working tree is not modified before approval — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/worktree/worktree-manager.ts` and `packages/agents/src/agents/harness-builder.ts` (runs baseline test commands inside a temporary isolated worktree and discards it in `finally`).
- **Proving test:** `packages/core/test/primary-tree.test.ts` (`SAFE-01` primary-tree, `.git/config`, and `node_modules` invariance test).
- **Failure behavior:** primary checkout `git status`, `HEAD`, `.git/config`, and `node_modules` remain byte-for-byte unchanged across worktree creation, baseline runs, engineer failures, and discard.

### SAFE-02 — All writes occur inside the approved worktree, with resolved-path containment — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/agents/src/agents/engineer.ts` `resolveContainedTarget`.
- **Proving test:** `packages/agents/test/engineer-containment.test.ts`.
- **Failure behavior:** escaping write rejected with `E_PATH_ESCAPE`, violation recorded, attempt fails closed.

### SAFE-03 — The worktree starts from a recorded commit — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/worktree/worktree-manager.ts` (`baseCommit` captured at creation) + `packages/core/src/orchestrator/runtime.ts` (`baseCommit` persisted in `ChangeLedgerEntry`).
- **Proving test:** `packages/core/test/primary-tree.test.ts` and `packages/agents/test/verification-fail-closed.test.ts`.
- **Failure behavior:** missing `baseCommit` causes verifiers to reject the attempt immediately.

### SAFE-04 — Only the approved writer can modify code — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/agents/src/definitions.ts` (single `worktree-write` permission on `engineer`), `packages/core/src/orchestrator/runtime.ts`, and `scripts/lint.mjs` (`SAFE-04` AST lint rule forbidding `node:fs` imports in any agent under `packages/agents/src` except `engineer.ts`).
- **Proving test:** `packages/agents/test/permissions.test.ts` (`GATE-03 / SAFE-04`).
- **Failure behavior:** any non-engineer `node:fs` import fails `pnpm lint` and `permissions.test.ts`.

### SAFE-05 — Changes are limited to approved files and operations — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/worktree/firewall.ts` + `packages/agents/src/agents/engineer.ts`.
- **Proving test:** `packages/core/test/firewall.test.ts`.
- **Failure behavior:** denied write records a `firewall-violation` artifact and auto-rejects at 2 cumulative violations.

### SAFE-06 — Protected paths cannot be modified — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/worktree/firewall.ts`.
- **Proving test:** `packages/core/test/firewall.test.ts`.
- **Failure behavior:** denial + violation record.

### SAFE-07 — Lockfiles and dependency files require explicit approval — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/worktree/firewall.ts`.
- **Proving test:** `packages/core/test/firewall.test.ts`.
- **Failure behavior:** denial + violation record unless verbatim in user-approved `filesInScope`.

### SAFE-08 — Proposal scope cannot silently change after approval — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/orchestrator/runtime.ts` `proposalScopeHash` (`SHA-256` of approved scope/constraints stored in `state.approval.scopeHashes` at `CHECKPOINT_APPROVED` and verified before each attempt).
- **Proving test:** `packages/core/test/primary-tree.test.ts` (`SAFE-08` tampered-backlog test).
- **Failure behavior:** hash mismatch rejects the attempt with `E_SCOPE_MUTATED` before invoking the engineer and records the rejection in the ledger.

### SAFE-09 — The final diff is checked after execution — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/agents/src/agents/verifier.ts` and `packages/agents/src/agents/regression-sentinel.ts` (`firewall-scope` gate over committed `git diff baseCommit..HEAD`).
- **Proving test:** `packages/agents/test/permissions.test.ts` (`SAFE-09` planted out-of-scope / forbidden-zone diff test).
- **Failure behavior:** `firewall-scope` gate records `FAIL` and rejects the attempt; changes never land.

### SAFE-10 — Verification is structurally blinded and fails closed — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/agents/src/runtime/context-builder.ts`, `packages/agents/src/runtime/decision-agent.ts`, and `packages/agents/src/agents/verifier.ts`.
- **Proving test:** `packages/agents/test/verification-fail-closed.test.ts`.
- **Failure behavior:** unavailable decision provider or failing gate rejects the change; nothing lands.

### SAFE-11 — Failed verification prevents completion — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/domain/src/reducer.ts`.
- **Proving test:** `packages/core/test/reducer.test.ts`.
- **Failure behavior:** rejected proposal retries up to budget then defers; never lands.

### SAFE-12 — Retry limits bound modification attempts — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/domain/src/reducer.ts` (`maxRetriesPerChange: 2` → 3 attempts total).
- **Proving test:** `packages/core/test/reducer.test.ts`.
- **Failure behavior:** exhausted retries transition the proposal to `deferred`.

### SAFE-13 — Every change has a rollback or discard path — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/worktree/worktree-manager.ts` `discard` (verifies directory removal post-discard, retries, and throws `E_DISCARD_FAILED` if still present).
- **Proving test:** `packages/core/test/recovery.test.ts` (`SAFE-13`) and `packages/core/test/e2e.test.ts`.
- **Failure behavior:** worktree and `vibefix/*` branch removed; unremovable directory throws `E_DISCARD_FAILED`.

### SAFE-14 — Human approval gates execution — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/domain/src/reducer.ts`.
- **Proving test:** `packages/core/test/reducer.test.ts`.
- **Failure behavior:** execution events before `CHECKPOINT_APPROVED` are ignored.

### SAFE-15 — Landing is crash-recoverable on the user's repository — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/worktree/worktree-manager.ts` (`landing-journal.json` + `recoverInterruptedLanding`).
- **Proving test:** `packages/core/test/recovery.test.ts` (`SAFE-15` kill-mid-cherry-pick test) and `packages/core/test/durable-correctness.test.ts`.
- **Failure behavior:** interrupted cherry-pick is deterministically aborted on project open, leaving a clean user branch.

### SAFE-16 — Firewall violations accumulate per proposal — enforced — Owner: `@vibefix/safety-eng`
- **Enforcement location:** `packages/core/src/orchestrator/runtime.ts` + `packages/core/src/worktree/firewall.ts` (`initialViolations` seeded across retries).
- **Proving test:** `packages/core/test/firewall.test.ts`.
- **Failure behavior:** 2 cumulative violations across attempts auto-reject and defer the proposal.

---

## 5. Resource and cost contract

Every limit below has a numeric default enforced in code and covered by automated tests (`Owner: @vibefix/platform-eng`).

| ID | Limit | Default / source | Status | On limit reached — outcome / user sees / persisted |
|---|---|---|---|---|
| RES-01 | Repository size | **500 MiB** (`524_288_000` bytes, `VIBEFIX_MAX_REPO_BYTES`, `context.ts` / `routes/projects.ts`) | **enforced** (`security.test.ts`) | Reject at registration with HTTP 400 `E_REPO_TOO_LARGE`; audited. |
| RES-02 | File count analyzed | **400** (harness pin, `harness-builder.ts`); **25** in-scope (`engineer.ts`) | **enforced** (`permissions.test.ts`) | Truncated analysis disclosed in `behavioral-baseline.excluded` (`truncatedAt:400`). |
| RES-03 | Individual file size | **200,000** chars (`security-agent.ts`); **30,000** render (`context-builder.ts`) | **enforced** (`permissions.test.ts`) | Skipped oversized files disclosed in `findings.notes` (`degraded: skipped N oversized file(s)`). |
| RES-04 | Analysis duration | **600,000 ms** (10 min, `budgets.analysisTimeoutMs`, `routing.ts` / `runtime.ts`) | **enforced** (`primary-tree.test.ts`) | Phase fails with `E_TIME_BUDGET`; partial evidence retained; `run.failed` event persisted. |
| RES-05 | Run duration | **1,800,000 ms** (30 min, `budgets.runTimeoutMs`, `routing.ts` / `runtime.ts`) | **enforced** (`primary-tree.test.ts`) | Run fails with `E_TIME_BUDGET`; worktrees discarded; `run.failed` event persisted. |
| RES-06 | Child-process duration | **30s** git / **60s–300s** commands / **600s** clone / **120s** LLM HTTP (`git.ts`; `test-runner.ts`; `projects.ts`; `http.ts`) | **enforced** (`test-runner.test.ts`) | Process tree killed (`taskkill /T /F` on Windows, `SIGKILL` on POSIX); `code: -1` + timeout message persisted. |
| RES-07 | Concurrent runs | **4** (`VIBEFIX_MAX_ACTIVE_RUNS`, `context.ts` / `routes/runs.ts`) | **enforced** (`security.test.ts`) | HTTP 429 `E_RUN_LIMIT`; audited; no run created. |
| RES-07b | Concurrent clones / clone rate | **2** concurrent / **10** per minute (`context.ts` / `routes/projects.ts`) | **enforced** (`security.test.ts`) | HTTP 429 with `Retry-After`; no clone started. |
| RES-07c | Request rate / body size | **600** req/min per client; **1 MiB** bodies (`RateLimiter`; Fastify `bodyLimit`) | **enforced** (`security.test.ts`) | HTTP 429 + `Retry-After`; oversized body rejected by Fastify. |
| RES-08 | Agent/pool concurrency | **3** (`POOL_CONCURRENCY`, `runtime.ts`) | **enforced** (`e2e.test.ts`) | Bounded worker pool (max 3 concurrent agents per phase). |
| RES-09 | Retry count per change | **2** (`maxRetriesPerChange`, `routing.ts`) | **enforced** (`reducer.test.ts`) | Change deferred after 3 total attempts; ledger + report updated. |
| RES-10 | LLM calls per run | **120** (`budgets.maxLlmCallsPerRun`, `routing.ts` / `budget.ts`) | **enforced** (`primary-tree.test.ts`) | `BudgetMeter.exceeded` triggers run abort with `"LLM call budget exhausted"`. |
| RES-11 | Output tokens per call | **8,192** (`maxOutputTokens`, `routing.ts`) | **enforced** (`roundtrip.test.ts`) | Capped per provider configuration in `ModelRoutingSchema`. |
| RES-12 | Run & agent token budgets | **2,000,000** run / **500,000** per agent + warn at **0.8** (`routing.ts`; `budget.ts`; `runtime.ts`) | **enforced** (`primary-tree.test.ts`) | Emits `budget.warning` at 80%; aborts run when run or agent token cap is exceeded. |
| RES-13 | Estimated cost ceiling | **$10.00 USD** (`budgets.maxCostUsd`, `routing.ts`; `budget.ts`; `executor.ts`) | **enforced** (`primary-tree.test.ts`) | Per-call cost computed from provider pricing; aborts run when `maxCostUsd` is exceeded. |
| RES-14 | Worktree count | **8** (`budgets.maxWorktreesPerRun`, `routing.ts`; `worktree-manager.ts`) | **enforced** (`primary-tree.test.ts`) | Throws `E_WORKTREE_LIMIT` when active worktrees for the project reach the ceiling. |
| RES-15 | Disk usage | **2 GiB** (`2_147_483_648` bytes, `VIBEFIX_MAX_DISK_BYTES`, `context.ts`) | **enforced** (`security.test.ts`) | New runs and clones rejected with HTTP 507 `E_DISK_BUDGET`; audited. |
| RES-16 | Artifact/report size | **200,000** chars ledger diff (`runtime.ts`); **8,000** chars command output tail (`test-runner.ts`) | **enforced** (`test-runner.test.ts`) | Truncated with `...` prefix / `[truncated]` marker before persistence. |

---

## 6. Data and privacy contract

Owner for `DAT-01..09`: `@vibefix/security-eng`.

- **DAT-01 Storage location — enforced.** All run state, evidence, worktrees, and clones live under `VIBEFIX_HOME` (`packages/core/src/store/paths.ts`; proven in `e2e.test.ts` and `primary-tree.test.ts`).
- **DAT-02 Provider payload scope — enforced.** Sensitive files (`.env*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`) are excluded from snapshots and outbound text/decision prompts pass through `redactSecrets` (`packages/agents/test/provider-redaction.test.ts`).
- **DAT-03 Secret redaction — enforced.** Shared `redactSecrets`/`redactUnknown` scrub logs, events, state errors, evidence artifacts, ledger diffs/notes, markdown reports, and diagnostics (`packages/server/test/redaction.test.ts`, `packages/schemas/test/redaction.test.ts`).
- **DAT-04 Provider requests structurally non-persisted — enforced.** Raw prompt/response bodies are never written to events or logs, and `scripts/lint.mjs` enforces an AST rule (`[DAT-04]`) forbidding prompt identifiers in logger/event calls (`packages/agents/test/permissions.test.ts`).
- **DAT-05 Retention — enforced.** Configurable per-project run retention (`VIBEFIX_RETENTION_MAX_RUNS`, default `20`) swept via `POST /api/projects/:enc/sweep` and `context.sweepRetention`, preserving active runs (`packages/server/test/security.test.ts`).
- **DAT-06 User deletion — enforced.** `DELETE /api/projects/:enc/runs/:runId` and `DELETE /api/projects/:enc` remove run directories, worktrees, project state, and managed clones with audit records (`packages/server/test/security.test.ts`).
- **DAT-07 Diagnostics exclude secrets — enforced.** `GET /api/diagnostics` passes the entire bundle through `redactUnknown` (`packages/server/test/redaction.test.ts`).
- **DAT-08 API keys env-only — enforced.** LLM keys are read exclusively from environment variables (`packages/llm/src/router.ts`); GitHub clone tokens use an ephemeral `0600` credential store deleted in `finally` (`packages/server/test/security.test.ts`).
- **DAT-09 Prompts/responses persistence — enforced.** Prompts are never persisted; structured model outputs are persisted only as redacted, schema-validated evidence artifacts (`packages/server/test/redaction.test.ts`).

---

## 7. Auditability contract

Owner for `AUD-01..02`: `@vibefix/security-eng`.

- **AUD-01 Correlation fields — enforced.** `AuditRecord` (`packages/server/src/context.ts`) records `auditId`, `ts`, `requestId`, `commandId`, `projectId`, `runId`, `actor`, `action`, `result`, `errorCode`, and redacted `detail` on every audited operation (`packages/server/test/security.test.ts`).
- **AUD-02 Audited operations — enforced.** Project open, clone, config update, run create/open/delete, checkpoint approve/reject/abort/resume, retention sweep, and project deletion append structured records to `VIBEFIX_HOME/audit.ndjson` and expose them via `GET /api/audit` (`packages/server/test/security.test.ts`).

## 8. Observability contract

Owner for `OBS-01..08`: `@vibefix/platform-eng`.

- **OBS-01 Structured logs — enforced.** `packages/core/src/logger.ts` emits structured log lines with `redactSecrets` and `redactUnknown` (`packages/schemas/test/redaction.test.ts`).
- **OBS-02 Health endpoint — enforced.** `GET /api/health` reports liveness, dynamic package version, `activeRuntimes`, and `backgroundFailures` (`packages/server/test/runtime-correctness.test.ts`).
- **OBS-03 Readiness endpoint — enforced.** `GET /api/ready` reports readiness, `activeRuns`, and `maxConcurrentRuns` (`packages/server/test/runtime-correctness.test.ts`).
- **OBS-04 Stable error codes — enforced.** Routes and core errors emit machine-readable codes (`E_INVALID_BODY`, `E_PATH_ESCAPE`, `E_REPO_TOO_LARGE`, `E_DISK_BUDGET`, `E_RUN_LIMIT`, `E_RUN_LOCKED`, `E_SCOPE_MUTATED`, `E_TIME_BUDGET`, `E_WORKTREE_LIMIT`, `E_DISCARD_FAILED`).
- **OBS-05 Metrics endpoint — enforced.** `GET /api/metrics` exposes `activeRuntimes`, `activeRuns`, `backgroundFailures`, `diskUsageBytes`, `maxDiskBytes`, and `maxConcurrentRuns` (`packages/server/test/runtime-correctness.test.ts`).
- **OBS-06 Degraded indicators — enforced.** Corrupt event lines, corrupt `state.json`, unpersisted events, corrupt evidence artifacts, and file-count/size truncations surface explicit degraded flags (`packages/server/test/runtime-correctness.test.ts`, `packages/agents/test/permissions.test.ts`).
- **OBS-07 Diagnostics bundle — enforced.** `GET /api/diagnostics` exports a redacted bundle of health, limits, disk usage, and recent audit entries (`packages/server/test/redaction.test.ts`, `packages/server/test/runtime-correctness.test.ts`).
- **OBS-08 Correlation IDs — enforced.** Request and command correlation IDs propagate into `AuditRecord` entries (`packages/server/test/security.test.ts`).

## 9. Compatibility and migration contract

Owner for `MIG-01..06`: `@vibefix/runtime-eng`.

- **MIG-01 Artifact schema versioning — enforced.** `packages/schemas/src/migrations.ts`; proven in `packages/schemas/test/roundtrip.test.ts`.
- **MIG-02 State/event schema versioning — enforced.** `RunStateSchema` and `AgentExecutionEventSchema` carry `schemaVersion: 1`; `migrateRunState` and `migrateEvent` validate and migrate on-disk state and events (`packages/schemas/test/roundtrip.test.ts`).
- **MIG-03 Migration walk — enforced.** Missing migration steps fail loudly naming the artifact/state/event and version (`packages/schemas/test/roundtrip.test.ts`).
- **MIG-04 Backup before upgrades — unsupported (release 1 baseline).** Downgraded per v3.1: no prior release exists whose data must survive an upgrade; becomes applicable at schema version 2.
- **MIG-05 N-1 compatibility — enforced (release 1 baseline).** Unversioned v1 state and event records normalize cleanly through `migrateRunState` and `migrateEvent` (`packages/schemas/test/roundtrip.test.ts`).
- **MIG-06 Unknown/future versions fail loudly — enforced.** Future `schemaVersion` values on artifacts, `state.json`, or `events.ndjson` throw explicit upgrade errors (`packages/schemas/test/roundtrip.test.ts`).

---

## 10. Release gates

Every gate names its owner and its green proof.

| ID | Gate | Owner | Proof | Status |
|---|---|---|---|---|
| GATE-01 | Clean install | `@vibefix/platform-eng` | `pnpm install --frozen-lockfile && pnpm build` (Node ≥ 20); `.github/workflows/ci.yml` (Ubuntu + Windows) | **green** |
| GATE-02 | Typecheck | `@vibefix/platform-eng` | `pnpm typecheck` (all workspace packages incl. UI) | **green** |
| GATE-03 | Lint | `@vibefix/platform-eng` | `pnpm lint` (`scripts/lint.mjs` AST linter + `packages/agents/test/permissions.test.ts`) | **green** |
| GATE-04 | Build | `@vibefix/platform-eng` | `pnpm build` (incl. UI) | **green** |
| GATE-05 | Tests | `@vibefix/platform-eng` | `pnpm test` (25 test files, 160 passing tests across schemas/adapters/core/agents/server/test-fixtures) | **green** |
| GATE-06 | Security | `@vibefix/security-eng` | `packages/server/test/security.test.ts`, `bind.test.ts`, `request-validation.test.ts`, `packages/agents/test/permissions.test.ts` (`SEC-01..14`) | **green** |
| GATE-07 | Restart recovery | `@vibefix/runtime-eng` | `packages/core/test/recovery.test.ts` + `packages/core/test/durable-correctness.test.ts` (`REL-07`, `REL-08`, `SAFE-13`, `SAFE-15`) | **green** |
| GATE-08 | WS replay | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts` (bridge interleave + real WebSocket reconnect with `since=lastSeq`, `REL-05`) | **green** |
| GATE-09 | Firewall | `@vibefix/safety-eng` | `packages/core/test/firewall.test.ts`, `packages/agents/test/engineer-containment.test.ts`, `packages/agents/test/permissions.test.ts` (`SAFE-02`, `SAFE-04..09`, `SAFE-16`) | **green** |
| GATE-10 | Behavior e2e | `@vibefix/safety-eng` | `packages/core/test/e2e.test.ts`, `packages/core/test/primary-tree.test.ts`, `packages/agents/test/verification-fail-closed.test.ts` (`SAFE-01`, `SAFE-03`, `SAFE-10`, `SAFE-13`) | **green** |
| GATE-11 | Credential redaction | `@vibefix/security-eng` | `packages/server/test/redaction.test.ts`, `packages/schemas/test/redaction.test.ts`, `packages/agents/test/provider-redaction.test.ts` (`SEC-10/11`, `DAT-02/03/07`) | **green** |
| GATE-12 | Resource limits | `@vibefix/platform-eng` | `packages/core/test/primary-tree.test.ts`, `packages/server/test/security.test.ts`, `packages/adapters/test/test-runner.test.ts` (`RES-01..16`, `DAT-05/06`) | **green** |
| GATE-13 | Docs match implementation | `@vibefix/platform-eng` | Contract v3.2, `docs/production-acceptance-criteria.md` v3.0, `AGENTS.md`, `docs/PHASES.md`, and `docs/ui-redesign-and-production-plan.md` reconciled with named owners | **green** |
| GATE-14 | No critical known vulnerability | `@vibefix/security-eng` | Zero open blocker or critical criteria in `docs/production-acceptance-criteria.md`; `pnpm verify` green | **green** |

---

## Contract summary

| ID | Guarantee | Status | Enforcement location | Proving test | Owner | Release blocker |
|---|---|---|---|---|---|---|
| SEC-01 | Loopback default bind | **enforced** | `main.ts` `resolveListenConfig` | `bind.test.ts` | `@vibefix/security-eng` | No |
| SEC-02 | Remote bind requires opt-in + auth | **enforced** | `auth/permissions.ts` `assertBindingAllowed` | `security.test.ts`, `bind.test.ts` | `@vibefix/security-eng` | No |
| SEC-03 | REST authentication | **enforced** | `auth/token-auth.ts` `authHook` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-04 | WS authentication | **enforced** | `authHook` + `websocket/gateway.ts` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-05 | CORS allowlist | **enforced** | `app.ts` + `origin-policy.ts` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-06 | Project isolation | **enforced** | `context.ts` `resolveRun`; `routes/repositories.ts` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-07 | Run scoping | **enforced** | `context.ts` `resolveRun` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-08 | Path-escape prevention | **enforced** | `policies/path-policy.ts` `isPathInside` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-09 | Symlink rejection | **enforced** | `routes/repositories.ts` + `engineer.ts` `fs.realpath` | `security.test.ts`, `engineer-containment.test.ts` | `@vibefix/security-eng` | No |
| SEC-10 | Secret non-exposure | **enforced** | `schemas/src/redaction.ts` + store/logger/provider/diagnostics | `server/test/redaction.test.ts`, `schemas/test/redaction.test.ts` | `@vibefix/security-eng` | No |
| SEC-11 | Secure git credentials | **enforced** | `routes/projects.ts` + `resource-policy.ts` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-12 | Execution policy (fail-closed landing) | **enforced** | `config.ts` + `executor.ts` + `verifier.ts` + `regression-sentinel.ts` | `permissions.test.ts` | `@vibefix/security-eng` | No |
| SEC-13 | Dangerous ops audited | **enforced** | `context.ts` `audit` + `GET /api/audit` | `security.test.ts` | `@vibefix/security-eng` | No |
| SEC-14 | Request-body validation | **enforced** | `schemas/src/api.ts` `parseRequestBody` | `request-validation.test.ts` | `@vibefix/security-eng` | No |
| REL-01 | Idempotent, atomic commands | **enforced** | `context.ts` `withIdempotency` + `routes/approvals.ts` | `runtime-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-02 | Central transition validation | **enforced** | `domain/src/reducer.ts` | `reducer.test.ts` | `@vibefix/runtime-eng` | No |
| REL-03 | Persist before report | **enforced** | `runtime.ts` + `event-log.ts` | `runtime-safety.test.ts`, `runtime-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-04 | Monotonic, never-reused seq | **enforced** | `event-log.ts` + `run-lock.ts` | `durable-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-05 | Exact WS missed-event recovery | **enforced** | `websocket/replay.ts` + `gateway.ts` + `ui/src/store.ts` | `runtime-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-06 | REST snapshot recovery | **enforced** | `routes/runs.ts` | `runtime-correctness.test.ts`, `security.test.ts` | `@vibefix/runtime-eng` | No |
| REL-07 | Restart durability | **enforced** | `run-manager.ts` `loadRun`/`resume` | `recovery.test.ts`, `durable-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-08 | Interrupted-run identification | **enforced** | `run-manager.ts` | `recovery.test.ts`, `durable-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-09 | Corrupt persistence → degraded | **enforced** | `event-log.ts` + `evidence-store.ts` + `routes/runs.ts` | `runtime-correctness.test.ts`, `durable-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-10 | Background failures visible | **enforced** | `routes/approvals.ts` + `projects.ts` `track` | `runtime-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-11 | Terminal runtime disposal | **enforced** | `projects.ts` `watchForTerminal` | `runtime-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| REL-12 | Child/timer cleanup | **enforced** | `adapters/src/tools/git.ts` + `test-runner.ts` | `test-runner.test.ts` | `@vibefix/platform-eng` | No |
| REL-13 | Graceful shutdown incl. landing | **enforced** | `main.ts` `createShutdownHandler` + `projects.ts` | `runtime-correctness.test.ts`, `recovery.test.ts` | `@vibefix/runtime-eng` | No |
| REL-14 | Single-writer run lock | **enforced** | `run-lock.ts` + `run-manager.ts` | `durable-correctness.test.ts` | `@vibefix/runtime-eng` | No |
| SAFE-01 | Primary tree unmodified pre-approval | **enforced** | `worktree-manager.ts` + `harness-builder.ts` | `primary-tree.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-02 | Resolved-path worktree containment | **enforced** | `engineer.ts` | `engineer-containment.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-03 | Recorded base commit | **enforced** | `worktree-manager.ts` + `runtime.ts` | `primary-tree.test.ts`, `verification-fail-closed.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-04 | Single-writer capability | **enforced** | `definitions.ts` + `scripts/lint.mjs` | `permissions.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-05 | Approved-scope writes | **enforced** | `firewall.ts` | `firewall.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-06 | Protected paths | **enforced** | `firewall.ts` | `firewall.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-07 | Lockfile/manifest approval | **enforced** | `firewall.ts` | `firewall.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-08 | Post-approval scope integrity | **enforced** | `runtime.ts` `proposalScopeHash` | `primary-tree.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-09 | Final diff checked | **enforced** | `verifier.ts` + `regression-sentinel.ts` | `permissions.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-10 | Blinded, fail-closed verification | **enforced** | `context-builder.ts` + `decision-agent.ts` + `verifier.ts` | `verification-fail-closed.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-11 | Failed verification blocks completion | **enforced** | `reducer.ts` | `reducer.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-12 | Retry limits (3 attempts) | **enforced** | `reducer.ts` | `reducer.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-13 | Rollback/discard path | **enforced** | `worktree-manager.ts` `discard` | `recovery.test.ts`, `e2e.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-14 | Human approval gate | **enforced** | `reducer.ts` | `reducer.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-15 | Crash-recoverable landing | **enforced** | `worktree-manager.ts` landing journal | `recovery.test.ts`, `durable-correctness.test.ts` | `@vibefix/safety-eng` | No |
| SAFE-16 | Cumulative violation counter | **enforced** | `runtime.ts` + `firewall.ts` | `firewall.test.ts` | `@vibefix/safety-eng` | No |
| RES-01..16 | Resource & cost ceilings (`§5`) | **enforced** | `routing.ts`, `budget.ts`, `runtime.ts`, `context.ts`, `worktree-manager.ts` | `primary-tree.test.ts`, `security.test.ts`, `permissions.test.ts`, `test-runner.test.ts` | `@vibefix/platform-eng` | No |
| DAT-01..09 | Data & privacy (`§6`) | **enforced** | `redaction.ts`, `context.ts`, `routes/projects.ts`, `routes/runs.ts`, `scripts/lint.mjs` | `server/test/redaction.test.ts`, `security.test.ts`, `permissions.test.ts` | `@vibefix/security-eng` | No |
| AUD-01/02 | Structured audit log (`§7`) | **enforced** | `context.ts` `audit` + `GET /api/audit` | `security.test.ts` | `@vibefix/security-eng` | No |
| OBS-01..08 | Observability & diagnostics (`§8`) | **enforced** | `logger.ts`, `routes/health.ts`, `routes/runs.ts` | `runtime-correctness.test.ts`, `server/test/redaction.test.ts` | `@vibefix/platform-eng` | No |
| MIG-01..06 | Schema versioning & migration (`§9`) | **enforced** | `schemas/src/migrations.ts` | `roundtrip.test.ts` | `@vibefix/runtime-eng` | No |
