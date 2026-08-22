# Phase 3 Delta-Dissemination Results (baseline + candidate measured 2026-08-13/14)

Status: **baseline and candidate measured.** Baseline on the slice-1
instrumented tree (egress-byte counters only — zero behavior change relative
to `main` at `124e0992`); candidate on the full phase-3 tree (M12 read-through,
M2 dissemination modes with the browser delta path, M13 admission).

Phase 3 evidence beside
[the Phase 0 formation-burst baseline](2026-08-08-formation-burst-baseline.md),
[the Phase 1 overlay-precedence results](2026-08-09-phase1-overlay-precedence-results.md),
and the primary reference
[the Phase 2 server-damping results](2026-08-11-phase2-server-damping-results.md),
for Phase 3 of
[the group formation implementation plan](../2026-08-08-group-formation-implementation-plan.md).
The written implementation plan is
[`plans/rallar-group-formation-phase3-delta-dissemination-plan.md`](../../../plans/rallar-group-formation-phase3-delta-dissemination-plan.md).

Reading rules are the Phase 0 baseline's: process-local metrics, per-server
capture (primary + secondary; the tertiary share of the three-server Postgres
cluster is uncaptured), T0/T1/T2 windows (T1−T0 = burst, T2−T1 = ~60 s steady
state), liveness-only assertions. One addition: **`wsEgressBytesByTopicId`**
counts serialized WS message length (UTF-16 code units of the encoded JSON —
exact bytes for ASCII payloads) times successful sends, accumulated per topic
at the live-send and outbox-send delivery sites. "Egress bytes" below sums
that map; per-topic splits are shown where they carry the story.

## Baseline run provenance

- Branch `codex/group-formation-phase3-delta-dissemination`, instrumented
  tree at commit `2342f726` (plan `54cec5f0`); behaviorally identical to
  `main` at `124e0992` (counters only).
- Machine: macOS 26.6 (Darwin 25.6.0), Apple Silicon (arm64); Node v26.7.0;
  Deno 2.9.5; Postgres via Docker (`ar-eye-hunter-postgres`), database
  recreated from empty volumes and freshly migrated before the Postgres
  runs; queue tables (`resource_inbox`, `resource_inbox_results`) truncated
  before the formation-large capture (Phase 0/2 methodology).
- Commands:
  - `npm run test:api-v1:black-box:memory` → 19/19 recipes passed.
  - `npm run test:api-v1:black-box:postgres` → 19/19 standard plus 5/5
    cluster passed.
  - `npm run test:api-v1:black-box:postgres:formation-large` → 1/1 passed
    (1,323 step successes, zero failures).
- Raw artifacts are not committed (`scripts/perf/README.md` artifact
  policy); numbers are the `outputs.*` captures from each recipe's
  `report.json`.

## Baseline: burst egress bytes (T1−T0, primary server)

| Tier × backend              | Total egress    | group-state.snapshot | group-directory.snapshot | group-state.event | overlay.topology | client-state.* | Snapshot share |
| --------------------------- | --------------- | -------------------- | ------------------------ | ----------------- | ---------------- | -------------- | -------------- |
| small × memory (N=6)        | 551,678         | 230,374              | 230,605                  | 22,317            | 34,680           | 33,702         | 83.6%          |
| medium × memory (N=20)      | 12,751,445      | 6,030,229            | 6,032,539                | 286,155           | 290,120          | 112,402        | 94.6%          |
| small × postgres (N=6)      | 679,507         | 287,570              | 287,867                  | 35,688            | 34,680           | 33,702         | 84.7%          |
| medium × postgres (N=20)    | 19,449,936      | 9,064,169            | 9,497,911                | 485,334           | 290,120          | 112,402        | 95.4%          |
| **large × postgres (N=50)** | **254,951,157** | **121,645,845**      | **123,346,245**          | **2,615,001**     | 7,242,932        | 101,134        | **96.1%**      |

