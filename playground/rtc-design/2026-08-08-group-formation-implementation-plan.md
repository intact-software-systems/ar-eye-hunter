# Group Formation Implementation Plan (2026-08-08)

Status: **Phases 0–4 landed on the default branch. Phase 5 is next and not started.**

| Phase | State | Delivery | Measured results |
| --- | --- | --- | --- |
| 0 — Metrics and baseline | Landed | — | `baselines/2026-08-08-formation-burst-baseline.md` |
| 1 — Overlay precedence | Landed | PR #138 | `baselines/2026-08-09-phase1-overlay-precedence-results.md` |
| 2 — Server damping (M1) | Landed | PR #152 | `baselines/2026-08-11-phase2-server-damping-results.md` |
| 3 — Delta dissemination | Landed | PR #214 | `baselines/2026-08-13-phase3-delta-dissemination-results.md` |
| 4 — Stable topology evolution (M6, M8, M11, M9) | Landed | PR #223 | `baselines/2026-08-15-phase4-stable-topology-evolution-results.md` |
| 5 — Formation epochs (M7) + activation reconciliation | Not started | — | — |
| 6 — Contention and scale-out polish | Measurement-gated | — | — |

Carried into Phase 5 from the landed phases:

- `RALLAR_GROUP_STATE_DISSEMINATION` deliberately still defaults to `dual-emit`.
  Phase 4 proved the churn stream consumes cleanly under `delta-primary` with both
  per-change snapshot topics at zero bytes, and both flip preconditions landed in
  PR #228 (delta-mode recipe twins; RTT-path cache re-verification). The flip and
  the retirement of `snapshot-per-change` are tracked in issue #231.
- Phase 4's incremental planner falls back to a full rebuild when the incremental
  **tree** remove path produces an invariant-violating graph, which costs a
  discarded repair plus a full rebuild. `incrementalPlanInvariantFallbackCount`
  makes the rate observable; tracked in issue #230.

This file records the plan and its phase state. It is not a governance record:
delivery is driven by the live pull request per `plans/README.md`.

Staged plan to make Rallar group formation convergent (eventually
consistent), fault tolerant, and permissive/optimistic at scale — covering
the overwhelming majority (target: 99%+) of common multi-party application
cases — by evolving the existing Rallar foundation. This is explicitly
**not** a reimplementation: existing groups, clients, authentication,
group-state doctrine (AppInbox), causal revisions, topology algorithms, and
queue machinery all remain the substrate. Phases add damping, precedence,
and dissemination discipline on top of them.

