# Group Formation Mechanism Catalog (2026-08-08)

Mechanisms, algorithms, and protocols that address the storm scenarios in
`2026-08-08-group-formation-storm-scenarios.md`. Each entry states the
mechanism, the standard distributed-systems technique it is an instance of,
what already exists in Rallar to build on (so this is evolution, not
rewrite), and which scenarios (S1–S7) it addresses.

The design goal these serve: convergent (eventually consistent) group
formation that is fault-tolerant and behaves in a permissive, optimistic
fashion — accept work tentatively, converge toward a bounded correct state,
never block the common case waiting for global agreement.

The catalog is grouped by the layer it acts on: dissemination (how state
spreads), computation (how topology is decided), reconciliation (how
browsers act), and admission/flow-control (how load enters).

---

## Dissemination layer

### M1 — Coalescing / debounced recompute with a change gate

Technique: work coalescing + hysteresis. Collapse a burst of triggers into
one execution; skip the execution entirely when nothing topology-relevant
changed.

Two parts:

- **Coalesce.** Replace per-`commandId` work identities with a per-group
  work identity so that N triggers while one execution is pending collapse
  to one successor. Add a short debounce window (a quiescence timer) so a
  join burst produces one recompute at the end, not one per join.
- **Change gate.** Compute the topology-relevant fingerprint (sorted active
  session set + effective config) and short-circuit before the expensive
  rebuild and publish when the fingerprint is unchanged from the last
  accepted overlay. A heartbeat that only advances a timestamp must not
  produce a recompute or a publication.

Already in Rallar: `CoalescedAppOutboxWorkService` implements replace-pending
with a monotonic generation (`services/CoalescedAppOutboxWorkService.ts`),
already used by the RTT path — it is simply not wired to the group-revision
recompute path. `DEFAULT_RTT_REBUILD_DEBOUNCE_MS = 250` and
`queueRttTopologyUpdate`/`flushDueRttTopologyUpdate` exist but are dead in
the persistent runtime. The activation design's debounce + minimum-batch-age
policy is the same mechanism at the batch layer.

Addresses: S3 (recompute storm), S7 (perpetual recompute), S2 indirectly
(fewer publications → fewer snapshot triggers).

### M2 — Delta dissemination instead of full-snapshot broadcast

Technique: event-sourced deltas + periodic/anti-entropy snapshots. Broadcast
the _change_ (member joined/left, presence transition), not the whole roster,
so per-message payload is O(1) instead of O(N) and aggregate burst cost drops
from O(N^3) toward O(N^2).

Members reconstruct current state by applying ordered deltas to a base
snapshot; a full snapshot is sent on join/resync only, and as an
occasional anti-entropy correction.

Already in Rallar: `group_state_events` is an append-only causal event log
(`apps/api-v1/prisma/schema.prisma`), and there is already a
`group-state.event` WS topic distinct from `group-state.snapshot`
(`group-presence-summary-work.ts:205-252`). The event path exists; the
system just _also_ sends full snapshots on every change and browsers act on
snapshots. The browser already has a state-event dedup path
(`rallar-runtime/state-events.ts`). Causal revisions
(`GroupStateCausalRevision`) give the ordering deltas need.

Addresses: S2 (broadcast bytes), S7 (steady-state fanout), S1 indirectly
(smaller summary work → lane drains faster).

### M3 — Scope-correct and audience-bounded fanout

Technique: precise multicast targeting. A group change is a group event;
it must not fan out at world scope.

Fix the client-state broadcast scope (`state-sync-publisher.ts:230-233`
sends principal snapshots to `{broadcast, world}`) to the correct group /
principal-session audience, and keep using the immutable computed audience
(`recipientPeerIds`) already established for overlay publications.

Already in Rallar: the AL targeting model (`al-contracts/al-contract.ts`)
supports unicast/multicast/broadcast with `groupRef`, and the overlay path
already computes and freezes a precise audience
(`rtc-topology-ws-outbox-entry.ts:31`). This is tightening an existing
mechanism, not adding one.

Addresses: S2 (world-scope amplification), S7.

### M4 — Presence heartbeat separation (liveness vs. state)

