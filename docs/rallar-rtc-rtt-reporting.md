# Rallar RTC RTT Reporting

This document explains how RTC round-trip time (RTT) measurements move from
Rallar browser clients to Rallar Server, how the server validates and stores
those measurements, and how the runtime bounds RTT measurement work separately
from retained RTC peer connections.

## Reporting Degree Limit

RTT reporting has its own degree limit, separate from
`rtc.maxPeerConnections`.

`rtc.maxPeerConnections` remains the browser cap for retained RTC peer
connections. It allows smooth room and overlay transitions without forcing the
browser to immediately close every inactive peer. RTT reporting uses
`rtc.rttReportingDegreeLimit` instead, so a browser can keep more RTC peers
than it actively measures.

The default RTT reporting degree is `5`, matching the default RTC topology
`degreeLimit`. The server normalizes invalid, zero, negative, or fractional
values back to that default. When the server option is omitted, it falls back
to the effective topology `degreeLimit`.

On the server that fallback is resolved per group, not once per process. Both
acceptance paths — the durable AppInbox RTT mutation composed in
`apps/api-v1/src/composition/create-api-v1-topology-services.ts` and the
in-memory topic path through the `readGroupRttReportingDegreeLimit` hook in
`packages/shared-server/rallar-system/ws-system-topics.ts` — and the read-side
planning filter all call `readRttReportingDegreeLimit` with the group's
effective topology configuration (server defaults, durable per-group config,
temporary override) under the server reporting option. An explicitly
configured `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT` therefore still wins;
otherwise a group's effective `degreeLimit` is its reporting limit, and raising
it through the group's topology config also raises the evidence the server
will store for that group. A report whose endpoints share several active
groups is accepted under the largest of those groups' limits. Acceptance and
planning agreeing per group is what lets formation readiness cover a plan
whose degree exceeds the server default; see
`docs/rallar-group-formation-architecture.md`.

API-v1 reads the server runtime option from:

```text
RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT
```

Browser callers can set:

```ts
rallar.setDefaults({
    rtc: { rttReportingDegreeLimit: 5 }
});
```

or pass the same option through operation RTC options. If the browser has no
explicit RTT reporting degree, it uses the published overlay `degreeLimit` once
an overlay snapshot is available. Before that, bootstrap selection falls back
to the shared default.

## Browser Reporting Path

RTT reporting starts on an open RTC data channel between two browser sessions.
`WebRtcHeartbeatService` sends heartbeat pings every
`defaultPingFrequencyMsecs` milliseconds, currently `5000`. Each ping payload
uses `performance.now()` as the timestamp. The remote peer responds with a pong
that echoes the timestamp, and the sender computes RTT as the rounded
difference between local `performance.now()` and the echoed value.

When a pong is observed, `WebRtcHeartbeatService` emits a `PingResult` with the
remote peer session id, the measured RTT in milliseconds, and a per-heartbeat
version counter. `WebRtcRxStreamerService` owns one heartbeat service per RTC
peer, but only selected reporting peers are allowed to start or keep heartbeat
measurement. Peers outside the selected set can remain connected without
running RTT heartbeat work.

`WebRtcGroupManager.rttReportingPeerIds(...)` selects at most K peers for the
local session with the shared deterministic reporting policy:

- Server-published overlay `nextHopSessionIds` are preferred and sorted
  deterministically. Browser-local provisional star overlays are used for RTC
  connection bootstrap, but not as authoritative RTT reporting eligibility.
- If fewer than K server-published overlay peers are available for a joined
  group, bootstrap candidates are chosen from that group's online active peers
  with a rendezvous hash of the local session, peer session, and scoped group
  key.
- Per-group candidates are de-duplicated, the local session is excluded, and a
  candidate is kept only if every other active joined group shared by the same
  pair would also pass the server reporting-edge policy. The final reporting
  set is globally capped at K for the browser session.

The browser middleware reconciles the selected set into
`WebRtcRxStreamerService`. Entering peers start RTT heartbeats if the RTC lane
is already open; leaving peers stop RTT heartbeats.

For each accepted local heartbeat result, the browser converts it into
`RttMeasurementInfo`:

- `sessionIdFrom`: the local browser session.
- `sessionIdTo`: the RTC peer session.
- `rttMs`: the measured round-trip time.
- `createdAtEpochMs`: the browser wall-clock time when the measurement was
  reported.
- `version`: the heartbeat service version for that local peer relationship.

The middleware enqueues a WebSocket AL message on `AppTopics.rtt` with
`toBrowserRttHeartbeatMessage(...)`. The message is short-lived:
`BROWSER_RTT_HEARTBEAT_TTL_MS` is `15000`. Its route uses the unordered
`pairKey(sessionIdFrom, sessionIdTo)` as the route context and the measurement
version as the route resource id, so repeated measurements for the same pair
share a stable pair identity while still carrying versioned updates.

## Server Acceptance

Browser RTT reports are proposals. The server remains authoritative and runs
the same acceptance policy for in-memory and runtime-state storage before it
updates repositories, Vivaldi state, or topology queues.

