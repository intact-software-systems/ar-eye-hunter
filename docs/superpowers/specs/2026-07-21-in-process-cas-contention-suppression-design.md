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

## Rejected fixed-handoff experiment (2026-07-21)

A follow-up experiment delayed a queued local successor for 3 ms after each
eligible successful write. It was intended to let an already-conflicted remote
stack complete its retry. The governed PostgreSQL result rejected that design:

| workload | FIFO lane only | 3 ms handoff | result |
| --- | ---: | ---: | --- |
| uncontended | 2100 accepted, 0 exhausted, 765.645/s | 2100 accepted, 0 exhausted, 768.911/s | noise |
| shared | 2020 accepted, 80 exhausted, 453 conflicts, 581.865/s | 2061 accepted, 39 exhausted, 463 conflicts, 561.441/s | slower, still exhausts |
| hot | 1849 accepted, 251 exhausted, 332 conflicts, 286.527/s | 1956 accepted, 144 exhausted, 576 conflicts, 193.148/s | 32.6% lower throughput |

Shared duration increased from `3471.595` to `3670.912` ms. Hot duration
increased from `6453.138` to `10126.934` ms; hot SQL statements increased
`12710 -> 14081`, rows `91256 -> 112247`, and serialized bytes
`103681283 -> 127608727`. The handoff artifact is preserved as
`tmp/perf/api-v1-state-write-handoff-3ms.json` with SHA-256
`8047b9bbb13028f04a14b4faa0c73209a5890c9adea148c0c0eb10269ebcba99`.
The producer also overwrote the candidate path with the same bytes, so the
pre-handoff comparison above uses the immutable metrics recorded in the task
report rather than claiming a still-present per-command artifact.

A deterministic two-lane, 20-command-per-lane model then compared no handoff,
every-write handoff, and a proposed quota of two eligible local successes per
handoff. It retained three attempts and `[0, 2, 8]`, a 0.5 ms conflict
observation lag, and nonzero measured-shape work stages: 1.2 ms reread, 0.1 ms
authorization/compute, 0.1 ms validation, and 2 ms transaction. Every conflict
reran read and validation, and no retry or handoff delay occurred in a
transaction.

| policy | accepted / exhausted | conflicts / reads | elapsed | handoffs | remote commit before successor CAS |
| --- | ---: | ---: | ---: | ---: | ---: |
| none | 40 / 0 | 19 / 59 | 127 ms | 0 | n/a |
| every write | 40 / 0 | 39 / 79 | 243 ms | 38 | 0 / 38 |
| quota two | 40 / 0 | 19 / 59 | 154 ms | 18 | 9 / 18 |

Quota two bounded each local commit streak at two and used nine handoffs per
stack, but failed the required cross-stack ordering in half its handoff
windows. The timer let the retry start; it did not cover the peer's complete
reread, reauthorization, revalidation, and CAS commit. Both the every-write
and quota variants are therefore rejected and are not shipping behavior. The
original per-service FIFO lane remains because it suppresses only avoidable
same-instance overlap and adds no timing policy.

The next approved experiment shortens guard-held database work rather than
coordinating schedulers. Its provider-neutral capability, PostgreSQL statement
shape, group/topology effect sets, rollback rules, and performance stop
conditions are specified in
`2026-07-21-guarded-runtime-state-batch-design.md`.
