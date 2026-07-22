# Task 5 report: client mutations inside AppInbox transactions

## Scope completed

- Replaced the client service's self-managed mutation loop with public
  `read`, `compute`, `validate`, and `write(transaction, computed)` phases.
- Made durable command facts mandatory and carried them on the command used by
  every phase. The AppInbox envelope supplies the durable timestamp, retry
  attempt, expiry, service identity, and deterministic event identity.
- Made computed outcomes exhaustive: replay, idempotency conflict, persisted
  no-op, non-persisted no-op, and applied write.
- Bound principal, instance, session, receipt, event, final `WS_OUTBOX` rows,
  AppInbox result, and AppInbox completion to the AppInbox-owned transaction.
- Routed HTTP client mutations, authorised WebSocket connect/disconnect, and
  session expiry through the same AppClientInbox phase path.
- Removed client-service transaction creation, retry/backoff/sleep behavior,
  row-lock precedent, and intermediate `StateMutationOutboxWork` intent writes.
- Kept post-commit cache observation explicit and outside the durable write.
- Added a transaction-bound `ClientStateRepository` factory and a test-only
  phase driver for legacy direct service behavior tests.

Presence expiry already entered through `AppClientInboxService`; it was moved
onto the same phased client mutation implementation without adding a separate
entry path. Task 6 and later work was not included.

## TDD and rollback evidence

The first focused run was red because the AppClientInbox handlers still called
the legacy mutator surface: the phase spies expected calls and received none.
After the implementation, the focused client suite passes 44/44 tests.

The integrated rollback test injects failure while writing the final WebSocket
outbox rows. Before terminal failure handling it verifies that rollback leaves
no principal, instance/session, idempotency receipt, event, final WebSocket
outbox row, AppInbox result, or completion. The queue entry remains reserved.
The separate terminal-failure transaction then records the failed result and
failed completion.

Retry coverage verifies that an optimistic conflict returns to AppInbox's
outer retry loop, then re-runs read, compute, validation, and the transaction.
There is no inner client retry loop.

## Validation

- `npx vitest run packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/client-state-service-idempotency.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts`
  - 3 files passed; 44 tests passed.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/services/client-state-service.test.ts`
  - 5 tests passed; 0 failed.
- `npx vitest run packages/tests/shared-server/cached-state-services.test.ts packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/shared-server/state-sync-event-replay-characterization.test.ts packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts packages/tests/repo/rallar-skill-integrity.test.ts`
  - 5 files passed; 75 tests passed.
- `npm run typecheck`
  - Passed for the root and every workspace typecheck.
- `npm run lint --workspaces --if-present`
  - Passed for every workspace lint/check target.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `cd apps/api-v1 && deno task lint`
  - Passed; 82 files checked.
- `npm run test:unit`
  - 466 files passed, 4 skipped; 4,999 tests passed, 18 skipped.
  - One accepted pre-existing boundary failure remains in
    `packages/tests/repo/typescript-7-boundaries.test.ts`; it reports the same
    three existing TypeScript compiler-API test helpers:
    `guarded-batch-contract-test-support.ts`,
    `guarded-batch-write-contract.test.ts`, and
    `read-compute-write-contract.test.ts`.
- `npm run check:repo-style`
  - Not available in this checkout (`Missing script: check:repo-style`).
- Static lock/retry scan across the changed client production files
  - No `runtime.begin`, local sleep/backoff, row/advisory lock, or
    `StateMutationOutboxWork` mutation path found.
- `git diff --check`
  - Passed.

## Tradeoffs and follow-up

- `bindRuntimeStateTransaction` exists only as an explicit test-adapter seam so
  the in-memory transaction fixture can stage runtime-state and final outbox
  changes together. Production uses the transaction-bound PostgreSQL factory.
- The canonical hash helper remains in the historically named
  `StateMutationOutboxRepository.ts`; client writes no longer create or consume
  intermediate state-mutation outbox intents. Renaming that shared helper is
  outside Task 5.
