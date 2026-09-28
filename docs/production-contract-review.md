# Hostile Production-Readiness Review

**Reviewer stance:** adversarial. Assumption: every claim is false until the code proves it.
**Documents reviewed:** `docs/production-contract-audit.md`, `docs/production-contract.md`, `docs/production-acceptance-criteria.md`, `README.md`, `AGENTS.md`
**Code evidence base:** working tree at commit `16682ef`; all cited behavior was verified in the audit and, for load-bearing claims, re-verified by direct source reading. Test suite state: 4 files / 31 tests, all passing — none of the defects below is covered by a failing test.

Each finding gives: (1) location, (2) problem, (3) why the wording is insufficient, (4) concrete failure scenario, (5) stronger wording, (6) required implementation control, (7) required automated test, (8) blocks release.

---

## A. Systemic findings (all three contract documents)

### F-01 — No item in any document has an owner
1. All contract items (SEC/REL/SAFE/RES/DATA/AUD/OBS/MIG), all acceptance criteria, all release gates.
2. No `Owner` field exists anywhere; nothing names who implements, tests, or signs off.
3. "Planned — work required" without an owner is a wish, not a plan; gates cannot be enforced accountability-wise.
4. Release day arrives; GATE-14 is open; no one is on the hook, so it ships anyway.
5. Every contract row and gate gains an `Owner` (role or named engineer) and a target milestone; unowned items are deleted.
6. None (process control); tracked in the contract table itself.
7. Manual review gate: GATE-13 checklist asserts every blocker row has an owner and a linked branch/issue.
8. Blocks release (process blocker).

### F-02 — Resource limits marked `TBD` make the resource contract untestable
1. Contract §5 (RES-01, RES-04, RES-05, RES-07, RES-10, RES-13, RES-15, RES-16).
2. Seven-plus limits have no value; "TBD" cannot be tested, enforced, or violated.
3. A contract that says "limits exist, values TBD" promises nothing measurable; acceptance criteria RES-001/004/005/007/015 are un-runnable as written.
4. Operator starts 200 concurrent runs against 5 large repos on a laptop; disk fills, machine dies mid-cherry-pick (see F-14).
5. "Each limit SHALL have a numeric default and a config key at release; a limit without a value is a defect, not a TBD."
6. Implement each limit at its enforcement point (registry intake, dispatch loop, run supervisor, clone route, evidence store).
7. The RES criteria once values are fixed (limits.test.ts, time-budget.test.ts, disk-budget.test.ts).
8. Blocks release.

### F-03 — "Enforced by absence" claims are unfalsifiable as tested
1. Contract DAT-04 ("provider requests are not logged … enforced by absence"), DATA-008, MIG-005 framing.
2. Absence of a code path today proves nothing about tomorrow; the criterion "scan after one run" can't prove a negative.
3. One refactor adding prompt logging silently flips the guarantee with no failing test.
4. Contributor adds `logger.debug(prompt)` for debugging; every repo file's content now lands in console/logs — unnoticed because no test pins it.
5. "Prompts and response bodies SHALL NOT be persistable: the types passed to logging exclude prompt content (structural, not behavioral)."
6. Type-level separation: prompt/response types are not serializable into the logger/event schema.
7. Negative test with a canary prompt string; static rule (lint) forbidding prompt variables in log/event calls.
8. Blocks release (major privacy claim rests on it).

### F-04 — The documents assume a trusted single-writer local environment without an explicit single-writer control
1. Contract §1 (single-user, local-first); REL-04; audit §5 assumption 1.
2. Nothing prevents two processes (server + CLI, or two servers) opening the same run: `EventLog` has no file lock and seq is an in-memory counter per instance (`run-manager.ts:134,192`).
3. "Single-user" is a statement about intent, not a mechanism; the code already constructs two EventLogs per run.
4. Operator runs `vibefix run` headless while the UI server has the same project open: interleaved appends, duplicate `seq`, a UI resuming on `since=` silently drops or duplicates events.
5. "Exactly one process may write a run's event log; second openers open read-only or fail with `E_RUN_LOCKED`."
6. Lock file (`~/.vibefix/projects/<key>/runs/<id>/.lock`, O_EXCL / flock) checked on `loadRun`/`createRun`.
7. `event-log.test.ts`: two writers → second fails `E_RUN_LOCKED`; no duplicate seq.
8. Blocks release.

