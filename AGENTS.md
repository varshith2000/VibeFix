# VibeFix — Agent & Engineering Guide

> **How to read this document (repair-program rule, Phase 5):** a feature is
> listed as **Implemented** only when a passing test in this repository
> covers it (or its failure scenario). **Partially implemented** means the
> code exists but a named gap remains. **Not yet verified** means exactly
> that — do not rely on it. The enforceable contract and its gate list live
> in `docs/production-contract.md` (v3.1); the repair-program status file is
> `docs/PHASES.md`. **The application is not production-ready** — that word
> is reserved for GATE-14 in the contract §10.

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
| Verifiable build/test baseline | root `verify` script (install --frozen-lockfile → typecheck → test → build, incl. UI) | locally green (`pnpm verify`); CI workflow `.github/workflows/ci.yml` (Ubuntu + Windows matrix) runs it on every push/PR — the Windows leg is locally verified, the Ubuntu leg first proves itself on the first pushed commit |
| Deterministic reducer state machine (guards, retries, defers, checkpoint gating) | `packages/core/src/orchestrator/reducer.ts` | `packages/core/test/reducer.test.ts` |
| Change Firewall (scope deny-by-default, protected paths, lockfiles, auto-reject) | `packages/core/src/worktree/firewall.ts` | `packages/core/test/firewall.test.ts` |
| Artifact schema versioning + migration walk rejection | `packages/schemas/src/migrations.ts` | `packages/schemas/test/roundtrip.test.ts` |
| Full pipeline end-to-end over a fixture repo (real git worktrees, landing, cleanup-on-rejection) | executor + orchestrator | `packages/core/test/e2e.test.ts` |
| Bearer-token auth on every endpoint except `/api/health`; timing-safe compare | `packages/server/src/security.ts` | `packages/server/test/security.test.ts` (auth block) |
| Binding guard: non-loopback host refuses to start without `VIBEFIX_ALLOW_REMOTE=1` AND an explicit ≥16-char token | `security.ts` `assertBindingAllowed` | `security.test.ts` (binding guard block) |
| CORS allowlist + foreign-`Origin` refusal (DNS-rebinding/CSRF) | `security.ts` `originCheckHook` | `security.test.ts` (origin block) |
| Path containment by `path.relative` (no string-prefix collision) + symlink realpath re-check | `security.ts` `isPathInside`; `/file` route | `security.test.ts` (filesystem containment block) |
| Project-scoped run URLs; cross-project run access is 404; runId shape validation | `app.ts` `resolveRun` | `security.test.ts` (project-scoped runs block) |
| Secure git clone credentials: token via 0600 credential-store file (never argv, never `.git/config`), atomic target reservation, stderr scrubbing | `app.ts` clone route; `security.ts` | `security.test.ts` (clone block) + live smoke (zero residue) |
| Rate limits (600 req/min, 10 clones/min) and ceilings (≤2 concurrent clones, ≤4 active runs, 1 MiB bodies) | `security.ts` `RateLimiter`; `app.ts` | `security.test.ts` (rate limiting + run ceiling) |
| Approval failures return HTTP 500 (never `ok:true` over a broken dispatch) | `app.ts` approve route | `packages/server/test/runtime-correctness.test.ts` |
| Background dispatch failures force-fail the run (FATAL) and are counted in `/api/health` | `projects.ts` `track()` | `runtime-correctness.test.ts` |
| Terminal runtimes are unregistered after background settle (disk keeps serving) | `projects.ts` `watchForTerminal` | `runtime-correctness.test.ts` |
| WS replay→live handoff without loss or duplication (subscribe-first bridge) | `packages/server/src/ws-replay.ts` | `runtime-correctness.test.ts` (bridge block) |
| Idempotency keys on approve/reject/abort/resume (replay original 200) | `app.ts` | `runtime-correctness.test.ts` |
| Explicit recovery degradation: corrupt event lines counted, corrupt `state.json` → 500 `{degraded}`, unpersisted events flagged | `event-log.ts`; `app.ts` | `runtime-correctness.test.ts` (degradation block) |
| TS-AST code metrics with analyzer labels (`ts-ast` / `regex-heuristic`) | `adapters/src/tools/code-metrics.ts` | `packages/adapters/test/analysis.test.ts` |
| Import graph via TypeScript module resolution (tsconfig paths, dynamic imports, export-from); regex fallback labeled | `adapters/src/tools/import-graph.ts` | `analysis.test.ts` |
| LLM findings validated against the file snapshot (hallucinated locations rejected; unverifiable evidence demoted) | `agents/src/shared/findings.ts` | `packages/agents/test/finding-validation.test.ts` |
| Content fingerprints for finding dedupe (not title matching) | `agents/src/shared/findings.ts` | `finding-validation.test.ts` |
| Opt-in git initialization for git-less projects (baseline commit, local identity, nothing existing modified) | `adapters` `GitTool.initBaseline`; `run-manager.ts` | `packages/server/test/open-project.test.ts` |

