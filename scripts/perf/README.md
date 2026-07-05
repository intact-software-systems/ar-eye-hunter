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
| `seed-perf-db.sql` | Synthetic Postgres fixture for runtime state, app data, state events, queue rows, and CRDT rows. |
| `explain-perf-db.sql` | EXPLAIN ANALYZE script for the seeded Postgres fixture. |
| `seed-perf-db-sparse-queue.sql` | Worst-case sparse queue fixture and EXPLAIN for runnable-row selection. |
| `client-list-fanout-bench.ts` | Client snapshot fanout/pagination workload. |
| `group-list-fanout-bench.ts` | Group snapshot fanout/pagination workload. |
| `state-sync-resolve-member-scan-bench.ts` | State-sync member resolution scan workload. |
| `state-sync-send-fanout-bench.ts` | State-sync send fanout workload. |
| `rtc-room-graph-no-rtt-bench.ts` | No-RTT room graph construction workload. |
| `rtc-room-graph-rtt-bench.ts` | RTT-backed room graph construction workload. |
| `rtc-topology-star-bench.ts` | Star topology rebuild workload. |
| `rtc-topology-tree-no-rtt-bench.ts` | No-RTT tree topology rebuild workload. |
| `rtc-topology-mesh-no-rtt-bench.ts` | No-RTT mesh topology rebuild workload. |
| `rtc-topology-rtt-traffic-metrics.ts` | WS/topic-level RTT burst probe for topology queue coalescing, flushes, graph builds, and publishes. |
| `rtc-topology-inactive-churn-bench.ts` | Topology snapshot lifetime workload comparing retained inactive overlays with inactive-overlay cleanup. |
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
