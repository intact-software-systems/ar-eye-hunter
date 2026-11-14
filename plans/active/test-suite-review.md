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

## Review focus

- A file can be reached by CI while its only PostgreSQL case is always skipped: compare actual
  runner selection and require a real, non-skipped PostgreSQL result in slice 1.
- A synchronous write can be visible only after an awaited refresh: assert immediate reads before
  the first await, then prove the same value through `get` in slice 2.
- A committed value can enter history but remain absent from synchronous reads: preserve a
  dedicated commit/read assertion in slice 2.
- Epoch zero is a real clock reading, not a missing-value sentinel: preserve the `LoanedValue`
  epoch-zero assertion at its owning suite in slice 2.
- Consolidation can accidentally erase refresh coalescing, expiry or per-key isolation: retain
  and rerun the existing cases and adjacent cache tests in slice 2.

## Slice 1: Activate the existing friends-presence PostgreSQL proof

**Owner/files:**

- Modify `packages/tests/shared-server/vitest.postgres-integration.config.mjs`.
- Execute `packages/tests/shared-server/rallar-system/friends/friends-presence.test.ts` unchanged.
- Consume `createResourceInboxTestStorage`, which owns a fresh schema and its cleanup. No new
  test helper, public interface or generic test harness is needed.

Steps:

1. Capture the existing unit result and PostgreSQL runner file list. Confirm the unit suite skips
   the overlap case and the configured PostgreSQL list omits this file.
2. Add this suite to the existing PostgreSQL `include` array. Review the complete configuration
   for coherent selection and existing backend boundaries.
3. Repeat the configured file listing and verify the file is selected. Run the whole selected
   friends-presence suite with `RALLAR_POSTGRES_INTEGRATION=1`, `--no-file-parallelism` and an
   isolated test database. Require all cases to pass with zero skipped cases; inspect the named
   overlap case, not merely the process exit code.
4. Run `npx tsc -p packages/shared-server/tsconfig.json --noEmit` and the maintained tests typecheck.
   Validate selection with the native runner, rather than adding another source-text config test.
5. Publish the coherent configuration change in the same draft PR. If execution exposes a real
   regression, classify it before adapting the plan; never reduce its concurrency assertions.

## Slice 2: Consolidate cache write-read regression coverage

**Owner/files:**

- Modify `packages/tests/shared/loaned-memento-repository.test.ts`.
- Modify `packages/tests/shared/loaned-value.test.ts`.
- Delete `packages/tests/shared/loaned-memento-set-value.test.ts` after preserving its distinct proofs.
- Production owners remain `LoanedMementoRepository` and `LoanedValue`; no production edits planned.

Steps:

1. Run all three suites before editing and map every assertion in the satellite regression file.
2. In the repository suite, exercise `setValue('k', 42)` and immediately assert `read`, `peek` and
   `hasValue`, before awaiting `get('k') === 42`. Use a refresher with a different value so an
   accidental refresh cannot satisfy the assertion. This replaces two overlapping scenarios.
3. Retain `commitValue('k', 7)` immediate visibility. Fold the empty-state/refresher assertions into
   the existing refresh scenario only if that scenario still distinguishes the same failure.
4. Move `acceptAt(9, 0)`, `readAt(0) === 9` and `expiredAt(0) === false` to the `LoanedValue` suite.
   Remove duplicated hand-built deferred helpers in touched files where `Promise.withResolvers`
   provides the same explicit construction. Apply full-file standards closure.
5. Delete the satellite file. Rerun the resulting suites and adjacent cache coverage. Verify the
   immediate-read scenario detects a temporary reintroduction of delayed visibility in a
   disposable experiment; restore production exactly before final checks.
6. Run `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npm run typecheck:tests`, formatting,
   changed-file style/coupling review, and test reachability. Report the measured file/case change,
   with no unsupported runtime-savings claim.

## Later outcomes, refined only after the first two slices

- Close canonical JSON boundary assertion gaps with independently expected valid/invalid values.
- Retire the class-string persistence ownership test after verifying its behavioral successors;
  review similar structural candidates individually, preserving durable compatibility boundaries.
- Strengthen reachability into conditional/backend execution accounting, with positive and
  negative fixtures and real runner outcomes. Avoid creating a broad hand-maintained case catalog.
- Review manifest/scenario and governance clusters for repeated coverage and self-derived oracles.
- Improve browser-suite cohesion and deterministic waits, preserving actual visible-user journeys
  and distinct real-browser responsibilities.
- Reassess manual mobile and propagation coverage and collect comparable timing/retry evidence
  before any broad runtime optimization or deletion campaign.

## Publication and completion

Publish the assessment and plan first on `codex/test-suite-coverage-review`, open one draft PR,
then publish reviewed implementation slices. The current request is to establish the plan and
start it, not to silently claim the entire long-term audit backlog resolved.

Before broad final validation, run `npm run pr:delivery -- status` and repair genuine conflicts.
Keep the PR draft while implementing the remaining accepted outcomes. When the plan is actually
finished, delete this active plan before the final ready transition; retain the review as a dated
assessment, with Git history preserving the plan. Run `npm run pr:delivery -- ready` once for that
finished candidate and monitor its required current-candidate release result. Do not merge as
part of this initial audit/start handoff.
