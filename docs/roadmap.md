VibeFix production-grade roadmap
VibeFix has a strong core idea: deterministic repository facts, narrow agents, a single writer, isolated worktrees, human approval, and independent verification. The main work now is turning those design promises into enforced, tested, observable guarantees.

“Perfect” is not a realistic engineering target. A production-grade VibeFix should instead be:

Secure by default
Reproducible
Recoverable after crashes
Correct under concurrency
Safe around untrusted repositories and LLM output
Observable when something goes wrong
Testable from a clean checkout
Honest about what it has and has not verified
Bounded in cost, time, disk, memory, and model usage
The plan below assumes the first production target is a local-first desktop/server application for one user, with optional remote model providers. If you eventually want a multi-user hosted SaaS, additional tenant isolation and infrastructure will be required.

1. Define the production contract first
Before changing code, write a short formal document called:

text


docs/production-contract.md
It should define what the application promises.

1.1 Security contract
For the initial local-first product:

The server binds to 127.0.0.1 by default.
No remote network access is enabled by default.
Every sensitive API endpoint requires an authentication token, even locally.
The UI is the only allowed browser origin.
A project can access only its own repository and run data.
A run can access only its own worktree and evidence.
LLM providers never receive secrets, credentials, or files outside the approved context.
GitHub tokens never appear in command-line arguments, logs, error messages, or persisted artifacts.
Untrusted repository code is never executed on the host without explicit policy.
The application does not modify the user’s primary working tree automatically.
1.2 Reliability contract
Define precise guarantees:

Every accepted command has an idempotency key.
Every state transition is persisted before it is reported as successful.
Every event has a monotonically increasing sequence number.
The client can recover from any missed WebSocket event.
A process restart does not lose the logical run state.
Incomplete runs become interrupted, recoverable, or failed; they do not remain falsely running.
A failed approval cannot return HTTP success.
Terminal runtimes are released from memory.
Corrupt evidence is reported as degraded, not silently ignored.
1.3 Behavior-preservation contract
For every proposed change:

The original repository remains untouched until approval.
Changes happen only in a dedicated worktree.
The firewall blocks files outside the proposal scope.
Public API changes are detected.
Baseline tests and verification checks run before and after the change.
Independent verification does not rely on the engineer’s explanation.
Failed changes are rejected or deferred after a fixed retry limit.
The final report states what was changed and what was not verified.
1.4 Resource contract
Every run must have limits:

Maximum wall-clock duration
Maximum number of agents
Maximum retry count
Maximum LLM tokens
Maximum estimated cost
Maximum repository size
Maximum output artifact size
Maximum concurrent runs
Maximum clone size and duration
Maximum child-process runtime
Maximum disk usage
These limits should be enforced in code, not merely shown in documentation.

2. Freeze the architecture before adding features
The existing conceptual architecture is good. Keep it, but formalize the boundaries.

2.1 Recommended package boundaries
text


packages/
  schemas/
    public contracts and versioned persisted schemas

  domain/
    run state machine
    transition rules
    invariants
    authorization concepts

  core/
    evidence store
    event log
    worktrees
    change firewall
    lifecycle management

  adapters/
    filesystem
    git
    parser
    module resolution
    test/build runners
    process execution

  llm/
    provider interfaces
    routing
    retries
    circuit breaker
    usage and cost accounting
    redaction

  agents/
    read-only analysis agents
    planning agents
    writer
    verification agents
    report generator

  server/
    authentication
    authorization
    route modules
    websocket gateway
    request validation

  ui/
    server state
    event synchronization
    run views
    approval workflows

  cli/
    local commands
    diagnostics
    cleanup
    export/import

  test-fixtures/
    intentionally messy repositories
    malicious repositories
    large repositories
    failure scenarios
2.2 Refactor app.ts
The server file should not contain the entire application. Split it:

text


