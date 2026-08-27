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

- eager state event listing loading full histories;
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

| File                                             | Purpose                                                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-validation-bench.ts`                    | Deno benchmark harness for event parsing, runtime prefix reads, cache retention, rate limiter cleanup, state-sync recipient resolution, WebSocket serialization, and cache churn. |
| `summarize-runtime-results.mjs`                  | Node helper that summarizes harness JSON into per-case duration and memory deltas.                                                                                                |
| `api-v1-state-write-concurrency-bench.ts`        | Direct PostgreSQL API-v1 state-write benchmark for uncontended, shared-group, and hot-group concurrency.                                                                          |
| `compare-api-v1-state-write-results.mjs`         | Validates state-write artifacts and enforces the relative performance and correctness gate.                                                                                       |
| `compare-api-v1-crdt-append-history-results.mjs` | Validates and compares diagnostic black-box append/replay timings at small, medium, and large bounded CRDT histories.                                                             |
| `seed-perf-db.sql`                               | Synthetic Postgres fixture for runtime state, app data, state events, queue rows, and CRDT rows.                                                                                  |
| `explain-perf-db.sql`                            | EXPLAIN ANALYZE script for the seeded Postgres fixture.                                                                                                                           |
| `seed-perf-db-sparse-queue.sql`                  | Worst-case sparse queue fixture and EXPLAIN for runnable-row selection.                                                                                                           |
| `client-list-fanout-bench.ts`                    | Client snapshot fanout/pagination workload.                                                                                                                                       |
| `group-list-fanout-bench.ts`                     | Group snapshot fanout/pagination workload.                                                                                                                                        |

## RTC/WebRTC benchmark package

All RTC/WebRTC performance executables, their owning tests, exact commands,
inputs, measured production symbols, timing boundaries, validation, output
classes, and accepted/diagnostic status are catalogued in
[`packages/shared-rtc-bench/README.md`](../../packages/shared-rtc-bench/README.md).
Use the private `@ar-eye-hunter/shared-rtc-bench` workspace for package checks.
The root commands `perf:rtc-baseline`, `perf:rtc-topology:delivery-log`, and
`perf:rtc-topology:replay-drain` retain their existing CLI grammar and now enter
that package directly. RTC production implementations remain authoritative;
the benchmark package measures them and does not reimplement RTC behavior.

RTC-B05 is also captured as a continuous browser observation stream. The
`RTC-B05 Performance Observation` workflow runs nightly at 03:17 UTC and by
manual dispatch, measures the `main` snapshot selected when the run starts,
and records the exact source commit rather than waiting for a permanently
stable head. Each verified result is retained as a workflow artifact and is
published through an observation-only pull request when
`RTC_OBSERVATION_PR_TOKEN` is configured with repository Contents and Pull
Requests access. Archive-only merges are excluded from product deploy and
supported distributed-manifest push triggers.

Local capture and archive verification commands, archive contents, and
failure semantics are documented in the package README. Local outputs still
belong under `tmp/perf/`; only the scheduled publication path writes the
append-only `performance-observations/rtc-b05/**` repository stream.

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

## CRDT append-history black-box diagnostic

Issue #265 tracks the PostgreSQL CRDT append path reading and decoding a complete document history
to determine whether one update is new or duplicated. The focused diagnostic exercises the real
authenticated WebSocket -> AppInbox -> PostgreSQL -> committed-reply path rather than a synthetic
repository-only benchmark.

One parameterized recipe runs three cases. It seeds 10, 100, or 480 updates outside measurement,
warms the duplicate path without growing history, and then measures 20 new appends plus 20 exact
duplicate replays. The terminal histories are 30, 120, and 500 updates. Every replay uses a fresh
outer delivery ID so ResourceInbox cannot bypass the CRDT repository lookup. Final integrity,
catch-up, fanout, and AppInbox/outbox evidence remain correctness requirements.

Capture the two sides against fresh managed PostgreSQL databases on the same host:

```sh
RALLAR_CRDT_APPEND_HISTORY_ARTIFACT_DIR=../../tmp/perf/crdt-append-history/baseline \
  npm run test:api-v1:black-box:postgres:crdt-append-history
RALLAR_CRDT_APPEND_HISTORY_ARTIFACT_DIR=../../tmp/perf/crdt-append-history/candidate \
  npm run test:api-v1:black-box:postgres:crdt-append-history
npm run perf:api-v1:crdt-append-history:compare -- \
  tmp/perf/crdt-append-history/baseline/cluster \
  tmp/perf/crdt-append-history/candidate/cluster
```

The comparison derives each end-to-end sample from the send step's start to the paired committed
reply's end, validates exactly 20 successful pairs per operation and case, and prints p50/p95
candidate-to-baseline ratios. It is diagnostic: malformed or failed artifacts cause a nonzero exit,
but one noisy valid ratio is reported rather than promoted to a performance gate. The recipe does
not measure process memory and its results do not support a memory claim.

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

Artifacts use schema `rallar.api-v1.state-write.v6`. Each measured run retains
exactly 700 command records and latencies (100 of every mutation kind), balanced
service-stack counts, and durable AppInbox attempt observations.
It also includes latency percentiles, throughput, SQL/row/serialized-byte
metrics, transaction and production phase timings, PostgreSQL lock/buffer/WAL
counters, and process CPU time. PostgreSQL buffer and WAL counters are captured
immediately before and after each measured phase; lock waits are sampled from
`pg_stat_activity` while the phase runs.

Attempt observations come from actual ResourceInbox release telemetry and are
reconciled exactly with durable `resource_inbox.ri_attempts` values for the
operation's production-derived AppInbox resource, topic, and context tuple.
Each operation has a one-based attempt number, observed retry
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

## Pinned Benchmark Environment

The dev container in `docker-compose.yml` is deliberately convenient — floating
tag, autovacuum on, no resource reservation — and those are the properties that
make medians drift between otherwise identical runs (issue #157).
`docker-compose.perf-bench.yml` is its controlled counterpart: the digest,
command, shm size, memory, and CPU count are all pinned because
`validate-api-v1-state-write-environment.mjs` compares them for exact equality.
It listens on 5433 and declares no named volume, so `down -v` genuinely returns
an empty data directory.

Every governed PostgreSQL setting except `autovacuum` is simply the PostgreSQL
16 default, so the pinned environment is stock PG16 with autovacuum off, 4 GiB
memory, 4 CPUs, and 256 MiB of shared memory.

The pooling protocol also requires no other running containers and no other
running benchmark process, so stop the dev container first.

```sh
docker stop ar-eye-hunter-postgres
docker compose -f docker-compose.perf-bench.yml down -v
docker compose -f docker-compose.perf-bench.yml up -d --wait
DATABASE_URL=postgres://app:app@localhost:5433/appdb npm run db:migrate
```

`capture-api-v1-state-write-environment.mjs` emits the governed descriptor that
each pooling source requires. Capture is two-stage because the field semantics
bracket the run: preflight row counts and the preflight maintenance counter
describe the database the benchmark started against, and the postflight
maintenance counter proves no automatic maintenance ran during it.

```sh
node scripts/perf/capture-api-v1-state-write-environment.mjs \
  --stage preflight --container rallar-perf-bench-postgres \
  --database-url postgres://app:app@localhost:5433/appdb \
  --out tmp/perf/env/position-1-preflight.json

# run the benchmark here

node scripts/perf/capture-api-v1-state-write-environment.mjs \
  --stage postflight --container rallar-perf-bench-postgres \
  --database-url postgres://app:app@localhost:5433/appdb \
  --preflight tmp/perf/env/position-1-preflight.json \
  --out tmp/perf/env/position-1.txt
```

The postflight stage validates before writing, so a descriptor that reaches
disk is one the pooling protocol accepts. A non-empty preflight database, a
container restarted mid-run, or an overlapping container fails the capture
rather than surviving into a verdict.

The order-balanced protocol runs four positions — approved-base, candidate,
candidate, approved-base — each against a freshly recreated container, and
`write-api-v1-state-write-pooled-results.mjs` pools them. Note that it rejects
equal approved-base and candidate commits, so an identical-code control needs
two distinct commits whose runtime code does not differ.

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
