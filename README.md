# VibeFix

**A local-first, multi-agent refactoring control plane for vibe-coded repositories.**

> **Status (2026-09-29):** early development — **not production-ready**. The API
> requires a bearer token and binds loopback-only by default (see "Security model"
> below), but known reliability and safety gaps remain. The repair program
> (Phases 1–5) is complete — see `docs/PHASES.md`; the enforceable contract and
> its current state live in `docs/production-contract.md` (v3.1).

VibeFix does not "one-shot fix" your code. It runs a deterministic pipeline of narrow,
single-responsibility agents whose prime directive is **behavior preservation**:

> Understand → Preserve → Improve → Verify → Explain

Before approval, VibeFix makes no tracked-file changes in your repository (it does set
one git setting, `core.longpaths`, and shares your `node_modules` with worktrees — see
the contract, SAFE-001). Every change is a structured Change Proposal, implemented in a
dedicated git worktree behind a Change Firewall, and lands only after a structurally
blinded verification pool **checks** it for behavior drift (deterministic gates plus an
LLM diff review — "checks", not "proves"; with no test suite or decision model routed,
a run is marked not-verified and nothing lands).

---

## Quick start

```bash
pnpm install
pnpm build

# terminal 1 — control plane
pnpm dev:server          # http://127.0.0.1:8630

# terminal 2 — UI
pnpm dev:ui              # http://localhost:5173
```

**Where things live:** run state, worktrees, cloned GitHub repos and per-project config
all live under `~/.vibefix` (override with `VIBEFIX_HOME`). Your project folder is
never used for run data. Before approval VibeFix only reads it — with two exceptions:
one git config entry (`core.longpaths`) and a `node_modules` junction shared with
worktrees; after approval, changes land only through the verified worktree path, and
the baseline test run may write normal build/test caches. API keys go in `.env` at the
VibeFix root (gitignored).

Open http://localhost:5173, point it at any git repository (clean working tree),
pick a mode, and watch the agent graph run. Folders with no git trace work too:
VibeFix offers to initialize a repository (one baseline commit of the current
contents — nothing existing is modified) so the worktree safety machinery has
something to branch from. Analysis runs deterministically without
keys; the engineer refuses to touch code until a real model is routed in ⚙ Settings.

### Headless

```bash
node packages/cli/dist/main.js run <repoPath> --mode minimal --yes
```

---

## The agent roster (16)

| # | Agent | Pool / phase | Job |
|---|---|---|---|
| 1 | Cartographer | recon | Maps files, languages, frameworks, entrypoints, import graph |
| 2 | Historian | recon | Product Intent Document from git history + README |
| 3 | Test Surveyor | recon | What safety net exists? Can it build/test? |
| 4 | Smell Detector | diagnosis | Duplication, long functions, god files |
| 5 | Architecture Auditor | diagnosis | Cycles, fan-in/fan-out, layering violations |
| 6 | Consistency Sentinel | diagnosis | Mixed patterns, naming, error-handling drift |
| 7 | Security | diagnosis | Secrets, injection sinks, sensitive logging (informational) |
| 8 | Risk Assessor | sequential | Calibrated risk + do-not-touch zones |
| 9 | Synthesis | sequential | Merges findings → Remediation Backlog |
| 10 | Minimality | sequential | Anti-overengineering gate before your checkpoint |
| 11 | Harness Builder | sequential | Pins public API surface + suite baseline |
| 12 | Refactoring Engineer | execution | **The only writer.** One proposal, firewalled worktree |
| 13 | Behavior Verifier | verification | Deterministic gates + fresh-context adjudication |
| 14 | Principle Reviewer | verification | Devil's advocate: minimal + principle-aligned? |
| 15 | Regression Sentinel | verification | Build / typecheck / lint / suite vs baseline |
| 16 | Docent | report | What changed, what did NOT change, what you learn |

**Modes:** Minimal (smallest diffs) · Architecture (boundary moves) · Modernization (larger scope).

---

## Orchestration guarantees

