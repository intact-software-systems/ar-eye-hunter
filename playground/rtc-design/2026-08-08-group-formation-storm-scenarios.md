# Group Formation Storm Scenarios (Current System, 2026-08-08)

Analysis of what the current Rallar browser + server actually does when a
group of 50 clients joins within a few seconds. Every claim below was
verified against the code on `main` (commit `f7ea9b2f` era); file:line
references are the evidence. Scenario IDs (S1–S7) are referenced by the
mechanism catalog and the implementation plan in this folder.

Summary in one paragraph: four independent storm engines ignite — a join
mutation backlog, a full-snapshot broadcast storm, an uncoalesced graph
recompute storm, and a browser full-mesh dialing storm — and the storm's
central irony is that the server's computed topologies mostly never take
effect, because every browser manufactures a local full-mesh overlay that
outranks them. Heartbeats and RTT reports then keep both storms burning
indefinitely after the joins stop.

## The per-join amplification chain

No stage of this chain coalesces, gates, or rate-limits:

```text
1 join
  -> 3 APP_INBOX mutations (WS connect, GROUP_JOIN, GROUP_PRESENCE_CONNECT)
       packages/shared-web/browser/rooms/join-room.ts:43-69
       apps/api-v1/src/group-state/register-group-admission-routes.ts:46
       apps/api-v1/src/group-state/register-group-presence-routes.ts:45
  -> each write outcome: exactly 1 GROUP_PRESENCE_SUMMARY APP_OUTBOX entry,
     keyed by per-request commandId (never merged)
       group-state/mutation/group-mutation-result.ts:92-132
       packages/shared/queuebox/GroupPresenceSummaryEntryContract.ts:53-57
  -> summary worker expands to:
       3 WS_OUTBOX rows (event + FULL group snapshot + FULL directory
         snapshot) to every connected member
       + 1 RTC_TOPOLOGY_RECOMPUTE APP_OUTBOX entry, UNCONDITIONAL
       group-state/presence/group-presence-summary-work.ts:205-273
  -> recompute: full graph rebuild from empty, ALWAYS publishes to all
     active sessions (even when the graph is identical or stale)
       services/RtcTopologyOutboxWork.ts:176-320, 647-677
  -> every delivered message: one full browser reconcile + full room-state
     re-derivation + re-render
       packages/shared-web/browser/data-caches.ts:119-136, 344-411
       packages/shared/services/WebRtcGroupManager.ts:253-328
```

`CoalescedAppOutboxWorkService` exists (`services/CoalescedAppOutboxWorkService.ts`)
but is not wired to any of this; the only debounce constant in the codebase
(`DEFAULT_RTT_REBUILD_DEBOUNCE_MS = 250`) is dead in the persistent runtime
(`group-topology-management-service.ts:760-766`, `ws-system-topics.ts:432`).

## S1 — Join backlog: tail joiners time out on joins that succeed

150 mutations (3 × 50) arrive at queue lanes running `maxConcurrency: 1`
with one row reserved at a time, per server
(`packages/shared-server/rallar-system/middleware/RallarMiddleware.ts:217-274`,
`packages/shared/queuebox/DequeueController.ts:64-65`). Each join HTTP call
block-polls its result at 250 ms → 1 s intervals with a 30-second ceiling
(`apps/api-v1/src/services/timing-service.ts:22-29`,
`AppInboxService.ts:381-408`). Joins land faster than the serialized lane
drains — and the same lane is also processing the presence summaries the
earlier joins spawned — so tail joiners in the burst can hit the ceiling and
receive `unavailable` even though their mutation later commits. There is no
join rate limiting on any group-state route, and `maxMembers` /
`maxSessionsPerMember` default to unbounded
(`group-state/group-mutation-command.ts:110-111`).

User-visible effect: some of the 50 see a failed join that actually
succeeded.

## S2 — Snapshot broadcast storm: O(N^3) bytes