---

## B. README.md

### F-05 — "Nothing touches your code until you approve it" — contradicted three ways
1. README lines 10-12.
2. VibeFix writes `core.longpaths=true` into the user's `.git/config` at worktree creation (`git.ts:112`); worktrees junction the user's `node_modules` (`worktree-manager.ts:123-136`), so worktree test runs write into the user's real `node_modules`; the harness baseline run executes the repo's test command **in the user's repo**, which commonly writes `coverage/`, `dist/`, caches into the working tree.
3. "Nothing" is absolute; three concrete counter-examples exist; also the crash window during post-approval landing (F-14).
4. User with a spotless repo runs analysis, rejects at checkpoint — finds `git diff` dirty (`.git/config` changed, coverage artifacts) and `node_modules` mutated by worktree tests.
5. "Before approval, VibeFix makes no tracked-file changes in your repository. It records one git setting (`core.longpaths`) and may write build/test caches when the baseline suite runs post-approval."
6. Move `longpaths` into worktree-local config or ask consent; isolate `node_modules` per worktree (copy/offline install) or junction-read-only; run baseline in a worktree snapshot.
7. `primary-tree.test.ts`: assert `git status --porcelain`, `.git/config`, and `node_modules` hashes unchanged from START to checkpoint.
8. Blocks release (it is the product's headline promise).

### F-06 — "an independent verification pool **proves** it preserved behavior" — overclaim
1. README lines 11-12, 77; v1doc invariant 4.
2. What actually runs: boolean pass/fail suite comparison (`run.ok === baselineOk`), export-symbol regex drift that only fails under an opt-in constraint (`verifier.ts:79`), a diff sliced to 12,000 chars, one shared provider model by default, and a fallback that answers "yes" at confidence 0.3 when no decision provider exists (`decision-agent.ts:38-48`).
3. "Proves" and "independent" are the two strongest words in the domain; the implementation checks a truncated diff with a possibly-absent judge.
4. Repo with no tests and no decision key: every gate is `NOT_APPLICABLE` or auto-passed; the engineer's change lands "proven".
5. "The verification pool **checks** for behavior drift using deterministic gates (scope, suite outcome, export surface) plus an LLM review of the diff; absent a test suite or decision provider, the run is marked **not verified** and nothing lands."
6. Fail-closed fallback in `decide()` for verification questions; refuse-to-land when gates are `NOT_APPLICABLE` and no residual adjudication ran.
7. `fresh-context.test.ts` case (b) (exists as criterion SAFE-010; not implemented).
8. Blocks release.

### F-07 — "Keys from environment (never persisted)" — contradicted for GitHub tokens
1. README line 85.
2. The GitHub clone token is persisted by git into `<clone>/.git/config` (`app.ts:147`), and can surface in returned stderr (`app.ts:151`).
3. The sentence is true only for LLM provider keys; a reader supplies a GitHub token believing the blanket claim.
4. User clones a private repo; months later shares/packs the `~/.vibefix` folder for debugging — token travels with it.
5. "LLM provider keys are read from the environment and never persisted. GitHub tokens are used for the clone only and scrubbed from the clone's git config afterward" (and make the second sentence true — SEC-011).
6. Credential mechanism per SEC-011 (`http.extraheader` or post-clone `remote set-url` scrub).
7. `credential.test.ts`: post-clone `git config remote.origin.url` contains no userinfo.
8. Blocks release.

### F-08 — "2 violations = auto-reject" is unscoped and resettable
1. README line 76; v1doc invariant 3.
2. The counter is per `ChangeFirewall` instance, instantiated fresh per attempt (`runtime.ts:306`); it resets every retry.
3. As worded, readers understand two lifetime violations kill the change; actually one violation per attempt across 3 attempts never triggers auto-reject.
4. A pattern of single probing violations per attempt (one forbidden write, then compliant behavior) evades auto-reject for the whole retry budget.
5. "Two violations **within one attempt** auto-reject that attempt; violations are also accumulated per proposal in the ledger, and 2 cumulative violations defer the proposal."
6. Persist violation count per proposalId in the ledger; check cumulative count in `advanceExecution`.
7. Firewall + reducer test: one violation per attempt × attempts → proposal deferred.
8. Major; blocks release only if combined with retry-bound weakness (it is cheap to fix — do both).

### F-09 — "Pure reducer" / v1doc "no clock" — false as stated
1. README line 74; v1doc invariant 5; `reducer.ts:5-6` docstring.
2. `reducer.ts:21,144` stamps `new Date().toISOString()` on every event.
3. "Pure" is a load-bearing testing promise; time-dependence breaks replay-diff determinism in tests.
4. Two identical event sequences produce different `updatedAt` values; a snapshot-comparison test flakes or masks real diffs.
5. "The reducer is deterministic given (state, event) except for timestamp fields, which are excluded from equality checks."
6. Inject a clock into `reduce` or move timestamping to the runtime.
7. Reducer test asserting byte-identical state for replayed sequences (timestamps excluded or injected).
8. Minor (wording); the control is major hygiene.

### F-10 — README/v1doc retry-count inconsistency
1. README line 78 ("failing twice is deferred"), v1doc line 17 ("max 1 retry"), code default `maxRetriesPerChange: 2` (`routing.ts:48`).
2. Three different numbers across two docs and the schema.
3. Operators cannot reason about worst-case attempts (actually 3: initial + 2 retries).
4. User budgets review time for 2 attempts, gets 3.
5. Single sentence everywhere: "default 3 attempts per change (1 initial + 2 retries), then the proposal is deferred."
6. None (docs alignment).
7. GATE-13 documentation-match check includes this constant.
8. Minor.

---

## C. AGENTS.md

### F-11 — "The system is now ready for production deployment with confidence" — remove
1. AGENTS.md Conclusion; echoed by ISSUES_FIXED.md ("production-ready").
2. 13 acceptance criteria are failing, 20 blocker-severity criteria are open, the API has zero authentication.
3. A deployment-decision reader of AGENTS.md alone would ship it.
4. Team deploys per AGENTS.md; any webpage can approve checkpoints (F-16).
5. Delete the sentence; replace with a pointer to `docs/production-contract.md` §10 gates and their open state.
6. None (documentation).
7. GATE-13: docs must not contain readiness claims contradicted by gate state.
8. Blocks release (as written it is a false claim in the repo).

### F-12 — "Session Recovery After Server Restarts ✅ … stale state healing" — contradicted
1. AGENTS.md §10.
2. The healing guard skips `status === "running"` (`run-manager.ts:171`) — precisely the crash case; healed values are never persisted.
3. A checkmark on a recovery feature that fails in the most common crash mode is worse than silence.
4. Server crashes mid-execution; after restart the UI shows the run as active forever; the operator waits on a zombie.
5. "Crashed runs are marked `interrupted` on next load (including mid-execution crashes) and are resumable; the healed status is persisted."
6. Persisted clean-shutdown marker/heartbeat; heal all non-clean states; write healed state back (REL-008).
7. `recovery.test.ts`: kill -9 mid-run → `interrupted`, resume completes.
8. Blocks release.

### F-13 — "Fallback to emit events even if persistence fails" is presented as a fix; it is a durability violation
1. AGENTS.md §5; `event-log.ts:57-64`.
2. Emitting a never-persisted event, then reusing its seq after restart, converts a disk failure into silent event loss for reconnecting clients.
3. The doc frames a data-loss path as resilience.
4. Disk fills mid-run; live UI shows phase X; after restart the event log lacks X and its seq is reused; a `since=`-resync client never learns X happened.
5. "If an event cannot be persisted, the run is marked degraded and the append is retried; the event is delivered with a `persisted: false` flag and the sequence is never reused."
6. Retry with backoff in `append`; seq allocated only on durable write; degraded counter surfaced (OBS-006).
7. `event-log.test.ts` failure-injection: full disk → degraded flag, no seq reuse after restart.
8. Blocks release.

---

## D. docs/production-contract.md and acceptance criteria — grading and wording

### F-14 — No control for a crash during post-approval landing (cherry-pick) on the user's branch
1. Contract BP-01/REL-13; acceptance criteria SAFE-001/REL-013 (gap: no such criterion exists).
2. Landing runs `git cherry-pick` **in the user's repo** (`worktree-manager.ts:76-81`). A process death between cherry-pick start and completion leaves the user's branch mid-cherry-pick (`CHERRY_PICK_HEAD`, staged index, possible conflict state).
3. The contract's "restart does not silently lose run state" covers VibeFix state, not the user's repository state — the more valuable asset.
4. Power loss during landing of proposal 3 of 7; on reboot the user's repo is in a conflict state they didn't know was in progress, with staged half-applied changes.
5. "Landing is a recoverable operation: on load, any detected in-progress cherry-pick in the target repo is completed or aborted deterministically, and the ledger records which."
6. Land-phase journal (pre/post records) + `git status` detection on project open; auto-`cherry-pick --abort` with ledger note (or complete + note).
7. New criterion SAFE-015 (failure-injection): kill during cherry-pick → reopen → repo clean, ledger reflects outcome.
8. Blocks release.

### F-15 — WS subscribe race: events between replay-read and subscribe are missed
1. Contract REL-05; server flow `app.ts:574-585` (snapshot → `eventsSince(since)` read → `socket subscribe`).
2. Events appended after the replay read but before `subscribe` are never sent on that socket; there is no buffer.
3. "Clients can recover from any missed WebSocket event" is stated while a no-window-miss protocol does not exist; correctness currently leans on later snapshot pushes and REST polling.
4. Agent completes exactly between replay read and subscribe: its result event is absent from the stream until an unrelated SNAPSHOT_EVENTS trigger fires; UI shows a stale phase.
5. "The server subscribes the socket **before** reading the replay, buffers to the socket, and deduplicates by `seq` client-side."
6. Reorder subscribe/replay + seq-dedup protocol.
7. `ws-replay.test.ts`: deterministic interleave (append during connect) → client sees every event exactly once.
8. Blocks release (it is the letter of REL-005).

### F-16 — "Local-first, loopback-only" is a trusted-environment assumption, not a boundary
1. Contract §1.1, SEC-01/SEC-02; README quick start.
2. Loopback binding is the **only** access control until SEC-003/004/005 land; `cors({origin:true})` reflects any origin, so browser JS on any site the operator visits can call the API while the server runs.
3. The documents imply the loopback default is a meaningful control; without auth it is a network-adjacency accident.
4. Operator visits a compromised page while VibeFix runs: the page POSTs `/api/projects/<enc>/runs`, then `/approve`, and code lands on their branch (CLI-equivalent of `--yes`).
5. "Until SEC-003/004/005 are enforced, a running server is treated as privileged: the docs must state that any local process or webpage can drive it."
6. SEC-003..005 implementation (auth, WS ticket, CORS allowlist) — already planned; add the interim warning to README now.
7. `auth.test.ts`, `ws-auth.test.ts`, `cors.test.ts` (criteria exist).
8. Blocks release.

### F-17 — SEC-02 "warning on remote bind" is a control that controls nothing
1. Contract SEC-02.
2. A log line does not prevent binding; the criterion asserts a warning was printed, not that exposure was prevented.
3. Testable but toothless; hostile reading: theater.
4. Misconfigured `VIBEFIX_HOST=0.0.0.0` in a script; warning scrolls past in a service log; API is exposed with no auth.
5. "Non-loopback binding requires `VIBEFIX_ALLOW_REMOTE=1` **and** auth enabled (SEC-003); otherwise the server exits at startup with `E_REMOTE_REFUSED`."
6. Startup validation gate in `main()`.
7. `bind.test.ts`: no flag → process exits non-zero, never listens.
8. Blocks release.

### F-18 — SEC-09 "rejected **or explicitly handled**" is a weasel clause
1. Contract SEC-09; criterion SEC-009.
2. "Explicitly handled" permits anything labeled as such; two behaviors, one criterion.
3. Untestable as a single guarantee; the junction exception already blurs it.
4. Reviewer implements "log a message" as handling; symlink escape ships.
5. "Symlinked paths that resolve outside the approved root are rejected with `E_PATH_ESCAPE`. The worktree `node_modules` junction is the single documented exception, created by VibeFix itself and read-only to agents."
6. `realpath` containment check; junction created read-only or replaced by copy.
7. `traversal.test.ts` symlink cases + engineer-write symlink case.
8. Blocks release.

### F-19 — SEC-10 "secrets" is undefined; the test can only prove planted canaries, not secrets generally
1. Contract SEC-10; criterion SEC-010.
2. No definition of what counts as a secret (patterns? entropy? length?).
3. "No secrets in logs" is unfalsable in general; the criterion silently degrades to "the tokens we planted".
4. A novel credential format (custom internal token) passes the canary test and leaks.
5. "Defined credential shapes (bearer tokens, `x-access-token`, key=value env lines, high-entropy strings >N chars in value position) are redacted; the redaction pattern list is versioned in the repo."
6. Shared `redact()` with a versioned pattern list; applied at logger/error/event boundaries.
7. Canary test + pattern-list unit tests; bundle export scan (DATA-007).
8. Blocks release (wording must scope the claim; the mechanism is GATE-11).

### F-20 — SEC-12 execution policy leaves the verification-weakening interaction undefined
1. Contract SEC-12; interaction with BP-05..BP-11 not specified.
2. If repo commands are not approved, gates become `NOT_APPLICABLE` — and `NOT_APPLICABLE` does **not** block landing today (sentinel leniency, `regression-sentinel.ts:39-44,61-83`).
3. The policy intended to reduce risk silently removes the verification the product exists to provide.
4. Operator declines script execution (sensible on a hostile repo); engineer changes land with zero executable verification, marked only in prose nobody reads.
5. "When the execution policy prevents baseline or after-change command execution, proposals **shall not land**; the run completes `not-verified` with the changes left in the worktree/branch for manual review."
6. Fail-closed gate composition in `executeProposal` when runnable verification is unavailable.
7. `exec-policy.test.ts`: unapproved commands + passing engineer → nothing lands, status `not-verified`.
8. Blocks release.

### F-21 — Grading inflation in the contract: known-broken items marked "partially enforced"
1. Contract BP-01 (original tree: `.git/config` writes today), BP-02 (containment absent today), REL-03 (four enumerated violations).
2. "Partially enforced" for guarantees with concrete counter-examples reads as progress; hostile reading: the contract soft-pedals its own audit.
3. Status words must map 1:1 to reality or the whole status system loses trust.
4. Stakeholder reads "partially enforced" and deploys behind a flag "temporarily".
5. Rule: any cited counter-example ⇒ status `failing` (as the acceptance criteria already do); reserve `partially enforced` for untested-but-uncontradicted code.
6. Re-grade BP-01, BP-02, REL-03, REL-09, RES-02/03/17 to `failing` where the audit shows violation.
7. GATE-13 includes a status-consistency check against the audit.
8. Blocks release (documentation integrity).

### F-22 — BP-04 "only the Engineer can write" depends on convention and prompt text, not capability
1. Contract BP-04; README "Single writer"; v1doc invariant 2.
2. Every agent receives the same toolset (`contract.ts:12-18`); nothing at the type or process level prevents another agent (or future contributor) from importing `node:fs`; the engineer's compliance itself rests on a system prompt ("Touch ONLY paths…").
3. A guarantee resting on prompt obedience and code-review discipline is not a control.
4. A future agent (say a "fixer") is added with `read-only` but its author calls `fs.writeFile` — nothing fails, tests stay green.
5. "Only the engineer execution context is **granted** a write capability (injected fs-like object); all other agents' contexts structurally lack one."
6. Capability injection: pass a `writeFile` handle only into the engineer context; lint/AST rule forbidding `node:fs` imports outside engineer + core.
7. `permissions.test.ts`: asserting non-engineer contexts have no write capability; static-rule test.
8. Blocks release (it is the "only the Engineer can write" promise).

### F-23 — "Independent verification" overstates: one model, shared context inputs, prompt-asserted blindness
1. Contract BP-10 wording; README line 77; v1doc invariant 4.
2. All three verifiers default to the same decision provider (`routing.ts:185-187`); the backlog artifact they consume carries the proposal's self-description (`expectedBenefit`, `explanation`); blindness is enforced by prompt assembly code, and the sentinel's determinism is real but its gates are the weakest (leniency).
3. "Independent" implies diverse judges; "structurally blinded" is the accurate claim, and even that is input-shaping.
4. Correlated failure: one provider's bias approves its own work pattern across all three gates.
5. "Verification agents are structurally blinded to the engineer's rationale and receive deterministic inputs; gate 1 and 3 are fully deterministic; model diversity is configurable and recommended."
6. Keep deterministic-first ordering; document single-provider correlation risk; optional provider-diversity config.
7. `fresh-context.test.ts` (a): assert no `change-attempt` content in verifier prompts.
8. Major; wording must change now, diversity later.

### F-24 — Idempotency (REL-001) as planned does not address the concurrent-dispatch race it must
1. Contract REL-001; current `dispatch` serialization is per-runtime in-process only (`runtime.ts:94-113`).
2. Two processes (F-04) or a UI double-click racing the phase transition can both pass `phase === "awaitingApproval"` checks before either persists.
3. The criterion only replays sequentially; the dangerous case is simultaneous.
4. Two approval requests land in the same millisecond: queue built twice, harness runs twice, duplicate worktrees/commits.
5. "Command application is atomic: the idempotency key check and the state transition occur under the run lock (F-04) in one critical section."
6. Run lock + compare-and-set on (phase, lastCommandId) in `reduceAndPersist`.
7. `idempotency.test.ts`: fire N concurrent approvals → exactly one queue built.
8. Blocks release.

### F-25 — Malformed input beyond traversal is unvalidated and has no criteria
1. Server route bodies: clone body, runs body, approve body (`approvedProposalIds`, `mode`) used raw (`app.ts:134-147,317-327,383-387`); only `PUT /config` validates.
2. Acceptance criteria cover traversal (SEC-008) but not type/shape validation of the other bodies.
3. "Vulnerable to malformed input" is in scope for this review; unvalidated arrays flow into the reducer and executor.
4. `approvedProposalIds: [{"__proto__":...}]` or a `mode: 42` reaches `reduce` and the executor's proposal lookup; behavior undefined, at best a confusing 500.
5. "Every request body is zod-validated per route; invalid ⇒ 400 `E_INVALID_BODY`."
6. Route schemas mirroring `RunEvent` payloads.
7. `packages/server/test/validation.test.ts` (new criterion SEC-014): malformed bodies → 400, run state untouched.
8. Blocks release.

### F-26 — Terminal-runtime disposal and artifact retention have no crash-safe trigger
1. Contract REL-011, DAT-005; current cleanup relies on resume paths and swallowed errors (`worktree-manager.ts:83-121`).
2. Disposal/retention "planned" without stating when they run (on terminal event? on startup? periodic?).
3. A cleanup that only runs on the happy path is indistinguishable from no cleanup after a crash.
4. Server is killed nightly; worktrees and clones accumulate for weeks; disk budget (RES-015) never triggers because nothing measures.
5. "Startup sweep + terminal-event disposal + periodic retention job, each idempotent and journaled."
6. `cleanupAll` on project open; scheduled retention pass; disposal verification (retry, surface failure) — fixes BP-013's swallowed errors too.
7. `lifecycle.test.ts` + `retention.test.ts` with crash-then-restart interleave.
8. Blocks release (resource contract depends on it).

---

## E. The five most dangerous contract gaps

1. **Verification can silently auto-pass** (F-06/F-20/F-23): no-provider fallback answers "yes" at confidence 0.3, `NOT_APPLICABLE` gates don't block landing — the product's core promise (behavior preservation) can be satisfied by absence of a judge. Until fail-closed semantics exist, every landed change is unproven.
2. **The API is a privileged local orphan** (F-16/F-25): zero authentication + reflect-all CORS + unvalidated bodies on a server that can approve and land code. Any local process or visited webpage is effectively the operator.
3. **Crash windows touch the user's repository, not just VibeFix state** (F-14/F-05/F-12): mid-cherry-pick termination leaves the user's branch in a conflicted half-applied state; crashed runs display as running; pre-approval writes already breach "nothing touches your code".
4. **Credential persistence** (F-07/F-19): the GitHub token outlives its use in `.git/config`, argv, and possibly stderr, under a README that says keys are never persisted.
5. **No ceilings of any kind** (F-02/F-26): no run duration, concurrency, disk, call-count, or cost caps, and no crash-safe cleanup — a single pathological run or a handful of clones can exhaust the machine hosting the user's actual work.

## F. Promises that must be removed or weakened

| Where | Current promise | Replacement |
|---|---|---|
| README 10-12 | "Nothing touches your code until you approve it" | "No tracked-file changes before approval; git config entry + test caches excepted (see contract §4)" — then remove the exceptions via F-05 controls |
| README 11-12 / v1doc inv. 4 | verification pool "proves" behavior preserved / "independent" | "checks for behavior drift via deterministic gates + blinded LLM review; single-provider by default" |
| README 85 | "Keys from environment (never persisted)" | Scope to LLM keys; state GitHub-token handling honestly until SEC-011 lands |
| README 74 / v1doc inv. 5 | "Pure reducer… no clock" | "Deterministic transition table; timestamp fields excluded" |
| README 76 | "2 violations = auto-reject" (unscoped) | "2 violations within one attempt auto-reject; cumulative per-proposal counter defers" |
| README 78 / v1doc 17 | retry counts (2 vs 1) | "3 attempts (1 + 2 retries), then defer" |
| AGENTS.md conclusion | "ready for production deployment with confidence" | Delete; link to contract release gates |
| AGENTS.md §10 | "Session Recovery … ✅" | "Run state is durable; crash classification is a known open defect (REL-008)" |
| AGENTS.md §5 | "fallback to emit events even if persistence fails" (framed as resilience) | "degraded mode with retry and no seq reuse" (per F-13) |
| Contract SEC-09 | "rejected or explicitly handled" | "rejected; single documented junction exception" |
| Contract SEC-02 | "warning" | "refuse to start without explicit opt-in + auth" |
| Contract COMP §9 title scope | "Persisted schema versioning" (read as all persistence) | "Artifact schema versioning (enforced); state/event versioning planned" |
| Contract DAT-04/DATA-008 | "enforced by absence" | structural non-persistability claim + negative test (F-03) |

## G. Guarantees requiring security testing

SEC-003 (REST auth), SEC-004 (WS auth), SEC-005 (CORS allowlist), SEC-006 (project isolation), SEC-007 (run scoping), SEC-008 (path escape), SEC-009 (symlink escape), SEC-010 (secret non-exposure / canary scan), SEC-011 (credential mechanism), SEC-012 (execution policy), SEC-014 (body validation — new, F-25), SAFE-002 (worktree containment incl. `..` and symlinked write paths), SAFE-010 (blinded verification, no auto-pass), DATA-002 (provider payload scope), DATA-003 (redaction), DATA-007 (diagnostics redaction), DATA-008 (key storage). Gate GATE-06 and GATE-11 are the umbrella proofs.

## H. Guarantees requiring failure-injection testing

REL-003 (persistence failure before report), REL-007 (kill -9 mid-run, resume), REL-008 (crashed run classified interrupted), REL-009 (corrupt events/artifacts on disk), REL-010 (approve → induced downstream failure), REL-012 (child-process timeout/kill, Windows tree), REL-013 (SIGTERM mid-run), **SAFE-015 (new: kill during cherry-pick landing, F-14)**, SAFE-001 (pre-approval primary-tree invariance under full pipeline), RES-004/RES-005 (time budgets via hung agents), RES-015 (disk exhaustion), SEC-010 (token canary under failing clone), F-04 lock test (concurrent writers), F-24 concurrent-approval race, F-15 WS connect interleave. Gate GATE-07 and the failure-injection portions of GATE-11/12 are the umbrella proofs.

---

## Verdict

The contract documents are honest about the code (the audit and criteria are reliable); the marketing-adjacent documents are not (README, AGENTS.md). The contract's own release gates, correctly hostile-read, block this release 20 times over — most dangerously where the product's founding promise (verified behavior preservation) can be satisfied by a missing model answering "yes". Do not use the word "production" near this system until the F-01…F-26 blockers with `Blocks release: yes` are closed and their named tests exist and pass.
