# Rallar Runtime Performance Validation Report

Date: 2026-07-02

Scope: runtime validation of the highest-risk findings from
`playground/rallar-static-performance-audit-2026-07-02.md` and
`playground/rallar-runtime-performance-validation-plan-2026-07-02.md`.

No optimization changes were made. Generated scripts, fixtures, profiles, and
benchmark outputs were isolated under `tmp/perf/`.

## Environment

- Branch: `main`
- Commit: `8c8a5fea8a6e348a2e91a583bd52bf843487b5ff`
- Host: macOS 26.5.1, Apple Silicon
- Node: `v26.4.0`
- npm: `11.17.0`
- Deno: `2.9.0`
- Docker: `29.6.1`
- Docker Compose: `v5.1.4`
- Postgres: local Docker Compose service `postgres:16`

Notes:

- Postgres was started through Docker for query-plan validation.
- Synthetic DB rows use `perf-*` namespaces and IDs.
- Synthetic rows were not deleted after measurement because cleanup would be a
  destructive database operation.
- Prisma migration reported a blank schema-engine error, but direct inspection
  showed the expected schema already existed.

## Commands Run

Focused runtime harness:

```sh
deno run --config apps/api-v1/deno.json --allow-read --allow-write --v8-flags=--expose-gc tmp/perf/scripts/runtime-validation-bench.ts --mode=full --runs=3 --out=tmp/perf/results/runtime-validation-focused-runs3.json
node tmp/perf/scripts/summarize-runtime-results.mjs tmp/perf/results/runtime-validation-focused-runs3.json tmp/perf/results/runtime-validation-focused-summary.json
```

CPU profile:

```sh
deno run --config apps/api-v1/deno.json --allow-read --allow-write --v8-flags=--prof,--expose-gc tmp/perf/scripts/runtime-validation-bench.ts --mode=full --runs=1 --out=tmp/perf/results/runtime-validation-focused-profiled-run.json
node --prof-process tmp/perf/profiles/runtime-validation-focused-v8.log > tmp/perf/profiles/runtime-validation-focused-v8-processed.txt
```

GC trace:

```sh
deno run --config apps/api-v1/deno.json --allow-read --allow-write --v8-flags=--trace-gc,--expose-gc tmp/perf/scripts/runtime-validation-bench.ts --mode=events --runs=3 --out=tmp/perf/results/runtime-validation-events-gc-run.json > tmp/perf/logs/runtime-validation-events-gc-stdout.log 2> tmp/perf/logs/runtime-validation-events-gc-stderr.log
```

Memory churn:

```sh
deno run --config apps/api-v1/deno.json --allow-read --allow-write --v8-flags=--expose-gc tmp/perf/scripts/runtime-validation-bench.ts --mode=leak --runs=1 --out=tmp/perf/results/runtime-validation-cache-leak-churn.json
```

Existing black-box runner checks:

```sh
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-seeded-traffic.json --artifact-dir=tmp/perf/artifacts/rallar-memory-traffic
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-parallel-groups.json --artifact-dir=tmp/perf/artifacts/rallar-memory-parallel
```

Postgres validation:

```sh
npm run db:test:up
docker compose exec -T postgres psql -U app -d appdb < tmp/perf/scripts/seed-perf-db.sql
docker compose exec -T postgres psql -U app -d appdb -c "ANALYZE runtime_state_store; ANALYZE app_data_store; ANALYZE client_state_events; ANALYZE resource_inbox; ANALYZE crdt_documents; ANALYZE crdt_updates;"
docker compose exec -T postgres psql -U app -d appdb < tmp/perf/scripts/explain-perf-db.sql > tmp/perf/results/postgres-explain-perf-db-after-analyze.txt
docker compose exec -T postgres psql -U app -d appdb -c "EXPLAIN (ANALYZE, BUFFERS) SELECT event_json FROM client_state_events WHERE application_id = 'perf-app' AND workspace_key = 'perf-workspace' AND principal_id = 'perf-principal' AND (snapshot_version, occurred_at_epoch_ms, event_id) > (90000, 1700000090000, 'perf-event-00090000') ORDER BY snapshot_version, occurred_at_epoch_ms, event_id LIMIT 101;" > tmp/perf/results/postgres-explain-event-page-row-value-after-analyze.txt
docker compose exec -T postgres psql -U app -d appdb < tmp/perf/scripts/seed-perf-db-sparse-queue.sql > tmp/perf/results/postgres-explain-sparse-queue.txt
```

