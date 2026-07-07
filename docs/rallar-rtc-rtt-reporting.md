# Rallar RTC RTT Reporting

This document explains how RTC round-trip time (RTT) measurements currently
move from Rallar browser clients to Rallar Server, how the server uses those
measurements for RTC overlay topology, and how Rallar can evolve toward a
bounded RTT reporting model where each client reports at most K measurement
edges.

The bounded model described here is analysis only. It is not implemented by the
current runtime.

## Current Reporting Path

RTT reporting starts on an open RTC data channel between two browser sessions.
`WebRtcHeartbeatService` sends a heartbeat ping every
`defaultPingFrequencyMsecs` milliseconds, currently `5000`. Each ping payload
uses `performance.now()` as the timestamp. The remote peer responds with a pong
that echoes the timestamp, and the sender computes RTT as the rounded
difference between the local current `performance.now()` and the echoed value.

When a pong is observed, `WebRtcHeartbeatService` emits a `PingResult` with the
remote peer session id, the measured RTT in milliseconds, and a per-heartbeat
version counter. `WebRtcRxStreamerService` owns one heartbeat service per RTC
peer. It converts each heartbeat result into `RttMeasurementInfo`:

- `sessionIdFrom`: the local browser session.
- `sessionIdTo`: the RTC peer session.
- `rttMs`: the measured round-trip time.
- `createdAtEpochMs`: the browser wall-clock time when the measurement was
  reported.
- `version`: the heartbeat service version for that local peer relationship.

The browser middleware registers an RTT measurement callback on
`rtcRxStreamer`. For each measurement, it enqueues a WebSocket AL message on
`AppTopics.rtt` by calling `toBrowserRttHeartbeatMessage(...)`. That message is
short-lived: `BROWSER_RTT_HEARTBEAT_TTL_MS` is `15000`. Its route uses the
unordered `pairKey(sessionIdFrom, sessionIdTo)` as the route context and the
measurement version as the route resource id, so repeated measurements for the
same pair share a stable pair identity while still carrying versioned updates.

The server installs the RTT topic through `initRallarSystemWsTopics(...)`.
`initRttTopic(...)` parses the AL payload as `RttMeasurementInfo`, then calls
`acceptRtcRttMeasurement(...)`. Without runtime-state storage, the measurement
is accepted into the shared in-memory RTT repository with
`rttRepository.setRtt(...)`. With runtime-state storage, the server writes to
`RtcRttRepository.putMeasurementIfNewer(...)`, backed by the durable
`rtc-rtt:latest` namespace, and mirrors accepted values into the in-memory
repository.

Both storage paths use the unordered session-pair key and accept only newer
versions for that pair. The latest measurement is therefore pairwise and
direction-agnostic for topology input, even though the measurement was reported
by one endpoint.

After a new RTT is accepted, the server updates Vivaldi state through
`vivaldiService.observeRtt(...)`, attempts to recompute the global graph cache,
and schedules RTC overlay topology work for groups affected by the measured
pair. Affected groups are found by session ids: any group containing either RTT
endpoint can be considered for recompute. When `rtcTopologyAppInbox` is
configured, recompute work is coalesced through the durable app inbox. Otherwise
it is debounced in process with `RallarRtcTopologyService.queueRttTopologyUpdate`
and a local timer.

When topology is recomputed, the server reads current RTT measurements. In
runtime-state mode it reads measurements whose endpoints are both active in the
target group. Without runtime-state mode it reads all in-memory RTT
measurements, and the topology service only uses the measurements that match
edges in the target room graph.

## How RTT Affects Topology

`RallarRtcTopologyService` builds an overlay topology snapshot for each active
group. The default active topology degree limit is `5`, configurable through
`RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT` in API-v1.

For small rooms, the service currently selects `star` topology. For rooms at or
above `treeMinSize`, default `5`, it selects `tree`. For rooms at or above
`meshMinSize`, default `16`, it selects `mesh`.

The topology service has two broad planning modes:

- No RTT measurements: the service uses deterministic fallback weights based on
  session order, with optimized no-RTT paths for tree and mesh topology.