The RTT topic rejects a report with one of these policy reasons:

- `invalid-rtt`: `rttMs` is missing, non-finite, zero, or negative.
- `self-pair`: `sessionIdFrom` and `sessionIdTo` are the same session.
- `sender-mismatch`: the AL sender does not match `sessionIdFrom`.
- `no-shared-active-group`: the endpoints are not both active members of any
  candidate scoped group.
- `not-reporting-edge`: the pair is not in the group's eligible reporting
  graph, using overlay next hops when a snapshot exists and deterministic
  bootstrap selection otherwise.
- `over-degree`: accepting the pair would put either endpoint over the
  reporting degree limit across accepted latest RTT pairs.

Accepted measurements keep the existing latest-pair semantics. The key is an
unordered session pair, newer versions win, and TTL remains in the existing
repository path. A stale or duplicate version is treated as a storage no-op:
it is not a policy rejection, and it does not update repositories, Vivaldi
state, global graph cache work, or topology recompute queues.

Without runtime-state storage, accepted measurements are stored in the shared
in-memory RTT repository with `rttRepository.setRtt(...)`. With runtime-state
storage, accepted measurements are written to
`RtcRttRepository.putMeasurementIfNewerWithEndpointLocks(...)` in the durable
`rtc-rtt:latest` namespace and mirrored into the in-memory repository. That
path rechecks policy inside deterministic endpoint and pair locks before
writing.

## How RTT Affects Topology

`RallarRtcTopologyService` is the supported API used by composition, benchmarks, and RTT topic
scheduling to build overlay topology snapshots for active groups. `RtcTopologyPlanner` owns kind
selection and the no-RTT-versus-weighted planning decision; `createRtcRoomGraph` owns weighted
sparse/complete graph construction. The default active topology degree limit is `5`, configurable
through `RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT` in API-v1. The RTT reporting limit defaults to that
effective topology degree unless `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT` is set.

For small rooms, the service selects `star` topology. For rooms at or above
`treeMinSize`, default `5`, it selects `tree`. For rooms at or above
`meshMinSize`, default `16`, it selects `mesh`.

The topology service has two broad planning modes:

- No RTT measurements: it uses deterministic fallback weights and optimized
  no-RTT paths for tree and mesh topology.
- RTT measurements present: it builds a sparse weighted candidate graph from
  accepted RTT edges plus deterministic fallback edges, capped by the reporting
  degree. If the sparse candidate graph cannot remain connected under the
  configured limit, the service falls back to the no-RTT topology plan and
  increments `weightedRoomGraphSparseFallbackCount`.

Before a group recompute uses stored latest-pair RTTs, the management layer
filters those samples through the same server reporting-edge policy for the
target group. Pair-global storage can retain a sample accepted for another
room, but that sample is ignored for any later room where the current overlay
or bootstrap reporting policy would reject the pair.

The resulting overlay snapshot includes:

- `activeSessionIds`: all active sessions in the group.
- `nextHopsBySessionId`: the RTC peers each session should actively use for
  overlay traffic.
- `degreeLimit`: the server degree limit used for the plan.
- `version`: incremented when the next-hop map changes.

Browsers receive `AppTopics.overlayTopology` snapshots over WebSocket. The
browser converts each snapshot into local `OverlayInfo`, including
`degreeLimit`, for its own session. `WebRtcGroupManager` then uses
`overlay.nextHopSessionIds` as both the steady-state desired RTC peer signal
and the preferred RTT reporting set.

Durable config and temporary override PUT/DELETE routes commit their optimistic
state change and queued `rtc-topology-recompute` intent atomically, adding the
first-writer idempotency record when `requestId` is supplied. Every response
includes a receipt. A retained config/override generation record keeps receipt
versions monotonic across physical deletion and override TTL expiry. A retained
group invariant generation serializes config and override decisions before
either can expose an invalid effective combination. Startup and first-access
backfill preserve config/override version floors before expiry cleanup, while
effective reads bracket the pair with the invariant generation. All topology
records use the canonical optional-workspace group-state key codec. Legacy
ambiguous topology source keys require the explicit offline
`migrateLegacyGroupTopologyConfigKeys` operation with old writers stopped;
ordinary startup and first access fail closed without moving them, and expiry
eviction stays disabled until startup backfill succeeds. Physical expiry is a
validated storage invariant: durable config and retained request/generation
rows are non-expiring, and override expiry must equal the value's
`expiresAtEpochMs`; malformed scope, child, JSON, or expiry metadata fails
before lazy deletion. Every retry re-evaluates active/unexpired group lifecycle
at a fresh attempt time for owners and platform admins alike. Stored write time
and relative override TTL remain fixed to the first non-replay attempt; a retry
after that expiry is rejected instead of extending or committing it. The
idempotency row stores only command identity plus the compact receipt. PUT
receipts must be applied, while DELETE can retain a legitimate no-op receipt;
mandatory nullable receipt timestamps reconstruct accepted PUT responses on
replay. Applied receipts also carry the mandatory five-field
`acceptedCausalRevision`; replay recomputes the deterministic
`rtc-topology-recompute` outbox identity from it and rejects a changed
`outboxId`. The topology transaction first CAS-touches the exact raw group row
used for lifecycle and actor authorization. That authority fence preserves all
group domain fields and its physical expiry, while advancing the causal group
revision used by the accepted outbox. A fence conflict rolls back topology,
idempotency, and outbox writes and reruns the full read/policy path. A no-op
receipt uses `acceptedCausalRevision: null` and queues no topology effect.
A request-id-bearing no-op still applies the fence before its idempotency claim;
the cached group domain view remains semantically unchanged, and a
minimum-revision read refreshes the causal-only advance when required.
DELETE uses
`Idempotency-Key` on REST (or `requestId` in the shared browser options) for
stable replay. They return after commit; outbox work performs recompute and
publication asynchronously and can retry independently.

