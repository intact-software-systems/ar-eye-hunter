# Rallar Group Formation Phase 3: Delta Dissemination + Read-Through (M2, M12, M13)

Status: active adaptive plan. Base: `main` at `124e0992` (recorded for plan
revalidation; the tree moved well past PR #152 — topology owners were
restructured by #198/#209 — so every surface reference below was re-audited
on this base, not carried from the phase-2 plan).

Phase 3 of
[the group formation implementation plan](../playground/rtc-design/2026-08-08-group-formation-implementation-plan.md):
burst dissemination cost drops from O(N^3) toward O(N^2) egress bytes, late
joiners and reconnects self-heal, and joins stop false-failing. Prior
evidence:
[Phase 0 formation-burst baseline](../playground/rtc-design/baselines/2026-08-08-formation-burst-baseline.md),
[Phase 1 overlay-precedence results](../playground/rtc-design/baselines/2026-08-09-phase1-overlay-precedence-results.md),
and the primary comparison reference
[Phase 2 server-damping results](../playground/rtc-design/baselines/2026-08-11-phase2-server-damping-results.md)
(burst deliveries at N=50 reduced 8,467 → 4,934 but each transition still
fans a full snapshot to the room — the explicitly named Phase 3 target; the
headline metric, egress bytes, has **no counter today**).

## Current-shape audit (base `124e0992`, file-level)

### The per-change emission chain (server)

One site emits every per-change group-state WS row.
`computeGroupPresenceSummaryOutboxEntries`
(`packages/shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts:302-352`)
produces, per presence-summary expansion: one `group-state.event` row (the
durable `GroupEvent`, `payloadKind: 'event'`), and **two full-snapshot rows**
from one `computeGroupStateSyncEntries` call
(`state-sync-publisher.ts:120-147`) — `group-state.snapshot` and
`group-directory.snapshot`, both carrying the same complete `GroupSnapshot`
(members[] + activeSessions[] + counts). Expansions are enqueued by every
group mutation that is not a pure lease renewal
(`group-mutation-result.ts:94-110`), and the entry set is byte-validated by
`validateComputedOutboxEntries`
(`mutation/result-validation/validate-computed-group-mutation-write.ts:311-342`)
— any Phase 3 change to what a mutation or expansion enqueues moves through
that validator.

Facts that bound the M2 design:

- **`group-state.event` exists but carries no delta.** `newGroupEvent`
  (`group-mutation-result.ts:272-289`) stamps `payload: {}`. The event has
  identity, `eventType` (15 kinds), actor, and `causalRevision` — nothing a
  browser could apply to a cached snapshot.
- **Event and snapshot rows for the same command deliberately differ in
  revision.** The event row carries the mutation's
  `acceptedCausalRevision`; the snapshot rows carry the **post-summary**
  `snapshot.causalRevision` (presenceRevision is advanced by the accepted
  summary write, `compute-group-presence-summary.ts:99`).
- **`GroupStateCausalRevision` is a partial order, not a sequence.**
  `compareGroupCausalRevision` (`group-client-views.ts:96-110`) returns
  `equal | dominates | dominated | incomparable`; presenceRevision is
  monotone per group but not gapless across a delivered stream (summary
  no-ops skip the increment; damped lease renewals never advance it). Gap
  detection cannot count sequence numbers.
