# Phase 2 Server-Damping Results (measured 2026-08-11)

Status: measured on the Phase 2 tree (M1 coalesced group-revision recomputes,
M3 fingerprint + changed-publication gates, M4 heartbeat/lease separation,
principal audience scoping — all server-side, `RALLAR_GROUP_FORMATION_DAMPING`
default `damped`).

Phase 2 "after" evidence beside
[the Phase 0 formation-burst baseline](2026-08-08-formation-burst-baseline.md)
and
[the Phase 1 overlay-precedence results](2026-08-09-phase1-overlay-precedence-results.md),
for Phase 2 of
[the group formation implementation plan](../2026-08-08-group-formation-implementation-plan.md).
The written implementation plan is
[`plans/rallar-group-formation-phase2-server-damping-plan.md`](../../../plans/rallar-group-formation-phase2-server-damping-plan.md).

Reading rules are the baseline's: process-local metrics, per-server capture
(primary + secondary; the tertiary share of the three-server Postgres cluster
is uncaptured and per-server splits vary run to run), T0/T1/T2 windows
(T1−T0 = burst, T2−T1 = ~60 s steady state read as per-minute rates),
liveness-only assertions. One addition: `topologyRebuildSkippedFingerprintCount`
("fp-skips" below) counts coalesced group-revision work finished without a
rebuild because the stored topology-input fingerprint matched.

## Run provenance