API-v1 explicit REST reconfigure uses the shared recompute path that WS group snapshots,
RTT timers, and app-inbox topology work use. `POST
/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure`
commits a recompute request through AppInbox and returns a mandatory queued
receipt. Resource-inbox outbox work then applies request-time topology options
for one recompute, resolving durable config and temporary overrides before the
same service update, validation, persistence, and overlay publication steps.
Callers use the topology read path to observe eventual completion.

## Global Graphs And Vivaldi

RTT measurement limits reduce heartbeat and accepted-measurement input from
all-pairs reporting toward `O(N * K)`, but they do not by themselves make every
graph computation sparse.

The complete Vivaldi predicted graph API still materializes all predicted
edges among Vivaldi-known nodes when callers explicitly request it. A node
becomes Vivaldi-known after at least one valid RTT involving that node is
observed.

RTT-triggered global recompute now uses a degree-capped predicted graph path
and is coalesced by the existing RTT rebuild debounce. The initial capped
implementation still scans all Vivaldi-known pairs before selecting bounded
output edges, so true large-N CPU reduction will need spatial indexing or
candidate sampling.

## Operational Notes

The bounded reporting model preserves debounce and coalescing. Accepted updates
can still arrive in bursts when many clients open lanes, so existing
`rttRebuildDebounceMs`, runtime-state locks, and coalesced app-inbox work
remain useful.

Runtime-state and in-memory modes share the same acceptance policy. App-inbox
topology recompute reads the same filtered latest RTT set when runtime-state
repositories are configured.

Star topology remains constrained by the topology selection thresholds in the
default configuration: star is used for fewer than five sessions, so each
client has at most three next hops. If an operator raises `treeMinSize` or
lowers topology `degreeLimit`, validate the resulting overlay with topology
diagnostics before treating it as a production shape.

## Source Map

- `packages/shared/rtc/rtt-reporting-policy.ts`: shared degree normalization
  and deterministic RTT reporting peer selection.
- `packages/shared/services/WebRtcHeartbeatService.ts`: ping/pong heartbeat and
  RTT calculation.
- `packages/shared/services/WebRtcRxStreamerService.ts`: per-peer heartbeat
  ownership and `RttMeasurementInfo` creation.
- `packages/shared/services/WebRtcGroupManager.ts`: browser desired RTC peer
  selection and capped RTT reporting peer selection.
- `packages/shared-web/browser/middleware.ts`: browser RTT AL message creation,
  selected-peer heartbeat reconciliation, and WS enqueue.
- `packages/shared/repository/rtt-repository.ts`: in-memory latest RTT
  repository and unordered pair key.
- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts`:
  durable runtime-state latest RTT repository.
- `packages/shared-server/rallar-system/rtc-topology/policy/rtc-rtt-measurement-policy.ts`:
  server-side acceptance policy and rejection reasons.
- `packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts`:
  server RTT decoding, durable-versus-in-memory handoff, Vivaldi update, and
  topology refresh scheduling.
- `packages/shared-server/rallar-system/ws-system-topics.ts`: server topic
  composition and RTC RTT topic registration.
- `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`:
  supported topology API and process-lifecycle coordination.
- `packages/shared-server/rallar-system/topology/planning/rtc-topology-planner.ts`:
  topology kind and no-RTT-versus-weighted planning decisions.
- `packages/shared-server/rallar-system/topology/planning/create-rtc-room-graph.ts`:
  RTT-weighted sparse/complete room graph construction.
- `packages/shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts`:
  deterministic no-RTT dispatch, star/mesh calculation, and canonical output translation.
- `packages/shared-server/rallar-system/topology/planning/compute-no-rtt-tree-next-hops.ts`:
  deterministic no-RTT tree construction and distance state.
- `packages/shared-server/rallar-system/topology/planning/update-no-rtt-tree-attachment-selection.ts`:
  no-RTT tree parent and nearest-vertex selection policy.
- `packages/shared-graph/graph/vivaldi.ts`: complete and degree-capped Vivaldi
  predicted graph builders.
- `packages/shared/api/overlay-topology.ts`: overlay snapshot and per-session
  `OverlayInfo` conversion.
- `apps/api-v1/src/services/rtc-topology-config.ts`: API-v1 environment-backed
  topology and RTT reporting options.
