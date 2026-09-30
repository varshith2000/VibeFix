# VibeFix | Investor & Product Overview

## Executive Summary

**VibeFix is a local-first, multi-agent refactoring control plane for AI-built and rapidly evolving software repositories.** It helps developers understand a codebase, identify evidence-backed maintenance opportunities, and carry out narrowly scoped refactors through a human-approved workflow with independent checks.

Unlike a coding assistant that starts with a prompt and returns a patch, VibeFix organizes repository improvement as a controlled process: **Understand → Preserve → Improve → Verify → Explain.** The product is designed around a central principle: a cleaner-looking diff is not valuable if it silently changes what the software does.

VibeFix is an early-development product, not a production-ready service. The project has a working local control plane, 16 specialized agent roles, a deterministic orchestrator, isolated Git worktrees, a write firewall, structured run evidence, and automated tests. Several release-critical reliability and safety gates remain open; they are stated below rather than presented as completed guarantees.

## The Problem

AI-assisted development has lowered the cost of creating software. It has also increased the volume of code that developers must understand, review, test, and maintain. In fast-moving or AI-generated projects, common problems include:

- Structure and dependencies are poorly understood by new contributors.
- Tests may be missing, unreliable, or unable to cover important behavior.
- Cleanup proposals can expand into rewrites that change behavior.
- A developer sees a large generated diff but not the evidence or rationale behind it.
- Coding agents can diagnose, plan, edit, and approve their own work in one conversational context.

The resulting gap is not simply “write code faster.” It is **how to improve an existing codebase without losing control of scope, behavior, or reviewability**. VibeFix targets that gap.

## The Product

VibeFix takes a Git repository and creates a structured, observable improvement run. It inventories the repository, identifies maintainability and security findings, assesses risk and available tests, and assembles a prioritized remediation backlog. The developer reviews and approves the proposed scope before code changes begin.

For each approved backlog item, the Refactoring Engineer works on one proposal in a dedicated Git worktree. A Change Firewall restricts writes to declared paths and blocks protected areas. The engineer is the only agent with code-write permission. A separate verification pool then checks the resulting diff. The application shows the pipeline, agent state, evidence, findings, checkpoint, execution, and report through a local web UI. A CLI is also available for headless runs.

The system uses structured, versioned artifacts rather than relying on conversational memory as its source of truth. The orchestrator is a deterministic state machine: it controls the run phases, checkpoint, retries, and terminal states. This makes the product's workflow inspectable and testable independently from the language model used for analysis or code generation.

## How a Run Works

1. **Open a repository.** The operator selects a local Git repository or opens an eligible project through the UI. Git-less folders can be initialized with an explicit opt-in that creates a baseline commit.
2. **Build repository context.** Deterministic tools gather file facts, imports, metrics, test commands, and repository information. Agents interpret that evidence into a map, product-intent artifact, and test survey.
3. **Diagnose.** Read-only agents independently look for code smells, architecture issues, convention drift, and security signals. Findings are tied to repository evidence and may include analyzer provenance and confidence.
4. **Assess and prioritize.** Risk Assessor scores findings and identifies do-not-touch zones. Synthesis merges duplicate or related observations into a prioritized backlog. Minimality challenges over-broad proposals.
5. **Ask the human.** The backlog is presented at a checkpoint. The operator chooses whether to approve the work. Execution does not begin until approval, except when the CLI's explicit `--yes` option is used.
6. **Establish a baseline.** Harness Builder records the current test-suite outcome when a runnable suite is detected and pins the public API surface. This is a baseline mechanism, not automatic generation of characterization tests.
7. **Make one scoped change.** Refactoring Engineer attempts one approved proposal in an isolated worktree. The firewall checks each proposed write against the change scope and protected-path rules. The workflow budget allows an initial attempt and up to two retries; changes that do not pass are deferred rather than forced through.
8. **Check the change.** Behavior Verifier runs deterministic checks for scope, test outcome, and public API drift, followed by a fresh-context behavior decision. Principle Reviewer challenges minimality and alignment with the stated proposal. Regression Sentinel checks the configured build, typecheck, lint, and test commands, as applicable.
9. **Explain the outcome.** Docent summarizes the codebase, findings, accepted and deferred proposals, changes made, verification results, and areas deliberately left untouched.

The checks reduce risk and improve reviewability; they do **not** mathematically prove program equivalence. A passing test result is evidence, not a universal guarantee that all behavior is unchanged.

## The 16 Agents: Function and Rationale

### Repository Understanding

**1. Cartographer — repository mapper**

Maps languages, frameworks, files, entry points, and dependency/import relationships into a codebase knowledge graph. Its job is to establish a factual map before later agents diagnose problems. This reduces the chance that an agent treats an unfamiliar structure as a defect simply because it is unfamiliar.

**2. Historian — product-intent researcher**

Reads repository history, README material, and debt markers to infer what the product is meant to do and where development focus has been. It creates a Product Intent artifact for downstream use. The reason for the role is to anchor refactoring recommendations in the repository's apparent purpose, rather than optimizing code style in isolation.

**3. Test Surveyor — safety-net assessor**

