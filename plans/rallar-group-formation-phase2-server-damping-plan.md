# Rallar Group Formation Phase 2: Server Damping (M1, M4, M3)

Status: in progress. Plan checkpoint; implementation follows in the same
draft PR. Base: `main` at `1e5f5e55` (recorded for plan revalidation).

Phase 2 of
[the group formation implementation plan](../playground/rtc-design/2026-08-08-group-formation-implementation-plan.md):
a join burst produces ~1 recompute, an idle group produces ~0 work. Baseline
evidence:
[Phase 0 formation-burst baseline](../playground/rtc-design/baselines/2026-08-08-formation-burst-baseline.md)
and
[Phase 1 overlay-precedence results](../playground/rtc-design/baselines/2026-08-09-phase1-overlay-precedence-results.md)
(20,000 WS deliveries/min at an idle N=50 group; recomputes triggered ≈
executed ≈ published; `topologyPublishSkippedUnchangedCount == 0`
everywhere).

## Context: the measured storm engine (file-level)

One causal chain produces every steady-state number in the baseline:

1. **Every group mutation — including `heartbeatPresence` — enqueues one
   presence-summary expansion.** `computeGroupMutationWriteResult`
   (`packages/shared-server/rallar-system/group-state/mutation/group-mutation-result.ts:92`)
   unconditionally emits a `GROUP_PRESENCE_SUMMARY` APP_OUTBOX entry keyed
   per `commandId`.
2. **Heartbeats always change summary content.** The summary content
   comparison (`compute-group-presence-summary.ts:84`, `summaryContent`)
   includes full `GroupPresenceSession` objects, so a moved
   `lastHeartbeatAtEpochMs`/`expiresAtEpochMs` forces `outcome: 'write'`
   with `presenceRevision + 1`.
3. **Every expansion fans out three WS rows and one topology entry.**
   `GroupPresenceSummaryWork.compute`
   (`group-state/presence/group-presence-summary-work.ts:219-287`) emits
   event + snapshot + directory WS_OUTBOX rows and one
   `RTC_TOPOLOGY_RECOMPUTE` APP_OUTBOX entry via the legacy
   `computeRtcTopologyEntry` overload whose identity is
   `deriveRtcTopologyEntryResourceId` — per `commandId` + causal tuple
   (`services/rtc-topology-outbox-entry.ts:210-222`). No two entries ever
   coalesce.
4. **Every recompute publishes, even for identical graphs.** The work
   handler (`topology/replay/create-rtc-topology-work-handler.ts:182-197`)
   builds a publication whenever `work.publish` is true — before and
   regardless of the planner's own `changed` result
   (`planRallarRtcTopologySnapshot`,
   `services/rallar-rtc-topology-service.ts:105-137`, which already
   computes `changed` and even returns the previous snapshot object when
   the graph is identical). `decideTopologySnapshot` then observes
   `'advanced'`/`'duplicate'`, but the publication is already built and is
   written and delivered either way.
5. **Client principal snapshots are stamped world-scope.**
   `toStateSyncEntry` (`state-sync-publisher.ts:230-233`) writes
   `{mode: 'broadcast', scope: 'world'}` for principal audiences. Delivery
   re-derives the audience per process by payload sniffing
   (`state-sync-routing.ts:39`, `ws-server-target-resolver.ts:95-104`);
   an unrecognized payload typeId falls through to _every open connection
   on the process_.

The coalescing infrastructure already exists and is proven on the RTT lane:
`CoalescedAppOutboxWorkService` (generation-CAS `write(transaction,
computed)`, due-time scheduling, successor identities;
`services/CoalescedAppOutboxWorkService.ts`) and the topology work codec
already accepts coalesced `group-revision` envelopes
(`topology/replay/rtc-topology-work-codec.ts:145,191`) with the coalescing
generation folded into the execution id (`toRtcTopologyExecutionId`).
Phase 2 wires the storm path onto that machinery and adds the two gates.

## Decisions

### Decision 1 — flag surface: one server damping mode, default `damped`