packages/server/src/
  app.ts
  main.ts
  auth/
    token-auth.ts
    permissions.ts
  routes/
    health.ts
    projects.ts
    repositories.ts
    runs.ts
    findings.ts
    artifacts.ts
    approvals.ts
  websocket/
    gateway.ts
    protocol.ts
    replay.ts
  policies/
    path-policy.ts
    resource-policy.ts
    origin-policy.ts
  errors/
    http-errors.ts
    error-handler.ts
app.ts should primarily compose plugins and routes.

This makes it easier to audit every endpoint and test each security boundary independently.

3. Phase 0: establish a clean verification baseline
Do this before implementing new features.

3.1 Fix the workspace scripts
The current setup must not allow a command to succeed while doing nothing.

At the root:

JSON


{
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "verify": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build",
    "verify:clean": "pnpm install --frozen-lockfile && pnpm verify"
  }
}
Every package should expose predictable scripts:

JSON


{
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
Do not rely only on pnpm -r typecheck unless every package actually has that script.

3.2 Make the build reproducible
Pin and verify:

Node.js version
pnpm version
TypeScript version
Vitest version
OS-specific behavior where relevant
Add:

text


.nvmrc
.tool-versions
and an engines field:

JSON


{
  "engines": {
    "node": ">=20.0.0 <23",
    "pnpm": ">=9 <11"
  },
  "packageManager": "pnpm@9.x"
}
Use a committed lockfile and CI installation:

Bash


pnpm install --frozen-lockfile
3.3 Clean generated artifacts
Decide whether dist, temporary runs, cloned repositories, and worktrees are:

Generated and ignored
Released as build artifacts
Committed intentionally
They should not be mixed ambiguously.

Add a clean-checkout test that verifies:

Bash


git clean -xfd
pnpm install --frozen-lockfile
pnpm verify
3.4 Add CI immediately
Minimum CI jobs:

text


quality:
  install
  typecheck
  lint
  format check
  unit tests
  build

integration:
  server tests
  WebSocket tests
  fixture-repository end-to-end tests

security:
  dependency audit
  secret scan
  path traversal tests
  credential redaction tests

packaging:
  CLI build
  production bundle
  smoke test
No feature is complete unless CI passes from a clean checkout.

4. Phase 1: secure the server and filesystem
This is the highest-priority phase.

4.1 Authentication
Generate a local installation token on first launch and store it with restrictive permissions.

For example:

text


~/.vibefix/auth/token
Requirements:

Token file permissions should be owner-only.
Never log the token.
Do not accept unauthenticated mutating endpoints.
Return generic authentication errors.
Support token rotation.
Expire or revoke tokens if the user requests it.
Require authentication for WebSocket connections as well as REST.
For a future hosted version, replace this with an actual identity provider and session model.

4.2 Authorization
Define permissions explicitly:

text


project:read
project:write
run:read
run:start
run:approve
run:abort
artifact:read
repository:read
repository:clone
admin:maintenance
Every handler must verify:

The caller is authenticated.
The project exists.
The run belongs to the requested project.
The caller has permission for that operation.
The requested path belongs to the project’s allowed root.
Never use a globally searchable runId as the only authorization boundary.

Prefer:

text


/api/projects/:projectId/runs/:runId
instead of:

text


/api/runs/:runId
4.3 CORS and origin policy
Replace permissive CORS:

TypeScript


origin: true
with an allowlist:

TypeScript


const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);
In production, serve the UI from the same origin if possible. That removes much of the CORS complexity.

4.4 Secure binding
Rules:

Default host: 127.0.0.1
Reject 0.0.0.0 unless a secure deployment flag is explicitly provided.
If remote binding is enabled, require:
TLS
authentication
restrictive CORS
rate limiting
audit logging
an explicit warning during startup
Startup should print something like:

text


WARNING: VibeFix is exposed beyond localhost.
Remote exposure requires TLS and authenticated access.
4.5 Correct path containment
Never use string prefix checks.

Use a reusable policy function:

TypeScript


