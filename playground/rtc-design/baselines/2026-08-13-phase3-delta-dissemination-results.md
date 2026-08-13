# Phase 3 Delta-Dissemination Results (baseline measured 2026-08-13)

Status: **baseline captured** on the slice-1 instrumented tree (egress-byte
counters only — zero behavior change relative to `main` at `124e0992`).
Candidate sections follow when the M2/M12/M13 mechanisms land.

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

| Tier × backend | Total egress | group-state.snapshot | group-directory.snapshot | group-state.event | overlay.topology | client-state.* | Snapshot share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| small × memory (N=6) | 551,678 | 230,374 | 230,605 | 22,317 | 34,680 | 33,702 | 83.6% |
| medium × memory (N=20) | 12,751,445 | 6,030,229 | 6,032,539 | 286,155 | 290,120 | 112,402 | 94.6% |
| small × postgres (N=6) | 679,507 | 287,570 | 287,867 | 35,688 | 34,680 | 33,702 | 84.7% |
| medium × postgres (N=20) | 19,449,936 | 9,064,169 | 9,497,911 | 485,334 | 290,120 | 112,402 | 95.4% |
| **large × postgres (N=50)** | **254,951,157** | **121,645,845** | **123,346,245** | **2,615,001** | 7,242,932 | 101,134 | **96.1%** |

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

| Tier × backend | Server | Mutations | Expansions | WS sends | Deliveries |
| --- | --- | --- | --- | --- | --- |
| small × memory | primary | 12 | 12 | 31 | 81 |
| medium × memory | primary | 40 | 40 | 102 | 691 |
| small × postgres | primary | 12 | 12 | 32 | 102 |
| medium × postgres | primary | 40 | 40 | 102 | 1,082 |
| large × postgres | primary | 34 | 35 | 211 | 6,110 |
| large × postgres | secondary | 35 | 46 | 0 | 0 |

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

## Candidate results

_Pending: M12 read-through recipes (late-joiner, reconnect-resync), M2
dual-emit and delta-primary tier reruns, M13 admission-enabled burst tail,
medium-scale convergence gate, and the state-write perf comparison gate
(issue #157 baseline-control protocol)._
