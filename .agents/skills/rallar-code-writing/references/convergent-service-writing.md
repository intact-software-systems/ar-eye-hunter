# Convergent Service Writing

Read this reference for authoritative database or realtime service mutations.
It is the canonical implementation doctrine for those services. Specialist
skills add domain facts; they do not replace or restate this contract.

## Contents

- [Human-readable service shape](#human-readable-service-shape)
- [Transaction and retry ownership](#transaction-and-retry-ownership)
- [Specialized ResourceInbox transaction ownership](#specialized-resourceinbox-transaction-ownership)
- [Optimistic persistence](#optimistic-persistence)
- [Permissive convergence](#permissive-convergence)
- [Protocol and timing traceability](#protocol-and-timing-traceability)
- [IDE causal-navigation mutation probe](#ide-causal-navigation-mutation-probe)
- [Verification](#verification)

## Human-readable service shape

Use a functional core with an explicitly owned stateful shell:

- parsing, authorization policy, computation, validation, reconciliation, and
  candidate construction are data-in/data-out functions;
- repositories, transactions, clocks, randomness, transports, caches, and
  subscriptions stay in narrow side-effect adapters;
- state belongs in an object only when that object clearly owns its lifecycle;
- a service owns one coherent business capability, one ownership boundary, and
  one reason to change.

Capability cohesion is judged by responsibility, not method count. Several
methods that own one transaction phase may form one narrow capability; several
unrelated methods do not become cohesive merely because the count is small.

Keep the control flow visible as the exact direct sequence
`read -> compute -> validate -> write(transaction, computed)`. `read` performs
the required repository reads. The `compute` and `validate` phases are pure
under the authoritative repository code standard; `compute` returns the
persistence-ready value and no later preparation phase transforms it. Computed
persistence data is not called a plan. Apply the transaction-write purity and
database-result refinement rules from the authoritative repository code
standard. The stateful shell records timing around each direct phase and around
the AppInbox transaction separately. Do not hide decisions behind manager,
coordinator, or pass-through helper chains.

Model the domain decision separately from the conditional write outcome:

- a decision is `apply`, `no-op`, or `reject`;
- an attempted write is `written` or `conflict`;
- `reject` is a typed domain result, not an exception;
- `conflict` returns to the retry owner for a complete new attempt.

This vocabulary keeps permissive convergence precise. It does not mean errors
are swallowed or invalid input is accepted.

## Transaction and retry ownership

AppInbox is mandatory for incoming database mutations, including every HTTP
and WebSocket client, group, topology, authentication/session/ticket, CRDT
append/admin, and mutating administration path. A synchronous result wait never
falls back to a direct service mutation.

AppInbox owns the transaction and retry boundary through QueueBox redelivery,
not through a loop around the handler. One queue delivery performs one mutation
attempt. A conflict exits that attempt; queue redelivery starts again from
`read`, then recomputes and revalidates authorization, policy, capacity,
lifecycle, invariants, and the complete candidate. The service write receives
the transaction and never opens, commits, replaces, or retries one. Retrying
only a stale final write is incorrect.

The write callback obeys the closed database-result grammar in the authoritative
repository code standard. A redelivered attempt repeats the whole
`read -> compute -> validate -> write(transaction, computed)` sequence with
fresh data.

## Specialized ResourceInbox transaction ownership

Policy follows the resolved transaction opener and owner, not a source path.
AppInbox and domain-owned transactions use `strict-domain-write`, including
when their callback invokes a ResourceInbox repository. Calling ResourceInbox
code from an AppInbox or domain-owned transaction does not transfer the
specialized policy.

Use `specialized-resource-inbox` only when type and API resolution prove an
exact PostgreSQL ResourceInbox, Results, or QueueBox transaction owner. These
transactions implement atomic middleware reservation, deduplication, result,
replacement, and queue coordination semantics in SQL. The owner may bind SQL
parameters, execute those statements, compare or normalize rows returned by the
current statement, and transform only those returned rows when the operation is
bounded by an explicit one-row result or caller-supplied batch limit. Unlike
`strict-domain-write`, `transaction.precomputable-work` does not apply to this
exact middleware work because its decision and rollback semantics exist only in
the specialized transaction.

Outside the exact winner-materializer allowance below, the specialized policy
prohibits ordinary domain mutation logic, transformations of caller-provided
domain values, external effects, timers, polling, processing rows without an
explicit bound, arbitrary operation callbacks, caller-owned mutation, and an
unrelated nested transaction. Inside the winner materializer, external effects,
timers, polling, unbounded work, caller-owned mutation, unrelated nested
transactions, and any callback beyond this exact supplied materializer remain
prohibited.

The one externally supplied operation-callback shape permitted by this policy
is the exact guarded winner materializer. The ResourceInbox owner must first
reserve the exact identity through its conditional SQL write, invoke the
materializer exactly once only on the winning branch, verify that the
materialized identity matches the reservation, and replace the placeholder in
the same transaction. This bounded callback may perform the operation-owned
clock capture, identifier generation, serialization, and row construction that
creates the winner's persistence payload from its immutable command input. This
is the sole exception to the general prohibition on transforming supplied
domain values inside the specialized transaction. A losing or replay branch
never invokes it. Any callback or replacement failure relies on PostgreSQL
rollback, so do not replace this shape with a lease, heartbeat, polling loop,
marker row, or after-commit repair protocol. Other conditional callbacks such
as general `enqueueIf` or `enqueueOrUpdate` callbacks are not winner
materializers and remain prohibited by this policy.

Transaction, retry, lifecycle, and after-commit dependencies use a named port
declared beside the canonical owner. From a consumer, Go to Definition reveals
invocation, retry, commit, and failure semantics instead of an anonymously
duplicated signature.

The operation-specific conditional guard is the first write. In the same
transaction, write authoritative state, event, receipt, durable result, and
final `APP_OUTBOX` or `WS_OUTBOX` rows directly through
`ResourceInboxRepository`. There is no intermediate mutation outbox. Final
outbox insertion is insert-only: a collision rolls back the transaction and
never loads a winner. Resolve dynamic logical WebSocket audiences and wake
workers only after commit. Persist an immutable computed audience in the final
outbox message when one exists, then intersect it only with locally open
connections.

ResourceInbox permits 20 total processing attempts. Attempts one through five
wait 1, 2, 4, 8, and 16 ms. Later waits rise through seconds, cap at 30 seconds,
and use jitter. A separate best-effort fairness lane claims retries more than
30 seconds overdue independently of timeout recovery.

Queue locks are coordination-only for bounded ResourceInbox reservation,
timeout-recovery, and fairness claims. They are not domain authority. Do not
add row, table, advisory, or CRDT document locks. Any exception requires
explicit human approval, measured evidence, a documented invariant, a bounded
critical section, and a review or removal condition.

## Optimistic persistence

Use optimistic compare-and-set writes with bounded QueueBox redelivery attempts:

- create with conditional insert or `insertIfAbsent`;
- update with expected-revision compare-and-set or `upsertIfRevision`;
- delete or expire with expected-revision conditional delete or
  `deleteIfRevision`.

Expired reads are observational. The subsequent write matches the exact
observed revision; a stale expiry observation must not delete or overwrite a
refreshed value. An idempotency ledger is immutable per request
key: the losing writer reads the winner. That rule never applies to final
outbox collisions, which roll back.

Hash caller semantics before materializing server time or randomness. Preserve
omission as an explicit mandatory `null` command field. Only a validated ledger
miss may capture volatile values in immutable facts; reuse those facts across
every retry and replay. A matching replay returns the durable winner. Conflicting
key reuse is a typed rejection and invokes no volatile callback.

Build internal maintenance identity from a collision-safe canonical projection
of every semantic field except the identity being derived. Keep maintenance
behind a separately wired narrow capability, never caller-provided authority or
bypass fields. Authoritative user-write authentication dependencies are
mandatory and fail closed.

## Permissive convergence

An optimistic and permissive service is explicit about valid no-ops:

- accept newer revisions only after complete validation;
- ignore stale revisions as a typed `no-op`;
- treat a duplicate with the same canonical content as a typed `no-op`;
- treat equal revisions with different canonical content as invariant
  corruption;
- reject unknown authoritative variants, malformed input, unauthorized work,
  impossible transitions, and conflicting idempotency-key reuse;
- propagate classified repository failures rather than catch-and-log success.

Validate every persisted row's canonical key, decoded identity, complete
mandatory shape, and trusted command-slot relationships. Derive expected scope,
principal, session, target, and request identity from the command or decoded
canonical key, never from the stored candidate. Corrupt authoritative reads
fail closed; they are not misses to hide, rows to filter, or values to repair by
guessing.

Scoped storage keys are injective over field name, value type or presence, and
value. Escaping a string does not encode absence. Treat an ambiguous stored
identity as corruption; never repair it by guessing, fan out one row, or add a
dual-read fallback.

Validate the complete operation-specific candidate through deterministic
recomputation and exact comparison, including guards, dependent rows, events,
receipts, and outbox intents. Shared shape checks alone are insufficient.
Authoritative persisted, replicated, queued, event, snapshot, receipt, and
response contracts use mandatory fields by default. Sparse construction inputs
use separate types from complete outputs.

Authoritative snapshot collections that represent unordered sets use canonical
storage-key order in both the computed mutation result and durable repository
assembly. Never depend on arrival, insertion, or database/provider iteration
order. Preserve equal-revision content checks; ordering drift is a producer
bug, not eventual consistency. Domain skills own any additional liveness and
concurrency rules for their snapshots.

## Protocol and timing traceability

When a protocol discriminant already determines its payload shape, express that
existing relationship as a discriminated type-to-payload relationship. Repeated
case-local assertions are not an acceptable substitute. One boundary narrowing
may establish an existing typed protocol relationship, but it must not claim to
validate fields it did not inspect, silently add payload validation, or alter
runtime error timing.

An explicit timing or decorator owner uses a closed operation-name type and an
exhaustive operation inventory. Timing identity fields are deliberately
populated or removed only through separately approved observable-behavior work.

## IDE causal-navigation mutation probe

When authoritative mutation control flow changes, start at the concrete AppInbox
registration and perform the canonical 5/5 cold probe using only Go to Definition
and Find Usages. Reach the concrete operation entry, domain or update policy,
first conditional write guard, exact durable result, and after-commit effect.
Record search escapes, ambiguous business-interface pivots, and named deferred
boundaries. A passing test or analyzer report does not replace this manual probe.
When a family intentionally performs no after-commit work, reach the explicit
commit return that proves the absence and record it as the fifth landmark.

The transaction callback, repository, transaction-writer, queue, clock, gateway,
and sink remain legitimate named effect boundaries. Keep the business phases on
the caller side visible, and keep the callable edge to each boundary concrete.
Named functions passed through `Either` or another functional pipeline preserve
the edge; no controller or class wrapper is required.

## Verification

For every materially different AppInbox callback, transaction, retry, protocol,
or lifecycle family, produce a family-level code-derived trace as two distinct
timelines:

The two timelines separate registration from invocation.

1. A construction and registration timeline names each required or captured
   dependency's creation and owner, the callback registration point, the first
   point at which it can be invoked, and proves every required dependency exists
   before that point.
2. A runtime invocation timeline names:

- the external or protocol entry;
- callback registration owner and registration time;
- runtime invoker and callback invocation count or retry rule;
- representation translation and read, compute, validate, and write owners;
- transaction and retry owner and the first conditional guard;
- receipt, event, exact durable result, and final outbox writes;
- commit-return point and private after-commit data;
- after-commit effects, early exits, failures, and cleanup; and
- final caller-visible result and canonical versus compatibility paths.

Make retry re-entry and the transaction commit-return boundary explicit. The
fail-closed rule is that mutable values do not escape a transaction callback
unless the transaction contract proves invocation count, retry behavior, commit
semantics, failure behavior, and why mutation is safe. Prefer an immutable
callback result with separate durable-result and private after-commit
projections.

Semantic tests are primary. Source inventories, exact-tree checks, string
assertions, and line/count ratchets are supplementary and temporary, with a
named owner and removal condition. Tests prove decision and write outcomes
independently. Cover apply/written,
apply/conflict/rebase, permitted no-op, typed rejection, overlapping writers,
retry exhaustion, idempotency races, stale expiry, equal-revision corruption,
and deterministic final convergence at the real conditional-write boundary.
Do not substitute a lock-ordering test for convergence behavior.