- **Evidence Store, not chat** — agents communicate only via versioned JSON under `~/.vibefix/projects/<key>/runs/<runId>/`.
- **Deterministic reducer orchestrator** — control flow is a testable transition table (timestamps excluded from equality).
- **Single writer** — only the Engineer modifies code, only inside `git worktree` sandboxes.
- **Change Firewall** — writes outside `filesInScope` (or into lockfiles / `protectedPaths` / forbidden zones) are blocked; 2 violations **within one attempt** = auto-reject of that attempt (cumulative per-proposal counting is planned).
- **Fresh-context verification pool** — Behavior + Principle + Regression never see the Engineer's reasoning.
- **Budgeted retries** — each change gets 3 attempts (1 initial + 2 retries); after that it is deferred, never forced.
- **User checkpoint** — execution starts only after you approve the backlog.

---

## Configuring models

Keys from environment — LLM provider keys are never persisted. GitHub clone tokens
travel through a 0600 git-credential-store file that is deleted immediately after
the clone (never in the `git clone` argv, never in the clone's `.git/config`):

- `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / Ollama at `http://localhost:11434`
- `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY` (Jev) for decision agents

Per-project routing: `~/.vibefix/projects/<key>/config.json` or ⚙ Settings in the UI.

---

## Security model

VibeFix's API reads your filesystem and drives code modification, so the boundary
is deliberately tight (risks doc, Phase 2 — all enforced by tests in
`packages/server/test/security.test.ts`):

- **Loopback-only by default** (`VIBEFIX_HOST` defaults to `127.0.0.1`). Binding a
  non-loopback interface refuses to start unless BOTH `VIBEFIX_ALLOW_REMOTE=1` and
  an explicit `VIBEFIX_API_TOKEN` (≥16 chars) are set.
- **Bearer-token authentication** on every endpoint except `GET /api/health`. The
  token comes from `VIBEFIX_API_TOKEN` or is generated once and stored (0600) at
  `~/.vibefix/server-token` — the Vite dev/preview proxy reads that file and
  injects the header, so the browser never knows the token. Delete the file to
  rotate. WebSockets accept `?token=` since browsers cannot set headers there.
- **Origin enforcement + restricted CORS** — only the configured UI origins
  (default `http://localhost:5173` / `127.0.0.1:5173`, override with
  `VIBEFIX_UI_ORIGIN`) may call the API; requests carrying any other `Origin`
  are refused (DNS-rebinding / CSRF defense). Non-browser clients send no Origin
  and pass.
- **Project-scoped run URLs** — every run endpoint is
  `/api/projects/:enc/runs/:runId/...` and the server verifies the run belongs
  to that project; run IDs are shape-validated (no path traversal).
- **Path containment by `path.relative`**, never string prefixes (the
  `project` vs `project-secrets` collision), with symlink resolution and
  re-checking.
- **Rate limits & ceilings** — 600 req/min per client globally, 10 clones/min,
  max 2 concurrent clones, max 4 concurrent active runs
  (`VIBEFIX_MAX_ACTIVE_RUNS`), 1 MiB request bodies.
- **Clone URL allowlist** — HTTPS GitHub only by default; extra hosts via
  `VIBEFIX_CLONE_HOSTS`. URLs with embedded credentials are rejected.

The local folder browser (`/api/fs/browse`) can still browse the whole disk —
that is its job as the project picker; the bearer token is the boundary that
keeps it local-user-only.

---

## Repository layout

```
packages/
  schemas/    zod contracts (RunState, Finding, ChangeProposal, ProductIntent, ...)
  llm/        TextGeneration + TypedDecision; provider adapters
  adapters/   deterministic tools: fs, imports, git, tests, metrics
  core/       orchestrator, evidence store, firewall, worktrees
  agents/     the 16 agents + executor
  server/     Fastify REST + WebSocket
  ui/         Vite + React control plane (pipeline, health, findings, checkpoint, report)
  cli/        vibefix serve | run | clean
  fixture-repo/  deterministic messy repos for tests
```

---

## Tests

```bash
pnpm test    # reducer, firewall, schema round-trip, full E2E over a fixture repo
```

## Verification

The full verification chain (what CI runs on every push and pull request —
`.github/workflows/ci.yml`, Ubuntu and Windows):

```bash
pnpm verify   # install --frozen-lockfile && typecheck && test && build
```

`pnpm typecheck` covers every package, including the UI (which is excluded from
the root `tsc -b` project graph because it is a non-composite Vite project — it
has its own `typecheck` script that the root script invokes). Do not treat a
change as verified until `pnpm verify` is green from a clean checkout.

