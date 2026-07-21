# Shared-Server Architecture Notes

`packages/shared-server` owns reusable Rallar server-side domain code. It stays
independent of one HTTP app, deployment process, and environment configuration.
`apps/api-v1` composes routes, runtime IDs, OpenAPI, database lifecycle, and
deployment settings around these shared services.

## Current Public Surface

- `mod.ts` is the broad compatibility barrel for facades, middleware,
  repositories, auth, state services, WS topics, and runtime-state helpers.
- `rallar-facade/` composes reusable REST, WebSocket, system, and data behavior.
- `rallar-system/services/` owns client/group state, topology, state sync,
  app-inbox processing, authorization, timing, and routing.
- `rallar-system/repositories/` owns durable state, compact mutation receipts,
  the mutation outbox, topology publications, and QueueBox contracts.
- `runtime-state/` exposes conditional and transactional capabilities;
  `postgres/` supplies the concrete Postgres adapters.

Persistent authority keeps client/group snapshots in `runtime_state_store`
and state-event logs in `client_state_events` and `group_state_events`.

## Implemented Convergent Database Writes

Authoritative runtime-state creation, update, and deletion use
`insertIfAbsent`, `upsertIfRevision`, and `deleteIfRevision`. Client, group,
topology-config, RTC topology/publication, and RTT mutations use one visible
`read`, `compute`, `validate`, `write` sequence. The `compute` and `validate`
phases are pure. Only `write` opens the transaction, and the operation-specific
conditional guard is its first database statement. A conflict rolls the
transaction back and restarts at `read`, including fresh authorization,
policy, capacity, lifecycle, and invariant checks.

The shared retry schedule is
`DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS = [0, 2, 8]`. Each attempt calls
`waitForRuntimeStateWriteRetry` before reading, so every nonzero wait is outside
the transaction. An exhausted budget raises `RuntimeStateRetryExhaustedError`;
domain adapters preserve their documented typed error codes, including
`client-state-write-conflict`, `group-state-write-conflict`, and
`group-topology-commit-conflict` where applicable.

The implementation guard covers these exact operation families:

| Family | Ordered phase symbols | First write guard | Atomic dependent effects |
| --- | --- | --- | --- |
| Client mutation | `readClientMutation`, `computeClientMutation`, `validateClientMutation`, `writeClientMutation` | principal insert/CAS | children, compact client `MutationReceipt`, `StateMutationOutboxRepository` row, event |
| Group mutation | `readGroupMutation`, `computeGroupMutation`, `validateGroupMutation`, `writeGroupMutation` | group aggregate or presence-session insert/CAS/delete | admission/member rows, compact group `MutationReceipt`, `StateMutationOutboxRepository` row, event |
| Topology config mutation | `readTopologyConfigMutation`, `computeTopologyConfigMutation`, `validateTopologyConfigMutation`, `writeTopologyConfigMutation` | group authority fence, then config/override guard | invariant/target generations, compact receipt, recompute outbox |
| RTC topology mutation | `readTopologyMutation`, `computeTopologyMutation`, `validateTopologyMutation`, `writeTopologyMutation` | topology snapshot CAS | work claim and immutable publication when the computed variant carries a publication |
| RTC RTT mutation | `readRttMutation`, `computeRttMutation`, `validateRttMutation`, `writeRttMutation` | lexically ordered endpoint-admission guards | measurement, compact receipt, every computed recompute intent |

RTC topology's publication-null `write` variant is deliberately an internal
snapshot update and has no external outbox. `commitTopologyWithRetry` owns that
internal path. The `createRtcTopologyWorkHandler` `onMessage` callback owns the
externally effectful publication-bearing path and fans out only after
`writeTopologyMutation` commits. Client no-op idempotency claiming
and topology-config claim outcomes may persist compact authority receipts. They
have no external effect: no external fanout or outbox is required. This does not
mean that they perform no database write. Every externally effectful computed
variant is matched to its transaction-local outbox or publication insert.

## Mutation Receipt And Outbox Boundary

The implemented `MutationReceipt` family consists of
`ClientMutationReceipt`, `GroupMutationReceipt`,
`GroupTopologyConfigMutationReceipt`, RTC topology work claims, and
`RtcRttMutationReceipt`. Receipts are compact authority records, not stored
snapshots. Group state and downstream effects carry the two-component
`GroupStateCausalRevision` (`groupRevision`, `presenceRevision`).

Client/group/topology-config writes insert a `StateMutationOutboxRepository`
record inside the same transaction as guarded state, receipt, and event where
the operation has an event. The repository's authoritative insert is
insert-only: a collision is a typed failure that rolls back the transaction;
it never loads a winner. `StateMutationOutboxWork` publishes state sync and
enqueues topology recomputation asynchronously, so AppInbox owns command
ingress but does not publish committed mutation effects inline.

