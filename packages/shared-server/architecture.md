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
  direct resource-inbox effects, topology publications, and QueueBox contracts.
- `runtime-state/` exposes conditional and transactional capabilities;
  `postgres/` supplies the concrete Postgres adapters.

Persistent authority keeps client/group snapshots in `runtime_state_store`
and state-event logs in `client_state_events` and `group_state_events`.

## Implemented Convergent Database Writes

**AppInbox is mandatory for incoming database mutations.** All HTTP and
WebSocket database mutations use AppInbox, including client/group/topology,
authentication/session/ticket, CRDT append/admin, and mutating admin paths.
AppInbox owns the transaction and retry boundary; synchronous result waiting
never falls back to direct mutation.

```text
HTTP/WS mutation
  -> APP_INBOX
  -> read -> compute -> validate
  -> AppInbox transaction
       -> service.write(transaction, computed)
       -> authoritative state/event/receipt
       -> APP_OUTBOX/WS_OUTBOX
       -> result + reservation-fenced completion
  -> commit
  -> wake/poll workers
```

Logical WebSocket audience resolution happens only after commit; queue workers
are then woken or poll.

Authoritative runtime-state creation, update, and deletion use
`insertIfAbsent`, `upsertIfRevision`, and `deleteIfRevision`. Client, group,
topology-config, RTC topology/publication, and RTT mutations use one visible
`read`, `compute`, `validate`, `write` sequence. The `compute` and `validate`
phases are pure; computed persistence data is not called a plan. The service
`write(transaction, computed)` is transaction-bound: service write receives the
transaction and never opens, commits, replaces, or retries one. Its conditional
guard is first. An incoming HTTP/WS mutation conflict rolls back and returns to
AppInbox, which starts a new processing attempt with fresh authorization,
policy, capacity, lifecycle, and invariant checks.

AppInbox owns incoming HTTP/WS mutation retries. Downstream `APP_OUTBOX` work
such as `RtcTopologyOutboxWork` uses its own ResourceInbox/QueueBox attempt
boundary and repeats the full read/compute/validate/write sequence. In both
cases, neither service owns the transaction or retry boundary.

Resource inbox allows 20 total processing attempts. Attempts one through five
wait 1, 2, 4, 8, and 16 ms; later waits rise through seconds, cap at 30 seconds,
and use jitter. A separate best-effort fairness lane claims retries more than 30
seconds overdue independently from timeout recovery.

The implementation guard covers these exact operation families:

| Family | Ordered phase symbols | First write guard | Atomic dependent effects |
| --- | --- | --- | --- |
| Client mutation | `readClientMutation`, `computeClientMutation`, `validateClientMutation`, `writeClientMutation` | principal insert/CAS | children, compact client `MutationReceipt`, direct `ResourceInbox` effects, event |
| Group mutation | `readGroupMutation`, `computeGroupMutation`, `validateGroupMutation`, `writeGroupMutation` | group aggregate or presence-session insert/CAS/delete | admission/member rows, compact group `MutationReceipt`, direct `ResourceInbox` effects, event |
| Topology config mutation | `readTopologyConfigMutation`, `computeTopologyConfigMutation`, `validateTopologyConfigMutation`, `writeTopologyConfigMutation` | group authority fence, then config/override guard | invariant/target generations, compact receipt, recompute outbox |
| RTC topology mutation | `readTopologyMutation`, `computeTopologyMutation`, `validateTopologyMutation`, `writeTopologyMutation` | topology snapshot CAS | work claim and immutable publication when the computed variant carries a publication |
| RTC RTT mutation | `readRttMutation`, `computeRttMutation`, `validateRttMutation`, `writeRttMutation` | lexically ordered endpoint-admission guards | measurement, compact receipt, every computed recompute intent |

`RtcTopologyOutboxWork` handles both publication-null and publication-bearing
RTC topology variants. ResourceInbox/QueueBox owns the downstream attempt and
transaction boundary; the topology service owns neither. Publication-null work
may update the guarded snapshot but produces no external outbox or fanout.
Publication-bearing work inserts its immutable publication with the guarded
write, and publication delivery and fanout start only after
`writeTopologyMutation` commits. Client no-op idempotency claiming and
topology-config claim outcomes may persist compact authority receipts. They have
no external effect: no external fanout or outbox is required. This does not mean
that they perform no database write. Every externally effectful computed variant
is matched to its transaction-local outbox or publication insert.

## Mutation Receipt And Outbox Boundary

The implemented `MutationReceipt` family consists of
`ClientMutationReceipt`, `GroupMutationReceipt`,
`GroupTopologyConfigMutationReceipt`, RTC topology work claims, and
`RtcRttMutationReceipt`. Receipts are compact authority records, not stored
snapshots. Group state and downstream effects carry the two-component
`GroupStateCausalRevision` (`groupRevision`, `presenceRevision`).

Client/group/topology-config writes insert immutable `APP_OUTBOX` or `WS_OUTBOX`
entries directly through `ResourceInboxRepository` in the same transaction as
guarded state, receipt, result, and any event. There is no intermediate mutation
outbox. A collision is a typed failure that rolls back the transaction; AppInbox
does not publish committed mutation effects inline.

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
Authoritative persisted and shared contracts use mandatory fields by default.

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

## Queue Coordination Locks

Queue locks are coordination-only. `FOR UPDATE SKIP LOCKED` is bounded to
resource-inbox reservation, timeout-recovery, and fairness claims; it is not
domain mutation authority. Authentication/session/ticket, AL admission, CRDT,
client, group, and topology writes use conditional insert/update/delete fencing.
Advisory locks and CRDT document-row locks are not approved queue-claim
exceptions or architecture precedent.

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
