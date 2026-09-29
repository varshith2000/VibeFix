# VibeFix Repair Program — Phase Status

This file tracks the repair program defined in `docs/risks-improvemts.md`
("Recommended repair order"). Each phase lists its scope from that document,
what was actually implemented, where it lives, and how it is verified.
Update this file whenever a phase's state changes — it is the single place
to answer "what has been done, and what is left?".

Verification baseline for everything below: `pnpm verify`
(install --frozen-lockfile → typecheck → test → build) is green, and CI
(`.github/workflows/ci.yml`) runs the same chain on Ubuntu and Windows.

---

## Phase 1 — Make the project verifiable ✅ (done 2026-09-28)

**Scope from the risks doc:** install from a clean checkout; fix the root
typecheck command; make build and tests pass; add CI; remove/label stale
generated artifacts; establish a fixture-repo end-to-end test.

**What was developed:**

| Item | Result |
|---|---|
| Clean-checkout install | `pnpm install --frozen-lockfile` verified; the doc's "build broken" finding was a broken environment, not the repo |
| Typecheck that cannot silently do nothing | Every package has a `typecheck` script; root `typecheck`/`build` now include the UI (non-composite Vite project, invoked via `pnpm --filter @vibefix/ui`) |
| One-command verification | Root `verify` script: install → typecheck → test → build |
| CI | `.github/workflows/ci.yml` — pnpm 9 / Node 20, Ubuntu + Windows matrix, runs the full chain on push and PR |
| Stale artifacts | Audited `git ls-files` — no `dist/`, `*.tsbuildinfo`, or generated files committed; `.gitignore` covers them |
| Fixture-repo E2E | Already existed and passing (`packages/core/test/e2e.test.ts`: full run over the small-mess fixture + worktree-cleanup-on-rejection) |

**Real bug found & fixed:** the UI had an uncaught type error
(`store.ts` `events[len-1].seq` possibly undefined) because nothing ever
typechecked the UI package.

---

## Phase 2 — Close the security boundary ✅ (done 2026-09-28)

**Scope from the risks doc:** loopback-only default binding; authentication
token; restrictive CORS; correct path containment checks; project-scoped run
URLs; secure Git credentials; rate limits and resource limits; tests for
every security issue.

**What was developed:**

| Item | Result |
|---|---|
| Security module | `packages/server/src/security.ts` — token generation/persistence (`~/.vibefix/server-token`, 0600; `VIBEFIX_API_TOKEN` wins), timing-safe compare, auth hook, origin-check hook (DNS-rebinding/CSRF), fixed-window `RateLimiter`, `isPathInside` (path.relative), run-ID shape validation, `parseCloneUrl` allowlist (rejects embedded credentials), credential-file body format, `scrubSecret`, `assertBindingAllowed` |
| Auth on every endpoint | All routes except `GET /api/health` require `Authorization: Bearer`, `X-VibeFix-Token`, or `?token=` (WS) — enforced by an onRequest hook |
| Binding guard | Non-loopback `VIBEFIX_HOST` refuses to start without BOTH `VIBEFIX_ALLOW_REMOTE=1` and an explicit ≥16-char token |
| CORS / origins | Only configured UI origins; foreign `Origin` headers get 403 regardless of CORS |
| Path containment | `/file` endpoint: realpath + `path.relative` containment with symlink re-check (fixes `project` vs `project-secrets` prefix collision) |
| Project-scoped runs | Every run route is `/api/projects/:enc/runs/:runId/...`; `resolveRun` verifies live-runtime↔project match or on-disk location; whole-disk `findRunDir` scan removed |
| Secure Git credentials | Token travels via a 0600 git-credential-store temp file (deleted in `finally`), never in argv; clean canonical clone URL; stderr scrubbed; atomic `mkdir` reservation kills the clone-name race; also fixes contract SEC-011 (token in `.git/config`) |
| Rate/resource limits | 600 req/min global, 10 clones/min, ≤2 concurrent clones, ≤4 active runs (`VIBEFIX_MAX_ACTIVE_RUNS`), 1 MiB body limit |
| Token delivery | Vite dev/preview proxy reads the same token file and injects the header (HTTP + WS upgrade) — the browser never knows the token |
| Tests | `packages/server/test/security.test.ts` — 37 tests: auth matrix, origin/CORS, traversal + prefix collision + absolute paths, cross-project run access, runId traversal, credential URL rejection, scrubbing, rate limit 429, run ceiling, binding guard, token persistence |

**Real bugs found & fixed along the way:**
1. find-my-way's default 100-char param limit silently 404'd any repo path
   longer than ~75 chars (base64url-encoded) → `maxParamLength: 1000`.