export function resolveInside(root: string, requested: string): string {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, requested);
  const relative = path.relative(absoluteRoot, candidate);

  if (relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) {
    throw new PathPolicyError("Path escapes allowed root");
  }

  return candidate;
}
Test all of these:

text


../secret
../../secret
C:\other-root
/project/repository-secrets
symlink-to-outside
encoded traversal
mixed separators
case variants
null bytes
4.6 Symlink policy
A repository can contain symlinks that point outside the worktree.

Decide explicitly:

Reject symlinks during analysis, or
Resolve and verify every symlink target, or
Allow only symlinks that remain inside the repository.
Do not allow an agent to read or modify arbitrary symlink targets.

4.7 Git credential protection
Never construct:

text


https://username:token@github.com/...
as a child-process argument.

Use one of:

Git credential helper with a temporary isolated configuration
A temporary credential file with restrictive permissions
Provider APIs that return an archive without exposing credentials to git
SSH keys managed by the operating system
Whatever mechanism is used:

Scrub stderr
Scrub structured logs
Scrub thrown errors
Do not persist clone URLs containing credentials
Add tests that intentionally cause clone failure and search all output for the token
4.8 Repository resource limits
Cloning and analyzing an arbitrary repository is dangerous even locally.

Enforce:

Maximum clone size
Maximum number of files
Maximum individual file size
Maximum total analysis size
Maximum clone duration
Maximum process duration
Maximum disk quota
Cancellation on user abort
Cleanup after failure
Reject repositories that exceed limits with a clear explanation.

5. Phase 2: make the run engine durable and correct
The orchestrator is the product’s core. Treat it like a state machine, not a collection of callbacks.

5.1 Define the state machine formally
Create a transition table:

text


created
  -> analyzing
  -> awaiting_approval
  -> executing
  -> verifying
  -> completed

created
  -> failed
analyzing
  -> failed
awaiting_approval
  -> aborted
executing
  -> aborted
executing
  -> failed
verifying
  -> rejected
verifying
  -> completed
any non-terminal state
  -> interrupted
For every transition define:

Allowed source states
Required command
Required persisted data
Emitted events
Side effects
Recovery behavior
Idempotency behavior
Reject illegal transitions centrally.

5.2 Make commands idempotent
Approval, abort, resume, and cleanup should include an idempotency key.

Example:

http


POST /api/projects/:projectId/runs/:runId/approve
Idempotency-Key: 8d9...
If the same request is repeated:

Do not execute the operation twice.
Return the original result.
Preserve the original event sequence.
This is essential when the UI retries after a network failure.

5.3 Persist before acknowledging
For a state-changing operation:

Validate command.
Check authorization.
Check idempotency key.
Apply state transition.
Persist state and event.
Execute background work.
Return an accepted response with a command ID.
Do not report approval as successful merely because a background promise was created.

Possible API response:

JSON


{
  "accepted": true,
  "commandId": "cmd_123",
  "runId": "run_123",
  "state": "executing"
}
If execution fails, emit and persist:

text


run.execution_failed
and expose the failure through the run state.

5.4 Fix promise swallowing
Do not use one method for both tracking and awaiting.

Use separate APIs:

TypeScript


registry.startBackground(runId, task);
registry.awaitCommand(runId, command);
Background tasks must still:

Persist failure
Emit failure event
Record error metadata
Release resources
Move the run into a terminal or recoverable state
5.5 Runtime lifecycle
A runtime should have explicit ownership:

text


created
  -> registered
  -> running
  -> terminal
  -> disposed
On terminal state:

Unsubscribe listeners
Clear timers
Close child processes
Release worktree locks
Close file handles
Remove runtime from registry
Retain disk-backed run data
The registry should distinguish:

text


active runtimes
recoverable persisted runs
terminal runs
Do not derive “active runs” from the total number of objects ever registered.

5.6 Restart recovery
On startup:

Enumerate persisted runs.
Validate their schemas.
Identify non-terminal runs.
Determine whether a worker was active.
Mark interrupted work safely.
Check worktree existence.
Check process ownership.
Reconcile pending commands.
Resume only explicitly resumable phases.
Mark unsafe phases as requiring user review.
Never automatically resume code modification without verifying:

The worktree is intact.
The proposal is unchanged.
The process is not still running elsewhere.
The run has not exceeded resource limits.
The repository identity still matches.
5.7 Event log design
Each event should include:

TypeScript


{
  eventId: string;
  sequence: number;
  runId: string;
  projectId: string;
  type: string;
  occurredAt: string;
  schemaVersion: number;
  payload: unknown;
  durable: boolean;
}
Use a single writer per run or an append-only mechanism that guarantees sequence ordering.

If persistence fails:

Do not silently continue as if the event were durable.
Mark the run as degraded.
Surface the issue to the UI.
Prevent claiming complete recovery guarantees.
5.8 Corruption handling
If one event line is corrupt:

Record the line number.
Record the corruption error.
Mark replay as degraded.
Provide a repair/export diagnostic.
Never silently drop it without telling the user.
Implement a repair command:

Bash


vibefix diagnose run <runId>
vibefix repair-event-log <runId> --backup
6. Phase 3: fix WebSocket and UI synchronization
Use a single authoritative synchronization model.

6.1 Server-side replay handshake
The safe sequence is:

Client connects with runId and last known sequence.
Server registers a live subscription.
Server begins buffering live events for that connection.
Server sends the authoritative snapshot and current sequence.
Server replays events after the client’s sequence.
Server flushes buffered events.
Server continues live delivery.
This avoids the replay/subscription gap.

6.2 Sequence numbers
The UI should track:

text


lastAppliedSequence
For each event:

If sequence equals last + 1, apply it.
If sequence is less than or equal to last, ignore as duplicate.
If sequence is greater than last + 1, request resynchronization.
Do not rely only on event IDs.

6.3 Resynchronization endpoint
Add:

text


GET /api/projects/:projectId/runs/:runId/snapshot
GET /api/projects/:projectId/runs/:runId/events?after=<sequence>
On a sequence gap:

Stop applying live events.
Request a fresh snapshot.
Set lastAppliedSequence.
Request events after that sequence.
Resume live processing.
6.4 Reconnection generations
The UI store should retain:

TypeScript


reconnectTimer
connectionGeneration
activeRunId
lastSequence
Every connect/disconnect increments the generation. A timer may only reconnect if its generation is still current.

Cancel:

Reconnect timers
Pending fetches
WebSocket listeners
Polling intervals
Run-specific subscriptions
6.5 Server-authoritative state
Avoid interpreting arbitrary event messages as domain enums.

Instead, validate:

TypeScript


const RunSnapshotSchema = z.object({
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  ...
});
The UI should receive authoritative snapshots and use events for incremental updates and display.

6.6 UI state tests
Test:

Initial snapshot
Replay from sequence zero
Replay from a later sequence
Duplicate event
Out-of-order event
Sequence gap
WebSocket disconnect
Reconnect after run switch
Terminal run reconnect
REST fallback
Approval retry
Abort retry
Stale browser tab
7. Phase 4: secure the agent and change pipeline
The central product promise is “safe refactoring.” Enforce it mechanically.

7.1 Separate capabilities by agent
Do not merely rely on agent names or prompts.

Define explicit capabilities:

TypeScript


type AgentCapability =
  | "read_repository"
  | "read_git_history"
  | "write_worktree"
  | "run_tests"
  | "run_build"
  | "call_llm"
  | "approve_change"
  | "publish_report";
Each agent receives only the capabilities it needs.

Examples:

text


Cartographer:
  read_repository
  read_git_history

Engineer:
  read_repository
  write_worktree
  run_tests
  run_build
  call_llm

Verifier:
  read_repository
  run_tests
  run_build
  call_llm

No agent:
  approve_change
Approval belongs to the user or a separate policy engine.

7.2 Firewall enforcement
The firewall should verify:

