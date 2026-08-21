# Phase 1 Overlay-Precedence Results (measured 2026-08-09)

Status: measured on the Phase 1 tree (overlay provenance admission, bounded
bootstrap star, outbound dial budget — all browser-side).

Phase 1 "after" evidence beside
[the Phase 0 formation-burst baseline](2026-08-08-formation-burst-baseline.md),
for Phase 1 of
[the group formation implementation plan](../2026-08-08-group-formation-implementation-plan.md).
Phase 1 changes no server behavior, so the recipe reruns are a
**non-regression** check (server-side storm quantities should match the
baseline within noise); the Phase 1 effect itself — server-overlay adoption
and bounded outbound dials — lives in browser-side logic that the raw-WS
recipes cannot execute, and is measured here by the in-process tier
simulation and the live three-browser diagnostics capture.

Reading rules are the baseline's: process-local metrics, per-server capture,
T0/T1/T2 windows, liveness-only assertions.

## Run provenance

- Branch `codex/group-formation-phase1-overlay-precedence` (PR #138),
  measured on the tree at commit `16561c46` (plan `2755122b`,
  implementation `7eca6b18`, simulation `16561c46`).
- Machine: macOS 26.6 (Darwin 25.6.0), Apple Silicon (arm64); Node v26.7.0;
  Deno 2.9.4; Postgres via Docker (`ar-eye-hunter-postgres`); queue tables
  (`resource_inbox`, `resource_inbox_results`) truncated before the Postgres
  runs, matching the baseline methodology.
- Commands:
  - `npm run test:api-v1:black-box:memory`
  - `npm run test:api-v1:black-box:postgres`
  - `npm run test:api-v1:black-box:postgres:formation-large`
  - `npx vitest run packages/tests/shared/group-formation-burst-simulation.test.ts`
  - `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/results npm run test:rallar:full-stack:memory:live-rtc-3`
- Raw artifacts are not committed (`scripts/perf/README.md` artifact policy).

## Browser-side tier evidence (the Phase 1 effect)

In-process formation-burst simulation
(`packages/tests/shared/group-formation-burst-simulation.test.ts`) at
N=6/20/50: per client an isolated overlay repository + `WebRtcGroupManager`
(budget 10, bootstrap degree 5) bursts one group, bootstraps, then receives
a server overlay planned against an **older** group revision than the
bootstrap star carries — the S5 condition that pre-Phase-1 admission
dropped.

| Tier               | Server-overlay adoption | Incomparable conflicts | Legacy restamp displacing server | Unique outbound dials per client |
| ------------------ | ----------------------- | ---------------------- | -------------------------------- | -------------------------------- |
| N=6                | 6/6 (100%)              | 0                      | 0/6                              | ≤ 10 (budget)                    |
| N=20               | 20/20 (100%)            | 0                      | 0/20                             | ≤ 10 (budget)                    |
| N=50               | 50/50 (100%)            | 0                      | 0/50                             | ≤ 10 (budget)                    |
| N=50 `legacy-star` | —                       | —                      | —                                | 49 (full mesh, rollback mode)    |

Deterministic rendezvous bootstrap connectivity: union bootstrap graph
connected at every tier across 100 seeded member sets per tier at degree 5
(`packages/tests/shared/rtc-bootstrap-peer-selection.test.ts`).

Live three-browser matrix (`live-rtc-3`, memory backend) with
`RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR` capture — real browsers through
the full stack (spec passed in 33.5 s; direct/multicast/broadcast/NACK
proven with real data over the established RTC edges). Per browser across
both captured scenarios (`rallar.rtc.diagnostics()`):

- `overlayAdoption`: `initialSetCount: 1` and `adoptedCount: 0–2` on every
  browser; `incomparableConflictCount: 0`,
  `bootstrapDroppedOverServerCount: 0`, `dominatedDroppedCount: 0` — the
  governing overlay converged to the server lineage on every browser with
  zero admission conflicts (the baseline's S5 mode was dominated/
  incomparable drops of server overlays).
- `groupManager`: `lastDesiredPeerCount: 2` (N=3),
  `connectAttemptCount: 0–2` (≤ desired), `connectFailureCount: 0`,
  `connectDeferredBudgetCount: 0` — dials bounded well inside the budget.

## Server-side non-regression: tier × backend reruns vs baseline

Legend as in the baseline (mutations / expansions / recomputes T-E-P /
WS sends / deliveries).

### Burst window (T1−T0)

Baseline values in parentheses where they differ.

| Tier × backend    | Server    | Burst wall clock | Mutations | Expansions | Recomputes T/E/P        | WS sends  | Deliveries    |
| ----------------- | --------- | ---------------- | --------- | ---------- | ----------------------- | --------- | ------------- |
| small × memory    | primary   | 2.2 s (4.6 s)    | 12        | 12         | 12 / 12 / 12            | 33 (36)   | 108 (113)     |
| medium × memory   | primary   | 3.9 s (4.8 s)    | 40        | 40         | 40 / 40 / 40            | 117       | 1,210 (1,229) |
| small × postgres  | primary   | 1.9 s            | 12        | 12         | 12 / 12 / 12            | 36        | 164 (165)     |
| small × postgres  | secondary | —                | 0         | 0          | 0 / 0 / 0               | 0         | 0             |
| medium × postgres | primary   | 2.4 s            | 34 (31)   | 31 (23)    | 31 / 33 / 33 (23/26/21) | 120 (117) | 1,659 (1,485) |
| medium × postgres | secondary | —                | 6 (9)     | 6 (17)     | 6 / 5 / 5 (17/29/19)    | 0         | 0             |
| large × postgres  | primary   | 4.2 s (6.6 s)    | 53 (38)   | 44 (41)    | 44 / 68 / 54 (41/44/36) | 299 (306) | 8,947 (8,467) |
| large × postgres  | secondary | —                | 47 (26)   | 56 (22)    | 56 / 61 / 46 (22/42/33) | 0         | 0             |

### Steady-state window (T2−T1, ~60 s ≈ per minute)

| Tier × backend    | Server    | Mutations | Expansions | Recomputes T/E/P        | WS sends | Deliveries |
| ----------------- | --------- | --------- | ---------- | ----------------------- | -------- | ---------- |
| small × memory    | primary   | 12        | 12         | 12 / 12 / 12            | 48       | 288        |
| medium × memory   | primary   | 40        | 40         | 40 / 40 / 40            | 160      | 3,200      |
| small × postgres  | primary   | 12        | 12         | 12 / 12 / 12            | 48       | 288        |
| medium × postgres | primary   | 40        | 40         | 40 / 40 / 40            | 160      | 3,200      |
| large × postgres  | primary   | 100 (57)  | 93 (56)    | 93 / 89 / 79 (56/62/34) | 400      | 20,000     |
| large × postgres  | secondary | 0 (28)    | 3 (23)     | 3 / 23 / 12 (23/62/40)  | 0        | 0          |

### Queue depth (rows in `resource_inbox` at capture instants)

| Tier × backend    | T0    | T1    | T2    |
| ----------------- | ----- | ----- | ----- |
| small × memory    | 138   | 282   | 367   |
| medium × memory   | 401   | 882   | 1,163 |
| small × postgres  | 140   | 284   | 371   |
| medium × postgres | 405   | 885   | 1,168 |
| large × postgres  | 2,109 | 3,309 | 4,012 |

The large-tier absolute queue totals start higher than the baseline's
(2,109 vs 13 at T0) because this run reused the suite session after the
standard profile instead of a fresh truncation; the **window deltas match
the baseline exactly**: T1−T0 = +1,200 and T2−T1 = +703 on both trees.

## Observations

- **Root cause 1 (S5) closed at the admission layer.** The simulation
  reproduces the exact failure geometry — a server overlay carrying an older
  causal tuple than the freshly restamped bootstrap star — and every client
  at every tier adopts it (`serverSupersededBootstrapCount == N`,
  conflicts 0). The reverse direction (`bootstrapDroppedOverServerCount ==
  N` under a forced legacy restamp) proves a bootstrap star can no longer
  displace a server topology.
- **Root cause 4 (S4 dial storm) bounded.** Unique outbound dials per client
  stay within the 10-connection budget at N=50 (bootstrap degree 5 + server
  next hops), against 49 in `legacy-star` mode — the 49-out/10-in asymmetry
  is gone. The bounded star also carries `degreeLimit ≤ 5`, so RTT-reporting
  degree now inherits ~5 instead of N−1.
- **Server side untouched, as designed.** Every tier × backend rerun shows
  the same structural signature as the baseline: recomputes ≈ expansions ≈
  triggered with `publishSkippedUnchanged == 0`, the ~2N-per-minute idle
  heartbeat storm (S7: 20,000 deliveries/min at N=50), and identical
  queue-window deltas (+1,200 burst, +703 steady at the large tier).
  Per-server splits differ run-to-run under the three-server cluster
  (expected; the baseline's reading rules call this out). Those storms are
  Phase 2's targets.
- All 13 memory recipes, 13 postgres standard + 5 cluster recipes, and the
  formation-large recipe passed with zero step failures on the Phase 1 tree.
