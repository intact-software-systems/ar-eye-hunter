# In-process CAS contention suppression design

## Context and objective

The governed API-v1 state-write candidate preserves durable correctness but
fails the frozen performance comparator under shared and hot contention. The
exhaustions are concentrated in aggregate-backed group membership/metadata
writes and group topology config writes. Presence-session writes, which use
their own guards, are not the source of the conflicts.

The objective is to suppress avoidable same-process compare-and-set collisions
without changing the immutable three-attempt `[0, 2, 8]` retry policy, reducing
the benchmark workload, or introducing database row, table, or advisory locks.
Database CAS remains the only correctness and authority boundary.

## Considered approaches

1. Add a per-service, per-aggregate FIFO lane. This is the selected approach.
   It removes same-instance thundering herds while preserving independent lanes
   and normal CAS conflicts between service instances and processes.
2. Add jitter, longer delays, or more retries. This could reduce collisions but
   would change the immutable retry contract and could hide rather than remove
   avoidable same-instance contention.
3. Serialize in PostgreSQL or through process-global state. Database locks are
   outside the approved architecture, while process-global coordination would
   make independently constructed service stacks appear more coordinated than
   separate production processes really are.

## Lane component

A package-internal `InProcessMutationLane` owns a map from canonical aggregate
key to a promise tail. `run(key, effect, options)` appends an effect after the
current tail for that key. Effects for the same key start in submission order
and never overlap; effects for distinct keys remain concurrent.

The lane is deliberately best-effort. It does not read state, authorize a
request, validate domain policy, open a transaction, or decide whether a write
may commit. It cannot coordinate with another lane or process. Each effect is
the existing complete read, compute, validate, conditional-write retry loop,
so a cross-instance collision still causes a fresh read and full revalidation.

A rejected effect does not poison its successor. When the last queued effect
settles, it removes the key only if its own tail is still current, preventing an
older completion from deleting a newer queue. An optional `AbortSignal` may
cancel an effect only before it acquires the lane. Once an effect starts, abort
does not release the lane early because its database work may still be active.
Skipped aborted effects and rejected effects both participate in normal tail
cleanup. A read-only pending-key count supports lifecycle diagnostics and tests.

## Service integration

Each `GroupStateService` instance creates one lane. Aggregate-backed commands
use the canonical scoped group key and enter the lane before the retry loop.
The presence operations `connectPresence`, `heartbeatPresence`, and
`disconnectPresence` bypass the aggregate lane because their authority guard is
the per-session presence row. This preserves the Task 4 contention split.

Each `GroupTopologyManagementService` instance creates a separate lane.
`putConfig`, `deleteConfig`, `putOverride`, and `deleteOverride` enter it through
the shared topology-config mutation executor, keyed by scoped group. Topology
reads, RTC publication/snapshot work, RTT writes, and client-state writes remain
unchanged.

Lanes are not shared between separately constructed service instances. The API
composition and the benchmark therefore retain real inter-instance CAS races.
No service accepts the lane as persisted state or an authorization dependency.

## Error and cancellation behavior

Domain, authorization, idempotency, retry-exhausted, and repository errors pass
through unchanged. The lane adds no retry and catches failures only to normalize
its internal tail. A queued abort rejects that caller with an `AbortError`
without invoking the effect; it does not affect preceding or following work.
There is no cancellation input on current state-mutation service methods, so
service behavior is unchanged unless a future internal caller explicitly uses
the lane's optional signal.

## Verification

TDD coverage will prove:

- same-key FIFO ordering and non-overlap;
- distinct-key concurrency;
- successor progress and map cleanup after rejection;
- pre-acquisition abort skips the effect and cleans the key;
- same-service aggregate mutations are suppressed before repository work;
- separate service instances still overlap, conflict, perform the unchanged
  bounded retry, and converge through CAS;
- presence mutation work is not blocked behind an aggregate mutation lane;
- topology config/override mutations receive the same per-instance behavior.

Focused group/topology suites, architecture contract tests, shared-server
typechecking, and the repository style scan follow implementation. The exact
PostgreSQL producer then overwrites only
`tmp/perf/api-v1-state-write-candidate.json`, followed by the unchanged
comparator. Medium-scale validation does not start unless that comparator
passes.

## Documentation constraint

Shared-server architecture guidance must describe the lane as optional
same-process conflict suppression and explicitly forbid treating it as a
correctness authority, a substitute for CAS, or precedent for database locks.
