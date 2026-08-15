# Phase 4 Stable-Topology-Evolution Results (baseline measured 2026-08-15)

Status: **pre-phase-4 baseline measured; candidate not yet measured.** Baseline on the slice-1
instrumented tree (churn recipe + counting-only attempt-budget diagnostics — zero behavior change
relative to `main` at `f094abb3`).

Phase 4 evidence beside
[the Phase 0 formation-burst baseline](2026-08-08-formation-burst-baseline.md),
[the Phase 1 overlay-precedence results](2026-08-09-phase1-overlay-precedence-results.md),
[the Phase 2 server-damping results](2026-08-11-phase2-server-damping-results.md), and the primary
reference
[the Phase 3 delta-dissemination results](2026-08-13-phase3-delta-dissemination-results.md),
for Phase 4 of
[the group formation implementation plan](../2026-08-08-group-formation-implementation-plan.md).

Reading rules are the Phase 0 baseline's (process-local metrics, primary + secondary capture with
the tertiary share uncaptured, liveness-only assertions) with one extension: the churn recipe
captures four instants — T0 (pre-formation), T1 (formed, pre-churn), T2 (post-churn), T3 (after
the ~60 s steady-state heartbeat window) — so T1−T0 is the formation burst, **T2−T1 is the churn
window** (six sequential join/leave cycles with 1.5 s settle delays, i.e. 12 membership changes),
and T3−T2 is steady state.

## Baseline run provenance

- Branch `codex/group-formation-phase4-stable-topology-evolution`, slice-1 instrumented tree;
  behaviorally identical to `main` at `f094abb3` (a new churn recipe plus counting-only
  attempt-budget diagnostics).
- Machine: macOS 26.6 (Darwin 25.6.0), Apple Silicon (arm64); Node v26.7.0; Postgres via Docker
  (`ar-eye-hunter-postgres`), database recreated from empty volumes and freshly migrated before
  the Postgres runs.
- Commands:
  - `npm run test:api-v1:black-box:memory` → 22/22 recipes passed (pre-instrumentation tree).
  - `npm run test:api-v1:black-box:postgres:formation-large` → burst-large + churn-large
    (baseline capture; see below).
- Raw artifacts are not committed (`scripts/perf/README.md` artifact policy); numbers are the
  `outputs.*` captures from each recipe's `report.json` and the planner measurement described
  below.

## Baseline: planner edge churn per membership change (unit-level, no-RTT paths)

Measured directly against `RallarRtcTopologyService.planGroupTopologyAt` (the same planning kernel
the durable work handler calls), with zero-padded session ids, no RTT measurements, and default
config — one full replan per membership change, exactly what the pre-phase-4 server executes.
"Churn" is the symmetric difference of undirected edge sets between consecutive plans.

| N | Kind | Formed edges | Join churn (edges) | Leave churn (edges) | Same-set reorder churn (edges) |
| --- | --- | --- | --- | --- | --- |
| 6 | tree | 5 | 7 | 1 | 6 |
| 20 | mesh | 37 | 2 | 6 | 54 |
| 50 | mesh | 97 | 2 | 6 | 180 |

Observations:

- **A different arrival order of the identical member set plans a mostly different graph** —
  at N=50 the reorder churn (180) is ~93% of the combined edge slots of the two plans. Every
  fallback weight is positional (`|i-j|+1` over the presence-array index), the no-RTT mesh
  attaches each member to the most recently inserted feasible candidates, and the tree source is
  picked by positional index distance — so planning is a function of arrival order, not of the
  member set. This is the quantified root cause behind both the cross-server determinism risk
  and the "replans do not preserve structure" behavior Phase 4 (M6) targets.
- **Mesh joins are incidentally cheap** (2 edges — the full rebuild replays the same insertion
  prefix and appends the joiner), but this is an accident of append-order stability, not a
  contract: the same rebuild churns 54–180 edges the moment order shifts.
- **The tree tier full-rebuilds on join** (7 of 5+6 edges at N=6): every join in the 5–15 member
  band rewires essentially the whole tree today.
- Leave churn is bounded (1–6 edges) only because removal keeps the surviving members' relative
  order; the browser still pays a teardown+redial per changed edge, and each teardown resets the
  peer's connection-attempt budget on the pre-phase-4 tree (reset-on-removal — the flap-loop
  hazard M11 closes).

