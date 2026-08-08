# Formation-Burst Baseline (Phase 0, measured 2026-08-08/09)

Status: measured on the Phase 0 instrumented tree (zero behavior change).

Baseline numbers for the group-formation storm quantities recorded by the
`group-formation` admin metrics family and the formation-burst black-box
recipes at the small (6), medium (20), and large (50) tiers. These are the
"before" numbers for Phases 1+ of
[the group formation implementation plan](../2026-08-08-group-formation-implementation-plan.md);
scenario references (S1–S7) point at
[the storm scenario record](../2026-08-08-group-formation-storm-scenarios.md).

Reading rules:

- Metrics are process-local (the `'process-local-realtime'` warning). Numbers
  are per server process. The recipes capture the primary and the secondary
  server; under the three-server Postgres cluster the queue workers on all
  three servers compete for the same work, so per-server counters
  under-represent cluster totals and the tertiary share is not captured.
- Under the memory backend there is one server; the "secondary" capture
  follows `RALLAR_API_BASE_URL_SECONDARY`, which falls back to the primary,
  so memory-tier primary and secondary numbers are the same process.
- T0 is captured before the burst, T1 after the convergence poll, T2 after
  the ~60 s steady-state window (two heartbeat rounds separated by 20 s
  delays). Burst deltas are T1−T0; steady-state deltas are T2−T1 and, with
  the ~60 s window, read as per-minute rates.
- Counters accumulate across the whole server process lifetime, so absolute
  values include earlier recipes in the same suite run; the deltas isolate
  the formation group's windows (plus any concurrent background work).
- The recipes assert liveness only: every join/presence call returns success,
  every client observes full membership (`memberCount == N+1`,
  `onlineMemberCount == N`), and every client receives at least one
  `overlay.topology` publication for the group. Storm quantities are
  recorded, never judged.

## Run provenance

- Branch `codex/group-formation-phase0-storm-metrics`, tree at commit
  `752e3ddc` ("fix: make formation-burst recipes and artifacts storm-safe";
  instrumentation commits `31824133`, `063fb7f1`, `3a757fce`, `1d6b60e2`).
- Machine: macOS 26.6 (Darwin 25.6.0), Apple Silicon (arm64); Node v26.7.0;
  Deno 2.9.4; Postgres via Docker (`ar-eye-hunter-postgres`, user-local
  container, `postgres://app@localhost:5432/appdb`); queue tables truncated
  before the Postgres runs so leftover rows from unrelated local work could
  not starve the serialized queue lanes.
- Commands:
  - `npm run test:api-v1:black-box:memory` → 13/13 recipes passed
    (artifacts under `.artifacts/api-v1-black-box/memory/`).
  - `npm run test:api-v1:black-box:postgres` → 13/13 standard profile plus
    5/5 cluster profile passed
    (artifacts under `.artifacts/api-v1-black-box/postgres/`).
  - `npm run test:api-v1:black-box:postgres:formation-large` → 1/1 passed
    (artifacts under `tmp/api-v1-black-box/postgres-formation-large/`).
- Raw artifacts are not committed (`scripts/perf/README.md` artifact policy);
  the numbers below are the `outputs.*` captures from each recipe's
  `report.json`.

## Tier × backend results

Legend: mutations are group-formation `groupMutationCount` sums over all
operation kinds and outcomes; "expansions" is `presenceSummaryExpansionCount`;
"WS rows" is `presenceSummaryWsRowCount` (event/snapshot/directory rows per
expansion are always 1/1/1 by construction, so one number is shown);
"recomputes T/E/P" is triggered (`topologyRecomputeTriggeredCount`) /
executed (`topologyUpdateCount`) / published (`topologyPublishedCount`);
"deliveries" is the sum over `wsOutboxRecipientCountByTopicId`.

### Burst window (T1−T0)

| Tier × backend | Server | Burst wall clock | Mutations | Expansions (=WS rows ×3) | Recomputes T/E/P | WS sends | Deliveries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| small × memory | primary | 4.6 s | 12 | 12 | 12 / 12 / 12 | 36 | 113 |
| medium × memory | primary | 4.8 s | 40 | 40 | 40 / 40 / 40 | 117 | 1,229 |
| small × postgres | primary | 1.9 s | 12 | 12 | 12 / 12 / 12 | 36 | 165 |
| small × postgres | secondary | — | 0 | 0 | 0 / 0 / 0 | 0 | 0 |
| medium × postgres | primary | 2.4 s | 31 | 23 | 23 / 26 / 21 | 117 | 1,485 |
| medium × postgres | secondary | — | 9 | 17 | 17 / 29 / 19 | 0 | 0 |
| large × postgres | primary | 6.6 s | 38 | 41 | 41 / 44 / 36 | 306 | 8,467 |
| large × postgres | secondary | — | 26 | 22 | 22 / 42 / 33 | 0 | 0 |