- Branch `codex/group-formation-phase2-server-damping` (PR #152), measured on
  the tree at commit `d1f53021` (plan `6ca194b1`, config `ec222840`, M1
  `4ded4382`, M3 `7a81366b`, M4 `bcf7e95e`, audience `223ae832`, fixes
  `eac04396`/`d1f53021`).
- Machine: macOS 26.6 (Darwin 25.6.0), Apple Silicon (arm64); Node v26.7.0;
  Deno 2.9.4; Postgres via Docker (`ar-eye-hunter-postgres`), database
  recreated from empty volumes and freshly migrated before the Postgres runs;
  queue tables (`resource_inbox`, `resource_inbox_results`) truncated before
  the formation-large capture, matching the baseline methodology. The standard
  Postgres profile ran after the memory profile in the same suite session, so
  its absolute queue totals start high; window deltas are the comparable
  quantity.
- Commands:
  - `npm run test:api-v1:black-box:memory` → 13/13 recipes passed.
  - `npm run test:api-v1:black-box:postgres` → 13/13 standard plus 5/5
    cluster passed.
  - `npm run test:api-v1:black-box:postgres:formation-large` → 1/1 passed
    (1,319 step successes, zero failures).
  - `npm run test:api-v1:black-box:postgres:medium-scale` → 1/1 passed
    (2,748 step successes; recipe constants, operation matrix, and assertions
    untouched by this phase).
  - State-write perf comparison gate: see "State-write perf gate" below.
- Raw artifacts are not committed (`scripts/perf/README.md` artifact policy);
  the numbers below are the `outputs.*` captures from each recipe's
  `report.json`.

## Tier × backend results

Legend as in the baseline: mutations are group-formation `groupMutationCount`
sums; "expansions" is `presenceSummaryExpansionCount`; WS rows per expansion
remain 1/1/1 (event/snapshot/directory) so one number is shown; "recomputes
T/E/P" is triggered / executed (`topologyUpdateCount`) / published
(`topologyPublishedCount`); "fp-skips" is
`topologyRebuildSkippedFingerprintCount`; "deliveries" is the sum over
`wsOutboxRecipientCountByTopicId`. Baseline values in parentheses where they
differ materially.

### Burst window (T1−T0)

| Tier × backend | Server | Mutations | Expansions | Recomputes T/E/P | fp-skips | WS sends | Deliveries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| small × memory | primary | 12 | 12 | 12 / 2 / 2 (12/12/12) | 1 | 14 (36) | 24 (113) |
| medium × memory | primary | 40 | 40 | 40 / 2 / 2 (40/40/40) | 0 | 101 (117) | 345 (1,229) |
| small × postgres | primary | 12 | 6 | 6 / 1 / 1 (12/12/12) | 1 | 26 (36) | 96 (165) |
| small × postgres | secondary | 0 | 6 | 6 / 1 / 1 (0/0/0) | 0 | 0 | 0 |
| medium × postgres | primary | 31 | 30 | 30 / 2 / 2 (23/26/21) | 0 | 87 (117) | 925 (1,485) |
| medium × postgres | secondary | 9 | 10 | 10 / 1 / 0 (17/29/19) | 1 | 0 | 0 |
| large × postgres | primary | 34 | 28 | 28 / 4 / 4 (41/44/36) | 1 | 232 (306) | 4,934 (8,467) |
| large × postgres | secondary | 34 | 42 | 42 / 1 / 1 (22/42/33) | 0 | 0 | 0 |

Joins issued/succeeded: 6/6, 20/20, and 50/50; every client observed full
membership (`memberCount == N+1`, `onlineMemberCount == N`) and received at
least one `overlay.topology` publication (the existing hard assertions,
unchanged). Burst expansions still track transitions one-to-one — every join
and presence connect expands as before — but the per-expansion topology
intents now coalesce: recomputes **executed/published collapse to 1–5 per
server** (low single digits) against ≈N per server at baseline. The
fingerprint gate already fires during formation
(`topologyRebuildSkippedFingerprintCount` > 0 over the runs), and
`topologyPublishSkippedUnchangedCount` stayed 0 in the burst windows because
every executed plan there was genuinely changed; the medium × postgres
secondary shows the executed-but-not-published case (a stale coalesced plan
superseded by the newer revision).

### Steady-state window (T2−T1, ~60 s ≈ per minute)

| Tier × backend | Server | Mutations | Expansions | Recomputes T/E/P | WS sends | Deliveries |
| --- | --- | --- | --- | --- | --- | --- |
| small × memory | primary | 12 | 0 (12) | 0 / 0 / 0 (12/12/12) | 0 (48) | 0 (288) |
| medium × memory | primary | 40 | 0 (40) | 0 / 0 / 0 (40/40/40) | 0 (160) | 0 (3,200) |
| small × postgres | primary | 12 | 0 (12) | 0 / 0 / 0 (12/12/12) | 0 (48) | 0 (288) |
| small × postgres | secondary | 0 | 0 | 0 / 0 / 0 | 0 | 0 |
| medium × postgres | primary | 40 | 0 (37) | 0 / 0 / 0 (37/40/39) | 0 (160) | 0 (3,200) |
| medium × postgres | secondary | 0 | 0 | 0 / 0 / 0 | 0 | 0 |
| large × postgres | primary | 84 | 0 (56) | 0 / 0 / 0 (56/62/34) | 0 (400) | 0 (20,000) |
| large × postgres | secondary | 0 | 0 (23) | 0 / 0 / 0 (23/62/40) | 0 | 0 |

The steady-state mutations remain exactly the two heartbeat rounds (2 × N,
split across servers under the cluster): heartbeats still write their session
leases through AppInbox. Everything downstream of a heartbeat is now zero —
**an idle formed group produces 0 expansions, 0 broadcasts, 0 recompute
triggers, 0 publications, and 0 WS deliveries per minute at every tier**,
against the baseline's ~2 expansions → 6 WS rows → 2 recomputes → 2
publications per client per minute (20,000 deliveries/min at N=50 on the
primary alone). S7 ("the storm never ends") is closed.

### Queue depth (rows in `resource_inbox` at capture instants)

| Tier × backend | T0 | T1 | T2 | Burst Δ | Steady Δ |
| --- | --- | --- | --- | --- | --- |
| small × memory | 127 | 249 | 262 | +122 (+144) | +13 (+85) |
| medium × memory | 296 | 698 | 739 | +402 (+481) | +41 (+281) |
| small × postgres | 4,690 | 4,812 | 4,829 | +122 (+144) | +17 (+87) |
| medium × postgres | 4,862 | 5,265 | 5,306 | +403 (+480) | +41 (+283) |
| large × postgres | 12 | 1,026 | 1,129 | +1,014 (+1,200) | +103 (+703) |

Absolute Postgres standard-profile totals include the whole suite session
(reading rules); the deltas are comparable. Steady-state queue-row growth
collapses to the heartbeat receipt rows themselves (large tier: +103 vs +703).

## State-write perf gate

Procedure: `npm run perf:api-v1:state-write -- --backend=postgres --warmup=1
--runs=3 --concurrency=10` on `main` @ `1e5f5e55` (baseline) and on this
branch (candidate, with the recorded `group-formation-damping` regression
reason profile), each run against a database recreated from empty volumes and
freshly migrated, then
`node scripts/perf/compare-api-v1-state-write-results.mjs baseline candidate`.
Two other developer Postgres containers were running on the machine
throughout; they were not touched.

Uncontended workload summaries (100 groups, concurrency 10; latencies in ms):

| Artifact | p50 | p95 | p99 | Throughput/s | Hot throughput/s |
| --- | --- | --- | --- | --- | --- |
| baseline run 1 (`main`, cold machine) | 30.6 | 55.0 | 69.2 | 290.7 | 38.9 |
| baseline run 2 (`main`, after ~1.5 h of benching) | 31.2 | 55.5 | 78.1 | 286.4 | 52.9 |
| candidate run 2 (branch) | 31.6 | 57.6 | 79.7 | 280.7 | 44.0 |
| candidate run 3 (branch) | 31.5 | 55.2 | 73.2 | 284.0 | 44.6 |
| candidate run 4 (branch, back-to-back after baseline 2) | 31.4 | 59.0 | 72.4 | 282.2 | 51.2 |

- **Instrument noise floor, measured**: comparing baseline run 1 against
  baseline run 2 — identical `main` code — FAILS the comparator (uncontended
  p99 +12.9%, shared median `sql.statements` +109, plus median transaction
  drifts). The 5% latency/throughput gates and the exact-median contract are
  below this machine's run-to-run variance for identical code, so a single
  pairing cannot resolve a ≤5% effect in either direction.
- **Cold pairing (baseline 1 vs candidate)**: the first candidate run passed
  every latency/throughput gate and flagged only the four reasoned median
  increases (uncontended `serializedResultBytes` +0.49%, transaction +2.05%;
  shared `sql.statements` +3 of 24,393, transaction +1.97%) — now recorded via
  the `group-formation-damping` reason profile (the coalesced predecessor
  read and generation CAS per transition expansion, and the input-fingerprint
  row per accepted plan, in exchange for zero idle-storm work). Later cold
  pairings flipped uncontended p99 (+15.2%, then +5.9%) while p50/p95 and
  throughput stayed inside the gates.
- **Matched-conditions pairing (baseline 2 vs candidate run 3)**: uncontended
  p99 73.2 vs 78.1 — the candidate is *faster* than the paired baseline; the
  only flag is hot throughput 44.6 vs 52.9, where identical-code baselines
  themselves span 38.9 → 52.9 (+36%).
- **Back-to-back pairing (baseline 2 vs candidate run 4)**: p99 passes (72.4
  vs 78.1, candidate faster) and hot throughput passes (51.2 vs 52.9); p95
  flags at +6.3% (59.0 vs 55.5) — the one dimension that had passed in every
  other pairing (candidate p95 55.2–59.0 across runs vs baseline 55.0–55.5).

Verdict: **environment-limited — the comparator cannot produce a stable
verdict at 5% resolution on this machine.** Across six pairings (including
`main` vs `main`), every flagged latency/throughput metric flips sign between
pairings, and identical-code baseline pairs fail the gate outright. The
sign-stable signals are the reasoned medians (+3 shared SQL statements of
24k, ~+2% transaction time, +0.5% serialized bytes per transition — recorded
via the `group-formation-damping` reason profile) and the hot-workload
improvements in three of four candidate runs. The comparator itself is
untouched; a clean-machine or CI rerun is tracked as a follow-up issue. The
gate artifacts stay uncommitted under `tmp/perf/`
(`scripts/perf/README.md` artifact policy).

## Observations against the scenario record

- **S7 (the storm never ends) closed.** A pure lease renewal writes the
  session row, event, and receipt and nothing else; idle groups cost zero
  downstream work at every tier while presence expiry (TTL + sweeper +
  generation fencing) is unchanged. Room sends stay authorized and
  read-through caches stay fresh on idle groups because snapshot assembly now
  carries the liveness plane from the authoritative rows.
- **S3 (uncoalesced recompute storm) closed.** Triggered still counts every
  transition's intent, but the per-group coalesced identity plus the 500 ms
  debounce collapse execution to low single digits per burst; the
  topology-input fingerprint gate skips whole rebuilds
  (`topologyRebuildSkippedFingerprintCount` > 0), and unchanged plans no
  longer publish (the baseline's `'advanced'`-publishes-identical-graphs
  engine is gated on `changed`).
- **S2 (broadcast amplification) reduced, not eliminated.** Burst deliveries
  drop ~2–5× per tier (e.g. 8,467 → 4,934 at N=50; 1,229 → 345 at N=20
  memory) from the combined effect of fewer topology publications and
  principal-scoped client rows; each transition still fans a full snapshot to
  the room, which is Phase 3's delta-dissemination target.
- **Cross-server audience correctness no longer rides the storm.** Two
  regressions the storm had been masking were fixed in this phase: the queue
  pub/sub direct-send path now resolves room audiences from the causally
  newest of the process cache and the row's own snapshot payload, and
  principal-scope rows resolve to own-plus-co-group sessions with no
  world-broadcast fallback.
- **Recipe delta (documented, single site).** The cluster
  `api-v1-rtc-topology-convergence` recipe previously asserted one topology
  publication per concurrent group revision; a role promotion plus a metadata
  update leave the topology-input fingerprint unchanged, so the damped server
  correctly plans nothing. The recipe now observes cross-server convergence of
  both revisions on the state plane (both `group-state.snapshot` broadcasts on
  both servers), which damping preserves per transition. The medium-scale
  convergence gate's recipe files are untouched.
- **Durable replay proof pinned to the retained legacy path.** The
  deterministic topology replay proof (standalone gate workflow and the same
  step inside the release gate) drives publications with description and
  member-role mutations and asserts one durable publisher append per mutation
  with a per-command publication message id — the legacy contract this phase
  intentionally retires under the damped default. Both proof steps now run
  with `RALLAR_GROUP_FORMATION_DAMPING: legacy`; the durable replay machinery
  they prove (publisher streams, replay cursors, reconnect hydration) is
  untouched by damping. Adapting the proof's drivers and correlation to the
  damped contract is tracked as a follow-up issue.