Secondary-server egress is 0 in every capture (all recipe WS clients connect
to the primary; the secondary's rows resolve no local recipients). Memory
"secondary" equals the primary process (Phase 0 reading rule).

Observations:

- **The two per-change full-snapshot topics dominate burst egress and their
  share grows with N**: 83.6% at N=6 → 96.1% at N=50. Growth is
  super-quadratic (0.55 MB → 12.75 MB → 255 MB for N=6/20/50 memory→large)
  because snapshot size, recipient count, and mutation count all scale
  with N — the measured O(N³)-flavored curve Phase 3 targets.
- **`group-directory.snapshot` costs as much as `group-state.snapshot`**
  (identical full `GroupSnapshot` payload). A delta-primary mode that
  drops only `group-state.snapshot` caps the total reduction at ~2×;
  hitting the order-of-magnitude target requires the delta path to replace
  **both** per-change snapshot rows. This settles the plan's D1
  directory-row question with measured shares.
- **`group-state.event` is ~1% of burst egress at N=50** (2.6 MB vs
  245.0 MB of snapshots) — the existing event row is cheap; the delta
  envelope adds payload but stays O(1)-sized per change.
- **Steady state is 0 egress bytes at every tier** — the Phase 2 idle
  property (only client-plane lease writes remain) is preserved by the
  instrumented tree, re-verified with the new counter.

## Baseline: burst counts (cross-check against Phase 2)

| Tier × backend    | Server    | Mutations | Expansions | WS sends | Deliveries |
| ----------------- | --------- | --------- | ---------- | -------- | ---------- |
| small × memory    | primary   | 12        | 12         | 31       | 81         |
| medium × memory   | primary   | 40        | 40         | 102      | 691        |
| small × postgres  | primary   | 12        | 12         | 32       | 102        |
| medium × postgres | primary   | 40        | 40         | 102      | 1,082      |
| large × postgres  | primary   | 34        | 35         | 211      | 6,110      |
| large × postgres  | secondary | 35        | 46         | 0        | 0          |

Counts are the same order as the Phase 2 results (e.g. large-tier primary
deliveries 6,110 here vs 4,934 in the Phase 2 capture — run-to-run split
between primary/secondary/tertiary varies; the uncaptured tertiary share
differs per run). Joins issued/succeeded 6/6, 20/20, 50/50; every client
observed full membership and at least one `overlay.topology` publication
(hard assertions unchanged). Steady-state windows show 0 expansions, 0
sends, 0 deliveries at every tier (the large-tier steady "mutations=100"
is exactly the two heartbeat rounds × 50 clients, whose pure lease renewals
produce no downstream work — S7 stays closed).

## Phase 3 target (set from this baseline)

Per the plan's acceptance criteria: with deltas primary, large-tier
(N=50) burst egress bytes on the primary must drop by roughly an order of
magnitude — **target ≤ 25.5 MB against the measured 254.95 MB**, with the
idle steady-state, liveness, and publish-skip properties intact.

## Candidate results (measured 2026-08-14)

Candidate tree: the full phase-3 branch (slices M12 read-through, M2 server
dual-emit/delta-primary with the delta envelope and persisted audience, M2
browser delta consumption, M13 admission), measured with the same machine,
methodology, freshly recreated database, and queue-table truncation before
each large-tier capture. Admission was enabled at its defaults in every run
(it is default-on). `dual-emit` is the branch default; `delta-primary` runs
set `RALLAR_GROUP_STATE_DISSEMINATION=delta-primary` on the managed servers.

### Burst egress bytes (T1−T0, primary server): baseline → dual-emit → delta-primary

| Tier × backend              | Baseline        | Dual-emit   | Delta-primary  | Reduction (baseline → delta-primary) |
| --------------------------- | --------------- | ----------- | -------------- | ------------------------------------ |
| small × memory (N=6)        | 551,678         | 589,431     | 122,835        | **4.5×**                             |
| medium × memory (N=20)      | 12,751,445      | 13,374,455  | 1,334,784      | **9.6×**                             |
| small × postgres (N=6)      | 679,507         | —           | 181,790        | **3.7×**                             |
| medium × postgres (N=20)    | 19,449,936      | —           | 1,833,900      | **10.6×**                            |
| **large × postgres (N=50)** | **254,951,157** | 259,502,056 | **13,215,859** | **19.3×**                            |

- **The N=50 target is met with 2× headroom: 13.2 MB against the ≤25.5 MB
  target from the measured 255.0 MB baseline.** Both per-change full-snapshot
  topics are absent from the delta-primary byte map; the remaining burst
  egress is `group-state.event` envelopes (8.2 MB — O(1)-sized deltas whose
  identity set scales with N, keeping the total O(N²)) and `overlay.topology`
  publications (4.9 MB — untouched by this phase and now the largest
  remaining fanout).
- Dual-emit costs +1.8% at N=50 over baseline (the envelope beside the
  retained snapshot rows) — the price of running the divergence oracle.
- Every delta-primary tier run passed its full liveness assertions
  (N=6: 163, N=20: 471/479, N=50: 1,307 step successes, zero failures;
  every client observed full membership and at least one `overlay.topology`
  publication).

### Phase-2 properties re-verified on the candidate

- **Idle steady state**: 0 expansions, 0 WS sends, 0 deliveries, and 0
  egress bytes in every steady-state window at every tier and mode; the
  steady-state mutations remain exactly the heartbeat lease renewals.
- **Damping counters** (large tier, T2−T0): recomputes executed/published
  collapse to 2–4 per server in both modes,
  `topologyRebuildSkippedFingerprintCount` fires during formation (1 on the
  primary in both modes), and `topologyPublishSkippedUnchangedCount` stays 0
  in the burst windows because every executed plan there is genuinely
  changed — exactly the Phase 2 results' documented shape.
- **Cross-server suites**: postgres standard profile (22 recipes including
  the phase-3 late-joiner, reconnect-resync, and admission recipes) plus the
  5-recipe cluster profile passed on the candidate under the dual-emit
  default.

### M12 and M13 recipe evidence

- `api-v1-group-topology-late-joiner` (22 steps): after formation, a member
  joining without a presence transition reads the current server overlay
  from `GET .../topology` immediately — the served version equals the
  pre-join publication capture; no new publication is awaited or required.
- `api-v1-group-state-reconnect-resync` (32 steps): a client drops WS,
  misses a fingerprint-relevant update and its publication, reconnects on a
  fresh socket, receives the unicast topology hydration push, and converges
  through the revision-floored snapshot read and the topology read-through.
- `api-v1-group-join-admission` (79 steps): a 70-attempt storm probe on one
  group drives real `429` answers carrying `Retry-After: 60` while a second
  principal's control join stays admitted; the N=50 burst passes with
  admission enabled at defaults and zero unavailable false failures (the
  join retry budgets stay unused, as in every tier run).

### Convergence and perf gates (measured 2026-08-14)

- **Medium-scale convergence gate: PASSED** —
  `npm run test:api-v1:black-box:postgres:medium-scale` 1/1 with 2,748 step
  successes and zero failures (the identical count to the Phase 2 run),
  under the dual-emit default with admission enabled at defaults; recipe
  constants, operation matrix, and assertions untouched.
- **State-write perf comparison (issue #157 baseline-control protocol)**:
  three runs on freshly recreated databases (`--backend=postgres --warmup=1
  --runs=3 --concurrency=10`): baseline A and control baseline B on `main`
  at `160e8f88`, candidate on the phase-3 tree. The **control pairing
  (identical `main` code) FAILS the comparator outright** — uncontended p95
  +9.8%, p99 +12.9%, shared throughput −23.7%, hot throughput −8.8%, plus
  seven median drifts — re-confirming that this machine's run-to-run
  variance sits far above the 5% gates (the Phase 2 finding issue #157
  tracks). Against that floor, the **candidate passes every latency and
  throughput gate in both pairings** (A→candidate and B→candidate). The
  only flags are sub-noise reasoned medians: uncontended `sql.statements`
  +6 of 23,786, `serializedResultBytes` +27 of 30.16 M, transaction time
  +2.4% (A-pairing); hot `sql.rowsRead` +0.3% and `serializedResultBytes`
  +0.6% (B-pairing) — consistent with the dual-emit envelope's slightly
  larger event payloads and no added statements on the mutation path.
  **Verdict: environment-limited comparator, with the sign-stable signal
  (candidate latency/throughput inside both baseline pairings while the
  identical-code control fails) indicating no mutation-path regression.**
  Gate artifacts stay uncommitted under `tmp/perf/` per the artifact
  policy.
- **Discovered and repaired in passing**: the bench harness itself had
  rotted on `main` — `scripts/perf/api-v1-state-write-concurrency-bench.ts`
  still imported `CircuitBreakerPolicy` from `Resilience.ts` after PR #164
  moved it to `circuit-breaker.ts`, so the gate could not run at all on
  either tree. The one-line import repair is part of this branch and was
  applied identically to the baseline worktree so both sides ran the same
  instrument.

### Completion gates

_Recorded on the final tree: `test:unit`, `test:ci`, `build`, Branch
Release Gate on the final feature-branch commit, and the Hetzner Supported
Distributed Manifests workflow on the resulting default-branch commit.
Known external blocker at measurement time: the `main` evidence-ledger
adaptive plan keeps the one-active-plan structure rule failing (one
navigation-evidence test and the CI governance gate) until it closes on
main._