Joins issued/succeeded: 6/6, 20/20, and 50/50 (every join and presence call
asserted success; the S1 false-failure tail did not appear at these tiers on
this machine — the join steps carry a 3-attempt 5xx retry that stayed
unused). Join writes split across the cluster (large: 19 primary + 10
secondary + ~21 on the uncaptured tertiary).

### Steady-state window (T2−T1, ~60 s ≈ per minute)

| Tier × backend | Server | Mutations | Expansions | Recomputes T/E/P | WS sends | Deliveries |
| --- | --- | --- | --- | --- | --- | --- |
| small × memory | primary | 12 | 12 | 12 / 12 / 12 | 48 | 288 |
| medium × memory | primary | 40 | 40 | 40 / 40 / 40 | 160 | 3,200 |
| small × postgres | primary | 12 | 12 | 12 / 12 / 12 | 48 | 288 |
| medium × postgres | primary | 40 | 37 | 37 / 40 / 39 | 160 | 3,200 |
| large × postgres | primary | 57 | 56 | 56 / 62 / 34 | 400 | 20,000 |
| large × postgres | secondary | 28 | 23 | 23 / 62 / 40 | 0 | 0 |

The steady-state mutations are exactly the two heartbeat rounds (2 × N,
split across servers under the cluster) — nothing else was running.

### Queue depth (rows in `resource_inbox` at capture instants)

| Tier × backend | T0 | T1 | T2 |
| --- | --- | --- | --- |
| small × memory | 138 | 282 | 367 |
| medium × memory | 401 | 882 | 1,163 |
| small × postgres | 140 | 284 | 371 |
| medium × postgres | 405 | 885 | 1,168 |
| large × postgres | 13 | 1,213 | 1,916 |

These are sampled totals (completed rows retained until expiry included),
not instantaneous backlog peaks.

### Per-client overlay delivery and other captures

- Every client received at least one `overlay.topology` publication for its
  group (hard-asserted per client via the exact matched route topic). The
  recipes do not count per-client totals; the primary's `overlay.topology`
  delivery share (e.g. 6,582 of the large run's cumulative T2 deliveries)
  is the aggregate view.
- `wsOutboxNoLocalRecipientCount` at T1: 201–482 (standard runs), 400
  primary / 829 secondary (large) — world-scope and cross-server rows
  resolved with no local recipient (the S2 multi-server compounder).
- RTT counters (`rttAcceptedWriteCount`, `rttRecomputeIntentCount`) are 0 in
  all tiers: the recipes drive raw WS sockets, not browser RTC clients, so
  no RTT reports are submitted. The S7 RTT term is exercised by the
  browser-side diagnostics (validated on the live 3-browser path), not by
  these recipes.

## Observations against the scenario record

- **S3 (uncoalesced recompute storm), confirmed and quantified.** Every
  presence-summary expansion enqueues exactly one recompute
  (triggered == expansions in every window), recomputes execute ≈ 1:1 with
  triggers, and `topologyPublishSkippedUnchangedCount` stayed 0 everywhere:
  the revision always advances, so even structurally identical graphs
  publish to all sessions.
- **S7 (the storm never ends), confirmed.** An idle formed group with only
  heartbeats runs 2 mutations → 2 expansions → 2 recomputes → 2 publishes
  per client per minute. At N=50 that is ~20,000 WS deliveries per minute on
  the primary alone (≈333/s), matching the scenario record's order of
  magnitude with zero application traffic.
- **S2 (O(N³) broadcast scaling), visible in the delivery curve.** Steady
  -state deliveries grow super-linearly: 288 (N=6) → 3,200 (N=20) → 20,000
  (N=50) per window — ×11 and ×6.3 for ×3.3 and ×2.5 member growth — because
  each of the 2N mutations fans out full-snapshot rows to all N sessions
  plus world-scope client rows.
- **S1 (join backlog) did not bite at these tiers on this machine**: the
  50-client burst completed in 6.6 s with every join succeeding first
  attempt. The mechanism (serialized lanes) is still visible in the queue
  totals; the false-failure tail presumably needs slower storage or larger
  N.
- The storm is also an observability hazard: before this change the N=20
  recipe report serialized ~96–144 MB (dominated by retained per-socket
  message buffers), and the N=50 report exceeded the V8 string-length limit
  outright — the runner now bounds ws.wait failure diagnostics and the
  per-connection stores it writes into artifacts.
