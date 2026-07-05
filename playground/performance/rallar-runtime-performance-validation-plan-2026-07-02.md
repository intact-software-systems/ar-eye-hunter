# Rallar Runtime Performance Validation Plan

Date: 2026-07-02

Purpose: confirm or reject the highest-risk hypotheses from
`playground/rallar-static-performance-audit-2026-07-02.md`.

Scope:

- Runtime validation only.
- Do not optimize yet.
- Keep profile and benchmark artifacts under `tmp/perf/` or `.artifacts/`.
- Prefer small, repeatable runs before large or worst-case runs.

## Environment To Record For Every Run

Capture these in `tmp/perf/run-notes.md` before comparing results:

- Git branch and commit.
- macOS version and CPU model.
- Power mode: plugged in, low-power mode off.
- Node, npm, Deno, Playwright, Docker, and Postgres versions.
- Backend: `pglite-memory` or Postgres.
- API mode and environment variables.
- Dataset size and seed.
- Number of warmup runs and measured runs.
- Artifact directory.

Useful commands:

```sh
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
node --version
npm --version
deno --version
docker --version
docker compose version
mkdir -p tmp/perf/profiles tmp/perf/logs tmp/perf/artifacts
```

## Benchmark Matrix

| ID | Static finding | Hypothesis | Tool or benchmark | Input data | Confirms if | Falsifies if | Signals to collect | Instrumentation needed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | `/clients` DB fanout | Client snapshot listing has query count and latency growing faster than the number of principals because each principal triggers related reads. | Minimal `api-state-bench.ts` plus Postgres query logging. | 10, 100, 1k principals; 1, 3, 10 instances per principal; 1, 3 sessions per principal. | Query count grows roughly O(P * related rows), p95 wall time rises steeply, heap/RSS spikes during response build. | Query count is close to constant or linear with low slope, p95 remains flat enough, heap returns to baseline after GC. | CPU, wall p50/p95/p99, allocation rate, peak heap/RSS, post-GC heap, DB query count, rows read, response bytes. | Add per-request query counter, response byte count, and heap samples around `GET /api/state/clients`. |
| B2 | `/groups` DB fanout | Group listing loads too much membership and presence data and filters authorization in memory. | Minimal `api-state-bench.ts` plus Postgres query logging. | 10, 100, 1k groups; 10, 100, 500 members per group; active session ratios 0%, 10%, 100%. | Query count and heap scale with groups * members/sessions; strict auth still reads broad data. | Query count and rows read scale with returned groups only; strict auth narrows DB work. | Wall time, query count, rows read, response bytes, heap/RSS, GC pauses. | Add group list timing spans and query count per request. |
| B3 | Legacy `/events` full history load | Legacy `/events` loads all historical events before returning the final page. | Endpoint benchmark comparing `/events` and `/events/page`. | 100, 10k, 100k events for one client and one group. | `/events` latency, JSON parse CPU, rows read, and allocation scale with total event count while `/events/page` scales with limit. | `/events` query returns bounded rows and remains close to `/events/page`. | CPU profile, wall time, rows read, response bytes, heap delta, GC count. | Query count/row count around `PSqlStateEventRepository.list*Events`; route-level timing. |
| B4 | TTL cache retained entries | State snapshot cache entries remain retained after logical TTL expiry and churn. | Long-running cache churn harness plus heap snapshots. | 1k, 10k, 100k unique principals/groups/sessions; TTL expiry window; repeated create/close cycles. | Post-GC heap and cache entry counts grow with unique historical IDs and do not plateau after TTL. | Post-GC heap plateaus and cache entry counts match live active IDs. | Retained heap, Map entry counts, RSS, GC frequency, old-space growth. | Add optional cache-size diagnostic log or debug endpoint for server cache repositories. |
| B5 | WS state-sync fanout scans | Recipient resolution scans global snapshot caches and all connections per message. | Black-box traffic/parallel runs plus focused WS fanout harness. | 10, 100, 500 connections; 10, 100, 1k groups; 1 KB, 32 KB, 256 KB payloads. | CPU and send latency scale with total snapshots/connections, not just actual recipients. | CPU and latency scale mainly with recipients and payload bytes. | CPU profile, send p95/p99, recipient count, snapshots scanned, connections scanned, payload bytes. | Counters in `resolveStateSyncRecipients`, `JsonWebSocketServer.broadcast`, and topic handlers. |
| B6 | QueueBox serialized throughput | `maxConcurrency: 1` and one-row reservations create queue lag under bursts. | Queue load harness plus Postgres queue depth sampling. | 1k, 10k, 100k queued rows; bursts at 10, 100, 1k messages/sec; mixed ready/reserved/expired rows. | Queue depth and age grow while CPU/DB still have capacity; reservation/release round trips dominate. | Queue drains linearly within target p95 lag and bottleneck is elsewhere. | Queue lag p50/p95/p99, dequeue rate, DB query time, lock wait, CPU idle, connection pool use. | Queue metrics: ready/reserved counts, age of oldest ready row, reserve/release timings. |
| B7 | Queue index mismatch | Queue runnable/timeout queries do scans or sorts despite existing indexes. | Postgres `EXPLAIN (ANALYZE, BUFFERS)`. | `resource_inbox` with 1k, 100k, 1M rows and realistic status/type/expiry distributions. | Plans show sequential scans, high buffer reads, sort nodes, or row estimates far from actual. | Plans use selective indexes with low buffer reads and stable latency. | Buffers, actual rows, loops, sort method, planning time, execution time. | None for EXPLAIN; optionally capture query text from repository methods. |
| B8 | Runtime state prefix scans | Runtime prefix/list operations materialize broad rows and parse full JSON values. | Repository microbench or endpoint harness for state snapshots. | 1k, 10k, 100k `runtime_state_store` rows; 512 B, 10 KB, 100 KB values; narrow and broad prefixes. | Rows read, JSON parse CPU, heap, and latency scale with namespace/prefix size. | SQL narrows rows and parse cost scales only with returned live values. | CPU parse profile, rows read, heap delta, response bytes, query plan. | Add row-count and JSON-parse timing around `RuntimeStateJsonStore.listEntries/listValues`. |
| B9 | CRDT admin full materialization | CRDT document listing/export/integrity materializes too much data. | CRDT repository benchmark and admin route benchmark. | 100, 10k documents; 100, 10k, 100k updates per hot doc; 1 KB and 32 KB updates. | Heap/RSS and wall time grow with full document/update corpus even when route returns a page/filter. | SQL-side filtering/paging keeps row reads and memory bounded. | Wall time, peak RSS/heap, post-GC heap, rows read, JSON parse CPU, GC. | Add query/row count and bytes-read counters around CRDT repository calls. |
| B10 | CRDT append row lock and quota scan | Hot-document append latency rises with concurrent actors and update count, especially with quota checks. | CRDT append concurrency harness. | One hot doc; 1, 10, 50 actors; 100, 10k, 100k existing updates; quotas on/off. | p95/p99 append latency grows with actor count and existing update count; lock wait appears in DB. | Latency stays bounded and quotas add negligible cost. | Append p50/p95/p99, DB lock wait, rows scanned for byte totals, CPU hash cost. | Add per-append timings for lock acquisition, quota check, hash, insert, transaction duration. |
| B11 | App-data whole-store hydrate | App-data hydrate/getEntries loads and caches full stores. | App-data repository benchmark. | 1k, 10k, 100k keys; 512 B, 10 KB, 100 KB values; narrow and broad prefixes. | Latency, heap, and rows read scale with all matching store rows; retained cache grows with key count. | Prefix/list operations stay bounded to requested page/projection. | Wall time, rows read, value bytes, heap/RSS, post-GC heap. | Add row count, value byte count, cache size, and hydrate timing. |
| B12 | RTC topology group scan | RTT measurements scan group snapshots and active sessions to find affected groups. | Existing live RTC three-browser test first, then focused RTT/topology harness. | 10, 100, 1k groups; 3, 30, 300 active sessions; RTT at 1, 10, 50 Hz. | CPU and topology latency scale with all groups/sessions per RTT measurement. | Work scales with groups containing measured sessions only. | CPU profile, scans per RTT, topology enqueue count, event-loop delay, send latency. | Counters in RTT handlers for groups scanned, sessions checked, topology jobs enqueued. |
| B13 | Per-recipient JSON serialization | Direct multi-recipient sends repeatedly serialize identical payloads. | WS send benchmark with large payloads and variable recipients. | 1, 10, 100, 500 recipients; 1 KB, 32 KB, 256 KB payloads. | CPU profile shows `JSON.stringify` proportional to recipient count * payload size. | Serialization cost is negligible compared with network/send overhead. | CPU ticks, allocation rate, send latency, payload bytes, recipients. | Count stringify calls and serialized byte length per outbound message. |
| B14 | Rate limiter full cleanup scan | Rate-limiter lookup scans all limiter entries on every read. | Microbench for limiter service plus ICE/login request load. | 100, 10k, 100k distinct client IDs in a 10-minute TTL window. | Per-request CPU/wall time increases with active limiter keys. | Lookup cost remains effectively constant. | CPU, wall time, heap, Map size, cleanup duration. | Add cleanup duration and limiter entry count metrics. |
| B15 | Hot-path logging | Info/debug logging consumes material CPU/I/O under message-heavy workloads. | Repeat WS/queue traffic with default logging and quiet logging. | Same as B5/B6 with 10k+ messages. | Throughput or p95 latency improves materially with noisy logs disabled. | No meaningful difference, or logging volume is low. | Wall time, CPU, log bytes/sec, event-loop delay, queue lag. | Count log lines by category and include log byte volume. |

