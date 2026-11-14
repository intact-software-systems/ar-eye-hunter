# Test Suite Review Implementation Plan

**Goal:** Improve confidence and maintainability across `packages/tests/**`, `tests/**` and
`apps/api-v1/test/**`, reducing redundant proofs where justified and adding missing coverage.

**Design:** [Collective test review](../../docs/test-suite-review.md). The maintainer selected
coverage-led reduction and accepts a net increase in tests. There is no percentage reduction quota.

**Execution:** Use `adaptive-plan-execution`, `rallar-testing`, `rallar-code-writing` and
`publishing-plan-progress`. Implement in this chat; use a fresh reviewer for the coherent batch.
Only the next two slices are concrete. The draft PR carries progress; this file is not a ledger.

**Stack:** Vitest for package tests, Bun for API tests, Playwright for browser behavior,
PostgreSQL/PGlite for database semantics, and TypeScript for maintained test compilation.

## Constraints and acceptance

- Preserve every independently meaningful failure case when consolidating; name the surviving
  test before deleting coverage. Source similarity alone does not authorize removal.
- Preserve real backend, security, scope, idempotency, retry, rollback and cross-process proofs.
- No production API, schema, runtime behavior or workload-constant changes in the initial slices.
- Review and remediate every changed human-authored file in full. Any support file modified by
  remediation enters closure recursively. Independent untouched code remains outside closure.
- Do not claim full manual review, mutation coverage, CI runtime savings or release-gate success
  from the static inventory or focused checks.
- Each slice needs a direct behavioral check and the affected package/test typecheck. Keep changes
  in draft while the broader plan remains active; use delivery readiness only for a finished,
  reviewed candidate intended for release handoff.

## Slice 1: Account for PostgreSQL selection and execution

**Owners:** Existing PostgreSQL npm commands and native Vitest configuration; checker/reporter
under `scripts/`, with CLI fixture tests in `packages/tests/repo/postgres-test-execution.test.ts`.

1. Discover PostgreSQL-gated package tests from their explicit environment marker. Use native Vitest file selection for
   the existing `test:postgres:*` lanes. For unselected candidates, compare dynamic registration
   with the backend flag on and off, with static parsing disabled. This distinguishes actual
   conditional cases from fixture strings without recompiling already-selected suites. Retain the
   separate presence-expiry lane. Fail closed on collection errors and name missing conditional cases.
2. Add a runtime reporter to the full PostgreSQL npm commands that rejects skipped, todo or pending
   cases. Keep filtered local invocations available without the completeness flag. Preserve native
   test failure handling and the intentional repeated presence-expiry run.
3. Prove acceptance and failure with actual native-runner fixtures: parameterized conditional aliases,
   a missing mixed-suite overlap case, collection errors, complete execution and declared/runtime skips.
4. Run the real repository selection audit and an isolated PostgreSQL friends-presence run with the
   reporter enabled. Run maintained tests typecheck, native configuration checks, formatting and
   affected style/coupling review. Document that collection proves selection; only runs prove execution.

## Slice 2: Review scenario and governance repetition

**Owners:** Existing scenario/manifest suites and repository governance tests named in the assessment.

1. Compare repeated assertions with their independent contract and surviving runtime or artifact test.
   Distinguish generated examples, public workload constants and private implementation choices.
2. Remove or consolidate only proofs with a named behavioral successor; strengthen a demonstrated
   gap before deleting its weak substitute. Keep independent publication-integrity checks honest
   about what they prove, and preserve distinct scenario inputs and backend responsibilities.
3. Run the affected focused suites and maintained test typecheck. Review every changed file in full
   and obtain a fresh review before publishing the coherent batch to the existing draft PR.

## Later outcomes, refined after these slices

- Review further structural candidates individually, preserving durable compatibility boundaries.
- Improve browser-suite cohesion and deterministic waits, preserving actual visible-user journeys
  and distinct real-browser responsibilities.
- Reassess manual mobile and propagation coverage and collect comparable timing/retry evidence
  before any broad runtime optimization or deletion campaign.

## Publication and completion

Continue the coverage-led plan in draft PR #828 on `codex/test-suite-coverage-review`.
Prioritize demonstrated coverage gaps and remove weak or redundant tests only where the
surviving coverage is clear. Keep the dated assessment separate from completion evidence.

Before broad final validation, run `npm run pr:delivery -- status` and repair genuine conflicts.
Keep the PR draft while implementing the remaining accepted outcomes. When the plan is actually
finished, delete this active plan before the final ready transition; retain the review as a dated
assessment, with Git history preserving the plan. Run `npm run pr:delivery -- ready` once for that
finished candidate and monitor its required current-candidate release result. Do not merge without an authorized delivery decision.