Technique: split the failure detector from the state channel. A liveness
heartbeat should refresh a lease without mutating shared, broadcast state.

Keep `lastHeartbeatAtEpochMs` out of the presence _summary_ content used for
broadcast and for `presenceRevision`, or maintain liveness in a separate
lightweight lease that expires on silence (phi-accrual-style or simple TTL)
and only produces a state change on an actual online/offline transition.

Already in Rallar: presence already has a TTL and an expiry reconciler
(`reconcile-expired-group-presence.ts`, 24 h TTL, 60 s sweeper), and a
session generation/fencing model (`ws-session-generation-lifecycle.ts`). The
change is to stop treating a timestamp refresh as a topology-relevant state
mutation.

Addresses: S7 (the perpetual storm engine), S2/S3 at idle.

---

## Computation layer

### M5 — Overlay precedence inversion (server authority for topology)

Technique: single-writer authority for a derived value + monotonic
compare-and-set. The **server** owns the accepted topology; the browser
treats its local star as a bootstrap-only fallback that never outranks a
server overlay.

Concretely: separate the overlay's ordering identity from the group revision
so a server overlay computed from group revision R is not dominated by a
locally-restamped star at revision R+k. Options: order overlays by their own
`(topologyEpoch, version)` lineage rather than by group causal revision; or
mark the local star as `provenance: 'bootstrap'` and always let
`provenance: 'server'` win regardless of revision. The browser uses the star
only until the first server overlay for that group arrives.

Already in Rallar: the overlay snapshot already carries
`sourceGroupStateCausalRevision` and `version`
(`shared/api/overlay-topology.ts`), and the server already has a monotonic
accepted-topology store with CAS
(`RtcTopologySnapshotRepository`, `compareOverlayTopologyCausalTuple`). The
fix is the comparison/precedence rule and a provenance tag, not new storage.

Addresses: S5 (the punchline — server topology never adopted), S4 (removes
the full-mesh desired set once a server overlay governs), S7 (RTT degree
then inherits 5, not 49).

### M6 — Incremental / stable topology (minimum-churn replanning)

Technique: stable matching / incremental graph maintenance with hysteresis.
Adding or removing one node should change O(1) edges, not reshuffle the whole
graph, and repeated recomputes on the same member set must be identical.

Two parts:

- **Canonical input order.** Sort the active session set before planning so
  positional fallback weights (`|i-j|+1`) are stable; today only the
  published `activeSessionIds` is sorted, not the planning input.
- **Seed from previous.** Feed the current accepted graph into the planner
  and use the incremental update algorithms already present
  (`updateGroupTree`/`insertMinimumDiameterDegreeLimitedEdge`,
  `updateGroupMesh`/`kInsertMC`, and the reconfig algorithms) instead of
  rebuilding from empty, so an add attaches a node and a remove repairs
  locally. Add a hysteresis band at the kind boundaries (star/tree/mesh) so
  a group hovering at 15–16 members does not oscillate.

Already in Rallar: `packages/shared-graph` already contains
`updateGroupTree` (`graphs-tree-service.ts:171-219`), `updateGroupMesh`
(`graphs-mesh-service.ts:171-246`), and the reconfig algorithms — all fully
implemented and currently unused by the server pipeline, which pins
`NO_RECONFIG_ALGO` and calls only the from-empty constructors. This is
wiring existing algorithms, plus a sort and a boundary band.

Addresses: S3 (structural reshuffle per join), S4/S5 (less churn to
disseminate and reconcile), S7.

### M7 — Formation quiescence window (batch the burst before planning)

Technique: barrier / batching with a settling timer. During initial group
formation, admit members immediately (optimistic) but hold topology planning
until the join rate falls below a threshold or a short window elapses, then
plan once against the settled set.

This is the formation-time complement to M1: M1 coalesces steady-state
triggers; M7 recognizes the distinct "group is forming" phase and plans the
initial topology once rather than 50 times across changing membership and two
kind-boundary crossings.

Already in Rallar: presence admission is already optimistic/tentative
(`rallar-realtime` skill: admit under caps, hard-reject only malformed/
self/exhausted). The activation design's minimum-batch-age is the same idea.
The RTC activation status projection (INITIALISING vs RECONFIGURING) gives a
natural place to expose "forming".