## Artifact Index

- Focused benchmark raw results:
  `tmp/perf/results/runtime-validation-focused-runs3.json`
- Focused benchmark summary:
  `tmp/perf/results/runtime-validation-focused-summary.json`
- V8 raw profile:
  `tmp/perf/profiles/runtime-validation-focused-v8.log`
- V8 processed profile:
  `tmp/perf/profiles/runtime-validation-focused-v8-processed.txt`
- Event GC trace:
  `tmp/perf/logs/runtime-validation-events-gc-stdout.log`
- Cache churn:
  `tmp/perf/results/runtime-validation-cache-leak-churn.json`
- Postgres EXPLAIN after `ANALYZE`:
  `tmp/perf/results/postgres-explain-perf-db-after-analyze.txt`
- Exact repository-shaped event page EXPLAIN:
  `tmp/perf/results/postgres-explain-event-page-row-value-after-analyze.txt`
- Sparse queue EXPLAIN:
  `tmp/perf/results/postgres-explain-sparse-queue.txt`
- Black-box traffic report:
  `tmp/perf/artifacts/rallar-memory-traffic/report.json`
- Black-box parallel report:
  `tmp/perf/artifacts/rallar-memory-parallel/report.json`

## Results Summary

| Area                                 |                      Measurement | Result                               | Status                            |
| ------------------------------------ | -------------------------------: | ------------------------------------ | --------------------------------- |
| Legacy events, in-process parse/list |                        100k rows | 38.8 ms median, 40.3 ms max          | Confirmed                         |
| Paged events, in-process parse/list  | 100k-row source, 100 parsed rows | 0.056 ms median                      | Confirmed fix direction           |
| Legacy event SQL                     |                        100k rows | 31.7 ms execution time               | Confirmed                         |
| Exact event page SQL                 |                         101 rows | 0.082 ms execution time              | Confirmed fix direction           |
| Runtime state broad prefix SQL       |                        100k rows | 41.3 ms execution time               | Confirmed                         |
| App-data broad prefix SQL            |                         50k rows | 9.36 ms execution time               | Confirmed, lower severity         |
| Observable cache expiry              |             100k expired entries | 100k retained entries, 0 live values | Confirmed                         |
| Observable cache cleanup             |             100k expired entries | 75.6 ms median                       | Confirmed                         |
| Cache churn                          |      10k to 100k cumulative keys | post-GC heap grew 14.5 MB to 91.2 MB | Confirmed leak-like retention     |
| Direct WS stringify                  |   500 recipients, 256 KB payload | 36.3 ms median                       | Confirmed                         |
| Broadcast encode once                |   500 recipients, 256 KB payload | 0.089 ms median                      | Confirmed contrast                |
| Rate limiter read                    |      100 reads at 5k cached keys | 15.6 ms median                       | Confirmed small but real          |
| State-sync recipient resolution      |                10 to 500 clients | 0.095 ms to 0.313 ms median          | Inconclusive for production scale |
| Queue dense runnable SQL             |                100 returned rows | 0.157 ms execution time              | Dense case refuted                |
| Queue sparse runnable SQL            |                100 returned rows | scanned 200,328 rows, 19.9 ms        | Worst-case confirmed              |
| CRDT quota byte sum                  |                     100k updates | 12.2 ms execution time               | Confirmed, workload-dependent     |
| CRDT catch-up page                   |      500 rows after sequence 90k | 0.14 ms execution time               | Refuted for tested page shape     |
| Memory traffic black-box             |            seeded traffic recipe | 10/10 success, 165 ms                | Smoke passed                      |
| Memory parallel black-box            |           parallel groups recipe | 19/19 success, 59 ms                 | Smoke passed                      |

