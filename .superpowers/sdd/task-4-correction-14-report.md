# Task 4 correction 14 report: validate production state evidence

## Status and scope

Status: implementation and validation complete; awaiting the fresh whole-range
review recorded below before commit.

This correction starts at clean Task 4 head
`f718827b880729d61742811cb7b10d94b31b72f6`. It resolves all three review-14
Important findings without starting Task 5/6, changing workload scale/mix/
concurrency or schema v3, updating progress, modifying the immutable baseline,
adding locks, weakening candidate gates, pushing, or replacing production
repositories/services with permissive fakes.

Correction 14 supersedes correction 13 only for final Task 4 acceptance and
production-derived performance evidence.

## Exact RED evidence

Focused RED was established before production changes:

- the performance source test found `ResourceInboxRepository`, the production
  attempt helper was absent, an ID-only receipt passed, and the candidate used
  the legacy durable contract: 3 selected failures;
- a canonically keyed Group missing mandatory `joinMode` was returned instead
  of typed corruption: 1 selected failure;
- a cast GroupEvent missing mandatory `actor` appended successfully in PGlite:
  1 selected failure.

The first real correction-14 producer run additionally failed during shared
warmup with `Invalid production conflict attempt ...`. This was a genuine
evidence-model defect: client/group services publish exact zero-based attempts
(`0,1,2`), while the harness had assumed one-based attempts. The final design
retains those production numbers and derives accepted terminals from successful
production `mutation.write`, or `mutation.validate` for no-op paths.

## Production-derived performance evidence

Timed commands now end when the production service call ends. The harness no
longer imports or writes Resource Inbox benchmark receipt/outbox topics. After
the measured phase, an uninstrumented admin SQL stack reads:

- complete client idempotency receipts for both profile and instance
  subcommands before projecting one profile-instance receipt;
- complete group idempotency receipts at each exact request ID;
- real pending `StateMutationOutboxRepository` records and their production
  effects.

Evidence mapping is exact:

- profile-instance: two real `client-state-sync` effects;
- membership, connect, heartbeat, disconnect, and config: real
  `group-state-sync` and `group-presence-summary` effects;
- topology-source: no invented record. The current non-candidate diagnostic
  records the exact DBW-06/DBW-12 gap until Task 5 supplies production topology
  persistence.

Outbox evidence IDs combine the real outbox ID and effect. Evidence reads occur
after latency, SQL/resource delta, timing, and PostgreSQL counter capture.
Production runtime-state outbox SQL remains classified as outbox timing from
the real bound namespace value.

Retry histories use exact correlated production events. Example accepted
history after two conflicts is attempts `0 conflicted`, `1 conflicted`,
`2 accepted`, with terminal source `client-state-service.mutation.write`.
Typed exhaustion turns the final real `mutation.conflict` into the terminal;
it must retain at least one preceding production conflict. Only an explicitly
labeled `state-write-command-envelope.prerequisite-exhausted:*` causal
non-invocation may be a one-observation synthetic terminal at attempt 1.

Governed `pre-remediation-baseline` metadata alone selects the immutable legacy
durable contract. All other artifacts select the production contract. Only
exact `task4-production-evidence-diagnostic` governance may use the current
topology return marker and waive exactly the `{DBW-06, DBW-12}` topology gap.
A Task 10 candidate must use the production topology timing source and complete
receipt/effect evidence; candidate DBW tags never waive uniqueness, linkage,
shape, retry, or durability rules.

## Complete group and event contracts

`GroupStateRepository` reuses the canonical persisted Group, GroupMember,
GroupPresenceSession, GroupPresenceAdmission, and GroupPresenceSummary
validators on every direct, entry, prefix-list, all-list, snapshot, and page
boundary. Validator and cross-row roster failures are wrapped as
`GroupStateRepositoryInvariantCorruptionError` with the physical storage key.
The incomplete-generation filter was removed; missing generation identity is
corruption, never offline absence.

`PSqlGroupStateEventRepository` reuses the canonical complete GroupEvent
validator before append and after parse. Every group list/recent/page query,
including subqueries, selects physical event type, snapshot version, occurrence
time, and event ID. JSON must exactly match those physical columns and requested
scope before filtering, ordering, return, or cursor projection. Failures use
`GroupStateEventRepositoryInvariantCorruptionError`.