Inputs: the scenario record (S1–S7) and mechanism catalog (M1–M14) in this
folder. Related: `plans/rallar-distributed-group-rtc-activation-design.md`
(PR #83), reconciled in Phase 5.

## Product envelope: what "99% of multi-party cases" means here

The plan targets these case families explicitly:

- **Burst formation**: N clients (lobby/event start) join within seconds;
  the group reaches a usable realtime state quickly and converges to an
  efficient topology shortly after. Sizes: star (≤4), tree (5–15), mesh
  (16+), validated at the 6/20/50 black-box tiers.
- **Drop-in / drop-out**: members join and leave an active group
  continuously without destabilizing the rest.
- **Reconnects and flaps**: page reloads, network changes, backgrounded
  tabs; sessions are fenced by generation, state resyncs on reconnect.
- **Mixed transport**: WS relay is the always-available baseline; RTC edges
  are the optimization. A member whose RTC fails still participates.
- **Multi-server**: any server handles any request; no group ownership.
- **Idle groups**: a formed, quiet group costs near-zero ongoing work.

Out of envelope (explicitly): groups of many hundreds of active RTC
sessions (WS relay + partial RTC remains the posture there), multi-region
databases, and cross-group browser connection budgeting (documented
limitation, carried over from the activation review).

## Design principles

1. **Three planes, separated.** Membership (who is in the group — causal,
   durable), liveness (who is reachable right now — leases, cheap,
   non-causal), topology (how they connect — derived, single-writer,
   epoch-ordered). Today all three are fused: a heartbeat mutates
   membership-adjacent state and triggers topology work. The fusion is the
   perpetual-storm engine (S7).
2. **Server is the topology authority; browser is the executor with a
   bootstrap fallback.** The browser's synthesized full-mesh star becomes a
   bootstrap-only, bounded fallback that always yields to a server overlay
   (inverts today's precedence, S5).
3. **Permissive and optimistic.** Joins are admitted immediately; bootstrap
   connectivity starts immediately; planning and refinement happen
   asynchronously; nothing user-visible blocks on global agreement.
   Tentative inbound admission stays.
4. **Damping at every amplification stage.** Coalesce triggers, gate on
   change, debounce bursts, budget dials, batch reconciles (the
   amplification map's "none" column becomes mechanisms M1/M4/M9/M10).
5. **Deltas over snapshots; pull on connect.** Events carry changes;
   snapshots serve resync. Reconnect pulls (anti-entropy) instead of
   waiting for the next broadcast.
6. **Make-before-break, with hysteresis.** Established, working connections
   survive replans within a grace window; failure budgets are stable so
   flapping converges instead of looping.
7. **Doctrine unchanged.** AppInbox remains mandatory for mutations;
   read/compute/validate/write(transaction, computed) unchanged; causal
   revisions remain authority; `GroupRef` scoping everywhere.

## Target end-to-end flow (N=50 burst, after all phases)

1. 50 joins arrive; admission-controlled but immediate (M13); each join
   appends a membership **event**; deltas fan out O(1)-sized (M2); the
   full-snapshot path serves only resync.
2. Browsers connect WS, hydrate snapshots **and the current overlay**
   (M12); with no server overlay yet, each uses a **bounded bootstrap set**
   (rendezvous-selected ≤ budget peers, not 49) for immediate connectivity
   (M5+M10); realtime works via WS relay from second zero.
3. Heartbeats renew liveness leases without causal mutations or broadcasts
   (M4). RTT measurements accumulate without per-report recomputes (M8).
4. The formation window closes (join rate quiesces or timer fires, M7);
   **one** topology plan runs against the settled set (M1 coalesced,
   fingerprint-gated), producing overlay epoch 1.
5. Epoch 1 publishes to all sessions; browsers adopt it (server precedence,
   M5), connect missing edges within their dial budget (M10), retain
   still-working bootstrap edges through the grace window (M11), and tear
   down the rest gracefully.
6. Later joins/leaves emit deltas; coalesced, fingerprint-gated replans
   produce epoch 2, 3… via **incremental** updates that preserve most edges
   (M6). RTT refinement adjusts placement occasionally under thresholds
   (M8).
7. Idle group: liveness renewals only; zero recomputes, zero broadcasts,
   near-zero reconciles.

Convergence argument (eventual consistency): overlay epochs form a single
monotonic lineage from one authority (M5); deltas are causally ordered with
snapshot resync on gap or reconnect (M2+M12); browsers reconcile toward the
latest adopted epoch with damped, budgeted actions (M9/M10/M11). Any missed
message is repaired by pull-on-connect or the periodic reconcile — the
system is self-correcting from any single loss, which is the permissive/
optimistic posture requested.

## Phases

Each phase is independently shippable, feature-flagged where it changes
behavior, and validated with the black-box size tiers (small 6 / medium 20 /
large 50) plus targeted unit/service tests. Ordering follows root-cause
rank: the earliest phases neutralize the biggest causes with the smallest
diffs.

### Phase 0 — Measure the storm (baseline + guardrails)

Goal: make every storm quantity from the scenario record observable, so
later phases prove their effect.

- Metrics: group mutations/min, summary expansions/min, WS_OUTBOX rows and
  delivered messages by topic, recomputes triggered vs executed vs
  published, overlay publications and adoption results (adopted / dominated
  / incomparable — **browser-reported**), browser reconciles/min, outbound
  dials, teardown counts, RTT submissions/min.
- Black-box: a formation-burst recipe at the 6/20/50 tiers that joins all
  clients within ~3 s and records the storm quantities; this becomes the
  regression harness for every later phase. (Extends the batch-tier recipes
  already defined in PR #83's validation section.)
- No behavior changes. Exit: baseline numbers recorded for all three tiers.

Touches: metrics plumbing in `rallar-system` services and
`packages/shared-web/browser` diagnostics; recipes in
`packages/shared-test/black-box-runner`.

### Phase 1 — Overlay precedence + bootstrap set (M5, M10 core; root cause 1)

Goal: the server's topology actually takes effect; browsers stop full-mesh
dialing. Biggest single win; mostly browser-side.

- Add overlay **provenance** (`bootstrap` vs `server`) to `OverlayInfo`;
  admission rule: server overlays always supersede bootstrap overlays;
  server-vs-server ordering keeps the existing monotonic tuple. The local
  star is created only when no server overlay exists for the group
  (`data-caches.ts:409` becomes conditional) and is never restamped over a
  server overlay.
- Replace the star's `nextHopSessionIds = all` with a **bounded bootstrap
  selection**: rendezvous-hash (reuse `selectRttReportingPeers`-style
  selection from `rtt-reporting-policy.ts`) of ≤ `bootstrapDegree` peers
  (default: min(degreeLimit, remaining budget)), deterministic per
  (groupKey, sessionId) so bootstrap graphs are connected with high
  probability without global coordination.
- Outbound dial budget in the reconcile connect loop
  (`WebRtcGroupManager.ts:269-290`): cap concurrent dials at the same
  peer-connection budget as inbound; priority order: server-overlay next
  hops, then bootstrap peers. Fixes the 49-out/10-in asymmetry.
- RTT reporting degree consequently inherits the server/bootstrap degree
  (≤5-ish), not N−1.

Validation: formation-burst recipe shows overlay adoption rate ≈ 100% and
outbound dials bounded; unit tests for precedence and deterministic
bootstrap selection; existing shared-web public-surface snapshots.
Rollback: flag reverts to legacy star behavior.

### Phase 2 — Server damping (M1, M4, M3; root causes 2 and 3's engine)

Goal: a join burst produces ~1 recompute, an idle group produces ~0 work.

- **Wire the coalescer**: route the group-revision recompute path through
  `CoalescedAppOutboxWorkService` with a per-group work identity (replace
  the per-`commandId` `deriveRtcTopologyEntryResourceId`), plus a short
  debounce (`topologyRecomputeDebounceMs`, default ~500 ms, config-backed).
- **Change gate**: compute the topology-input fingerprint (sorted active
  sessions + effective config — the same canonical hash defined in the
  activation design) before planning; unchanged fingerprint →
  no rebuild, no publication. Also gate publication on `changed` (today
  `'advanced'` publishes identical graphs because revision always moves).
- **Heartbeat separation**: exclude `lastHeartbeatAtEpochMs` from the
  presence-summary content used for `presenceRevision`/broadcast (liveness
  lease refresh only); a heartbeat produces zero broadcast rows and zero
  recompute triggers unless it causes an online/offline transition.
  Presence expiry machinery (TTL + sweeper + generation fencing) is
  unchanged.
- **Audience fix**: client-state principal snapshots stop broadcasting at
  world scope (`state-sync-publisher.ts:230-233`) — scope to the
  principal's sessions plus groups that need it.

Validation: idle 50-member group shows ~0 recomputes/broadcasts per minute
(vs baseline 150/min + 450 rows/min); burst tier shows recompute count ≈
low single digits; medium-scale convergence gate unweakened; existing-lane
queue tests unaffected.
Risk note: heartbeat separation changes `presenceRevision` semantics —
consumers that relied on heartbeats advancing revisions must be audited
(state-sync freshness gates, `minSnapshotVersion` users).

### Phase 3 — Delta dissemination + read-through (M2, M12, M13)

Goal: burst cost drops from O(N^3) toward O(N^2) bytes; late joiners and
reconnects self-heal; joins stop false-failing.

- Browsers consume `group-state.event` deltas as the primary update path
  (the topic and the event log already exist); full snapshots on join,
  resync, and causal-gap detection (revision gap → pull). Snapshot
  broadcasts per change are removed once delta consumption is proven
  (flagged transition: dual-emit → delta-only).
- Overlay read-through on connect/reconnect: add the existing
  `GET .../groups/:groupId/topology` to `hydrateStateCaches` and the
  reconnect path (`readStateGroupTopology` gains its first production
  caller).
- Join admission: token-bucket rate limit on group-state mutation routes
  (reuse the existing limiter pattern from `config-route.ts`); sensible
  default `maxMembers` cap; optionally async-accept (202 + poll) for join
  under burst, reusing the AppInbox fire-and-forget + the ticket pattern
  from the activation design.

Validation: burst tier egress bytes vs baseline; late-joiner recipe (join
after formation, assert overlay present without waiting for a
publication); reconnect recipe (drop WS, reconnect, assert resync); join
tail latency under burst with no `unavailable` false failures.

### Phase 4 — Stable topology evolution (M6, M8, M11, M9)

Goal: replans preserve structure; browsers churn O(delta) edges, not O(N).

- Canonical sorted planning input; retire positional `|i-j|+1` weights in
  favor of order-independent fallback weights (e.g., hash-derived) so
  identical member sets always produce identical graphs.
- Seed planning with the current accepted graph; use the existing
  incremental `updateGroupTree`/`updateGroupMesh` + reconfig algorithms for
  add/remove deltas; full rebuild only on kind change or invariant
  violation. Hysteresis band at kind boundaries (e.g., tree→mesh at 16,
  mesh→tree at 12) to prevent oscillation.
- Browser: generalize `retainedPeerConnections` to overlay transitions
  (grace window before tearing down an edge that the previous epoch
  wanted); attempt budgets survive topology-churn teardowns (reset only on
  genuine success); reconcile gains the dirty-flag follow-up (single-flight
  becomes a true coalescer).
- RTT refinement: threshold + interval-gated (reuse the RTT coalescing path
  that already exists; add Vivaldi-delta threshold), so placement improves
  occasionally instead of 25 times/second.

Validation: churn recipe (join/leave stream against a formed 50-group)
asserting edge-churn-per-change bounds and no budget-reset flap loops;
graph unit tests for determinism, incremental-vs-full equivalence of
invariants, and boundary hysteresis.

### Phase 5 — Formation epochs + reconciliation with the activation design (M7)

Goal: a first-class "forming" phase, and one coherent story with PR #83.

- Formation window: while a group's RTC status is `INITIALISING` (or a
  fresh burst is detected), hold planning until join-rate quiescence or a
  window cap; plan once; publish epoch 1. This is the activation design's
  debounce + minimum-batch-age, generalized to formation.
- **Decision point (explicit):** with Phases 1–4 landed, the substrate the
  activation design assumed exists — and the observed-convergence posture
  becomes cheap: the server publishes the planned overlay as desired,
  browsers converge (budgeted, retained, damped), and the server derives
  activation/formation status from observed edge state (RTT/liveness
  reporting) against a readiness threshold. The recommendation from the
  architect review stands: prefer observed convergence for the common
  path, and reserve the full per-edge command/confirm batch machinery
  (`group_batch`, `ASYNC_REMOTE_QUEUE`) for the cases that need a hard
  per-edge audit trail or strict establishment pacing. Either way,
  `group_batch` remains valuable as the plan/audit/readiness record; what
  is decided here is whether per-edge confirmations are the default or the
  exception. This decision is made at Phase 5 start, informed by Phase 0–4
  measurements, and recorded in the activation design doc.
- Expose formation state via the RTC activation status projection
  (INITIALISING → ACTIVE/DEGRADED) and the ticket/read surfaces defined in
  the activation design.

Validation: the formation-burst tiers assert: time-to-usable (WS baseline)
≈ immediate; time-to-epoch-1 ≈ window + one plan; total recomputes during
formation ≈ 1–3; convergence to epoch 1 across all browsers; Hetzner
small-tier distributed manifest per PR #83.

### Phase 6 — Contention and scale-out polish (M14 + committed follow-ups)

Measurement-gated, only if Phase 0 metrics show need:

- Honor `orderingKey` in dequeue (per-group serialization of recompute
  work) to cut CAS-conflict retries.
- Queue lane concurrency tuning beyond `maxConcurrency: 1` with per-group
  ordering preserved.
- The `resource_inbox` partition/dedicated-lane follow-up already committed
  in the activation design's Scale Posture.
- Remove the per-signal `JSON.stringify` console logging in the RTC hot
  path (diagnostic-gated).

## Compatibility and doctrine

- No public API breaks: `GroupRef`, auth/session model, group-state routes,
  `rallar.realtime.room`/`rallar.messages.room`, and the AppInbox mutation
  doctrine are unchanged. New behavior ships behind config/flags with the
  legacy path retained until the corresponding tier validation passes.
- Deno/Node runtime split respected: shared contracts in
  `packages/shared`; server changes in
  `packages/shared-server/rallar-system` (canonical feature directories,
  not `services/**` compatibility shims); browser changes in
  `packages/shared-web/browser` + `packages/shared/services`.
- Every phase that touches REST behavior ships black-box recipes in the
  same change (repo rule), and api-v1 mutation-path phases run the
  medium-scale convergence gate unweakened.

## Risks and open questions

1. **`presenceRevision` semantics change (Phase 2)** — consumers relying on
   heartbeat-advanced revisions (freshness gates, `minSnapshotVersion`)
   must be audited; mitigation: dual-plane transition period where liveness
   is separated but revisions still advance on transition events only.
2. **Delta-path correctness (Phase 3)** — gap detection and resync must be
   airtight before snapshot broadcasts are removed; mitigation: dual-emit
   phase + gap-injection black-box tests.
3. **Bootstrap graph connectivity (Phase 1)** — rendezvous bootstrap sets
   must be connected with high probability at small degree; validate with
   graph unit tests across sizes; WS relay remains the correctness
   baseline regardless.
4. **Incremental-plan quality drift (Phase 4)** — incremental updates can
   accumulate suboptimality; mitigation: periodic full replan under the
   fingerprint gate + RTT-threshold triggers, and the invariant validator
   runs on every plan regardless of how it was produced.
5. **Interaction with PR #83** — the activation design's browser
   coexistence contract (commanded-edge retention, origin validation)
   overlaps M11; Phase 5 resolves which establishment posture is default.
   Until then, the two documents must not be implemented against each
   other; the Phase 5 decision is the merge point.
6. **Backgrounded tabs** — timer throttling degrades liveness renewal and
   RTC work alike; leases and thresholds must be tuned to tolerate
   ~1-minute wake gaps (carried over from the architect review).

## Suggested first slice

Phase 0 + Phase 1 together: the measurement harness plus the precedence
inversion and dial budget. They are small, mostly additive, neutralize root
causes 1 and 4, and make every subsequent phase's effect measurable — and
after them, the server's existing topology machinery starts actually
governing browsers, which changes the observed system more than any other
single step.
