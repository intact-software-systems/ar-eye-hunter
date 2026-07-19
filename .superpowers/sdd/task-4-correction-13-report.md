# Task 4 correction 13 report: migrate reusable performance consumers

> Superseded by correction 14 for final Task 4 acceptance and for claims that
> durable benchmark evidence was production-derived. Correction 13's reusable
> consumer compilation, authority composition, savepoint, cleanup, and fanout
> evidence remains valid; its Resource Inbox receipt/outbox evidence did not
> prove authoritative transaction atomicity.

## Status and scope

Status: `DONE`.

This correction starts from clean Task 4 head
`34308c03d34ca37487fe66b4d22d1569a6ead6aa` and resolves review 13's
reusable-performance-consumer finding. It does not start Task 5/6, update
progress, change workload cardinality/concurrency/mutation mix/artifact schema,
modify the Task 0B baseline, weaken production authority, or push.

Correction 13 supersedes correction 12 only for final Task 4 acceptance.
Correction 12's cache behavior and evidence remain valid.

## Exact established RED

Before editing, the required native checks failed exactly as review reported:

```text
deno check --config apps/api-v1/deno.json \
  scripts/perf/api-v1-state-write-concurrency-bench.ts
8 errors; exit 1

deno check --config apps/api-v1/deno.json \
  scripts/perf/group-list-fanout-bench.ts
3 errors; exit 1
```

The state-write errors were two missing `authSessionRepository` compositions
and missing authority arguments for create/member/presence/update. The list
harness lacked the three optimistic primitives and mandatory Group/presence
fields.

Focused TDD also established RED for:

- deterministic scope-isolated benchmark authority sessions;
- real conditional insert/update/delete conflict behavior;
- production-faithful timing-exclusion validation;
- transaction `savepoint()` preservation through SQL instrumentation;
- first-error/in-flight-drain and sampler cleanup behavior;
- typed production retry exhaustion and causal prerequisite terminals.

## Production-faithful state-write design

Both measured PostgreSQL service stacks and the setup service now compose a
real `AuthSessionRepository` over the same runtime-state SQL repository. A pure
helper creates complete deterministic `IssuedAuthSession` credentials whose
session and token identities injectively percent-encode application, workspace,
principal, and session-label tuple components, so delimiter/percent lookalikes,
same-label principals, and warmup/measured phases cannot collide.

Setup inserts owner and client sessions before counters and mutation timing.
Every authoritative group call receives matching credentials: owner authority
for create/member/config and client session authority for connect/heartbeat/
disconnect. One scope-isolated generation ID is reused for each client presence
lifecycle. The production service's auth-session lookup and revalidation remain
inside measured calls and their SQL/timing counters.

The artifact now honestly excludes `setup`, `auth-session insertion`, and
`http`. The validator remains backward-compatible with the immutable legacy
baseline's `authentication` label while requiring either that legacy label or
the precise new insertion label. Focused tests prove the new producer
disclosure validates and omission fails.

Real producer execution exposed two additional consumer defects after native
check:

1. Instrumentation dropped transaction `savepoint()`. The wrapper now delegates
   savepoints recursively, instruments nested queries, preserves callback
   repository shape, and propagates callback errors.
2. Immediate concurrent rejection closed pools while siblings and the lock
   sampler were active, masking the initiating terminal as
   `CONNECTION_ENDED`. The mapper now captures the first temporal rejection,
   stops claiming new work, drains already-in-flight workers, and then throws.
   Failure paths await sampler cleanup and preserve the initiating error even
   if cleanup itself fails.

The unmasked production terminal was typed optimistic retry exhaustion during
shared membership. The existing artifact schema already governs exhausted
commands, but the harness aborted and then invoked presence for a client whose
membership had not committed. It now records only typed
`RuntimeStateRetryExhaustedError` as exhausted; generic errors still abort.
Only causal dependents are cascaded without a service call:

- membership exhaustion blocks connect, heartbeat, and disconnect;
- connect exhaustion blocks heartbeat and disconnect;
- heartbeat exhaustion does not block disconnect.

Skipped dependents emit an explicit `prerequisite-exhausted:*` command-envelope
source and write no receipt/outbox. Counts remain exactly 700 commands per
sample. The unchanged comparator still requires zero shared exhaustion, so
diagnostic completion cannot turn a failing candidate into a pass.

## Group-list fanout design

`CountingRuntimeStateRepository` now implements the optimistic transactional
contract. Conditional insert applies only when absent at revision 0; conditional
upsert applies only at the expected revision and increments it; conditional
delete applies only at the expected revision. Stale/missing operations return
typed conflicts. Focused tests cover winner/loser insert, winner/stale update,
and winner/stale/post-delete conflict.

The read service composes a real `AuthSessionRepository`. Every group fixture
has one active owner, matching owner member, active-member count, and complete
generation/lifecycle presence fields. The smoke asserts zero point reads and
the exact bounded distribution:

```json
{
  "group-state:groups": 2,
  "group-state:members": 1,
  "group-state:presence-summaries": 1,
  "group-state:sessions": 1
}
```

## Durable testing guidance

Five unguided pressure controls combined deadline, artifact-hash, broad-test,
non-CI-consumer, cast/fake, and read-heavy-path pressure. All selected targeted
native checks and smokes, but the pre-edit guided probes consistently noted
that the skill did not explicitly cover reusable performance consumers. Review
13 demonstrated the practical gap: broad green suites plus an unchanged hash
had missed broken current-HEAD producers.

The minimal generic `rallar-testing` addition requires native-checking every
affected reusable `scripts/perf/**` consumer and smoking its executable harness
when shared state contracts, mandatory fields, repository interfaces, or
service composition/signatures change. It distinguishes historical artifact
preservation from current-HEAD reproducibility. Five fresh post-edit guided
samples all selected the required checks and found the requirement unambiguous;
skill integrity passed 8/8.

## Files and behavior changed

- `.agents/skills/rallar-testing/SKILL.md`: generic perf-consumer validation.
- `.superpowers/sdd/task-4-correction-12-report.md`: final-acceptance
  supersession note.
- `scripts/perf/api-v1-state-write-concurrency-bench.ts`: real authority
  composition/seeding, generation fencing, honest measurement disclosure,
  savepoint preservation, deterministic failure cleanup, and governed
  exhaustion reporting.
- `scripts/perf/compare-api-v1-state-write-results.mjs`: legacy/new timing
  disclosure compatibility.
- `scripts/perf/group-list-fanout-bench.ts`: optimistic semantics, complete
  fixtures, real auth composition, and semantic fanout assertions.
- `scripts/perf/README.md`: auth and prerequisite measurement boundaries.
- `packages/tests/shared-server/state-write-performance-harness.test.ts` and
  `group-list-fanout-performance-harness.test.ts`: focused TDD coverage.
- This report.

No public product export/import path changed.

## Validation evidence

```text
Both required Deno native checks:
passed

Focused Task 4 plus performance harness matrix:
9 files passed; 217 tests passed

Performance harness focused tests:
2 files passed; 32 tests passed

npx vitest run packages/tests/shared-server:
56 files passed; 2 configured files skipped
565 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno task test:
204 passed; 0 failed

npm run typecheck:
root shared and every TypeScript workspace passed

cd apps/api-v1 && deno task check:
passed

cd apps/api-v1 && deno task lint:
Checked 76 files; passed

npm run lint --workspace @ar-eye-hunter/shared-server:
passed

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts:
8 passed

npm run test:postgres:presence-expiry:
1 file passed; 6 tests passed
100-heartbeat case: 1167 ms

npm run test:api-v1:black-box:memory:
11 profiles passed; 0 failed; 0 skipped
api-v1-group-presence: 17 successful steps
```

The three-group/one-run fanout smoke wrote only
`/private/tmp/group-list-fanout-correction-13-final.json`: 3 snapshots, 5
semantic prefix reads, 0 point/all-entry reads, maximum 3 rows per prefix.

The real state-write producer ran its unchanged required settings:

```text
--backend=postgres --warmup=1 --runs=3 --concurrency=10
output: tmp/perf/api-v1-state-write-correction-13.json (ignored)
all uncontended/shared/hot phases completed; exit 0
artifact validation: []
```

It retained exact sample cardinality and durable evidence. Aggregate outcomes
were uncontended 2100 accepted/0 exhausted, shared 2067/33, and hot 1173/927;
all DBW findings were empty and receipt/outbox counts matched accepted commands.
The generated file intentionally retains pre-remediation feature governance;
comparing it as a Task 10 candidate fails that governance gate. Focused
comparison coverage independently proves any shared exhaustion also fails the
unchanged zero-exhaustion gate.

The first sandboxed PostgreSQL and memory black-box runs failed only with local
network/listener `EACCES`; approved reruns passed. The first real producer run
then found the genuine savepoint defect. Two later diagnostic runs showed
`CONNECTION_ENDED` until deterministic draining/sampler cleanup exposed the
typed retry exhaustion. All subsequent focused/native checks and the final
producer passed.

Final architecture/diff gates found no Task 4 production lock, pure-mutation,
direct-publication, or scope-leakage changes. `git diff --check` passed. The
Task 0B baseline remained exact before and after:

```text
ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7  tmp/perf/api-v1-state-write-baseline.json
```

## Handoff

The reusable prerequisites and final producer now compile and execute against
current production contracts. The real diagnostic artifact correctly reveals
shared/hot retry exhaustion rather than hiding it or weakening gates; Task 10
owns candidate governance and performance acceptance. No correction-13
follow-up is required before fresh review. Task 5 remains blocked until the
parent explicitly advances it.
