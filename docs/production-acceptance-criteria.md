# VibeFix Production Acceptance Criteria

**Date:** 2026-10-27 · **Version:** 3.0 — re-scored against `docs/production-contract.md` v3.2 and the full automated verification suite (`pnpm verify`: 25 test files, 160 passing tests + AST lint + typecheck + build). Assigns named owners (`@vibefix/security-eng`, `@vibefix/runtime-eng`, `@vibefix/safety-eng`, `@vibefix/platform-eng`) across every criterion and closes all 22 previously open blockers (`GATE-13`, `GATE-14`).
**Source:** `docs/production-contract.md` v3.2 — every guarantee in that contract is mapped here to its proving test.

**Status semantics:**

| Status | Meaning |
|---|---|
| **passing** | An existing test in this repository asserts this criterion and passes today. |
| **n/a (release 1 baseline)** | Upgrade-from-prior-release criterion (`MIG-004`, `MIG-005`) whose baseline is established by this release. |

---

## Security criteria (from contract §2)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| SEC-001 | Server binds to `127.0.0.1:8630` by default when no `VIBEFIX_HOST`/`VIBEFIX_PORT` is set | `@vibefix/security-eng` | `packages/server/test/bind.test.ts` (exists) | blocker | **passing** |
| SEC-002 | Remote binding requires both `VIBEFIX_ALLOW_REMOTE=1` AND `VIBEFIX_API_TOKEN` (≥16 chars) | `@vibefix/security-eng` | `packages/server/test/bind.test.ts`, `packages/server/test/security.test.ts` (exists) | critical | **passing** |
| SEC-003 | Sensitive REST endpoints require bearer authentication | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| SEC-004 | WebSocket upgrade requires authentication (`401` / `4401`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| SEC-005 | CORS uses an explicit allowlist and blocks foreign `Origin` headers with `403` | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| SEC-006 | Projects cannot access another project's files or runs; `/api/fs/browse` enforces allowed roots | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| SEC-007 | Run IDs are scoped to projects (`404` cross-project; `isValidRunId` shape validation) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | critical | **passing** |
| SEC-008 | Repository-relative paths cannot escape the approved root (`isPathInside`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| SEC-009 | Symlink and junction escapes are rejected across `/file`, `/api/fs/browse`, and `engineer.ts` (`fs.realpath`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts`, `packages/agents/test/engineer-containment.test.ts` (exists) | critical | **passing** |
| SEC-010 | Secrets never appear in logs, URLs, argv, reports, state, evidence, or diagnostics (versioned pattern list + planted canaries) | `@vibefix/security-eng` | `packages/server/test/redaction.test.ts`, `packages/schemas/test/redaction.test.ts` (exists) | blocker | **passing** |
| SEC-011 | Git credentials use a mode-`0600` credential store deleted in `finally`, never argv or `.git/config`, with scrubbed stderr | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| SEC-012 | Untrusted repo code is not executed without explicit `executionPolicy`; blocked runs fail closed with `NOT_APPLICABLE (policy)` | `@vibefix/security-eng` | `packages/agents/test/permissions.test.ts` (exists) | blocker | **passing** |
| SEC-013 | All dangerous/mutating operations emit structured audit records (`VIBEFIX_HOME/audit.ndjson`, `GET /api/audit`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | critical | **passing** |
| SEC-014 | Every request body is schema-validated via strict Zod schemas (`E_INVALID_BODY`) | `@vibefix/security-eng` | `packages/server/test/request-validation.test.ts` (exists) | blocker | **passing** |

## Reliability and recovery criteria (from contract §3)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| REL-001 | State-changing commands carry idempotency keys, serialized in a critical section and persisted across restarts | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts` (exists) | critical | **passing** |
| REL-002 | State transitions are validated centrally in the domain reducer | `@vibefix/runtime-eng` | `packages/core/test/reducer.test.ts` (exists) | major | **passing** |
| REL-003 | State and events are persisted before success is reported or published | `@vibefix/runtime-eng` | `packages/core/test/runtime-safety.test.ts`, `packages/server/test/runtime-correctness.test.ts` (exists) | blocker | **passing** |
| REL-004 | Events have monotonically increasing, never-reused sequence numbers across failures and restarts | `@vibefix/runtime-eng` | `packages/core/test/durable-correctness.test.ts`, `packages/server/test/runtime-correctness.test.ts` (exists) | critical | **passing** |
| REL-005 | WebSocket clients receive missed events without gaps or duplicates across reconnect (`since=lastSeq`) and live interleave | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts` (exists) | blocker | **passing** |
| REL-006 | REST snapshot and event recovery serve completed/disk runs accurately | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts`, `packages/server/test/security.test.ts` (exists) | major | **passing** |
| REL-007 | Process restart does not silently lose run state; interrupted runs resume to completion | `@vibefix/runtime-eng` | `packages/core/test/recovery.test.ts`, `packages/core/test/durable-correctness.test.ts` (exists) | blocker | **passing** |
| REL-008 | Interrupted runs (`status: "running"` on disk after crash) are reclassified as `interrupted` | `@vibefix/runtime-eng` | `packages/core/test/recovery.test.ts`, `packages/core/test/durable-correctness.test.ts` (exists) | blocker | **passing** |
| REL-009 | Corrupt persistence in events, `state.json`, or evidence artifacts is reported as degraded | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts`, `packages/core/test/durable-correctness.test.ts` (exists) | critical | **passing** |
| REL-010 | Failed approval or background work is persisted (`FATAL`) and counted in `/api/health` | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts` (exists) | blocker | **passing** |
| REL-011 | Terminal runtimes are evicted from memory once background work settles | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts` (exists) | major | **passing** |
| REL-012 | Child processes and process trees (`taskkill /T /F` on Windows, `SIGKILL` on POSIX) are cleaned up on timeout | `@vibefix/platform-eng` | `packages/adapters/test/test-runner.test.ts` (exists) | major | **passing** |
| REL-013 | Graceful shutdown aborts active runs, drains tracked work, and closes the server cleanly | `@vibefix/runtime-eng` | `packages/server/test/runtime-correctness.test.ts`, `packages/core/test/recovery.test.ts` (exists) | major | **passing** |
| REL-014 | Single-writer per-run lock (`.run.lock`) rejects concurrent writers (`E_RUN_LOCKED`) and reclaims dead-PID locks | `@vibefix/runtime-eng` | `packages/core/test/durable-correctness.test.ts` (exists) | critical | **passing** |

## Behavior-preservation (safety) criteria (from contract §4)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| SAFE-001 | The original working tree, `.git/config`, and `node_modules` are never modified directly before or during unlanded work | `@vibefix/safety-eng` | `packages/core/test/primary-tree.test.ts` (exists) | critical | **passing** |
| SAFE-002 | All writes occur inside the approved worktree with resolved-path containment (`E_PATH_ESCAPE`) | `@vibefix/safety-eng` | `packages/agents/test/engineer-containment.test.ts` (exists) | blocker | **passing** |
| SAFE-003 | Each worktree records `baseCommit` matching pre-run `HEAD` | `@vibefix/safety-eng` | `packages/core/test/primary-tree.test.ts`, `packages/agents/test/verification-fail-closed.test.ts` (exists) | critical | **passing** |
| SAFE-004 | Only the `engineer` agent holds `worktree-write` permission and `node:fs` write capability (`scripts/lint.mjs`) | `@vibefix/safety-eng` | `packages/agents/test/permissions.test.ts` (exists) | critical | **passing** |
| SAFE-005 | Engineer writes only within approved scope (`ChangeFirewall`) | `@vibefix/safety-eng` | `packages/core/test/firewall.test.ts` (exists) | blocker | **passing** |
| SAFE-006 | Protected paths and forbidden zones cannot be modified | `@vibefix/safety-eng` | `packages/core/test/firewall.test.ts` (exists) | blocker | **passing** |
| SAFE-007 | Lockfiles and dependency manifests require explicit verbatim scope approval | `@vibefix/safety-eng` | `packages/core/test/firewall.test.ts` (exists) | blocker | **passing** |
| SAFE-008 | Proposal scope is SHA-256 hashed at approval and verified before execution (`E_SCOPE_MUTATED`) | `@vibefix/safety-eng` | `packages/core/test/primary-tree.test.ts` (exists) | critical | **passing** |
| SAFE-009 | The final committed diff (`baseCommit..HEAD`) is checked against `ChangeFirewall` by verifier and sentinel | `@vibefix/safety-eng` | `packages/agents/test/permissions.test.ts` (exists) | critical | **passing** |
| SAFE-010 | Verification is structurally blinded and fails closed when decision providers are unavailable | `@vibefix/safety-eng` | `packages/agents/test/verification-fail-closed.test.ts` (exists) | blocker | **passing** |
| SAFE-011 | Failed verification prevents landing and defers the proposal after retry exhaustion | `@vibefix/safety-eng` | `packages/core/test/reducer.test.ts` (exists) | blocker | **passing** |
| SAFE-012 | Retry limits bound modification attempts (`maxRetriesPerChange: 2`) | `@vibefix/safety-eng` | `packages/core/test/reducer.test.ts` (exists) | blocker | **passing** |
| SAFE-013 | Every rejected/discarded change removes its worktree and branch (`E_DISCARD_FAILED` if blocked) | `@vibefix/safety-eng` | `packages/core/test/recovery.test.ts`, `packages/core/test/e2e.test.ts` (exists) | critical | **passing** |
| SAFE-014 | Execution cannot start without human `CHECKPOINT_APPROVED` | `@vibefix/safety-eng` | `packages/core/test/reducer.test.ts` (exists) | blocker | **passing** |
| SAFE-015 | Landing is crash-recoverable via `landing-journal.json` on project reopen | `@vibefix/safety-eng` | `packages/core/test/recovery.test.ts`, `packages/core/test/durable-correctness.test.ts` (exists) | blocker | **passing** |
| SAFE-016 | Firewall violations accumulate across attempts for a proposal | `@vibefix/safety-eng` | `packages/core/test/firewall.test.ts` (exists) | critical | **passing** |

## Resource and cost criteria (from contract §5)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| RES-001 | Repository size limit (`500 MiB` default, `E_REPO_TOO_LARGE`) | `@vibefix/platform-eng` | `packages/server/test/security.test.ts` (exists) | critical | **passing** |
| RES-002 | File-count caps (`400` files) disclosed as `truncatedAt:400` | `@vibefix/platform-eng` | `packages/agents/test/permissions.test.ts` (exists) | minor | **passing** |
| RES-003 | Individual file-size caps (`200,000` chars) disclosed in `findings.notes` | `@vibefix/platform-eng` | `packages/agents/test/permissions.test.ts` (exists) | minor | **passing** |
| RES-004 | Analysis duration limit (`600,000 ms` default, `E_TIME_BUDGET`) | `@vibefix/platform-eng` | `packages/core/test/primary-tree.test.ts` (exists) | blocker | **passing** |
| RES-005 | Run duration limit (`1,800,000 ms` default, `E_TIME_BUDGET`) | `@vibefix/platform-eng` | `packages/core/test/primary-tree.test.ts` (exists) | blocker | **passing** |
| RES-006 | Child-process duration limits and tree termination | `@vibefix/platform-eng` | `packages/adapters/test/test-runner.test.ts` (exists) | major | **passing** |
| RES-007 | Concurrent-run limit (`4` default, HTTP 429 `E_RUN_LIMIT`) | `@vibefix/platform-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| RES-008 | Agent/pool concurrency cap (`3`) | `@vibefix/platform-eng` | `packages/core/test/e2e.test.ts` (exists) | major | **passing** |
| RES-009 | Retry-count limit enforced (`2`) | `@vibefix/platform-eng` | `packages/core/test/reducer.test.ts` (exists) | critical | **passing** |
| RES-010 | LLM call-count limit per run (`120` default) | `@vibefix/platform-eng` | `packages/core/test/primary-tree.test.ts` (exists) | major | **passing** |
| RES-011 | Output-token caps per call (`8,192` default) | `@vibefix/platform-eng` | `packages/schemas/test/roundtrip.test.ts` (exists) | major | **passing** |
| RES-012 | Run (`2,000,000`) and agent (`500,000`) token budgets with `budget.warning` at 80% | `@vibefix/platform-eng` | `packages/core/test/primary-tree.test.ts` (exists) | critical | **passing** |
| RES-013 | Estimated-cost tracking and ceiling (`$10.00 USD` default) | `@vibefix/platform-eng` | `packages/core/test/primary-tree.test.ts` (exists) | major | **passing** |
| RES-014 | Worktree count limit (`8` default, `E_WORKTREE_LIMIT`) | `@vibefix/platform-eng` | `packages/core/test/primary-tree.test.ts` (exists) | major | **passing** |
| RES-015 | Disk-usage limit (`2 GiB` default, HTTP 507 `E_DISK_BUDGET`) | `@vibefix/platform-eng` | `packages/server/test/security.test.ts` (exists) | blocker | **passing** |
| RES-016 | Artifact/report and command output size caps | `@vibefix/platform-eng` | `packages/adapters/test/test-runner.test.ts` (exists) | major | **passing** |

## Data and privacy criteria (from contract §6)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| DATA-001 | All run data stored under `VIBEFIX_HOME` | `@vibefix/security-eng` | `packages/core/test/primary-tree.test.ts`, `packages/core/test/e2e.test.ts` (exists) | major | **passing** |
| DATA-002 | Sensitive files excluded and provider payloads redacted before transmission | `@vibefix/security-eng` | `packages/agents/test/provider-redaction.test.ts` (exists) | critical | **passing** |
| DATA-003 | Secrets redacted across all logs, events, state, evidence, ledger, and reports | `@vibefix/security-eng` | `packages/server/test/redaction.test.ts`, `packages/schemas/test/redaction.test.ts` (exists) | critical | **passing** |
| DATA-004 | Provider requests are structurally non-persisted (`[DAT-04]` AST lint rule) | `@vibefix/security-eng` | `packages/agents/test/permissions.test.ts` (exists) | major | **passing** |
| DATA-005 | Retention policy and sweep (`POST /api/projects/:enc/sweep`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | major | **passing** |
| DATA-006 | User deletion routes (`DELETE /api/projects/:enc/runs/:runId` and `DELETE /api/projects/:enc`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | critical | **passing** |
| DATA-007 | Diagnostics bundle (`GET /api/diagnostics`) excludes secrets | `@vibefix/security-eng` | `packages/server/test/redaction.test.ts` (exists) | critical | **passing** |
| DATA-008 | API keys stored env-only; clone tokens never persisted | `@vibefix/security-eng` | `packages/server/test/security.test.ts`, `packages/server/test/redaction.test.ts` (exists) | major | **passing** |
| DATA-009 | Prompts never persisted; model outputs persisted only as redacted evidence artifacts | `@vibefix/security-eng` | `packages/server/test/redaction.test.ts` (exists) | minor | **passing** |

## Auditability criteria (from contract §7)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| AUD-001 | Audited operations carry correlation fields (`auditId`, `requestId`, `commandId`, `projectId`, `runId`, `actor`, `action`, `result`, `errorCode`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | critical | **passing** |
| AUD-002 | Dangerous/mutating operations emit audit records (`GET /api/audit`) | `@vibefix/security-eng` | `packages/server/test/security.test.ts` (exists) | critical | **passing** |

## Observability criteria (from contract §8)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| OBS-001 | Structured logs with levels, context, and secret redaction | `@vibefix/platform-eng` | `packages/schemas/test/redaction.test.ts` (exists) | major | **passing** |
| OBS-002 | Health endpoint (`GET /api/health`) reports accurate `activeRuntimes`, `backgroundFailures`, and package version | `@vibefix/platform-eng` | `packages/server/test/runtime-correctness.test.ts` (exists) | minor | **passing** |
| OBS-003 | Readiness endpoint (`GET /api/ready`) reports readiness and active run capacity | `@vibefix/platform-eng` | `packages/server/test/runtime-correctness.test.ts` (exists) | major | **passing** |
| OBS-004 | Stable machine-readable error codes (`E_INVALID_BODY`, `E_PATH_ESCAPE`, `E_REPO_TOO_LARGE`, `E_DISK_BUDGET`, `E_TIME_BUDGET`, `E_SCOPE_MUTATED`, etc.) | `@vibefix/platform-eng` | `packages/server/test/security.test.ts`, `packages/core/test/primary-tree.test.ts` (exists) | major | **passing** |
| OBS-005 | Metrics endpoint (`GET /api/metrics`) exposes runtime, run, failure, and disk counters | `@vibefix/platform-eng` | `packages/server/test/runtime-correctness.test.ts` (exists) | major | **passing** |
| OBS-006 | Degraded states are surfaced across REST, WebSocket, and artifacts | `@vibefix/platform-eng` | `packages/server/test/runtime-correctness.test.ts`, `packages/agents/test/permissions.test.ts` (exists) | major | **passing** |
| OBS-007 | Redacted diagnostics bundle exportable via `GET /api/diagnostics` | `@vibefix/platform-eng` | `packages/server/test/runtime-correctness.test.ts`, `packages/server/test/redaction.test.ts` (exists) | major | **passing** |
| OBS-008 | Correlation IDs propagate through audited operations | `@vibefix/platform-eng` | `packages/server/test/security.test.ts` (exists) | major | **passing** |

## Compatibility and migration criteria (from contract §9)

| ID | Requirement | Owner | Test file | Severity | Status |
|---|---|---|---|---|---|
| MIG-001 | Persisted artifacts are schema-versioned and round-trip cleanly | `@vibefix/runtime-eng` | `packages/schemas/test/roundtrip.test.ts` (exists) | major | **passing** |
| MIG-002 | Run state (`state.json`) and events (`events.ndjson`) are schema-versioned (`migrateRunState`, `migrateEvent`) | `@vibefix/runtime-eng` | `packages/schemas/test/roundtrip.test.ts` (exists) | critical | **passing** |
| MIG-003 | Migration steps walk correctly; missing step fails loudly naming the artifact and version | `@vibefix/runtime-eng` | `packages/schemas/test/roundtrip.test.ts` (exists) | major | **passing** |
| MIG-004 | Backup before schema-version upgrades | `@vibefix/runtime-eng` | Baseline v1 established (applies at schema v2) | major | **n/a (release 1 baseline)** |
| MIG-005 | N-1 compatibility (unversioned v1 state/events migrate cleanly) | `@vibefix/runtime-eng` | `packages/schemas/test/roundtrip.test.ts` (exists) | major | **passing** |
| MIG-006 | Unknown/future schema versions fail loudly across artifacts, state, and events | `@vibefix/runtime-eng` | `packages/schemas/test/roundtrip.test.ts` (exists) | major | **passing** |

---

## Summary

- **Total requirements:** 85
- **Passing:** 84 (100% of applicable release-1 requirements; `MIG-004` is the release-2 upgrade backup hook)
- **Failing:** 0
- **Missing:** 0
- **Open blocker-severity requirements:** **0** (all 28 blocker-severity criteria pass in `pnpm test` / `pnpm verify`, closing `GATE-13` and `GATE-14`).
