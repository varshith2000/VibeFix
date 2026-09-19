# VibeFix

**A local-first, multi-agent refactoring control plane for vibe-coded repositories.**

VibeFix does not "one-shot fix" your code. It runs a deterministic pipeline of narrow,
single-responsibility agents whose prime directive is **behavior preservation**:

> Understand → Preserve → Improve → Verify → Explain

Nothing touches your code until you approve it. Every change is a structured
Change Proposal, implemented in an isolated git worktree behind a Change Firewall,
and only lands after independent fresh-context verification proves it preserved behavior.

---

## Quick start (zero API keys)

```bash
pnpm install
pnpm build

# terminal 1 — control plane
pnpm dev:server          # http://127.0.0.1:8630

# terminal 2 — UI
pnpm dev:ui              # http://localhost:5173
```

**Where things live:** run state, worktrees, cloned GitHub repos and per-project config
all live in a central workspace — `~/.vibefix` (override with the
`VIBEFIX_HOME` env var). Your project folder is never used for run data; VibeFix only ever
reads it, and writes only through firewalled worktrees you approved. API keys go in `.env`
at the VibeFix root (gitignored, auto-loaded).

Open http://localhost:5173, point it at any git repository (clean working tree),
pick a mode, and watch the agent graph run. Add your API keys to `.env` first —
VibeFix is **real-models-only**: analysis runs deterministically without keys,
but the engineer refuses to touch code until a real model (Gemini, Anthropic,
OpenAI or local Ollama) is routed in ⚙ Settings. Nothing is ever faked.

A demo fixture was generated during development at `D:\tmp-vibefix-demo` — or make a fresh one:

```bash
node -e "import('./packages/fixture-repo/dist/index.js').then(m => m.createFixtureRepo('./my-mess', { profile: 'small-mess' }))"
```

### Headless

```bash
node packages/cli/dist/main.js run <repoPath> --mode minimal --yes
```

---

## The 10 agents

| # | Agent | Kind | Job |
|---|---|---|---|
| 1 | Cartographer | Text | Maps files, languages, frameworks, entrypoints, import graph |
| 2 | Test Surveyor | Text | What safety net exists? Can it build/test? |
| 3 | Smell Detector | Text | Duplication, long functions, god files (deterministic metrics) |
| 4 | Architecture Auditor | Text | Cycles, fan-in/fan-out extremes, layering violations |
| 5 | Risk Assessor | **Decision** | Calibrated risk score per finding; declares do-not-touch zones |
| 6 | Synthesis | **Decision** | Merges findings → prioritized Remediation Backlog |
| 7 | Harness Builder | Text | Pins current behavior: public API surface + suite baseline |
| 8 | Refactoring Engineer | Text | **The only writer.** One proposal per attempt, firewalled worktree |
| 9 | Behavior Verifier | **Decision** | Deterministic gates + fresh-context adjudication |
| 10 | Docent | Text | The report: what changed, what did NOT change, what you learn |

**Decision agents are TypedDecision calls** (structured choice/score answers, no prose) —
routed to Jev by TypeSafe AI, with OpenRouter as fallback. Generative agents route to
Gemini / Anthropic / OpenAI / Ollama. There are no mock providers in the product:
unavailable providers degrade to deterministic analysis, and the engineer refuses
rather than making placeholder edits.

## Orchestration guarantees

- **Evidence Store, not chat** — agents communicate only via versioned JSON artifacts in `<repo>/.vibefix/runs/<runId>/`. Auditable, resumable, debuggable.
- **Pure reducer orchestrator** — the whole control flow is a testable transition table (`packages/core/src/orchestrator/reducer.ts`).
- **Single writer** — only the Engineer modifies code, only inside `git worktree` sandboxes; pass = one cherry-picked commit, fail = worktree discarded, user branch never dirtied.
- **Change Firewall** — writes outside `filesInScope` (or into lockfiles/manifests/forbidden zones) are blocked in code; 2 violations = auto-reject.
- **Fresh-context reviewers** — the Verifier structurally never receives the Engineer's reasoning, only diff + proposal + baseline.
- **Budgeted retries** — a change failing twice is deferred with reasons, never forced.
- **User checkpoint** — execution starts only after you approve the backlog and pick a mode (Minimal / Architecture / Modernization).

## Configuring real models

Edit `<repo>/.vibefix/config.json` (or PUT `/api/projects/:enc/config`). Keys are read
from environment variables — never persisted:

- `ANTHROPIC_API_KEY` → providers.anthropic.enabled = true, route agents to it
- `OPENAI_API_KEY` / Ollama at `http://localhost:11434`
- `TYPESAFE_API_KEY` (Jev) or `OPENROUTER_API_KEY` → decision agents

Route any agent to any provider per-agent under `routes`.

## Repository layout

```
packages/
  schemas/    zod contracts for every artifact (RunState, Finding, ChangeProposal, ...)
  llm/        TextGeneration + TypedDecision interfaces; anthropic/openai/gemini/ollama/jev/openrouter adapters
  adapters/   deterministic tools: fs facts, language detect, import graph, git, test runner, metrics; Python sidecar seam
  core/       orchestrator reducer + runtime, evidence store, event log, budget, worktrees, firewall
  agents/     the 10 agents + executor implementing core's port
  server/     Fastify REST + WebSocket; composition root
  ui/         Vite + React + React Flow agent graph, checkpoint, findings, ledger, report
  cli/        vibefix serve | run | clean
  fixture-repo/  deterministic messy repos for tests
```

Dependency rule: `core` never imports `agents`/`llm`/`adapters` — the server is the
composition root. `ui` depends on nothing but its own wire types.

## Tests

```bash
pnpm test    # 31 tests: reducer transition table, firewall matrix, schema round-trip, full E2E over a fixture repo
```
