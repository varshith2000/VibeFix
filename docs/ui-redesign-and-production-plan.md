# VibeFix UI redesign and production plan

Date: 2026-10-22  
Branch: `UI-changes` (Git does not allow spaces in branch names)  
Status: local, uncommitted working changes

## Executive summary

VibeFix already has the core behavior of a serious local-first refactoring
control plane: a reducer-driven pipeline, isolated worktrees, a human
checkpoint, event replay, findings validation, and a broad security test
suite. The main product gap is not missing capability in the UI; it is the
way that capability is presented. The existing screen is dense and tool-like,
with equal visual weight for navigation, telemetry, and decision points.

This pass moves the UI toward a focused “control room” experience inspired by
the reference short: dark full-height focus, compact status/navigation, a
clear active surface, and an always-visible live activity rail. Functional
components and API behavior are preserved.

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

## Product issues and recommended fixes

### P0 — required before external users

1. **Production gate is still open.** The repository guide explicitly says the
   application is not production-ready; GATE-14 remains the arbiter. Close the
   remaining contract gates with named owners and proving tests before making
   readiness claims.
2. **Restart recovery needs kill-mid-run and kill-mid-landing tests.** The
   durable machinery exists, but the highest-risk recovery paths are still
   listed as unverified. Add process-level tests that terminate the server at
   each landing stage and assert safe recovery.
3. **Secret redaction needs an end-to-end canary.** Plant versioned credential
   patterns in provider errors, event lines, state, evidence, and reports;
   assert that no persisted artifact contains the secret.
4. **Primary-tree invariance needs failure injection.** Prove that failed
   worktree creation, engineer writes, and landing recovery leave the primary
   checkout unchanged, including Git config and dependency directories.
5. **Resource limits and retention are incomplete.** Decide and enforce the
   remaining RES/DAT values, add sweep/retention controls, and expose clear
   operator diagnostics when limits are reached.

### P1 — required for a reliable beta

1. Add a multi-root browse policy UI and symlink-specific browse tests.
2. Finish graceful-shutdown tests for SIGINT/SIGTERM during active runs and
   cherry-pick recovery.
3. Add readiness, diagnostics bundle, cost estimate, and metrics endpoints;
   show them in the Health view instead of making operators infer state from
   the event stream.
4. Add real-provider smoke tests in a controlled environment. Keep scripted
   doubles for deterministic CI, but verify routing, redaction, timeouts, and
   provider failure behavior with real integrations before beta release.
5. Re-score the full acceptance-criteria matrix and assign GATE-13 owners.

### P2 — product polish and scale

1. Add responsive mobile/tablet layouts. The current control surface is
   desktop-first and should collapse the event rail into a drawer.
2. Add onboarding copy, empty states, accessible icon labels, and a guided
   “first run” tour based on the included demo.
3. Add export/share controls for reports and evidence, with explicit redaction
   confirmation before export.
4. Add run search/filtering, project history, and retention controls as the
   number of local runs grows.
5. Add visual regression coverage for the UI at desktop, narrow desktop, and
   mobile breakpoints.

## Suggested release sequence

1. **Hardening:** close P0 contract gates and verify `pnpm verify` on both CI
   operating systems.
2. **Operator beta:** complete P1 observability, recovery, and real-provider
   smoke coverage; ship to a small trusted group.
3. **Usability:** run onboarding sessions using `demo.html`, fix confusing
   state transitions, and add visual regression tests.
4. **Wider rollout:** publish a supported deployment guide, recovery runbook,
   retention defaults, and explicit security scope.

## Verification checklist for this change

- [ ] `pnpm --filter @vibefix/ui typecheck`
- [ ] `pnpm --filter @vibefix/ui build`
- [ ] Open the built `demo.html` and run the walkthrough.
- [ ] Verify the live app still reaches the checkpoint and report views.
- [ ] Run the full repository `pnpm verify` before merging.

This document intentionally does not call the project production-ready. That
label belongs only to the contract’s green GATE-14 outcome.