- **Delivery-audience self-healing rides the snapshot payload.**
  `ws-server-target-resolver.ts:23-45` (landed in PR #152) resolves each
  row's audience from the causally newest of the process cache and the
  row's **own snapshot payload**; `group-state.event` rows have no snapshot
  payload and fall back to cache/global lookup returning `[]` when nothing
  resolves (`state-sync-routing.ts:59-72`). The process cache itself is
  refreshed by the snapshot topics' `onState` handlers
  (`ws-system-topics.ts:157-171`) — the `group-state.event` registration
  has none (`:173`). Removing snapshot rows without a replacement audience
  source silently black-holes event delivery on servers that never served
  a REST read for the group.
- **A revision-floored resync pull already exists.** `GET
  /api/state/apps/:app/workspaces/:ws/groups/:groupId` accepts
  `minGroupRevision` + `minPresenceRevision`
  (`state-snapshot-read-query.ts:33-51`), answers
  `409 state-revision-floor-not-satisfied` when unmet, stamps
  `Rallar-Group-Revision`/`Rallar-Presence-Revision` headers, and
  side-hydrates the server process cache. The gap→pull primitive needs no
  new route.
- **Metrics substrate (Phase 0).** `formation-metrics.ts` records
  per-topic WS sends/recipients via `WsDeliveryDiagnosticsEvent`
  (`packages/shared/services/ws-queue-box-server-contracts.ts:62-80`);
  exposed on `GET /api/admin/operations/realtime`
  (`admin-operations-routes.ts:64`), captured by the formation-burst
  recipes at T0/T1/T2. **No byte accounting exists anywhere on the WS
  egress path.** The natural hook: `sendToTargetsWithResult` encodes once
  (`WsQueueBoxServerService.ts:428-430`) and reports
  `recipientCount`/`sentCount` at `:469-475`; the outbox path sends
  prepared text at `:649-672`.
- **Flag pattern to follow.** `RALLAR_GROUP_FORMATION_DAMPING`
  (`apps/api-v1/src/runtime/group-formation/group-formation-damping-config.ts`)
  parses env into a behavior-carrying discriminated intent, threaded
  explicitly through `middleware.ts:260-313`; documented in
  `docs/environment-variables.md:82`.
- **Dormant legacy candidate.** `createWsStateSyncPublisher`
  (`state-sync-publisher.ts:334-430`) and its only wiring
  (`apps/api-v1/src/services/state-sync-service.ts`) have no production
  caller — flagged for the legacy ledger, disposition decided at the M2
  slice.

### Browser snapshot-consumer audit (the M2 precondition)

Complete inventory of consumers of per-change `group-state.snapshot`
broadcasts (every entry must have a delta-mode or pull replacement before
snapshot-per-change can be dropped):

| # | Consumer | Site | Dependency | Delta-mode disposition |
| --- | --- | --- | --- | --- |
| 1 | Cache write arm | `data-caches.ts:135-151` (single catch-all inbox switch; `group-directory.snapshot` arm `:152-168` is a byte-identical duplicate feeding the same cache) | writes group snapshot cache via revision decide | delta arm writes the same cache through the same decide |
| 2 | Readiness engine | snapshot write → `onGroupStateSnapshotChange` (`data-caches.ts:319-345`) → `notifyStateCacheChange` → `onStateCacheChange` | `waitForPresence` (`rooms/room-presence.ts:52-141`), room state store, RTC room readiness (`rallar-runtime/realtime.ts:811-826`) re-evaluate only on cache change | preserved automatically iff deltas produce cache writes |
| 3 | Bootstrap overlay restamping + RTC group sync | same observer → `acceptGroupSnapshotUpdate` (`group-snapshot-rtc-sync.ts:41-67`) | `createAndSetBootstrapOverlays` + `webRtcGroupManager.acceptGroupUpdate` | preserved iff deltas produce cache writes |
| 4 | Heartbeat target selection | `heartbeat.ts:104-111` reads `getAllGroupStateSnapshots()` | groups absent from cache stop heartbeating | preserved iff cache entries stay fresh (60 s TTL, `browser-cache-repositories.ts:8-20`; heartbeat itself refreshes full snapshots every 20 s, `heartbeat.ts:99-148`) |
| 5 | Server delivery-audience resolution | `ws-server-target-resolver.ts:23-45` + process cache refresh (`ws-system-topics.ts:157-171`) | snapshot payload is the self-healing audience source | delta rows must carry a persisted immutable computed audience (doctrine-blessed) — see D2 |
| 6 | `rooms.onEvent` user events | `state-events.ts:196-238` → `room-events.ts:159-176` | consumes `group-state.event` (dedupe by eventId, no cache writes) | unaffected; delta envelope must keep the `GroupEvent` shape it validates |
| 7 | Black-box recipes waiting on snapshot broadcasts | exactly two (repo-exhaustive): `api-v1-cross-application-ws-isolation.json:461-538` (ws.wait on `group-state.snapshot` frames + a negative cross-scope wait; memory + postgres profiles) and `api-v1-rtc-topology-convergence.json:622-690` (waits on both revision snapshots on two servers and asserts on snapshot **payload contents**; cluster profile). No recipe references `group-state.event`. | ws.wait steps on `group-state.snapshot` | dual-emit keeps both green; `delta-primary` tier runs need delta-mode recipe variants, including a delta-mode cross-scope isolation negative |
| 8 | Tests pinning "events are ignored" | `data-caches.test.ts:383,794` | encode the current snapshot-primary contract | rewritten with the delta arm |
| 9 | Server RTT group-resolution fallback | `topology/rtt/init-rtc-rtt-topic.ts:130` (`findGroupStateSnapshotsBySessionIds`) | reads the server process cache the snapshot topics' `onState` handlers refresh | M2 must keep server process caches truthful under delta-primary: a delta `onState` apply, post-commit observation on the mutating server, or a verified durable fallback (initial-review finding 4) |
| 10 | Shared-graph group creation | `packages/shared-graph/group-graphs-create-service.ts:40` | same server process cache | same disposition as #9 |

Additional discovered coupling: PR #152's equal-tuple decide
(`group-state-snapshot-revision.ts:35-41`) treats lease-insensitive-equal
or liveness-reduction pairs as `duplicate` and **throws** on any other
equal-tuple divergence — so a browser-materialized delta snapshot must
reproduce the server's canonical assembly byte-for-byte (member ordering
is canonical storage-key order per the convergent doctrine) or dual-emit
will throw `StateSnapshotRevisionConflictError` on the trailing snapshot.
This is deliberately kept: dual-emit doubles as a live divergence oracle.

