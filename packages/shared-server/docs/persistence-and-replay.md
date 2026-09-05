# Shared-server persistence and replay

This document describes current durable shapes and owners. The current schema
bootstrap creates today’s database shape; runtime code does not translate older shapes.
Current readers decode the shape written by current writers and fail at a named
corruption boundary when that shape is invalid.

## Store map

| Store                          | Current owner                                            | Purpose and authority                                                                                            |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `runtime_state_store`          | `runtime-state/postgres/` plus feature codecs            | Revision-fenced runtime state for auth, client/group state, presence, RTC-RTT, and AL runtime namespaces.        |
| `resource_inbox`               | `queuebox/postgres/`                                     | QueueBox entry identity, status, reservation attempt, retry scheduling, expiry, and serialized current resource. |
| `resource_inbox_results`       | `queuebox/postgres/resource-inbox-results-repository.ts` | Durable AppInbox success or typed failure result. This is the completion source of truth.                        |
| `client_state_events`          | `rallar-system/state-events/postgres/`                   | Ordered client state events for snapshot/event reads.                                                            |
| `group_state_events`           | `rallar-system/state-events/postgres/`                   | Ordered scoped group state events for snapshot/event reads.                                                      |
| `app_data_store`               | `app-data/postgres/`                                     | Application-owned schema-versioned `JsonWireValue` data.                                                         |
| `crdt_documents`               | `rallar-system/crdt/persistence/`                        | Current CRDT document metadata and revision authority.                                                           |
| `crdt_updates`                 | `rallar-system/crdt/persistence/`                        | Durable document update log.                                                                                     |
| `crdt_snapshots`               | `rallar-system/crdt/persistence/`                        | Durable compacted document snapshots.                                                                            |
| `rtc_topology_delivery_stream` | `rallar-system/topology/replay/postgres/`                | Per-process publisher/consumer stream HEAD, retained floor, and lease.                                           |
| `rtc_topology_delivery_log`    | `rallar-system/topology/replay/postgres/`                | Immutable per-publisher topology delivery sequence.                                                              |
| `rtc_topology_replay_cursor`   | `rallar-system/topology/replay/postgres/`                | Last processed sequence for one consumer/publisher pair.                                                         |

Feature-owned runtime-state codecs define the namespace, key family, exact
value, and expiry behavior. Do not use `runtime_state_store` as an untyped
application-data table. Application data enters through
`RallarServerAppData.open(...)` and `app_data_store`.

## Current-value boundaries

Unknown input is allowed only at a named decoder, validator, type guard, or
caught-error boundary. Persistence owners decode rows immediately before domain
decisions.

- `runtime-state/postgres/runtime-state-row-codec.ts` decodes revision, value,
  and expiry.
- State-event PostgreSQL owners use separate client and group row codecs.
- QueueBox uses `resource-inbox-row-codec.ts`; AppInbox separately validates the
  canonical logical command identity and decodes its `JsonWireValue` payload.
- App data requires an `AppDataValueCodec<V>` with exactly one current
  `schemaVersion`, `encode`, and `decode` implementation. A version mismatch or
  malformed value throws `AppDataCorruptionError`.
- CRDT, topology, RTC-RTT, auth, client, and group readers use their owning
  feature codec or validation module.

There is no runtime translation callback, predecessor key scan, dual read,
fallback decoder, or write-back conversion. Development and test databases are
recreated from the current schema bootstrap.

## Conditional state writes

`RuntimeStateRepositoryLike` exposes current reads, batched reads, ordinary
writes, and conditional revision guards. Authoritative state mutations use:

- conditional insert for creation;
- expected-revision upsert for update;
- expected-revision delete for removal or expiry;
- guarded batches when multiple runtime-state rows share one atomic authority
  decision.

The PostgreSQL adapter owns execution and row decoding under
`runtime-state/postgres/`. Batch reads are part of the required repository
contract; there is no capability probe or unsupported-repository fallback.
Concurrency-driven rereads remain because they are part of current correctness.

## AppInbox transaction boundary

The application entry, queue reservation, domain decision, and durable result
have separate owners:

- `AppInboxReservationClient` materializes commands that require a durable
  reservation before their current authority can be computed;
- `AppInboxQueueEntryWriter` writes current commands and wakes the owning queue;
- `AppInboxCommandClient` coordinates ordinary enqueue-and-wait calls;
- `AppInboxResultWaiter` polls completion state and decodes the typed durable
  result;
- `AppInboxHandlerRegistry` registers exact command decoders and handlers;
- `AppInboxHandlerExecutor` invokes registered handlers and classifies
  retryable versus terminal failures;
- the domain handler owns its read, compute, validate, and transaction-bound
  write;
- `AppInboxTransactionWriter` owns the SQL transaction, durable result, and
  reservation-fenced finalization.

Repository reads load the decision surface outside the write transaction. Only
`compute` and `validate` are pure. At write time, service write receives the
transaction and performs the first conditional authority guard before dependent
effects. The same transaction contains the current state/event/receipt,
`ResourceInboxRepository` outbox entry, typed result, and reservation
finalization.