## Profiling Commands

### Baseline Existing Test Runs

These are the first repeatable checks because they already exist:

```sh
npm run test:shared-black-box:memory:scale
npm run test:shared-black-box:memory:traffic
npm run test:shared-black-box:memory:parallel
npm run test:shared-black-box:memory:soak
npm run test:shared-black-box:matrix:traffic
npm run test:rallar:full-stack:memory
```

For Postgres-backed runs:

```sh
npm run db:test:up
npm run test:rallar:full-stack:postgres:rest
npm run test:rallar:full-stack:postgres:live-rtc-3
```

Use `npm run db:test:down` when done if the local Postgres service should be
stopped. Avoid `db:reset` during measurement unless intentionally reseeding the
database.

### Direct Black-Box Runner Runs

Use direct runner commands when a smaller repeat count or dedicated artifact
directory is needed:

```sh
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-delivery-semantics.json \
  --iterations=30 \
  --artifact-dir=tmp/perf/artifacts/rallar-memory-scale-30

deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-seeded-traffic.json \
  --artifact-dir=tmp/perf/artifacts/rallar-memory-traffic
```

Runner artifacts to inspect:

- `report.json`
- `events.jsonl`
- `failures.json`
- `metadata.json`
- `expanded-plan.json`, when traffic plans are generated