- RTT measurements present: the service materializes a complete room graph and
  uses RTT values as edge weights where available. Missing RTTs fall back to
  deterministic weights.

The resulting overlay snapshot includes:

- `activeSessionIds`: all active sessions in the group.
- `nextHopsBySessionId`: the RTC peers each session should actively use for
  overlay traffic.
- `degreeLimit`: the server degree limit used for the plan.
- `version`: incremented when the next-hop map changes.

Browsers receive `AppTopics.overlayTopology` snapshots over WebSocket. The
browser converts each snapshot into local `OverlayInfo` for its own session.
`WebRtcGroupManager` then uses `overlay.nextHopSessionIds` as the desired RTC
peer set when a scoped overlay is available. Before an overlay is available, the
browser can fall back to group peers from the room snapshot.

This is important for RTT reporting: today RTT measurements are produced for
open RTC peers. The server controls the steady-state overlay degree by
publishing bounded next hops, but the RTT reporting set is not separately
bounded by an explicit RTT-reporting policy.

## Current Constraints And Gaps

Current RTT reporting is opportunistic. A browser reports measurements for RTC
peers that have an open data channel and heartbeat service. The runtime does
not expose a separate "RTT reporting degree" setting.

The server RTT topic accepts newer values by unordered pair. Topic-local checks
do not currently prove that:

- the AL sender matches `sessionIdFrom`;
- `sessionIdFrom` and `sessionIdTo` are both active members of a shared scoped
  group;
- the reported pair is part of an allowed reporting set;
- accepting the pair keeps every reporting client under a degree limit.

Some of those constraints are indirectly encouraged by the rest of the system:
RTC peers are normally created from group membership and overlay next hops, and
the topology recompute path filters to active group endpoints in runtime-state
mode. They are not enforced as an RTT-topic acceptance policy.

Storage also differs by mode. Runtime-state mode keeps latest durable
measurements in `rtc-rtt:latest` with TTL, and reads group-local measurements
for topology. Non-runtime-state mode stores latest RTTs in process and reads all
current measurements before the topology service ignores non-room pairs.

Finally, the default topology thresholds keep normal star rooms below the
default degree limit: star is used for fewer than five sessions, so each client
has at most three next hops. The star path itself does not enforce
`degreeLimit`. If an operator raises `treeMinSize` or lowers `degreeLimit`, a
star snapshot can publish more next hops than the configured limit.

## Bounded RTT Reporting Model

The recommended model is to bound RTT measurement/reporting edges, not browser
connection retention. `rtc.maxPeerConnections` should remain the browser cap for
retained RTC peer connections so room transitions can stay smooth. RTT reporting
should have its own degree K.

K should default to the server topology `degreeLimit`. A future public surface
could make this explicit with a browser option such as
`rtc.rttReportingDegreeLimit?: number` and a server option such as
`rttReportingDegreeLimit?: number`, defaulting to the active topology degree
limit. If the public option is not added, the browser can derive K from the
published overlay snapshot's `degreeLimit` once available.

### Browser Selection

The browser should pick at most K peers to report RTTs for each local session.

Steady-state selection should prefer the current overlay next hops:

1. Read `overlay.nextHopSessionIds` for each active room.
2. Union those peers across the rooms this session owns.
3. Keep at most K peers with deterministic ordering.
4. Start or keep heartbeat reporting only for those selected peers.

Bootstrap selection needs a bounded path before the first overlay arrives. It
should use deterministic candidates from active room peers, excluding self and
offline peers, capped at K. The deterministic ordering should be stable across
clients and workers, for example by sorted session id or by a rendezvous hash of
`localSessionId`, `peerSessionId`, and scoped group id. That avoids every client
choosing the same central peers when a room first forms.

The selected reporting peers do not need to be the only retained RTC
connections. A browser may keep inactive or transition peers up to
`rtc.maxPeerConnections`, but only selected peers should enqueue RTT messages.

### Server Acceptance

The server should treat RTT reports as proposals until validated. Acceptance
should keep the current "newer version wins" and TTL behavior, but add policy
checks before storing:

- Reject self pairs.
- Reject non-finite or non-positive `rttMs`.
- Reject reports where the AL sender does not match `sessionIdFrom`.
- Find shared active scoped groups for the pair and reject pairs with no shared
  active group.
