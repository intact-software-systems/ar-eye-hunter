# Runtime Performance Validation Scripts

These scripts preserve the reusable harnesses created during the July 2026
runtime performance validation pass. They are intended to make the measured
findings repeatable without checking in generated benchmark artifacts.

The background reports live in:

- `playground/rallar-static-performance-audit-2026-07-02.md`
- `playground/rallar-runtime-performance-validation-plan-2026-07-02.md`
- `playground/rallar-runtime-performance-validation-report-2026-07-02.md`

## Motivation

The static audit produced several performance hypotheses around:

- legacy state event listing loading full histories;
- broad runtime/app-data prefix scans;
- expired latest-value cache entries staying retained;
- per-recipient WebSocket JSON serialization;
- rate-limiter cache cleanup scans;
- queue runnable-row query behavior under dense and sparse distributions;
- CRDT quota byte-sum scans;
- WebRTC/RTC topology, signaling, reconnect, and retained-resource churn.

The scripts in this directory keep small, targeted validation workloads close to
the repository so future optimization work can collect before/after data using
the same shapes.

## Artifact Policy

Run outputs belong under `tmp/perf/`.

Do not check in:

- `tmp/perf/results/**`
- `tmp/perf/profiles/**`
- `tmp/perf/logs/**`
- `tmp/perf/artifacts/**`

The scripts are reusable; their outputs are local measurements and are expected
to vary by machine, Postgres state, runtime version, cache warmth, and load.

## Scripts

| File | Purpose |
| --- | --- |
| `runtime-validation-bench.ts` | Deno benchmark harness for event parsing, runtime prefix reads, cache retention, rate limiter cleanup, state-sync recipient resolution, WebSocket serialization, and cache churn. |
| `summarize-runtime-results.mjs` | Node helper that summarizes harness JSON into per-case duration and memory deltas. |
| `api-v1-state-write-concurrency-bench.ts` | Direct PostgreSQL API-v1 state-write benchmark for uncontended, shared-group, and hot-group concurrency. |
| `compare-api-v1-state-write-results.mjs` | Validates state-write artifacts and enforces the relative performance and correctness gate. |
| `seed-perf-db.sql` | Synthetic Postgres fixture for runtime state, app data, state events, queue rows, and CRDT rows. |
| `explain-perf-db.sql` | EXPLAIN ANALYZE script for the seeded Postgres fixture. |
| `seed-perf-db-sparse-queue.sql` | Worst-case sparse queue fixture and EXPLAIN for runnable-row selection. |
| `client-list-fanout-bench.ts` | Client snapshot fanout/pagination workload. |
| `group-list-fanout-bench.ts` | Group snapshot fanout/pagination workload. |
| `state-sync/state-sync-resolve-member-scan-bench.ts` | State-sync member resolution scan workload. |
| `state-sync-send-fanout-bench.ts` | State-sync send fanout workload. |
| `rtc-room-graph-no-rtt-bench.ts` | No-RTT room graph construction workload. |
| `rtc-room-graph-rtt-bench.ts` | RTT-backed room graph construction workload. |
| `rtc-topology-star-bench.ts` | Star topology rebuild workload. |
| `rtc-topology-tree-no-rtt-bench.ts` | No-RTT tree topology rebuild workload. |
| `rtc-topology-mesh-no-rtt-bench.ts` | No-RTT mesh topology rebuild workload. |
| `rtc-topology-rtt-traffic-metrics.ts` | WS/topic-level RTT burst probe for topology queue coalescing, flushes, graph builds, and publishes. |
| `rtc-topology-inactive-churn-bench.ts` | Topology snapshot lifetime workload comparing retained inactive overlays with inactive-overlay cleanup. |
| `rtc-topology/delivery-log-bench.ts` | PostgreSQL publisher-stream append, contention, duplicate-race, and rollback workload. |
| `rtc-topology/replay-drain-operation-counts.ts` | Deterministic caught-up, bounded-page, delivery-outcome, and gap-hydration operation counts for the production replay service. |
| `rtc-rtt-group-scan-bench.ts` | RTT/group lookup scan workload. |
| `rtc-multicast-serialization-bench.ts` | Multicast transport serialization fanout workload. |
| `rtc-ice-candidate-queue-bench.ts` | ICE candidate queue flush workload. |
| `rtc-peer-listener-cleanup-bench.ts` | Peer connection listener/handler cleanup workload. |
| `rtc-data-channel-replace-key-bench.ts` | DataChannel replace-by-key queue coalescing workload. |
| `rtc-data-channel-close-retention-bench.ts` | DataChannel terminal close queue-retention workload. |
| `rtc-data-channel-error-reference-bench.ts` | DataChannel native error reference/handler-retention workload. |
| `rtc-data-channel-browser-soak.mjs` | Playwright/Chromium DataChannel close/reconnect soak. |
| `rtc-peer-connection-diagnostics-burst.ts` | Synthetic QRtcPeerConnection burst probe for queued ICE candidates, offer collisions, reconnect timers, ICE restarts, and diagnostic counter validation. |
| `webrtc-group-cache-fallback-bench.ts` | `WebRtcGroupService` fallback lookup cache workload. |
| `webrtc-group-manager-state-bench.ts` | `WebRtcGroupManager.state()` online peer set workload. |
| `webrtc-group-manager-peer-owners-bench.ts` | `WebRtcGroupManager.peerOwners()` ownership-map workload. |
| `webrtc-heartbeat-callback-churn-bench.ts` | Heartbeat callback registration/removal churn workload. |

