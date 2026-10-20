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

The timed command ends when its actual service sequence returns a validated
AppInbox result. Profile-instance waits for a successful profile result before
submitting the instance update, and its command ends after the instance result.
Each command keeps one owned queue pump through that sequence. A dequeue pass or
timer already in progress is joined after the command endpoint and before the
command's concurrency slot is released. The measured phase, SQL and CPU counters,
and diagnostic release events remain open through this cleanup. A pump failure
after a successful command still fails the workload; it does not rewrite the
observed command boundary.

This completion behavior is a harness revision. A fresh main-versus-candidate
comparison must run both roles with the same candidate perf-directory overlay
and native-check both checkouts. Historical samples from the earlier completion
behavior cannot be mixed with corrected-harness samples, even though both use
schema `rallar.api-v1.state-write.v6`. The repaired boundary does not establish
a production speedup or waive a failed comparison.

After the measured phase, the harness queries completed `APP_INBOX` rows/results,
production idempotency receipts, and final `APP_OUTBOX`/`WS_OUTBOX` rows from
`resource_inbox` through an uninstrumented admin SQL stack.
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

## Opt-in state-write diagnostic timeline

Add `--diagnostics-dir=tmp/perf/<fresh-directory>` to retain a supplemental timeline.
The default is disabled. The enabled writer reserves a new private directory;
existing directories and files are never reused. Canonical v6 output, collection,
workload, comparator and thresholds remain unchanged.

The canonical `--out` file and diagnostic directory must be disjoint: neither
may equal or contain the other. Options reject normalized lexical overlaps.
Before reserving the directory and again before canonical publication, the writer
resolves existing filesystem ancestors, including symlink aliases, and applies
the same policy. An unresolved existing path (including a dangling symlink) is
rejected without writing canonical output. A rejected publication preserves phase
and partial evidence and finalizes diagnostics as incomplete. Use sibling paths,
for example `--out=tmp/perf/run.json --diagnostics-dir=tmp/perf/run-timeline`.
These checks cover existing path identities; they do not lock parent directories
against concurrent external filesystem changes.

Each warmup or measured phase writes `phase-<ordinal>.ndjson` after its duration,
CPU and PostgreSQL counters have been captured. Fixed ceilings are 110,000 retained
timing plus release records per phase, 33,554,432 serialized bytes per phase and
536,870,912 serialized bytes per run. Boundary records are counted separately;
command/kind boundaries and release facts have priority over timing events.
The logical event ceiling is an explicit 10% resource-budget increase from
100,000, leaving 8,815 events above the observed 101,185-event maximum. The byte
ceilings are unchanged. This does not change correctness or performance acceptance,
guarantee future captures fit, or bound the pre-existing raw timing array collection.
These limits are safeguards, not measured event maxima. No canonical arrays are
truncated. The phase footer reports total, retained, unassociated, rejected and
truncated counts. Expected process-level SQL or unavailable attempt/worker facts
are disclosed; invalid joins and capacity loss make the projection incomplete.

Current captures use `rallar.state-write.diagnostic.v3`: readable named JSON records
retain every independent timing field, event order and multiplicity. Only the two
exactly derived timing-row properties are omitted: `approximateStartedAtEpochMs`
is `completedAtEpochMs - roundedDurationMs`; `statusMeaning` is
`wrapper-finally-not-commit` for component `state-write-benchmark-phase` and
`timed-operation-status` otherwise. Wrapper-finally status never proves commit.
Existing timing fields retain millisecond units; reservation intervals use microseconds.
Human reports use seconds. The schema
version identifies this derivation contract without repeating it in every timing row.

The sidecar exports fixed labels and phase-local command ordinals. Private exact
logical/physical AppInbox expectations associate profile and instance separately.
Originating command stack and observing timing stack are distinct; release worker
identity is unavailable. Raw identities, authority, payloads, SQL and error text
are excluded. Command/run monotonic bounds reuse existing clock reads, with the
performance clock origin read outside timing. Timing completion stamps and rounded
durations retain their original meaning; completion minus duration is approximate,
and kind intervals are derived command envelopes. Exact kind endpoints, selected
due timestamps and native-profiler alignment are unavailable. The SQL transaction
wrapper's status is not commit evidence. A failed command retains its observed
start and explicitly unavailable end.

A final `receipt.json` is complete only when all requested projections and writes
succeeded. Fixed status stages disclose the first failure; `projection` includes
invalid associations and phase truncation, whose counts are in the phase footer.
Each file is written and closed at an exclusive `.partial` path before reserving
an empty canonical path and renaming over that owned reservation. A failed write,
close or rename retains partial evidence and may leave an empty canonical file;
only a published canonical receipt establishes completeness. No fallible cleanup
follows successful publication. Receipt byte accounting conservatively reserves
all projected phase bytes, including failed writes, plus 1,024 bytes for the
receipt, so partial evidence also remains within the run ceiling. The writer
reports incomplete status without source error text. An otherwise successful
benchmark still writes v6 and exits nonzero for incomplete diagnostics; an
original operation failure remains the original failure.

