# Task 6 report: group mutations inside AppInbox transactions

## Scope completed

- Replaced the group service's public mutator and service-local retry surface
  with explicit `read`, `compute`, `validate`, and
  `write(transaction, computed)` phases.
- Made `AppGroupInboxService` the only production owner of authenticated group,
  membership, governance, ownership, invite/join, and presence writes. Presence
  expiry and disconnected-session cleanup also prepare and enqueue internal
  AppInbox commands instead of writing through a maintenance bypass.
- Kept deterministic command material outside retry attempts: command/event
  identity, logical time, canonical hash, join-code material, expiry, authority
  proof, and queue identity are prepared before attempt one and carried in the
  durable AppInbox entry.
- Rerun the complete read, authorization, compute, policy/capacity/lifecycle
  validation, and transaction on every QueueBox attempt. A CAS conflict escapes
  the transaction and returns to AppInbox; the group service has no retry loop,
  backoff, sleep, or in-process contention lane.
- Changed group write candidates from an intermediate state-mutation intent to
  one mandatory immutable presence-summary `APP_OUTBOX` `ResourceEntry`.
- Bound aggregate/session CAS, admission/member rows, compact receipt, exact
  group event, summary `APP_OUTBOX`, AppInbox result, and AppInbox completion to
  the same caller-owned SQL transaction.
- Converted `GroupPresenceSummaryWork` to explicit phases. Its write uses the
  caller transaction to commit the converged summary, three group-state
  `WS_OUTBOX` rows, one deterministic topology `APP_OUTBOX` row, and the consumed
  summary reservation completion atomically.
- Kept the cached group facade free of legacy direct mutators by explicitly
  delegating only phase and read APIs instead of spreading the durable object.
  Removed the production maintenance
  service type and obsolete sync-publisher, sleep, legacy drainer-wake, and
  in-process-lane precedents from group public surfaces.
- Made exact group-event replay symmetric with client events: identical content
  matches; divergent content under the same event identity raises the typed
  collision and rolls the transaction back.
- Updated the executable syntax-aware read/compute/write inventory for AppInbox
  transaction ownership and direct ResourceInbox effects. Architecture and
  skill prose are intentionally left to Task 13.

## Atomic flow

1. The HTTP or WebSocket boundary authenticates and asks `AppGroupInboxService`
   to prepare and enqueue a durable command.
2. A QueueBox attempt calls group `read`, `compute`, and `validate` from current
   database state.
3. AppInbox opens one transaction. Group `write(transaction, computed)` applies
   the CAS guard first, then dependent state, receipt, event, and immutable
   summary `APP_OUTBOX`. AppInbox records its result and completion in that same
   transaction.
4. After commit, the summary `APP_OUTBOX` is independently reserved. The summary
   handler rereads current group/member/presence state, computes and validates a
   converged projection, then atomically writes the projection, three WS rows,
   topology work, and reservation completion.
5. Any conflict or injected failure rolls back the whole owning transaction.
   QueueBox alone decides retry timing and stale-due fairness selection.

## Six-row old-test to replacement-coverage map

| # | Removed or stale coverage | Replacement coverage | Evidence protected |
| ---: | --- | --- | --- |
| 1 | Group service inner-retry/read-batch tests (`group-state-mutation-read-retry` and the retry half of `group-state-guarded-batch-behavior`) | `group-app-inbox-authority`: `restarts the AppInbox group operation and denies a retry after authority changes`; `group-state-mutation-read-retry` now asserts the durable service is single-attempt | Attempt 1 conflicts; attempt 2 rereads, recomputes, revalidates, and denies changed authority. No stale computed value or policy decision is reused. |
| 2 | In-process aggregate-lane probes and service-local sleep/backoff assertions in `group-state-concurrency` | `keeps independent service writes convergent without service-local sleep`, `commits presence independently while an aggregate CAS write is held`, syntax-aware contract checks, and the static production scan | Group correctness depends on database CAS and AppInbox retry ownership, not a process lane, inner loop, or service sleep. |
| 3 | Group `StateMutationOutbox` replay/collision expectations | `ResourceInboxRepository` exact immutable replay/collision tests plus PGlite `group summary outbox collision rolls back state event and receipt atomically` | The group mutation writes its summary `APP_OUTBOX` directly. Exact content matches; divergent immutable content is corruption and rolls back state, event, and receipt. |
| 4 | `GroupPresenceSummaryWork.converge` local-retry tests | `exposes single-attempt presence-summary phases for a queue-owned transaction`, PGlite summary reservation-fence rollback, and the read-through-cache phase adapter | Summary read/compute/validate occur outside one caller-owned write transaction; reservation generation, summary CAS, downstream rows, and completion are atomic. |
| 5 | Predecessor snapshot publication assumptions | PGlite AppGroup vertical test asserts zero `WS_OUTBOX` rows after group commit and before summary processing, then exactly three after summary convergence | A group mutation never publishes a snapshot carrying an unconverged predecessor summary. Only the summary handler publishes the event, member snapshot, and directory snapshot. |
| 6 | Isolated event or receipt failure tests that did not cover the final outbox | PGlite group-event collision rollback and group-summary ResourceInbox collision rollback | Divergent event or summary identity leaves aggregate state unchanged, no mutation receipt, no accepted event, and no new summary work. The pre-existing collision row remains the sole winner. |

