# VibeFix Production-Contract Audit

**Date:** 2026-09-27
**Scope:** Full repository at commit `16682ef` (working tree, plus untracked `ISSUES_FIXED.md`)
**Audited against:** `README.md`, `AGENTS.md`, `docs/v1doc.md`, `ISSUES_FIXED.md`, `docs/production-contract.md`, and the project context stated for this audit
**Method:** Every claim below was verified against source. The highest-severity findings were independently re-verified by reading the cited code directly; file paths and line numbers refer to the current working tree. No behavior is inferred where no code exists.

**Status legend used throughout:**

| Status | Meaning |
|---|---|
| ✅ implemented + tested | Code exists; a test in the repo asserts the guarantee |
| 🔶 implemented, untested | Code exists; no test asserts it |
| 🟡 partial | Code exists but with documented gaps that break the guarantee in reachable cases |
| ⛔ documented, not implemented | Docs claim it; no matching code found |
| ❌ contradicted | Code does the opposite of what the documentation claims |

---

## 1. Guarantees claimed by the documentation

Four documents make guarantee-level claims.

**README.md** (`Orchestration guarantees`, lines 71–80; `Where things live`, lines 29–32):
- Evidence Store, not chat — agents communicate only via versioned JSON under `~/.vibefix/projects/<key>/runs/<runId>/`
- Pure reducer orchestrator
- Single writer — only the Engineer modifies code, only inside `git worktree` sandboxes
- Change Firewall — writes outside `filesInScope` (or into lockfiles / `protectedPaths` / forbidden zones) are blocked; 2 violations = auto-reject
- Fresh-context verification pool — Behavior + Principle + Regression never see the Engineer's reasoning
- Budgeted retries — a change failing twice is deferred, never forced
- User checkpoint — execution starts only after backlog approval
- "Your project folder is never used for run data; VibeFix only reads it, and writes only through firewalled worktrees you approved"
- "Keys from environment (never persisted)"

**docs/v1doc.md** (§1, lines 11–17) — five "foundational architectural invariants":
1. Evidence Store, Not Chat
2. Single-Writer Guarantee (`permission: "worktree-write"` for exactly one agent)
3. Change Firewall & Git Sandboxing (2 violations → auto-reject)
4. Fresh-Context Verification Pool ("structurally blinded")
5. Pure Reducer State Machine ("zero I/O side effects… retried within budget (max 1 retry), then deferred")

**AGENTS.md / ISSUES_FIXED.md** claim a long list of reliability fixes as complete (WebSocket backoff, state synchronization, dispatch-queue race fixes, session recovery after restarts, health checks, resource management) and declare the system "production-grade" / "ready for production deployment".

**docs/production-contract.md** (written 2026-09-27, normative) claims the security, reliability, behavior-preservation, and resource-limit contracts quoted in §4–§6 below.

---

## 2–3. Guarantee-by-guarantee implementation map and status

### 2.1 Security guarantees

