# API-v1 performance validation scripts

API-v1 state-write, CRDT append-history compare, snapshot-read, and
group-topology pooling harnesses live in this directory.

Shared-server runtime, fanout, and SQL seed benches live under
`scripts/platform/perf/`.

## Artifact Policy

Run outputs belong under `tmp/perf/` and are not committed.

Do not check in:

- `tmp/perf/results/**`
- `tmp/perf/profiles/**`
- `tmp/perf/logs/**`
- `tmp/perf/artifacts/**`

## Scripts

| File                                             | Purpose                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `api-v1-state-write-concurrency-bench.ts`        | Direct PostgreSQL API-v1 state-write benchmark for uncontended, shared-group, and hot-group concurrency.              |
| `compare-api-v1-state-write-results.mjs`         | Validates state-write artifacts and enforces the relative performance and correctness gate.                           |
| `compare-api-v1-crdt-append-history-results.mjs` | Validates and compares diagnostic black-box append/replay timings at small, medium, and large bounded CRDT histories. |

## Prerequisites

Run commands from the repository root. Deno harnesses use
`--config apps/api-v1/deno.json`.

Useful environment checks:

```sh
node --version
npm --version
deno --version
docker --version
docker compose version
mkdir -p tmp/perf/results tmp/perf/profiles tmp/perf/logs tmp/perf/artifacts
```

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
`create-state-write-benchmark-sql.ts` configures both the admin and service
clients with API-v1's existing lossless timestamp decoder. PostgreSQL reservation
comparisons require all six fractional digits; JavaScript `Date` decoding loses
precision and can make a worker reject its own observation. When comparing a
revision whose harness omits that decoder, record the same harness-only
correction on a separate measurement commit, retaining its unchanged product
code and original parent identity. Never attribute a setup failure to mutation
latency or fabricate a successful baseline artifact.
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
Snapshot receipts enumerate every page and audience carrier. Capture uses the
canonical AL envelope and snapshot-page decoders, checks the page's source
message, scope, and revision against its operation receipt, and distinguishes
the source route key from the physical page key. Receipt order does not classify
effect kinds. The comparator requires exact physical effect linkage for each
operation, including all snapshot carriers and exactly one event per profile or
instance update. Missing, repeated, or cross-operation carriers fail validation.
`api-v1-state-write-outbox-contract.mjs` owns those completion rules and carrier
counts for capture, comparison, and pooled summaries. Attempt histories are
validated in `validate-state-write-attempt-evidence.mjs`; durable result and
receipt linkage are validated in `validate-state-write-durable-evidence.mjs`.
`atomicCompletionFailures` requires each completed AppInbox result, receipt,
and exact final effects in the same observation. These evidence queries are
excluded from command latency and measurement counters. Every metric source is disclosed in
`measurement.counterSources`.

Compare a candidate with its unmodified baseline:

```sh
node apps/api-v1/scripts/perf/compare-api-v1-state-write-results.mjs \
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
Every receipt links to a nonempty raw command ID, every final ResourceInbox
record has nonempty effect/command/topic/type identity and a raw-command
reference, and finding IDs must match the governed `DBW-...` format. Both
baseline and candidate artifacts must satisfy these same requirements.
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
runs 1–100, and concurrency 1–256. The state-write gate requires exactly one warmup,
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
node apps/api-v1/scripts/perf/capture-api-v1-state-write-environment.mjs \
  --stage preflight --container rallar-perf-bench-postgres \
  --database-url postgres://app:app@localhost:5433/appdb \
  --out tmp/perf/env/position-1-preflight.json

# run the benchmark here

node apps/api-v1/scripts/perf/capture-api-v1-state-write-environment.mjs \
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
requires exactly nine measured runs per workload at every position:

```sh
DATABASE_URL=postgres://app:app@localhost:5433/appdb npm run perf:api-v1:state-write -- \
  --backend=postgres --warmup=1 --runs=9 --concurrency=10 \
  --out=tmp/perf/position-1.json
```

Capture preflight and postflight evidence separately for every position.
`write-api-v1-state-write-pooled-results.mjs` validates the four sources and
pools them into eighteen measured runs per workload for each role. It rejects
equal approved-base and candidate commits, so an identical-code control needs
two distinct commits whose runtime code does not differ.

## Interpreting Results

Treat these scripts as validation tools, not production benchmarks.

When using these scripts to validate an optimization, record:

- branch and commit;
- machine/runtime versions;
- exact command;
- input size and mode;
- number of runs;
- before and after artifacts under `tmp/perf/`.
