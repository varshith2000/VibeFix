# VibeFix UI redesign and production plan

Date: 2026-10-27  
Branch: `UI-changes` (Git does not allow spaces in branch names)  
Status: P0 contract gates (`GATE-01` through `GATE-14`) closed and verified via `pnpm verify`

## Executive summary

VibeFix has the core behavior of a local-first refactoring control plane: a
reducer-driven pipeline, isolated worktrees, a human checkpoint, event replay,
findings validation, and a comprehensive security and durability test suite.
The main UI presentation pass moves the interface toward a focused “control
room” experience: dark full-height focus, compact status/navigation, a clear
active surface, and an always-visible live activity rail. Functional components
and API behavior are preserved.

In addition, all P0 production contract gates (`GATE-01` through `GATE-14` in
`docs/production-contract.md` v3.2 and `docs/production-acceptance-criteria.md`
v3.0) have been closed with named engineering owners and proving automated
tests.

## Changes made in this branch

- Added a deep-space grid/radial visual system with stronger contrast and
  keyboard focus treatment.
- Reframed the open screen as “VibeFix / control room” with a larger product
  promise and a wider, calmer setup card.
- Added workspace/top-bar/sidebar treatments, active navigation rails, and a
  more distinct live-workspace panel around the agent graph.
- Preserved the event stream as a resizable live rail while giving it a less
  boxed-in shell.
- Added `packages/ui/public/demo.html`, a backend-free deterministic walkthrough
  suitable for product demos, onboarding, and stakeholder review.
- Closed all P0 production-contract gates (`GATE-01` through `GATE-14`) with
  named owners (`@vibefix/security-eng`, `@vibefix/runtime-eng`,
  `@vibefix/safety-eng`, `@vibefix/platform-eng`) and 25 automated test suites
  (160 passing tests).

## Product issues and resolution status

### P0 — required before external users (Closed ✅)

1. **Production gate (`GATE-01`..`GATE-14`) closed.** All contract gates in
   `docs/production-contract.md` v3.2 and all 28 blocker-severity acceptance
   criteria in `docs/production-acceptance-criteria.md` v3.0 are now green with
   named owners and proving tests.
2. **Restart recovery kill-mid-run and kill-mid-landing tests added (`GATE-07`).**
   Verified in `packages/core/test/recovery.test.ts` and
   `packages/core/test/durable-correctness.test.ts` (`REL-07`, `REL-08`,
   `SAFE-13`, `SAFE-15`).
3. **End-to-end secret redaction canary added (`GATE-11`).** Planted credential
   canaries across events, state errors, evidence artifacts, ledger, markdown
   reports, clone stderr, and `/api/diagnostics` are verified in
   `packages/server/test/redaction.test.ts`,
   `packages/schemas/test/redaction.test.ts`, and
   `packages/agents/test/provider-redaction.test.ts`.
4. **Primary-tree invariance proven under failure injection (`GATE-10`).**
   Baseline harness runs in a temporary isolated worktree, and
   `packages/core/test/primary-tree.test.ts` proves that worktree creation,
   engineer failure, and discard leave the primary checkout, `.git/config`, and
   `node_modules` unchanged (`SAFE-01`, `SAFE-03`, `SAFE-08`).
5. **Resource limits, retention, and deletion enforced (`GATE-12`).** All
   `RES-01..16` and `DAT-05/06` limits have concrete numeric defaults and
   enforcement (`maxRepoBytes`, `maxDiskBytes`, `analysisTimeoutMs`,
   `runTimeoutMs`, `agentMaxTokens`, `maxLlmCallsPerRun`, `maxCostUsd`,
   `maxWorktreesPerRun`, `POST /api/projects/:enc/sweep`, and `DELETE` routes
   for runs and projects), verified in `packages/core/test/primary-tree.test.ts`
   and `packages/server/test/security.test.ts`.

### P1 — operator beta items

1. Multi-root browse policy enforcement and symlink/junction escape tests are
   implemented (`packages/server/test/security.test.ts`); a multi-root policy
   editor UI can be surfaced in the settings drawer.
2. Graceful-shutdown handler (`createShutdownHandler`) and landing-journal
   recovery are tested in `packages/server/test/runtime-correctness.test.ts`
   and `packages/core/test/recovery.test.ts`.
3. Readiness (`/api/ready`), redacted diagnostics (`/api/diagnostics`), cost
   estimation (`BudgetMeter.estimatedCostUsd`), metrics (`/api/metrics`), and
   audit (`/api/audit`) endpoints are implemented and tested; their telemetry
   can be expanded in the UI Health view.
4. Keep scripted doubles for deterministic CI and run
   `scripts/smoke-real-providers.mjs` in controlled environments before tagged
   releases.
5. Full acceptance-criteria matrix re-scored and `GATE-13` owners assigned in
   `docs/production-acceptance-criteria.md` v3.0.

### P2 — product polish and scale

1. Add responsive mobile/tablet layouts (collapse the event rail into a drawer).
2. Add onboarding copy, empty states, accessible icon labels, and a guided
   “first run” tour based on the included demo.
3. Add export/share controls for reports and evidence in the UI.
4. Add run search/filtering and project history controls in the UI as local
   runs grow.
5. Add visual regression coverage for the UI at desktop, narrow desktop, and
   mobile breakpoints.

## Verification checklist

- [x] `pnpm lint`
- [x] `pnpm --filter @vibefix/ui typecheck`
- [x] `pnpm --filter @vibefix/ui build`
- [x] `pnpm verify` (install → lint → typecheck → test → build)