There is **no gap detection today**: `dominates` accepts any forward jump;
only `incomparable` escalates (full-collection reread,
`state-cache-snapshot-adoption.ts:19-58`). The unused
`minCausalRevision` option on the point read
(`state-read/point-read.ts:98-132`) is the ready-made floored-pull hook.

### Overlay read-through shapes (M12)

- `readStateGroupTopology` (`api-integration.ts:798-810`) calls `GET
  .../groups/:groupId/topology` (`graph-topology-routes.ts:136`), returns
  `GroupTopologyManagementView` — **zero production callers** (verified).
- Adoption path with identical precedence: `toOverlayInfoForSession`
  (stamps `provenance: 'server'`) →
  `overlaysRepository.setCurrentServerOverlayById` (the fresh-durable-read
  entry that force-adopts over incomparable server overlays,
  `overlays-repository.ts:276-299`) → `waitForOverlayChangesIdle` →
  `webRtcGroupManager.notifyOverlayTopologyChanged()`. Today that block
  lives inline in the `overlay.topology` switch arm
  (`data-caches.ts:200-229`) and must be extracted for REST reuse.
- **Discovered overlap:** PR #148 already added a server-push hydrator on
  every WS connection (`topology/replay/rtc-topology-reconnect-hydrator.ts`,
  unicast generation-fenced `rtc-topology-hydration` messages). M12's
  browser-pull is the anti-entropy complement: it works when the replay
  lane is disabled, covers the push race on late joins, and is the
  deterministic recipe-testable path. Recorded as a compatibility fact,
  not a conflict.
- Browser reconnect today does nothing state-related: the socket layer's
  `onOpen` hook is an explicit empty TODO
  (`WsQueueBoxClientService.ts:331-333`); state convergence after
  reconnect rides the 20 s heartbeat poll. The runtime lifecycle
  (`rallar-runtime/lifecycle.ts`, ws `'connected'` emit at
  `rallar-runtime/ws.ts:257-280`) is the browser-side reconnect signal to
  hook.

### Issues #156 and #159 interaction

- **#156 (open):** the durable topology replay proof (standalone workflow
  + release-gate step) runs pinned to `RALLAR_GROUP_FORMATION_DAMPING:
  legacy` and correlates on **topology publication** message ids. Phase 3
  changes group-state row emission, not the damping flag or topology
  publication identity; the proof's drivers (description/member-role
  mutations) also do not depend on `group-state.snapshot` rows. Phase 3
  therefore neither fixes nor further pins #156; the new dissemination
  flag must leave the `legacy` damping mode's emission exactly as today so
  the pinned proof keeps its contract. Any M2 flag interaction with the
  proof workflows is re-checked at the M2 slice.
- **#159 (closed):** the churn-read race (single-attempt final read vs
  async presence-summary freshness) was fixed by giving shared-group final
  reads convergence-floor treatment. M12's read-through and M2's pulls
  must use the same floored-read discipline (revision floors, bounded
  retries) rather than single-attempt reads — the same class of race
  otherwise reappears in the late-joiner and reconnect recipes.

## Decisions

### D1 — flag surface: one server dissemination mode, default `dual-emit`

`RALLAR_GROUP_STATE_DISSEMINATION` ∈ `['snapshot-per-change', 'dual-emit',
'delta-primary']`, parsed in
`apps/api-v1/src/runtime/group-formation/group-state-dissemination-config.ts`
following the exact damping-config convention (typed union, default,
throw-on-invalid startup reader, startup log line, row in
`docs/environment-variables.md`), threaded as a behavior-carrying intent
into `GroupPresenceSummaryWork` beside the existing `topologyIntent`.

- `snapshot-per-change` — today's engine wholesale (event row with empty
  payload + two full-snapshot rows). Retained legacy/rollback path.
- `dual-emit` — **default for this phase.** The event row gains the delta
  envelope and computed audience; both snapshot rows still emitted.
  Browsers consume deltas as primary and snapshots as the trailing
  divergence oracle (equal-tuple decide throws on any reconstruction
  divergence). Every existing recipe and the #156-pinned proof stay green.
- `delta-primary` — the event row (delta envelope) is emitted; **both**
  per-change full-snapshot rows (`group-state.snapshot` and
  `group-directory.snapshot`) are dropped. Full snapshots serve join,
  resync, and causal-gap pulls only. This mode produces the headline
  egress numbers and is exercised by dedicated recipe runs; the default
  flips only when a later checkpoint earns it with tier evidence.
  (Directory-row disposition settled by the measured baseline: the
  directory row carries the identical full snapshot and costs the same —
  123.3 MB of the 255.0 MB N=50 burst vs 121.6 MB for
  `group-state.snapshot` — so dropping only the state row caps the total
  reduction at ~2×. The browser's directory arm feeds the same cache as
  the state arm, so the delta path replaces both; directory freshness for
  non-members comes from list/join pulls.)

The `RALLAR_GROUP_FORMATION_DAMPING=legacy` mode bypasses the new flag
entirely (legacy damping implies snapshot-per-change), preserving #156's
pinned proof contract bit-for-bit.

