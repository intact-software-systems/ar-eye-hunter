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
- CRDT quota byte-sum scans.

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
| `runtime-validation-bench.ts` | Deno benchmark harness for event parsing, cache retention, rate limiter cleanup, state-sync recipient resolution, WebSocket serialization, and cache churn. |
| `summarize-runtime-results.mjs` | Node helper that summarizes harness JSON into per-case duration and memory deltas. |
| `seed-perf-db.sql` | Synthetic Postgres fixture for runtime state, app data, state events, queue rows, and CRDT rows. |
| `explain-perf-db.sql` | EXPLAIN ANALYZE script for the seeded Postgres fixture. |
| `seed-perf-db-sparse-queue.sql` | Worst-case sparse queue fixture and EXPLAIN for runnable-row selection. |

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