| # | Guarantee (source) | Implementation | Status |
|---|---|---|---|
| S1 | Server binds to 127.0.0.1 by default (production-contract §1.1.1; README quick start) | `packages/server/src/main.ts:7-8` — `VIBEFIX_HOST ?? "127.0.0.1"`, `VIBEFIX_PORT ?? 8630`; bound at `main.ts:14` | 🔶 implemented, untested. No guard warns when `VIBEFIX_HOST` is set to a non-loopback address |
| S2 | Every sensitive endpoint requires an auth token (production-contract §1.1.2) | **None.** No `addHook`/`preHandler`/auth check exists anywhere in `packages/server/src`; deps are only `fastify`, `@fastify/websocket`, `@fastify/cors`, `ws` | ⛔ documented, not implemented. All ~25 routes plus `/ws` are unauthenticated |
| S3 | The UI is the only allowed browser origin (production-contract §1.1.3) | `packages/server/src/app.ts:56` — `app.register(cors, { origin: true })` reflects **every** Origin | ❌ contradicted |
| S4 | A project can access only its own repository and run data (§1.1.4) | `packages/server/src/projects.ts:63-65` — `decodePath` performs no validation (any base64url → any absolute path); `app.ts:65-78` `findRunDir` scans **all** projects' run dirs; `app.ts:174-209` `/api/fs/browse` lists any directory on any drive; `app.ts:233-247` `/api/projects/:enc/file` reads any file under any decoded path, guarded only by a prefix `startsWith` check that sibling-prefix paths (`C:\repo` vs `C:\repo-evil`) can bypass | ⛔ documented, not implemented |
| S5 | A run can access only its own worktree and evidence (§1.1.5) | All `/api/runs/:runId/*` routes are keyed by runId alone with no project scoping (`app.ts:344-543`); any client can act on any run of any project | ⛔ documented, not implemented |
| S6 | LLM providers never receive secrets or out-of-context files (§1.1.6) | Prompts are assembled from repo files: engineer sends up to 25 in-scope code files (`packages/agents/src/agents/engineer.ts:43,75-82`); verifiers send the worktree diff sliced to 12k/10k chars (`verifier.ts:100`, `principle-reviewer.ts`); `packages/adapters/src/tools/fs-facts.ts:86-89` skips dot-directories but lists dot-**files** (`.env` is listed). API keys go only into HTTP headers (`packages/llm/src/providers/*`); no key-logging path found | 🟡 partial. No redaction step exists: a secret hardcoded in an in-scope file is transmitted to the provider verbatim; `.env` paths are surfaced in findings |
| S7 | GitHub tokens never appear in argv, logs, errors, or persisted artifacts (§1.1.7) | `packages/server/src/app.ts:147` — token embedded as URL userinfo: `https://x-access-token:<token>@github.com/...`, passed as a `git clone` **argv** entry (`app.ts:148`). Git persists it in `<clone>/.git/config` (`remote.origin.url`); nothing scrubs it (no `git remote set-url` anywhere). On failure, `res.stderr.slice(0,300)` is returned to the client (`app.ts:151`) — git stderr can echo the credentialed URL. The code comment at `app.ts:146` ("never logged or stored") is false for the on-disk git config | ❌ contradicted |
| S8 | Untrusted repository code is never executed on the host without explicit policy (§1.1.8) | `packages/adapters/src/tools/test-runner.ts:53-70` executes repo-detected `test`/`typecheck`/`lint`/`build` commands (i.e., arbitrary `package.json` scripts) on the host, in the user's repo (baseline, `harness-builder.ts:59-71`) and in the worktree (`verifier.ts:63`, `regression-sentinel.ts:32-83`). There is no policy gate | ❌ contradicted (execution is the default, not the exception) |
| S9 | The application does not modify the user's primary working tree automatically (§1.1.9) | Tracked files: holds — the only mutation of the primary tree's content is `git cherry-pick` **after** approval + all verifier gates (`packages/core/src/orchestrator/runtime.ts:401` → `packages/core/src/worktree/worktree-manager.ts:76-81`). But VibeFix writes `core.longpaths=true` into the user's repo `.git/config` on every worktree creation (`packages/adapters/src/tools/git.ts:112`), and worktrees link `node_modules` via junction to the user's checkout (`worktree-manager.ts:123-136`), so worktree test runs execute against — and can write into — the user's real `node_modules` | 🟡 partial |
| S10 | API keys from environment, never persisted (README line 85) | `packages/llm/src/router.ts:40-41` reads `env[config.apiKeyEnv]`; keys used only in headers; `packages/schemas/src/routing.ts:19-21` documents the design | 🔶 implemented, untested (S7's GitHub-token case is the violation, and it is a different, user-supplied credential) |

### 2.2 Reliability guarantees

| # | Guarantee | Implementation | Status |
|---|---|---|---|
| R1 | Every accepted command has an idempotency key (§1.2.1) | **None.** `RunEvent` (`packages/core/src/orchestrator/state.ts:12-29`) carries no key; the `eventId` built at `runtime.ts:91` is debug-only, never persisted or compared. Only incidental phase-guards exist (`reducer.ts:25,36,126,138,181-182`); a replayed `CHECKPOINT_APPROVED` arriving while still in `awaitingApproval` is applied twice | ⛔ documented, not implemented |
| R2 | Every state transition persisted before reported successful (§1.2.2) | State: yes — `runtime.ts:115-141` `reduceAndPersist` persists `state.json` (atomic) before effects run; persist failure propagates. Exceptions: (a) `packages/core/src/store/event-log.ts:57-64` emits events to subscribers even when `appendFile` fails (memory-only events, silently lost to replay); (b) `runtime.ts:276` sets `agentStates[id]="failed"` directly on memory with no persist; (c) `run-manager.ts:169-183` heals stale agent states in memory only, never written back; (d) initial state written with plain `fs.writeFile`, not atomic (`run-manager.ts:144`) | 🟡 partial |
| R3 | Every event has a monotonically increasing sequence number (§1.2.3) | `event-log.ts:13,48-54` — in-memory counter, recovered on load by counting file lines (`ensureLoaded`, lines 73-84). Per-run, per-process. Collision risks: append-failure consumes seq numbers that after restart are **reused** (missed events for a `since=`-resync client); two `EventLog` instances are constructed per run (`run-manager.ts:134` probe + `:192` runtime), which if both append produce duplicate seqs | 🔶 implemented, untested (with documented collision cases) |
| R4 | The client can recover from any missed WebSocket event (§1.2.4) | Server: `GET /api/runs/:runId/events?since=N` (`app.ts:360-369`); WS replay honors `since` on connect (`app.ts:544-587`); dead runtimes serve disk state + `readonly` frame. Client: `packages/ui/src/store.ts:35-96` reconnect with capped exponential backoff (10 attempts, 1s→30s), `syncEvents()` incremental REST fetch by `lastSeq` (lines 98-116), eventId dedup + seq sort (lines 106-139). Gap: the WS URL omits `since` (`store.ts:47`), so every reconnect replays from 0 and dedup — not sequence resume — is what actually protects the UI | 🟡 partial, untested (zero tests in `packages/server` and `packages/ui`) |
| R5 | A process restart does not lose logical run state (§1.2.5) | `state.json` full-snapshot per transition; `loadRun` (`run-manager.ts:154-187`) rebuilds a runtime; `resume()` (`runtime.ts:545-585`) re-executes non-terminal agents | 🔶 implemented, untested (no restart-recovery test exists) |
| R6 | Incomplete runs become interrupted/recoverable/failed; never falsely running (§1.2.6) | Healing exists but is guarded by `if (state.status !== "running" && state.status !== "paused")` (`run-manager.ts:171`) — a crash mid-run leaves `status === "running"`, exactly the case the guard skips. The run loads back as falsely running until someone calls `resume()`; `listRuns` (`run-manager.ts:101-120`) shows a phantom active run. Healed values are also never persisted (R2c) | ❌ contradicted for the common crash case |
| R7 | A failed approval cannot return HTTP success (§1.2.7) | `app.ts:389-395` wraps dispatch in try/catch and returns 500 on **synchronous** throw — but `registry.track` (`projects.ts:43-51`) attaches `.catch(err => console.error(...))` to the background promise, converting **any** asynchronous failure into a resolved promise. The endpoint then returns `{ ok: true, approved, mode }` while the approved run fails. `reject`/`abort`/`resume` (lines 399-425) don't even await | ❌ contradicted |
| R8 | Terminal runtimes are released from memory (§1.2.8) | `ProjectRegistry.runtimes` (`projects.ts:11`) has only `set` (`:27-29`); no delete/evict exists anywhere. Completed/failed runtimes (stores, event logs, meters) live for the process lifetime; `activeRuntimeCount` (`:35-37`) grows forever | ⛔ documented, not implemented |
| R9 | Corrupt evidence is reported as degraded, not silently ignored (§1.2.9) | Split behavior: `EvidenceStore.list()` surfaces a `{ data: { corrupt: true, ... } }` placeholder (`packages/core/src/store/evidence-store.ts:100-111`), but `latest()` and `read()` silently return `null` on corruption (`:117-142`), and corrupt event-log lines are silently skipped on replay (`event-log.ts:35-37`, and identically in the server's `diskEvents`, `app.ts:96-98`) | 🟡 partial |

### 2.3 Behavior-preservation guarantees

| # | Guarantee | Implementation | Status |
|---|---|---|---|
| B1 | Only the Refactoring Engineer may modify code (v1doc invariant 2) | `packages/agents/src/definitions.ts` — exactly one `permission: "worktree-write"` (line 146, engineer); harness-builder is `evidence-write` (line 134); all others `read-only`. Orchestrator grants `worktree` + `firewall` only in the engineer's context (`runtime.ts:298-321`); verifiers get the worktree but not the firewall (`:385`) and never write. Only `fs.writeFile` calls in `packages/agents`: `engineer.ts:68` (firewalled) and `docent.ts:160` (report .md under `.vibefix/`). Caveats: the toolset is identical for every agent (`contract.ts:12-18`) — the boundary is convention + input-shaping, not a capability sandbox | 🔶 implemented, untested directly (e2e exercises it end-to-end) |
| B2 | Changes happen only in a dedicated worktree (v1doc invariant 3; §1.3.2) | Worktrees under `~/.vibefix/projects/<sha1-12>/worktrees/<slug>` (`worktree-manager.ts:29-55`, `paths.ts:55-57`); branch `vibefix/<slug>`. **Gap:** the engineer's write closure joins `path.join(worktree.path, ...relativePath.split("/"))` with no resolved-path containment check (`engineer.ts:66`) — an edit path containing `..` segments that still matches a scope glob (e.g. `src/auth/../../.ssh/x`) can resolve outside the worktree while passing `canWrite`. The firewall sees only the raw relative string (`firewall.ts:35-53`) | 🟡 partial |
| B3 | Firewall blocks out-of-scope writes; 2 violations = auto-reject (README; v1doc) | `packages/core/src/worktree/firewall.ts:5-53` — `ALWAYS_PROTECTED` (`.git/**`, `.vibefix/**`, lockfiles), `MANIFESTS`, `filesOutOfScope`, `extraForbidden` (risk zones ∪ config `protectedPaths`, merged at `runtime.ts:472-486`), default-deny on `filesInScope` mismatch. Auto-reject at `violations >= 2` (`firewall.ts:56-61`), enforced by `engineer.ts:50-63`. **Tested** by `packages/core/test/firewall.test.ts` (8 cases incl. auto-reject). Gaps: firewall is advisory at one call site (the engineer's `write` closure) — it wraps no fs layer, so `git add -A`, test-runner subprocesses, and any future writer are unfirewalled; `ALWAYS_PROTECTED` is overridden by listing a protected path verbatim in `filesInScope` (`firewall.ts:37`) | ✅ implemented + tested (with structural caveats) |
| B4 | Public API changes are detected (§1.3.4) | `harness-builder.ts:10-57` pins an export-symbol surface (regex-based, ≤400 files) into `behavioral-baseline`; `verifier.ts:75-84` + `surfaceDrift` (`verifier.ts:149-198`) computes drift. **Gap:** drift FAILs the gate only when `proposal.constraints.includes("no-public-api-change")` (`verifier.ts:79`) — constraints are set by Synthesis, so a proposal without the constraint can change the public API and still PASS. Removal detection is textual (`content.includes(name)`), so re-exports satisfy it | 🟡 partial |
| B5 | Baseline tests run before and after the change (§1.3.5) | Before: `harness-builder.ts:59-71` runs the repo test command (300s timeout) pre-change. After: `verifier.ts:49-73` re-runs the same command in the worktree; `regression-sentinel.ts:32-57` re-checks. Comparison is boolean (`ok === ok`), not per-test; a red-at-baseline suite yields `NOT_APPLICABLE` in the sentinel (lines 39-44). Typecheck/lint/build have **no baseline capture** — failures without a green pin are `NOT_APPLICABLE`, never blocking (`regression-sentinel.ts:61-83`) | 🟡 partial (exercised indirectly by e2e; no direct verifier tests) |
| B6 | Independent verification does not rely on the engineer's explanation (§1.3.6) | Structural: `context-builder.ts:5,16` — `FRESH_CONTEXT_EXCLUDED = ["change-attempt"]` for `freshContext` agents; verifier/principle-reviewer/sentinel are `freshContext: true` (`definitions.ts:153-190`) and their `consumes` exclude `change-attempt`; verifier prompt: "never the author's reasoning" (`verifier.ts:96`); sentinel is fully deterministic. **Critical gap:** when no decision provider is available, `decide()` falls back to a deterministic neutral answer that picks `choices[0]` (`packages/agents/src/runtime/decision-agent.ts:38-48`) — for the verifier's `["yes","no"]` question that is **"yes" (verify-pass) at confidence 0.3**, so the independence machinery can silently auto-approve when the decision model is missing. Verifiers also all share one provider by default (`routing.ts:185-187`) — architectural independence, not model diversity | 🟡 partial |
| B7 | Failed changes are rejected or deferred after a fixed retry limit (§1.3.7) | `maxRetriesPerChange` default 2 (`packages/schemas/src/routing.ts:48,193`); enforced in `reducer.ts:270-293` (`advanceExecution`) — retries then `stage: "defer"`, ledger records it, run continues; never force-committed. **Tested:** `reducer.test.ts` cases "GATE_VERDICT passed advances… rejected retries then defers" and "rejected verdict emits retry effect" (note v1doc line 17 claims "max 1 retry" — the actual default is 2) | ✅ implemented + tested |
| B8 | User checkpoint before execution (README; §1.3.1) | Reducer: `awaitingApproval` + `PauseForApproval` after minimality (`reducer.ts:81-87`); `CHECKPOINT_APPROVED` is the only event that builds the execution queue, and only in the right phase (`reducer.ts:137-161`); **tested** (`reducer.test.ts` cases 6-9). CLI `--yes` (`packages/cli/src/main.ts:35,60-69`) auto-approves the entire backlog headlessly — a documented bypass of the human gate, still subject to all verifier gates | ✅ implemented + tested |
| B9 | Final report states what changed and what was not verified (§1.3.8) | `docent.ts:105-113,211-213` — explicit "What did NOT change" section; per-change `deliberatelyNotTouched` (lines 91-94). Gaps: no explicit "not verified" section — `NOT_APPLICABLE` gates are not disclosed as unverified; `publicApiChanges` is **hardcoded to 0** (`docent.ts:72`) rather than derived from real surface drift | 🟡 partial (e2e asserts the report contains "What did NOT change") |
| B10 | Evidence store, not chat (README; v1doc invariant 1) | All inter-agent data flows through versioned JSON artifacts (`packages/core/src/store/evidence-store.ts`); schema round-trip **tested** (`packages/schemas/test/roundtrip.test.ts`) | ✅ implemented + tested |

### 2.4 Pure-reducer claim (v1doc invariant 5)

`reducer.ts:5-6` documents "No I/O, no clock, no randomness". Verified: no I/O, no randomness, operates on `structuredClone`d state (`state.ts:80-82`). **But** `reducer.ts:21` stamps `next.updatedAt = new Date().toISOString()` on every event (even no-ops) and `:144` stamps `approval.decidedAt` — the reducer is not clock-pure, contradicting its own docstring. 🟡 partial (transition logic itself is **tested** by 16 reducer test cases).

---

## 4. Security assumptions currently made

The code assumes, without enforcing:

1. **Loopback is authentication.** The only access control is the default bind address (`main.ts:8`). Any local process — and, combined with `cors({ origin: true })` (`app.ts:56`), any webpage the operator visits — can call every endpoint, start runs, approve checkpoints, read any run's findings, and list any directory (`/api/fs/browse`, `app.ts:174`).
2. **The client is trusted.** No request body is schema-validated except `PUT /config` (`app.ts:305`); clone URL/token, run bodies, and approval payloads are used raw (`app.ts:134-147,317-327,383-387`).
3. **Path inputs are honest.** `decodePath` accepts any absolute path (`projects.ts:63-65`); the `/file` guard is a non-segment-aware prefix check (`app.ts:236-238`).
4. **The repo under analysis is not adversarial.** Its `test`/`build`/`lint` scripts execute on the host by default (S8); its `.git` hooks and git config are trusted; `node_modules` is shared with the user's checkout via junction (`worktree-manager.ts:123-136`).
5. **The LLM's edit paths are honest.** The firewall evaluates raw relative strings; no resolved-path containment (B2).
6. **Secrets don't live in source files.** No redaction before prompts (S6).
7. **Tokens don't leak through git.** Contradicted by the `.git/config` persistence (S7).

## 5. Reliability assumptions currently made

1. **Single process per run.** The event log's seq counter and append path assume one writer; two `EventLog` instances are already constructed per run (`run-manager.ts:134,192`) (R3).
2. **Disk writes succeed or fail atomically.** `appendFile` is non-atomic; failures degrade silently to memory-only events (R2a).
3. **Crashes happen at convenient times.** The healing guard only handles orphans in non-running statuses (R6) — i.e., it assumes crashes occur while paused or terminal, not mid-flight.
4. **Background promises don't fail, or failure is acceptable.** `registry.track` converts rejections to console noise (R7); effect failures are logged and skipped (`runtime.ts:169-176`); cleanup failures are swallowed (`.catch(() => undefined)` in `worktree-manager.ts:83-121`).
5. **The UI's dedup is sufficient.** WS reconnects replay from seq 0 and rely on `eventId` dedup rather than sequence resume (`store.ts:47`).
6. **Approvals are single-delivery.** No idempotency; double-submitted approvals double-apply if the first hasn't left the phase yet (R1).
7. **LLM providers eventually answer.** HTTP calls have timeouts and retries (`packages/llm/src/providers/http.ts:12-27`), but nothing bounds total run wall-clock time; a hung phase hangs forever (§6).

## 6. Resource-limit assumptions currently made

Enforced in code today (all in `packages/core` + `packages/schemas/src/routing.ts:190-195` unless noted):

| Limit | Status | Evidence |
|---|---|---|
| Max retries per change (2) | ✅ enforced + tested | `reducer.ts:272-292`; `reducer.test.ts` |
| Max changes per run (10) | ✅ enforced + tested | `reducer.ts:145,304-306`; `reducer.test.ts` |
| Max run LLM tokens (2,000,000) | 🔶 enforced, untested | `budget.ts:49-51`, checked between effects at `runtime.ts:177-180` → `BUDGET_EXCEEDED` aborts (`reducer.ts:237-242`). Checked **between effects, not between LLM calls**; `agentMaxTokens` exists in schema but is read by no enforcement code |
| Pool concurrency (3) | 🔶 enforced, untested | `runtime.ts:25,530-539` |
| Child-process runtime | 🔶 enforced, untested | `runCommand` timeouts + SIGKILL (`git.ts:24-26`, default 60s; tests 300s; clone 300s at `app.ts:148`); LLM HTTP 120s (`http.ts:12`). Caveat: on Windows, SIGKILL kills the `.cmd` shim; grandchildren may survive |
| Output truncation (partial) | 🔶 enforced | stdout/stderr capped ~1MB (`git.ts:28-35`); test output tail 8k (`test-runner.ts:67`); diff prompts 10-12k; ledger 200k (`runtime.ts:503`) |

**Assumed but not enforced** (no matching code found anywhere):

- Wall-clock run/phase/agent duration — **nothing** bounds a hung run
- Max concurrent runs — server registers unlimited runtimes (`app.ts:324-327`, no admission control)
- Max agents, max run-level retries
- Max cost in currency — `pricePerMTok*` fields exist (`routing.ts:31-32`) but no code multiplies usage by price
- Max repository size, max artifact size (`evidence-store.ts` writes unbounded payloads), max events.ndjson size
- Max clone size (full clone, no `--depth`; `app.ts:148`), and clones are never garbage-collected
- Max disk usage — no retention/sweep of `~/.vibefix/projects/*/worktrees|runs|repos` anywhere

The `budget.warning` event type (`packages/schemas/src/events.ts:16`) is never emitted: the `onBudgetWarn` hook (`run-manager.ts:195-197`) is registered by neither server nor CLI.

---

## 7. Where the documentation overclaims

1. **`app.ts:146` code comment** — "Token … is injected into the clone URL only — never logged or stored." False: git stores it in the clone's `.git/config` (S7). The most direct in-code contradiction found.
2. **`docs/production-contract.md`** — 8 of its clauses are simply not implemented (S2, S4, S5, R1, R8) or contradicted (S3, S7, R7), and 9 of 11 resource limits are unenforced. The contract itself marks these as release blockers; today every one of them is outstanding.
3. **AGENTS.md / ISSUES_FIXED.md "production-grade / production-ready"** — the specific fixes listed (WS backoff, dedup, atomic evidence writes, logging) are real but narrower than the headings imply: the event log is *not* atomic, server recovery leaves crashed runs falsely "running" (R6), approvals can 200-on-failure (R7), and terminal runtimes leak (R8). "Session Recovery After Server Restarts ✅" is contradicted for mid-run crashes.
4. **README "writes only through firewalled worktrees you approved"** — the tracked-file write path honors this, but `.git/config` is modified pre-approval (`core.longpaths`, `git.ts:112`) and the shared `node_modules` junction pierces the boundary (S9).
5. **v1doc invariant 5 "no clock"** — `reducer.ts:21,144` (§2.4); v1doc "max 1 retry" vs actual default 2 (B7).
6. **README "Changes are protected by a Change Firewall"** (front page) — the firewall is a policy check at one closure, not a containment mechanism (B2/B3 caveats).
7. **AGENTS.md "Comprehensive Logging"** — `packages/core/src/util/logger.ts` has **no redaction**; combined with S7's stderr echo path, tokens can reach logs.

---

## 8. Missing guarantees required for production use

1. **Authentication** for every route and the WS upgrade; an origin allowlist.
2. **Path confinement**: validated project registry, segment-aware containment for `/file`, per-project scoping of run routes.
3. **Credential hygiene**: credential-helper or `http.extraheader` for clones; post-clone remote scrubbing; redaction in logger/error paths.
4. **Idempotency keys** on approve/reject/abort/resume/start.
5. **Honest async status**: approval/reject endpoints that report background failures (or return job ids); crash-safe healing for `status === "running"`; healed state persisted.
6. **Runtime lifecycle**: eviction of terminal runtimes; retention policy for runs, worktrees, clones.
7. **Resource ceilings**: wall-clock timeouts, concurrent-run admission, disk/size budgets, cost tracking (fields already exist), per-agent token caps (schema already exists, unread).
8. **Durable event log**: atomic append (the `atomicWrite` helper already exists in `evidence-store.ts:158-181` but is not used by the event log), degraded-mode reporting on corruption, single-writer seq.
9. **Execution policy gate** for running untrusted repo commands; sandboxing or explicit opt-in.
10. **Verification integrity**: no silent auto-pass when the decision provider is missing (`decision-agent.ts:38-48`); mandatory `no-public-api-change` semantics or explicit drift disclosure; baseline pinning for typecheck/lint/build.
11. **Test coverage** for the packages that hold nearly all the risk: `packages/server` (0 tests), `packages/agents` (0), `packages/llm` (0), `packages/adapters` (0), `packages/ui` (0). The four existing test files cover the reducer, firewall, schema codecs, and one e2e happy path.

---

## 9. Evidence index (key symbols)

- Server: `buildApp` `packages/server/src/app.ts:48`; CORS `:56`; `findRunDir` `:65`; `diskEvents` `:81`; `/api/health` `:121`; `/api/projects/clone` `:134-154`; `/api/fs/browse` `:174`; `/api/runs/:runId/approve` `:371-397`; `/ws` `:544`
- Registry: `ProjectRegistry` `packages/server/src/projects.ts:9`; `track` `:43-51`; `decodePath` `:63-65`
- Orchestrator: `dispatch`/`dispatchQueue` `packages/core/src/orchestrator/runtime.ts:90-113`; `reduceAndPersist` `:115-141`; `performEffects` error handling `:169-176`; budget check `:177-180`; `executeProposal` `:292-430`; landing `:401`; `resume` `:545-585`
- Run manager: initial non-atomic write `packages/core/src/orchestrator/run-manager.ts:144`; `loadRun` healing guard `:171`; probe/runtime dual `EventLog` `:134,192`
- Reducer: purity vs clock `packages/core/src/orchestrator/reducer.ts:21,144`; approval gating `:137-161`; retry/defer `:270-293`
- Event log: `append` failure path `packages/core/src/store/event-log.ts:57-64`; corrupt-line skip `:35-37`; seq recovery `:73-84`
- Evidence store: `atomicWrite` `packages/core/src/store/evidence-store.ts:158-181`; corruption surfacing `:100-111` vs silent `latest()/read()` `:117-142`
- Firewall: `ChangeFirewall.canWrite` `packages/core/src/worktree/firewall.ts:35-53`; scope-override escape `:37`; `recordViolation` `:56-61`
- Engineer: write closure `packages/agents/src/agents/engineer.ts:47-71` (firewall check `:48`, uncontained `path.join` `:66`)
- Worktrees: create `packages/core/src/worktree/worktree-manager.ts:33-55`; `landOnMainBranch`/cherry-pick `:76-81`; `node_modules` junction `:123-136`
- Git tool: `core.longpaths` write `packages/adapters/src/tools/git.ts:112`; `runCommand` timeout/SIGKILL `:24-26`
- Agents: permissions `packages/agents/src/definitions.ts:14-197`; fresh-context exclusion `packages/agents/src/runtime/context-builder.ts:5,16`; decision fallback `packages/agents/src/runtime/decision-agent.ts:38-48`; api-drift gate condition `packages/agents/src/agents/verifier.ts:79`; docent hardcoded counter `packages/agents/src/agents/docent.ts:72`
- Budgets: `BudgetMeter` `packages/core/src/budget.ts:49-51`; schema defaults `packages/schemas/src/routing.ts:44-52,190-195`
- Tests (complete inventory): `packages/core/test/reducer.test.ts` (16 cases), `packages/core/test/firewall.test.ts` (8 cases), `packages/core/test/e2e.test.ts` (2 cases), `packages/schemas/test/roundtrip.test.ts`

---

## 10. Prioritized contradictions and risks

1. **No authentication on any endpoint or WebSocket, with reflect-all CORS** (`app.ts:56`; no auth code exists). Any local process or visited webpage can start runs, approve checkpoints, and read arbitrary directories via `/api/fs/browse`. Severity: critical; the entire security contract rests on the loopback default.
2. **GitHub token persisted in plaintext in the clone's `.git/config`, passed in argv, and echoable in stderr** (`app.ts:147-151`) — directly contradicting both the production contract §1.1.7 and the code's own comment at `app.ts:146`. Severity: critical credential exposure.
3. **Verification can silently auto-pass when the decision provider is unavailable** — fallback picks `choices[0]` = "yes" (verify-pass) at confidence 0.3 (`decision-agent.ts:38-48`). Severity: critical to the product's core promise (behavior preservation).
4. **A failed approval returns HTTP 200** — `registry.track` swallows asynchronous failures (`app.ts:390`, `projects.ts:43-51`). Severity: high; violates reliability contract §1.2.7 and misleads the UI.
5. **Crashed mid-run stays falsely "running"** — healing guard skips `status === "running"` (`run-manager.ts:171`), and healed state is never persisted. Severity: high; violates §1.2.6.
6. **Firewall is advisory with no path containment** — `..`-bearing scope-matching paths can escape the worktree (`engineer.ts:66`); lockfile protection is overridable by verbatim scope listing (`firewall.ts:37`). Severity: high; the headline "Change Firewall" guarantee.
7. **Untrusted repo code executes on the host by default** (test/build/lint commands; `regression-sentinel.ts`, `test-runner.ts`) with no policy gate, against a `node_modules` junction shared with the user's checkout. Severity: high.
8. **No wall-clock, concurrency, disk, size, or cost ceilings** (§6) — a hung agent hangs the run forever; unlimited concurrent runs; unbounded disk growth with no retention. Severity: high for sustained operation.
9. **Event log is not durable** — non-atomic append, persistence failures silently degrade to memory-only events with seq reuse on restart, corrupt lines silently dropped (`event-log.ts:35-37,57-64`). Severity: medium-high; undermines the client-recovery contract (§1.2.4).
10. **Terminal runtimes and on-disk artifacts never released** (`projects.ts:11` no eviction; no GC of runs/clones/worktrees) — memory and disk grow monotonically. Severity: medium.

Secondary (not top-10 but tracked above): public-API drift only enforced under an opt-in constraint (`verifier.ts:79`); `publicApiChanges` hardcoded 0 in reports (`docent.ts:72`); no request-body zod validation; `/file` prefix-check sibling bypass; `btoa` throws on non-Latin1 project paths (`packages/ui/src/api.ts:9-11`); reducer clock impurity; zero tests outside core/schemas.

---

## Unresolved questions

1. **Dual `EventLog` construction** (`run-manager.ts:134` probe vs `:192` runtime): does the probe executor ever append before the runtime's log is built? If yes, duplicate seqs are reachable today; if no, it is latent. Not determinable from static reading alone.
2. **git stderr credential echo**: which git versions include userinfo in `fatal: repository … not found`-style errors? Determines whether the `app.ts:151` stderr slice is an active token leak to the HTTP client or only a theoretical one.
3. **Decision-fallback reachability in practice**: when the UI is used without any decision-provider key, do verifier gates actually run through the `choices[0]` fallback (silent pass), or does routing refuse earlier? The e2e test always configures mock providers, so the unconfigured path is untested.
4. **Windows SIGKILL semantics**: `child.kill("SIGKILL")` on `.cmd` shims (`git.ts:24-26`) — do spawned grandchildren (npm scripts) survive in the shipped Node 20 runtime on Windows 11, leaving orphaned test processes?
5. **`/file` sibling-prefix bypass** (`app.ts:236-238`): confirm exploitability requires only a decoded repo path whose resolved form is a prefix of a sibling directory — believed true from `path.resolve` semantics, not demonstrated.