Detects test frameworks and available test/build commands, then characterizes whether the repository has a usable baseline. This calibrates later risk decisions: the same proposed change is more difficult to verify in an untested area than in a well-covered module.

### Diagnosis and Risk

**4. Smell Detector — local maintainability analyst**

Looks for duplication, overly long functions, dead code, and related function- or class-level smells. Its role is to find localized opportunities that can often be addressed with small structural changes.

**5. Architecture Auditor — structural analyst**

Examines relationships between modules for cycles, oversized or overly central modules, and boundary violations. It exists to spot systemic issues that are not apparent from reading one function at a time. Where language-model findings are used, repository facts validate locations and unsupported evidence is demoted rather than treated as established fact.

**6. Consistency Sentinel — convention analyst**

Finds drift in naming, error handling, and repeated implementation patterns. It asks whether similar problems are handled in noticeably different ways. This matters because inconsistent patterns increase the effort required to understand and safely extend a codebase.

**7. Security — read-only security signal**

Looks for patterns such as secrets, injection sinks, and sensitive logging. It is informational and read-only: it does not claim to be a comprehensive security audit or automatically remediate vulnerabilities. Keeping this agent out of the write path makes its findings easier to review independently.

**8. Risk Assessor — change-risk analyst**

Evaluates findings in light of repository context and the available test survey, assigns risk assessments, and marks areas that should not be touched. The purpose is to optimize for worthwhile changes relative to risk, rather than maximizing the number of findings fixed in a run.

**9. Synthesis — backlog owner**

Combines findings, risk assessments, repository context, and test evidence into a single prioritized Remediation Backlog. It makes multiple agent outputs usable by a developer deciding what work is worth approving.

**10. Minimality — scope challenge**

Reviews the backlog to shrink scope or defer ambitious changes. Its purpose is to counter a common failure mode of automated code changes: turning a focused cleanup into a broad redesign with more risk than benefit.

### Baseline, Change, and Verification

**11. Harness Builder — baseline recorder**

Records the existing test-suite result when a test command can be detected and pins a public API surface for later comparison. This supplies measurable baseline data to the verification phase. Important current boundary: it does not yet generate characterization tests, and if the repository has no runnable suite, the baseline is limited.

**12. Refactoring Engineer — sole code writer**

Implements exactly one approved proposal per attempt in a Git worktree. It is the only agent granted worktree-write permission; changes go through a Change Firewall and must stay inside the approved scope. Its operating rules favor structural moves such as moving, extracting, or renaming code, and prohibit unrelated drive-by changes. This centralized write authority is a core design choice: many agents can inspect and challenge work, but only one can modify code.

**13. Behavior Verifier — behavior and scope checker**

Runs code-level gates for changed-file scope, compares the test-suite outcome with the captured baseline when available, and checks public API surface drift. It then requests a fresh-context behavior-preservation decision based on the proposal, gates, and diff, without access to the engineer's rationale. Its purpose is to reduce author-review bias. These checks are not exhaustive; in particular, the production contract identifies fail-closed verification as an open gap that must be closed before relying on production-level guarantees.

**14. Principle Reviewer — minimality reviewer**

Reviews whether the diff follows the approved proposal and stays minimal. It acts as a devil's advocate for unnecessary changes and principle drift, rather than repeating the behavior verifier's primary role.

**15. Regression Sentinel — integration gate**

Runs configured build, typecheck, lint, and test commands and checks for forbidden-zone touches. Its purpose is to catch integration problems and broader regressions that a review of the target function alone could miss. Repository commands currently run on the host by default; an explicit execution-approval policy remains necessary future hardening.

### Explanation

**16. Docent — user-facing explainer**

Turns the run's structured evidence into a readable report: the state of the codebase, what each accepted change was intended to do, what verification found, what was deferred, and what was deliberately not changed. It exists to make the result legible to the developer who must own the repository after the agents finish.

## Unique Selling Proposition

**VibeFix sells a governed change process, not merely an AI-generated diff.** Its differentiation is the combination of:

- **A multi-stage workflow:** understanding, diagnosis, human checkpoint, implementation, verification, and explanation are distinct phases.
- **Single-writer discipline:** one specialized agent writes; the rest inspect, assess, or verify.
- **Scope enforcement:** approved file scope and protected paths are enforced by a Change Firewall rather than left solely to prompt instructions.
- **Blinded review structure:** verification agents receive the diff, proposal, and gates without the engineer's rationale, reducing the risk of being persuaded by the author's explanation.
- **Evidence-first artifacts:** findings, proposals, baselines, verdicts, and reports are represented as structured data that can be inspected and tested.
- **Human control:** the backlog checkpoint gives the developer a say before code changes begin.
- **Local-first posture:** repositories and run data are kept on the operator's machine by default, while model providers can be routed/configured.
- **Language-model flexibility:** deterministic tools provide facts; text generation and typed decisions can be routed to supported providers. This separates parts of the workflow from a single model vendor.

These choices position VibeFix as a possible safety and governance layer around code agents, and as a repository-maintenance workflow for teams dealing with accumulated AI-generated code. The product should avoid claiming that its current checks guarantee behavior preservation.