## CPU Profile Interpretation

The processed V8 profile is readable but reports a V8 version mismatch when
processed by Node, so percentages should be treated as directional rather than
precise.

The hottest identifiable JavaScript path was:

- `LatestRepository.deleteExpired`
- called through `readRateLimiter`
- visible in `tmp/perf/profiles/runtime-validation-focused-v8-processed.txt`

The profile also showed work from event parsing and serialization benchmark
closures. A large share of total ticks landed in runtime/GC internals, which is
consistent with the allocation-heavy benchmark shape.

CPU conclusions:

- Repeated cleanup scans in `readRateLimiter` are real CPU work.
- Repeated per-recipient `JSON.stringify` is material for large fanout payloads.
- Legacy event materialization burns CPU in proportion to total event history,
  while page-only parsing stays flat.

## Memory Profile Interpretation

The GC trace for the event benchmark showed repeated scavenges and
mark-compacts while materializing larger event arrays. During the 100k-event
workload, heap rose into the tens of MB before forced GC returned it.

The strongest memory result is the cache churn artifact:

| Cumulative expired keys | Retained entries | Live values | Post-GC heap |
| ----------------------: | ---------------: | ----------: | -----------: |
|                     10k |              10k |           0 |      14.5 MB |
|                     50k |              50k |           0 |      48.6 MB |
|                    100k |             100k |           0 |      91.2 MB |

After explicit `deleteExpired()`, retained entry count dropped to zero. RSS did
not immediately return to baseline, which is expected allocator behavior and not
enough by itself to prove a permanent leak.

Memory conclusion:

- The cache issue is confirmed as leak-like retained metadata/entries without
  scheduled eviction.
- It is not proven that memory is unrecoverable after explicit cleanup.

## Hypotheses

| Hypothesis                                                          | Evidence                                                                                       | Status                   | Notes                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| Legacy `/events` loads and parses full history before slicing.      | 100k-row in-process path: 38.8 ms median; SQL full list: 31.7 ms. Exact page SQL: 0.082 ms.    | Confirmed                | Strongest and cleanest result.                                     |
| Runtime/app-data prefix scans materialize broad row sets.           | Runtime 100k rows: 41.3 ms. App-data 50k rows: 9.36 ms.                                        | Confirmed                | App-data lower in this fixture, but still unbounded.               |
| Snapshot/latest caches retain expired entries.                      | 100k expired entries retained with 0 live values; churn heap grows with historical keys.       | Confirmed                | Requires missing/insufficient eviction to become production issue. |
| Direct multi-recipient sends repeatedly serialize large payloads.   | 500 recipients, 256 KB direct: 36.3 ms median. Broadcast encode-once: 0.089 ms.                | Confirmed                | Fake sockets isolate serialization cost from network cost.         |
| Rate limiter cleanup scans all cached keys per read.                | 100 reads at 5k cached keys: 15.6 ms median; CPU profile highlights `deleteExpired`.           | Confirmed                | Impact depends on distinct client cardinality.                     |
| Queue runnable selection is index-unfriendly.                       | Dense runnable rows are fast; sparse runnable distribution scans 200,328 rows for 100 results. | Partially confirmed      | Risk is distribution-dependent.                                    |
| CRDT quota byte sum scales with hot document update count.          | 100k updates byte sum: 12.2 ms.                                                                | Confirmed                | Could matter on hot append paths with quota enabled.               |
| CRDT catch-up pages are slow.                                       | 500-row catch-up after sequence 90k: 0.14 ms.                                                  | Refuted for tested shape | Full export/integrity paths still need separate validation.        |
| State-sync recipient scans dominate at moderate scale.              | 500-client synthetic resolution: 0.313 ms median.                                              | Inconclusive             | Did not test real topic traffic, topology RTT, or 10k+ snapshots.  |
| Full `/clients` and `/groups` REST fanout is a measured bottleneck. | Related primitives measured, but exact route query-count fixture was not built.                | Inconclusive             | Still plausible from static audit.                                 |