- For each affected group, accept the pair only if it belongs to that group's
  eligible reporting graph and keeps both endpoints within the reporting degree
  K.

The eligible reporting graph should be deterministic and based on server truth.
When a topology snapshot exists, the simplest policy is to accept pairs that are
current overlay edges for the group. During bootstrap, the server can compute
the same deterministic capped candidate set used by the browser, or it can
derive a temporary bounded graph from the active group snapshot. Either way,
the server must remain authoritative; browser selection is only a client-side
load reduction.

In runtime-state mode, the server should persist only accepted measurements in
`rtc-rtt:latest`. App-inbox recompute work should read the same filtered latest
set. In non-runtime-state mode, the in-memory repository should use the same
acceptance path so single-worker behavior and durable behavior do not diverge.

## Implementation Considerations

The bounded model should preserve partial-measurement behavior. Topology
planning already tolerates incomplete RTT coverage by falling back to
deterministic weights for missing edges. A bounded model should lean on that
rather than attempting all-pairs measurement.

The model should also preserve debounce and coalescing. Bounded reporting
reduces the number of RTT messages, but accepted updates can still arrive in
bursts when many clients open lanes. Existing `rttRebuildDebounceMs`,
runtime-state locks, and coalesced app-inbox work remain useful.

Star topology needs special treatment if the bounded model becomes a runtime
contract. Either star should stay constrained to sizes where
`activeSessionIds.length - 1 <= degreeLimit`, or the star path should be
replaced with a degree-limited fallback when custom thresholds would exceed the
limit.

The same bounded eligibility helper should be shared by:

- browser-side reporting selection;
- server-side RTT acceptance;
- topology tests that assert max degree;
- diagnostics that explain why a peer is connected but not reporting RTT.

API-v1 REST reconfigure uses the shared recompute path that WS group-snapshot,
RTT timer, and app-inbox topology work use. `POST
/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure`
can apply request-time topology options for one recompute, while durable config
and temporary overrides are resolved before the same `RallarRtcTopologyService`
update, validation, persistence, and overlay publication steps.

## Suggested Future Tests

Future runtime support should include focused tests for these scenarios:

- Browser reports at most K RTT peers per client even when more RTC peers are
  known or retained.
- Browser prefers overlay `nextHopSessionIds` for reporting after receiving an
  overlay snapshot.
- Bootstrap selection is deterministic and capped before overlay topology
  arrives.
- Server rejects stale, self, nonmember, sender-mismatched, invalid, and
  over-degree RTT pairs.
- Runtime-state and in-memory RTT acceptance use the same filtering behavior.
- App-inbox topology recompute reads the same filtered latest RTT set.
- Topology remains connected and degree-bounded with no RTTs, partial RTTs, and
  dense RTTs.
- Star topology honors the configured degree limit under custom `treeMinSize`
  and `degreeLimit` settings.

## Source Map

- `packages/shared/services/WebRtcHeartbeatService.ts`: ping/pong heartbeat and
  RTT calculation.
- `packages/shared/services/WebRtcRxStreamerService.ts`: per-peer heartbeat
  ownership and `RttMeasurementInfo` creation.
- `packages/shared-web/browser/middleware.ts`: browser RTT AL message creation
  and WS enqueue.
- `packages/shared/repository/rtt-repository.ts`: in-memory latest RTT
  repository and unordered pair key.
- `packages/shared-server/rallar-system/repositories/RtcRttRepository.ts`:
  durable runtime-state latest RTT repository.
- `packages/shared-server/rallar-system/ws-system-topics.ts`: server RTT topic,
  acceptance, Vivaldi update, and topology recompute scheduling.
- `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`:
  RTT-weighted room graph construction and overlay topology planning.
- `packages/shared/services/WebRtcGroupManager.ts`: browser desired RTC peer
  selection from overlay next hops.
- `packages/shared/api/overlay-topology.ts`: overlay snapshot and per-session
  `OverlayInfo` conversion.
- `apps/api-v1/src/services/rtc-topology-config.ts`: API-v1 environment-backed
  topology options.