Each of the ~100 summary expansions (2 per join) writes full-snapshot rows —
`GroupSnapshot` carries all members and all sessions
(`packages/shared/api/group-types.ts:203-213`) — delivered to every
connected member (`state-sync-routing.ts:133-189`). Aggregate cost:

```text
2N snapshot rows x O(N) payload x O(N) recipients = O(N^3) bytes
N = 50  =>  ~400 WS messages received per client, ~10-20k deliveries,
            roughly 50 MB of WebSocket egress for the burst alone
```

Two compounders:

- Client-state snapshots broadcast at **world scope** — every open session
  in the same applicationId+workspaceId, not just the group
  (`state-sync-publisher.ts:230-233` routes `audience.kind === 'principal'`
  to `{mode:'broadcast', scope:'world'}`).
- Multi-server: per WS_OUTBOX row, every other server performs a full-row
  SELECT, a JSON parse, and an O(members × sessions) recipient-resolution
  scan (`QueueBoxPubSubBridge.ts:106-152`,
  `ws-server-target-resolver.ts:50-58`, `state-sync-routing.ts:154-186`).

## S3 — Graph storm: ~100 rebuilds, all published, structure reshuffling

The ~100 join-driven recompute work items each rebuild the topology from an
empty graph. Three properties maximize churn:

- **Full rebuild, no incremental path.** Only `createGroupTree` /
  `createGroupMesh` are called
  (`services/rallar-rtc-topology-service.ts:664-678`); the incremental
  `updateGroupTree` / `updateGroupMesh` and the reconfig algorithms exist in
  `packages/shared-graph` but are never called from the server pipeline, and
  mesh config pins `reconfigAlgo: NO_RECONFIG_ALGO`
  (`rallar-rtc-topology-service.ts:792-800`).
- **Positional weights.** With no RTT data, edge weights are
  `|i - j| + 1` over the **unsorted** active-sessions array order
  (`rallar-rtc-topology-service.ts:831-833`;
  `group-client-views.ts:124-130` preserves arrival order). Every join
  shifts indices, so consecutive plans can be structurally unrelated.
- **Kind boundaries crossed live.** star 1–4 / tree 5–15 / mesh 16+
  (`rallar-rtc-topology-service.ts:485-508`, defaults `:156-159`) are
  re-evaluated per work item against whatever snapshot that item captured;
  crossing a boundary replaces every edge, and out-of-order execution can
  cross a boundary more than once in both directions.

Every recompute publishes: the snapshot decision compares causal revision
first, and revision always moved, so even a byte-identical graph is
`'advanced'` (`rallar-rtc-topology-service.ts:105-137`,
`rtc-topology-snapshot-contract.ts:21-32`) — and a stale work item still
publishes via `'publish-superseded'`
(`services/rtc-topology-stale-publication.ts:22-51`). Publication audience
is all active sessions (`RtcTopologyOutboxWork.ts:669`).

Concurrency: dequeue ignores `orderingKey` (set to contextId on the message
but unused by the selector, `ResourceInboxRepository.ts:487-501`), so
recomputes for the same group can run concurrently across servers and
conflict on the snapshot row (`RuntimeStateWriteConflictError` → retry,
`RtcTopologyOutboxWork.ts:281-283`).

## S4 — Browser mesh-dial storm: 49 out, 10 in

On **every** group snapshot where the client is an active member, the
browser manufactures a local "star" overlay whose next hops are **all
member sessions** with `degreeLimit = N - 1`
(`packages/shared-web/browser/data-caches.ts:409` →
`packages/shared/repository/overlays-repository.ts:280-295`). The reconcile
loop then dials every desired peer with **no outbound cap** — the connect
loop has no slice, sort, or budget (`WebRtcGroupManager.ts:269-290`).
`DEFAULT_WEBRTC_MAX_PEER_CONNECTIONS = 10` gates **inbound admission only**
(`WebRtcConnectionService.ts:570-590`) plus retained-peer eviction
(`WebRtcGroupManager.ts:578`).

Cohort math at N=50:

```text
2,450 RTCPeerConnection objects over 1,225 pairs (both ends dial)
~20,000-30,000 offer/answer/ICE messages relayed through the server's
  maxConcurrency-1 WS outbox
per browser: ~100+ full reconciles back-to-back (one per inbound state
  message), each O(P^2 log P) plus O(M x C) ~= 2,500 room-state
  comparisons, two locale sorts, and listener/re-render fan-out
console JSON.stringify per signal and full SDP logs
  (WebRtcConnectionService.ts:446, QRtcPeerConnection.ts:315, 496)
```

What works: glare is handled correctly with perfect negotiation, polite
side = lexicographically smaller sessionId
(`WebRtcConnectionService.ts:1329-1331`, `QRtcPeerConnection.ts:521-564`),
so pairs converge to a single negotiation.

What bites: the 49-out / 10-in asymmetry. Inbound slots fill with whoever
dialed first (tentative admission for unknown peers,
`middleware.ts:127-136`); after 10, offers from **genuinely desired** peers
are rejected `'max-peer-connections'` while the rejected side keeps
redialing every reconcile, burning its 6-attempt budget
(`WebRtcConnectionService.ts:78-83`), which reconcile ignores
(`WebRtcGroupManager.ts:279-289` only logs `connect-exhausted`).

## S5 — The server's topology loses the overlay race (the punchline)

Server overlays are admitted client-side only if they **dominate** the
stored overlay on `(sourceGroupStateCausalRevision, then overlayVersion)`
(`overlays-repository.ts:203-239, 248-263`). But the local star overlay is
re-stamped with the newest causal revision on every group snapshot
(`toStarOverlay`, `overlays-repository.ts:282`), and its `overlayVersion` is
the group version — large — while the server overlay's version is its own
small counter.

During the burst — and during steady heartbeat churn, where at N=50 a group
mutation lands roughly every 0.4 s — the local star's revision advances
faster than the server can compute and deliver an overlay. Server overlays
are therefore dropped as `'dominated'` (silent console log) or throw
`OverlayRevisionConflictError` (`'incomparable'`, caught and logged at
`WsQueueBoxClientService.ts:574-578`). Even at equal revisions, the version
tiebreak favors the star.

**Net effect: browsers stay on full mesh; the server's graph storm (S3) is
largely wasted work.** On the occasions a degree-5 overlay does land:
desired drops 49 → ≤5, tearing down up to 44 peers per browser (~2,200
cohort-wide) — connections that completed real ICE work — and every
teardown **clears that peer's attempt budget**
(`WebRtcConnectionService.ts:321-323` via default `removePeerIfPresent`),
so a peer flapping in and out of consecutive overlays redials forever and
can never exhaust. `retainedPeerConnections` protects nothing here: it is
populated only on the "I left the group" path
(`WebRtcGroupManager.ts:117-118, 519-536`; browser caller
`data-caches.ts:402`).

## S6 — The late joiner never learns the topology

There is no overlay read-through: WS connect pushes no state (the
`onConnection` hook at `JsonWebSocketServer.ts:110` has zero
registrations), the client hydrates only client+group snapshots
(`middleware.ts:304-316`), and the topology read API
(`GET .../groups/:groupId/topology`, `graph-topology-routes.ts:135-142`)
has **zero production callers** — `readStateGroupTopology`
(`api-integration.ts:801-813`) is referenced only from tests. A client
joining after a publication learns the overlay only from the **next**
publication. Usually its own join triggers a recompute whose audience
includes it; when that recompute produces no publication, the client sits on
its local full-mesh star indefinitely. Combined with S5, "browser holds the
server's topology" is the exception, not the rule.

## S7 — The storm never ends: steady state at ~600 messages/second

After all 50 are in and idle:

- **Presence heartbeats** (browser interval 20 s,
  `packages/shared-web/browser/heartbeat.ts:16`) are full mutations — the
  timestamp always advances so the no-op guard never holds
  (`compute-group-presence-mutation.ts:196-229`), and the presence summary
  content embeds `lastHeartbeatAtEpochMs` so `presenceRevision` bumps every
  time (`compute-group-presence-summary.ts:256-282, 80-94`). At N=50:
  150 group mutations/min → 450 full-snapshot broadcast rows/min →
  ~22,500 group messages/min, plus ~15,000 world-scope client messages/min,
  plus **150 topology recomputes per minute, forever**, each publishing to
  all 50 sessions.
- **RTT reports** fire every 5 s per reporting peer
  (`WebRtcHeartbeatService.ts:4`), and the reporting degree is inherited
  from the overlay's degree limit — which, thanks to the local star, is
  **49, not 5** (`WebRtcGroupManager.ts:219-230, 487-492`;
  `overlays-repository.ts:291`): up to ~29,400 submissions/min cohort
  ceiling (3,000/min once a real overlay governs). Every accepted
  measurement enqueues a version-keyed, never-deduplicated recompute intent
  (`services/rtc-topology-mutations.ts:539-552`,
  `rtc-topology-identifiers.ts:43-51`) — ~25 more recomputes/sec potential,
  ~1,500 in the first minute.
- Every one of those messages re-triggers the browser's per-message
  reconcile and re-render (S4 costs, continuously).

The observed "storm of graphs being created and reconfigured" is not a
join-burst transient; the join burst just makes the permanent regime
visible.

## Amplification map

| Stage                                    | Multiplier                                      | Dampening today?                                                |
| ---------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| 1 join → mutations                       | ×3                                              | none (no rate limit, unbounded group)                           |
| mutation → broadcast rows                | ×3, each O(N) payload → O(N) recipients         | none — full snapshots, commandId-unique keys                    |
| mutation → topology recompute            | ×1 unconditional                                | none — no change gate; coalescer exists, unwired; debounce dead |
| recompute → publication                  | ×1 always (identical and stale graphs included) | none                                                            |
| publication/snapshot → browser reconcile | ×1 per message                                  | single-flight guard is lost-update, rarely engages              |
| reconcile → outbound dials               | ×desired (49, from the local star overlay)      | no outbound cap; inbound capped at 10                           |
| heartbeat / RTT → all of the above       | every 20 s / 5 s per client                     | none — heartbeats always mutate; RTT intents never dedupe       |
| offer glare                              | pairs converge to one negotiation               | ✔ perfect negotiation works                                     |

## Root causes, ranked

1. **Local star overlay trap** — the browser manufactures a full-mesh
   overlay per snapshot that both sets desired = everyone and outranks the
   server's real topology under churn (S4, S5, S6, S7 amplifier).
2. **Unconditional, uncoalesced recompute + always-publish** — no change
   gate, no debounce; commandId-unique work identities defeat dedup by
   construction (S3, S7).
3. **Full-snapshot broadcast per change (O(N^3)) + heartbeats-as-mutations**
   — the fanout cost and the perpetual-storm engine; world-scoped client
   snapshots compound it (S2, S7).
4. **No outbound dial cap + inbound-10 asymmetry** — mesh dialing floods,
   then crowds out the very peers a real topology would want (S4).
5. **Per-message reconcile + budget-reset-on-teardown** — O(P^2) work per
   message and flap loops that never exhaust (S4, S5).
6. **RTT degree inherited from the star overlay (49)** — measurement
   traffic scales with the bug; each report can trigger a recompute (S7).
7. **No overlay read-through on connect; 30 s join-poll ceiling; no join
   admission control** — late joiners stranded, tail joiners see false
   failures (S1, S6).

## Relationship to the activation design (PR #83)

The distributed activation design
(`plans/rallar-distributed-group-rtc-activation-design.md`) addresses causes
2, 4, and 7 for its commanded-establishment path (debounced batches,
capacity pacing, ticket surface). Causes 1 and 3 would sink it exactly as
they sink today's pipeline: commanded edges would be crowded out or torn
down by the same local full-mesh, and the same broadcast/heartbeat storm
would keep superseding batches. The formation plan in this folder supplies
that substrate.