## Partially implemented (known gaps — do not rely on the missing part)

- **WebSocket authentication** — the token reaches `/ws` via query param and
  the auth hook; the in-handler re-check exists, but no test drives a real
  socket upgrade (contract SEC-04).
- **Secret redaction** — clone credentials never reach argv/`.git/config`
  and stderr is scrubbed, but the central logger has no redaction pass
  (contract SEC-10/DAT-03) and file contents sent to providers are not
  redacted (DAT-02).
- **Event durability** — an append that fails disk write still reaches live
  subscribers; it is now *counted and surfaced* (`persistenceFailures`,
  `replayDegraded`) instead of silent, but the seq can still be reused after
  restart (contract REL-03/04 target: persist-before-publish).
- **Interrupted-run detection** — a crash mid-run still reloads as
  `running` (contract REL-08); `/open` auto-resumes it, which is recovery by
  optimism, not by proof.
- **Idempotency cache is in-memory** — replay works within one server
  process lifetime only; cross-restart duplicates rely on the phase guard's
  409 (contract REL-01 target: atomic, persisted keys).
- **Single writer per run** — no run lock; server and CLI can open the same
  run concurrently (contract REL-14).
- **Execution policy for repo commands** — repo test/build commands still
  execute on the host by default; no approval policy (contract SEC-12).
- **Verification fail-closed** — with no decision provider routed, the
  fallback can still auto-pass a gate (contract SAFE-10; the contract's
  fail-closed target is not implemented).
- **Engineer write containment** — `path.join` without resolved-path
  containment in the engineer's write closure (contract SAFE-02).
- **Cumulative firewall violations** — the violation counter resets per
  attempt (contract SAFE-16).
- **Graceful shutdown** — no signal handling; Ctrl-C can interrupt a
  cherry-pick on the user's branch (contract REL-13/SAFE-15).
- **Resource limits** — several TBD values remain (contract §5); what exists
  (clone/run ceilings, timeouts, body limit) is tested, the rest is
  unbounded.
- **Folder browser breadth** — `/api/fs/browse` can list any directory on
  the machine. It is authenticated and is the project picker's core feature;
  constrained browse roots remain a contract target (SEC-06).

## Not yet verified (claims from design, no covering test)

- Restart-recovery correctness beyond the happy path (kill-mid-run,
  kill-mid-landing — contract GATE-07).
- Behavior preservation on real repositories with real models (all E2E tests
  run scripted test doubles; real-provider smoke is manual:
  `scripts/smoke-real-providers.mjs`).
- Windows child-process tree termination (`.cmd` shims may orphan
  grandchildren — contract REL-12).
- Cost estimation, metrics, readiness probes, diagnostics bundles
  (contract OBS-03/05/07, RES-13 — planned, not built).

## Operational limitations (standing)

- Node ≥ 20, git on PATH; pnpm 9 workspace.
- All run state under `~/.vibefix` (`VIBEFIX_HOME`); target repos are read
  pre-approval except two documented exceptions (contract SAFE-001:
  `core.longpaths` git-config write, shared `node_modules` junction).
- LLM keys from the environment only; analysis runs keyless, code
  modification requires a routed real model (mocks are test-only).
- No retention/sweep: runs, worktrees and clones accumulate until deleted
  manually (contract DAT-05).

## Debugging aids

```bash
pnpm verify                         # full chain CI runs
curl http://127.0.0.1:8630/api/health   # liveness + activeRuntimes + backgroundFailures
```

API token: `VIBEFIX_API_TOKEN` env or `~/.vibefix/server-token` (delete to
rotate; the Vite dev proxy injects it automatically). See README "Security
model" and `.env.example` for every knob.
