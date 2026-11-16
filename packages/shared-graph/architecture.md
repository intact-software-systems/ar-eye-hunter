# Shared-Graph Architecture Notes

`packages/shared-graph` owns Rallar graph and topology services. It is the place
where graph-specific dependencies such as `graphology` belong; browser facade
entry points and runtime-neutral shared contracts should not accidentally import
those heavier graph implementations.

## Current Public Surface

- `mod.ts` is the package barrel for graph services, repositories, topology
  algorithms, Vivaldi helpers, and graph CRDT utilities.
- `GroupGraphService.ts` and `GroupGraphReadService.ts` compose group snapshot
  data into graph views used by RTC topology and diagnostics.
- `complete-graph/complete-graph-service.ts`, `graphs-mesh-service.ts`,
  `graphs-tree-service.ts`, `remove/**`, and related helpers implement
  topology generation and graph mutation strategies.
- `vivaldi.ts`, `graph-vivaldi-service.ts`, and RTT helpers support latency-aware
  topology decisions.
- `crdt-graph.ts` and graph repository modules provide graph storage and
  synchronization helpers where graph state needs to be shared or tested.

## Leaving a tree or a mesh

A member that left a room cannot forward for it, so a leave that keeps the
leaver in the graph as a forwarding-only vertex gives a layout the planner's
validation refuses (`validateGroupTopology`). The leave paths below do not keep
it.

What holds, and is tested: after `updateGroupTree` with
`removeAlgo: 'REMOVE_MINIMUM_COST_EDGE'`, or `updateGroupMesh` with
`removeAlgo: DynamicMeshAlgo.K_REMOVE_MC`, for a `TO_SERVER_LEAVE`, the leaver
is not a vertex of the result, the remaining members are connected, and no
member exceeds its degree limit.

Under which conditions it was tested: every single leave of five formed rooms
(trees of 8, 12 and 30, meshes of 20 and 30), degree limit 5, mesh parameter 2,
a complete global graph over the remaining members with the leaver absent from
it, in rooms without a director: no led room was tested, and no leader's leave.
The planner tests also run every single leave of measured rooms (RTT
measurements held for the pairs the members select), planned over a complete
graph in which an unmeasured pair is weighted above the slowest measured one.
The tests are
`packages/tests/shared-server/rallar-system/topology/planning/plan-record/resolve-topology-plan-change.test.ts`
(through the planner), `packages/tests/shared-graph/graphs-tree-service-leave.test.ts`
and `packages/tests/shared-graph/graphs-mesh-service-leave.test.ts`.

How:

- The cheapest-links remove links the leaver's neighbours with the cheapest
  edges of the global graph. When the pair it chooses is already linked, nothing
  is added and that neighbour counts as connected; the same step serves the four
  reconnect helpers of `remove/tree-dynamics-connect.ts`.
- A mesh leave that the capacity rule refuses (`hasReconnectCapacity`: the
  neighbours' spare degree plus their count is below twice their count minus
  two) results in the mesh without the leaver, when that mesh is connected. The
  mesh service asks the predicate before it calls the remove service.
- A tree leave runs through the remove facade with the algorithm the caller
  names (`GlobalTreeArgs.removeAlgo`).

The reconnect step only adds an edge that exists in the global graph it is
given. A sparse global graph can leave a neighbour with no candidate edge, and
the step then loops without end. The planner therefore gives a leave a complete graph.
Any other caller of the remove algorithms owes the same.

What is not guaranteed: in a led room a repaired tree can exceed the leader's
depth bound, so a leave can still be followed by a `leader-rooting` rebuild at
the next quiet plan (a reviewer measured 2 of 7 non-leader leaves in a led tree
of 8, none in led trees of 12 and 30). Outside those conditions the remove can refuse (a tree
then falls back to try-replace, which may keep the leaver as a forwarding
vertex; so does a mesh whose removal would cut it apart), and the reconnect
step relaxes the degree limit by one per round when no pair fits. The
relaxation is intended: it keeps the change to the layout small. Where it
produces a member over its limit, the result is invalid and the planner
rebuilds. A caller that needs the guarantee validates the result with
`validateGroupTopology`, as the planner does, and rebuilds.

The mesh parameter is not restored: a leave can leave a member with fewer than
k links.

The removes that keep the leaver as a Steiner vertex
(`REMOVE_TRY_REPLACE_MDDL_NAIVE` and the pruning variants) stay for a setting
where a departed peer can still forward; the planner does not select them.

## Boundaries

- Keep graph algorithms and `graphology` usage here or in apps that explicitly
  choose graph tooling.
- Do not add browser facade code, DOM APIs, WebSocket route handling, Postgres
  adapters, or app-specific game behavior to this package.
- Shared types that do not need graph dependencies should stay in
  `packages/shared`.
- Server routing and browser transport code may consume computed graph snapshots,
  but authorization and delivery decisions remain owned by shared-server and
  shared-web transport layers.

## Reliability Truths

- Graph snapshots should preserve scoped room identity with `GroupRef`. A bare
  `groupId` is not enough when one runtime can observe multiple workspaces.
- Overlay/topology removal and update paths should target the matching scoped
  graph/overlay, not every room that happens to share an id.
- Graph services are best treated as pure or mostly pure transforms over
  snapshots, RTT data, and configuration. Keep IO at repository boundaries.
- Topology changes affect RTC multicast and game/motion delivery reliability, so
  tests should prove same-id/different-scope isolation, removal behavior, and
  deterministic graph output where possible.

## Validation

Common package-focused checks:

```bash
npx tsc -p packages/shared-graph/tsconfig.json --noEmit
npx vitest run packages/tests/shared-graph
```

When changing topology behavior, also run the nearest shared RTC/multicast tests
under `packages/tests/shared/**` that consume graph results.
