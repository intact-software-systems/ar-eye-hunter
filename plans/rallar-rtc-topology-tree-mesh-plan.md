# Rallar RTC Tree And Mesh Topology Plan

Date: 2026-06-04

## Summary

Rallar should use three server-authoritative RTC overlay shapes by active group
size:

- `1-4` sessions: star overlay.
- `5-15` sessions: degree-limited tree overlay.
- `16+` sessions: degree-limited mesh overlay.

Use `packages/shared-graph/graphs-tree-service.ts` and
`packages/shared-graph/graphs-mesh-service.ts` as the shared-graph core
services. Rallar should not call low-level tree or mesh algorithms directly; it
should call a Rallar topology wrapper that delegates creation and update work to
these core services and converts the result into compact RTC next-hop overlays.

## Current Repo Alignment

- `graphs-tree-service.ts` now exposes `createGroupTree(...)` and
  `updateGroupTree(...)`, with strict member-only, degree-limited behavior for
  Rallar topology creation.
- `graphs-mesh-service.ts` now exposes `createGroupMesh(...)` and
  `updateGroupMesh(...)`, validates member-only output, honors remove behavior,
  and evaluates reconfiguration against the updated mesh.
- Rallar builds room-local weighted graphs for active room sessions only, with
  member degree limit `5` baked into graph attributes and nodes.
- `AppTopics.overlayTopology` exists as the compact routing-overlay topic, while
  `AppTopics.graphs` remains diagnostic or legacy graph data.
- `OverlayId` is a scoped string derived from `GroupRef`, and browser overlay
  lookup applies snapshots by scoped group identity.
- `WebRtcGroupManager` reconciles desired RTC peers from overlay next hops, with
  star fallback before the first server topology snapshot.
- RTT measurements are stored in the RTT repository, used as graph weights, and
  now trigger debounced, coalesced topology rebuilds for affected cached groups.

## Key Changes

- Add a server-side Rallar topology service that owns scoped `GroupRef`
  topology state, versions, membership diffs, RTT dirty state, and publish
  decisions.
- Build a complete weighted graph for active room sessions only, with
  `degreeLimitMember = 5` and per-node `degreeLimit = 5`.
- Extend `graphs-tree-service.ts` with an explicit create/rebuild entrypoint,
  not only dynamic enter/leave update.
- Use `updateGroupTree(...)` for single-member tree joins/leaves when the
  previous tree is valid.
- Use `updateGroupMesh(...)` for single-member mesh joins/leaves when the
  previous mesh is valid.
- Use full rebuild when topology tier changes, membership changes by more than
  one session, RTT debounce fires, dynamic update fails, degree validation
  fails, or the graph contains non-active sessions.
- Keep `meshParamK = 2`; the new `5` value is the maximum node degree, not the
  number of edges every peer should target.
- Disable non-room Steiner relays in v1. If shared-graph dynamics retain a
  departed peer as a Steiner/core node, discard that result and rebuild
  member-only.

## Shared-Graph Service Adjustments

`graphs-tree-service.ts` should become the tree core service:

- Add `createGroupTree(...)` or equivalent rebuild API.
- Select a central source from the weighted room graph.
- Enforce member-only output for Rallar mode.
- Support strict degree behavior, because current
  `mddlOTTC(..., relaxDegreeByOne)` can relax beyond the configured limit.

`graphs-mesh-service.ts` remains the mesh core service, but needs cleanup before
Rallar depends on it:

- Evaluate reconfiguration against the updated group mesh, not the global graph.
- Pass the updated mesh into reconfiguration.
- Honor configured remove algorithm or remove the unused option.
- Expose failure metadata so Rallar can rebuild or fall back cleanly.
- Support member-only, degree-limited output.

Add graph validation helpers used by both services:

- All active sessions are present.
- No inactive sessions are present.
- Graph is connected when size is greater than one.
- Every node degree is `<= 5`.

## Runtime Behavior

- Publish compact `overlay.topology` snapshots with
  `topology: 'star' | 'tree' | 'mesh'`.
- Convert graph edges into `nextHopsBySessionId`, where each session receives
  its direct graph neighbors.
- Browser stores only its own next hops in `OverlayInfo.nextHopSessionIds`.
- `WebRtcGroupManager` should use overlay next hops as desired RTC peers, with
  star fallback before the first topology snapshot.
- Existing `graphs` snapshots remain diagnostic or legacy data, not the primary
  browser routing input.
- Use scoped overlay keys derived from `GroupRef`, not raw `groupId`.
- Group snapshot and membership changes publish immediately when the next-hop
  map changes.
- RTT-triggered rebuilds are queued per scoped overlay and published after the
  debounce window only if the recomputed next-hop map changed.

## Test Plan

Tree service tests:

- Create tree for 5, 10, and 15 members.
- Dynamic join/leave preserves connectivity.
- Every node degree remains `<= 5`.
- No departed member remains as Steiner/core in Rallar member-only mode.
- Strict rebuild fails clearly or falls back to bounded-degree member-only tree.

Mesh service tests:

- Create/update mesh for 16+ members.
- Every node degree remains `<= 5`.
- Reconfiguration uses the updated group mesh.
- Dynamic failures return enough metadata for rebuild fallback.

Server topology tests:

- `4 -> 5` transitions star to tree.
- `15 -> 16` transitions tree to mesh.
- `16 -> 15` transitions mesh to tree.
- RTT debounce triggers rebuild.
- Unchanged next-hop maps are not republished.

Browser/runtime tests:

- Applies `overlay.topology` by scoped `GroupRef`.
- Desired RTC peers match local next hops.
- Group growth does not create full-mesh RTC connections.

## Implementation Priority

Start with the smallest topology slice that can be tested without changing the
entire product API:

1. [x] Add shared-graph create/rebuild APIs and validation helpers for
   member-only, degree-limited tree and mesh graphs.
2. [x] Fix `graphs-mesh-service.ts` reconfiguration so it evaluates and
   reconfigures the updated group mesh, honors remove behavior, and reports
   failure metadata.
3. [x] Add the server-side Rallar topology service with star/tree/mesh size
   selection and scoped per-group state.
4. [x] Add compact `overlay.topology` snapshots and publish only changed
   next-hop maps.
5. [x] Update browser overlay application and `WebRtcGroupManager` so desired
   RTC peers follow overlay next hops with star fallback.
6. [x] Add integration coverage for group growth, group shrinkage,
   RTT-triggered rebuild, RTT debounce/coalescing, app-inbox RTT recompute
   ownership, and no full-mesh connection growth.

## Remaining Follow-Up

- Group-snapshot and RTT-triggered recomputes now have an opt-in app-inbox
  ownership path using a fixed key per scoped overlay. Multi-worker topology
  continuity is supported when `rtcTopologyRuntimeState` is configured: previous
  overlay snapshots are stored in `rtc-topology:snapshots`, and latest accepted
  RTT inputs are stored in `rtc-rtt:latest`.
- Large audio/video groups still need an SFU/relay architecture; this plan's
  tree and mesh overlays are for RTC data-channel routing and multicast.

## Assumptions

- Size boundaries are inclusive: tree is `5-15`, mesh starts at `16`.
- Degree limit `5` is strict for both tree and mesh overlays.
- Star remains acceptable for groups up to `4` because max degree is then `3`.
- v1 overlays only use active room sessions as relay nodes.