Ordinary, unobserved PostgreSQL RETRY claims optionally retain the previous persisted
retry delay and due-to-reservation observation interval as signed safe-integer
microseconds. Both intervals are subtracted in PostgreSQL before truncation toward
zero; negative values remain visible. The observation occurs in UPDATE RETURNING,
after update and before commit, and does not measure lock, commit or handler time.
Microsecond quantization and database wall-clock adjustments limit interpretation.
Human reports convert these values to seconds with explicit units.

Each release carries availability, boundary, association and reservation attempt.
The attempt stays distinct from a not-ready release's decremented attempt. Missing
or malformed expected RETRY observations make the projection incomplete; NEW is
not applicable, and FAIRNESS, TIMEOUT and FINALIZATION remain explicitly uncaptured.
Observed PostgreSQL claims and non-PostgreSQL stores cannot provide these intervals.
The footer counts expected, available and unavailable RETRY observations. Physical
keys and previous timestamps remain private. Existing v2 originals are preserved;
the current hosted capture validator admits v3 only.

The original CLI dispatches comparison mode through a shared workload runner and
loads one fixed diagnostic entry only when `--diagnostics-dir` is present. Candidate
and baseline comparison use the identical perf overlay. Diagnostic composition
requires the current production observation validator and fails during import on
unsupported historical production, before database setup. Native checks cover both
candidate entries and the baseline comparison entry separately.

Scalar stores and allocations in the mapper are diagnostic overhead. Enabled mode
also retains an additional phase-local array of references to release telemetry;
the serialization budgets do not bound that array or canonical collection. Post-phase
projection and I/O can affect later phases. This overlay is not a performance
improvement claim and does not authorize or replace the governed comparison.

For source navigation, start at `api-v1-state-write-concurrency-bench.ts` for mode selection.
Under `state-write/`, `run-state-write-benchmark.ts` owns the single SQL/phase/artifact
lifecycle and `run-state-write-diagnostic.ts` owns diagnostic reader composition; `state-write-workload.ts` owns
the complete seven-kind command and queue-pump flow, `seed-complete-state.ts` owns
setup, and `state-write-measurement.ts` owns summaries. Exact command/operation association
policy lives in `state-write-diagnostic-association.ts`; record projection and caps
live in `state-write-diagnostic-projection.ts`; file lifecycle lives
in `state-write-diagnostic-writer.ts`. `state-write-benchmark-output.ts` owns the
mandatory v6 file effect followed by supplemental finalization.

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

Preflight uses the already installed pinned image; it does not pull from a registry.
Docker stores may expose a configuration ID (classic store) or an OCI index ID
(containerd store). `read-api-v1-state-write-image-identity.mjs` derives the
existing governed `image_id` from original configuration bytes. For containerd,
it binds the actual container's selected manifest descriptor to the local export,
checks original manifest and configuration SHA256 digests, sizes and declared
platform, and retains their provenance separately from the reconstructed export
index. The reconstructed index digest is not the pinned repository digest.
Classic exports must hash to the native container image ID.

This capture requires a POSIX `tar` supporting `-tf`, `-tvf` and `-xOf` with
`--` before the named member, and Docker image-save platform selection. The
reader was verified with native macOS BSD tar on the retained arm64 export;
Linux/GNU tar and Windows execution have not been verified by that local proof.
No layers are extracted and metadata/process output is bounded. Each preflight
reserves a fresh `<out>.acquisition` directory; an existing directory or output
is rejected. The native export is written directly there, without a temporary
transport copy. Original container/image inspection bytes, export index or classic
metadata, selected manifest (containerd) and configuration bytes remain readable.
The sidecar's `imageProof.acquisition` binds their absolute paths, byte sizes and
SHA256 hashes. The directory is private to the capture; raw inspection documents
may contain sensitive native configuration and should stay with private evidence.
Failed attempts retain any acquired bytes for diagnosis and emit no successful
sidecar; use a fresh output for a later authorized attempt rather than reusing it.
Local export, metadata I/O and archive hashing occur before benchmark timing.
Metadata acquisition milliseconds cover export through retained archive hashing,
excluding initial native inspection, so preparation cost remains visible.

The postflight stage validates before writing, so a descriptor that reaches
disk is one the pooling protocol accepts. It preserves preflight empty-table
counts and samples current container identity, exact native running-session start,
restart count, governed resources, and process/container overlap. The sidecar
requires a usable native start identity; historical sidecars without it are rejected.
A non-empty preflight database, a changed start identity (including a manual restart
whose restart count is zero), a reported restart, changed governed resources,
or overlap present at postflight fails capture.
These boundary samples do not continuously observe transient overlap or resource
changes that revert before postflight.

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

## Hosted order-balanced comparison

