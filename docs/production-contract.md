# VibeFix Production Contract

**Version:** 3.1 — incorporates the hostile review (`docs/production-contract-review.md`, findings F-01…F-26) **and the repair program** (Phases 1–4 of `docs/PHASES.md`, 2026-09-29). Supersedes v3.0.
**Date:** 2026-09-29
**Companion documents:** `docs/production-contract-audit.md` (evidence, pre-repair), `docs/production-contract-review.md` (adversarial review), `docs/production-acceptance-criteria.md` (testable criteria), `docs/PHASES.md` (repair-program status).
**Status of the product:** not production-ready. This document does not claim otherwise; see §10.

**Normative rules for this document:**
1. An item may be marked **enforced** only when a passing test in this repository proves it.
2. Every item separates **Current** (verified behavior today), **Target** (required behavior before the item can be called enforced), and where relevant **Unsupported** (explicitly not provided — do not rely on it).
3. Every important item states its **failure behavior**: what happens, what the user sees, and what is persisted when the guarantee cannot be honored.
4. Every enforced item names its **enforcement location** (file/symbol). Every item has an **Owner** field; today every owner is `unassigned`, and assigning them is itself a release requirement (F-01).
5. A resource limit without a numeric value at release is a **defect**, not a TBD (F-02). Values still marked TBD below must be set before release.

| Status | Definition |
|---|---|
| **enforced** | Implemented; a passing test asserts it. |
| **partially enforced** | Implemented, untested, and no known contradiction — or tested with a named remaining gap. |
| **contradicted** | The audit verified that current code violates the guarantee. |
| **planned** | Not implemented; the required work is named. |
| **unsupported** | Explicitly not provided in this release; stated so no one relies on it. |

**Trusted-environment assumption (revised in v3.1):** the API now requires a bearer token on every endpoint except `/api/health`, binds loopback by default, refuses non-loopback binding without explicit opt-in plus a strong token, restricts CORS to the UI origins, and refuses foreign `Origin` headers outright (SEC-01…05). The remaining assumption is a **single trusted operator**: any local process running as the same user can read `~/.vibefix/server-token` (mode 0600) and therefore drive the API, including approval. Protection against a malicious local user/process remains explicitly **unsupported** (see §1.2). A running server must still be treated as privileged.

**Local-first single-user scope (unchanged):** one operator, one machine. Multi-user, remote, and hosted deployment are out of scope (§1.2).

---

## 1. Product scope

### 1.1 Supported product (target deployment model)