Absolute path containment
Allowed file list
Allowed operation type
Protected paths
Lockfiles
Generated files
Symlinks
Renames
Deletes
New files
File size
Binary files
Permission changes
Git metadata changes
Perform checks both:

Before each write
After the entire worktree operation using git diff --name-status
The second check catches writes that bypass the normal adapter.

7.3 Proposal schema
A ChangeProposal should include:

TypeScript


{
  proposalId,
  runId,
  title,
  rationale,
  affectedFiles,
  allowedOperations,
  forbiddenPaths,
  expectedBehavior,
  publicApiImpact,
  dependencyImpact,
  testPlan,
  rollbackPlan,
  riskScore,
  confidence,
  createdAt,
  schemaVersion
}
The proposal must be immutable after approval. If the engineer changes scope, the proposal becomes invalid and requires re-approval.

7.4 Approval integrity
When a user approves:

Verify the proposal hash.
Verify the proposal belongs to the run.
Verify no files changed in the source repository unexpectedly.
Verify the approval is for the current proposal version.
Record user identity, timestamp, and selected proposal IDs.
Reject duplicate or stale approvals safely.
7.5 Worktree lifecycle
For every worktree:

Create it from a known commit.
Record the source commit hash.
Record branch/worktree path.
Restrict permissions.
Ensure cleanup on success, failure, and cancellation.
Preserve failed worktrees optionally for debugging.
Prevent concurrent operations against the same worktree.
Verify cleanup actually occurred.
8. Phase 5: make deterministic analysis trustworthy
The current analysis layer should never present heuristic guesses as facts.

8.1 Replace regex metrics with parsers
For TypeScript and JavaScript:

Use the TypeScript compiler API for syntax trees.
Use the module resolver for imports.
Support .ts, .tsx, .js, .jsx, .mts, .cts, .d.ts.
Understand path aliases and package exports.
Track parser failures explicitly.
For other languages, use language-specific parsers where practical.

8.2 Metrics should include provenance
Every metric should include:

TypeScript


{
  value: number;
  analyzer: "typescript-compiler-api";
  confidence: "high" | "medium" | "low";
  parserErrors: number;
  skippedFiles: string[];
}
A metric produced after parser failure should not look equivalent to a fully parsed metric.

8.3 Improve function metrics
Measure using AST nodes:

Function length
Cyclomatic complexity
Cognitive complexity
Nesting depth
Parameter count
Branch count
Mutation count
Exception paths
Async boundaries
Do not count braces and parentheses with a shared depth counter.

8.4 Improve import graph analysis
Use actual module resolution. Record:

text


source file
import specifier
resolved file
import type
dynamic/static
external/internal
resolution status
Unresolved imports should be reported separately from confirmed architecture violations.

8.5 LLM finding validation
Before accepting an LLM finding:

Does the location exist?
Do cited files exist?
Do cited edges exist in the graph?
Is the recommendation compatible with the mode?
Is the finding duplicate by normalized fingerprint?
Does the evidence actually support the claim?
Reject or downgrade unsupported findings.

8.6 Finding identity
Use a stable fingerprint:

text


category
+ normalized location
+ normalized evidence
+ recommendation category
Titles should be presentation, not identity.

8.7 Score honestly
Rename arbitrary scores:

text


Architecture health score
to something like:

text


Heuristic architecture indicator
Display:

Severity
Confidence
Evidence count
Analyzer source
Number of affected files
Test coverage
Risk of changing the area
Avoid a single number that implies objective software quality.

9. Phase 6: harden the LLM subsystem
9.1 Error taxonomy
Define typed errors:

TypeScript


type LlmFailure =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "network"
  | "provider_unavailable"
  | "model_not_found"
  | "invalid_request"
  | "schema_invalid"
  | "content_filtered"
  | "budget_exceeded"
  | "aborted"
  | "internal";
Fallback rules should depend on the category.

Example:

Table