## Prerequisites

Run commands from the repository root.

Useful environment checks:

```sh
node --version
npm --version
deno --version
docker --version
docker compose version
mkdir -p tmp/perf/results tmp/perf/profiles tmp/perf/logs tmp/perf/artifacts
```

The Deno harness uses `apps/api-v1/deno.json` for import aliases such as
`@shared/` and `@shared-server/`.

## API-v1 State-write Concurrency Baseline

Start PostgreSQL and apply the API-v1 migrations before running the state-write
benchmark. `DATABASE_URL` defaults to the local compose database
`postgres://app:app@localhost:5432/appdb` when it is not set.

```sh
npm run db:up
DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run db:migrate
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-baseline.json
```

The harness constructs two independent PostgreSQL AppInbox stacks
against one database. It seeds complete client and group state before every
warmup and measured phase, then resets measurement state. Setup, including
deterministic auth-session insertion, and HTTP routing are not included in
mutation latency. Each authoritative command is enqueued, retried, and completed
by the production AppInbox transaction boundary; authorization revalidation and
its SQL remain measured.
Every workload uses 100
clients, concurrency 10, and the same deterministic mix: profile/instance,
membership, presence connect/heartbeat/disconnect, group config, and topology
source config. Workload group counts are 100 (`uncontended`), five (`shared`),
and one (`hot`).

Artifacts use schema `rallar.api-v1.state-write.v5`. Each measured run retains
exactly 700 command records and latencies (100 of every mutation kind), balanced
service-stack counts, and durable AppInbox attempt observations.
It also includes latency percentiles, throughput, SQL/row/serialized-byte
metrics, transaction and production phase timings, PostgreSQL lock/buffer/WAL
counters, and process CPU time. PostgreSQL buffer and WAL counters are captured
immediately before and after each measured phase; lock waits are sampled from
`pg_stat_activity` while the phase runs.

Attempt observations come from actual ResourceInbox release telemetry and are
reconciled exactly with durable `resource_inbox.ri_attempts` values for
`APP_INBOX` rows. Each operation has a one-based attempt number, observed retry
delay and due age, selected `fast`, `fairness`, or `timeout` lane, and a final
accepted or exhausted outcome. Profile and instance remain separate operations;
the other mutation kinds use one command operation. Both comparison roles reject
service-local retry timing, invented attempt expansion, and synthetic
prerequisite records. Every release carries the actual typed exception
code/name, or an explicit no-failure marker for acceptance. Only recognized
optimistic concurrency failures count as conflicts; other retryable
infrastructure failures count as transient retries.
Command accepted/exhausted outcomes, conflict and transient retry counts, attempt counts, and
attempts per accepted mutation are derived from these histories. Coherent hot
baseline exhaustion is representable; comparison permits candidate hot
exhaustion only up to that baseline while requiring zero in uncontended/shared.