Addresses: S3 (kind-boundary thrash during formation), S1 (less summary work
competing with joins), S4.

### M8 — RTT-driven recompute as bounded background optimization

Technique: threshold/delta-triggered recomputation with rate limiting.
RTT measurements refine placement; they must not each trigger a full
recompute. Accept measurements continuously, but recompute topology from RTT
only on a significant-change threshold and no more than once per bounded
interval per group.

Already in Rallar: the RTT path already uses the coalescing service
(`RtcTopologyOutboxWork.ts:361-402` with `mergeRtcTopologyRttWork`) — the gap
is the recompute-per-accepted-write intent (`rtc-topology-mutations.ts:539-552`)
with no threshold. Vivaldi coordinates
(`packages/shared-graph/graph/vivaldi-core.ts`) already provide a smoothed
model that changes slowly, which is the natural threshold signal.

Addresses: S7 (RTT-triggered recomputes), S3.

---

## Reconciliation layer (browser)

### M9 — Reconcile coalescing (single-flight with a dirty flag)

Technique: coalesced reconciliation loop. Collapse a burst of triggers into
at most one in-flight reconcile plus at most one queued follow-up, instead of
one full O(P^2) reconcile per inbound message.

Fix the existing single-flight so a trigger arriving during an in-flight
reconcile sets a dirty flag that schedules exactly one follow-up, rather than
being dropped (today) or running immediately per message.

Already in Rallar: `reconcileAllGroups` already has a `reconcileInFlight`
single-flight guard (`WebRtcGroupManager.ts:253-260`) — it just lacks the
dirty/rerun flag, so it is currently a lost-update rather than a coalescer.
Small, well-scoped change to an existing structure.

Addresses: S4 (per-message reconcile cost), S7.

### M10 — Outbound connection budget + priority selection

Technique: admission control with prioritized selection (and symmetry with
inbound). Cap outbound dials to the same peer-connection budget as inbound,
and when desired exceeds the budget, select by priority (overlay next-hops
first, then RTT/rendezvous-ranked bootstrap peers) rather than dialing
everyone.

Already in Rallar: the inbound cap exists
(`canAcceptAdditionalPeer`, `WebRtcConnectionService.ts:570-590`); rendezvous
hashing for peer selection already exists
(`selectRttReportingPeers`, `rtt-reporting-policy.ts:27-59`). The fix applies
the same budget and a selection order to the outbound reconcile loop, which
currently has neither.

Addresses: S4 (mesh dial flood, 49-out/10-in asymmetry).

### M11 — Connection retention + attempt-budget correctness

Technique: hysteresis on teardown + stable failure accounting. Do not tear
down a live, working connection just because a new overlay omits it within a
grace window; and do not reset a peer's attempt budget on ordinary topology
churn (only on genuine success), so flapping peers can actually exhaust and
back off.

Already in Rallar: `retainedPeerConnections` already implements
retention-with-eviction (`WebRtcGroupManager.ts:519-587`) but is wired only
to the group-leave path; the attempt budget exists
(`WebRtcConnectionService.ts:78-83`) but is cleared on every
`removePeerIfPresent` default call (`:321-323`). The fix generalizes
retention to overlay transitions and narrows the budget reset to real
success.

Addresses: S5 (teardown storm + infinite redial on overlay adoption), S4.

### M12 — Overlay read-through on connect (anti-entropy pull)

Technique: state resync on (re)connect. A client that connects or reconnects
pulls the current accepted overlay for each of its groups instead of waiting
for the next publication.

Already in Rallar: the read API exists
(`GET .../groups/:groupId/topology`, `graph-topology-routes.ts:135-142`;
`readStateGroupTopology`, `api-integration.ts:801-813`) with zero production
callers. The client already pulls client+group snapshots on connect
(`hydrateStateCaches`) — add the overlay to that hydration and to the
reconnect path.

Addresses: S6 (late joiner never learns topology), S5 (recovery after a
dropped/incomparable overlay).

---

## Admission / flow-control layer

