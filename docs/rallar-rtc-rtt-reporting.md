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
`degreeLimit`. API-v1 configuration requires
`RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT` to be a positive integer; invalid,
zero, negative, or fractional values fail configuration decoding. In a
lower-level shared-server composition where the server option is omitted,
`normalizeRttReportingDegreeLimit` falls back to the effective topology
`degreeLimit`, then to `5` if that fallback is invalid.

On the server that fallback is resolved per group, not once per process.
RTC-RTT has one API-v1 acceptance path on every database backend.
`install-rtc-rtt-system-topic.ts` decodes the WebSocket payload and enqueues a
durable AppInbox mutation. `rtc-rtt-app-inbox-handler.ts` verifies its authority
and asks `create-api-v1-topology-services.ts` for the candidate groups, overlay
snapshots, and reporting degree. The read-side planning filter uses the same
`readRttReportingDegreeLimit` policy. An explicitly configured
`RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT` therefore wins. Shared-server
compositions that omit the option fall back to each group's effective
`degreeLimit`. A report whose endpoints both hold live sessions in several
groups is accepted under the largest resolved limit. Acceptance and planning
agreeing on this policy is what lets formation readiness cover a plan whose
degree exceeds the server default; see
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
explicit RTT reporting degree, it uses the smallest `degreeLimit` among the
overlays it holds for the groups it is in — server-published or locally
bootstrapped — once at least one overlay snapshot is available
(`computeOverlayRttReportingDegreeLimit`). Before that, bootstrap selection
falls back to the shared default.

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

- Each unordered session pair has exactly one reporter: the endpoint with the
  lexically smaller session id. The other endpoint can keep the RTC lane open,
  but does not run the pair's RTT heartbeat or publish a competing version
  stream.
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

Browser RTT reports are proposals. The server remains authoritative. The
durable AppInbox mutation validates policy before it writes the current
runtime-state measurement, receipt, endpoint admission, and topology outbox
work in one transaction.

The RTT topic rejects a report with one of these policy reasons:

- `invalid-rtt`: `rttMs` is missing, non-finite, zero, or negative.
- `self-pair`: `sessionIdFrom` and `sessionIdTo` are the same session.
- `sender-mismatch`: the AL sender does not match `sessionIdFrom`.
- `non-canonical-reporter`: `sessionIdFrom` is not the lexically smaller
  endpoint that owns reporting for the unordered pair.
- `no-shared-active-group`: the endpoints are not both active members of any
  candidate scoped group.
- `not-reporting-edge`: the pair is not in the group's eligible reporting
  graph under overlay next-hop or deterministic bootstrap selection.
- `over-degree`: accepting the pair would put either endpoint over the
  reporting degree limit across accepted latest RTT pairs.

Accepted measurements use latest-pair semantics. The key is an unordered
session pair. Canonical reporter ownership gives that pair one heartbeat
version stream, so independently initialized counters from the two endpoints
cannot contend for the same pair and version. Newer versions win, and current
runtime-state rows expire under the RTC-RTT retention policy. A stale or
duplicate version is a no-op: it does not write measurement, receipt, endpoint
admission, or topology work. The mutation guards the pair and both
endpoint-admission rows so concurrent reports cannot exceed the reporting
degree.

## How RTT Affects Topology

`RallarRtcTopologyService` is the supported API used by composition, benchmarks, and topology work
to build overlay topology snapshots for active groups. `RtcTopologyPlanner` owns kind
selection and the no-RTT-versus-weighted planning decision; `createRtcRoomGraph` owns weighted
sparse/complete graph construction. The default active topology degree limit is `5`, configurable
through `RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT` in API-v1. The API-v1 RTT reporting limit also defaults
to `5` and is configured independently through `RALLAR_RTC_RTT_REPORTING_DEGREE_LIMIT`.
Lower-level shared-server compositions fall back to the effective topology degree only when the
reporting option is omitted.

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

Durable config and temporary override PUT/DELETE routes go through AppInbox.
They atomically apply the optimistic state change, current idempotency receipt,
group-authority fence, generation guards, and queued `rtc-topology-recompute`
intent. Current stored rows use the canonical scoped group identity. Exact
decoders reject malformed scope, JSON, revision, causal receipt, or expiry
metadata at the corruption boundary; there is no runtime migration or alternate
key reader. Every retry re-reads active group lifecycle and authority. A
conflict rolls back the whole transaction and retries the complete
read/compute/validate/write flow. No-op receipts queue no topology effect.
Successful routes return after commit; outbox work performs recompute and
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

AppInbox topology recompute reads the current filtered RTC-RTT measurements
from the runtime-state repository.

Star topology remains constrained by the topology selection thresholds in the
default configuration: star is used for fewer than five sessions, so each
client has at most three next hops. If an operator raises `treeMinSize` or
lowers topology `degreeLimit`, validate the resulting overlay with topology
diagnostics before treating it as a production shape.

## Source Map

- `packages/shared/rtc/rtt-reporting-policy.ts`: shared canonical reporter,
  degree normalization, and deterministic RTT reporting peer selection.
- `packages/shared/services/WebRtcHeartbeatService.ts`: ping/pong heartbeat and
  RTT calculation.
- `packages/shared/services/WebRtcRxStreamerService.ts`: per-peer heartbeat
  ownership and `RttMeasurementInfo` creation.
- `packages/shared/services/WebRtcGroupManager.ts`: browser desired RTC peer
  selection and capped RTT reporting peer selection.
- `packages/shared-web/browser/connection/initialise-browser-middleware.ts`:
  browser RTT AL message creation,
  selected-peer heartbeat reconciliation, and WS enqueue.
- `packages/shared/repository/rtt-repository.ts`: in-memory latest RTT
  repository and unordered pair key.
- `packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts`:
  durable runtime-state latest RTT repository.
- `packages/shared-server/rallar-system/rtc-rtt/policy/rtc-rtt-measurement-policy.ts`:
  server-side acceptance policy and rejection reasons.
- `packages/shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts`:
  exact RTC RTT decoding and durable mutation enqueue.
- `packages/shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-app-inbox-handler.ts`:
  authority verification and read/compute/validate/write mutation entry.
- `apps/api-v1/src/composition/create-api-v1-topology-services.ts`:
  candidate-group, topology-policy, measurement persistence, and topology
  refresh dependencies.
- `packages/shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts`:
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
- `apps/api-v1/src/configuration/api-v1-configuration.ts` and
  `apps/api-v1/src/configuration/decode-api-v1-configuration.ts`: current
  API-v1 topology and RTT reporting configuration contract and validation.