The timed command ends with AppInbox completion. After the measured phase, the
harness queries completed `APP_INBOX` rows/results, production idempotency
receipts, and final `APP_OUTBOX`/`WS_OUTBOX` rows from `resource_inbox` through
an uninstrumented admin SQL stack.
Profile-instance counts as received only when both profile and instance
subcommand receipts are present and complete; a group command uses its exact
request-ID receipt. Each operation projects its validated receipt's command and
request identity, command hash, aggregate reference, revision, snapshot version,
and event identity so the persisted public result cannot be substituted from a
different command. Production effect IDs and kinds are projected without
inventing evidence: principal snapshot/event effects for profile-instance,
`group-presence-summary` for group mutations, and `rtc-topology-recompute` for
topology-source. Receipt linkage records the command-specific immutable identity:
physical ResourceInbox keys for client/group receipts and outer envelope
`id.msgId` for topology receipts. Intermediate mutation-intent evidence is forbidden.
`atomicCompletionFailures` requires each completed AppInbox result, receipt,
and exact final effects in the same observation. These evidence queries are
excluded from command latency and measurement counters. Every metric source is disclosed in
`measurement.counterSources`.

Compare a candidate with its unmodified baseline:

```sh
node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-baseline.json \
  tmp/perf/api-v1-state-write-candidate.json
```

The comparison rejects invalid artifacts, uncontended p95/p99 regressions above
5%, shared or hot throughput regressions above 5%, unreasoned median
SQL/row/byte/transaction increases, disallowed retry exhaustion, and any
baseline or candidate receipt or outbox contract failure. Comparing an artifact
with itself passes: the gate asserts no-regression within tolerance, not
improvement. Benchmark each side against a freshly migrated database; on noisy
hosts use the order-balanced A-B-B-A pooling protocol
(`pool-api-v1-state-write-results.mjs`) before concluding a regression. A
correctness failure on either side is a comparison failure. The validator
recomputes all percentiles, throughput, outcome, attempt, median, and
correctness summaries from raw records before applying comparison gates. Both
roles are validated against the production durable contract with strict unique
receipt/final-effect ID, command, and effect linkage; DBW tags cannot waive
those invariants.
DBW retention never waives record structure: every receipt is a nonempty raw
command ID, every final ResourceInbox record has nonempty effect/command/topic/type
identity and a raw-command reference, and finding IDs must match the governed `DBW-...`
format. The legacy waiver is selected only by governed baseline metadata; there
is no permissive either-contract candidate path.
Validation and comparison are total over parsed JSON-like input: malformed
nested samples, unsupported mutation kinds, missing evidence containers, or
invalid derivation records produce path-oriented baseline/candidate errors
instead of throwing from summary or durable-contract derivation.
All contract arrays must be dense: workloads, samples, raw commands, attempt and
latency records, stack counts, AppInbox rows, receipts, ResourceInbox effects,
DBW findings, mutation
mix/exclusions, and regression reasons reject JavaScript holes before any
iteration, equality check, or derivation.

Resource-regression reasons contain exactly `workload`, `metric`, and `reason`.
The workload must be uncontended, shared, or hot; the metric must be one of
`sql.statements`, `sql.rowsRead`, `sql.serializedResultBytes`, or
`postgres.transactionDurationMs`; and the explanation must be substantive
(at least ten non-whitespace characters, not merely ten characters after edge
trimming). Validation and resource-regression authorization share this exact
predicate, so malformed entries cannot authorize a regression.

Loop-driving CLI values are bounded safe integers: warmup runs 1–10, measured
runs 1–100, and concurrency 1–256. Task 0B further requires exactly one warmup,
at least three measured runs, and concurrency 10.

## RTC Topology Delivery Log

Apply the current migrations, then run the fixed PostgreSQL workload:

```sh
DATABASE_URL=postgres://app:app@localhost:5432/appdb \
  npm run perf:rtc-topology:delivery-log -- \
  --label=candidate \
  --out=tmp/perf/rtc-topology-delivery-log-candidate.json
```

The workload constants are intentionally code-owned: 300 appends at concurrency
10 for both one-stream contention and three-stream independent publication, 30
forced duplicate-publication races, and 100 surrounding-transaction rollbacks.
Every result records throughput, p50/p95/p99, transaction retries, durable row
and HEAD counts, per-stream HEADs, and contiguous-sequence verification. Output
belongs under `tmp/perf/` and is not committed.

## Focused Runtime Harness

Run the full focused harness with three measured runs:

```sh
deno run \
  --config apps/api-v1/deno.json \
  --allow-read \
  --allow-write \
  --v8-flags=--expose-gc \
  scripts/perf/runtime-validation-bench.ts \
  --mode=full \
  --runs=3 \
  --out=tmp/perf/results/runtime-validation-focused-runs3.json
```

Summarize the results:

```sh
node scripts/perf/summarize-runtime-results.mjs \
  tmp/perf/results/runtime-validation-focused-runs3.json \
  tmp/perf/results/runtime-validation-focused-summary.json
```

Supported harness modes:

- `full`
- `events`
- `runtime-prefix`
- `cache`
- `rate-limit`
- `state-sync`
- `serialization`
- `latest-cleanup`
- `leak`

Example narrow event-listing run:

```sh
deno run \
  --config apps/api-v1/deno.json \
  --allow-read \
  --allow-write \
  --v8-flags=--expose-gc \
  scripts/perf/runtime-validation-bench.ts \
  --mode=events \
  --runs=3 \
  --out=tmp/perf/results/events-runs3.json
```

## WebRTC Signaling Diagnostics

Run a repeatable synthetic peer-connection burst:

```sh
deno run \
  --config apps/api-v1/deno.json \
  --allow-read \
  --allow-write \
  scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
  --peers=500 \
  --ice-candidates=5 \
  --offer-collisions=3 \
  --runs=3 \
  --out=tmp/perf/results/rtc-peer-connection-diagnostics-burst-runs3.json
```

Expected counter shape for that input:

- `queuedIceCandidateCount` and `flushedIceCandidateCount`: `peers * ice-candidates`
- `offerCollisionCount` and `ignoredOfferCollisionCount`: `peers * offer-collisions`
- `reconnectAttemptCount`, `reconnectTimerAlreadyActiveCount`,
  `reconnectExhaustedCount`, and `iceRestartCount`: `peers`
- `pendingIceCandidateQueueLength`: `0`

Use this harness to validate that reconnect/renegotiation storm counters remain
stable before wiring the counters into broader browser or full-stack traffic
tests.

Run the memory-mode three-browser live matrix and persist compact RTC
diagnostic artifacts:

```sh
RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/results \
  npm run test:rallar:full-stack:memory:live-rtc-3
```

That command writes files such as:

- `tmp/perf/results/live-rtc-diagnostics-realtime-*.json`
- `tmp/perf/results/live-rtc-diagnostics-messages-rtc-*.json`
- `tmp/perf/results/live-rtc-three-browser-run-summary-*.json`

For browser or full-stack runs, capture the same counters through the public RTC
facade:

```ts
const diagnostics = await rallar.rtc.diagnostics();
console.log(JSON.stringify({
  generatedAtEpochMs: diagnostics.generatedAtEpochMs,
  peerCount: diagnostics.peerCount,
  peers: diagnostics.peers.map((peer) => ({
    peerId: peer.peerId,
    connectionState: peer.connection.connectionState,
    candidatePairRtt: peer.selectedCandidatePair?.currentRoundTripTime,
    usesRelay: peer.usesRelay,
    connectionDiagnostics: peer.connectionDiagnostics,
  })),
}));
```

Useful live signals:

- `reconnectAttemptCount`, `reconnectTimerAlreadyActiveCount`, and
  `reconnectExhaustedCount` for reconnect storms.
- `disconnectTimerScheduledCount`, `disconnectTimerAlreadyActiveCount`,
  `disconnectTimerClearedCount`, and `disconnectTimerFiredCount` for network
  flap timer coalescing.
- `offerCollisionCount`, `ignoredOfferCollisionCount`, and
  `politeOfferRollbackCount` for offer glare.
- `queuedIceCandidateCount`, `flushedIceCandidateCount`, and
  `pendingIceCandidateQueueLength` for ICE queue pressure.
- `outboundSignalingErrorCount` and `inboundSignalingErrorCount` for signaling
  failures.

## RTC Topology Lifetime

Compare retained versus cleaned inactive room topology snapshots:

