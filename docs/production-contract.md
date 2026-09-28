# VibeFix Production Contract

**Version:** 3.0 — incorporates the hostile review (`docs/production-contract-review.md`, findings F-01…F-26). Supersedes v2.0.
**Date:** 2026-09-27
**Companion documents:** `docs/production-contract-audit.md` (evidence), `docs/production-contract-review.md` (adversarial review), `docs/production-acceptance-criteria.md` (testable criteria).
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
| **partially enforced** | Implemented, untested, and no known contradiction. |
| **contradicted** | The audit verified that current code violates the guarantee. |
| **planned** | Not implemented; the required work is named. |
| **unsupported** | Explicitly not provided in this release; stated so no one relies on it. |

**Trusted-environment assumption (explicit, until SEC-03/04/05 are enforced):** the server has **no access control**. Any local process — and, because CORS reflects every origin, any webpage the operator visits while the server runs — can call every endpoint, including approval. A running server must be treated as privileged. This is a stated assumption, not a control (review F-16).

**Local-first single-user scope (unchanged):** one operator, one machine. Multi-user, remote, and hosted deployment are out of scope (§1.2).

---

## 1. Product scope

### 1.1 Supported product (target deployment model)

1. **Local-first application.** All run state, evidence, worktrees, and clones live under the VibeFix home (`~/.vibefix`, override `VIBEFIX_HOME`), never inside the analyzed repository (`packages/core/src/store/paths.ts:5-57`). *Current:* holds for run data; two pre-approval exceptions exist (SAFE-001).
2. **Single-user deployment.** One operator, one machine; no identity model is claimed.
3. **Local server and UI.** Fastify control plane, default `127.0.0.1:8630` (`packages/server/src/main.ts:7-8`), plus a Vite/React UI proxied to it.
4. **Optional external LLM providers.** Keys sourced from the environment (`packages/llm/src/router.ts:40-41`); analysis runs without keys; code modification requires a routed model.
5. **Repositories through approved paths.** Operator registers a local git repo (clean tree asserted, `run-manager.ts:95-99`) or clones from GitHub.
6. **Isolated git worktrees for modifications** — directory-convention isolation under `~/.vibefix/projects/<key>/worktrees/` on `vibefix/*` branches (`worktree-manager.ts:29-55`). **This is not an OS-level sandbox** (see SAFE-002, SAFE-004).
7. **Human approval before code changes.** Execution starts only on `CHECKPOINT_APPROVED` (`reducer.ts:137-161`); CLI `--yes` is an explicit operator opt-in bypassing the human checkpoint only.
8. **Independent verification after changes** — *structurally blinded* verification (diff + proposal + gates, never the engineer's rationale). "Independent" does **not** mean diverse judges: all three verifiers may share one provider model by default (SAFE-010).

### 1.2 Explicitly out of scope / unsupported for the first production release

| Out of scope / unsupported | Consequence |
|---|---|
| Multi-tenant hosted SaaS | No tenancy, isolation, or quotas designed or claimed. |
| Anonymous or authenticated remote access | Remote binding is **unsupported** until SEC-02/03/04 are enforced. |
| Model-diverse verification (three different providers) | **Unsupported** this release: blinded structure only; single-provider correlation risk is documented (SAFE-010). |
| OS-level sandboxing of agent processes | **Unsupported**: SAFE-004 targets capability injection, not process isolation. |
| Protection against a malicious local user/process | **Unsupported**: the trusted-environment assumption above states the boundary. |
| Unrestricted execution of arbitrary repository scripts | Execution without an approved policy is a **defect** (SEC-12), not a feature. |
| Automatic merging without verification | No bypass exists or is planned. |
| Unrestricted filesystem access | Scoped-path access is the contract (SEC-06..09); current deviations are defects. |

---

## 2. Security contract

Format: **Guarantee — Status — Owner: unassigned.** Current / Target / Failure behavior. (Threat and enforcement location are inline; full criteria in the acceptance document.)

### SEC-01 — Server binds to 127.0.0.1 by default — partially enforced — Owner: unassigned
- **Current:** `packages/server/src/main.ts:8` — loopback unless `VIBEFIX_HOST` overrides; bound at `:14`. Untested.
- **Target:** as current, plus `packages/server/test/bind.test.ts` asserting the listen address with no env set.
- **Failure behavior:** none defined today. Target: startup failure is loud (`E_BIND`) and the process exits non-zero.

### SEC-02 — Remote binding requires an explicit opt-in flag AND authentication — planned — Owner: unassigned
- **Current (contradicted intent):** any `VIBEFIX_HOST` value binds silently; no warning, no gate. A log warning would not prevent exposure and is not an acceptable control (review F-17).
- **Target:** startup exits with `E_REMOTE_REFUSED` unless `VIBEFIX_ALLOW_REMOTE=1` is set **and** SEC-03/SEC-04 are enforced; the refusal names both conditions. Test: `bind.test.ts` — no flag ⇒ process never listens.
- **Failure behavior (target):** exit non-zero before binding; message persisted to the log; nothing listens.

### SEC-03 — Sensitive REST endpoints require authentication — planned — Owner: unassigned
- **Current:** zero authentication on all ~25 routes (`packages/server/src/app.ts`); no auth hook exists.
- **Target:** Fastify `onRequest` bearer-token hook on every route except `/api/health`; token generated at first start, stored under `~/.vibefix`, delivered to the UI locally.
- **Failure behavior (target):** 401 `E_AUTH`, audit event AUD-01, no state change.

### SEC-04 — WebSocket connections require authentication — planned — Owner: unassigned
- **Current:** `/ws` (`app.ts:544-587`) accepts any upgrade, no origin or ticket check.
- **Target:** ticket issued by an authenticated REST call; unauthorized upgrades closed 4001.
- **Failure behavior (target):** close 4001 + audit event; no frames sent.

### SEC-05 — CORS uses an explicit allowlist — contradicted — Owner: unassigned
- **Current:** `app.ts:56` — `cors({ origin: true })` reflects every origin. Any visited webpage can call the API (see trusted-environment assumption).
- **Target:** allowlist (`http://localhost:5173`, configurable); no ACAO for foreign origins.
- **Failure behavior (target):** preflight denied; request blocked in browsers; audit event.

### SEC-06 — Projects cannot access another project's files or runs — contradicted — Owner: unassigned
- **Current:** `decodePath` validates nothing (`projects.ts:63-65`); `findRunDir` scans all projects (`app.ts:65-78`); `/api/fs/browse` lists any directory (`app.ts:174-209`).
- **Target:** persisted project registry; every route resolves through it; browse restricted to registered roots.
- **Failure behavior (target):** 403/404 `E_SCOPE`, audit event; no data returned.

### SEC-07 — Run IDs are scoped to projects — planned — Owner: unassigned
- **Current:** all `/api/runs/:runId/*` routes key globally (`app.ts:344-543`).
- **Target:** `/api/projects/:enc/runs/:runId/*` with registry validation.
- **Failure behavior (target):** 404 `E_SCOPE`.

### SEC-08 — Repository-relative paths cannot escape the approved root — contradicted — Owner: unassigned
- **Current:** the `/file` guard is a prefix `startsWith` check; sibling-prefix paths bypass it (`app.ts:236-238`).
- **Target:** segment-aware containment (`path.relative(root, abs)` — not absolute, no leading `..`).
- **Failure behavior (target):** 400 `E_PATH_ESCAPE`; no file read; audit event.

### SEC-09 — Symlink escapes are rejected; one documented exception — planned — Owner: unassigned
- **Current:** no symlink/realpath check anywhere; the worktree `node_modules` junction (`worktree-manager.ts:123-136`) deliberately crosses roots. "Explicitly handled" is no longer accepted wording (review F-18).
- **Target:** `fs.realpath` containment on file-serving routes and engineer write targets; **the single exception is the VibeFix-created worktree `node_modules` junction, which must be read-only to agents.** All other resolving-outside-root paths ⇒ 400 `E_PATH_ESCAPE`.
- **Failure behavior (target):** rejection with `E_PATH_ESCAPE`; audit event; no read/write.

### SEC-10 — Secrets are not written to logs, URLs, argv, reports, or persisted artifacts — contradicted — Owner: unassigned
- **Current:** GitHub token embedded in the clone URL (argv) and persisted by git into `<clone>/.git/config`; can surface in stderr returned to the client (`app.ts:147-151`); logger has no redaction (`logger.ts`).
- **Target / measurable definition (review F-19):** "secret" = the versioned pattern list in the redaction utility: bearer/basic credentials, `x-access-token` URLs, `KEY=value` env lines, high-entropy strings (>20 chars) in value position. All such shapes pass through `redact()` at the logger, error-mapper, and event boundaries. Completeness is claimed **only** over the versioned pattern list plus planted canaries — not over arbitrary future credential formats.
- **Failure behavior (target):** redaction failure is a build-breaking test (GATE-11 canary); runtime detection logs a redacted placeholder, never the value.

### SEC-11 — Git credentials use a secure mechanism — contradicted — planned fix — Owner: unassigned
- **Current:** URL userinfo (`app.ts:147`).
- **Target:** `git -c http.<url>.extraheader=…` per-invocation (never on disk) or a scoped credential helper; `remote.origin.url` scrubbed to the bare URL immediately after clone.
- **Failure behavior (target):** clone failure returns stderr with userinfo stripped; post-clone assertion fails loudly if any credential remains.

### SEC-12 — Untrusted repository code is not executed without an explicit execution policy — contradicted — Owner: unassigned
- **Current:** repo `test`/`typecheck`/`lint`/`build` commands execute on the host by default (`test-runner.ts:53-70`; `harness-builder.ts:59-71`; `verifier.ts:63`; `regression-sentinel.ts:32-83`).
- **Target:** per-project policy (default analysis-only); commands shown to the operator for approval at registration/checkpoint.
- **Interaction rule (review F-20, normative):** when the policy prevents baseline or post-change command execution, proposals **shall not land**; the run completes `not-verified` with changes left on the worktree branch for manual review. `NOT_APPLICABLE` gates never substitute for executable verification when landing.
- **Failure behavior (target):** unapproved command ⇒ skipped, gate records `NOT_APPLICABLE (policy)`, landing blocked, report discloses "not verified".

### SEC-13 — All dangerous operations are audited — planned — Owner: unassigned
- **Target:** the §7 event set with AUD-01 fields. **Failure behavior:** an operation without its audit event fails its test; at runtime, un-auditable dangerous operations are refused where feasible and logged as `E_NO_AUDIT` otherwise.

### SEC-14 — Every request body is schema-validated — contradicted — Owner: unassigned
- **Current:** only `PUT /config` validates (`app.ts:305`); clone/runs/approve bodies are used raw (`app.ts:134-147,317-327,383-387`) (review F-25).
- **Target:** zod schema per route; invalid ⇒ 400 `E_INVALID_BODY`, run state untouched, audit event.
- **Failure behavior (target):** 400 with the schema violation path; no partial application.

---

## 3. Reliability and recovery contract

### REL-01 — State-changing commands carry idempotency keys, applied atomically — planned — Owner: unassigned
- **Current:** no keys; replayed approvals double-apply while the phase persists; concurrent dispatches are serialized only in-process (`runtime.ts:94-113`) (review F-24).
- **Target:** client `idempotencyKey` on start/approve/reject/abort/resume; key check **and** transition in one critical section under the run lock (REL-14); outcomes persisted for replay across restart.
- **Failure behavior (target):** replay returns the original outcome; concurrent duplicate returns the first result; neither re-dispatches.

### REL-02 — State transitions are validated centrally — enforced — Owner: unassigned
- **Enforcement location:** `packages/core/src/orchestrator/reducer.ts` (guards `:25,36,126,138,181-182`); terminal ignore `runtime.ts:116-121`.
- **Proving test:** `packages/core/test/reducer.test.ts` (4 guard cases).
- **Failure behavior:** stale/out-of-phase events are no-ops with zero effects (tested).

### REL-03 — State is persisted before success is reported — contradicted — Owner: unassigned
- **Current:** run-state path holds (`runtime.ts:115-141`: atomic `state.json` write before effects; failure propagates). Violations: events emitted despite failed append (`event-log.ts:57-64`); agent-failure state memory-only (`runtime.ts:276`); healed state not written back (`run-manager.ts:169-183`); initial write non-atomic (`run-manager.ts:144`).
- **Target:** all four closed; append retried with backoff; a non-persistable event sets a degraded flag and its `seq` is never reused (F-13).
- **Failure behavior (target):** persistence failure surfaces as an error to the caller (no success), a `degraded` indicator on the run, and a persisted failure record.

### REL-04 — Events have monotonically increasing, never-reused sequence numbers — partially enforced — Owner: unassigned
- **Current:** per-run in-memory counter recovered by line count (`event-log.ts:13,48-54,73-84`); seq consumed by failed appends is reused after restart; two `EventLog` instances per run (`run-manager.ts:134,192`).
- **Target:** seq allocated only on durable write; single writer per run enforced by REL-14; atomic append (reuse `atomicWrite`, `evidence-store.ts:158-181`).
- **Failure behavior (target):** append failure ⇒ retry, then degraded flag; no emission with a seq that was not durably recorded.

### REL-05 — WebSocket clients recover missed events exactly — partially enforced — Owner: unassigned
- **Current:** server replays `since` on connect and serves `eventsSince` (`app.ts:560-585`); client reconnects with backoff but omits `since` and relies on `eventId` dedup (`store.ts:47,106-139`). **Protocol gap (F-15):** the socket subscribes *after* the replay read — events in that window are never sent.
- **Target:** subscribe **before** replay read, buffer to socket, client dedups by `seq`; client passes `since=lastSeq`.
- **Failure behavior (target):** any gap or duplicate in a deterministic interleave test fails GATE-08.

### REL-06 — REST snapshot recovery — partially enforced — Owner: unassigned
- **Current:** `GET /api/runs/:runId` + `events?since=` serve disk state (`app.ts:81-101,344-369`); corrupt lines silently skipped. **Target:** as current + degraded reporting (REL-09). **Failure behavior:** missing run ⇒ 404; unreadable state ⇒ 500 `E_STATE_CORRUPT` (target), never partial data.

### REL-07 — Process restart does not silently lose run state — partially enforced — Owner: unassigned
- **Current:** durable state per transition; `loadRun` + `resume()` re-execute non-terminal agents (`run-manager.ts:154-187`; `runtime.ts:545-597`). Gaps: memory-only states (REL-03), event durability (REL-04), and **user-repo landing recovery (SAFE-014)**.
- **Failure behavior (target):** unrecoverable state ⇒ run `failed` with `E_STATE_UNRECOVERABLE`; recoverable ⇒ `interrupted` + resumable.

### REL-08 — Interrupted runs are identified after restart — contradicted — Owner: unassigned
- **Current:** healing guard skips `status === "running"` (`run-manager.ts:171`) — the common crash case stays falsely running.
- **Target:** persisted clean-shutdown marker; on load, any non-clean run (including mid-`running`) becomes `interrupted` (new `RunState` status value); healed state persisted.
- **Failure behavior (target):** kill -9 mid-run ⇒ next load reports `interrupted`, resumable, never `running`.

### REL-09 — Corrupt persistence is reported as degraded — contradicted — Owner: unassigned
- **Current:** artifact `list()` surfaces corruption (`evidence-store.ts:100-111`) but `latest()/read()` return silent `null` (`:117-142`) and corrupt event lines are skipped silently (`event-log.ts:35-37`; `app.ts:96-98`).
- **Target:** every read path returns a countable, machine-readable degraded indicator (run-level `degraded` flag + counters surfaced via OBS-06).
- **Failure behavior (target):** corruption ⇒ degraded indicator + event; never silent skip, never a crash.

### REL-10 — Failed background work is persisted and visible — contradicted — Owner: unassigned
- **Current:** `registry.track` converts rejections to console noise (`projects.ts:43-51`); approve returns `{ok:true}` regardless (`app.ts:390-391`); reject/abort/resume don't await.
- **Target:** persisted task record (accepted/running/failed + error) per command; endpoints return 202 + task id + status route; failures emit events and show in the UI.
- **Failure behavior (target):** downstream failure ⇒ task `failed`, run state reflects it, HTTP never reports success for a failed command.

### REL-11 — Terminal runtimes are disposed — planned — Owner: unassigned
- **Current:** `ProjectRegistry.runtimes` has no eviction (`projects.ts:11,27-29`); growth is unbounded; `activeRuntimeCount` inflates.
- **Target:** evict on terminal status (disk serves reads); startup sweep + periodic retention (F-26). **Failure behavior:** eviction failure retried and surfaced (`E_EVICTION`), never swallowed.

### REL-12 — Child processes and timers are cleaned up — partially enforced — Owner: unassigned
- **Current:** timeouts + SIGKILL (`git.ts:24-26`); Windows `.cmd` shim kills may orphan grandchildren.
- **Target:** process-tree termination (taskkill /T or equivalent); run-level sweep at abort/cleanup. **Failure behavior:** timeout ⇒ tree killed, non-ok result, `E_PROC_TIMEOUT` recorded.

### REL-13 — Graceful shutdown, including the landing phase — planned — Owner: unassigned
- **Current:** no signal handling (`main.ts`); Ctrl-C can tear mid-persist or **mid-cherry-pick on the user's branch** (SAFE-014).
- **Target:** SIGINT/SIGTERM ⇒ stop intake, settle dispatch queue, finish-or-journal any in-flight landing (SAFE-15), flush, close WS, exit 0.
- **Failure behavior (target):** shutdown journal guarantees the user repo is never left mid-cherry-pick without a recovery record.

### REL-14 — Single writer per run (process lock) — planned — Owner: unassigned
- **Current:** none; server and CLI can open the same run concurrently; two `EventLog` instances already exist per run (`run-manager.ts:134,192`) (review F-04).
- **Target:** `~/.vibefix/projects/<key>/runs/<id>/.lock` (O_EXCL/flock) on open; second opener gets read-only access or `E_RUN_LOCKED`.
- **Failure behavior (target):** `E_RUN_LOCKED` with the holder's PID; no interleaved writes; stale locks (dead PID) reclaimed with an audit event.

---

## 4. Behavior-preservation (safety) contract

### SAFE-01 — The original working tree is not modified before approval — contradicted — Owner: unassigned
- **Current:** tracked files are untouched pre-approval (landing is post-approval + post-gates: `runtime.ts:401`). Violations: `core.longpaths` written to the user's `.git/config` at worktree creation (`git.ts:112`); `node_modules` junction lets worktree tests write into the user's checkout (`worktree-manager.ts:123-136`); the harness baseline run executes the repo test command **in the user's repo** (post-approval), which commonly writes caches/coverage into the working tree.
- **Target:** `longpaths` scoped to worktree config or consented; per-worktree `node_modules` (copy/offline install) or read-only junction; baseline executed in a worktree snapshot.
- **Failure behavior (target):** any pre-approval mutation of the primary tree fails `primary-tree.test.ts` (git status, `.git/config`, `node_modules` hashes unchanged through checkpoint).

### SAFE-02 — All writes occur inside the approved worktree, with resolved-path containment — contradicted — Owner: unassigned
- **Current:** the engineer's write closure joins `path.join(worktree.path, …)` with **no containment check** (`engineer.ts:66`); `..`-bearing scope-matching paths can escape.
- **Target:** resolve the absolute path and verify prefix-containment on the **resolved** path (segment-aware) before every write; reject with `E_PATH_ESCAPE` + firewall violation.
- **Failure behavior (target):** escaping write rejected, violation recorded (feeds SAFE-016), attempt fails closed.

### SAFE-03 — The worktree starts from a recorded commit — planned — Owner: unassigned
- **Current:** `git worktree add -b` from HEAD (`git.ts:110-114`); the base commit is **not** persisted as evidence.
- **Target:** `baseCommit` (rev-parse at creation) recorded in the attempt ledger; mismatch vs pre-run HEAD fails the attempt. **Failure behavior:** missing/mismatched `baseCommit` ⇒ attempt rejected, ledger records `E_BASE_COMMIT`.

### SAFE-04 — Only the approved writer can modify code — partially enforced — Owner: unassigned
- **Current:** convention + orchestrator input-shaping: one `worktree-write` agent (`definitions.ts:146`), worktree+firewall passed only to it (`runtime.ts:298-321`); every agent's toolset is identical (`contract.ts:12-18`) — this is **not** a capability control, and engineer compliance itself rests partly on system-prompt rules (review F-22).
- **Target:** capability injection — a write handle exists only in the engineer context; other agents structurally lack one; static rule (lint/AST) forbidding `node:fs` imports outside engineer/core. OS-level sandboxing remains **unsupported** this release.
- **Failure behavior (target):** a non-engineer write attempt is impossible by construction; the static rule fails CI on violation.

### SAFE-05 — Changes are limited to approved files and operations — enforced — Owner: unassigned
- **Enforcement location:** `packages/core/src/worktree/firewall.ts:35-61` (default-deny on `filesInScope`, `filesOutOfScope`, forbidden zones); auto-reject enforced at `engineer.ts:50-63`.
- **Proving test:** `packages/core/test/firewall.test.ts` (scope, exclusion, auto-reject cases).
- **Failure behavior:** denied write ⇒ violation artifact + auto-reject at 2 violations **per attempt** (cumulative behavior: SAFE-016). Note the firewall is an advisory API-boundary check, not an fs-level gate — containment is SAFE-02's job.

### SAFE-06 — Protected paths cannot be modified — enforced — Owner: unassigned
- **Enforcement location:** `firewall.ts:46-48` (zones merged at `runtime.ts:472-486`). **Test:** `firewall.test.ts`. **Failure behavior:** denial + violation record.

### SAFE-07 — Lockfiles and dependency files require explicit approval — enforced — Owner: unassigned
- **Enforcement location:** `firewall.ts:5-15,35-42`; explicit approval = verbatim listing in the user-approved `filesInScope`. **Test:** `firewall.test.ts`. **Failure behavior:** denial + violation record.

### SAFE-08 — Proposal scope cannot silently change after approval — planned (hash check) — Owner: unassigned
- **Current:** queue fixed from approved ids (`reducer.ts:148-153`); no integrity check that the artifact used at execution equals the one approved.
- **Target:** hash the approved backlog; verify at each attempt; mismatch ⇒ fail closed. **Failure behavior:** `E_SCOPE_MUTATED`, attempt rejected, audit event.

### SAFE-09 — The final diff is checked after execution — partially enforced — Owner: unassigned
- **Current:** verifier `firewall-scope` gate compares `changedFiles` vs scope (`verifier.ts:38-46`); sentinel re-checks zones; untested directly.
- **Failure behavior (current/target):** out-of-scope or zone-touching diff ⇒ gate FAIL ⇒ SAFE-011 path (no landing). **Target:** gate unit tests with planted violations.

### SAFE-10 — Verification is structurally blinded and fails closed — contradicted — Owner: unassigned
- **Current:** structural exclusion of `change-attempt` (`context-builder.ts:5,16`; `definitions.ts:153-190`; prompts `verifier.ts:95-100`) holds; **but** with no decision provider the fallback answers `choices[0]` = "yes" (pass) at confidence 0.3 (`decision-agent.ts:38-48`). Model diversity is **unsupported** (single provider by default, `routing.ts:185-187`).
- **Target:** verification questions with no provider ⇒ gate `FAIL`/`NOT_VERIFIABLE`, nothing lands, report says "not verified". Prompt-level blindness remains backed by the data-flow exclusion (not prompt text alone).
- **Failure behavior (target):** unconfigured/misrouted decision capability ⇒ zero landed changes, run marked `not-verified`.

### SAFE-11 — Failed verification prevents completion — enforced — Owner: unassigned
- **Enforcement location:** `reducer.ts:270-293` (reject → retry → defer; never lands). **Test:** `reducer.test.ts`. **Failure behavior:** deferred proposal, ledger record, run continues.

### SAFE-12 — Retry limits bound modification attempts — enforced — Owner: unassigned
- **Enforcement location:** `reducer.ts:272`; `maxRetriesPerChange: 2` (`routing.ts:48,193`) — **3 attempts total (1 initial + 2 retries), then defer.** **Test:** `reducer.test.ts`.

### SAFE-13 — Every change has a rollback or discard path — enforced (with hardening required) — Owner: unassigned
- **Enforcement location:** discard on all failure paths (`runtime.ts:337-350,367,408,423` → `worktree-manager.ts:83-86`); conflict ⇒ cherry-pick abort, branch untouched (`:76-81`). **Test:** `e2e.test.ts` (no worktrees left after rejection).
- **Failure behavior (current defect):** cleanup errors are swallowed — a failed removal is invisible. **Target:** verify post-discard state, retry, surface `E_DISCARD_FAILED`.

### SAFE-15 — Landing is crash-recoverable on the user's repository — planned — Owner: unassigned
- **Current:** `git cherry-pick` runs in the user's repo (`worktree-manager.ts:76-81`); a crash mid-land leaves `CHERRY_PICK_HEAD`/staged state with no detection anywhere (review F-14).
- **Target:** land journal (pre/post records persisted before/after the pick); on project open, detect in-progress picks and deterministically complete or abort, ledger-recording the outcome.
- **Failure behavior (target):** kill during landing ⇒ reopen ⇒ user repo clean, ledger states the outcome; never a silent half-applied branch.

### SAFE-14 — Human approval gates execution — enforced — Owner: unassigned
- **Enforcement location:** `reducer.ts:81-87,137-161` — `CHECKPOINT_APPROVED` is the only queue-building event, valid only in phase. **Test:** `reducer.test.ts` (3 cases). CLI `--yes` is the documented explicit bypass of the human gate only.

### SAFE-16 — Firewall violations accumulate per proposal — planned — Owner: unassigned
- **Current:** the violation counter resets each attempt (fresh `ChangeFirewall` per attempt, `runtime.ts:306`); one probing violation per attempt evades auto-reject across the retry budget (review F-08).
- **Target:** persist violation count per proposalId in the ledger; 2 cumulative ⇒ defer the proposal. **Failure behavior:** cumulative threshold ⇒ proposal deferred, ledger + report record it.

---

## 5. Resource and cost contract

**Normative (F-02):** every limit below must have a numeric default and a config key at release. A `TBD` at release is a defect. Current behavior for every unimplemented limit is **unbounded**.

| ID | Limit | Default / source | Status | On limit reached — outcome / user sees / persisted |
|---|---|---|---|---|
| RES-01 | Repository size | **TBD — must be set before release** | planned | Reject at registration `E_REPO_TOO_LARGE`; user sees refusal message; registration attempt audited. |
| RES-02 | File count analyzed | 400 (harness pin, `harness-builder.ts:38`); 25 in-scope (engineer `:43`) | partially enforced | **Current:** silent truncation. **Target:** degraded disclosure in report (`truncatedAt: N files`); persisted in artifact. |
| RES-03 | Individual file size | 200,000 chars (security-agent `:64`); 30,000 render (`context-builder.ts:30`) | partially enforced | **Current:** silent skip. **Target:** per-file degraded disclosure; persisted. |
| RES-04 | Analysis duration | **TBD — must be set** | planned | Phase fails `E_TIME_BUDGET`; partial evidence retained; user sees failed phase + reason; event persisted. |
| RES-05 | Run duration | **TBD — must be set** | planned | Run `failed`; worktrees discarded; user sees failure + reason; `run.failed` event. |
| RES-06 | Child-process duration | 30s git / 60s commands / 300s tests+clone / 120s LLM HTTP (`git.ts:24,60`; `test-runner.ts:53`; `app.ts:148`; `http.ts:12`) | partially enforced | Killed; non-ok result; gate FAIL or clone 400; exit code + output tail persisted. Windows tree-kill hardening pending (REL-12). |
| RES-07 | Concurrent runs | **TBD — must be set** | planned | Queue or reject `E_RUN_LIMIT`; user sees queue position; event persisted. |
| RES-08 | Agent/pool concurrency | 3 (`runtime.ts:25,530-539`) | partially enforced | Structural (fixed 16-agent roster); pool cap untested. |
| RES-09 | Retry count per change | 2 (`routing.ts:48,193`) | enforced (`reducer.test.ts`) | Change **deferred**; ledger + report show it; persisted. |
| RES-10 | LLM calls per run | **TBD — must be set** | planned | Degraded (no further calls) or failed per policy; user informed; usage persisted. |
| RES-11 | Output tokens per call | provider `maxOutputTokens` (`routing.ts:80-166`); 2,048/16,384/1,500 call caps | partially enforced | Truncated generation → schema-repair path; usage persisted. |
| RES-12 | Run token budget | 2,000,000 + warn 0.8 (`routing.ts:190-195`; `budget.ts:49-51`; check `runtime.ts:177-180`) | partially enforced | Run **aborted** "token budget exhausted"; user sees aborted run; persisted. **Defects:** checked between effects only; `budget.warning` never wired; `agentMaxTokens` unread in code. |
| RES-13 | Estimated cost | **TBD** — prices exist (`routing.ts:31-32`), no cost math | planned | Estimate in report; ceiling breach ⇒ abort like RES-12; persisted. |
| RES-14 | Worktree count | **TBD — must be set** | planned | Attempts queue; user sees queue; ledger persisted. |
| RES-15 | Disk usage | **TBD — must be set** | planned | New runs/clones rejected `E_DISK_BUDGET`; retention offer surfaced; event persisted. |
| RES-16 | Artifact/report size | piecemeal: ledger 200k (`runtime.ts:503`), tails 8k (`test-runner.ts:67`) | partially enforced | **Current:** undisclosed truncation. **Target:** per-artifact byte cap with explicit `truncated: true` surfaced in UI. |

---

## 6. Data and privacy contract

- **DAT-01 Storage location — partially enforced.** Current/target per §1.1; failure: any run data outside `VIBEFIX_HOME` fails `paths.test.ts`.
- **DAT-02 Provider payload scope — contradicted.** Current: in-scope file contents, diffs, metadata are sent; `.env` values are not; **no redaction — secrets in analyzed files are transmitted verbatim.** Target: versioned redaction pass (SEC-10) before any prompt; redaction disclosed in report. Failure: redaction miss ⇒ GATE-11 canary fails.
- **DAT-03 Secret redaction — planned.** Target: shared `redact()` (versioned pattern list) at logger/error/event boundaries. Failure: masked placeholder, never the value.
- **DAT-04 Provider requests not logged — partially enforced → structural target.** Current: no persistence path exists for prompts/responses (behavioral absence, unfalsifiable — review F-03). Target: **structural non-persistability** — prompt/response types are not serializable into the logger/event schemas; lint rule forbids them in log calls. Failure: negative canary test + lint rule fail CI.
- **DAT-05 Retention — planned.** Current: nothing is ever deleted (runs, worktrees, clones accumulate). Target: configurable retention + crash-safe periodic sweep (F-26). Failure: sweep failure retried and surfaced.
- **DAT-06 User deletion — planned.** Target: `DELETE` routes for runs/projects removing dirs, worktrees, branches, clones + audit event. Failure: partial deletion ⇒ `E_DELETE_PARTIAL` listing remains.
- **DAT-07 Diagnostics exclude secrets — planned.** Target: bundle built from redacted sources only; planted-secret test (GATE-11).
- **DAT-08 API keys env-only — partially enforced.** Holds for LLM keys (absence of a path; structural test required per F-03); **contradicted for GitHub tokens** (SEC-11). Rotation = env change + restart.
- **DAT-09 Prompts/responses persistence — current: prompts never persisted; model outputs persisted only as declared evidence artifacts** (audit trail). Deletion via DAT-06.

---

## 7. Auditability contract

- **AUD-01 Correlation fields — partially enforced.** Current: runId, agentId, artifactId, seq, ts exist (`packages/schemas/src/events.ts`; `event-log.ts:48-54`; `evidence-store.ts`). Missing: request ID, command ID, project ID, per-execution ID, actor, result, error codes. Target: full field set on every audited operation.
- **AUD-02 Audited operations — partially enforced.** Current coverage: run lifecycle, checkpoint, agent transitions, verification verdicts, firewall-violation artifacts. Silent today: project registration, clone, config change, cleanup, recovery, file writes (success). Target: one audit event per operation with AUD-01 fields. **Failure behavior:** a dangerous operation without its event fails the audit test; runtime refusal where feasible (`E_NO_AUDIT`).

## 8. Observability contract

OBS-01 structured logs (partially enforced; redaction pending) · OBS-02 health endpoint (partially enforced; version hardcoded "0.1.0", count inflated by REL-11 leak) · OBS-03 readiness (planned) · OBS-04 error codes (planned: `E_AUTH`, `E_PATH_ESCAPE`, `E_TIME_BUDGET`, `E_REMOTE_REFUSED`, `E_RUN_LOCKED`, `E_INVALID_BODY`, …) · OBS-05 metrics (planned) · OBS-06 degraded indicators (planned — feeds REL-09, RES-02/03/16) · OBS-07 diagnostics bundle (planned, redacted) · OBS-08 correlation IDs (planned, = AUD-01). **Constraint:** no observability feature exposes secrets or full source contents.

## 9. Compatibility and migration contract

- **MIG-01 Artifact schema versioning — enforced.** `packages/schemas/src/migrations.ts:11-34`; test `roundtrip.test.ts` (valid round-trip, invalid rejection, unknown-version rejection).
- **MIG-02 State/event schema versioning — planned.** Current: `state.json`/`events.ndjson` are unversioned casts. Target: version field; older migrates or fails loudly, newer never misparses.
- **MIG-03 Migration walk — partially enforced.** Missing step ⇒ loud error naming artifact + version (`migrations.ts:20-27`); direct test pending.
- **MIG-04 Backup before upgrades — planned** (downgraded from blocker: no prior release exists whose data must survive an upgrade; becomes blocking at release 2).
- **MIG-05 N-1 compatibility — planned** (this release defines the baseline fixture for release 2).
- **MIG-06 Unknown/future versions fail loudly — enforced** (artifacts; `roundtrip.test.ts`).

---

## 10. Release gates

Every gate names its proof. A gate without a green proof blocks the words "production-ready".

| ID | Gate | Proof | Status |
|---|---|---|---|
| GATE-01 | Clean install | fresh clone → `pnpm install && pnpm build` (Node ≥ 20), documented | unverified |
| GATE-02 | Typecheck | `pnpm typecheck` | exists; must be green |
| GATE-03 | Lint | `pnpm lint` | **missing** — no linter configured; creating it is release work |
| GATE-04 | Build | `pnpm build` | exists; must be green |
| GATE-05 | Tests | `pnpm test` (currently 31 passing) | exists; must be green |
| GATE-06 | Security | `auth/ws-auth/cors/isolation/traversal/validation` suites (SEC-03..09, SEC-14) | **missing** |
| GATE-07 | Restart recovery | `recovery.test.ts` incl. kill-mid-run (REL-07/08) and **kill-mid-landing (SAFE-15)** | **missing** |
| GATE-08 | WS replay | `ws-replay.test.ts` incl. deterministic connect interleave (F-15) | **missing** |
| GATE-09 | Firewall | `firewall.test.ts` + containment (`SAFE-002`) + cumulative violations (`SAFE-016`) | partial |
| GATE-10 | Behavior e2e | `e2e.test.ts` + primary-tree invariance (SAFE-01) + fail-closed no-provider (SAFE-10) | partial |
| GATE-11 | Credential redaction | planted-canary scan across logs/artifacts/events/argv/`.git/config` (SEC-10/11, DAT-02/03/07) | **missing** |
| GATE-12 | Resource limits | tests for RES-04/05/07/12/15 with numeric values set (F-02) | **missing** |
| GATE-13 | Docs match implementation | re-audit + status-consistency check (F-21) + **owner assigned to every blocker (F-01)** | open |
| GATE-14 | No critical known vulnerability | all open blocker-severity criteria in `docs/production-acceptance-criteria.md` closed | **open** |

---

## Contract summary

Owner column added per F-01; **every owner is currently `unassigned`** — assignment is a GATE-13 requirement, and this table is the tracking list.

| ID | Guarantee | Status | Enforcement location | Required test | Owner | Release blocker |
|---|---|---|---|---|---|---|
| SEC-01 | Loopback default bind | partially enforced | `main.ts:8,14` | `bind.test.ts` (create) | unassigned | No |
| SEC-02 | Remote bind requires opt-in + auth | planned | — | `bind.test.ts` refusal case | unassigned | **Yes** |
| SEC-03 | REST authentication | planned | — | `auth.test.ts` | unassigned | **Yes** |
| SEC-04 | WS authentication | planned | — | `ws-auth.test.ts` | unassigned | **Yes** |
| SEC-05 | CORS allowlist | contradicted | `app.ts:56` | `cors.test.ts` | unassigned | **Yes** |
| SEC-06 | Project isolation | contradicted | — | `isolation.test.ts` | unassigned | **Yes** |
| SEC-07 | Run scoping | planned | — | isolation test | unassigned | Yes |
| SEC-08 | Path-escape prevention | contradicted | `app.ts:236-238` | `traversal.test.ts` | unassigned | **Yes** |
| SEC-09 | Symlink rejection (+1 documented exception) | planned | — | traversal symlink cases | unassigned | **Yes** |
| SEC-10 | Secret non-exposure (defined shapes + canaries) | contradicted | — | GATE-11 canary | unassigned | **Yes** |
| SEC-11 | Secure git credentials | contradicted | `app.ts:147` | credential test | unassigned | **Yes** |
| SEC-12 | Execution policy (fail-closed landing) | contradicted | `test-runner.ts:53-70` | `exec-policy.test.ts` | unassigned | **Yes** |
| SEC-13 | Dangerous ops audited | planned | — | audit tests | unassigned | Yes |
| SEC-14 | Request-body validation | contradicted | `app.ts:305` (only route) | `validation.test.ts` | unassigned | **Yes** |
| REL-01 | Idempotent, atomic commands | planned | — | concurrent + replay tests | unassigned | **Yes** |
| REL-02 | Central transition validation | enforced | `reducer.ts` guards | `reducer.test.ts` (exists) | unassigned | No |
| REL-03 | Persist before report | contradicted | `runtime.ts:115-141` (+4 violation sites) | persistence-failure test | unassigned | **Yes** |
| REL-04 | Monotonic, never-reused seq | partially enforced | `event-log.ts:13,48-54` | `event-log.test.ts` | unassigned | **Yes** |
| REL-05 | Exact WS missed-event recovery | partially enforced | `app.ts:560-585` | `ws-replay.test.ts` + interleave | unassigned | **Yes** |
| REL-06 | REST snapshot recovery | partially enforced | `app.ts:81-101,344-369` | rest-recovery test | unassigned | No |
| REL-07 | Restart durability | partially enforced | `run-manager.ts:154-187` | `recovery.test.ts` | unassigned | **Yes** |
| REL-08 | Interrupted-run identification | contradicted | `run-manager.ts:171` | kill-9 → interrupted | unassigned | **Yes** |
| REL-09 | Corrupt persistence → degraded | contradicted | `evidence-store.ts:100-111` | planted-corruption test | unassigned | **Yes** |
| REL-10 | Background failures visible | contradicted | `projects.ts:43-51` | task-status test | unassigned | **Yes** |
| REL-11 | Terminal runtime disposal | planned | `projects.ts:11` | lifecycle soak test | unassigned | Yes |
| REL-12 | Child/timer cleanup | partially enforced | `git.ts:24-26` | Windows tree-kill test | unassigned | Yes |
| REL-13 | Graceful shutdown incl. landing | planned | `main.ts` | shutdown test | unassigned | Yes |
| REL-14 | Single-writer run lock | planned | — | concurrent-writer test | unassigned | **Yes** |
| SAFE-01 | Primary tree unmodified pre-approval | contradicted | `runtime.ts:401` (+3 violation sites) | primary-tree test | unassigned | **Yes** |
| SAFE-02 | Resolved-path worktree containment | contradicted | `engineer.ts:66` | `..`/symlink write test | unassigned | **Yes** |
| SAFE-03 | Recorded base commit | planned | `git.ts:110-114` | base-commit test | unassigned | Yes |
| SAFE-04 | Single-writer capability | partially enforced | `definitions.ts:146`, `runtime.ts:298-321` | permissions + lint rule | unassigned | **Yes** |
| SAFE-05 | Approved-scope writes | enforced | `firewall.ts:35-61` | `firewall.test.ts` (exists) | unassigned | No (keep green) |
| SAFE-06 | Protected paths | enforced | `firewall.ts:46-48` | `firewall.test.ts` | unassigned | No |
| SAFE-07 | Lockfile/manifest approval | enforced | `firewall.ts:5-15,35-42` | `firewall.test.ts` | unassigned | No |
| SAFE-08 | Post-approval scope integrity | planned | `reducer.ts:148-153` | backlog-hash test | unassigned | Yes |
| SAFE-09 | Final diff checked | partially enforced | `verifier.ts:38-46` | gate unit tests | unassigned | Yes |
| SAFE-10 | Blinded, fail-closed verification | contradicted | `context-builder.ts:5,16`; gap `decision-agent.ts:38-48` | no-provider refusal test | unassigned | **Yes** |
| SAFE-11 | Failed verification blocks completion | enforced | `reducer.ts:270-293` | `reducer.test.ts` | unassigned | No |
| SAFE-12 | Retry limits (3 attempts) | enforced | `reducer.ts:272` | `reducer.test.ts` | unassigned | No |
| SAFE-13 | Rollback/discard path | enforced (hardening req.) | `worktree-manager.ts:76-121` | `e2e.test.ts` | unassigned | No |
| SAFE-14 | Human approval gate | enforced | `reducer.ts:81-87,137-161` | `reducer.test.ts` | unassigned | No |
| SAFE-15 | Crash-recoverable landing | planned | `worktree-manager.ts:76-81` | kill-mid-cherry-pick test | unassigned | **Yes** |
| SAFE-16 | Cumulative violation counter | planned | `runtime.ts:306` (reset defect) | per-proposal violation test | unassigned | Yes |
| RES-01..16 | See §5 | mixed (8 TBD values) | §5 | limit tests once values set | unassigned | RES-01/04/05/07/10/13/14/15 block |
| DAT-01..09 | See §6 | mixed | §6 | §6 | unassigned | DAT-02/03/05/06/07 block |
| AUD-01/02 | See §7 | partially enforced | §7 | audit tests | unassigned | Yes |
| OBS-01..08 | See §8 | mixed | §8 | §8 | unassigned | OBS-01/04 block |
| MIG-01..06 | See §9 | enforced: MIG-01/06 | `migrations.ts` | `roundtrip.test.ts` + new | unassigned | MIG-02 blocks |

**Reading:** 12 items enforced and test-proven. 16 items are **contradicted** — the code violates them today. The remainder are partially enforced or planned. **No claim of production-readiness is made by this document**; GATE-14 (all open blockers closed) is the sole arbiter, and it is far from green.