2. Importing `@vibefix/server` started the server as a side effect (the
   CLI's `loadEnvFile` import did it) → entry-point guard on `void main()`.
3. Registry keys were unconditionally lowercased → distinct repos collided
   on case-sensitive filesystems (now Windows-only folding).

---

## Phase 3 — Fix runtime correctness ✅ (done 2026-09-28)

**Scope from the risks doc:** stop swallowing approval/dispatch failures;
unregister terminal runtimes; fix WebSocket replay/subscription ordering;
add sequence-gap recovery; make recovery degradation explicit; idempotency
keys for approve/abort/resume. (Finding #8 — reconnect-timer lifecycle —
is the same subsystem and was included.)

**What was developed:**

| Item | Result |
|---|---|
| No more silent approval success | `POST .../approve` awaits `runtime.dispatch(...)` directly in try/catch — a failed approval is an HTTP 500, never `{ok:true}` (`app.ts`) |
| Background failures persisted | `ProjectRegistry.track()` no longer swallows: on rejection it records the failure (bounded map, surfaced via `/api/health` `backgroundFailures` and `failureFor()`) and force-fails the run through the reducer (`FATAL` → status `failed`, `run.failed` event, worktree cleanup) |
| Terminal runtimes unregistered | `registerRuntime` subscribes to the run's events; on `run.completed` / `run.failed` / `run.aborted` / `run.nochanges` (or registration of an already-terminal run) the runtime is dropped after background work settles. Disk-backed serving keeps everything readable; the health count is now truthful; no more unbounded memory growth |
| WS replay/subscribe race fixed | New `packages/server/src/ws-replay.ts` — `bridgeReplayToLive` subscribes FIRST into a buffer, replays history, flushes the buffer (dedup by eventId), then goes live. Events appended between the replay query and the subscription can no longer be lost. Used by the `/ws` handler with snapshot-on-change via `onLiveEvent` |
| Sequence-gap recovery (UI) | `store.ts` `pushEvent` detects `seq > lastSeq + 1` and triggers `resyncAfterGap()` — pulls missed events from the durable REST log plus a fresh authoritative snapshot |
| Reconnect lifecycle (UI) | `connectionGeneration` + retained `reconnectTimer`: every connect/disconnect bumps the generation; timers and socket callbacks no-op unless current; `disconnect()` cancels the pending timer. No more orphaned reconnects for a previous run |
| Explicit degradation | `EventLog` counts failed appends (`persistenceFailures`, `degraded`) and corrupt lines (`replaySince` returns `corruptLines`); `GET .../events` responds with `corruptLineCount` / `replayDegraded` / `persistenceFailures`; corrupt `state.json` is a 500 `{degraded:true}` instead of a silent 404; `/ws` sends `{t:"degraded"}` frames; the UI shows a "⚠ replay degraded" badge (`EventStream`) |
| Idempotency keys | `approve` / `reject` / `abort` / `resume` accept an `Idempotency-Key` header (or body `idempotencyKey`); a repeated key replays the original 200 response with `X-Idempotent-Replay: true` instead of double-executing. Without a key, the phase guard still prevents double dispatch (409) |
| Tests | `packages/server/test/runtime-correctness.test.ts` — 12 tests: approval-dispatch failure → 500; idempotent replay (approve + abort) with dispatch-counted doubles; duplicate approve without key → 409 single dispatch; `track()` FATAL + failure recording + health count; terminal unregistration (event-driven and already-terminal); bridge no-loss/no-dup with events appended during replay; corrupt-lines counting; corrupt state 500; unpersisted-event flagging |

**Known limits (documented, not hidden):** idempotency cache is in-memory
(process lifetime); sequence-gap detection uses the dense `seq` counter and
triggers a REST resync rather than a protocol-level handshake; `/open` on a
terminal run registers its runtime only for the instant needed, then serves
from disk (usage numbers for historical runs read as zero).

---

## Phase 4 — Improve analysis quality ✅ (done 2026-09-29)

**Scope from the risks doc:** parser-backed code metrics; TypeScript module
resolution for the import graph; LLM findings validated against repository
facts; finding fingerprints; confidence + analyzer provenance.

**What was developed:**

| Item | Result |
|---|---|
| Parser-backed metrics | `packages/adapters/src/tools/code-metrics.ts` — TS/JS files measured through the TypeScript compiler AST (`measureTsFunctions`: function spans survive braces in strings, template literals, comments, regexes, JSX; arrow/method/accessor/constructor naming; Block-based nesting depth). The old regex scanner remains as an explicitly low-confidence fallback and for Python. Every `FunctionMetric` carries `analyzer: "ts-ast" \| "regex-heuristic"`; `FileMetrics.analyzer` reports the aggregate (incl. `"ts-ast+regex-fallback"` when a file failed to parse) |
| TS module resolution for imports | `packages/adapters/src/tools/import-graph.ts` — new `TsImportGraph`: AST module-specifier extraction (import, `export ... from`, dynamic `import()`, `require()`) + `ts.resolveModuleName` resolution with the repo's tsconfig (`baseUrl`/`paths` aliases), extension probing and index files. External / out-of-repo resolutions stay unresolved edges. Python keeps the regex patterns (labeled). `createImportGraph()` is the new default in the executor; `RegexImportGraph` remains exported. `ImportGraph.analyzer` names the backend |
| LLM finding validation | `packages/agents/src/shared/findings.ts` — `validateLlmFindingAgainstRepo()` runs BEFORE an LLM finding enters the evidence store: a location that does not exist in the file snapshot is REJECTED (hallucinated paths never become findings the Engineer "fixes"); findings whose evidence cites no real file are kept but demoted to `analyzer: "llm-unverified"` with confidence capped at 0.5. Wired into the Architecture Auditor's discovery pass |
| Finding fingerprints | `findingFingerprint()` — sha1 of category + normalized location (line suffixes/case/slashes stripped) + normalized sorted evidence + recommendation. The arch-auditor dedupes against deterministic findings by fingerprint instead of title: different wording about the same defect merges, differently-located defects never do |
| Provenance on findings | `FindingSchema` gains optional `analyzer` and `parserStatus` (older artifacts parse unchanged). Deterministic arch findings carry `import-graph` + the graph backend; smell findings carry `ts-ast` (confidence 0.9) or `regex-heuristic` (0.5); duplication findings carry `duplication-scan`; LLM findings carry `llm-validated` / `llm-unverified`. The UI Findings panel shows the analyzer as a colored pill (amber for llm/regex, blue for exact analyzers) with the parser status as tooltip |
| Tests | `packages/adapters/test/analysis.test.ts` (AST spans through brace-poison sources; analyzer labels; aliased/dynamic/export-from/external resolution; regex graph still labeled) and `packages/agents/test/finding-validation.test.ts` (fingerprint merge/split rules; hallucination rejection; unverified demotion; directory-prefix locations). The core E2E exercises both new analyzers through the real pipeline (`factsFor` → `createImportGraph` + `computeMetrics`) |

**Dependency change:** `@vibefix/adapters` now depends on `typescript`
(same version range as the workspace) for the compiler API.

### User-requested addition: projects without git

Opening a folder with no git trace is now supported, opt-in:
`GitTool.initBaseline()` runs `git init -b main` (with fallback for older
git), sets repo-local identity (`VibeFix <vibefix@local>`) so the baseline
commit succeeds on machines without global git config, and commits the
current contents (`--allow-empty` for empty folders) — worktrees need one
commit to branch from. Wired through `RunManager.open(..., { initIfMissing })`
→ `ProjectRegistry.open` → `POST /api/projects { repoPath, initGit: true }`.
Without the flag the endpoint still refuses, with an error that names the
`initGit` option. The UI shows a "No git here — initialize a repository &
open" button whenever the open fails with "not a git repository". Verified by
`packages/server/test/open-project.test.ts` (refusal + hint, initialization
+ clean tree + `.git` present, subsequent opens, type validation).

---

## Phase 5 — Align documentation with reality ⬜ (pending)

**Scope from the risks doc:**
- Rewrite `AGENTS.md` into implemented / partially implemented / not yet
  verified; never mark a feature complete without a test covering the
  failure scenario.
- Reconcile `docs/production-contract.md`, `docs/production-contract-audit.md`
  and `docs/production-acceptance-criteria.md` with the post-Phase-2/3 state
  (several entries and line-number references describe pre-phase code: the
  now-scoped `/api/runs/*` routes, the removed `findRunDir`, SEC-011 which
  Phase 2 fixed, REL-03/04 degradation reporting which Phase 3 implemented).
- Document local-only security assumptions and operational limitations.
- Do not use "production-ready" anywhere until CI and the security tests are
  green from a clean checkout — they are, so the remaining blocker for that
  word is the open contract items, not the CI.

---

## Bottom line

Phases 1–4 are implemented and verified (97 tests green, `pnpm verify`
green, E2E through the new analyzers). The system is still **not
production-ready**: Phase 5 (documentation truth) remains, and the
enforceable gate list in `docs/production-contract.md` §10 still has open
blockers beyond this repair program.