### D2 — M2 delta contract: chained-revision envelope with persisted audience

The `group-state.event` WS row's payload becomes a typed delta envelope
(the durable event log and `GroupEvent` shape are untouched — the envelope
wraps the event at expansion time, where the post-summary snapshot is in
hand):

- `event` — the existing `GroupEvent` (so `rooms.onEvent` validation is
  unchanged).
- `predecessorCausalRevision` — the exact summary predecessor the
  expansion CASed against.
- `resultingCausalRevision` — the post-summary `snapshot.causalRevision`
  (what the trailing snapshot rows carry).
- `delta` — the resulting state sufficient for deterministic
  reapplication: the resulting member record and/or session record (or
  removal markers) for the affected slice, the resulting group aggregate
  fields, resulting `memberCount`/`onlineMemberCount`, **and the complete
  resulting `activeSessions` identity set** (session ids). The identity
  set is required, not optional: snapshot assembly TTL-filters
  `activeSessions` against authoritative rows at expansion time, so a
  summary transition can silently drop sessions beyond the mutation's own
  slice; a delta carrying only the affected slice would materialize a
  snapshot whose counts and session set disagree, and the shared
  equal-tuple decide (`hasConsistentGroupOnlineMemberCount` on both sides
  of the liveness-reduction arm) would throw on healthy operation
  (initial-review finding 2).
- No-op expansions: `compute()` emits rows regardless of
  `summary.outcome`; a summary no-op has no CAS predecessor, so its
  envelope stamps `predecessorCausalRevision === resultingCausalRevision`
  and browsers must evaluate the equals-resulting no-op rule **before**
  the equals-predecessor apply rule.

