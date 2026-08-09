# Rallar Group Formation Phase 1: Overlay Precedence And Bounded Bootstrap

Status: implementation and local validation complete on
`codex/group-formation-phase1-overlay-precedence` (PR #138), based on `main`
at `76e5a1b3`; awaiting **Branch Release Gate** confirmation on the final
build-affecting commit, human review/merge, and the post-merge **Run Hetzner
Supported Distributed Manifests** gate before the plan can be marked
complete.

## Progress notes (2026-08-09)

- Commits: plan checkpoint `2755122b`; implementation `7eca6b18` (provenance
  admission, conditional bounded star, dial budget, flag threading, style
  splits); tier simulation `16561c46`; measured results
  `aebe9393`; headless bundle ratchet `5466ccca` (final build-affecting
  commit — the Phase 1 modules add ~0.7 KiB brotli, budget 194 → 196 with
  boundary assertions unchanged).
- Local completion gates from the final tree at `5466ccca`:
  `npm run test:unit` (717 files, 6,562 passed), `npm run test:ci` (exit 0;
  unit + Deno + Playwright e2e 38 + 211 + full-stack 7), `npm run build`
  (exit 0). `npm run check:repo-style:changed -- origin/main HEAD` passed
  with zero findings; `check:browser-bundles` passed;
  `apps/api-v1 deno task check` passed.
- Tier evidence (Decision 4 mapping): simulation asserts 100%
  server-overlay adoption, zero conflicts, dials ≤ budget at N=6/20/50 and
  the 49-dial legacy contrast; live-rtc-3 (memory) passed with captured
  diagnostics (zero admission conflicts, dials ≤ desired, deferrals 0);
  recipes rerun green — memory 13/13, postgres 13/13 + 5/5 cluster,
  formation-large 1/1 (1,324 steps, 0 failures) — with baseline-matching
  server-side signatures. Committed record:
  `playground/rtc-design/baselines/2026-08-09-phase1-overlay-precedence-results.md`.
- Gates that do not bind (evidence): `git diff origin/main...HEAD` contains
  no `packages/shared-server` or `apps/**` changes, so the api-v1
  medium-scale convergence and state-write perf gates are not required by
  the mutation-path rule; the PR-triggered **API v1 Medium-Scale Gate**
  nevertheless ran and succeeded on `7eca6b18`, `16561c46`, `aebe9393`,
  and `5466ccca` (run 31326547901).
- Remote gates: **Branch Release Gate** failed on `7eca6b18`/`16561c46`
  solely on the headless bundle ratchet (194.61 > 194), fixed in
  `5466ccca`; run 31326545612 **succeeded on `5466ccca`**. **Run Hetzner
  Supported Distributed Manifests** pends the resulting default-branch
  commit after merge; the plan is not complete until it is green there.

## Context

Phase 0 (merged as `be6acbfe`, PR #113) made the formation storm observable:
storm counters on the server (`group-formation` admin metrics family), browser
diagnostics (`rallar.rtc.diagnostics().groupManager` / `.overlayAdoption`),
formation-burst black-box recipes at the 6/20/50 tiers, and the committed
baseline `playground/rtc-design/baselines/2026-08-08-formation-burst-baseline.md`.

Phase 1 of
`playground/rtc-design/2026-08-08-group-formation-implementation-plan.md`
(mechanisms M5 + M10, root cause 1 / scenario S5) makes the server's topology
actually take effect and stops browser full-mesh dialing. The defect chain
today, all browser-side:

1. Every group snapshot update unconditionally restamps a local full-membership
   star overlay (`packages/shared-web/browser/data-caches.ts:409` →
   `createAndSetStarOverlays`, builder at
   `packages/shared/repository/overlays-repository.ts:359`) carrying the
   group's **latest** causal revision and `overlayVersion = group version`.
2. Overlay admission (`overlays-repository.ts:276` `setOverlayById`) orders
   overlays by the `(sourceGroupStateCausalRevision, overlayVersion)` tuple
   only. A server overlay planned against an older group revision is
   `dominated` (dropped) or `incomparable` (conflict) against the freshly
   restamped star — server topologies effectively never govern browsers.
3. The star's `nextHopSessionIds` is **all members**, so
   `WebRtcGroupManager.reconcileAllGroups` (connect loop at
   `packages/shared/services/WebRtcGroupManager.ts:277-292`) dials N−1 peers
   with no outbound cap, while inbound admission is capped at
   `maxPeerConnections` (10) — the 49-out/10-in asymmetry.
4. The star's `degreeLimit` is N−1, and
   `WebRtcGroupManager.overlayRttReportingDegreeLimit()` treats the overlay
   `degreeLimit` as the RTT-reporting fallback degree, so RTT reporting also
   scales with N instead of ~5.

Phase 1 is browser-side only: `packages/shared` (contracts, repository,
services, rtc policy) and `packages/shared-web/browser`. No server behavior,
route, or schema changes. Verified: `OverlayInfo` has no usage under
`packages/shared-server` or `apps/**`; the wire contract
(`RallarOverlayTopologySnapshot`, `packages/shared/api/overlay-topology.ts`)
is unchanged.

## Decisions for review (owner may override at this checkpoint)

1. **Provenance admission is always-on; the rollback flag governs the
   environment-dependent behaviors** (conditional star, bounded bootstrap
   selection, outbound dial budget). Rationale: the admission rule
   ("server supersedes bootstrap; bootstrap never overwrites server") is a
   pure, deterministic correctness fix for S5 with exhaustive unit coverage —
   reverting it means reverting the phase (git revert). The plausible
   production rollback need is different: bounded bootstrap graphs or the dial
   budget misbehaving in some environment. `legacy-star` mode therefore
   restores the unconditional full-membership star (shape, N−1 degree,
   unconditional restamp attempts) and unbounded dialing — the aggressive
   legacy connectivity — while server topology, once published, still governs.
   A restamped bootstrap star cannot displace an adopted server overlay even
   in legacy mode; that displacement is the root-cause bug, not a behavior to
   preserve.
2. **Flag surface**: `groupFormationMode: 'bounded-bootstrap' | 'legacy-star'`
   (default `'bounded-bootstrap'`) plus `bootstrapDegree?: number`, exposed
   exactly like `maxPeerConnections` today: `RallarOperationOptions`
   (`packages/shared-web/browser/rallar-operation-options.ts:16`),
   `RallarBrowserRuntimeDefaults.rtc`
   (`packages/shared-web/browser/rallar-runtime-context.ts:35-41`), resolved
   in the runtime context and threaded through the middleware composition
   root into `data-caches` and `WebRtcGroupManager`.
3. **Default bootstrap degree** = `min(5, maxPeerConnections)` — 5 matches
   `DEFAULT_RTT_REPORTING_DEGREE_LIMIT`
   (`packages/shared/rtc/rtt-reporting-policy.ts:1`), the "server/bootstrap
   degree (≤5-ish)" target in the program plan; the `min` keeps the bootstrap
   set inside the connection budget when an app configures a smaller budget.
4. **Tier evidence mapping.** The formation-burst recipes drive raw WS
   sockets (baseline "Reading rules"), so browser adoption/dial counters
   cannot come from those processes. Phase 1 supplies the required
   "overlay adoption ≈ 100% and bounded outbound dials at N=6/20/50"
   evidence from the components that actually run that logic, at exactly
   those tiers:
   - a new deterministic in-process formation-burst simulation test that
     instantiates N real browser stacks (overlays/group/client repositories +
     `WebRtcGroupManager` over a fake `WebRtcConnectionService`) at N=6/20/50,
     bursts joins, publishes server overlays, and asserts adoption 100% and
     dials ≤ budget per client — using the same Phase 0 diagnostics counters;
   - the live three-browser matrix with
     `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR` capture, asserting the same
     from real browsers via `rallar.rtc.diagnostics()`;
   - the unchanged formation-burst recipes at 6/20/50 rerun against the
     Phase 1 tree to prove the server-side storm quantities and the
     per-client `overlay.topology` delivery assertions are not regressed
     (Phase 1 must not change server behavior; deltas vs the baseline are
     recorded).
5. **Connect-first ordering stays.** The reconcile loop keeps its current
   connect → disconnect → evict order; budget freed by disconnects becomes
   available on the next reconcile (reconciles fire on every presence/overlay
   change). Make-before-break and grace windows are Phase 4 (M11); reordering
   teardown before dialing is out of scope here.
6. **Measured-results document**: tier reruns, simulation numbers, and
   live-rtc-3 diagnostics land in
   `playground/rtc-design/baselines/2026-08-09-phase1-overlay-precedence-results.md`
   beside the Phase 0 baseline, with a README row, following the same
   raw-artifacts-not-committed policy.

## Roadmap coordination

The active RTC B01–B05 reservation (roadmap Section 10) reserves
`scripts/perf/rtc-baseline/**`, the listed `scripts/perf/*` harnesses, the
`packages/tests/repo/rtc-performance-baseline-*.test.ts` files, the baseline
plan document, and `tmp/perf/rtc-baseline/**`. **This plan writes none of
those paths.** Declared overlap of subject, not files: Phase 1 changes the
behavior of `WebRtcGroupManager` and overlay admission, which are on the
baseline program's measured workload — dial counts and RTT-reporting degree
change by design. The human program owner sequences B01–B05 captures against
this phase so before/after RTC baselines are not mixed within one accepted
envelope.

## Scope

In scope:

1. Overlay **provenance** (`'server' | 'bootstrap'`) on `OverlayInfo` and
   provenance-aware admission in `setOverlayById`: server supersedes
   bootstrap; bootstrap never overwrites server; same-provenance ordering
   keeps the existing monotonic tuple. New adoption-diagnostics outcomes and
   counters for both new branches.
2. **Conditional local star**: the bootstrap overlay is created only when no
   server overlay exists for the group; bootstrap-over-bootstrap restamps
   (membership changes) still advance while no server overlay exists.
3. **Bounded rendezvous-hash bootstrap selection**: `nextHopSessionIds` =
   deterministic ≤ `bootstrapDegree` peers per (groupKey, sessionId), reusing
   the FNV-1a rendezvous scoring already in `rtt-reporting-policy.ts`;
   `degreeLimit` = effective bootstrap degree (so RTT reporting inherits ≤5).
4. **Outbound dial budget** in the `WebRtcGroupManager` reconcile connect
   loop: new dials capped at `maxPeerConnections − |known ∩ desired|`
   (see the Design amendment on retained connections);
   priority order server-overlay next hops, then bootstrap peers; deferred
   dials counted in diagnostics.
5. The `groupFormationMode` rollback flag and `bootstrapDegree` config,
   threaded through the existing options/defaults surfaces.
6. Unit tests, the N=6/20/50 in-process simulation test, public-surface
   snapshot updates, tier recipe reruns, live-rtc-3 diagnostics capture, and
   the committed results document.

Out of scope (explicitly): all server-side damping (Phase 2 — coalescer,
change gate, heartbeat separation, audience fix); delta dissemination and
overlay read-through on connect (Phase 3 — `hydrateStateCaches` still does
not pull `GET .../topology`; adoption of the first server overlay still rides
its WS publication); incremental replans, hysteresis, retention grace windows
(Phase 4); formation epochs (Phase 5). No changes to
`packages/shared-server`, `apps/api-v1`, recipes, or the black-box runner.

## Design

### 1. Provenance and admission (`packages/shared`)

- `OverlayInfo` (`packages/shared/api/api-config.ts:120`) gains required
  `provenance: 'server' | 'bootstrap'` (house rule: required fields by
  default; every constructor is in this change set). Type
  `OverlayProvenance` lives beside `OverlayInfo`.
- `toOverlayInfoForSession` (`packages/shared/api/overlay-topology.ts:41`)
  stamps `'server'` — it is the single decoder for server
  `overlay.topology` publications (`data-caches.ts:186-202`). The wire
  snapshot itself is unchanged.
- The bootstrap builder stamps `'bootstrap'`.
- `updateNextHopSessionIds` (`overlays-repository.ts:203`, the `graphs`
  topic path) preserves the current overlay's provenance.
- `setOverlayById` (`overlays-repository.ts:276`) admission becomes, in
  order: no current → initial-set (unchanged); incoming `server` over
  current `bootstrap` → **adopt always** (new outcome
  `server-superseded-bootstrap`); incoming `bootstrap` over current
  `server` → **drop always** (new outcome `bootstrap-dropped-over-server`);
  same provenance → existing tuple comparison and conflict semantics
  unchanged. `OverlayAdoptionOutcome` union and the adoption counters gain
  the two new members (`serverSupersededBootstrapCount`,
  `bootstrapDroppedOverServerCount`); Phase 0 counter fields keep their
  meaning for same-provenance flows.
- Admission logic stays a pure decision over the two records; if the
  file's style budget demands, the comparison moves to a sibling
  `overlay-admission.ts` with `overlays-repository.ts` keeping the
  repository shell.

### 2. Bootstrap selection (`packages/shared/rtc`)

- New `packages/shared/rtc/rendezvous-hash.ts`: the FNV-1a scoring extracted
  verbatim from `rtt-reporting-policy.ts:65-80`; `rtt-reporting-policy.ts`
  re-imports it (zero behavior change,
  `packages/tests/shared/rtc-rtt-reporting-policy.test.ts` must stay green
  unmodified).
- New `packages/shared/rtc/bootstrap-peer-selection.ts`:
  `selectBootstrapPeers({ localSessionId, memberSessionIds, groupKey,
  bootstrapDegree })` → deterministic, self-excluded, ≤ degree, ordered by
  rendezvous score. Also `resolveBootstrapDegree({ bootstrapDegree?,
  maxPeerConnections? })` → `min(bootstrapDegree ?? 5, maxPeerConnections ??
  10)`, guarded to positive integers.
- Bootstrap graphs are k-out digraphs with pseudo-random asymmetric edges;
  undirected-union connectivity at k=5 is validated by unit test across
  N=6/20/50 and many deterministic seed sets (risk 3 of the program plan).
  WS relay remains the correctness baseline regardless — a disconnected
  bootstrap component degrades to relay, never to silence.

### 3. Conditional bounded star (`packages/shared` repository +
`packages/shared-web/browser`)

- `overlays-repository.ts`: new
  `createAndSetBootstrapOverlays(groups, policy, manager?)` where `policy`
  carries `{ localSessionId, mode, bootstrapDegree, maxPeerConnections }`.
  In `bounded-bootstrap` mode it builds the bounded overlay
  (`nextHopSessionIds` from `selectBootstrapPeers`, `degreeLimit` =
  effective bootstrap degree) and **skips creation entirely when a
  server-provenance overlay already exists** for the group (checked via the
  repository; admission also enforces it — defense in depth). In
  `legacy-star` mode it delegates to the unchanged full-membership builder.
  The existing `createAndSetStarOverlays` export keeps its exact legacy
  semantics (now stamping `provenance: 'bootstrap'`).
- `data-caches.ts:409` (`handleGroupSnapshotUpdate`) calls the new function
  with the policy from the observer context; `StateCacheScopeOptions` gains
  the policy input, provided by the middleware composition root
  (`packages/shared-web/browser/middleware.ts:296-316`) so construction
  stays visible. The policy decision (mode, degree) is made once at the
  composition root, not inside the handler.

### 4. Outbound dial budget (`packages/shared/services`)

- `WebRtcGroupManagerOptions` gains `groupFormationMode?`. In
  `bounded-bootstrap` mode `reconcileAllGroups` splits connectable desired
  peers into already-known (always ensured — an ensure on a known peer is
  not a new dial) and new dials; new dials are ordered server-overlay-desired
  first (provenance read from the group's overlay via
  `readOverlayForGroup`), then bootstrap-desired, deterministic within each
  class, and capped at `max(0, maxPeerConnections − |known ∩ desired|)` —
  the same budget inbound admission uses
  (`WebRtcConnectionService.canAcceptAdditionalPeer`,
  `packages/shared/services/WebRtcConnectionService.ts:570-590`).
  **Amendment (implementation finding):** only *desired* known connections
  count against the dial budget. Retained (grace) connections are governed
  by the existing retained-eviction pass, which trims the overflow within
  the same reconcile; counting them in the dial budget would let a full
  retained set permanently starve required dials, because retained
  eviction only fires when the retained count exceeds the leftover budget,
  which a deferred dial never raises. Deferred
  dials increment a new `connectDeferredBudgetCount` diagnostics field.
  `legacy-star` mode keeps today's unbounded loop.
- The dial-plan computation is a pure function in a new sibling module
  (`webrtc-outbound-dial-plan.ts`, verb `computeOutboundDialPlan`) so
  `WebRtcGroupManager.ts` (608 lines) barely grows and the decision is
  testable in isolation.
- RTT-reporting degree needs no code change: with the bounded star,
  `overlayRttReportingDegreeLimit()` now sees `degreeLimit ≤ 5` instead of
  N−1, which is the plan's intended inheritance.

### 5. Flag threading (`packages/shared-web/browser`)

`RallarOperationOptions` (+ normalization), `RallarBrowserRuntimeDefaults.rtc`,
the runtime-context resolution (`rallar-runtime-context.ts:214-227` pattern),
middleware options, and the two consumers (data-caches policy,
`WebRtcGroupManager` options). Additive public-surface change → deliberate
snapshot updates in `shared-web-public-api-snapshots.test.ts`; bundle
boundary checks must stay green.

## Tasks

### Task 1 — Shared primitives: provenance, admission, selection

`OverlayProvenance` on `OverlayInfo`; stamped builders/decoder;
provenance-aware `setOverlayById` with the two new outcomes/counters;
`rendezvous-hash.ts` extraction; `bootstrap-peer-selection.ts`.
Tests: admission decision table (every provenance × tuple combination,
including conflict-path preservation), selection determinism/bounds/
self-exclusion, union-graph connectivity at 6/20/50, RTT policy suite
untouched and green.

### Task 2 — Conditional bounded star and flag threading

`createAndSetBootstrapOverlays` + policy; `data-caches.ts` switch;
options/defaults/runtime-context/middleware threading; snapshots.
Tests: `data-caches.test.ts` — bounded shape, conditional creation (no
bootstrap write when server overlay present), restamp-over-server dropped,
legacy mode bit-identical star behavior; snapshot updates.

### Task 3 — Outbound dial budget

`computeOutboundDialPlan` + reconcile integration + diagnostics field +
options. Tests: budget cap, server-first priority, deferred counting,
already-known ensures not budget-counted, legacy mode unbounded,
`webrtc-group-manager.test.ts` extensions.

### Task 4 — Tier simulation test

`packages/tests/shared-web/group-formation-burst-simulation.test.ts` (exact
home may shift to `packages/tests/shared/` if no shared-web import is
needed): N=6/20/50, per-client isolated repositories via `RepositoryManager`
(`packages/tests/cache-repository-config.ts` pattern), fake rtcQBox, burst
join → assert bootstrap dials ≤ budget and bootstrap next-hops ≤ degree →
publish server overlay per client → assert adoption 100%
(`initialSetCount + serverSupersededBootstrapCount` accounts for every
client, `incomparableConflictCount == 0`, every manager's effective overlay
is server-provenance) and total connect attempts bounded.

### Task 5 — Tier reruns, live diagnostics, results document

Recipes unchanged: memory (small+medium), postgres (small+medium),
postgres formation-large; deltas vs the Phase 0 baseline recorded.
live-rtc-3 (memory mode) with diagnostics capture; verify
`groupManager.connectAttemptCount` bounded and `overlayAdoption` shows
server adoption without conflicts. Commit the results document + README row.

## Validation

Focused first:

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
cd apps/api-v1 && deno task check   # packages/shared is on its compile path
npx vitest run packages/tests/shared/rtc-rtt-reporting-policy.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/webrtc-overlay-services.test.ts
npx vitest run packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

plus the new selection, admission, dial-plan, and simulation test files.

Tier evidence (Decision 4 mapping):

```sh
npx vitest run packages/tests/shared-web/group-formation-burst-simulation.test.ts
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:formation-large
RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/results npm run test:rallar:full-stack:memory:live-rtc-3
```

Gates that do **not** apply, with evidence to be recorded at completion: the
api-v1 medium-scale convergence gate and the state-write perf comparison
bind to api-v1 mutation-path/server changes; this phase's diff must contain
no `packages/shared-server` or `apps/**` production changes (verified by
`git diff --stat` at completion; if that ever stops being true, both gates
become required). Postgres-backed runs follow the DB-freshness procedure
(fresh migrate before capture; issues #119/#136).

Repo style: `npm run check:repo-style:changed -- origin/main HEAD`.

Completion gates (plan completion policy): from the final working tree
`npm run test:unit`, `npm run test:ci`, `npm run build`; draft PR record
current; **Branch Release Gate** green on the final feature-branch commit;
**Run Hetzner Supported Distributed Manifests** green on the resulting
default-branch commit; exact SHAs recorded here. Any change after a passing
gate invalidates it.

## Sequencing

One feature branch, commits in task order (1 shared primitives → 2 star +
threading → 3 dial budget → 4 simulation → 5 reruns + results doc), one
draft PR for the plan-to-implementation lifecycle, kept current per
checkpoint. Default-branch base recorded: `76e5a1b3`; plan revalidation runs
before each published milestone.

## Risks

1. **Bootstrap connectivity at small degree** (program-plan risk 3):
   validated by the connectivity unit test across tiers and seeds; WS relay
   remains the correctness floor; `legacy-star` is the operational rollback.
2. **Dial-budget starvation under churn**: deferred dials are retried on
   every reconcile (presence/overlay driven); the deferred counter makes
   starvation observable in diagnostics and live-rtc capture; rollback flag.
3. **Public-surface churn**: additive fields on `OverlayInfo`,
   `RallarOperationOptions`, defaults, and diagnostics; deliberate snapshot
   updates; no removals.
4. **Existing-file style budgets** (`WebRtcGroupManager.ts` 608 lines,
   `data-caches.ts` 478, `overlays-repository.ts` 374): new logic lands in
   new small pure modules; edits to existing files stay near call sites;
   `check:repo-style:changed` is the arbiter, style-lineage declarations
   only if unavoidable.
5. **Interaction with PR #83** (activation design): M11-adjacent retention
   behavior is untouched; this phase only implements M5/M10 as the program
   plan's merge-point rules require.