Error	Fallback
Timeout	Yes, if budget permits
Network failure	Yes
Provider unavailable	Yes
Rate limit	Yes, with backoff
Invalid request	No
Schema failure	Retry bounded; then fail
Programming error	No
User cancellation	No
Budget exceeded	No
9.2 Circuit breaker
Replace a permanent dead-provider set with a timed circuit breaker:

text


closed
  -> open after N failures
  -> half-open after cooldown
  -> closed after successful request
Store:

Failure count
Failure timestamps
Last error type
Cooldown expiry
Successful recovery time
9.3 Budget enforcement
Track per run:

Input tokens
Output tokens
Estimated cost
Provider calls
Retry calls
Maximum model latency
Number of fallback attempts
If a budget is exceeded, stop safely and explain why.

9.4 Sensitive-data redaction
Before sending repository content to a provider:

Detect likely credentials
Redact secrets
Exclude .env, credentials, private keys, and configured sensitive paths
Record what was excluded
Allow user policy configuration
Never send full repository content by default
9.5 Prompt and schema versioning
Persist:

text


provider
model
prompt version
schema version
temperature/configuration
input artifact hashes
output artifact hash
This makes runs reproducible and debuggable.

9.6 Structured output validation
Every typed model response must be:

Parsed
Schema-validated
Cross-validated against repository facts
Size-limited
Redacted before persistence if necessary
10. Phase 7: testing strategy
You need multiple layers of tests.

10.1 Unit tests
Cover:

State transition table
Path containment
Symlink handling
Firewall decisions
Proposal hashing
Finding deduplication
Metrics calculation
Import resolution
Retry classification
Circuit breaker
Budget calculations
Event sequencing
Error serialization
10.2 Contract tests
For every persisted schema:

Valid fixture
Invalid fixture
Unknown-field behavior
Version migration
Backward compatibility
Corruption handling
Persisted runs must remain readable after upgrades.

10.3 Integration tests
Test:

Server routes
Authentication
Authorization
Project scoping
Clone lifecycle
Run lifecycle
Approval flow
Abort flow
Cleanup
Restart recovery
Event replay
WebSocket synchronization
10.4 End-to-end fixture tests
Create fixture repositories for:

text


fixture-clean
fixture-cycles
fixture-god-module
fixture-missing-tests
fixture-security-issues
fixture-large-repository
fixture-path-traversal
fixture-malicious-scripts
fixture-failing-build
fixture-conflicting-changes
fixture-symlink-escape
fixture-corrupt-history
The main happy-path test should:

Register repository.
Analyze repository.
Produce findings.
Produce a proposal.
Ask for approval.
Approve the proposal.
Run engineer in a worktree.
Run independent verification.
Reject or accept based on evidence.
Produce a final report.
Restart the server.
Verify the run remains readable.
10.5 Failure injection tests
Intentionally fail:

LLM provider
Disk write
Event append
Test command
Build command
Git command
WebSocket connection
Process startup
Worktree cleanup
Repository deletion
User cancellation
Server restart during execution
A production-grade system is defined by its behavior during failure.

10.6 Security tests
Required tests:

Path traversal
Prefix collision
Symlink escape
Unauthorized run access
Cross-project artifact access
CORS rejection
Token redaction
Command injection
Malicious repository scripts
Oversized repository
Oversized output
Rate limiting
WebSocket authentication
Sensitive file exclusion
10.7 Coverage policy
Do not use coverage alone as quality evidence. Set minimum thresholds, but also require critical-path coverage:

text


Overall lines: 80%
Core state machine: 95%
Firewall: 95%
Authorization: [REDACTED]
Persistence/recovery: 90%
LLM router: 90%
Server routes: 85%
11. Phase 8: observability and operations
11.1 Structured logging
Use JSON logs with:

text


timestamp
level
event
requestId
projectId
runId
agentId
commandId
provider
durationMs
result
errorCode
Never log:

API keys
Git tokens
Full repository contents
Full prompts by default
Sensitive file contents
11.2 Correlation IDs
Every request and background operation should be traceable:

text


requestId
commandId
runId
agentExecutionId
artifactId
eventSequence
The UI should be able to display a diagnostic ID to the user.

