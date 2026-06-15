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
- `complete-graph-service.ts`, `mesh-dynamics.ts`, `tree-dynamics.ts`,
  `remove-dynamics.ts`, and related helpers implement topology generation and
  graph mutation strategies.
- `vivaldi.ts`, `graph-vivaldi-service.ts`, and RTT helpers support latency-aware
  topology decisions.
- `crdt-graph.ts` and graph repository modules provide graph storage and
  synchronization helpers where graph state needs to be shared or tested.

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