## Baseline: churn recipe (formed N=50, six join/leave cycles, three-server Postgres cluster)

`api-v1-group-formation-churn-large` baseline run: **PASSED, 2,070 step successes, zero
failures** (burst-large re-passed beside it with 1,307). Metrics are process-local and
cumulative, and the burst-large recipe ran first in the same processes, so T0 carries its
residue; every quantity below is a window delta. All numbers are the primary server; secondary
egress was 0 in every window (all recipe WS clients connect to the primary), and the tertiary
share is uncaptured (Phase 0 reading rule).

Churn window (T2−T1; 12 membership changes: 6 joins with presence connect, 6 presence
disconnects, 1.5 s settle between operations):

| Quantity | Churn window | Per membership change |
| --- | --- | --- |
| `overlay.topology` egress bytes | 19,432,098 | **≈ 1.62 MB** |
| `overlay.topology` WS sends | 24 | 2.0 |
| Topology replans executed (`topologyUpdateCount`) | 9 | 0.75 |
| Replans changed / published | 9 / 9 | 0.75 |
| Fingerprint-gated skips (`topologyRebuildSkippedFingerprintCount`) | 6 | 0.5 |
| `group-state.event` egress bytes | 6,972,400 | 581 KB |
| `group-state.snapshot` egress bytes (dual-emit oracle) | 71,812,081 | 5.98 MB |
| `group-directory.snapshot` egress bytes (dual-emit oracle) | 71,822,047 | 5.99 MB |
| Presence-summary expansions | 18 | 1.5 |

Steady-state window (T3−T2, ~60 s with two heartbeat rounds across the 50 online clients):
**0 egress bytes, 0 WS sends, 0 expansions, 0 replans, 0 publications** — the only movement is
the heartbeat lease renewals in `groupMutationCount` (+73), so the phase-2 idle property holds
under the churn instrument.

Observations:

- **Every churned membership change publishes a full ~810 KB overlay snapshot to every session**
  (~1.62 MB per change at N≈51–56 across ~2 sends): replan output is a complete
  `nextHopsBySessionId` graph regardless of how small the actual edge delta is. Combined with
  the planner-level table above (full replans that reshuffle on reorder), this is the
  O(N)-per-change cost phase 4 bounds to O(delta).
- The damping machinery behaves correctly under churn: 12 changes coalesce into 9 executed
  replans, every executed replan is genuinely changed and published exactly once, and 6
  redundant recomputes (for example the member-remove after a presence disconnect) are
  fingerprint-skipped.
- Under the `dual-emit` default the two per-change full-snapshot topics still dominate the churn
  window (143.6 MB of 170.1 MB total) — the phase-3 delta-primary evidence applies to churn
  exactly as it did to formation, which is the delta-consumption context for this phase's
  dissemination-default checkpoint decision.
- Browser-side composition (from the churn simulation beside the burst simulation): the
  `WebRtcGroupManager` executes exactly the per-client edge delta of an overlay transition —
  a republished identical edge set churns zero edges, and a disjoint transition tears down and
  redials per changed edge in the same reconcile pass with no grace window and no retention.
  Each teardown resets the peer's connection-attempt budget on this tree (reset-on-removal),
  measured by the new counting-only attempt-budget diagnostics.

## Phase 4 targets (set from this baseline)

- Identical member sets plan byte-identical graphs across servers and insertion orders (reorder
  churn → 0), unit-proven across sizes.
- Edge churn per single join/leave bounded by O(degree) with no full-mesh teardown, on both the
  planner measurement and the churn recipe/simulation.
- No budget-reset flap loops under the churn stream (`resetOnRemovalCount` stays ≈ 0 once M11
  lands; measured by the new counting-only attempt-budget diagnostics).
- No kind-boundary oscillation across the hysteresis band.
- Every phase-2 and phase-3 property preserved: idle steady state ≈ 0 beyond client-plane lease
  writes, burst egress at the phase-3 levels per dissemination mode, liveness assertions, and
  fingerprint-skips still firing.

## Candidate results

### Slice 2 (M6 canonical input + order-independent weights): planner edge churn

Same measurement as the baseline table, on the slice-2 tree (canonical sorted planning input,
hash-derived pair weights at every fallback site including the no-RTT mirrors, order-sensitive
`changed` predicate, code-unit tie-breaks on the planning path):