Browser application rule (the causal-gap/resync contract, recorded as the
plan's core judgment):

1. cached snapshot revision `equal` to `predecessorCausalRevision` →
   apply delta, write the materialized snapshot through the existing
   revision decide (canonical member order = the server's storage-key
   order, mirrored via a shared pure helper so reconstruction is
   byte-stable).
2. cached `dominates` predecessor (or equals resulting) → typed no-op
   (stale/duplicate delta).
3. anything else — cached `dominated`-but-not-equal-predecessor,
   `incomparable`, or no cached snapshot for a group the session belongs
   to → **causal gap**: floored point pull via the existing
   `minCausalRevision` read (`readStateGroupSnapshot`), floor =
   `resultingCausalRevision`, with the incomparable-recovery fallback to
   the full-collection reread that already exists.
4. WS reconnect → resync: point pulls for joined groups + overlay
   read-through (M12), because deltas during the gap are simply lost, not
   queued. The trigger is the socket-level re-open — the ws `'open'`
   lifecycle signal (`rallar-runtime/ws.ts:259-262`) or the
   `WsQueueBoxClientService.ts:331-333` `onOpen` TODO hook — **not** the
   `'connected'` lifecycle, which fires only on session establishment
   (`rallar-runtime/ws.ts:122-124`) and never on a mid-session socket
   re-dial (initial-review finding 3).
5. Divergence oracle channel: a `StateSnapshotRevisionConflictError` from
   a delta- or snapshot-adoption write under dual-emit is caught at the
   adoption boundary and recorded as a countable diagnostics outcome
   (mirroring the overlay adoption diagnostics), never left to escape
   into the inbound runtime's retry loop (initial-review finding 6).

Audience correctness under `delta-primary`: the event row persists an
**immutable computed audience** (the summary's active session ids at write
time) in the outbox message — the convergent doctrine's blessed shape —
intersected with locally open connections at delivery; late joiners are
covered by their join-time snapshot pull, not by event fanout. Under
`dual-emit` the trailing snapshot rows additionally keep the process
caches warm exactly as today.

### D3 — M12 read-through injection: extract-and-reuse the adoption block

Extract the overlay adoption block from the `data-caches.ts` switch arm
into an exported `acceptServerOverlayTopology` (same file ownership), then:

- **Connect:** `refreshStateSnapshots` flow (`middleware.ts:325-338`)
  additionally issues `readStateGroupTopology` for each joined group from
  the freshly accepted collection and routes results through
  `acceptServerOverlayTopology` (null snapshot → no-op). This gives
  `readStateGroupTopology` its first production caller.
- **Reconnect:** a subscriber on the ws `'open'` lifecycle signal (the
  socket-level re-open; see D2 rule 4 — `'connected'` fires only on
  session establishment) re-runs the same joined-group topology pulls
  (plus D2's state resync pulls), guarded by the middleware generation
  fence so a stale reconnect cannot hydrate a newer session's caches.
- Conflict posture: `setCurrentServerOverlayById` is the correct entry (a
  REST read is a fresh durable current-state read); the known equal-tuple
  different-bytes throw from a race with the #148 push hydration is caught
  and recorded as an adoption-diagnostics outcome, not a crash.

### D4 — M13 admission: family-scoped limiting + a default member cap

**Audited route matrix.** Group-state mutation routes are split by domain
under `apps/api-v1/src/group-state/` (composition:
`register-group-state-routes.ts:12-24`): aggregate
(`register-group-state-mutation-routes.ts` — create `:41`, update `:76`,
director-appoint `:112`), admission
(`register-group-admission-routes.ts` — join `:46`, invite-accept `:82`,
join-code-rotate `:118`, invite-create `:154`, invite-revoke `:192`),
membership (`register-group-membership-routes.ts` — remove/ban/unban/
role/owner-transfer/upsert-self `:49-239`), presence
(`register-group-presence-routes.ts` — connect `:45`, heartbeat `:90`,
disconnect `:135`), plus group-scoped topology mutations in
`routes/graph-topology-routes.ts:163-277`. The join route carries no
route-level authorization (policy lives in the compute phase) — the
natural admission insertion point.

**Discovered existing admission layers** (recorded so M13 composes
rather than duplicates):

- A blanket `/api/state/*` sliding-window limiter + circuit breaker
  already exists (`apps/api-v1/src/services/state-api-resilience-middleware.ts`,
  mounted at `main.ts:80`): 300 requests/min per client key (60/min for
  event listing), bare-JSON 429, and a 503-emitting circuit breaker — a
  plausible source of the S1 `unavailable` false failures under storm.
- The repo's limiter primitive is a **sliding-window counter**
  (`RateLimiterPolicy` + `SlidingWindowCounter`,
  `packages/shared/resilience/Resilience.ts:101-206,411-468`;
  factory `packages/shared-server/http/rate-limit-service.ts:40-48`),
  used by `config-route.ts:28-38` (login/register/ws-ticket) and
  `ice-route.ts:9`. "Reuse the limiter pattern from `config-route.ts`"
  therefore means reusing `RateLimiterPolicy`/`RateLimiter` and the
  per-namespace keyed cache — not introducing a parallel token-bucket
  implementation.
- `maxMembers` already exists end-to-end: `Group.maxMembers:
  number | null` (`group-types.ts:59`), enforced by
  `wouldExceedMemberCap` (`group-policy.ts:506-516`) in `canJoinGroup`
  / `canActivateGroupMember` / presence admission, surfacing as the
  typed `group-full` denial (403). Today `null` means uncapped.

**M13 shape:**

- **Join-admission limiter**: family-scoped sliding-window limits on the
  admission family (join, invite-accept, upsert-self member) and presence
  connect, keyed per **group** (shed a pathological storm on one group)
  with a per-principal secondary key, env-configurable policies
  defaulting far above the legitimate N=50 burst rate. Over-limit answers
  are contractual `429` **with a `Retry-After` header** (the existing
  429 sites send bare JSON; the OpenAPI `TooManyRequests` response gains
  the header) — never a 5xx, so clients can distinguish backpressure
  from unavailability.
- **Default member cap**: a configured operational default applied when
  `group.maxMembers === null`, decided inside `wouldExceedMemberCap` from
  typed config threaded to the policy (operational default from
  configuration, not a rewrite of stored aggregates); the existing
  `group-full` typed denial is the rejection surface. Default sized well
  above the validated tier envelope (e.g. 256) so it only bounds
  pathological growth.
- **Async-accept (202 + poll) stays outcome-shaped.** Audited reality:
  api-v1 has no 202 surface today, and `AppGroupInboxService` explicitly
  blocks fire-and-forget for authenticated group mutations
  (`AppGroupInboxService.ts:195-231`). The activation design's ticket
  contract (202 + scoped request-id poll, PR #83) is the recorded shape
  if a later checkpoint shows synchronous joins still false-failing with
  limiting and caps in place; it is not built speculatively.

**429-versus-202 contract judgment (recorded):** admission over-limit is
`429 Retry-After` (retryable-by-contract backpressure); `202 + ticket` is
reserved for the case where the join itself must be accepted-but-deferred,
which the current evidence (50/50 joins succeed at N=50 with retries
unused) does not yet justify.

**Non-vacuous admission proof (initial-review finding 7):** because the
N=50 burst already passes with retries unused, "zero unavailable false
failures" alone would pass without admission ever engaging. The admission
recipe therefore includes a storm probe that drives at least one actual
over-limit response and asserts the `429` + `Retry-After` contract on it,
alongside the burst-with-admission-enabled liveness assertions.

### D5 — egress-bytes metric definition (slice 1, zero behavior change)

`WsDeliveryDiagnosticsEvent` gains a required `payloadBytes` field
(encoded message text length) on the `live-send` and `outbox-send`
variants; `formation-metrics.ts` accumulates
`wsEgressBytesByTopicId[topic] += payloadBytes × sentCount` (live) and
`+= payloadBytes` (outbox), reusing the bounded per-topic map. Surfaces on
the existing `/api/admin/operations/realtime` capture with no recipe step
changes (recipes capture whole metrics objects). Baseline = the
instrumented tree with no behavior flags, behaviorally identical to
`main`.

## Scope: first horizon (at most two concrete slices)

1. **`egress-bytes-instrumentation-and-baseline`** — D5 counters + unit
   tests; tier baseline capture (memory + postgres + formation-large at
   N=6/20/50) recorded as the bytes columns of the Phase 3 results
   document skeleton beside the existing baselines. No behavior change;
   the affected suites are the shared/service and formation-metrics unit
   tests plus the recipe reruns.
2. **`overlay-read-through-on-connect-and-reconnect`** — D3: adoption
   block extraction, connect-time and reconnect-time topology pulls,
   generation fencing; late-joiner and reconnect-resync black-box recipes
   (REST-change rule: recipes ship in the same change); shared-web public
   API snapshot/bundle-boundary updates.

Later mechanisms stay outcome-shaped until a checkpoint earns them (M2
dual-emit envelope → browser delta consumption → delta-primary tier
proofs → M13 admission → results document + completion gates), per the
adaptive horizon rule.

## Validation matrix

- Slice-focused: the touched package suites from
  `rallar-testing/references/test-commands.md`, then
  `npm run check:adaptive-governance` after each slice.
- shared-web surface changes: `shared-web-public-api-snapshots.test.ts`,
  `shared-web-browser-bundle-boundaries.test.ts`,
  `shared-web-browser-entrypoints.test.ts`,
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`,
  plus the headless bundle-boundary test (its budget is known to trip on
  `packages/shared` growth).
- REST/mutation changes: black-box recipes in the same change; the
  unweakened `npm run test:api-v1:black-box:postgres:medium-scale`; the
  state-write perf comparison gate on freshly migrated databases with a
  baseline-vs-baseline control first (issue #157 noise-floor protocol:
  if the control fails the comparator, report environment-limited with
  reasoned medians).
- Tier measurement: memory + postgres + formation-large at N=6/20/50 on
  the candidate; compare against the Phase 2 results (primary) and the
  Phase 0/1 baselines; every Phase 2 property re-asserted (idle steady
  state ≈ 0 beyond client-plane lease writes, liveness assertions,
  `publishSkippedUnchanged` still firing).
- Completion: `npm run test:unit`, `npm run test:ci`, `npm run build` on
  the final tree; Branch Release Gate on the final feature-branch commit;
  Run Hetzner Supported Distributed Manifests on the resulting
  default-branch commit; close via
  `npm run plan:adapt -- close --final-pr-evidence`.

```plan-adaptation-v1
{
  "version": 1,
  "planId": "rallar-group-formation-phase3-delta-dissemination",
  "status": "active",
  "goal": "Cut group-formation burst dissemination cost from O(N^3) toward O(N^2) egress bytes by making group-state.event deltas the primary browser update path with full snapshots reserved for join, resync, and causal-gap pulls, adding overlay topology read-through on connect and reconnect, and admission-controlling join bursts, all behind flags with the legacy snapshot-per-change path retained.",
  "acceptanceCriteria": [
    "Egress bytes per WS topic are counted on the delivery path and a tier baseline (N=6/20/50, memory + postgres + formation-large) is captured on a tree behaviorally identical to main and recorded beside the phase-2 results.",
    "Burst egress bytes at N=50 with deltas primary drop by roughly an order of magnitude against the measured baseline: primary-server burst egress at the large tier must be at most 25.5 MB against the measured 254,951,157 bytes (96.1 percent of which are the two per-change full-snapshot topics).",
    "A late-joiner recipe proves the current server overlay is present via read-through without waiting for a new topology publication, and readStateGroupTopology gains its first production caller.",
    "A reconnect-resync recipe proves group-state and overlay convergence after a dropped WS connection without waiting for a new per-change broadcast.",
    "Join tail latency under an N=50 burst with admission enabled shows zero unavailable false failures, and over-limit admission answers are contractual (429 with Retry-After, or an explicitly recorded 202 ticket contract) rather than 5xx.",
    "Every phase-2 property is preserved: idle steady state stays at zero expansions, broadcasts, recomputes, publications, and WS deliveries beyond client-plane lease writes; liveness assertions hold; publishSkippedUnchanged still fires.",
    "The snapshot-per-change path is retained behind the dissemination flag, delta-primary correctness is proven under dual-emit before any default flip, and the legacy damping mode's emission is bit-for-bit unchanged so the issue-156 pinned replay proof keeps its contract.",
    "REST changes carry black-box recipes in the same change; shared-web surface changes carry public API snapshots, bundle-boundary tests, and check:browser-bundles; mutation-path changes pass the unweakened medium-scale convergence gate and the state-write perf comparison gate under the issue-157 baseline-control protocol."
  ],
  "distributedValidation": {
    "required": true,
    "reason": "Plan acceptance requires the Run Hetzner Supported Distributed Manifests workflow on the resulting default-branch commit in addition to the Branch Release Gate on the final feature-branch commit."
  },
  "architecture": {
    "intendedHypothesis": "Dissemination cost, self-healing, and admission are three separable capabilities layered over the existing single presence-summary expansion site: byte-level observability lands first with zero behavior change, overlay read-through reuses the existing server-provenance adoption rules from the REST surface, and delta-primary emission replaces per-change snapshot fanout only after every audited snapshot consumer has a delta-write or floored-pull replacement, with dual-emit acting as a live divergence oracle before any default flip."
  },
  "capabilities": [
    {
      "owner": "group-state dissemination server",
      "root": "packages/shared-server",
      "entry": "packages/shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts",
      "testRoot": "packages/tests/shared-server",
      "focusedCommand": "npm run test:shared-server",
      "navigationMap": "packages/shared-server/rallar-system/group-state/README.md",
      "factContracts": [
        "apps/api-v1/src/create-rallar-server.ts",
        "apps/api-v1/src/group-state/create-group-state-route-dependencies.ts",
        "apps/api-v1/src/group-state/group-state-route-authorization.ts",
        "apps/api-v1/src/group-state/group-state-route-errors.ts",
        "apps/api-v1/src/group-state/read-group-state-route-request.ts",
        "apps/api-v1/src/group-state/register-group-admission-routes.ts",
        "apps/api-v1/src/group-state/register-group-membership-routes.ts",
        "apps/api-v1/src/group-state/register-group-presence-routes.ts",
        "apps/api-v1/src/group-state/register-group-state-mutation-routes.ts",
        "apps/api-v1/src/group-state/register-group-state-read-routes.ts",
        "apps/api-v1/src/group-state/register-group-state-routes.ts",
        "apps/api-v1/src/group-state/to-group-state-command.ts",
        "apps/api-v1/src/group-state/to-group-state-response.ts",
        "apps/api-v1/src/middleware.ts",
        "packages/shared/queuebox/DequeueResourceEntryController.ts",
        "packages/shared/services/QueueMessageReader.ts"
      ],
      "controlFlowFamilies": [
        "presence-summary expansion and outbox materialization",
        "ws outbox delivery and audience resolution",
        "snapshot assembly and floored REST reads"
      ]
    },
    {
      "owner": "shared group-state contracts",
      "root": "packages/shared",
      "entry": "packages/shared/api/group-types.ts",
      "testRoot": "packages/tests/shared",
      "focusedCommand": "npm run test:shared",
      "navigationMap": "packages/shared/api/README.md",
      "controlFlowFamilies": [
        "contract validation at trust boundaries",
        "causal-revision comparison and adoption decides",
        "dissemination topic and metrics contracts"
      ]
    },
    {
      "owner": "browser state-cache consumption",
      "root": "packages/shared-web",
      "entry": "packages/shared-web/browser/data-caches.ts",
      "testRoot": "packages/tests/shared-web",
      "focusedCommand": "npm run test:shared-web",
      "navigationMap": "packages/shared-web/browser/state-cache/README.md",
      "controlFlowFamilies": [
        "ws inbox switch and cache adoption",
        "connect and refresh hydration reads",
        "overlay adoption and RTC group sync"
      ]
    },
    {
      "owner": "api-v1 group-state boundary",
      "root": "apps/api-v1",
      "entry": "apps/api-v1/src/group-state/register-group-state-routes.ts",
      "testRoot": "packages/tests/api-v1",
      "focusedCommand": "npm run test:api-v1",
      "navigationMap": "apps/api-v1/src/group-state/README.md",
      "contractPaths": [
        "docs/environment-variables.md"
      ],
      "controlFlowFamilies": [
        "route registration and request decoding",
        "admission and resilience middleware",
        "flag parsing and composition"
      ]
    },
    {
      "owner": "formation black-box recipes",
      "root": "packages/shared-test",
      "entry": "packages/shared-test/black-box-runner/api-v1-black-box-run.mts",
      "testRoot": "packages/tests/shared-test",
      "focusedCommand": "npm run test:shared-test",
      "navigationMap": "packages/shared-test/black-box-runner/README.md",
      "contractPaths": [
        "playground/rtc-design/baselines/2026-08-13-phase3-delta-dissemination-results.md"
      ],
      "controlFlowFamilies": [
        "managed server topology and run entry",
        "recipe execution and artifact writing",
        "recipe matrix registration"
      ]
    }
  ],
  "completedSlicesSinceCheckpoint": [
    "overlay-read-through-on-connect-and-reconnect"
  ],
  "facts": {
    "diffBase": "origin/main",
    "affectedCodeDigest": "d782ceffe409c34ec5f516172b236479048317059fb7b6f190c908705a464a1f",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "public-contract-change",
      "scope-growth"
    ],
    "undeclaredChangedPaths": [
      "plans/rallar-group-topology-evidence-ledger-plan.md",
      "plans/repo-human-traceability-program-execution-plan.md",
      "plans/repo-human-traceability-refactoring-program-plan.md"
    ]
  },
  "checkpoint": {
    "outcome": "Slice 1 landed and measured: per-topic WS egress-byte counters are live on the delivery path with zero behavior change, all tier suites pass (memory 19/19, postgres 19/19 plus 5/5 cluster, formation-large 1/1 with 1,323 step successes), and the baseline is recorded in the dated phase-3 results document: N=50 primary burst egress is 254,951,157 bytes with the two full-snapshot topics at 96.1 percent and idle steady state at exactly zero egress bytes.",
    "learning": "The measured byte shares settle two open questions: group-directory.snapshot costs the same as group-state.snapshot (123.3 MB vs 121.6 MB at N=50), so delta-primary must replace both per-change snapshot rows or the reduction caps at roughly 2x; and group-state.event is only about one percent of burst egress, so the delta envelope has ample byte headroom. The Phase 2 idle property is re-verified through the new counter.",
    "structure": "The five declared capability owners are unchanged and sufficient; the results document is declared as a contract path on the formation black-box recipes owner; no folder or ownership moves are needed for the next horizon.",
    "decision": "continue",
    "nextSlices": [
      "m2-dual-emit-delta-envelope"
    ]
  },
  "structuralDispositions": [
    {
      "kind": "predecessor-path",
      "path": "packages/shared-server/rallar-system/formation-metrics/formation-metrics.ts",
      "disposition": "consolidate",
      "destination": "packages/shared-server/rallar-system/formation-metrics.ts",
      "owner": "group-state dissemination server",
      "rationale": "The formation-metrics directory held exactly one code file; materially touching it for the egress-byte counters triggered the singleton-subtree rule, and consolidating the recorder up beside the other flat rallar-system feature modules removes the one-file folder without changing any behavior or export symbol."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.directory-density",
      "target": "packages/shared-server/rallar-system",
      "identity": null,
      "magnitude": 21,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "Pre-existing flat feature-module layout surfaced by touching single files in place; phase 3 adds one consolidated module and reorganizing this directory is outside the delta-dissemination outcome."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system",
      "identity": "rtc",
      "magnitude": 7,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system",
      "identity": "state",
      "magnitude": 4,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.directory-density",
      "target": "packages/shared-server/rallar-system/services",
      "identity": null,
      "magnitude": 74,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "Pre-existing flat feature-module layout surfaced by touching single files in place; phase 3 adds one consolidated module and reorganizing this directory is outside the delta-dissemination outcome."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system/services",
      "identity": "auth",
      "magnitude": 4,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system/services",
      "identity": "client",
      "magnitude": 8,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system/services",
      "identity": "crdt",
      "magnitude": 17,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system/services",
      "identity": "group",
      "magnitude": 8,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system/services",
      "identity": "inbox",
      "magnitude": 12,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "layout.feature-prefix-cluster",
      "target": "packages/shared-server/rallar-system/services",
      "identity": "rtc",
      "magnitude": 10,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "The prefix names a real subsystem family whose canonical owner directories already exist; renaming or refoldering the family is repository-structure work outside this plan."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-server/rallar-system/group-state",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "Canonical feature or subfeature directory established by the group-state and topology structure plans; the depth names a real boundary (inbox, presence, compatibility services) and phase 3 edits files in place."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-server/rallar-system/group-state/inbox",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "Canonical feature or subfeature directory established by the group-state and topology structure plans; the depth names a real boundary (inbox, presence, compatibility services) and phase 3 edits files in place."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-server/rallar-system/group-state/presence",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "Canonical feature or subfeature directory established by the group-state and topology structure plans; the depth names a real boundary (inbox, presence, compatibility services) and phase 3 edits files in place."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-server/rallar-system/rtc-topology/inbox",
      "identity": null,
      "magnitude": 3,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "Canonical feature or subfeature directory established by the group-state and topology structure plans; the depth names a real boundary (inbox, presence, compatibility services) and phase 3 edits files in place."
    },
    {
      "kind": "current-fact",
      "ruleId": "structure.semantic-depth",
      "target": "packages/shared-server/rallar-system/services",
      "identity": null,
      "magnitude": 2,
      "affectedCodeDigest": "048d4758af28f5108597320bff8221c1ea7de3629269b72d64d742b94b3e5508",
      "disposition": "keep",
      "rationale": "Canonical feature or subfeature directory established by the group-state and topology structure plans; the depth names a real boundary (inbox, presence, compatibility services) and phase 3 edits files in place."
    }
  ],
  "freshStructuralReview": null,
  "coldNavigationEvidence": null,
  "materialDecisions": [
    {
      "date": "2026-08-13",
      "decision": "continue",
      "summary": "Slice 1 landed and measured: per-topic WS egress-byte counters are live on the delivery path with zero behavior change, all tier suites pass (memory 19/19, postgres 19/19 plus 5/5 cluster, formation-large 1/1 with 1,323 step successes), and the baseline is recorded in the dated phase-3 results document: N=50 primary burst egress is 254,951,157 bytes with the two full-snapshot topics at 96.1 percent and idle steady state at exactly zero egress bytes."
    }
  ]
}
```