```sh
deno run \
  --config apps/api-v1/deno.json \
  --allow-read \
  --allow-write \
  scripts/perf/rtc-topology-inactive-churn-bench.ts \
  --groups=10000 \
  --sessions=5 \
  --runs=3 \
  --mode=retain \
  --out=tmp/perf/results/rtc-topology-inactive-churn-retain-runs3.json

deno run \
  --config apps/api-v1/deno.json \
  --allow-read \
  --allow-write \
  scripts/perf/rtc-topology-inactive-churn-bench.ts \
  --groups=10000 \
  --sessions=5 \
  --runs=3 \
  --mode=cleanup \
  --out=tmp/perf/results/rtc-topology-inactive-churn-cleanup-runs3.json
```

The key signal is `finalTopologySnapshotCount`: retain mode models the old
lifetime shape, while cleanup mode should end at `0` after archived/deleted
room snapshots.

## CPU Profiling

Run one profiled pass:

```sh
deno run \
  --config apps/api-v1/deno.json \
  --allow-read \
  --allow-write \
  --v8-flags=--prof,--expose-gc \
  scripts/perf/runtime-validation-bench.ts \
  --mode=full \
  --runs=1 \
  --out=tmp/perf/results/runtime-validation-focused-profiled-run.json
```

Deno writes an `isolate-*.log` file in the current directory. Move it into
`tmp/perf/profiles/`, then process it with Node:

```sh
mv isolate-*.log tmp/perf/profiles/runtime-validation-focused-v8.log
node --prof-process \
  tmp/perf/profiles/runtime-validation-focused-v8.log \
  > tmp/perf/profiles/runtime-validation-focused-v8-processed.txt
```

If `node --prof-process` warns about a V8 version mismatch, treat percentages
as directional rather than exact.

## GC Trace

Use a short mode because `--trace-gc` is noisy:

```sh
deno run \
  --config apps/api-v1/deno.json \
  --allow-read \
  --allow-write \
  --v8-flags=--trace-gc,--expose-gc \
  scripts/perf/runtime-validation-bench.ts \
  --mode=events \
  --runs=3 \
  --out=tmp/perf/results/runtime-validation-events-gc-run.json \
  > tmp/perf/logs/runtime-validation-events-gc-stdout.log \
  2> tmp/perf/logs/runtime-validation-events-gc-stderr.log
```

## Postgres Query Plans

Start the local Postgres service:

```sh
npm run db:up
```

Apply migrations if the schema is missing:

```sh
DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run db:migrate
```

Seed synthetic perf data:

```sh
docker compose exec -T postgres psql -U app -d appdb \
  < scripts/perf/seed-perf-db.sql
```

Update planner statistics:

```sh
docker compose exec -T postgres psql -U app -d appdb \
  -c "ANALYZE runtime_state_store; ANALYZE app_data_store; ANALYZE client_state_events; ANALYZE resource_inbox; ANALYZE crdt_documents; ANALYZE crdt_updates;"
```

Run the main EXPLAIN suite:

```sh
docker compose exec -T postgres psql -U app -d appdb \
  < scripts/perf/explain-perf-db.sql \
  > tmp/perf/results/postgres-explain-perf-db-after-analyze.txt
```

Run the sparse queue worst-case fixture:

```sh
docker compose exec -T postgres psql -U app -d appdb \
  < scripts/perf/seed-perf-db-sparse-queue.sql \
  > tmp/perf/results/postgres-explain-sparse-queue.txt
```

### Database Safety

The SQL fixture scripts insert rows using `perf-*` namespaces, document keys,
application IDs, and queue types. They do not delete data.

This is intentional:

- cleanup is destructive;
- repeated runs should not hide what was measured;
- local developers may want to inspect rows after a run.

If cleanup is needed, do it manually with a targeted transaction after checking
the row predicates.

## Interpreting Results

Treat these scripts as validation tools, not production benchmarks.

Good signals:

- relative differences between full-list and paged-list paths;
- growth shape as row counts, keys, recipients, or payload sizes increase;
- EXPLAIN scan type, rows removed by filter, buffers, sorts, and execution time;
- post-GC heap shape across repeated cache churn.

Noisy signals:

- absolute wall time on a laptop;
- RSS after forced GC;
- CPU profile percentages processed across different V8 versions;
- Postgres timings before `ANALYZE`;
- Docker-backed database timings under unrelated local load.

When using these scripts to validate an optimization, record:

- branch and commit;
- machine/runtime versions;
- exact command;
- input size and mode;
- number of runs;
- before and after artifacts under `tmp/perf/`.