1. **Local-first application.** All run state, evidence, worktrees, and clones live under the VibeFix home (`~/.vibefix`, override `VIBEFIX_HOME`), never inside the analyzed repository (`packages/core/src/store/paths.ts`). *Current:* holds for run data; two pre-approval exceptions exist (SAFE-001).
2. **Single-user deployment.** One operator, one machine; no identity model is claimed.
3. **Local server and UI.** Fastify control plane, default `127.0.0.1:8630` (`packages/server/src/main.ts`), plus a Vite/React UI proxied to it (the proxy injects the API token server-side).
4. **Optional external LLM providers.** Keys sourced from the environment (`packages/llm/src/router.ts`); analysis runs without keys; code modification requires a routed model.
5. **Repositories through approved paths.** Operator registers a local git repo (clean tree asserted, `run-manager.ts` `assertClean`) or clones from GitHub. **A folder with no git trace can be opened opt-in** (`initGit`): VibeFix initializes a repository with one baseline commit of the current contents (`GitTool.initBaseline`; tested in `packages/server/test/open-project.test.ts`).
6. **Isolated git worktrees for modifications** — directory-convention isolation under `~/.vibefix/projects/<key>/worktrees/` on `vibefix/*` branches (`worktree-manager.ts`). **This is not an OS-level sandbox** (see SAFE-002, SAFE-004).
7. **Human approval before code changes.** Execution starts only on `CHECKPOINT_APPROVED` (`reducer.ts`); CLI `--yes` is an explicit operator opt-in bypassing the human checkpoint only.
8. **Independent verification after changes** — *structurally blinded* verification (diff + proposal + gates, never the engineer's rationale). "Independent" does **not** mean diverse judges: all three verifiers may share one provider model by default (SAFE-010).

### 1.2 Explicitly out of scope / unsupported for the first production release

| Out of scope / unsupported | Consequence |
|---|---|
| Multi-tenant hosted SaaS | No tenancy, isolation, or quotas designed or claimed. |
| Anonymous remote access | Remote binding requires explicit opt-in + strong token (SEC-02, enforced); anything beyond that is **unsupported**. |
| Model-diverse verification (three different providers) | **Unsupported** this release: blinded structure only; single-provider correlation risk is documented (SAFE-010). |
| OS-level sandboxing of agent processes | **Unsupported**: SAFE-004 targets capability injection, not process isolation. |
| Protection against a malicious local user/process | **Unsupported**: the trusted-environment assumption above states the boundary. |
| Unrestricted execution of arbitrary repository scripts | Execution without an approved policy is a **defect** (SEC-12), not a feature. |
| Automatic merging without verification | No bypass exists or is planned. |
| Unrestricted filesystem access | Scoped-path access is the contract (SEC-06..09); the remaining browse-breadth deviation is a named gap. |

---

## 2. Security contract

Format: **Guarantee — Status — Owner: unassigned.** Current / Target / Failure behavior. (Threat and enforcement location are inline; full criteria in the acceptance document.)

### SEC-01 — Server binds to 127.0.0.1 by default — partially enforced — Owner: unassigned
- **Current:** `packages/server/src/main.ts` — loopback unless `VIBEFIX_HOST` overrides; any non-loopback override is gated by the tested binding guard (SEC-02). The default value itself is not directly asserted by a test.
- **Target:** `packages/server/test/bind.test.ts` asserting the listen address with no env set.
- **Failure behavior:** none defined today. Target: startup failure is loud and the process exits non-zero.

### SEC-02 — Remote binding requires an explicit opt-in flag AND authentication — enforced — Owner: unassigned
- **Enforcement location:** `packages/server/src/security.ts` `assertBindingAllowed`, wired in `main.ts` (refusal logged, `process.exit(1)`).
- **Current:** a non-loopback host exits the process **before listening** unless BOTH `VIBEFIX_ALLOW_REMOTE=1` and `VIBEFIX_API_TOKEN` (≥16 chars) are set; the refusal message names both conditions. Supersedes the `E_REMOTE_REFUSED` code-name target with equivalent behavior.
- **Proving test:** `packages/server/test/security.test.ts` (binding-guard block: default refusal; opt-in without token refused; both conditions required; loopback always allowed).
- **Failure behavior:** exit non-zero before binding; nothing listens.

### SEC-03 — Sensitive REST endpoints require authentication — enforced — Owner: unassigned
- **Enforcement location:** `packages/server/src/security.ts` `authHook`/`getApiToken`/`tokenEquals` (SHA-256 + `timingSafeEqual`; token from `VIBEFIX_API_TOKEN` or a generated 32-byte value persisted mode 0600 at `~/.vibefix/server-token`).
- **Current:** every route except `GET /api/health` requires the token (`Authorization: Bearer`, `X-VibeFix-Token`, or `?token=` for WS). The Vite dev/preview proxy reads the token file and injects the header — the browser never holds it.
- **Proving test:** `security.test.ts` (auth block: 401 without/with-wrong token, 200 via both headers, health public, length-safe compare) and the token-persistence block (generate → reuse; env override wins).
- **Failure behavior:** 401, no state change.

### SEC-04 — WebSocket connections require authentication — partially enforced — Owner: unassigned
- **Current:** `/ws` is gated by the same auth hook (query token accepted — browsers cannot set headers on upgrades) plus an in-handler re-check that closes the socket with 4401; no test drives a real socket upgrade, so this stays partially enforced.
- **Target:** socket-level test (unauthorized upgrade closed before any frame).
- **Failure behavior (current):** upgrade refused / socket closed 4401; no frames sent.

### SEC-05 — CORS uses an explicit allowlist — enforced — Owner: unassigned
- **Enforcement location:** `app.ts` (`cors({ origin: allowlist })`, default `localhost:5173`/`127.0.0.1:5173`, override `VIBEFIX_UI_ORIGIN`) + `security.ts` `originCheckHook`.
- **Current:** allowlist-only CORS **and** any request carrying a foreign `Origin` header is refused with 403 outright — CORS alone only governs what a browser may read; the hook stops the request from executing (DNS-rebinding/CSRF defense).
- **Proving test:** `security.test.ts` (origin block: foreign origin 403, allowed origin 200, non-browser clients pass, preflight advertises only the allowed origin).
- **Failure behavior:** preflight denied; foreign-origin requests 403; no data returned.

### SEC-06 — Projects cannot access another project's files or runs — partially enforced — Owner: unassigned
- **Current:** every run route resolves through `/api/projects/:enc/runs/:runId/*` with registry/disk verification (see SEC-07, tested); the whole-disk `findRunDir` scan is removed; `/api/fs/browse` still lists any directory (authenticated — it is the project picker's core feature).
- **Target:** browse restricted to registered roots (or moved to a desktop-only capability).
- **Failure behavior (current):** cross-project run access ⇒ 404; browse remains broad by design until the target lands.

### SEC-07 — Run IDs are scoped to projects — enforced — Owner: unassigned
- **Enforcement location:** `app.ts` `resolveRun` (live runtime must match the project's registry key, else the run dir must live under that project's `runs/`, else 404) + `security.ts` `isValidRunId` (shape validation, no traversal).
- **Proving test:** `security.test.ts` (project-scoped runs block: state/events/approve cross-project ⇒ 404; malformed ids ⇒ 400/404, never 200).
- **Failure behavior:** 404; no data returned, no mutation.

### SEC-08 — Repository-relative paths cannot escape the approved root — enforced — Owner: unassigned
- **Enforcement location:** `security.ts` `isPathInside` (`path.relative` containment — never a string prefix) on the `/file` route.
- **Proving test:** `security.test.ts` (filesystem containment block: `../` traversal 400; the `project` vs `project-secrets` prefix-collision sibling 400/404 with no content; absolute outside path 400; nonexistent repo 400).
- **Failure behavior:** 400; no file read.

### SEC-09 — Symlink escapes are rejected; one documented exception — partially enforced — Owner: unassigned
- **Current:** the `/file` route resolves `fs.realpath` for root and candidate and re-checks containment, so symlink escapes are rejected by construction; there is no symlink-specific test (creating symlinks is privilege-restricted on Windows CI). The worktree `node_modules` junction (`worktree-manager.ts`) deliberately crosses roots and remains the single documented exception.
- **Target:** symlink-planted test cases; realpath containment on engineer write targets (SAFE-002).
- **Failure behavior (current):** resolved-outside-root paths ⇒ 400; no read.

### SEC-10 — Secrets are not written to logs, URLs, argv, reports, or persisted artifacts — partially enforced — Owner: unassigned
- **Current (v3.1):** clone credentials never appear in argv, `.git/config`, or scrubbed stderr (SEC-11, tested); URLs with embedded credentials are rejected outright (tested). **Remaining:** the central logger has no redaction pass, and file contents sent to providers are not redacted (DAT-02).
- **Target / measurable definition (review F-19):** "secret" = the versioned pattern list in the redaction utility: bearer/basic credentials, `x-access-token` URLs, `KEY=value` env lines, high-entropy strings (>20 chars) in value position. All such shapes pass through `redact()` at the logger, error-mapper, and event boundaries. Completeness is claimed **only** over the versioned pattern list plus planted canaries.
- **Failure behavior (target):** redaction failure is a build-breaking test (GATE-11 canary); runtime detection logs a redacted placeholder, never the value.

### SEC-11 — Git credentials use a secure mechanism — enforced — Owner: unassigned
- **Enforcement location:** `app.ts` clone route + `security.ts` (`credentialFileBody`, `scrubSecret`, `parseCloneUrl`).
- **Current:** the token travels in a mode-0600 `git-credential-store` temp file (deleted in a `finally`, including on failure), the clone URL passed to git is canonical and clean, stderr is scrubbed before reaching the client, and the concurrent-target race is closed via atomic `mkdir` reservation. Live-smoke verified: a real clone leaves zero credential residue. (Supersedes the v3.0 extraheader target with an equivalent mechanism.)
- **Proving test:** `security.test.ts` (clone block: credential-URL rejection, scrubbing, store-file format, host allowlist) + live smoke (2026-09-28).
- **Failure behavior:** clone failure returns scrubbed stderr; no credential persisted anywhere.

### SEC-12 — Untrusted repository code is not executed without an explicit execution policy — contradicted — Owner: unassigned
- **Current:** repo `test`/`typecheck`/`lint`/`build` commands execute on the host by default (`test-runner.ts`; `harness-builder.ts`; `verifier.ts`; `regression-sentinel.ts`).
- **Target:** per-project policy (default analysis-only); commands shown to the operator for approval at registration/checkpoint.
- **Interaction rule (review F-20, normative):** when the policy prevents baseline or post-change command execution, proposals **shall not land**; the run completes `not-verified` with changes left on the worktree branch for manual review. `NOT_APPLICABLE` gates never substitute for executable verification when landing.
- **Failure behavior (target):** unapproved command ⇒ skipped, gate records `NOT_APPLICABLE (policy)`, landing blocked, report discloses "not verified".

### SEC-13 — All dangerous operations are audited — planned — Owner: unassigned
- **Target:** the §7 event set with AUD-01 fields. **Failure behavior:** an operation without its audit event fails its test; at runtime, un-auditable dangerous operations are refused where feasible and logged as `E_NO_AUDIT` otherwise.

### SEC-14 — Every request body is schema-validated — contradicted — Owner: unassigned
- **Current:** only `PUT /config` zod-validates; clone/runs/approve bodies are checked manually (type/shape guards added in v3.1) but not schema-validated (review F-25).
- **Target:** zod schema per route; invalid ⇒ 400 `E_INVALID_BODY`, run state untouched, audit event.
- **Failure behavior (target):** 400 with the schema violation path; no partial application.

---

## 3. Reliability and recovery contract

### REL-01 — State-changing commands carry idempotency keys, applied atomically — partially enforced — Owner: unassigned
- **Current (v3.1):** `approve`/`reject`/`abort`/`resume` accept an `Idempotency-Key` header (or body field); a repeated key replays the original 200 response (`X-Idempotent-Replay: true`) without re-dispatching, and without a key the phase guard turns duplicates into a clean 409. Proving test: `packages/server/test/runtime-correctness.test.ts` (idempotency block, dispatch-counted doubles). **Remaining:** the cache is in-memory (process lifetime), keys are not atomic/persisted across restart.
- **Target:** key check **and** transition in one critical section under the run lock (REL-14); outcomes persisted for replay across restart.
- **Failure behavior (current):** replay returns the original outcome within one server process; restart-era duplicates are blocked by the phase guard.

### REL-02 — State transitions are validated centrally — enforced — Owner: unassigned
- **Enforcement location:** `packages/core/src/orchestrator/reducer.ts` (guards); terminal ignore in `runtime.ts` `reduceAndPersist`.
- **Proving test:** `packages/core/test/reducer.test.ts` (4 guard cases).
- **Failure behavior:** stale/out-of-phase events are no-ops with zero effects (tested).

### REL-03 — State is persisted before success is reported — contradicted — Owner: unassigned
- **Current:** run-state path holds (`runtime.ts`: atomic `state.json` write before effects; failure propagates — and since v3.1 a failed approval is an HTTP 500, never `ok:true`). Violations: events emitted despite failed append (`event-log.ts` — now **counted and surfaced** as `persistenceFailures`/`degraded`, REL-09); agent-failure state memory-only (`runtime.ts` `runAgentGuarded`); healed state not written back (`run-manager.ts` `loadRun`); initial write non-atomic.
- **Target:** all closed; append retried with backoff; a non-persistable event sets a degraded flag and its `seq` is never reused (F-13).
- **Failure behavior (current):** persistence failure surfaces as an error to the caller and a degraded indicator; a memory-only event's sequence number can still be reused after restart.

### REL-04 — Events have monotonically increasing, never-reused sequence numbers — partially enforced — Owner: unassigned
- **Current:** per-run in-memory counter recovered by line count (`event-log.ts`); seq consumed by failed appends is reused after restart (now *flagged*: failed appends increment `persistenceFailures` and mark the log degraded, surfaced via REST/WS — tested in `runtime-correctness.test.ts`); two `EventLog` instances per run (`run-manager.ts`).
- **Target:** seq allocated only on durable write; single writer per run enforced by REL-14; atomic append.
- **Failure behavior (target):** append failure ⇒ retry, then degraded flag; no emission with a seq that was not durably recorded.

### REL-05 — WebSocket clients recover missed events exactly — partially enforced — Owner: unassigned
- **Current (v3.1):** the v3.0 protocol gap (subscribe *after* replay read — events in that window never sent, F-15) is **closed**: `/ws` bridges through `packages/server/src/ws-replay.ts` (subscribe-first into a buffer → replay → dedup-by-eventId flush → live), deterministically tested with events appended *during* the replay window (`runtime-correctness.test.ts` bridge block). Client side: `eventId` dedup plus sequence-gap detection (`seq > lastSeq+1` triggers a REST resync + fresh snapshot) — implemented, but there is no browser test harness.
- **Target:** client passes `since=lastSeq` on reconnect (currently replay is idempotent instead); socket-level end-to-end test.
- **Failure behavior (current):** no loss/duplication through the bridge; client gaps self-heal via REST resync.

### REL-06 — REST snapshot recovery — enforced — Owner: unassigned
- **Enforcement location:** `app.ts` scoped run routes (`state`, `events?since=`) over disk state.
- **Current:** missing run ⇒ 404; unreadable `state.json` ⇒ 500 `{degraded:true}` naming the reason (never silently "unknown run"); corrupt event lines are counted (`corruptLineCount`, `replayDegraded`) rather than skipped silently; unpersisted live events flagged (`persistenceFailures`).
- **Proving test:** `runtime-correctness.test.ts` (explicit recovery degradation block).
- **Failure behavior:** as above; never partial data without a degraded flag.

### REL-07 — Process restart does not silently lose run state — partially enforced — Owner: unassigned
- **Current:** durable state per transition; `loadRun` + `resume()` re-execute non-terminal agents (`run-manager.ts`; `runtime.ts` `resume`). Gaps: memory-only states (REL-03), event durability (REL-04), and **user-repo landing recovery (SAFE-015)**.
- **Failure behavior (target):** unrecoverable state ⇒ run `failed` with `E_STATE_UNRECOVERABLE`; recoverable ⇒ `interrupted` + resumable.

### REL-08 — Interrupted runs are identified after restart — contradicted — Owner: unassigned
- **Current:** healing guard skips `status === "running"` (`run-manager.ts` `loadRun`) — the common crash case stays falsely running.
- **Target:** persisted clean-shutdown marker; on load, any non-clean run (including mid-`running`) becomes `interrupted` (new `RunState` status value); healed state persisted.
- **Failure behavior (target):** kill -9 mid-run ⇒ next load reports `interrupted`, resumable, never `running`.

### REL-09 — Corrupt persistence is reported as degraded — partially enforced — Owner: unassigned
- **Current (v3.1):** event-log reads count corrupt lines and failed appends, surfaced via the events endpoint and WS `{t:"degraded"}` frames; corrupt run state ⇒ 500 `{degraded:true}` — all tested (`runtime-correctness.test.ts`). **Remaining:** evidence-store `latest()/read()` still return silent `null` on corruption.
- **Target:** every read path returns a countable, machine-readable degraded indicator (run-level `degraded` flag + counters surfaced via OBS-06).
- **Failure behavior (current):** event/state corruption ⇒ degraded indicator; artifact corruption still silent.

### REL-10 — Failed background work is persisted and visible — enforced — Owner: unassigned
- **Enforcement location:** `app.ts` approve route (awaits dispatch; 500 on failure) + `projects.ts` `track()` (records failures in a bounded map surfaced via `/api/health` `backgroundFailures`, and force-fails the run via `FATAL` → status `failed`, `run.failed` event, worktree cleanup).
- **Proving test:** `runtime-correctness.test.ts` (approval-failure 500; `track()` FATAL + failure recording; health counter).
- **Failure behavior:** downstream/background failure ⇒ run state reflects it, HTTP never reports success for a failed approval, failure visible in health. (The v3.0 target's 202+task-id status API was not built; the guarantee itself is enforced.)

### REL-11 — Terminal runtimes are disposed — enforced — Owner: unassigned
- **Enforcement location:** `projects.ts` `watchForTerminal` (drops the runtime on `run.completed`/`failed`/`aborted`/`nochanges`, or at registration of an already-terminal run, after background work settles; disk serves all reads).
- **Proving test:** `runtime-correctness.test.ts` (terminal block: event-driven and already-terminal cases; `activeRuntimeCount` no longer inflated).
- **Failure behavior:** unregistrable runtime is dropped defensively; reads fall back to disk.

### REL-12 — Child processes and timers are cleaned up — partially enforced — Owner: unassigned
- **Current:** timeouts + SIGKILL (`git.ts`); Windows `.cmd` shim kills may orphan grandchildren.
- **Target:** process-tree termination (taskkill /T or equivalent); run-level sweep at abort/cleanup. **Failure behavior:** timeout ⇒ tree killed, non-ok result, `E_PROC_TIMEOUT` recorded.

### REL-13 — Graceful shutdown, including the landing phase — planned — Owner: unassigned
- **Current:** no signal handling (`main.ts`); Ctrl-C can tear mid-persist or **mid-cherry-pick on the user's branch** (SAFE-015).
- **Target:** SIGINT/SIGTERM ⇒ stop intake, settle dispatch queue, finish-or-journal any in-flight landing (SAFE-15), flush, close WS, exit 0.
- **Failure behavior (target):** shutdown journal guarantees the user repo is never left mid-cherry-pick without a recovery record.

### REL-14 — Single writer per run (process lock) — planned — Owner: unassigned
- **Current:** none; server and CLI can open the same run concurrently; two `EventLog` instances already exist per run (`run-manager.ts`) (review F-04).
- **Target:** `~/.vibefix/projects/<key>/runs/<id>/.lock` (O_EXCL/flock) on open; second opener gets read-only access or `E_RUN_LOCKED`.
- **Failure behavior (target):** `E_RUN_LOCKED` with the holder's PID; no interleaved writes; stale locks (dead PID) reclaimed with an audit event.

---

## 4. Behavior-preservation (safety) contract

### SAFE-01 — The original working tree is not modified before approval — contradicted — Owner: unassigned
- **Current:** tracked files are untouched pre-approval (landing is post-approval + post-gates: `runtime.ts`). Violations: `core.longpaths` written to the user's `.git/config` at worktree creation (`git.ts`); `node_modules` junction lets worktree tests write into the user's checkout (`worktree-manager.ts`); the harness baseline run executes the repo test command **in the user's repo** (post-approval), which commonly writes caches/coverage into the working tree.
- **Target:** `longpaths` scoped to worktree config or consented; per-worktree `node_modules` (copy/offline install) or read-only junction; baseline executed in a worktree snapshot.
- **Failure behavior (target):** any pre-approval mutation of the primary tree fails `primary-tree.test.ts` (git status, `.git/config`, `node_modules` hashes unchanged through checkpoint).

### SAFE-02 — All writes occur inside the approved worktree, with resolved-path containment — contradicted — Owner: unassigned
- **Current:** the engineer's write closure joins `path.join(worktree.path, …)` with **no containment check** (`engineer.ts`); `..`-bearing scope-matching paths can escape. (The server's read-side containment, SEC-08, is enforced — the write side is not.)
- **Target:** resolve the absolute path and verify segment-aware containment on the **resolved** path before every write; reject with `E_PATH_ESCAPE` + firewall violation.
- **Failure behavior (target):** escaping write rejected, violation recorded (feeds SAFE-016), attempt fails closed.

### SAFE-03 — The worktree starts from a recorded commit — planned — Owner: unassigned
- **Current:** `git worktree add -b` from HEAD (`git.ts`); the base commit is **not** persisted as evidence.
- **Target:** `baseCommit` (rev-parse at creation) recorded in the attempt ledger; mismatch vs pre-run HEAD fails the attempt. **Failure behavior:** missing/mismatched `baseCommit` ⇒ attempt rejected, ledger records `E_BASE_COMMIT`.

### SAFE-04 — Only the approved writer can modify code — partially enforced — Owner: unassigned
- **Current:** convention + orchestrator input-shaping: one `worktree-write` agent (`definitions.ts`), worktree+firewall passed only to it (`runtime.ts`); every agent's toolset is identical (`contract.ts`) — this is **not** a capability control, and engineer compliance itself rests partly on system-prompt rules (review F-22).
- **Target:** capability injection — a write handle exists only in the engineer context; other agents structurally lack one; static rule (lint/AST) forbidding `node:fs` imports outside engineer/core. OS-level sandboxing remains **unsupported** this release.
- **Failure behavior (target):** a non-engineer write attempt is impossible by construction; the static rule fails CI on violation.

### SAFE-05 — Changes are limited to approved files and operations — enforced — Owner: unassigned
- **Enforcement location:** `packages/core/src/worktree/firewall.ts` (default-deny on `filesInScope`, `filesOutOfScope`, forbidden zones); auto-reject enforced at `engineer.ts`.
- **Proving test:** `packages/core/test/firewall.test.ts` (scope, exclusion, auto-reject cases).
- **Failure behavior:** denied write ⇒ violation artifact + auto-reject at 2 violations **per attempt** (cumulative behavior: SAFE-016). Note the firewall is an advisory API-boundary check, not an fs-level gate — containment is SAFE-02's job.

### SAFE-06 — Protected paths cannot be modified — enforced — Owner: unassigned
- **Enforcement location:** `firewall.ts` (zones merged at `runtime.ts` `forbiddenZones`). **Test:** `firewall.test.ts`. **Failure behavior:** denial + violation record.

### SAFE-07 — Lockfiles and dependency files require explicit approval — enforced — Owner: unassigned
- **Enforcement location:** `firewall.ts`; explicit approval = verbatim listing in the user-approved `filesInScope`. **Test:** `firewall.test.ts`. **Failure behavior:** denial + violation record.

### SAFE-08 — Proposal scope cannot silently change after approval — planned (hash check) — Owner: unassigned
- **Current:** queue fixed from approved ids (`reducer.ts`); no integrity check that the artifact used at execution equals the one approved.
- **Target:** hash the approved backlog; verify at each attempt; mismatch ⇒ fail closed. **Failure behavior:** `E_SCOPE_MUTATED`, attempt rejected, audit event.

### SAFE-09 — The final diff is checked after execution — partially enforced — Owner: unassigned
- **Current:** verifier `firewall-scope` gate compares `changedFiles` vs scope (`verifier.ts`); sentinel re-checks zones; untested directly.
- **Failure behavior (current/target):** out-of-scope or zone-touching diff ⇒ gate FAIL ⇒ SAFE-011 path (no landing). **Target:** gate unit tests with planted violations.

### SAFE-10 — Verification is structurally blinded and fails closed — contradicted — Owner: unassigned
- **Current:** structural exclusion of `change-attempt` (`context-builder.ts`; `definitions.ts`; prompts `verifier.ts`) holds; **but** with no decision provider the fallback answers `choices[0]` = "yes" (pass) at confidence 0.3 (`decision-agent.ts`). Model diversity is **unsupported** (single provider by default, `routing.ts`).
- **Target:** verification questions with no provider ⇒ gate `FAIL`/`NOT_VERIFIABLE`, nothing lands, report says "not verified". Prompt-level blindness remains backed by the data-flow exclusion (not prompt text alone).
- **Failure behavior (target):** unconfigured/misrouted decision capability ⇒ zero landed changes, run marked `not-verified`.

### SAFE-11 — Failed verification prevents completion — enforced — Owner: unassigned
- **Enforcement location:** `reducer.ts` (reject → retry → defer; never lands). **Test:** `reducer.test.ts`. **Failure behavior:** deferred proposal, ledger record, run continues.

### SAFE-12 — Retry limits bound modification attempts — enforced — Owner: unassigned
- **Enforcement location:** `reducer.ts`; `maxRetriesPerChange: 2` (`routing.ts`) — **3 attempts total (1 initial + 2 retries), then defer.** **Test:** `reducer.test.ts`.

### SAFE-13 — Every change has a rollback or discard path — enforced (with hardening required) — Owner: unassigned
- **Enforcement location:** discard on all failure paths (`runtime.ts` → `worktree-manager.ts`); conflict ⇒ cherry-pick abort, branch untouched. **Test:** `e2e.test.ts` (no worktrees left after rejection).
- **Failure behavior (current defect):** cleanup errors are swallowed — a failed removal is invisible. **Target:** verify post-discard state, retry, surface `E_DISCARD_FAILED`.

### SAFE-15 — Landing is crash-recoverable on the user's repository — planned — Owner: unassigned
- **Current:** `git cherry-pick` runs in the user's repo (`worktree-manager.ts`); a crash mid-land leaves `CHERRY_PICK_HEAD`/staged state with no detection anywhere (review F-14).
- **Target:** land journal (pre/post records persisted before/after the pick); on project open, detect in-progress picks and deterministically complete or abort, ledger-recording the outcome.
- **Failure behavior (target):** kill during landing ⇒ reopen ⇒ user repo clean, ledger states the outcome; never a silent half-applied branch.

### SAFE-14 — Human approval gates execution — enforced — Owner: unassigned
- **Enforcement location:** `reducer.ts` — `CHECKPOINT_APPROVED` is the only queue-building event, valid only in phase. **Test:** `reducer.test.ts` (3 cases). CLI `--yes` is the documented explicit bypass of the human gate only.

### SAFE-16 — Firewall violations accumulate per proposal — planned — Owner: unassigned
- **Current:** the violation counter resets each attempt (fresh `ChangeFirewall` per attempt, `runtime.ts`); one probing violation per attempt evades auto-reject across the retry budget (review F-08).
- **Target:** persist violation count per proposalId in the ledger; 2 cumulative ⇒ defer the proposal. **Failure behavior:** cumulative threshold ⇒ proposal deferred, ledger + report record it.

---

## 5. Resource and cost contract

**Normative (F-02):** every limit below must have a numeric default and a config key at release. A `TBD` at release is a defect. Current behavior for every unimplemented limit is **unbounded**.

| ID | Limit | Default / source | Status | On limit reached — outcome / user sees / persisted |
|---|---|---|---|---|
| RES-01 | Repository size | **TBD — must be set before release** | planned | Reject at registration `E_REPO_TOO_LARGE`; user sees refusal message; registration attempt audited. |
| RES-02 | File count analyzed | 400 (harness pin, `harness-builder.ts`); 25 in-scope (engineer) | partially enforced | **Current:** silent truncation. **Target:** degraded disclosure in report (`truncatedAt: N files`); persisted in artifact. |
| RES-03 | Individual file size | 200,000 chars (security-agent); 30,000 render (`context-builder.ts`) | partially enforced | **Current:** silent skip. **Target:** per-file degraded disclosure; persisted. |
| RES-04 | Analysis duration | **TBD — must be set** | planned | Phase fails `E_TIME_BUDGET`; partial evidence retained; user sees failed phase + reason; event persisted. |
| RES-05 | Run duration | **TBD — must be set** | planned | Run `failed`; worktrees discarded; user sees failure + reason; `run.failed` event. |
| RES-06 | Child-process duration | 30s git / 60s commands / 600s clone / 120s LLM HTTP (`git.ts`; `test-runner.ts`; `app.ts`; `http.ts`) | partially enforced | Killed; non-ok result; gate FAIL or clone 400; exit code + output tail persisted. Windows tree-kill hardening pending (REL-12). |
| RES-07 | Concurrent runs | **4** (`VIBEFIX_MAX_ACTIVE_RUNS`, `app.ts` createRun guard) | **enforced** (`security.test.ts` run-ceiling block: 429 `run ceiling reached`) | 429 refusal; user sees which condition; no run created. Per-run queueing not provided. |
| RES-07b | Concurrent clones / clone rate | 2 concurrent / 10 per minute (`app.ts` clone route) | **enforced** (`security.test.ts` clone-rate block: 429 with Retry-After) | 429; user sees retry window; no clone started. |
| RES-07c | Request rate / body size | 600 req/min per client; 1 MiB bodies (`security.ts` `RateLimiter`; Fastify `bodyLimit`) | **enforced** (`security.test.ts` rate-limit block: 429 after window exhaustion) | 429 + `Retry-After`; oversized body rejected by Fastify. |
| RES-08 | Agent/pool concurrency | 3 (`runtime.ts` `POOL_CONCURRENCY`) | partially enforced | Structural (fixed 16-agent roster); pool cap untested. |
| RES-09 | Retry count per change | 2 (`routing.ts`) | enforced (`reducer.test.ts`) | Change **deferred**; ledger + report show it; persisted. |
| RES-10 | LLM calls per run | **TBD — must be set** | planned | Degraded (no further calls) or failed per policy; user informed; usage persisted. |
| RES-11 | Output tokens per call | provider `maxOutputTokens` (`routing.ts`) | partially enforced | Truncated generation → schema-repair path; usage persisted. |
| RES-12 | Run token budget | 2,000,000 + warn 0.8 (`routing.ts`; `budget.ts`; check in `runtime.ts`) | partially enforced | Run **aborted** "token budget exhausted"; user sees aborted run; persisted. **Defects:** checked between effects only; `budget.warning` never wired; `agentMaxTokens` unread in code. |
| RES-13 | Estimated cost | **TBD** — prices exist (`routing.ts`), no cost math | planned | Estimate in report; ceiling breach ⇒ abort like RES-12; persisted. |
| RES-14 | Worktree count | **TBD — must be set** | planned | Attempts queue; user sees queue; ledger persisted. |
| RES-15 | Disk usage | **TBD — must be set** | planned | New runs/clones rejected `E_DISK_BUDGET`; retention offer surfaced; event persisted. |
| RES-16 | Artifact/report size | piecemeal: ledger 200k (`runtime.ts`), tails 8k (`test-runner.ts`) | partially enforced | **Current:** undisclosed truncation. **Target:** per-artifact byte cap with explicit `truncated: true` surfaced in UI. |

---

## 6. Data and privacy contract

- **DAT-01 Storage location — partially enforced.** Current/target per §1.1; failure: any run data outside `VIBEFIX_HOME` fails `paths.test.ts`.
- **DAT-02 Provider payload scope — contradicted.** Current: in-scope file contents, diffs, metadata are sent; `.env` values are not; **no redaction — secrets in analyzed files are transmitted verbatim.** Target: versioned redaction pass (SEC-10) before any prompt; redaction disclosed in report. Failure: redaction miss ⇒ GATE-11 canary fails.
- **DAT-03 Secret redaction — planned.** Target: shared `redact()` (versioned pattern list) at logger/error/event boundaries. Failure: masked placeholder, never the value.
- **DAT-04 Provider requests not logged — partially enforced → structural target.** Current: no persistence path exists for prompts/responses (behavioral absence, unfalsifiable — review F-03). Target: **structural non-persistability** — prompt/response types are not serializable into the logger/event schemas; lint rule forbids them in log calls. Failure: negative canary test + lint rule fail CI.
- **DAT-05 Retention — planned.** Current: nothing is ever deleted (runs, worktrees, clones accumulate). Target: configurable retention + crash-safe periodic sweep (F-26). Failure: sweep failure retried and surfaced.
- **DAT-06 User deletion — planned.** Target: `DELETE` routes for runs/projects removing dirs, worktrees, branches, clones + audit event. Failure: partial deletion ⇒ `E_DELETE_PARTIAL` listing remains.
- **DAT-07 Diagnostics exclude secrets — planned.** Target: bundle built from redacted sources only; planted-secret test (GATE-11).
- **DAT-08 API keys env-only — partially enforced.** LLM keys: env-only (absence of a persistence path; structural test per F-03 still pending). GitHub clone tokens: no longer persisted anywhere (SEC-11 enforced — credential file deleted post-clone; live-smoke verified). Rotation = env change + restart, or delete `~/.vibefix/server-token`.
- **DAT-09 Prompts/responses persistence — current: prompts never persisted; model outputs persisted only as declared evidence artifacts** (audit trail). Deletion via DAT-06.

---

## 7. Auditability contract

- **AUD-01 Correlation fields — partially enforced.** Current: runId, agentId, artifactId, seq, ts exist (`packages/schemas/src/events.ts`; `event-log.ts`; `evidence-store.ts`). Missing: request ID, command ID, project ID, per-execution ID, actor, result, error codes. Target: full field set on every audited operation.
- **AUD-02 Audited operations — partially enforced.** Current coverage: run lifecycle, checkpoint, agent transitions, verification verdicts, firewall-violation artifacts, background-failure FATAL events (v3.1). Silent today: project registration, clone, config change, cleanup, recovery, file writes (success). Target: one audit event per operation with AUD-01 fields. **Failure behavior:** a dangerous operation without its event fails the audit test; runtime refusal where feasible (`E_NO_AUDIT`).

## 8. Observability contract

OBS-01 structured logs (partially enforced; redaction pending) · OBS-02 health endpoint (partially enforced; reports truthful `activeRuntimes` since REL-11 and `backgroundFailures` since REL-10, tested; version still hardcoded "0.1.0") · OBS-03 readiness (planned) · OBS-04 error codes (planned: `E_AUTH`, `E_PATH_ESCAPE`, `E_TIME_BUDGET`, `E_REMOTE_REFUSED`, `E_RUN_LOCKED`, `E_INVALID_BODY`, …) · OBS-05 metrics (planned) · OBS-06 degraded indicators (**partially enforced** v3.1: event/state corruption and unpersisted events surfaced via REST + WS, tested — feeds REL-09, RES-02/03/16 targets remain) · OBS-07 diagnostics bundle (planned, redacted) · OBS-08 correlation IDs (planned, = AUD-01). **Constraint:** no observability feature exposes secrets or full source contents.

## 9. Compatibility and migration contract

- **MIG-01 Artifact schema versioning — enforced.** `packages/schemas/src/migrations.ts`; test `roundtrip.test.ts` (valid round-trip, invalid rejection, unknown-version rejection).
- **MIG-02 State/event schema versioning — planned.** Current: `state.json`/`events.ndjson` are unversioned casts. Target: version field; older migrates or fails loudly, newer never misparses.
- **MIG-03 Migration walk — partially enforced.** Missing step ⇒ loud error naming artifact + version (`migrations.ts`); direct test pending.
- **MIG-04 Backup before upgrades — planned** (downgraded from blocker: no prior release exists whose data must survive an upgrade; becomes blocking at release 2).
- **MIG-05 N-1 compatibility — planned** (this release defines the baseline fixture for release 2).
- **MIG-06 Unknown/future versions fail loudly — enforced** (artifacts; `roundtrip.test.ts`).

---

## 10. Release gates

Every gate names its proof. A gate without a green proof blocks the words "production-ready".

| ID | Gate | Proof | Status |
|---|---|---|---|
| GATE-01 | Clean install | fresh clone → `pnpm install --frozen-lockfile && pnpm build` (Node ≥ 20); CI runs the full chain on Ubuntu + Windows | **green locally** (`pnpm verify`, Windows); CI workflow configured — its verdict lands on the first pushed commit |
| GATE-02 | Typecheck | `pnpm typecheck` (covers all packages incl. UI) | **green** |
| GATE-03 | Lint | `pnpm lint` | **missing** — no linter configured; creating it is release work |
| GATE-04 | Build | `pnpm build` (incl. UI) | **green** |
| GATE-05 | Tests | `pnpm test` (97 passing: schemas/core/adapters/agents/server) | **green** |
| GATE-06 | Security | auth/ws-auth/cors/isolation/traversal/validation suites (SEC-03..09, SEC-14) | **partial** — `packages/server/test/security.test.ts` covers auth, origin/CORS, traversal, isolation, rate/ceilings, clone credentials; WS-socket-level and per-route body-schema suites still missing |
| GATE-07 | Restart recovery | `recovery.test.ts` incl. kill-mid-run (REL-07/08) and kill-mid-landing (SAFE-15) | **missing** |
| GATE-08 | WS replay | `ws-replay.test.ts` incl. deterministic connect interleave (F-15) | **partial** — bridge-level deterministic test exists (`runtime-correctness.test.ts`); no full-socket interleave test |
| GATE-09 | Firewall | `firewall.test.ts` + containment (SAFE-002) + cumulative violations (SAFE-016) | partial |
| GATE-10 | Behavior e2e | `e2e.test.ts` + primary-tree invariance (SAFE-01) + fail-closed no-provider (SAFE-10) | partial |
| GATE-11 | Credential redaction | planted-canary scan across logs/artifacts/events/argv/`.git/config` (SEC-10/11, DAT-02/03/07) | **partial** — clone path enforced + live-smoke verified; logger/provider-payload canary suite missing |
| GATE-12 | Resource limits | tests for RES-04/05/07/12/15 with numeric values set (F-02) | **partial** — RES-07/07b/07c set and tested; RES-04/05/10/13/14/15 remain TBD |
| GATE-13 | Docs match implementation | re-audit + status-consistency check (F-21) + owner assigned to every blocker (F-01) | open (this v3.1 revision is the first re-audit step; owners still unassigned) |
| GATE-14 | No critical known vulnerability | all open blocker-severity criteria in `docs/production-acceptance-criteria.md` closed | **open** |

---

## Contract summary

Owner column per F-01; **every owner is currently `unassigned`** — assignment is a GATE-13 requirement, and this table is the tracking list.

| ID | Guarantee | Status | Enforcement location | Required test | Owner | Release blocker |
|---|---|---|---|---|---|---|
| SEC-01 | Loopback default bind | partially enforced | `main.ts` default + `assertBindingAllowed` | `bind.test.ts` (create) | unassigned | No |
| SEC-02 | Remote bind requires opt-in + auth | **enforced** | `security.ts` `assertBindingAllowed` | `security.test.ts` binding-guard (exists) | unassigned | No |
| SEC-03 | REST authentication | **enforced** | `security.ts` `authHook` | `security.test.ts` auth block (exists) | unassigned | No |
| SEC-04 | WS authentication | partially enforced | auth hook + in-handler 4401 check | socket-level ws-auth test | unassigned | **Yes** |
| SEC-05 | CORS allowlist | **enforced** | `app.ts` cors + `originCheckHook` | `security.test.ts` origin block (exists) | unassigned | No |
| SEC-06 | Project isolation | partially enforced | `resolveRun`; browse breadth remains | constrained-browse test | unassigned | **Yes** |
| SEC-07 | Run scoping | **enforced** | `app.ts` `resolveRun` | `security.test.ts` scoped-runs block (exists) | unassigned | No |
| SEC-08 | Path-escape prevention | **enforced** | `security.ts` `isPathInside` | `security.test.ts` containment block (exists) | unassigned | No |
| SEC-09 | Symlink rejection (+1 documented exception) | partially enforced | `/file` realpath re-check | traversal symlink cases | unassigned | **Yes** |
| SEC-10 | Secret non-exposure (defined shapes + canaries) | partially enforced | clone path enforced; logger/provider redaction missing | GATE-11 canary | unassigned | **Yes** |
| SEC-11 | Secure git credentials | **enforced** | `app.ts` clone + `security.ts` | `security.test.ts` clone block (exists) | unassigned | No |
| SEC-12 | Execution policy (fail-closed landing) | contradicted | `test-runner.ts` | `exec-policy.test.ts` | unassigned | **Yes** |
| SEC-13 | Dangerous ops audited | planned | — | audit tests | unassigned | Yes |
| SEC-14 | Request-body validation | contradicted | `app.ts` (only `/config`) | `validation.test.ts` | unassigned | **Yes** |
| REL-01 | Idempotent, atomic commands | partially enforced | `app.ts` idempotency cache | concurrent + replay tests (replay exists) | unassigned | **Yes** |
| REL-02 | Central transition validation | enforced | `reducer.ts` guards | `reducer.test.ts` (exists) | unassigned | No |
| REL-03 | Persist before report | contradicted | `runtime.ts` (+violation sites; now surfaced) | persistence-failure test | unassigned | **Yes** |
| REL-04 | Monotonic, never-reused seq | partially enforced | `event-log.ts` (+failure counting) | `event-log.test.ts` | unassigned | **Yes** |
| REL-05 | Exact WS missed-event recovery | partially enforced | `ws-replay.ts` bridge (server side proven) | socket-level interleave | unassigned | **Yes** |
| REL-06 | REST snapshot recovery | **enforced** | scoped run routes + degradation reporting | `runtime-correctness.test.ts` (exists) | unassigned | No |
| REL-07 | Restart durability | partially enforced | `run-manager.ts` `loadRun`/`resume` | `recovery.test.ts` | unassigned | **Yes** |
| REL-08 | Interrupted-run identification | contradicted | `run-manager.ts` healing guard | kill-9 → interrupted | unassigned | **Yes** |
| REL-09 | Corrupt persistence → degraded | partially enforced | `event-log.ts` + routes (tested); evidence-store silent null remains | planted-corruption test (events/state exist) | unassigned | **Yes** |
| REL-10 | Background failures visible | **enforced** | `app.ts` approve + `projects.ts` `track` | `runtime-correctness.test.ts` (exists) | unassigned | No |
| REL-11 | Terminal runtime disposal | **enforced** | `projects.ts` `watchForTerminal` | `runtime-correctness.test.ts` (exists) | unassigned | No |
| REL-12 | Child/timer cleanup | partially enforced | `git.ts` | Windows tree-kill test | unassigned | Yes |
| REL-13 | Graceful shutdown incl. landing | planned | `main.ts` | shutdown test | unassigned | Yes |
| REL-14 | Single-writer run lock | planned | — | concurrent-writer test | unassigned | **Yes** |
| SAFE-01 | Primary tree unmodified pre-approval | contradicted | `runtime.ts` (+3 violation sites) | primary-tree test | unassigned | **Yes** |
| SAFE-02 | Resolved-path worktree containment | contradicted | `engineer.ts` | `..`/symlink write test | unassigned | **Yes** |
| SAFE-03 | Recorded base commit | planned | `git.ts` worktree add | base-commit test | unassigned | Yes |
| SAFE-04 | Single-writer capability | partially enforced | `definitions.ts`, `runtime.ts` | permissions + lint rule | unassigned | **Yes** |
| SAFE-05 | Approved-scope writes | enforced | `firewall.ts` | `firewall.test.ts` (exists) | unassigned | No (keep green) |
| SAFE-06 | Protected paths | enforced | `firewall.ts` | `firewall.test.ts` | unassigned | No |
| SAFE-07 | Lockfile/manifest approval | enforced | `firewall.ts` | `firewall.test.ts` | unassigned | No |
| SAFE-08 | Post-approval scope integrity | planned | `reducer.ts` | backlog-hash test | unassigned | Yes |
| SAFE-09 | Final diff checked | partially enforced | `verifier.ts` | gate unit tests | unassigned | Yes |
| SAFE-10 | Blinded, fail-closed verification | contradicted | `context-builder.ts`; gap `decision-agent.ts` | no-provider refusal test | unassigned | **Yes** |
| SAFE-11 | Failed verification blocks completion | enforced | `reducer.ts` | `reducer.test.ts` | unassigned | No |
| SAFE-12 | Retry limits (3 attempts) | enforced | `reducer.ts` | `reducer.test.ts` | unassigned | No |
| SAFE-13 | Rollback/discard path | enforced (hardening req.) | `worktree-manager.ts` | `e2e.test.ts` | unassigned | No |
| SAFE-14 | Human approval gate | enforced | `reducer.ts` | `reducer.test.ts` | unassigned | No |
| SAFE-15 | Crash-recoverable landing | planned | `worktree-manager.ts` | kill-mid-cherry-pick test | unassigned | **Yes** |
| SAFE-16 | Cumulative violation counter | planned | `runtime.ts` (reset defect) | per-proposal violation test | unassigned | Yes |
| RES-01..16 | See §5 | mixed (7 TBD values remain; RES-07/07b/07c now set + tested) | §5 | limit tests once values set | unassigned | RES-01/04/05/10/13/14/15 block |
| DAT-01..09 | See §6 | mixed (GitHub-token half of DAT-08 resolved via SEC-11) | §6 | §6 | unassigned | DAT-02/03/05/06/07 block |
| AUD-01/02 | See §7 | partially enforced | §7 | audit tests | unassigned | Yes |
| OBS-01..08 | See §8 | mixed (OBS-02/06 improved) | §8 | §8 | unassigned | OBS-01/04 block |
| MIG-01..06 | See §9 | enforced: MIG-01/06 | `migrations.ts` | `roundtrip.test.ts` + new | unassigned | MIG-02 blocks |

**Reading (v3.1):** 21 items enforced and test-proven (9 newly enforced by the repair program: SEC-02/03/05/07/08/11, REL-06/10/11; plus new tested limits RES-07b/07c within §5). **9 items remain contradicted** — SEC-12, SEC-14, REL-03, REL-08, SAFE-01, SAFE-02, SAFE-04, SAFE-10, DAT-02. The remainder are partially enforced or planned. **No claim of production-readiness is made by this document**; GATE-14 (all open blockers closed) is the sole arbiter, and it is not green.