## Ranked Bottlenecks

1. Legacy event listing loads full history.
   - Expected impact: high.
   - Confidence: high.
   - Implementation risk: low to medium.
   - Evidence: 100k full-list path vs exact page query.

2. Cache repositories retain expired entries without eviction.
   - Expected impact: high for long-lived/high-cardinality processes.
   - Confidence: high.
   - Implementation risk: medium.
   - Evidence: retained entries and heap growth with expired keys.

3. Direct WebSocket multi-recipient send repeats serialization.
   - Expected impact: high for large payload fanout.
   - Confidence: high.
   - Implementation risk: low to medium.
   - Evidence: 36.3 ms direct vs 0.089 ms broadcast in the 500-recipient,
     256 KB case.

4. Runtime/app-data broad scans lack pagination/projection.
   - Expected impact: medium to high.
   - Confidence: medium-high.
   - Implementation risk: medium.
   - Evidence: broad SQL scans over 50k to 100k rows.

5. Queue runnable selection can degrade under sparse runnable distributions.
   - Expected impact: medium to high during queue backlog skew.
   - Confidence: medium.
   - Implementation risk: medium.
   - Evidence: dense case fast, sparse case scanned 200k rows.

6. CRDT quota byte sum scans all updates for a hot document.
   - Expected impact: medium when quotas are enabled on hot documents.
   - Confidence: medium.
   - Implementation risk: medium.
   - Evidence: 12.2 ms for 100k update envelopes.

7. Rate limiter per-read cleanup scan.
   - Expected impact: low to medium.
   - Confidence: medium-high.
   - Implementation risk: low.
   - Evidence: measurable scaling and CPU profile visibility.

## Recommended Fixes

| Rank | Fix                                                                               | Expected impact | Confidence  | Risk       | Validation                                                |
| ---: | --------------------------------------------------------------------------------- | --------------- | ----------- | ---------- | --------------------------------------------------------- |
|    1 | Route legacy `/events` through SQL-limited paging or equivalent DESC-limit query. | High            | High        | Low-medium | Re-run focused events harness and route-level tests.      |
|    2 | Add scheduled or bounded eviction for state snapshot/latest caches.               | High            | High        | Medium     | Re-run cache churn and long-lived black-box memory tests. |
|    3 | Add an encoded/pre-serialized send path for repeated direct WS sends.             | High for fanout | High        | Low-medium | Re-run serialization benchmark and WS send tests.         |
|    4 | Add pagination/projection for runtime/app-data broad list paths.                  | Medium-high     | Medium-high | Medium     | Re-run prefix EXPLAIN and endpoint benchmarks.            |
|    5 | Revisit queue runnable query/index strategy for sparse runnable rows.             | Medium-high     | Medium      | Medium     | Re-run dense and sparse queue EXPLAINs.                   |
|    6 | Store rolling CRDT document byte totals for quota checks.                         | Medium          | Medium      | Medium     | Re-run CRDT quota append benchmark.                       |
|    7 | Move rate-limiter expiry cleanup off the per-read path or bucket it.              | Low-medium      | Medium-high | Low        | Re-run rate-limiter benchmark.                            |

## Measurement Limits

- The focused harness isolates hot functions and does not fully reproduce API
  middleware, auth, network, or browser overhead.
- State-sync tests used fake sockets and moderate synthetic sizes.
- `/clients` and `/groups` exact route query counts remain unmeasured.
- Live browser RTC/topology scale remains unmeasured beyond small memory-mode
  black-box smoke recipes.
- Synthetic Postgres fixtures are useful for shape and query-plan behavior, but
  production row distribution, table bloat, and cache warmth may differ.
- The V8 profile was processed with a version mismatch warning.

## Next Step

Attempt one small optimization first: replace the legacy `/events` route
implementation with the existing paged repository path, preserving API response
shape where possible. This has the best evidence, clear before/after
measurement, and the lowest risk among the confirmed bottlenecks.