RTC topology execution atomically guards the snapshot and inserts its compact
work claim plus immutable publication. RTT acceptance guards endpoint
admissions before measurement, receipt, and per-group recompute-intent inserts.
Publication and recompute drainers deliver after commit and can resume after a
process restart.

## Concurrency Domains

- Client writes guard the principal aggregate.
- Group metadata and roster writes guard the group aggregate.
- Group presence uses the observed session row as its guard and does not
  contend on the group row. `GroupPresenceSummaryWork` asynchronously converges
  the materialized summary and emits topology recompute work.
- Topology config guards the group authority fence, target config/override, and
  lifecycle generations.
- RTC topology guards the snapshot; RTT guards the lexically ordered endpoint
  admission rows.

Aggregate-backed group mutations and topology config/override mutations also
use a per-service in-process FIFO lane keyed by the scoped group. The lane only
suppresses avoidable collisions among calls already handled by one service
instance. Presence-session mutations bypass the aggregate lane, and separate
service instances or processes retain independent lanes. Every queued effect
still runs the complete bounded retry from a fresh read; the lane does not
replace database CAS and is not authorization, persistence, or correctness
authority.

Snapshot assembly treats presence summaries as optimistic hints. At one
observation time it intersects the summary with the latest active/unexpired
group, active members, and connected/unexpired sessions. The causal tuple is
preserved even when archived, deleted, or expired groups report zero live
presence.

## Contract Defaults

Authoritative shared fields are mandatory except documented input or migration
exceptions. Persisted, replicated, queued, event, snapshot, receipt, and
successful response contracts are complete. Sparse request, query, patch,
builder, and migration types remain separate. Meaningful absence is represented
explicitly, commonly as required `null`.

## Measured Boundary

The retained artifact `tmp/perf/api-v1-state-write-task5.json` was produced at
commit `8a5863ef8a56d6537ca2040ab6ca8b3687f52fdb` with Postgres, one warmup,
three measured runs, concurrency 10, and 700 commands per measured run. Its
counter source states that SQL statements come from the thin `postgres.js`
wrappers around both service stacks and transaction duration is wall-clock time
inside production `sql.begin` calls. Exact workload totals stored in that
artifact are:

| Workload | SQL statements | Postgres transaction duration (ms) |
| --- | ---: | ---: |
| uncontended | 13000 | 3706.0120909999987 |
| shared (five groups) | 13948 | 4070.0607589999927 |
| hot (one group) | 12379 | 3891.845030999997 |

These are artifact-wide totals across the three measured runs, not per-command
budgets and not Task 10 acceptance. The retained artifact does not count
high-level repository method calls, so no measured repository-call total is
claimed. Tasks 6-8 retained correctness and multi-process convergence evidence
but no newer governed performance candidate. A current mutation-path or
concurrency-domain change must produce a fresh artifact and pass the comparative
gate; historical numbers cannot be relabeled as current results.

## Locks: Current And Historical

No targeted client, group, topology-config, topology snapshot/publication/
execution, or RTT repository calls `lockKey`. Earlier lock-based implementations
and pre-outbox publication ordering are historical evidence only and must not be
copied. Database row, table, and advisory lock exceptions require explicit
human approval, a measured need, a documented invariant, a bounded critical
section, and a review/removal condition.

The exhaustive current exception inventory is in
`rallar-server-repositories.md`. It covers QueueBox claiming
(`FOR UPDATE SKIP LOCKED`), WebSocket and agent-session ticket consumption,
username registration, inbound/outbound AL admission, and CRDT document-row
coordination, together with the shared Postgres advisory-lock primitive. These
remain outside this convergent-write remediation boundary and are not precedent
for authoritative state mutation design.

## Documentation And Validation

- `rallar-server-repositories.md` inventories current persistence and data flow.
- `rallar-server-repositories-improvements.md` is the historical hardening log.
- `../../docs/rallar-convergent-state-and-rtc-topology.md` describes the
  distributed state/topology model and acceptance gates.

Run focused tests first. Changes to the guarded implementation or guidance must
also run:

```bash
npx vitest run packages/tests/shared-server/read-compute-write-contract.test.ts
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
npm run test:api-v1:black-box:postgres:medium-scale
```

A mutation-path or concurrency-domain change additionally requires
`npm run perf:api-v1:state-write` and
`node scripts/perf/compare-api-v1-state-write-results.mjs <baseline> <candidate>`.