| N | Kind | Formed edges | Join churn (edges) | Leave churn (edges) | Same-set reorder churn (edges) |
| --- | --- | --- | --- | --- | --- |
| 6 | tree | 5 | 1 (was 7) | 1 (was 1) | **0 (was 6)** |
| 20 | mesh | 37 | 2 (was 2) | 8 (was 6) | **0 (was 54)** |
| 50 | mesh | 97 | 2 (was 2) | 6 (was 6) | **0 (was 180)** |

- **Same-set reorder churn is 0 at every size** — identical member sets now plan byte-identical
  graphs regardless of arrival order (unit-proven across sizes 2–64, no-RTT and RTT-mixed, in
  `rtc-topology-plan-determinism.test.ts`).
- Join/leave churn is already inside O(degree) *empirically* on full rebuilds, because
  pair-stable weights keep unrelated planning decisions identical when one member changes. The
  tree tier's join churn fell 7 → 1. This bound is emergent, not contractual — the
  incremental-seeding + hysteresis slice turns it into a contract (and covers the kind-boundary
  crossings a full rebuild still reshuffles).

### Slice 3 (M6 incremental evolution + kind hysteresis): planner edge churn

Same measurement on the slice-3 tree, now planning with the `membership-delta` intent the
durable group-revision work path passes (incremental evolution of the previous accepted graph
through `updateGroupTree`/`updateGroupMesh`, hysteresis band widths
`RALLAR_RTC_TOPOLOGY_MESH_EXIT_WIDTH=4` / `TREE_EXIT_WIDTH=0`, RTT-refresh and explicit
reconfigure work still full rebuilds — the periodic drift bound):

| N | Kind | Formed edges | Join churn (edges) | Leave churn (edges) | Incremental plans / fallbacks |
| --- | --- | --- | --- | --- | --- |
| 6 | tree | 5 | 1 | 1 | 2 / 0 |
| 20 | mesh | 37 | 2 | 5 | 2 / 0 |
| 50 | mesh | 97 | 2 | 5 | 2 / 0 |

- Structure preservation is now by construction, not coincidence: an unchanged member keeps its
  edges, join adds `meshParamK` (or one tree) edges, leave repairs locally. The contractual
  bound (churn ≤ 2×(degreeLimit+1) per single change) plus incremental-vs-full invariant
  equivalence, seeded determinism, delta-budget fallback, and the hysteresis boundary walk
  (15↔16 flap holds mesh through the 12–15 band, exits at 11) are unit-proven in
  `evolve-planned-topology.test.ts` and `topology-kind-hysteresis.test.ts`.

### Slice 4 (M11 + M9): browser churn resilience

Measured through the churn simulation (50 real `WebRtcGroupManager` stacks over a fake connection
service, seeded ring overlays):

- **Overlay transition, within the grace window**: each client dials its 2 incoming delta edges
  and tears down **0** — the 2 outgoing edges the previous epoch wanted become retained
  connections (`reason: 'overlay-transition'`, grace default
  `DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS = 15 s`).
- **Flap (epoch A → B → A)**: the round trip costs exactly the 2 forward dials and **0
  teardowns** — the reverted epoch's edges are still connected, so flapping converges instead of
  looping. A republished identical edge set stays at 0/0.
- **Expiry**: past the grace window the retained edges tear down (`retainedExpiredCount`), and
  every churn-path teardown — overlay expiry, retained eviction, connection close, failed lane
  open — now preserves the peer's connection-attempt budget (`resetAttemptBudget: false`);
  budgets reset only on genuine establishment or explicit user reconnect intent. Failures still
  consume budget.
- **M9**: the reconcile single-flight is a true coalescer — a trigger arriving while a run is in
  flight is flagged and re-run against the newest state instead of silently dropped
  (`reconcileCoalescedRerunCount` / the awaited-caller re-run path), proven by the concurrent
  reconcile test that previously documented the lost update.

## Dissemination-default checkpoint decision

_(pending: the churn stream is the delta-consumption proof phase 3 recorded as the
`RALLAR_GROUP_STATE_DISSEMINATION` default-flip precondition; the decision is recorded here
either way once the candidate churn evidence exists.)_