The current AppInbox policy permits 20 total processing attempts. A conflict or
retryable failure releases the reservation to QueueBox; the next attempt starts
from a fresh read. A terminal failure writes the sole current `AppInboxFailure`
shape to `resource_inbox_results`.

## Outbox and publication boundary

`APP_OUTBOX` and `WS_OUTBOX` are semantic intents written with authoritative
state. Logical WebSocket audience resolution happens only after commit.
QueueBox worker wake-ups may reduce latency, but durable rows remain authority.

Client, group, topology-config, CRDT, and admin writers place their dependent
outbox work in the same transaction as their first guard and durable result.
The worker later resolves current recipients or executes the named downstream
capability.

The RTC topology work handler has a separate ResourceInbox/QueueBox attempt
boundary. It repeats its full topology read/compute/validate/write flow; neither
service owns the transaction or retry boundary. Publication-bearing work guards the
snapshot and inserts its immutable publication and durable delivery entry
atomically. Publication-null work may update guarded current state without
creating external fanout.

Queue locks are coordination only. `FOR UPDATE SKIP LOCKED` is confined to
bounded ResourceInbox reservation, overdue retry, and timed-out reservation
recovery. Domain authority uses conditional row guards rather than queue locks.

## Durable topology replay

Every API process owns an ephemeral topology delivery stream. Sequence numbers
are monotonic only within one publisher stream. Every consumer owns one cursor
per publisher; cross-stream sequence comparison has no authority meaning.

### Append

`rtc-topology-delivery-stream-service.ts` acquires and maintains the publisher
lease. A publication append advances the publisher HEAD and inserts the exact
next delivery-log row. A lost publisher lease is a health failure rather than a
silent alternate path.

### Drain

`RtcTopologyReplayService` is single-flight. Startup, one-second anti-entropy
polls, database notifications, and local commits only request work; they do not
process entries inline. Each turn uses bounded pages through
`RtcTopologyReplayDrain` and `RtcTopologyReplayPageProcessor`.

For each publisher, replay reads from the consumer cursor toward current HEAD,
validates contiguous sequence and exact payload shape, invokes the entry
handler, and advances the cursor transactionally. An entry handler validates
the immutable publication but reloads current topology before delivery, so an
old publication never becomes current authority.

### Gaps and reconnects

`retained_from_sequence` is the first retained physical sequence. If a cursor
falls below that floor, replay performs current-state gap hydration before
advancing. Reconnect hydration batches briefly, reads current durable group
membership, presence, expiry, and topology, then fences the final send to the
same socket generation. Cached presence alone never authorizes hydration.

### Retention and retirement

Current replay policy is:

- 1 second anti-entropy polling;
- 100 entries per page;
- at most 10 pages and 1,000 entries per turn;
- 10 second stream heartbeats with a 30 second lease;
- 60 second compaction scheduling;
- 1,000-row compaction pages;
- 24 hour delivery-log retention.

Compaction verifies physical contiguity under the stream guard, removes only
expired prefix rows, and atomically advances the retained floor. Retention is
not cursor-pinned; gap hydration is the correctness boundary for a lagging
consumer. Maintenance retires expired consumer cursors and empty expired
streams only when their remaining cursor and log relationships are safe.

## Expiry and maintenance

- `RuntimeStateExpiryWorker` deletes expired runtime-state rows every 60
  seconds, retries failed runs after 10–20 seconds, and excludes RTC-RTT
  namespaces whose receipt-family cleanup has its own invariant-aware owner.
- Runtime-state reads also treat expired rows as absent, so periodic eviction
  is storage maintenance rather than liveness authority.
- ResourceInbox maintenance deletes expired entries every 15 seconds. Active
  reservation and retry queries also exclude expired rows.
- App-data stores may derive `expireAt` from a fixed TTL or current typed value;
  optimistic revision guards protect refreshes from stale expiry writes.
- CRDT retention and quota policy are owned under `rallar-system/crdt/`, not by
  generic queue or runtime-state maintenance.
- Topology delivery compaction and stream/cursor retirement use the replay
  policies above.

## Validation

Run affected unit suites before integration and black-box gates:

```bash
npx vitest run packages/tests/shared-server/runtime-state
npx vitest run packages/tests/shared-server/rallar-system/app-inbox
npx vitest run packages/tests/shared-server/rallar-system/state-events
npx vitest run packages/tests/shared-server/rallar-system/topology/replay
npx vitest run packages/tests/shared-server/integration/postgres
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Full mutation and replay acceptance uses:

```bash
npm run test:integration:postgres
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:topology-replay
npm run perf:api-v1:state-write
node scripts/perf/compare-api-v1-state-write-results.mjs <baseline> <candidate>
```

The medium-scale gate retains 100 independently authenticated clients, five
groups, three PostgreSQL-backed API processes, and 10 client lanes plus 5
control lanes. Performance comparisons require environment-matched artifacts;
historical numbers are not a current baseline.