### API Server With Inspector

Run the API in one terminal:

```sh
mkdir -p tmp/perf/profiles tmp/perf/logs
npm run db:test:up
DATABASE_URL=postgres://app:app@localhost:5432/appdb \
CORS_ORIGINS=http://localhost:5176,http://127.0.0.1:5176 \
deno run \
  --inspect=127.0.0.1:9229 \
  --v8-flags=--expose-gc \
  --env-file=apps/api-v1/.env.local \
  --env-file=apps/api-v1/.env \
  --env-file=.env \
  --config apps/api-v1/deno.json \
  --allow-net --allow-env --allow-read \
  apps/api-v1/src/main.ts
```

Then connect Chrome DevTools to `chrome://inspect` and capture:

- CPU profile during the measured interval.
- Heap snapshot after warmup.
- Heap snapshot after load.
- Heap snapshot after forced GC, if exposed.
- Allocation timeline for suspected JSON parse/stringify paths.

### API Server With V8 CPU Profile

Use this when DevTools is not convenient:

```sh
mkdir -p tmp/perf/profiles
DATABASE_URL=postgres://app:app@localhost:5432/appdb \
CORS_ORIGINS=http://localhost:5176,http://127.0.0.1:5176 \
deno run \
  --v8-flags=--prof \
  --env-file=apps/api-v1/.env.local \
  --env-file=apps/api-v1/.env \
  --env-file=.env \
  --config apps/api-v1/deno.json \
  --allow-net --allow-env --allow-read \
  apps/api-v1/src/main.ts
```

