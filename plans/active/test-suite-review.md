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

## Slice 1: Close canonical JSON assertion gaps

**Owner:** `packages/shared/encoding/canonical-json.ts`; change only its owning test file,
`packages/tests/shared/encoding/canonical-json.test.ts`.

1. Preserve the literal canonical representations and the separate SHA-256 digest vectors.
2. Add explicit valid null-prototype and repeated-reference examples. Cover non-finite numbers,
   sparse and extended arrays, hidden properties, symbol keys, unsupported object values and cycles.
   Assert that both array and object getters remain unexecuted when rejected.
3. Run the owning suite and the hash-wrapper suite. Use disposable production copies to verify
   sensitivity to removed finite-number, symbol-key and descriptor guards and lost cycle cleanup.
   Tests of existing correct behavior must pass; no artificial failing production change is needed.
4. Run shared package typecheck and maintained tests typecheck. Review the entire changed test
   file, with literal expected outputs and no new generic test harness.

## Slice 2: Remove the source-only persistence ownership check

**Delete:** `packages/tests/shared-server/rallar-system/group-state/persistence/group-state-persistence-ownership.test.ts`.

1. Trace `createTestGroupStateRepository` into the real aggregate, membership, presence, reads and
   snapshot owners. Confirm the class strings establish no independent runtime or public contract.
2. Retain and run `group-state-repository-identity.test.ts`, `group-state-snapshot-assembly.test.ts`,
   `group-state-repository-write-integrity.test.ts` and the API repository integration suite.
   In particular, “stores groups by scope, supports slug lookup, and assembles group snapshots”
   exercises real membership/presence writes and snapshot assembly through the repository facade.
3. Delete the source-only test; do not add an equivalent file-tree or source-text ratchet.
4. Run affected shared-server/test typechecks, formatting, coupling/style review and reachability.
   Review the coherent batch with a fresh reviewer before publishing to the existing draft PR.

## Later outcomes, refined after these slices

- Review further structural candidates individually, preserving durable compatibility boundaries.
- Strengthen reachability into conditional/backend execution accounting, with positive and
  negative fixtures and real runner outcomes. Avoid creating a broad hand-maintained case catalog.
- Review manifest/scenario and governance clusters for repeated coverage and self-derived oracles.
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