### M13 — Join admission control + backpressure

Technique: rate limiting + load shedding + async acknowledgement. Smooth
the join burst so the serialized mutation lane is not overrun, and return a
fast durable acknowledgement rather than blocking up to 30 s.

Parts: a per-group/per-principal join rate limit (token bucket); optional
async-accept for joins (202 + ticket, as the activation design already
proposes for activation) so the HTTP path does not block on the lane; and
sensible default `maxMembers`/`maxSessionsPerMember` caps as a safety valve.

Already in Rallar: rate limiters exist for ICE, auth, and WS tickets
(`config-route.ts:28-38`) — the pattern is present, just not on group-state
routes. The AppInbox already supports fire-and-forget vs
wait-for-completion (`processEntryNoWaiting` vs
`processEntryUntilCompletionResult`).

Addresses: S1 (join backlog + false-failure tail).

### M14 — Per-group work affinity / ordered processing (optional)

Technique: consistent-hash work routing / per-key serialization. Route a
group's recompute work so it does not run concurrently across servers on the
same snapshot row, avoiding CAS-conflict retry amplification; or honor the
`orderingKey` that is already set but ignored.

Already in Rallar: messages already carry `ordering.orderingKey = contextId`
(`rtc-topology-outbox-entry.ts:125`); the dequeue selector simply does not
use it (`ResourceInboxRepository.ts:487-501`). Correctness does not depend on
this (CAS + retry already make concurrent writers safe) — it is a contention
optimization, so it is optional and measurement-gated.

Addresses: S3 (concurrent same-group recompute conflicts). Lower priority.

---

## Scenario → mechanism matrix

Primary mechanism in **bold**; others are supporting.

| Scenario                                        | Mechanisms              |
| ----------------------------------------------- | ----------------------- |
| S1 Join backlog / false-failure tail            | **M13**, M2, M7         |
| S2 O(N^3) snapshot broadcast                    | **M2**, M3, M4, M1      |
| S3 Uncoalesced graph recompute storm            | **M1**, M6, M7, M8, M14 |
| S4 Browser 49-out/10-in mesh dial storm         | **M5**, M10, M11, M9    |
| S5 Server topology never adopted (overlay race) | **M5**, M11, M12        |
| S6 Late joiner never learns topology            | **M12**, M2             |
| S7 Perpetual storm at idle (heartbeats + RTT)   | **M4**, M1, M8, M2, M5  |

## Mechanism → root-cause coverage

| Root cause (from scenarios doc)                         | Mechanisms   |
| ------------------------------------------------------- | ------------ |
| 1. Local star overlay trap                              | M5, M11, M12 |
| 2. Unconditional/uncoalesced recompute + always-publish | M1, M6, M8   |
| 3. Full-snapshot broadcast + heartbeats-as-mutations    | M2, M3, M4   |
| 4. No outbound cap + inbound-10 asymmetry               | M10, M9      |
| 5. Per-message reconcile + budget-reset teardown        | M9, M11      |
| 6. RTT degree inherited from star (49)                  | M5, M8       |
| 7. No overlay read-through; no join admission           | M12, M13     |

## Design posture notes

- **Permissive/optimistic** is preserved throughout: M7/M13 admit members
  immediately and plan/accept asynchronously; M5 lets a bootstrap mesh carry
  traffic until the server overlay lands; M11 retains working connections
  through churn. Nothing here blocks the common case on global agreement.
- **Eventual consistency**: M2 (ordered deltas) + M12 (anti-entropy pull on
  connect) + M5 (single-writer monotonic overlay authority) are the classic
  convergence triad — bounded staleness, self-correcting on reconnect,
  one authoritative lineage.
- **Fault tolerance** is inherited from existing Rallar durability (AppInbox,
  causal revisions, presence TTL/fencing, perfect-negotiation glare
  handling) — the mechanisms above add damping and precedence, they do not
  replace the durability substrate.
- **Cheapest high-impact wins**, if a subset must be picked first: M5
  (precedence inversion) and M1 (coalesce + change gate) together neutralize
  the two top root causes and make the server's existing topology machinery
  actually take effect — both are wiring/precedence changes over code that
  already exists.