`.github/workflows/api-v1-state-write-pr-measurement.yml` runs the order-balanced protocol above on one
GitHub-hosted runner. Add the label `measure-state-write` to a pull request, or remove and add it again to
measure a newer head. Once the workflow is on `main` it can also be dispatched with a `ref`.

It measures the candidate against its merge base with `main` in A-B-B-A order. Both sides run the
candidate's `apps/api-v1/scripts/perf` harness, and the pooled result goes through the unchanged comparator.
The workflow refuses a candidate that changes the comparator or a module it imports, `package-lock.json`,
`apps/api-v1/deno.json`, `apps/api-v1/deno.lock`, `docker-compose.perf-bench.yml`, or the
`perf:api-v1:state-write` and `db:migrate` scripts.

The artifact `state-write-comparison-<run>-<attempt>` keeps the four captures, their environment records,
the harness overlay patch, original acquisition bytes, command streams and `comparison.log`. Each
benchmark's stdout retains its workload summaries, including `sql.serializedResultBytes`.

## Hosted bounded diagnostic

Manual dispatch accepts `mode=comparison` (the default) or `mode=diagnostic`. The supported PR label
continues to select comparison. Concurrency includes the selected mode and label, so an unrelated
label or a diagnostic cannot cancel a comparison.

Diagnostic mode checks out one candidate with persisted checkout credentials disabled. It records
that immutable commit, tree, clean tracked state, hashes of the workflow, compose fixture, dependency
inputs and every tracked performance executable, plus toolchain and native runner facts. It checks
those source inputs again immediately before the benchmark. It does not resolve or synthesize a base,
apply a harness overlay, pool samples, or invoke the comparative verdict.

On an admitted `ubuntu-24.04` GitHub-hosted runner, it executes exactly once:

```sh
npm run perf:api-v1:state-write -- \
  --backend=postgres --warmup=1 --runs=3 --concurrency=10 \
  --out=tmp/perf/state-write-diagnostic/<run>-<attempt>/artifacts/state-write.json \
  --diagnostics-dir=tmp/perf/state-write-diagnostic/<run>-<attempt>/diagnostics
```

The workflow substitutes the actual GitHub run ID and attempt. Fresh `commands/`, `artifacts/`,
`diagnostics/` and capture-owned `.acquisition` destinations keep producer originals separate.
All three workloads, twelve phases, 8,400 total commands and 6,300 measured commands are required.
The unchanged exported `validateStateWriteArtifact` validates canonical v6 correctness. The hosted
owner validates only the fresh v3 capture from that same pinned candidate checkout;
unsupported schemas and incomplete or inconsistent row/count evidence fail closed.
It has no historical-input API. Original v1/v2 artifacts remain unchanged; no historical
adapter is added. The owner also checks every diagnostic phase, the complete receipt,
byte accounting and the fixed
110,000 timing/release records per phase, 33,554,432 bytes per phase and 536,870,912 bytes per run.
A successful workflow is diagnostic evidence; it does not repair a failed comparison or satisfy
frozen scale acceptance.

`run-api-v1-state-write-measurement.mjs` owns the provisioning, migration, capture, benchmark,
postflight, database-log and cleanup lifecycle for both modes. Admission requires at least four CPUs,
no pre-existing containers and no existing state-write workload. It provisions only the explicit
pinned compose fixture under `state-write-comparison`, outside measurement timing. Every command
retains argv, cwd, UTC start/end, actual child PID and terminal outcome. The owner settles that same
child and its process group before a later capture, log, cleanup or export, including interruption or
metadata/stream recording failure. Postflight is attempted whenever preflight exists; logs and owned
project/volume removal are attempted on every provisioned exit. The first failure is retained
separately from secondary failures. A changed container/project/service/image/context refuses
cleanup; no unrelated process or local development container is stopped or restored.

The separately named 14-day `state-write-diagnostic-originals-<run>-<attempt>` artifact includes the
canonical output, diagnostic receipt and phases, command streams, source binding, hashes/inventory,
and original native inspections, image archive and metadata chain. Raw upload is admitted only after
the capture-produced original configuration matches image-default environment plus the three literal
compose database overrides, the fixed compose labels/context, no custom environment or bind/custom
mount, and one fresh image-declared anonymous database volume. The pinned public image's image-save
archive excludes container database data and the runner environment. Ephemeral IDs, addresses,
session facts and public runner paths are expected disclosure. Unexpected configuration refuses raw
upload without printing its values; `state-write-terminal-<run>-<attempt>` retains safe failure and
refusal evidence. Failed or incomplete evidence is retained as failed or incomplete.

The existing native image reader and descriptor validator remain authoritative. Linux/GNU-tar
portability must be established by the actual hosted acquisition; local BSD-tar evidence and fake
command-port tests do not establish it.

## Interpreting Results

Treat these scripts as validation tools, not production benchmarks.

When using these scripts to validate an optimization, record:

- branch and commit;
- machine/runtime versions;
- exact command;
- input size and mode;
- number of runs;
- before and after artifacts under `tmp/perf/`.