11.3 Health endpoints
Separate:

text


/live
The process is alive.

text


/ready
The application can accept new work.

text


/health/details
Detailed local diagnostics.

Include:

Storage writable
Event log healthy
Disk space
Active runs
Provider availability
Version
Schema version
Queue state
Worktree cleanup status
Do not expose sensitive information without authentication.

11.4 Metrics
Track:

Run success/failure rate
Run duration
Agent duration
Queue wait time
LLM latency
LLM cost
Fallback rate
Provider failures
Verification rejection rate
Firewall violations
Event persistence failures
Recovery failures
Disk usage
Worktree leaks
WebSocket reconnects
Sequence-gap resynchronizations
11.5 Diagnostics bundle
Add:

Bash


vibefix diagnostics --run <runId> --output diagnostics.zip
The bundle should contain:

Version
Configuration summary with secrets removed
State snapshot
Event metadata
Error summaries
Artifact manifest
Environment information
No repository secrets or raw credentials
12. Phase 9: deployment and packaging
12.1 Local application packaging
For the local-first release:

Package the server and UI together.
Provide a single startup command.
Use a production UI build.
Avoid requiring two terminals.
Detect missing dependencies clearly.
Create the VibeFix home directory safely.
Validate configuration on startup.
Provide clean shutdown handling.
Target:

Bash


vibefix start
rather than requiring separate development commands.

12.2 Configuration validation
Validate at startup:

Port
Host
Storage path
Allowed origins
Provider configuration
Token configuration
Resource limits
Disk availability
Node version
Git availability
Fail with actionable errors.

12.3 Graceful shutdown
On SIGTERM/SIGINT:

Stop accepting new runs.
Notify clients.
Cancel or checkpoint active work.
Persist state.
Terminate child processes.
Clean temporary resources.
Close WebSockets.
Flush logs.
Exit within a timeout.
12.4 Upgrade and migration system
Every release may change:

Persisted state
Event schemas
Artifact schemas
Configuration
Prompt versions
Implement:

text


schemaVersion
migrationVersion
Before upgrading:

Back up run data.
Run migrations transactionally where possible.
Keep a migration log.
Provide rollback guidance.
Test upgrades from at least the previous two versions.
12.5 Backup and cleanup
Provide:

Bash


vibefix backup
vibefix restore
vibefix clean --dry-run
vibefix clean --older-than 30d
Cleanup must never delete:

Active runs
Unexported failed worktrees
User-approved artifacts
Configuration
Backups
13. Product-level improvements
Production quality is not only backend correctness.

13.1 Explain uncertainty
Every finding should show:

Why it was detected
Evidence
Confidence
Analyzer
Potential impact
Risk of changing it
Whether tests cover the area
Whether the recommendation is deterministic or model-generated
13.2 Make approval understandable
The approval screen should show:

Exact files affected
Before/after diff
Proposed behavior
Tests to run
Risk score
Files explicitly excluded
Public API impact
Dependency changes
Estimated token cost
Estimated duration
Rollback plan
13.3 Show degraded states
Do not display only “running” or “failed.” Add states such as:

text


running
waiting_for_approval
degraded
recovery_required
verification_failed
budget_exceeded
cancelled
interrupted
completed
The user should know whether a result is complete, partial, heuristic, or recovered.

13.4 Avoid overclaiming
Update README.md and AGENTS.md.

Replace claims such as:

text


production-ready
fully reliable
guaranteed recovery
with explicit status:

text


Implemented
Tested
Partially verified
Known limitations
Not yet supported
A production-grade product earns trust partly by accurately stating its limitations.

14. Recommended implementation order
Stage 1 — Verification foundation
Deliverables:

Clean install works
Typecheck works
Tests run
Build works
CI is green
Fixture repository executes end-to-end
Generated files are controlled
Do not proceed until this is stable.

Stage 2 — Security foundation
Deliverables:

Authentication
Authorization
Project-scoped routes
Restrictive CORS
Path containment
Symlink policy
Secure Git credentials
Resource limits
Security test suite
This is the release-blocking phase.

Stage 3 — Run correctness
Deliverables:

Formal state machine
Idempotent commands
Correct error propagation
Runtime cleanup
Durable events
Restart recovery
Corruption/degraded states
Graceful shutdown
Stage 4 — UI synchronization
Deliverables:

Sequence-numbered events
Safe replay handshake
Gap recovery
Reconnect cancellation
Authoritative snapshots
WebSocket and REST integration tests
Stage 5 — Agent safety
Deliverables:

Capability-based agents
Strong firewall
Immutable proposals
Worktree lifecycle
Diff validation
Public API detection
Approval integrity
Stage 6 — Analysis quality
Deliverables:

Parser-backed metrics
Real module resolution
Finding provenance
LLM evidence validation
Stable deduplication
Confidence-aware reports
Stage 7 — LLM reliability
Deliverables:

Typed error taxonomy
Correct fallback policy
Recoverable circuit breaker
Token/cost budgets
Redaction
Prompt/schema versioning
Provider health checks
Stage 8 — Operations and packaging
Deliverables:

Production startup command
Configuration validation
Structured logging
Metrics
Diagnostics bundles
Backup/restore
Cleanup tools
Migration system
Release artifacts
15. Release gates
Do not call VibeFix production-ready until all of these are true.

Build gate
Clean checkout installs successfully.
Typecheck passes.
Lint passes.
Build passes.
Tests pass without network access unless explicitly required.
Security gate
No unauthenticated sensitive route.
No permissive CORS.
No path traversal.
No symlink escape.
No credential leakage.
No cross-project access.
Security tests pass.
Reliability gate
Restart recovery test passes.
Event replay test passes.
WebSocket gap recovery passes.
Approval failure returns failure.
Runtime cleanup test passes.
Corrupt event handling is visible and safe.
Shutdown test passes.
Agent safety gate
Firewall bypass tests pass.
Writer capability is isolated.
Proposal mutation is rejected.
Worktree cleanup passes.
Independent verifier cannot access engineer reasoning.
Public API changes are detected.
LLM gate
Provider fallback behavior is tested.
Circuit breaker recovers.
Cost limits work.
Secrets are redacted.
Invalid model output is rejected safely.
Provider failure does not corrupt run state.
Operations gate
Logs are structured.
Diagnostic bundles work.
Health checks work.
Backups restore successfully.
Upgrade migration tests pass.
Disk and process limits are enforced.
Product gate
A user can understand every proposed change.
The UI clearly displays uncertainty and degraded states.
Documentation matches reality.
Failed runs explain how to recover.
The system never silently claims success.
16. Suggested first 10 implementation tickets
Start with these concrete tickets:

Add root typecheck, verify, and CI workflows.
Implement authenticated local server startup and token rotation.
Create resolveInside() path policy and security tests.
Convert all run routes to project-scoped URLs.
Remove credential-bearing Git URLs from child-process arguments.
Separate awaited commands from background runtime tracking.
Add runtime disposal and terminal-run cleanup.
Implement sequence-based WebSocket replay with gap recovery.
Replace regex TypeScript metrics with compiler-API analysis.
Build one complete fixture-repository end-to-end test through approval, worktree execution, verification, and restart recovery.
Final priority judgment
The biggest mistake would be adding more agents, more UI features, or more model providers before fixing the foundation.

The correct order is:

text


Clean build
  ↓
Security boundary
  ↓
Durable state machine
  ↓
Recovery and synchronization
  ↓
Firewall and agent capability isolation
  ↓
Parser-backed analysis
  ↓
LLM reliability
  ↓
Observability and packaging
  ↓
More agents and advanced features
VibeFix can become a production-grade application, but its strongest selling point must be backed by hard guarantees:

It should never silently claim that a code change is safe, never modify outside the approved scope, never lose the truth about a run, and never hide uncertainty behind an impressive report.