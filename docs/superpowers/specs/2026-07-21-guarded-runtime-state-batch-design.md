# Guarded runtime-state batch design

> **SUPERSEDED FOR API-V1 MUTATION OWNERSHIP.** This document preserves
> historical evidence only. Its service-owned transaction and three-attempt
> retry text is not current architecture precedent. The replacement is
> [the approved 2026-07-22 AppInbox transactional mutation design](./2026-07-22-api-v1-app-inbox-transactional-mutations-design.md),
> where AppInbox owns transaction and retry and services receive the transaction.

## Status and objective

This design follows the rejected fixed-handoff experiments recorded in
`2026-07-21-in-process-cas-contention-suppression-design.md`. Scheduler delays
improved fairness but increased collisions and wall time because a delay that
lets a remote retry start does not necessarily let its complete reread,
reauthorization, revalidation, and compare-and-set commit finish.

The objective is instead to shorten the database interval during which a
successful authoritative guard remains transactionally open. PostgreSQL may
execute one guard-dependent runtime-state batch per mutation attempt. Database
CAS remains the sole authority; the batch adds no row, table, or advisory lock,
no retry, no sleep, and no domain read.

This is a performance optimization of the existing `writeX` phase. It must not
change the three-attempt `[0, 2, 8]` retry policy, the complete retry boundary,
authorization or policy checks, public semantic versions, idempotency, outbox
ownership, or the sequential behavior of repositories without the capability.

## Considered approaches

1. **One guard-dependent PostgreSQL statement. Selected.** A data-modifying CTE
   statement applies one conditional guard and makes every dependent mutation
   consume the guard's `RETURNING` row. It removes JavaScript/database round
   trips while keeping guard-first ordering and atomic rollback visible.
2. **`Promise.all` after the guard. Rejected for the pilot.** It is smaller, but
   transaction clients are not required to pipeline calls and a single
   connection may still execute the statements sequentially. It also cannot
   provide one exact applied-identity result without adapter-specific behavior.
3. **A topology-specific SQL fast path. Rejected.** Services must remain
   provider-neutral. PostgreSQL details belong in the runtime-state adapter.
4. **More retries, longer delay, jitter, or database locks. Rejected.** These
   change the approved retry contract, repeat the failed timing strategy, or
   violate the lock-exception policy.

## Capability boundary and mandatory contracts

The existing base repository does not gain an optional method. A separate
`RuntimeStateGuardedBatchRepositoryLike` interface and type guard expose the
capability. Transaction repositories returned by PostgreSQL implement it;
non-PostgreSQL and fake repositories continue through the existing sequential
transaction code unless a focused test implementation intentionally supports
the capability.

Batch values use mandatory discriminated fields. Each variant contains every
field needed to execute and verify it; meaningful absence is represented by a
different variant rather than optional properties.

- Conditional insert: operation, identity, value, physical expiry.
- Conditional update: operation, identity, expected revision, value, physical
  expiry.
- Conditional delete: operation, identity, expected revision.
- Guard-authorized put: operation, identity, value, physical expiry. This is
  allowed only as a dependent effect after the guard and retains the current
  aggregate-owned last-write contract for member rows.

Identity is the mandatory namespace/key pair. The batch input contains exactly
one conditional `guard` and a dense `effects` array. Each effect also has a
mandatory caller-owned effect ID. Domain meaning stays in the service: effect
IDs let group/topology code classify a missing receipt as a retryable
idempotency race while preserving the existing non-retryable outbox collision
error. The generic adapter does not know domain roles.

The result contains the applied guard result or explicit guarded conflict, plus
a dense result for every input effect in input order. An insert/update guard
carries `resultingRevision`; a delete guard carries `matchedRevision`. Applied
insert/update/put results carry effect ID, operation, identity, and mandatory
`resultingRevision`. An applied delete instead carries mandatory
`matchedRevision`, because no stored revision exists after deletion.
Skipped/conflicted results carry the same complete identity plus a mandatory
reason. There is no sparse result object.

The generic validator rejects before SQL:

- an empty or sparse effect list representation;
- duplicate effect IDs;
- duplicate namespace/key identities, including the guard identity;
- invalid namespace/key/value/expiry values;
- an expected revision that is negative zero or outside its operation-specific
  safe range: update accepts `0..Number.MAX_SAFE_INTEGER - 1`, while delete
  accepts `0..Number.MAX_SAFE_INTEGER` because it does not increment;
- a put used as the guard; and
- an operation outside the provider-neutral guarded-batch operation union.

## PostgreSQL statement shape

The adapter sends one tagged, parameterized statement. Descriptors are passed
as JSON and expanded with `jsonb_to_recordset` (or an equivalently fixed
parameterized shape); descriptor values never become SQL source text.

The statement has distinct guard insert, update, and delete CTEs. Exactly one is
eligible from the discriminant. A read-only `authority` CTE unions their
`RETURNING` rows. Every protected insert, update, delete, or put CTE explicitly
selects from or joins `authority`. If the guard returns zero rows, every
protected CTE has zero input and cannot write.

All mutations target `runtime_state_store`. PostgreSQL data-modifying CTEs share
one snapshot and their base-table changes are not mutually visible. The design
therefore does not rely on one dependent CTE observing another dependent CTE's
table changes. It relies only on the guard's `RETURNING` relation as an
authorization token, and it rejects duplicate row identities so no row is
modified twice in the statement. Callers must not introduce a dependency
between two effects; such a mutation remains on the sequential path.

The final query returns the guard result and an exact effect-result row for each
descriptor. The adapter validates density, uniqueness, identity, operation,
effect ID, and operation-discriminated revision before returning. If PostgreSQL or PGlite cannot safely
report this exact set, the pilot stops; it must not fall back to dynamic SQL or
weaken result checks.

## Transaction and failure semantics

Services continue to call the batch only inside their existing `runtime.begin`
`writeX` transaction. The guarded-batch type guard is applied to the repository
passed into the `begin` callback; callers do not assume that an outer repository
capability survives transaction construction. All descriptors are materialized
and validated before `begin`; the callback performs no domain read,
authorization, clock access, ID generation, or sleep.

The callback accepts the result only when:

- the guard applied exactly once at the expected identity and revision;
- every target, generation, admission, summary, member, and receipt
  effect produced its exact expected result; and
- the mandatory outbox effect produced its exact expected result.

A missing conditional guard, target, generation, admission, summary, or receipt
result throws `RuntimeStateWriteConflictError` before the callback returns. The
surrounding transaction rolls back the guard and every effect, and the service
restarts at read after the unchanged backoff. A missing outbox result throws the
existing outbox collision error and also rolls back every effect. A member put
has no legitimate conflict after the guard applied, so a missing put result is
invariant corruption rather than a retryable conflict. Other unexpected or
duplicate result rows are likewise invariant corruption, never a partial
success; an operational SQL error propagates unchanged.

The sequential path remains the semantic oracle. Capability and fallback must
return the same receipt, preserve the same typed errors, and leave equivalent
logical rows: equal namespace, key, stored-value bytes, physical expiry, and
revision for runtime state, plus equal `group_state_events` values. PostgreSQL
`updated_ts` is assigned by the database clock at execution and is explicitly
excluded from cross-execution byte-equivalence claims.

## Topology config bundle

For `write`, the root is the group authority-fence CAS. Guard-authorized effects
are:

1. config or override conditional insert/update/delete;
2. invariant-generation conditional insert/update;
3. target-generation conditional insert/update;
4. optional idempotency-receipt conditional insert; and
5. mandatory state-mutation-outbox conditional insert.

For `claim`, the same authority-fence CAS guards only the idempotency-receipt
conditional insert. It has no target, generation, or outbox effect. Replay and
no-op outcomes never open a transaction or create a batch.

The existing wake-up remains after the committed `write` returns. It is not an
effect in the batch.

## Group bundle

The root is the existing group-row or presence-session conditional
insert/update/delete guard. Its dependent effects are the already computed
subset of:

1. presence-admission conditional insert/update;
2. aggregate-owned member puts;
3. initial presence-summary conditional insert;
4. idempotency-receipt conditional insert;
5. mandatory state-mutation-outbox conditional insert.

Presence operations still bypass the group aggregate's in-process FIFO lane,
but their database write may use the same guarded batch with the
presence-session row as root. No routine heartbeat rewrites the group row.

Member puts are safe only because the group/presence guard returned authority
and identities are unique within the batch. They do not become general
last-write-wins APIs outside this aggregate-owned write path.

Production group events use the SQL state-event repository rather than
`runtime_state_store`, so they are deliberately not smuggled into this generic
capability. The service appends the already-computed event immediately after a
successful guarded batch and before the existing transaction callback returns.
An event error still rolls back the batch. The capable group path therefore has
one guarded runtime-state statement plus the existing event statement. Event
composition is unchanged for every path: `repositoryFor(transaction)` creates
the event store from the same transaction repository exactly as the sequential
oracle already does. The service does not inspect a PostgreSQL class or invent a
second provider capability. A custom factory retains its existing obligation to
honor the transaction repository it receives. This explicit remainder is part
of the measured pilot and must not be reported as a one-statement whole group
mutation. `GroupStateEventCollisionError` remains non-retryable; it is never
reclassified as a CAS conflict.

## TDD and verification sequence

1. **Contract RED.** Add tests for mandatory discriminated descriptors, dense
   inputs/results, duplicate identity/effect rejection, capability detection,
   and exact result validation.
2. **SQL RED.** Through the instrumented PostgreSQL/PGlite adapter, require one
   tagged statement, parameterized descriptor transport, guard-root dependency
   for every protected CTE, exact applied identities, and no lock syntax.
3. **Atomic matrix RED.** Force guard, target, each generation, receipt, and
   outbox conflicts separately. After each failure, assert that the guard
   revision and every state/receipt/outbox/event row are unchanged or absent.
   Separately force `GroupStateEventCollisionError` after a successful guarded
   batch and prove the guard, members/admission/summary, receipt, and outbox all
   roll back while the event error remains non-retryable.
4. **Topology RED/GREEN.** Prove capability selection, `write` and `claim`
   effect sets, replay/no-op zero-batch behavior, fallback equivalence, and a
   two-client collision where the loser sleeps exactly 2 ms, fully rereads and
   revalidates, then commits.
5. **Group RED/GREEN.** Prove the group and presence effect sets, fallback
   equivalence, write-only transaction boundaries, authority and policy reruns,
   exact receipts/outboxes/events, and independent-client convergence.
6. **Architecture gates.** Rerun the guard-first structural contract, atomic
   outbox contracts, optional-field audit, no-lock scan, focused suites,
   shared-server typecheck, formatting, and diff checks.
7. **Governed producer.** Run the unchanged PostgreSQL producer and comparator.
   Do not add throughput/exhaustion reasons or weaken the frozen baseline.

Tests instrument transaction activity and fail if retry sleep occurs while a
transaction is active. The SQL capability test also proves one guarded DML call
per capable attempt; the fallback is not required to report one call.

## Performance acceptance and stop conditions

The current FIFO-only candidate remains the comparison point for diagnosis;
the immutable Task 0B baseline remains the gate. The batch candidate must:

- keep uncontended behavior within the frozen budgets;
- reduce statements and transaction/write duration for capable topology and
  group attempts;
- produce zero shared exhaustion and no more hot exhaustion than the baseline;
- exceed shared throughput `752.2423201768095/s` and meet hot throughput
  `295.1851420383843/s`;
- retain exact three-attempt `[0, 2, 8]` histories and complete retry
  revalidation evidence; and
- retain complete receipts, atomic outboxes, and an empty DBW finding set.

The experiment is rejected if exact result reporting is unsafe, atomic rollback
cannot be proven, statement/transaction work does not improve, or governed
throughput regresses. A failed batch is removed or redesigned; it is not
retained as documentation-only performance debt.