The two removed inner-retry tests are not silent coverage deletion: row 1 owns
complete outer retry/policy evidence, while `group-state-guarded-batch-behavior`
now checks that the guarded runtime batch contains authoritative state and the
compact receipt only, with the final ResourceInbox entry kept outside the batch
but inside the received SQL transaction.

## Validation

- `npx vitest run packages/tests/shared-server/group-app-inbox-authority.test.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-state-service-idempotency.test.ts packages/tests/shared-server/presence-expiry-reconciliation-service.test.ts packages/tests/shared/resource-inbox-repository.test.ts`
  - 5 files passed; 172 tests passed; 0 failed; no skipped task tests.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/services/group-state-service.test.ts`
  - 31 tests passed; 0 failed.
- `npx vitest run packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts`
  - 2 files passed; 22 tests passed; 0 failed.
- `npx vitest run packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/shared-server/group-state-guarded-batch-behavior.test.ts packages/tests/shared-server/group-state-mutation-read-retry.test.ts`
  - 3 files passed; 50 tests passed; 0 failed.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/db/pglite-sql-adapter.test.ts`
  - 38 tests passed; 0 failed.
  - Includes the real PGlite AppGroup vertical commit, exact event replay and
    divergent collision, predecessor WS absence, reservation-generation
    rollback, and group event/receipt/summary-outbox rollback tests.
- `npm run typecheck`
  - Passed for the root and every workspace typecheck.
- `npm run test:unit`
  - Task 6 coverage passed. Cumulative result: 464 files and 4,985 tests
    passed; 4 files and 18 tests skipped; 3 files and 4 tests failed.
  - One known repository-boundary failure reports the three pre-existing
    TypeScript-compiler-based structural test files. The other three failures
    are sandbox-only `EPERM` listener/tsx IPC failures in black-box harness
    tests. No Task 6 group, AppInbox, ResourceInbox, summary, cache, or PGlite
    test failed.
- `npm run check:repo-style`
  - Could not run because the command and the referenced
    `docs/repo-human-style-guide.md` are absent from this checkout.
- Static scan across the group service, guarded writer, AppGroup service,
  presence-summary worker, mutation module, cached facade, and expiry bridge
  - No service-local `sleep`, backoff, in-process lane, nested `begin`, legacy
    drainer wake, sync publisher, row lock, or advisory lock path.
  - The only group-side reference to the historically named
    `StateMutationOutboxRepository` is its generic canonical command hash helper;
    no state-mutation outbox candidate, row, work item, writer, or drainer is
    created or consumed by group mutations.

## Tradeoffs and follow-up

- Task 13 must reconcile stale statements in
  `packages/shared-server/architecture.md`: it currently says only service write
  opens a transaction, applies the old shared `[0, 2, 8]` service retry policy
  to groups, routes group effects through `StateMutationOutboxWork`, and assigns
  groups a per-service FIFO lane. The implemented group path instead uses the
  AppInbox caller transaction, QueueBox's 20-attempt schedule (1/2/4/8/16 ms,
  then seconds), direct summary ResourceInbox work, and no group-local lane.

- Legacy direct-service behavior suites use a test-only phase adapter. It is not
  exported by production code and cannot be reached from HTTP, WebSocket,
  expiry, or disconnect cleanup composition. Architectural retry evidence lives
  in AppGroup tests, not in that compatibility adapter.
- QueueBox's `FOR UPDATE SKIP LOCKED` reservation mechanism remains an approved
  queue-claiming exception. Group authoritative state writes themselves use CAS
  and do not acquire database row, table, or advisory locks.
- The canonical command hash helper still resides in the historically named
  `StateMutationOutboxRepository.ts` because other unconverted mutation families
  import it. Moving the generic helper can be done as a separate naming cleanup;
  it is not a group outbox dependency.
- The native/live Postgres integration and distributed black-box gates were not
  run because this worktree has no managed Postgres/API/browser stack. The
  transaction semantics were exercised against the real PGlite SQL adapter;
  live Postgres remains an environment-dependent integration gate.