Drive load from another terminal, stop the server, then move the generated
`isolate-*.log` file into `tmp/perf/profiles/`.

### GC Trace Run

Use a short run because `--trace-gc` is noisy:

```sh
DATABASE_URL=postgres://app:app@localhost:5432/appdb \
deno run \
  --v8-flags=--trace-gc,--expose-gc \
  --config apps/api-v1/deno.json \
  --allow-net --allow-env --allow-read \
  apps/api-v1/src/main.ts \
  2> tmp/perf/logs/api-gc-trace.log
```

Expected signals:

- Frequent major GC during steady load suggests retained memory or excessive
  allocation.
- Long GC pauses aligned with request p95/p99 spikes suggest heap pressure is
  visible to users.
- Flat post-GC heap after repeated cycles argues against a leak.

### Postgres EXPLAIN Commands

Start Postgres:

```sh
npm run db:test:up
```

Run EXPLAIN through the Docker service:

```sh
docker compose exec postgres psql -U app -d appdb -c "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM runtime_state_store WHERE store_namespace = 'TODO' AND store_key LIKE 'TODO%' ORDER BY store_key LIMIT 500;"

docker compose exec postgres psql -U app -d appdb -c "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM resource_inbox WHERE ri_type_id = 'TODO' AND ri_status = 'TODO' AND expire_ts > now() AND (start_ts IS NULL OR next_ts < now()) ORDER BY ri_row_id LIMIT 100;"

docker compose exec postgres psql -U app -d appdb -c "EXPLAIN (ANALYZE, BUFFERS) SELECT event_json FROM client_state_events WHERE subject_ref = 'TODO' ORDER BY subject_ref, event_sequence;"

docker compose exec postgres psql -U app -d appdb -c "EXPLAIN (ANALYZE, BUFFERS) SELECT octet_length(update_envelope) FROM crdt_updates WHERE document_id = 'TODO';"

docker compose exec postgres psql -U app -d appdb -c "EXPLAIN (ANALYZE, BUFFERS) SELECT data_value FROM app_data_store WHERE app_namespace = 'TODO' AND store_name = 'TODO' AND data_key LIKE 'TODO%' ORDER BY data_key;"
```

Replace `TODO` values with IDs from the seeded benchmark data. Record whether
plans use indexes, row estimates are accurate, buffers are low, and sorts are
absent on hot paths.

## Minimum Useful Benchmark Harness

The repo already has scenario, traffic, soak, parallel, and full-stack test
coverage. It does not appear to have a narrow endpoint-level benchmark harness
for query count, heap/RSS, and seeded high-cardinality API data. Add the
smallest useful harness before optimizing:

```sh
deno run -A tools/perf/api-state-bench.ts \
  --base-url=http://localhost:8080 \
  --backend=postgres \
  --dataset=state-p1000-g1000-e10000 \
  --endpoint=clients,groups,client-events,group-events \
  --concurrency=1,8,32 \
  --runs=5 \
  --warmup=2 \
  --out=tmp/perf/api-state-bench.json

deno run -A tools/perf/crdt-bench.ts \
  --backend=postgres \
  --documents=1000 \
  --updates-per-document=10000 \
  --payload-bytes=1024 \
  --actors=1,10,50 \
  --quota=on,off \
  --out=tmp/perf/crdt-bench.json
```

Minimum harness requirements:

- Deterministic seeded data.
- Warmup and measured run separation.
- p50/p95/p99 wall time.
- Request and operation throughput.
- Status/error counts.
- Response byte counts.
- `Deno.memoryUsage()` before, after, and after optional forced GC.
- Query count, query duration, and rows read when using Postgres.
- Optional `runnerRunId` or correlation ID in headers/logs.
- JSON/NDJSON output under `tmp/perf/`.

## Memory-Leak Detection Plan

1. Start the API with inspector and `--v8-flags=--expose-gc`.
2. Warm up with a small dataset until JIT and lazy initialization settle.
3. Take a baseline heap snapshot and record `Deno.memoryUsage()`.
4. Run a churn workload:
   - create/connect/close unique principals and sessions;
   - create groups with unique IDs;
   - send state sync messages;
   - let TTL windows expire when applicable;
   - repeat for 10, 100, and 1k cycles.
5. Force GC through DevTools if available.
6. Take a post-GC heap snapshot.
7. Repeat the same churn workload twice more without restarting the server.

Confirm leak-like behavior if:

- post-GC heap grows roughly linearly with unique historical IDs;
- retained objects are dominated by cache entries, sessions, listeners,
  closures, or large JSON payloads;
- cache entry counts keep growing while live active counts remain flat;
- RSS does not stabilize after repeated GC and idle windows.

Falsify leak-like behavior if:

- post-GC heap reaches a plateau;
- cache entry counts match live active entries after expiry;
- retained objects are bounded and expected;
- RSS may remain high due to allocator behavior but used heap stays flat.

Suggested memory-specific commands:

```sh
npm run test:shared-black-box:memory:soak
npm run test:shared-black-box:memory:traffic
npm run test:rallar:full-stack:memory
```

For API-specific cache retention, use the proposed endpoint harness rather than
only browser-driven tests, because it can create more unique principals/groups
with less browser overhead.

## Load And Concurrency Test Plan

### REST State Endpoints

Use the proposed `api-state-bench.ts` harness with:

- concurrency: 1, 8, 32, 128;
- endpoints: `/clients`, `/groups`, legacy `/events`, paged `/events/page`;
- datasets: representative, large, worst-case.

Expected bottleneck signals:

- wall p95/p99 grows faster than throughput;
- DB query count per request grows with tenant size;
- CPU profile shows JSON parse, array copy, filtering, or sorting;
- heap spikes track response size or rows read;
- DB time dominates wall time.

### WebSocket State Sync And RTC

Start with existing flows:

```sh
npm run test:shared-black-box:memory:traffic
npm run test:shared-black-box:memory:parallel
npm run test:shared-black-box:matrix:traffic
npm run test:rallar:full-stack:memory:live-rtc-3
npm run test:rallar:full-stack:postgres:live-rtc-3
```

Then add a focused WS harness if existing scenarios do not produce enough
connections:

- 10, 100, 500 concurrent sockets;
- 1, 10, 100 groups;
- 1 KB, 32 KB, 256 KB payloads;
- broadcast, room, and direct-send cases.

Expected bottleneck signals:

- event-loop delay and send latency rise with total connections rather than
  recipients;
- CPU profile shows recipient scans or repeated serialization;
- GC trace shows frequent allocation during fanout;
- queue lag grows while socket sends are active.

### QueueBox

Use the proposed queue load harness or a black-box recipe that enqueues app/WS
work faster than workers can drain it.

Collect:

- ready row count;
- reserved row count;
- age of oldest ready row;
- reserve latency;
- release latency;
- dequeue batch size;
- worker busy/idle ratio;
- Postgres lock wait and query duration.

Confirm a concurrency bottleneck if queue age grows while CPU and DB are not
saturated and each worker processes one row at a time.

### CRDT

Use a CRDT harness that can run against repositories without browser overhead:

- append only;
- catch-up after N updates;
- list documents;
- export/debug bundle;
- integrity verification;
- append with quota on/off.

Collect:

- append p50/p95/p99;
- transaction duration;
- lock wait;
- rows scanned for quota;
- update envelope bytes;
- hash/canonicalization CPU;
- heap/RSS during export and integrity.

## Required Test Data And Fixtures

Representative data:

- 100 principals.
- 50 groups.
- 10 members per group.
- 1 active session per active principal.
- 100 state events per subject.
- 100 CRDT documents with 100 updates each.
- 1k app-data keys with 512 B values.
- 10 WebSocket clients.

Large data:

- 1k principals.
- 1k groups.
- 100 members per group.
- 3 sessions per active principal.
- 10k state events per hot subject.
- 1k CRDT documents with 10k updates on a hot document.
- 10k app-data keys with 10 KB values.
- 100 WebSocket clients.

Worst-case data:

- 10k principals if local hardware can tolerate it.
- 10k groups.
- 500 members per hot group.
- 100k state events per hot subject.
- 10k CRDT documents and 100k updates on one hot document.
- 100k app-data keys with 10 KB values.
- 500 WebSocket clients.
- Queue table with 1M rows and mixed ready/reserved/expired statuses.

Each fixture should be deterministic and record:

- seed;
- row counts;
- value and payload byte sizes;
- active vs inactive session ratio;
- group membership distribution;
- event sequence range;
- CRDT actor count and update size distribution.

## Risks To Measurement Accuracy

- PGlite-memory results may not predict deployed Postgres behavior.
- Empty or freshly seeded Postgres tables may not reflect bloat, statistics, or
  cache state from real workloads.
- Docker resource limits can hide or exaggerate DB bottlenecks.
- First-run TypeScript/Deno startup and JIT warmup can dominate short runs.
- Browser and Playwright overhead can hide API/server costs.
- Dev laptop CPU scaling, battery mode, and background apps add noise.
- Instrumentation can change timings, especially verbose query or log capture.
- Local loopback has lower latency and lower packet loss than real networks.
- Heap/RSS after GC can differ because RSS is affected by allocator behavior.
- Logging level, CORS/auth mode, and strict-auth scope can change hot paths.
- Randomized traffic plans must record the seed and expanded plan to be
  comparable.

## Recommended Order Of Execution

1. Baseline environment and create `tmp/perf/`.
2. Run existing memory/traffic scripts once to confirm the repo is healthy.
3. Build the minimum endpoint benchmark harness.
4. Measure B3 first: legacy `/events` vs `/events/page`.
5. Measure B1 and B2: `/clients` and `/groups` query counts, latency, and heap.
6. Run Postgres EXPLAIN for B7, B8, B9, B10, and B11.
7. Measure B5, B12, and B13 with WS/RTC traffic and CPU profiles.
8. Measure B6 queue throughput and lag under burst load.
9. Measure B10 CRDT append concurrency and quota cost.
10. Measure B4 memory retention with churn and heap snapshots.
11. Measure B14 and B15 only if earlier runs show CPU headroom consumed by
    request bookkeeping or logging.
12. Mark every hypothesis confirmed, refuted, or inconclusive before choosing
    the first optimization.

## Result Template

Use this table in follow-up reports:

| Hypothesis | Dataset | Command | Result | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| B3 legacy `/events` loads all history | 100k events | `TODO` | `/events` read 100k rows; `/events/page` read 101 rows | `tmp/perf/...` | Confirmed |

Statuses:

- Confirmed
- Refuted
- Inconclusive