## Product and Demo Surface

The current product includes a local React web control plane, a Fastify API, a CLI run path, per-project model routing, a live agent graph, an event stream, findings and codebase views, a human checkpoint, execution/diff views, health information, and a final report. Runs produce structured artifacts and can be resumed from saved state in supported situations.

### Suggested investor demo

1. Open a deliberately messy fixture repository so the problem is visible and repeatable.
2. Show the agent graph as the recon and diagnosis roles produce repository context and findings.
3. Open a finding and show its location, evidence, analyzer provenance, risk, and proposed remediation.
4. Show the synthesized backlog, including a high-value narrow proposal and any do-not-touch area.
5. Pause at the approval checkpoint and explain that implementation waits for operator approval.
6. Approve one proposal. Show the worktree-based execution and the write boundary.
7. Show the verification gates and explain what each establishes and what it cannot establish.
8. Finish with the Docent report: accepted work, rejected/deferred work, and changes deliberately not made.

For a repeatable demo, use a fixture and scripted test doubles where appropriate; real-model behavior can vary. Do not present a mock or fallback demonstration as evidence that all real-provider paths are production-ready.

## Technical Foundation and Evidence

The codebase is organized into packages for schemas, domain state, core orchestration and worktrees, agents, language-model providers, repository adapters, server/API, UI, and CLI. The orchestration state machine, Change Firewall, artifact migration path, parser-backed TypeScript metrics, TypeScript-aware import graph, finding validation, API security boundaries, and fixture-repository end-to-end workflow have named tests in the repository.

The project reports a passing verification chain covering package typechecks, tests, and builds, and configures CI for Windows and Ubuntu. The repository's own engineering guide and production contract are authoritative on maturity: tested features are distinguished from partial or unverified claims. A local passing suite and a CI workflow are positive engineering evidence, but not substitutes for customer validation, independent security review, operational testing, or closed release gates.

## Business Model and Monetization Roadmap

The commercial path should follow trust-building. Code modification software sits close to a customer's most valuable intellectual property and developer workflow; monetization will depend on demonstrating safety, predictable value, and manageable operating costs.

### Phase 1: Developer adoption and product validation

- Keep a local developer edition available to reduce adoption friction and gather feedback from real repositories.
- Validate the highest-value workflow: finding a risky maintenance issue, agreeing on a narrow proposal, and reviewing a trustworthy outcome.
- Measure time-to-understanding, accepted proposal rate, verification pass/defer rate, review time saved, and repeat usage. These are proposed product metrics, not established traction claims.
- Improve onboarding, fixture demos, provider setup, error reporting, and supported-language transparency.

### Phase 2: Paid team edition

Potential paid features include shared project policies, team-configurable approval requirements, reusable remediation rules, collaboration on backlog decisions, run history/search, consolidated model usage and cost visibility, and CI/PR workflows that publish a proposed change for human review. Charge by seats, active repositories, or a blended tier. Keep model costs visible; support customer-owned API keys or a transparent usage charge to avoid hiding inference economics.

### Phase 3: Enterprise self-hosted offering

Offer self-hosted deployment, private model routing, centralized configuration, policy administration, audit exports, retention controls, enterprise identity integration, and support commitments. These should be built only after their security, access-control, audit, deletion, and recovery behavior is implemented and tested. Enterprise value would center on governance and deployment control, not merely a larger agent count.

### Phase 4: Hosted service, only after readiness

A managed multi-tenant service could lower setup and administration costs, but it materially changes the threat model. It should remain a later option until tenant isolation, secrets handling, authorization, retention/deletion, resource isolation, incident response, and operational reliability are designed and verified. The current product is local-first and explicitly not a multi-tenant service.

### Product investments that unlock monetization

- Close production-contract gaps around fail-closed verification, execution policy, write containment, restart/recovery, single-writer locking, durable events, secret redaction, audit events, and resource limits.
- Add characterization-test generation, stronger behavior baselines, and wider language/framework support.
- Add incremental repository analysis to make repeat runs faster and less expensive.
- Build CI/PR integrations and team policy workflows, with a clear route from proposal to reviewed pull request.
- Add retention/deletion controls, administrative visibility, and exportable audit history before enterprise positioning.
- Establish customer discovery and pilots to validate pricing, buyer, deployment preference, and return on investment before projecting revenue.

## Current Stage, Risks, and Investor Framing

VibeFix is early development and **not production-ready**. The production contract names open release gates. Known limitations include incomplete fail-closed verification, repository commands executing on the host without an approval policy, write-containment gaps, incomplete recovery and event durability, incomplete centralized secret redaction, and lack of multi-user/tenant controls. These are important work items, not footnotes to an already finished enterprise product.

The core investment thesis is that AI-generated code increases the need for systems that govern how code changes are proposed, scoped, checked, and explained. VibeFix has a concrete, testable workflow and an architecture organized around that thesis. The next stage is to close trust-critical engineering gaps, validate the workflow with developers and teams, prove measurable value, and only then scale into paid team and enterprise deployments.

**Positioning line:** *VibeFix helps teams improve AI-built software without handing an AI agent the keys to the whole codebase.*