Memory and PGlite injections cover missing `joinMode`, `generationId`, member
status, admission timestamp, and summary causal revision across direct/list/all/
snapshot/page reads. PGlite event injections cover missing actor and each
physical column mismatch across list, recent-list, and page paths. Existing
sparse test fixtures were upgraded to canonical rows rather than weakening the
new boundaries.

## Durable skill guidance

Five unguided controls were run before guidance edits; all resisted the offered
shortcuts, while review 14 remained the concrete observed gap. Minimal generic
wording was added only to `rallar-code-writing` and `performance-analysis`:
complete authoritative public read contracts and SQL physical-column agreement;
production receipt/outbox/timing evidence and strict legacy/candidate isolation.

Five fresh guided samples then combined deadline, compatibility, incomplete
row, synthetic evidence, duplicate-ID, and zero-conflict-exhaustion pressure.
All five selected fail-closed complete validation and production evidence; none
filtered, inferred, repaired, synthesized, or accepted an either-contract
candidate. Skill integrity passed 8/8.

## Validation evidence

Fresh final results:

```text
Focused skill/performance/group/API-repository matrix: 4 files, 143 tests passed
Focused performance artifact suite after final governance: 39 passed
Full PGlite adapter suite: 18 passed, 0 failed
Both native Deno perf checks: passed
Full shared-server Vitest: 56 files passed, 2 configured skipped;
  577 tests passed, 7 configured skipped
API-v1 `deno task test`: 206 passed, 0 failed
Root/workspace `npm run typecheck`: passed
API-v1 `deno task check` and `deno task lint`: passed; 76 files linted
Shared-server workspace lint/typecheck: passed
Live PostgreSQL presence/concurrency suite: 6 passed, 0 failed;
  100-heartbeat case 1723 ms on final run
Memory API-v1 black-box matrix: 11 passed, 0 failed, 0 skipped;
  group-presence 17 successful steps
Three-group fanout smoke: 3 snapshots, 5 semantic prefix reads,
  0 point/all-entry reads, maximum 3 rows per prefix read
`git diff --check`: passed
```

The unchanged-scale real producer completed with
`--backend=postgres --warmup=1 --runs=3 --concurrency=10`; the ignored artifact
is `tmp/perf/api-v1-state-write-correction-14.json`. Imported standalone
validation returned `[]`.

```text
uncontended: accepted 2100, conflicted 0, exhausted 0,
  receipts 1800, outbox effects 3600
shared: accepted 1970, conflicted 366, exhausted 130,
  receipts 1670, outbox effects 3340
hot: accepted 1137, conflicted 913, exhausted 963,
  receipts 837, outbox effects 1674
all workloads: dbwFindings exactly [DBW-06, DBW-12]
```

The 300-receipt/effect gap in every workload is exactly the 300 accepted
topology-source commands across three measured samples. It is an honest Task 4
diagnostic, not a Task 10 candidate pass. Shared/hot typed exhaustion has
positive real conflict evidence and remains subject to unchanged future gates.

Architecture scans found no added row/table/advisory lock, direct state
publication, scope/key leakage, or benchmark-only Resource Inbox evidence.
Canonical validators and all event physical columns are present at the new
boundaries. The Task 0B baseline SHA-256 was exact before and after:

```text
ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7
```

`deno fmt --check` was not used as a gate because these touched package files
use the repository's established four-space style and were already not
whole-file Deno-formatted; mass formatting would create unrelated churn.
Introduced lines were kept consistent locally, native checks passed, and
`git diff --check` passed.

## Fresh whole-range review

A fresh pre-commit correction-level reviewer inspected `551e283a` through the
complete correction-14 working tree. The first pass found three Important gaps:
generic exceptions for null/invalid JSON rows, hidden partial profile outbox
effects, and permissive prerequisite evidence. The same implementer reproduced
and fixed all three. A follow-up spoof probe also tightened exact terminal shape
and service-family sources. The final fresh verdict was:

```text
Spec: PASS
Quality: APPROVED
Advance to Task 5: YES
```

The parent will run an additional post-commit whole-range review from the clean
commit before actually advancing Task 5.

## Handoff

Task 4 now derives durability/retry/timing claims from production state and
fails closed at complete group/event persistence boundaries. Task 5 remains
out of scope and must not begin unless the parent advances it after the required
exact `PASS / APPROVED / YES` review verdict.
