# VibeFix

**A local-first, multi-agent refactoring control plane for vibe-coded repositories.**

VibeFix does not "one-shot fix" your code. It runs a deterministic pipeline of narrow,
single-responsibility agents whose prime directive is **behavior preservation**:

> Understand → Preserve → Improve → Verify → Explain

Nothing touches your code until you approve it. Every change is a structured
Change Proposal, implemented in an isolated git worktree behind a Change Firewall,
and only lands after an independent verification pool proves it preserved behavior.

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
never used for run data; VibeFix only reads it, and writes only through firewalled
worktrees you approved. API keys go in `.env` at the VibeFix root (gitignored).

Open http://localhost:5173, point it at any git repository (clean working tree),
pick a mode, and watch the agent graph run. Analysis runs deterministically without
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
- **Pure reducer orchestrator** — control flow is a testable transition table.
- **Single writer** — only the Engineer modifies code, only inside `git worktree` sandboxes.
- **Change Firewall** — writes outside `filesInScope` (or into lockfiles / `protectedPaths` / forbidden zones) are blocked; 2 violations = auto-reject.
- **Fresh-context verification pool** — Behavior + Principle + Regression never see the Engineer's reasoning.
- **Budgeted retries** — a change failing twice is deferred, never forced.
- **User checkpoint** — execution starts only after you approve the backlog.

---

## Configuring models

Keys from environment (never persisted):

- `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / Ollama at `http://localhost:11434`
- `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY` (Jev) for decision agents

Per-project routing: `~/.vibefix/projects/<key>/config.json` or ⚙ Settings in the UI.

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
