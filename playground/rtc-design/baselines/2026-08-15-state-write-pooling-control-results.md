# State-write pooling control: the comparator's resource gate has no noise band

Date: 2026-08-15
Issue: #157
Commits: approved-base `bc705968`, candidate `c9e18904`

## What this run was for

Three consecutive phases reported the API-v1 state-write perf comparison as
"environment-limited": an identical-code control failed the comparator, so no
candidate verdict could be trusted. Issue #157 attributed this to developer-machine
noise and pointed at an order-balanced A-B-B-A pooling protocol as the escalation.
That escalation had never been executed, because nothing in the repository could
produce the environment descriptor each pooling source requires.

The tooling now exists (`docker-compose.perf-bench.yml`,
`scripts/perf/capture-api-v1-state-write-environment.mjs`), so this is the first
actual execution of the protocol.

## Design

A literal main-vs-main control is impossible: `pool-api-v1-state-write-results.mjs`
rejects equal approved-base and candidate commits. The control therefore uses two
distinct commits whose runtime code is provably identical.

`git diff bc705968 c9e18904` is exactly four files — a new compose file, a README
section, the new capture script, and a one-word `export` on the validator. Nothing
under `packages/**` or `apps/**` changed, and the benchmark exercises the AppInbox
write paths in `packages/shared-server`. **The true performance effect is exactly
zero**, so every difference measured below is noise by construction.

Four positions ran in A-B-B-A order — approved-base, candidate, candidate,
approved-base — each against a freshly recreated pinned container with its own
migration, at `--warmup=1 --runs=9 --concurrency=10`. All four captured environment
descriptors are byte-identical (md5 `2ef098449b6bef0910ba2125f9d81752`).

## Result: pooling fixed the timing metrics

The metrics that failed in phase 4 — throughput and latency, compared against ±5%
bands — **passed cleanly**. Phase 4's naive single pairing reported shared
throughput at −8.1%; the pooled comparison reports no throughput or latency finding
at all. For what it was built to do, pooling plus a pinned environment worked.

## Result: what still fails is not noise sensitivity

All eight remaining findings are resource counters, and they fail for a different
reason. `compare-api-v1-state-write-results.mjs` compares latency and throughput
with a `0.05` tolerance, but compares four resource metrics with **strict `>` and no
tolerance at all**:

```js
if (
    candidateMedian > baselineMedian &&
    !hasRecordedReason(candidate, name, `${container}.${metric}`)
) {
    errors.push(`${name} median ${container}.${metric} increased without a recorded reason: ...`);
}
```

Measured drift on byte-identical code, pooled over 18 runs per role:

| workload    | metric                           | drift   |
| ----------- | -------------------------------- | ------- |
| uncontended | `postgres.transactionDurationMs` | +0.122% |
| uncontended | `sql.statements`                 | +0.204% |
| shared      | `sql.rowsRead`                   | +0.147% |
| shared      | `sql.statements`                 | +0.317% |
| shared      | `sql.serializedResultBytes`      | +0.383% |
| shared      | `postgres.transactionDurationMs` | +1.550% |
| hot         | `postgres.transactionDurationMs` | +1.409% |
| hot         | `sql.statements`                 | +2.655% |

These counters are not deterministic. The workloads contend deliberately —
the `hot` workload drove 4,516 conflicts and 11,716 attempts for 6,300 accepted
mutations in one position — and the number of retry attempts depends on timing.
Statement counts, rows read, and transaction duration all follow attempt counts, so
they vary run to run even when the code does not.

A strict-inequality gate on a stochastic counter is unsatisfiable. It is not
measuring a regression; it is measuring which side of a coin flip the median landed
on. Roughly half of all identical-code runs will fail it, on any hardware, however
well pinned.

## Revised diagnosis for #157

The issue's framing — developer-machine noise, remedied by pooling — is half right.
Pooling did stabilize the timing comparison. But the residual failure is a gate
design problem, not an environment problem:

- The four resource metrics need a tolerance band, calibrated from the drift this
  control measured. The observed floor on identical code is up to **+2.7%**.
- The existing escape hatch (`hasRecordedReason`) is built for _intentional_
  regressions with a substantive written justification. It is the wrong instrument
  for measurement noise, and requiring a written reason for a coin flip trains
  reviewers to write meaningless ones.

Until the band exists, "environment-limited" remains the honest verdict for these
four metrics — but it should be recorded as _gate-limited_, and no amount of
environment pinning will change it.

## Known limitation: the `image_id` pin is store-dependent

`postgres@sha256:081f1bc7…` is a **multi-architecture OCI image index**, not a
per-architecture image. `docker manifest inspect` on it returns an index listing
amd64, arm, and other platform manifests, each with its own digest.

This machine runs the **containerd image store** (`docker info` reports
`io.containerd.snapshotter.v1`), and under that store `docker image inspect`
reports the _index_ digest as the image `Id` and resolves `Architecture` to the
host's. That is why the capture satisfies the validator's pin
`image_id == sha256:081f1bc7…` exactly.

Under the classic dockerd image store, `Id` is the per-architecture config digest,
which is a different sha. The `image_id` pin would then not match, and the
descriptor would be rejected even though the same image is running. The pins
`image_ref` and `repo_digest` are the index digest and are stable across stores;
only `image_id` carries this coupling.

The practical consequence is that the pinned environment is reproducible on hosts
using the containerd image store, and its portability elsewhere — notably to CI,
which is typically classic dockerd on amd64 — is **unproven**. I have not tested a
classic-store host, so this is reasoned from the store's documented behavior rather
than measured. It also further supports the inference that the validator's pins were
originally captured on a containerd-store arm64 machine.

If the protocol is ever meant to run in CI, `image_id` is the field to revisit
first.

## Incidental findings

- **Artifact size is close to a hard runtime limit.** A 9-run artifact is
  506,420,464 bytes against Node's 536,870,888-byte maximum string length — 5.67%
  headroom — and `readFile(path, 'utf8')` is how both the pooling script and the
  comparator ingest them. Pooled artifacts are 493 MB (8.11% headroom) because they
  are written compactly rather than pretty-printed. A modest increase in run count
  or per-run detail breaks both scripts with `ERR_STRING_TOO_LONG`. Pooling and
  comparison also need roughly 12 GB of heap (`--max-old-space-size=12288`).
- **The capture script rejected its own first run**, because the dev container was
  still up and `container_overlap_count` was not zero. That is the intended
  behavior and it caught a real protocol violation before it reached a verdict.

## Reproduction

```sh
docker stop ar-eye-hunter-postgres
docker compose -f docker-compose.perf-bench.yml down -v
docker compose -f docker-compose.perf-bench.yml up -d --wait
DATABASE_URL=postgres://app:app@localhost:5433/appdb npm run db:migrate
# preflight capture, 9-run benchmark, postflight capture, per position
# then write-api-v1-state-write-pooled-results.mjs and compare-api-v1-state-write-results.mjs
```

Full procedure in `scripts/perf/README.md`, section "Pinned Benchmark Environment".