`RALLAR_GROUP_FORMATION_DAMPING` ∈ `['damped', 'legacy']`, default
`'damped'`, parsed in a new `apps/api-v1/src/services/`
`group-formation-damping-config.ts` following the exact
`rtc-topology-replay-config.ts` convention (mode const, typed union,
throw-on-invalid reader, startup log line from `main.ts`). The mode is
threaded explicitly (constructor/options/facts — no module state) into the
group mutation facts, `GroupPresenceSummaryWork`, the topology work
handler, snapshot assembly, and the state-sync publisher/resolver.
`legacy` retains today's engine wholesale (per-command topology entries,
heartbeat-driven expansions, publish-on-advanced, world-scope stamps).
Rationale: matches the server-side flag convention the repo already uses
(`RALLAR_RTC_TOPOLOGY_REPLAY`, `RALLAR_API_QUEUE_WORKERS`) and mirrors
Phase 1's default-on-with-legacy-rollback posture (`groupFormationMode:
'bounded-bootstrap' | 'legacy-star'`). Default-on means every existing
suite exercises the damped path; targeted unit tests pin the legacy path.

The debounce is config, not flag:
`RALLAR_RTC_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS` → new
`topologyRecomputeDebounceMs` option beside `rttRebuildDebounceMs`
(default **500 ms**, non-negative, 0 = due immediately), parsed in
`apps/api-v1/src/services/rtc-topology-config.ts` and defaulted in
`rallar-rtc-topology-service.ts`. Both env vars get documented in
`docs/environment-variables.md` (the existing `RALLAR_RTC_TOPOLOGY_*`
family is undocumented there today; this change documents the new ones and
backfills the family).

### Decision 2 — M1 identity: one coalesced work item per group

The presence-summary expansion stops writing per-command topology entries.
Under `damped`, `GroupPresenceSummaryWork` routes the topology intent
through `CoalescedAppOutboxWorkService.write(transaction, computed)` with:

- **Key**: same topic (`app-outbox.rtc-topology`) and context (group
  storage key); `resourceId = ${overlayId}:group-revision` — constant per
  group. (The RTT lane already owns `resourceId = ${overlayId}`; the
  suffix keeps the two lanes' queue identities disjoint.)
- **Envelope**: the existing `RtcTopologyGroupRevisionWork` shape plus the
  coalescing metadata field the codec already accepts. Merge keeps the
  max-`sourceGroupStateRevision` snapshot (same selection rule as
  `mergeRtcTopologyRttWork`), unions reasons, and slides
  `dueAtEpochMs = max(previous, now + debounceMs)` — the same sliding-due
  semantics the RTT merge uses. Starvation is bounded because under M4
  only transitions enqueue.
- **Read/compute/write discipline**: the expansion's `read` phase
  additionally reads the current coalesced entry via the outbox reader
  (new explicit `outboxQueueReader` dependency wired at
  `apps/api-v1/src/middleware.ts:276`, where it is already in scope);
  `compute` builds `{expectedEntry, entry, successorEntry}` purely;
  `write(transaction, computed)` performs the generation-CAS inside the
  expansion's existing transaction. A reserved/raced predecessor falls to
  the successor identity `${overlayId}:group-revision:r${revision}` —
  insert-if-absent, deterministic, self-coalescing. AppInbox doctrine is
  untouched: the service write still receives the transaction and never
  opens or retries one; conflicts stay typed values.

Out of M1 scope (unchanged trigger sites, all rare/operator-driven): the
explicit reconfigure path (`group-topology-management-service.ts:543`,
resource `:explicit`), topology config mutations (`:1096`), RTT recompute
intents (`rtc-rtt-mutation-service.ts:101`), and the scalar-recompute
migration worker (`init-api-rtc-topology-scalar-recompute-worker.ts`).

### Decision 3 — M3 gates discriminate on the coalesced envelope

Both gates run in `computeAcceptedRtcTopologyWork`
(`create-rtc-topology-work-handler.ts`) and apply **only** to work that
carries the coalescing metadata field with kind `group-revision` and an
empty canonical request patch — i.e. exactly the storm path M1 creates.
Explicit reconfigure, config-mutation, RTT-refresh, and migration work
keep today's semantics, which preserves the medium-scale gate's
`assertFinalTopologyEffectsConverged` /
`assertPublishedTopologyEffectsMatchReceipts` behavior (those assert
explicit-reconfigure publications).

- **Input fingerprint (skip rebuilds).** A pure
  `computeRtcTopologyInputFingerprint` hashes the canonical topology
  input: sorted active session ids from the group snapshot, the resolved
  effective config projection (topology kind selection inputs, degree
  limit, tree/mesh thresholds, mesh K), and the group display name (it
  participates in the planner's `changed`). SHA-256 over canonical JSON —
  the same deterministic-fingerprint idea the activation design defines
  for `group_batch` (`topologyInputHash`). The fingerprint of the inputs
  that produced the committed snapshot is stored in a new runtime-state
  entry beside the overlay snapshot, written in the same
  `writeTopologyMutation` transaction by **every** accepting path (so
  explicit/RTT rebuilds refresh it), and read in the execution read.
  Fingerprint equal + stored snapshot `active` → finish the entry
  completed with no plan, no snapshot write, no publication; count a new
  `topologyRebuildSkippedFingerprintCount` metric. Absent or mismatched
  fingerprint fails open into a normal rebuild — a stale fingerprint can
  only cause an extra rebuild, never a wrong skip.
- **Publication gated on `changed`.** The publication is built only when
  the plan result's `changed` is true or no durable snapshot exists.
  Unchanged plans finish without a snapshot write or publication and
  record `recordTopologyPublishResult(false)` →
  `topologyPublishSkippedUnchangedCount` finally moves off zero. Late
  joiners are covered because their own presence connect is a transition
  that changes the input fingerprint and the planned graph; reconnecting
  sessions are covered by the durable topology replay/hydration lane
  (PRs #143/#146/#148), which replays the last publication.

### Decision 4 — M4 heartbeat separation: the audit and the dual-plane cut

**Audit of every consumer of heartbeat-advanced `presenceRevision` and
heartbeat-refreshed lease fields** (the risk the program plan flags):

| # | Consumer                                                                      | Site                                                                                                                                                                               | Today                                                                                                                                                                                                                                             | Under damped M4                                                                                                                                                                                                                                                            |
| - | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Summary content comparison                                                    | `compute-group-presence-summary.ts:84` (`summaryContent` includes full sessions)                                                                                                   | every heartbeat → content change → `presenceRevision+1` → broadcast + recompute                                                                                                                                                                   | lease fields excluded from the comparison; renewals compare equal (see cut below)                                                                                                                                                                                          |
| 2 | Snapshot assembly session values                                              | `assemble-group-state-snapshot.ts:110` (`readActiveSessions`)                                                                                                                      | snapshot sessions are the **summary-frozen** copies; authoritative rows only filter (identity, generation, disconnect, expiry)                                                                                                                    | frozen lease values would lapse ~TTL (browser default 120 s, `DEFAULT_STATE_HEARTBEAT_TTL_MSECS`) after the last transition → assembly must override `lastHeartbeatAtEpochMs`/`expiresAtEpochMs` from the authoritative row                                                |
| 3 | Room-send authorization                                                       | `group-policy.ts:397-407` (`canSendRoomMessage` requires `isLiveSession(snapshot session, now)`)                                                                                   | kept live by the heartbeat→summary rewrite                                                                                                                                                                                                        | **breaks without #2** (idle groups would deny sends after TTL); fixed by #2                                                                                                                                                                                                |
| 4 | Read-through cache freshness                                                  | `group-state-snapshot-read-through-cache.ts:162` → `isGroupSnapshotPresenceFresh` (`snapshot-presence.ts:35`: every session lease in the future)                                   | kept fresh the same way                                                                                                                                                                                                                           | **breaks without #2** (`findOrLoad` would return `undefined` for idle-but-alive groups — WS authorization and topology reads fail); fixed by #2, cache TTL 60 s re-loads fresh values                                                                                      |
| 5 | Equal-tuple content equality                                                  | `shared/repository/group-state-snapshot-revision.ts:32` (`jsonEquals`); server carve-out `isTuplePreservingGroupLivenessReduction` (`group-topology-management-service.ts:1247`)   | content per tuple is deterministic **except** read-time expiry filtering (a pre-existing, storm-masked GET-vs-broadcast conflict window)                                                                                                          | with #2, same-tuple assemblies legitimately differ in lease values → the shared decide treats lease fields as liveness, not content, and adopts the tuple-preserving liveness-reduction carve-out (predicate moves to the shared layer; the management service imports it) |
| 6 | `minSnapshotVersion` freshness gates                                          | `ws-topic-room-authorizer.ts:56-83`, `ws-topic-router.ts:715,762-765`, read-through caches (`minSnapshotVersion`/`minCausalRevision`/`minStateRevision`), `canSendRoomMessage:383` | all compare `group.snapshotVersion` (groupRevision) or a receipt-derived tuple; heartbeat receipts already return the **pre-expansion** revision (`group-mutation-result.ts:83-84` reads the stored summary; the `+1` never appears in a receipt) | **no consumer waits on a heartbeat-driven bump — no change needed**                                                                                                                                                                                                        |
| 7 | Overlay causal tuples                                                         | `sourceGroupStateCausalRevision` ordering (Phase 1 admission, stale-publication guard, replay decisions)                                                                           | strictly monotonic                                                                                                                                                                                                                                | still strictly monotonic — transitions bump the tuple; unchanged graphs are not republished at all                                                                                                                                                                         |
| 8 | Presence-expiry machinery                                                     | sweeper `enqueueExpiredPresenceSessions` (rows), TTL, generation fencing                                                                                                           | reads **authoritative rows**, which heartbeats keep updating                                                                                                                                                                                      | unchanged, by design; the sweeper's expiry-disconnect remains the sole offline-transition authority and bumps the tuple when it fires                                                                                                                                      |
| 9 | Client plane (`rallar.people` `lastSeenAtEpochMs`, client snapshot freshness) | client sessions/snapshots                                                                                                                                                          | separate mutation family                                                                                                                                                                                                                          | out of Phase 2 scope: client heartbeats are untouched (the formation recipes drive only group-presence heartbeats; idle-tier targets do not require client-plane separation)                                                                                               |

**Recommendation (recorded per the program plan's risk #1): adopt the
dual-plane transition now, with no revision-advancing shim.** Concretely:

- (a) **Mutation-level gate**: `computeHeartbeatPresence` classifies a
  heartbeat as a _pure lease renewal_ when the stored summary lists the
  session (`read.presenceSummary.activeSessionIds` contains it) **and**
  the existing row was still unexpired at read time
  (`expiresAtEpochMs > now`). Pure renewals still write the session row,
  the durable event, and the receipt — but emit **no** presence-summary
  work (`outboxEntries: []`, mirrored in the receipt's `outboxIds` and in
  the deterministic write validator). Anything not provably pure —
  including a lapsed-lease revival, which is an offline→online transition
  — emits summary work as today.
- (b) **Snapshots carry the liveness plane without revision movement**:
  assembly overrides the two lease fields from the authoritative row
  (audit #2), keeping authorization, cache freshness, and
  `isGroupSnapshotSessionLive` truthful between transitions.
- (c) **Lease fields become non-content**: the summary content comparison
  (audit #1) and the shared equal-tuple snapshot equality (audit #5)
  exclude `lastHeartbeatAtEpochMs`/`expiresAtEpochMs`; the equal-tuple
  liveness-reduction carve-out moves into the shared decide, which also
  closes the pre-existing storm-masked conflict window.
- (d) **Revisions advance on transition events only** — join/leave,
  connect/disconnect, admission changes, expiry-disconnects from the
  unchanged sweeper. Because audit #6 found no consumer that requires
  heartbeat-driven advancement, no dual-write compatibility period is
  needed; `legacy` mode retains the old engine wholesale for rollback.

### Decision 5 — audience fix: honest scope + co-group narrowing, flagged

`toStateSyncEntry` stops stamping principal-audience rows as
world-broadcast. An additive `'principal'` member joins the broadcast
scope union in `ALTargets` (`packages/shared/al-contracts/al-contract.ts:31-50`),
carried with the aggregate's principal identity; persistence validation
accepts it; `newALBroadcastMessage` semantics for existing scopes are
unchanged (no public API break — additive union member, server-resolved).
The server resolver maps `scope: 'principal'` to: the principal's own live
sessions ∪ live sessions of groups where the principal is an active
member — resolved at delivery time per the after-commit dynamic-audience
doctrine — and **never** falls through to all open connections
(the `'world'` fallback blast radius flagged in
`ws-server-target-resolver.ts:47-58` does not apply to the new scope).
Legacy `'world'` rows (old producers, in-flight rows) resolve exactly as
today.

Deliberate tradeoff, recorded: today every live session in the
(application, workspace) scope receives every principal's client snapshot
(`state-sync-routing.ts:112-131`), and the browser people directory
(`rallar-runtime/state-store.ts:99-109`, `rallar-people-facade.ts`)
depends on receiving _other_ principals' snapshots. Narrowing to co-group
sessions preserves the directory for the peers that share a group with the
observer (the realtime-relevant set) while stopping workspace-wide
strangers from receiving each other's client state. In every black-box
recipe all clients share one group, so recipe-visible behavior is
identical. Under `legacy` the world stamp and workspace fanout are
retained bit-for-bit.

### Decision 6 — single draft PR (review-pressure record)

Estimated footprint: ~25 production modules across `packages/shared`,
`packages/shared-server`, `apps/api-v1`, plus tests and docs — under the
100-file / 10,000-line / 20-production-module thresholds is _not_ certain
(module count may cross 20), so the written decision is recorded here:
**one PR**. The four mechanisms form one invariant ("a heartbeat is not a
topology event; an unchanged topology is not a publication") verified by
one measurement harness; the flag couples them operationally; and the
tier reruns validate them only in combination. The PR body carries a
read-first map ordered by entry owners (mutation compute → expansion →
work handler → resolver) per the large-PR rule.

## Scope (implementation slices)

Each slice lands with its unit/service tests; focused validation runs per
slice, tier + gate validation at the end.

1. **Config + flag plumbing** — damping-mode config file (api-v1), the
   `topologyRecomputeDebounceMs` option + env parsing, startup log,
   `docs/environment-variables.md` rows, threading into the composition
   roots (`create-rallar-server.ts`, `middleware.ts`).
2. **M1 coalesced recompute** — `GroupPresenceSummaryWork` read/compute/
   write changes, per-group identity + successor identity, merge function
   beside the RTT merge, wiring of the outbox reader dependency; tests
   for merge selection, generation CAS, reserved→successor, debounce due
   scheduling, and legacy-mode per-command retention.
3. **M3 gates** — fingerprint helper + storage read/write in the
   execution repository transaction, both gates in
   `computeAcceptedRtcTopologyWork`, `topologyRebuildSkippedFingerprintCount`
   metric, `recordTopologyPublishResult(false)` on unchanged; tests for
   skip/fail-open/changed-gate/exemption-of-explicit-and-RTT work.
4. **M4 heartbeat separation** — pure-renewal gate in
   `computeHeartbeatPresence` + write-result/receipt/validator mirroring;
   lease exclusion in `summaryContent` + validator; assembly lease
   override (`sessionLeaseFields: 'summary-frozen' | 'authoritative'`
   required input, all call sites updated); shared lease-insensitive
   equal-tuple equality + liveness-reduction carve-out relocation; tests
   for renewal-vs-transition classification (incl. lapsed-lease revival),
   equal-tuple decisions, authorization and cache freshness on idle
   groups, sweeper interplay.
5. **Audience fix** — `ALTargets` `'principal'` scope + validation,
   publisher stamp under damped, resolver branch + co-group resolution,
   no-fallback guarantee; tests for scope resolution (own sessions,
   co-group sessions, no-blast on unknown typeId), legacy compatibility.
6. **Validation + results** — tier reruns (memory, postgres,
   formation-large), medium-scale gate, state-write perf comparison
   (fresh DB per side), results document beside the baselines, final
   completion gates.

Recipes: no step or assertion changes are expected — the formation-burst
recipes capture whole metrics objects (new counters appear automatically)
and assert liveness only; convergence polls (4 × 1 s + 5 s `ws.wait`)
comfortably cover the 500 ms debounce. If any capture path proves
incompatible, the recipe change ships in the same slice that caused it.

Recorded delta (implementation): one cluster recipe,
`api-v1-rtc-topology-convergence`, asserted a topology publication per
concurrent group revision. A role promotion plus a metadata update leave the
topology-input fingerprint unchanged, so the damped server correctly plans
nothing; the recipe now observes cross-server convergence of both revisions
on the state plane (both `group-state.snapshot` broadcasts on both servers),
which damping preserves per transition. The medium-scale gate's recipe files
are untouched. Details in the phase-2 results document.

Recorded delta (implementation): the deterministic durable-topology replay
proof (`api-v1-topology-replay-gate.yml` and the same step inside
`release-gate.yml`) pins the legacy per-command publication contract: its
drivers are description and member-role mutations, and it asserts exactly one
durable publisher append per mutation plus a per-command publication message
id and a presence-revision bump per expansion. The damped default
intentionally eliminates all three for non-topology-affecting mutations, so
both proof steps now run with `RALLAR_GROUP_FORMATION_DAMPING: legacy` — the
retained path they were authored against; the durable replay machinery itself
(streams, cursors, hydration) is unchanged by this phase. Adapting the proof
to the damped contract (fingerprint-affecting drivers, revision-exact
correlation) is a recorded follow-up issue.

Recorded delta (implementation): coalesced work generations must preserve the
original persisted-message creation and expiry identity, because queue rows
never rewrite their created-audit columns and the release-idempotency
predicate proves handler finalization through the canonical work contract.
The first M1 cut stamped each generation with the latest request time, which
wedged the APP_OUTBOX worker in lost-reservation retry loops from generation
2 onward (caught post-gate by the full-stack WS quick test; fixed in the
compute builder, the coalesced service merge path, and with a revival-aware
release-idempotency arm; details in the phase-2 results document).

Recorded delta (implementation): the branch-CI changed-style gate rejects
worsened file-length and layout findings, so the damping additions that had
grown pre-existing large files were extracted into feature modules instead:
`state-sync/state-sync-payload.ts` and `state-sync/validate-state-sync.ts`
(from the publisher/routing pair), `topology/rallar-rtc-topology-metrics.ts`
(from the topology service), `topology/replay/finish-rtc-topology-work.ts`
(from the work handler), `postgres/resource-inbox/resource-inbox-finished-replacement.ts`
(the terminal-revival CAS as a standalone function; `ResourceInboxRepository`
is byte-identical to main), and the coalesced group-revision work module now
lives in `topology/replay/` beside its consumer and owns
`isChangeGatedGroupRevisionWork` plus `DEFAULT_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS`.
Structural-lineage manifests in
`plans/repo-style-lineages/group-formation-phase2-server-damping.json` map
the extractions for the changed-style checker.

Out of scope (later phases per the program plan): delta dissemination and
read-through (Phase 3), join admission control (Phase 3), incremental
planning/hysteresis (Phase 4), RTT threshold refinement (Phase 4, M8),
formation epochs (Phase 5), client-plane heartbeat separation (audit #9 —
follow-up issue if idle client-plane rows matter operationally),
`orderingKey` dequeue honoring (Phase 6).

## Validation matrix

Targets (from the program plan and the Phase 2 task):

- **Idle steady state (T2−T1, per minute), every tier**: expansions ≈ 0,
  recomputes triggered/executed/published ≈ 0, presence-summary WS rows ≈
  0, deliveries ≈ 0 (vs 20,000/min at N=50 today). Group mutations remain
  2N (heartbeats still write leases).
- **Burst window (T1−T0)**: recomputes executed/published in the low
  single digits per server (vs ≈ N today);
  `topologyPublishSkippedUnchangedCount > 0` over the run; every join
  succeeds; full membership visible (`memberCount == N+1`,
  `onlineMemberCount == N`); every client receives ≥ 1 `overlay.topology`
  (existing hard assertions unchanged).
- **No liveness regressions**: room sends authorized on idle groups
  (audit #3), read-through caches serve idle groups (audit #4).

Commands (fresh DB per the established procedure for every postgres run:
`docker compose down -v && npm run db:up && DATABASE_URL=… npm run
db:migrate`; queue tables truncated before capture runs, matching the
baseline methodology):

- `npm run test:api-v1:black-box:memory` (13 recipes incl. small+medium
  tiers)
- `npm run test:api-v1:black-box:postgres` (13 + 5 cluster)
- `npm run test:api-v1:black-box:postgres:formation-large` (N=50)
- `npm run test:api-v1:black-box:postgres:medium-scale` — constants,
  operation matrix, and assertions untouched (this plan changes none of
  its recipe files; Decision 3 keeps explicit-reconfigure publication
  semantics it asserts)
- State-write perf comparison gate: `npm run perf:api-v1:state-write`
  baseline on `main`@`1e5f5e55` and candidate on this branch (each
  against a freshly migrated database), then
  `node scripts/perf/compare-api-v1-state-write-results.mjs baseline
  candidate`. Expected direction: heartbeat-heavy workloads write fewer
  outbox rows; any waiver follows the comparator's waiver contract.
- Focused suites: `packages/tests/shared-server` (presence summary,
  coalesced work, topology handler, policy), `packages/tests/shared`
  (al-contracts, repository decides), api-v1 `deno task check` + group
  state route tests, `npx vitest run
  packages/tests/rallar-black-box-headless/` +
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  (shared bundle ratchets), `npm run check:repo-style:changed -- origin/main HEAD`.
- Completion gates: final tree passes `npm run test:unit`,
  `npm run test:ci`, `npm run build`; **Branch Release Gate** green on the
  final feature-branch commit; **Run Hetzner Supported Distributed
  Manifests** green on the resulting default-branch commit (recorded by
  exact SHA).

Results document: committed beside the baselines as
`playground/rtc-design/baselines/<date>-phase2-server-damping-results.md`
with the same tier × backend tables, reading rules, and provenance.

## Risks and mitigations

1. **Lease-aware equality misses a comparison site.** Mitigation: the
   change lands in the single shared decide all stores use
   (`group-state-snapshots-repository.ts:232` is its only caller) plus
   the one server carve-out site; a grep-audit for `jsonEquals` over
   `GroupSnapshot` is part of slice 4 review.
2. **Coalesced entry starvation under sustained churn** (sliding due).
   Bounded: only transitions enqueue under M4; a stuck-reserved
   predecessor falls to the successor identity. Watched via queue-depth
   captures in the tier reruns.
3. **Fingerprint skip hides a needed rebuild.** The gate fails open on
   absent/mismatched fingerprints, applies only to empty-patch coalesced
   work, and every accepting path refreshes the stored fingerprint in the
   same transaction. Wrong-skip would require a fingerprint collision on
   different canonical inputs (SHA-256).
4. **Mixed-version window during rollout** (old browser bundles with
   strict `jsonEquals` vs new servers emitting lease-fresh snapshots at
   an unmoved tuple). Exposure is transient and self-heals on the next
   transition ('advanced' replaces the entry); the same window exists
   today via read-time expiry filtering. Rollback: `legacy` mode.
5. **Medium-scale/perf gate sensitivity to changed outbox counts.**
   Heartbeat receipts legitimately report `outboxIds: []` under damped;
   the medium-scale recipe asserts outbox ids only on topology-config
   receipts (unchanged paths). The perf comparator sees fewer SQL
   statements on heartbeat paths — an improvement, not a waiverable
   regression.

## Draft Pull Request Record

Maintained in the PR body from the first checkpoint: written-plan link,
milestone checklist mirroring the six slices, current behavior +
incomplete areas, exact passed/failed/skipped validation, follow-up
issues, default-branch base (`1e5f5e55`) and latest revalidation outcome,
and the Decision 6 single-PR record with the read-first map.
