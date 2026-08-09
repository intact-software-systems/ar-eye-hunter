# Rallar Group Formation Phase 0: Storm Metrics And Formation-Burst Baseline

Status: complete. Merged to `main` as `be6acbfe` (PR #113); all local and
remote completion gates passed (see the completion record below).

## Progress notes (2026-08-09)

- Final feature-branch commit `e6ba759c` ("test: align api-v1 deno fakes
  and migration pins with the formation wiring"); instrumentation commits
  `31824133` (server metrics), `063fb7f1` (browser diagnostics), `3a757fce`
  (style-budget splits with `plans/repo-style-lineages/` declarations),
  `1d6b60e2` + `752e3ddc` (recipes and storm-safe runner fixes), `c2ce5fd6`
  (baseline document), `5fc67a14` (pinning-suite registration).
- Completion gates from the final tree at `e6ba759c`: `npm run test:unit`
  (6493 passed / 22 skipped), `npm run test:ci`, and `npm run build` all
  passed; `npm run check:repo-style:changed -- origin/main` passed with
  zero findings. **Branch Release Gate** run 31282733981 succeeded on
  `e6ba759c`; the PR-triggered **API v1 Medium-Scale Gate** run 31282735230
  also succeeded. **Run Hetzner Supported Distributed Manifests** is
  pending the resulting default-branch commit after merge.
- Black-box evidence: memory 13/13; postgres 13/13 standard + 5/5 cluster;
  formation-large 1/1; medium-scale convergence gate 1/1 (unweakened).
  Baseline recorded in
  `playground/rtc-design/baselines/2026-08-08-formation-burst-baseline.md`.
- Open items flagged in PR #113: the state-write perf comparison gate
  failed as run and, as designed, requires strict shared-throughput
  improvement, so it cannot pass an observation-only change (recorded
  artifacts under `tmp/perf/`; local Docker Postgres also proved unstable
  under the bench); the live-rtc-3 browser validation fails identically on
  the merge base in this environment (peer establishment timeouts), so the
  live capture of the new diagnostics fields remains open on a healthy RTC
  host. Both items were resolved later the same day; see the completion
  record.

## Completion record (2026-08-09, post-merge)

- Both open items above were resolved before merge. The perf comparative
  gate **passed** under the unmodified comparator once each side was
  benchmarked against a freshly migrated database (earlier failures were
  order-confounded by database residue; full numbers and the four
  reason-recorded sub-1% SQL median deltas are in the PR #113 comments).
  live-rtc-3 went **green** after fixing the local environment (missing
  `RALLAR_AUTH_CREDENTIAL_SECRET` for postgres-mode env files and a
  Docker-recreated Postgres volume), and the captured
  `live-rtc-diagnostics-*.json` artifacts verify the new
  `groupManager`/`overlayAdoption` fields with plausible counters.
- The branch was rebased onto `main` at `72166816` (middleware auto-merge
  semantically verified against PR #110's queue pub-sub bridge option;
  reviewed-source blob pin recomputed; style-lineage manifests re-anchored
  to the new merge base). Final feature-branch commit: `4cd9d752`.
- Local completion gates from the final tree: `npm run test:unit`
  (6,536 passed), `npm run test:ci` (exit 0), `npm run build` (exit 0);
  `npm run check:repo-style:changed -- origin/main HEAD` passed with zero
  findings; api-v1 `deno task test` 407 passed.
- Remote gates: **Branch Release Gate** run 31320994588 succeeded on
  `4cd9d752`; **API v1 Medium-Scale Gate** run 31320996882 succeeded;
  **Run Hetzner Supported Distributed Manifests** run 31321817717
  succeeded on the resulting default-branch commit `be6acbfe`.
- Follow-ups per the follow-up governance: issue #136 (live-rtc-3 peer
  readiness flakes on databases dirtied by earlier heavy runs) created;
  issue #119 (`db:test:up` self-containment) reused with new evidence.
  The perf comparator's retired campaign rules were addressed separately
  in PR #134 (`8a42574d`), merged the same day.

## Context

`playground/rtc-design/2026-08-08-group-formation-storm-scenarios.md`
documents, with code evidence, what happens today when 50 clients join a
group within a few seconds (scenarios S1–S7): a join backlog with
false-failure tails, an O(N^3) snapshot broadcast storm, an uncoalesced
graph-recompute storm, a browser full-mesh dial storm, server topologies
that browsers never adopt, stranded late joiners, and a permanent
heartbeat/RTT-driven storm at idle.
`playground/rtc-design/2026-08-08-group-formation-implementation-plan.md`
defines Phase 0 as the first slice: make every storm quantity observable and
build the formation-burst black-box regression harness at the small (6),
medium (20), and large (50) tiers, so Phases 1+ (overlay precedence, server
damping, deltas, stable topology) land with before/after evidence.

This plan is Phase 0 only. It is strictly additive: **zero behavior
change**. No debounce, no coalescing, no precedence change, no caps.
Counters and recipes observe the current system; the baseline records it.

Decisions already made by the product owner for this plan:

- Browser-side instrumentation is in scope in full: counters plus exposure
  through `rallar.rtc.diagnostics()` and the black-box browser runtime,
  validated at the existing 3-browser live path.
- The steady-state (S7) measurement window applies to **all three tiers**.
- The committed baseline deliverable is a markdown document under
  `playground/rtc-design/baselines/`; raw run artifacts are never committed
  (`scripts/perf/README.md:30-42` artifact policy).
- Tier recipes are authored with the recipe `fragments`/`replace` mechanism
  first; if per-client instantiation proves insufficient, fall back to
  committed generated JSON (the 9.8k-line
  `api-v1-state-medium-scale-churn.json` is the size precedent). Record
  which path was taken in the recipe descriptions and the PR.

Principles that bind every task below:

- Recording must never affect behavior: every recorder call is wrapped so it
  cannot throw or change control flow (precedent comments:
  `packages/shared-server/rallar-system/services/timing.ts:55`,
  `packages/shared-web/browser/state-read/diagnostics.ts:25-33`).
- The burst recipes must **pass on current behavior**. Assertions are
  correctness/liveness only (everyone joins, everyone receives a topology);
  storm quantities are recorded, never judged. Threshold regression gates
  are added by later phases once improvements land.
- Metrics are process-local (existing warning `'process-local-realtime'`,
  `AdminOperationsService.ts:156-160`); under the two-server Postgres
  runner the recipe reads both servers and the baseline records per-server
  numbers.

## Roadmap coordination

The active RTC B01–B05 reservation (roadmap Section 10, activated by the
`docs: activate nine-path RTC Task 1 reservation` revision) reserves
`scripts/perf/rtc-baseline/**`, 20 existing `scripts/perf/*` harnesses,
three `packages/tests/repo/rtc-performance-baseline-*.test.ts` files, the
baseline plan document, and `tmp/perf/rtc-baseline/**`. **This plan writes
none of those paths.**

One declared overlap of subject (not of files): Phase 0 adds counters inside
files the baseline program _benchmarks_ (`WebRtcGroupManager.ts`,
`rallar-rtc-topology-service.ts`, `QRtcPeerConnection`-adjacent paths). The
counters are plain number increments behind never-throw guards; the
state-write perf comparison gate in the validation section quantifies any
overhead. The human program owner sequences this plan against B01–B05
capture so instrumented and pre-instrumentation measurements are not mixed
within one accepted baseline envelope.

## Scope

In scope:

1. Server storm counters (`group-formation` metrics family) following the
   existing counter-object + `readMetrics()`/`resetMetrics()` house pattern,
   exposed through the existing admin operations endpoints.
2. Browser storm counters (overlay adoption, reconcile/dial/teardown)
   following the existing diagnostics patterns, exposed through
   `rallar.rtc.diagnostics()` and the black-box browser runtime event
   stream.
3. Three formation-burst black-box recipes (6/20/50) with matrix entries and
   npm scripts; small+medium in the standard api-v1 profiles, large behind a
   focused Postgres command (the medium-scale pattern).
4. A committed baseline document recording the measured numbers per tier and
   backend.

Out of scope (explicitly): any damping, coalescing, precedence, budget, or
dissemination change (Phases 1+); Hetzner distributed manifests for the
formation recipes (later phase); Prometheus/OpenMetrics endpoints (the admin
JSON endpoint is the house style); counters on `ResourceInboxRepository`
internals (queue-depth numbers already come from
`PSqlAdminOperationsStatsReader.readQueues`,
`packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts:77-102`).

## Metric inventory

Every metric is grounded in the code site the scenarios document identified.
"Existing" means reuse without duplication.

### Server: new `group-formation` counter family

| Counter                                                                                                                                      | Instrumented at                                                                                                                                                                                                   | Scenario |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `groupMutationCount` by operation kind (join, presenceConnect, heartbeat, disconnect, membership, other) and outcome (write, noOp, rejected) | `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts` (post-commit of `processGroupStateMutation`, ~:80-120)                                                                      | S1, S7   |
| `presenceSummaryExpansionCount`, `presenceSummaryWsRowCount` by kind (event, snapshot, directory), `presenceSummaryTopologyEntryCount`       | `packages/shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts:205-273`                                                                                                                | S2, S3   |
| `topologyRecomputeTriggeredCount` (outbox entries written)                                                                                   | `packages/shared-server/rallar-system/services/rtc-topology-outbox-entry.ts` (`writeRtcTopologyOutbox`, ~:67-192)                                                                                                 | S3, S7   |
| `wsOutboxSendCount` and `wsOutboxRecipientCount` by `topicId`, `wsOutboxNoLocalRecipientCount`                                               | `packages/shared/services/WsQueueBoxServerService.ts` (`sendPreparedMessage` :673-692, `sendToTargetsWithResult` :448-460) via a small optional sink declared in `packages/shared` (the file is runtime-agnostic) | S2, S7   |
| `rttAcceptedWriteCount`, `rttRecomputeIntentCount` — add only what `RallarRtcTopologyMetrics` does not already carry                         | `packages/shared-server/rallar-system/services/rtc-topology-mutations.ts:539-552`; verify against existing `rttQueue*` counters first (`rallar-rtc-topology-service.ts:66-72`)                                    | S7       |

Reused as-is (no new code): recompute executed/changed/unchanged and publish
attempt/published/skipped-unchanged already exist in
`RallarRtcTopologyMetrics`
(`packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts:49-81`,
recorded at `:249-256` and call sites in
`group-topology-management-service.ts:242,866,874`); queue rows by
type/status via `GET /api/admin/operations/queues`.

### Browser: new diagnostics

| Counter                                                                                                                                                                | Instrumented at                                                                                                                                                                                                                                                                                                                                                             | Scenario |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Overlay adoption results: `adoptedCount`, `dominatedDroppedCount`, `incomparableConflictCount`, `equalCount`, `initialSetCount`                                        | `packages/shared/repository/overlays-repository.ts` (`setOverlayById` branches :211-238) via a module-level opt-in sink (pattern: `packages/shared-web/browser/state-read/diagnostics.ts:16-33`)                                                                                                                                                                            | S5, S6   |
| `reconcileRunCount`, `reconcileAwaitedInFlightCount`, `lastDesiredPeerCount`, `connectAttemptCount`, `connectFailureCount`, `disconnectCount`, `retainedEvictionCount` | `packages/shared/services/WebRtcGroupManager.ts` (`reconcileAllGroups` :253-328: entry/suppress :254-257, connect loop :277-290, disconnect :294-306, eviction :308-315) as a `WebRtcGroupManagerDiagnostics` object with `readDiagnostics()`/`resetDiagnostics()` (pattern: `QRtcPeerConnectionDiagnostics`, `packages/shared/webrtc/QRtcPeerConnection.ts:66-99,162-171`) | S4, S5   |

Exposure: two additive optional fields on `RallarRtcDiagnostics`
(`packages/shared-web/browser/rallar-rtc-facade.ts:217-224`) —
`groupManager?` and `overlayAdoption?` — collected in
`packages/shared-web/browser/rallar-runtime/rtc.ts` (`toRtcDiagnostics`,
:293-347). Because the black-box browser runtime's health diagnostics embed
`rtcDiagnostics` already
(`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/contracts.ts:235-259`,
pull at `runtime.ts:531-536`), the new fields flow into browser-run
artifacts without runner changes; verify and extend at `runtime.ts:531-536`
only if the runtime narrows the object.

## Tasks

### Task 1 — Server formation-metrics recorder and admin exposure

New files:

- `packages/shared-server/rallar-system/formation-metrics/formation-metrics.ts`
  — `RallarGroupFormationMetrics` readonly contract, mutable counterpart,
  `emptyGroupFormationMetrics()`, and
  `createGroupFormationMetricsRecorder()` returning the increment hooks plus
  `readMetrics()`/`resetMetrics()`. Model directly on
  `rallar-rtc-topology-service.ts:162-224`. Keep the file well under the
  400-line new-TS cap (`scripts/check-changed-ts-file-growth.mjs:4`).
- `packages/shared-server/rallar-system/formation-metrics/formation-metrics-sinks.ts`
  (if needed) — narrow named sink types consumed by the instrumented owners,
  so dependencies stay visible-construction options (threading precedent:
  `RallarTimingSink` through `middleware.ts:149` and service options).

Edits (each: one optional named-sink option + guarded increment calls; no
control-flow change):

- `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts`
- `packages/shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts`
- `packages/shared-server/rallar-system/services/rtc-topology-outbox-entry.ts`
- `packages/shared/services/WsQueueBoxServerService.ts` — declare the
  minimal `WsDeliveryDiagnosticsSink` input field here (runtime-agnostic,
  default undefined); the server recorder implements it.
- `packages/shared-server/rallar-system/services/rtc-topology-mutations.ts`
  — only if the RTT counters are not already covered.

Admin exposure edits:

- `packages/shared/api/admin-operations-types.ts:5` — add
  `'group-formation'` to `ADMIN_METRICS_RESET_CATEGORIES`.
- `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`
  — options `readGroupFormationMetrics?` / `resetGroupFormationMetrics?`
  beside the rtc-topology hooks (:62-72); include in `readRealtime`
  (:168-171) and `readOverview` (:123-125); handle the category in
  `resetMetrics` (:187-216) and its validation (:391-422).
- `apps/api-v1/src/create-rallar-server.ts` — construct one recorder,
  wire the read/reset hooks beside the existing pair (:217-218), and thread
  the sinks into the middleware construction sites (summary worker
  registration at `apps/api-v1/src/middleware.ts:284-298`, group-state
  runtime composition, WS service construction).

Tests (Vitest, `packages/tests/shared-server/`):

- New `formation-metrics.test.ts`: counters increment per hook; read/reset
  round-trip; recorder never throws when a sink misbehaves.
- Extend the group-state inbox and presence-summary suites (start from the
  files named in
  `.agents/skills/rallar-testing/references/test-commands.md:42-61`) to
  assert the sinks fire on a write-outcome mutation and a summary
  expansion.
- Extend the admin-operations service coverage: `realtime`/`overview`
  include the family; reset category `group-formation` resets it and leaves
  `rtc-topology` untouched.

### Task 2 — Browser instrumentation and facade exposure

Edits:

- `packages/shared/services/WebRtcGroupManager.ts` — add
  `WebRtcGroupManagerDiagnostics` (readonly contract + private mutable
  counters), `readDiagnostics()`, `resetDiagnostics()`; increments at the
  sites listed in the inventory. No behavior change; the reconcile loop's
  logic is untouched.
- `packages/shared/repository/overlays-repository.ts` — module-level
  `setOverlayAdoptionDiagnosticsSink(sink)` plus guarded emit calls in the
  four `setOverlayById` outcome branches (:211-238). Existing `console.log`
  lines stay as-is (removing them is a Phase 1+ concern).
- `packages/shared-web/browser/rallar-rtc-facade.ts` — additive optional
  `groupManager` and `overlayAdoption` fields on `RallarRtcDiagnostics`
  (:217-224).
- `packages/shared-web/browser/rallar-runtime/rtc.ts` — collect both in
  `toRtcDiagnostics` (:293-347).
- `packages/shared-web/browser/middleware.ts` — register the overlay
  adoption sink at composition time into a process-local counter object
  (pattern: the state-read sink registration; the AL diagnostics sink
  threading at :68,182,216 is the wiring precedent).
- `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/runtime.ts:531-536`
  — verify the health pull carries the new fields; extend only if it
  narrows.

Tests:

- New/extended `packages/tests/shared/` coverage for
  `WebRtcGroupManager` diagnostics (reconcile/connect/disconnect counting
  against a fake rtcQBox) and the overlays-repository sink (one test per
  outcome branch).
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` —
  deliberate snapshot update for the additive fields.
- `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`,
  `shared-web-browser-entrypoints.test.ts` — must stay green;
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`.

### Task 3 — Formation-burst recipes, matrix entries, scripts

New recipes in `packages/shared-test/black-box-runner/tests/api-v1/`:

- `api-v1-group-formation-burst-small.json` (N=6)
- `api-v1-group-formation-burst-medium.json` (N=20)
- `api-v1-group-formation-burst-large.json` (N=50)

Common structure (per tier; authored via `fragments`/`replace` with one
client-flow fragment, fallback per Context):

1. **Setup**: register/login the group creator; create the group
   (`tests/api-v1/api-v1-group-presence.json:98-133` shapes); SET timestamp
   bookend (`{"transform": {"timestamp": true}}`, precedent
   `api-v1-state-medium-scale-churn.json:487-493`); read admin metrics T0
   (see step 5 for auth).
2. **Burst**: one `parallel` step, N sibling groups, `maxConcurrency: N`
   (`execute-black-box.ts:3483-3560` — no clamp), each group:
   register → login (with `x-forwarded-for: 10.1.{i}.1` spreading, precedent
   `api-v1-state-medium-scale-churn.json:520`, against
   `RALLAR_LOGIN_IP_RATE_LIMIT=100`,
   `api-v1-black-box-run.mts:149-150`) → upsert principal →
   `POST .../groups/{groupId}/join` → `POST /api/auth/ws-ticket` →
   `ws.connect` → `PUT .../groups/{groupId}/sessions/{sessionId}`.
3. **Convergence poll**: the unrolled poll-until idiom
   (`api-v1-state-medium-scale-churn.json:6383-6399` … final hard assert
   :8979-8990): up to 5 attempts of (SET `delayMs: 1000` + non-blocking
   `parallel`), each attempt: per-client `GET` group membership visible,
   and per-client `ws.wait` for at least one
   `{route: {topicId: "overlay.topology", contextId: "{groupId}"}}`
   message (shape: `api-v1-rtc-topology-convergence.json:576-610`), generous
   `withinMs`. The final attempt is a hard assert with
   `missingActualValue: "MISSING"`.
4. **Steady-state window (all tiers)**: hold sockets open; two heartbeat
   rounds (`PUT .../sessions/{sessionId}` heartbeat mutations) separated by
   SET `delayMs: 20000` each, ~60 s total; read admin metrics T1 before and
   T2 after so the idle-storm delta (S7) is recorded.
5. **Capture**: `GET /api/admin/operations/realtime` and
   `.../operations/queues` on the primary — and on the secondary under the
   Postgres runner — with an admin-authorized client (reuse the auth
   approach of `tests/api-v1/api-v1-admin-operations.json`; if the runner
   environment does not already provide an admin client id, add
   `AUTH_ADMIN_CLIENT_IDS` to `toApiV1BlackBoxEnvironment`
   (`api-v1-black-box-run.mts:120-171`) — a test-runner-env-only change).
   Extract counters into `outputs.*` so they land in `report.json`.
6. **Assertions** (baseline discipline): join/login/presence steps assert
   success statuses; the convergence assert is hard; admin-metrics asserts
   are existence/`gte: 0` sanity only. `postRunAssertions` limited to
   `summary.failure == 0`. **No upper-bound thresholds anywhere.**
7. `execution.artifact` caps set explicitly (order of
   `maxEvents: 200, maxReportResults: 400`; tune at implementation) — the
   quantitative source of truth is the admin-metrics outputs, not raw event
   capture (medium-scale precedent caps at 25/25,
   `api-v1-state-medium-scale-churn.json:60-65`).

Registration and scripts:

- `packages/shared-test/black-box-runner/recipe-matrix.json` — small and
  medium entries with
  `profiles: ["api-v1-black-box", "api-v1-black-box-recipes"]` (standard
  memory + postgres runs, hence branch CI); large entry with
  `profiles: ["api-v1-black-box-formation-large"]`.
- `packages/shared-test/package.json` — `bb:api-v1:postgres:formation-large`
  mirroring the medium-scale script (`--backend=postgres
--secondary-port=18081 --cluster-only
--cluster-profile=api-v1-black-box-formation-large
--artifact-dir=../../tmp/api-v1-black-box/postgres-formation-large`,
  pattern `packages/shared-test/package.json:10`).
- Root `package.json` —
  `test:api-v1:black-box:postgres:formation-large` workspace delegation
  beside the medium-scale line (`package.json:73-78`).

### Task 4 — Baseline runs and the committed baseline document

- Run: `npm run test:api-v1:black-box:memory` and
  `npm run test:api-v1:black-box:postgres` (small+medium tiers execute in
  both), plus `npm run test:api-v1:black-box:postgres:formation-large`.
- New committed document
  `playground/rtc-design/baselines/2026-08-XX-formation-burst-baseline.md`
  recording, per tier × backend (and per server on Postgres): joins
  issued/succeeded and burst duration; group mutations by kind; summary
  expansions and WS rows by kind/topic; recomputes triggered vs executed vs
  published; overlay messages received per client (min/median); queue-depth
  peaks from the queues endpoint; the steady-state deltas per minute
  (mutations, WS rows, recomputes) from the T1→T2 window; and the run
  provenance required by `scripts/perf/README.md:504-511` (branch/commit,
  machine and runtime versions, exact commands, artifact paths under
  `.artifacts/` / `tmp/`). Raw artifacts are not committed.
- Add a row for the baseline document to
  `playground/rtc-design/README.md`.

## Validation

Focused first (per
`.agents/skills/rallar-testing/references/test-commands.md`):

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
```

```sh
npx vitest run packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts packages/tests/shared-server/group-state/inbox/group-state-inbox-transaction-result.test.ts packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts
npx vitest run packages/tests/shared/webrtc-connection-service.test.ts
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

plus the new formation-metrics, group-manager-diagnostics, and
overlays-sink test files added by Tasks 1–2.

Recipes:

```sh
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:formation-large
```

Convergent-state gates — this plan touches api-v1 group/topology paths, so
both fixed gates apply unweakened
(`test-commands.md:106-139`):

```sh
npm run test:api-v1:black-box:postgres:medium-scale
```

```sh
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/api-v1-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/api-v1-state-write-baseline.json tmp/perf/api-v1-state-write-candidate.json
```

Browser counters at live scale (existing 3-browser path,
`scripts/perf/README.md:302-316`):

```sh
RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/results npm run test:rallar:full-stack:memory:live-rtc-3
```

then verify the captured diagnostics JSON contains the new `groupManager`
and `overlayAdoption` fields.

Repo style: `npm run check:repo-style:changed -- origin/main HEAD` (what
branch CI enforces). `npm run test:repo-governance` only if skills, plugin
metadata, or examples end up touched (not expected).

Completion gates (plan completion policy, `test-commands.md:141-172` and
`AGENTS.md`): from the final working tree run `npm run test:unit`,
`npm run test:ci`, and `npm run build`; the draft PR stays current; the
**Branch Release Gate** must pass on the final feature-branch commit and
**Run Hetzner Supported Distributed Manifests** on the resulting
default-branch commit; record the exact SHAs and workflow runs in this
plan's progress notes. Any change after a passing command invalidates it.

## Sequencing

One feature branch, commits in task order (1 server metrics → 2 browser
instrumentation → 3 recipes/scripts → 4 baseline doc), one draft PR kept
current. If review size demands, Tasks 1–2 and Task 3–4 may split into two
PRs; the baseline document lands only after the recipes run on the final
instrumented tree.

## Risks and notes

- **Hot-path overhead**: counters are plain increments behind never-throw
  guards; the state-write perf comparison is the quantitative check.
  Coordination with the B01–B05 baseline program is declared above.
- **Recipe runtime**: the all-tiers steady-state window adds ~60 s to each
  tier; small+medium therefore add ~2–3 minutes total to the standard
  api-v1 black-box runs. If branch CI duration becomes a problem, the
  window is removed from the small tier first (recorded as a revisit note,
  not done preemptively).
- **50-client recipe size**: if fragments cannot instantiate per-client
  flows, the committed generated JSON will be medium-scale-sized (~10k
  lines); acceptable per precedent.
- **Admin auth in the runner**: if `AUTH_ADMIN_CLIENT_IDS` is not already
  provided by `toApiV1BlackBoxEnvironment`, adding it is a test-env-only
  change and must not alter production defaults.
- **Public-surface churn**: limited to two additive optional fields on
  `RallarRtcDiagnostics`; snapshot updates are deliberate.
- **Process-local metrics**: numbers are per server; the baseline records
  primary and secondary separately under Postgres. No cross-server
  aggregation is attempted in Phase 0.
