# Topology outbox queued-authority defect report

## Scope and closure

- Starting implementation head: `9ad88dee`.
- Corrective implementation commit:
  `459aba9488ea6cbe0144b99da09707dbd7b34e8b`
  (`fix: preserve queued topology authority`).
- The correction changes only:
  - `packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts`
  - `packages/shared-server/rallar-system/services/group-topology-management-service.ts`
  - `packages/tests/shared-server/rtc-topology-outbox-work.test.ts`
- Final independent review reported no Critical or Important findings.

## Production evidence and root cause

The failed two-server report showed both observed group snapshots advancing to
causal revision `{ groupRevision: 7, presenceRevision: 6 }` while every
topology poll remained at
`{ groupRevision: 4, presenceRevision: 2 }`. The final reconfigure returned the
same stale topology and did not publish it. This ruled out eventual group-state
convergence as the missing step.

The topology queue already persisted the full immutable group snapshot, but a
claim-miss worker discarded that authority and replanned from only its mutable
finder/cache. Commit `f598f775` introduced that finder-only read. When the
finder was behind the queued causal tuple, the scalar stale-work guard did not
skip the work, so graph planning stamped the stale finder tuple. The normal
topology CAS and immutable publication claim then correctly preserved the
wrong candidate; replay intentionally never replans an existing claim.

A review correction exposed a second layer: the read-through cache treats a
snapshot below or incomparable with `minCausalRevision` as a miss, and an equal
cached tuple can prevent a durable refresh entirely. Therefore a lower-bound
cache read alone cannot establish production planning authority.

## Corrected authority selection

- Claim-miss topology work now supplies its queued `groupSnapshot` to
  `readTopologyPlanningAuthority`.
- When a production `GroupStateRepository` is configured, the attempt reads a
  fresh stable durable snapshot directly. This prevents an equal or stale cache
  value from masking newer or incomparable durable authority.
- Optional-repository and in-memory consumers first request a cache/finder
  snapshot at least as new as the queued causal tuple. If that API returns no
  candidate, one unbounded read distinguishes a real absence from a filtered
  dominated or incomparable result.
- Selection uses the authoritative causal partial order:
  - current dominates queued: use current;
  - current is dominated by queued: use queued;
  - tuples are incomparable: fail with
    `GroupStateSnapshotIncomparableError`;
  - equal tuples and equal content: use current;
  - equal tuples with different non-liveness content: fail with
    `StateSnapshotRevisionConflictError`.
- A direct durable read may legitimately remove expired or disconnected
  sessions without advancing the presence-summary tuple. Equal-causal current
  state is therefore also accepted when all non-liveness authority is
  identical, both online-member counts are internally consistent, and current
  sessions are an exact order-preserving subset of the queued sessions.

Config and RTT reads, predecessor reads, pure compute/validate phases, the
bounded three-attempt CAS loop, immutable publication claims, replay behavior,
and the no-lock architecture remain unchanged.

## TDD evidence

All production changes followed an observed failing regression.

1. Newer queued authority versus stale finder:
   `npx vitest run packages/tests/shared-server/rtc-topology-outbox-work.test.ts -t "plans from the causally newest queued authority without letting older work replace it"`
   exited 1 with the durable topology at `{4,2}` instead of `{7,6}`.
2. Equal-causal different-content corruption:
   `npx vitest run packages/tests/shared-server/rtc-topology-outbox-work.test.ts -t "rejects equal-causal queued and finder authority with different content"`
   exited 1 because the promise resolved instead of rejecting.
3. Incomparable lower-bound cache miss:
   `npx vitest run packages/tests/shared-server/rtc-topology-outbox-work.test.ts -t "rejects incomparable queued and finder authority after a lower-bound cache miss"`
   exited 1 with 1 failed and 31 skipped because the promise resolved instead
   of rejecting.
4. Cache masking an incomparable durable tuple:
   `npx vitest run packages/tests/shared-server/rtc-topology-outbox-work.test.ts -t "prefers durable group authority when cache state masks an incomparable tuple"`
   exited 1 with 1 failed and 32 skipped because the promise resolved instead
   of rejecting.
5. Legitimate equal-causal liveness reduction:
   `npx vitest run packages/tests/shared-server/rtc-topology-outbox-work.test.ts -t "accepts a durable equal-causal liveness reduction as current authority"`
   exited 1 with 1 failed and 33 skipped because it raised
   `StateSnapshotRevisionConflictError`.

After the final correction, the liveness and equal-content-conflict pair passed
2/2, and all five regressions pass in the full focused matrix.

## Final validation

- Focused RTC, management, transport, and shared-web matrix:
  7/7 files and 439/439 tests passed.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`: passed.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`: passed.
- In `apps/api-v1`,
  `deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts`:
  7/7 passed.
- In `apps/api-v1`, `deno task check`: passed.
- `git diff --check` and staged `git diff --cached --check`: passed.
- The changed production paths contain no `FOR UPDATE`, `SKIP LOCKED`,
  `pg_advisory`, or `lockKey(` match.
- `npm run check:repo-style` could not run because this head has no such npm
  script; the two style/traceability documents named by the workspace guide
  are also absent on this head.
- A diagnostic `deno fmt --check` over the three package files was not an
  applicable gate: it reported all three existing four-space files as requiring
  whole-file Deno two-space formatting. No formatter was run with write mode.

## Deferred live recipe rerun

The single fresh two-server PostgreSQL rerun remains with the paused Task 8
workflow. Its recipe and matrix are Task 8-owned dirty paths that this
correction was required to preserve byte-for-byte. The available managed
cluster wrapper would run the entire cluster profile rather than only the new
recipe, so this correction did not broaden execution or modify the frozen
harness to force a run. The focused reproduction, regression matrix, API
checks, and review close the code defect; Task 8 must still record the fresh
live recipe artifact/result.

The seven preserved Task 8 file hashes after the implementation commit remain:

```text
6581be87d767c4da1d4620051dc1f5b0c487eadae69632aedceba9948c85a3c0  recipe-matrix.json
0ca57037f6bcc98e9fb390074d8fd9cad13c02310cca18ac2a1d964c6873ade7  api-v1-state-medium-scale-churn.json
08d22a712abfd5c5a0a261cd8a4908fd3f02ee45b6ae872702f2c3cb6a5b640a  postgres-expiry-worker.ts
76c164007ee00ecb77bfdd8d1ad025a83ab482620f8ae52faaf365f03ba31464  postgres-presence-expiry-concurrency.test.ts
b6c987e557528e6932bcf06accee12f84e6507a79774719213ddf7503ec7b8b8  postgres-runtime-state-concurrency.test.ts
25affe0a35a89a90a32fa9b70bcfea872c67026ea9691be9b5a6a2981a4fdc99  recipe-matrix.test.ts
e510e85aa125bc376d2f866fd0c0dc90432b9b9c097301236d79154187c7759b  api-v1-state-write-convergence.json
```
