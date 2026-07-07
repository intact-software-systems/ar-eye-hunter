# API V1 Graph Topology Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Build the scoped graph diagnostics and group topology management REST product described in `playground/api-v1-graph-topology-management-design.md`, while preserving legacy graph endpoints and reusing existing Rallar graph, group-state, runtime-state, auth, and topology infrastructure.

## Source Inputs Inspected

- `playground/api-v1-graph-topology-management-design.md`
- `AGENTS.md` instructions from the conversation
- `skills/rallar-platform/SKILL.md`
- `skills/rallar-platform/references/package-map.md`
- `skills/rallar-realtime/SKILL.md`
- `skills/rallar-code-writing/SKILL.md`
- `skills/rallar-code-writing/references/package-code-style.md`
- `skills/rallar-testing/SKILL.md`
- `skills/rallar-testing/references/test-commands.md`
- `apps/api-v1/src/routes/graph-routes.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `apps/api-v1/src/routes/client-state-routes.ts`
- `apps/api-v1/src/routes/crdt-admin-routes.ts`
- `apps/api-v1/src/routes/config-route.ts`
- `apps/api-v1/src/create-rallar-server.ts`
- `apps/api-v1/src/middleware.ts`
- `apps/api-v1/src/services/rtc-topology-config.ts`
- `apps/api-v1/src/repository/createStateRepositories.ts`
- `apps/api-v1/resources/api-v1-openapi.yaml`
- `apps/api-v1/deno.json`
- `packages/shared/api/group-types.ts`
- `packages/shared/api/state-types.ts`
- `packages/shared/api/api-type-utils.ts`
- `packages/shared/api/overlay-topology.ts`
- `packages/shared-web/browser/api-integration.ts`
- `packages/shared-web/browser/data-caches.ts`
- `packages/shared/services/WebRtcGroupManager.ts`
- `packages/shared/repository/overlays-repository.ts`
- `packages/shared-graph/group-graphs-create-service.ts`
- `packages/shared-graph/repository/graphs-repository.ts`
- `packages/shared-graph/shared-graph-types.ts`
- `packages/shared-graph/architecture.md`
- `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- `packages/shared-server/rallar-system/ws-system-topics.ts`
- `packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts`
- `packages/shared-server/rallar-system/repositories/RtcRttRepository.ts`
- `packages/shared-server/runtime-state/RuntimeStateJsonStore.ts`
- `packages/shared-server/runtime-state/RuntimeStateRepository.ts`
- `packages/shared-server/rallar-system/group-policy.ts`
- `packages/shared-server/mod.ts`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `apps/api-v1/test/rallar-server.test.ts`
- `apps/api-v1/test/swagger-routes.test.ts`
- `packages/tests/shared-graph/group-graph-services.test.ts`
- `packages/tests/shared-graph/graphology-serialization.test.ts`
- `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`
- `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
- `packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`
- `packages/tests/shared-server/fake-runtime-state-repository.ts`
- `packages/tests/shared-web/api-workflows.test.ts`
- `apps/rallar-black-box/src/rallar-server-workbench.ts`
- `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`
- `.github/workflows/release-gate.yml`
- `.github/workflows/branch-release-gate.yml`
- root `package.json`

## Repo Truths

- `apps/api-v1` is the Deno/Hono server shell. It composes routes and shared-server services; it should not own reusable graph or topology domain behavior.
- `packages/shared` owns graph/topology REST contract types that do not require graphology.
- `packages/shared-graph` owns graphology types, graph algorithms, diagnostic graph creation, graph repositories, and graph serialization helpers.
- `packages/shared-server` owns runtime-state repositories, group policy, state sync, WS topics, RTC topology services, and server-side orchestration.
- `packages/shared-web` must not depend directly on `graphology`; browser helper types should consume JSON-safe DTOs from `packages/shared`.
- Group/client REST routes already use `/api/state/apps/:applicationId/workspaces/:workspaceId/...` and local route dependency injection for tests.
- Group update authorization already exists as `canUpdateGroupSnapshot(...)`: active group owners/admins are allowed.
- Platform admin by client id already exists as a pattern through `AUTH_ADMIN_CLIENT_IDS` in config and CRDT admin routes.
- Runtime-state JSON stores already provide namespaced persistence, scoped keys, expiry, and transactional key locks. New topology config does not need a database migration because it can use `runtime_state_store`.
- `RtcTopologySnapshotRepository` and `RtcRttRepository` already provide durable topology snapshots and latest RTT measurements when runtime state is configured.
- `initRallarSystemWsTopics(...)` already supports `rtcTopologyRuntimeState` and `rtcTopologyAppInbox`, but `apps/api-v1/src/create-rallar-server.ts` currently passes neither.
- Current browser routing behavior follows `AppTopics.overlayTopology`; `AppTopics.graphs` is diagnostic/legacy and should not become the live routing source.
- CI is real: `.github/workflows/release-gate.yml` runs `npm run test:ci`, builds deployable apps, runs Deno checks, applies Postgres migrations, and runs Postgres full-stack smoke tests.

## API Contract Summary

Base path:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId
```

Add graph diagnostics:

- `GET /graphs/global?includeMeasured=true&refresh=if-missing`
- `GET /groups/:groupId/graphs/latest?includeMeasured=true&refresh=if-missing`

Add topology management:

- `GET /groups/:groupId/topology`
- `GET /groups/:groupId/topology/config`
- `PUT /groups/:groupId/topology/config`
- `DELETE /groups/:groupId/topology/config`
- `GET /groups/:groupId/topology/override`
- `PUT /groups/:groupId/topology/override`
- `DELETE /groups/:groupId/topology/override`
- `POST /groups/:groupId/topology/reconfigure`

Configuration resolution order:

```text
server defaults -> durable group config -> temporary override -> request-time reconfigure options
```

Topology config fields:

- `topologyKind?: 'auto' | 'star' | 'tree' | 'mesh'`
- `degreeLimit?: number`
- `treeMinSize?: number`
- `meshMinSize?: number`
- `meshParamK?: number`

Write authorization:

- active group owner/admin can manage their group
- platform admin client id can manage any group

Read authorization:

- follow existing strict-read behavior for full group state reads

Legacy compatibility:

- keep `GET /api/graph`
- keep `GET /api/graph/tree/:groupId`
- mark both deprecated in OpenAPI and prefer scoped routes

## Current-Code Conflicts To Resolve

- `apps/api-v1/src/routes/graph-routes.ts` exposes only unscoped graph routes.
- `computeGlobalGraphAndCacheIt()` reads all process client snapshots and uses `GLOBAL_GRAPH_REF = { applicationId: 'global', workspaceId: 'global', groupId: DEFAULT_GRAPH_PROP.id }`, which conflicts with scoped `/graphs/global`.
- `apps/api-v1/resources/api-v1-openapi.yaml` describes graph schemas with `graphId`, but runtime `GraphInfoSnapshot` uses `groupRef`.
- `RallarRtcTopologyServiceOptions` does not include `topologyKind`, and `RallarRtcTopologyService.updateGroupTopology(...)` cannot accept per-request effective config.
- RTC topology recompute/publish helpers are private in `packages/shared-server/rallar-system/ws-system-topics.ts`, so REST routes cannot reuse them yet.
- `apps/api-v1/src/create-rallar-server.ts` does not pass `rtcTopologyRuntimeState` or `rtcTopologyAppInbox` into `initRallarSystemWsTopics(...)`, so current API-v1 topology is process-local by default.
- `apps/rallar-black-box/src/rallar-server-workbench.ts` still lists only `/api/graph` and `/api/graph/tree/{groupId}` for graph diagnostics.

## Decisions And Tradeoffs

- Keep graph diagnostics and topology management separate. Graph diagnostics return JSON-safe graph snapshots; topology management returns the live RTC distribution plan.
- Store durable and temporary topology config in new shared-server runtime-state repositories, not inside `Group.metadata`. This keeps group product state separate from server transport controls.
- Extend the existing RTC topology service to accept effective options per update rather than creating a second topology algorithm.
- Extract topology recompute/publish behavior from `ws-system-topics.ts` into a shared-server service/coordinator. WS topics and REST routes must call the same code path.
- Make route modules dependency-injected like existing state routes so Deno route tests can run without Postgres or real WS.
- Add browser/shared-web helper functions and black-box workbench presets only after server contracts exist. They are compatibility/product-surface helpers, not the source of truth.
- Do not add manual graph node/edge editing. REST callers configure and reconfigure topology; graph algorithms remain authoritative.

## Non-Goals

- No manual REST editing of graph nodes or edges.
- No historical durable storage for diagnostic graph snapshots.
- No new database migration for topology config; use existing `runtime_state_store`.
- No new web framework, queue system, or persistence framework.
- No replacement of existing client/group state routes.
- No removal of legacy `/api/graph` routes in this work.
- No role-based platform admin model beyond the existing `AUTH_ADMIN_CLIENT_IDS` client-id convention.
- No SFU/media-relay architecture changes.

## Files By Responsibility

Shared REST contract types:

- Create `packages/shared/api/graph-topology-management-types.ts`
- Modify `packages/shared/mod.ts`

Graph diagnostics:

- Modify `packages/shared-graph/shared-graph-types.ts`
- Create `packages/shared-graph/graph-diagnostics-serialization.ts`
- Modify `packages/shared-graph/group-graphs-create-service.ts`
- Modify `packages/shared-graph/mod.ts`
- Modify `packages/tests/shared-graph/group-graph-services.test.ts`
- Modify `packages/tests/shared-graph/graphology-serialization.test.ts`

Topology config persistence:

- Create `packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-config-repository.test.ts`

Topology config resolution and validation:

- Create `packages/shared-server/rallar-system/services/group-topology-config-service.ts`
- Create `packages/tests/shared-server/group-topology-config-service.test.ts`

RTC topology effective config:

- Modify `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Modify `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`

Topology recompute/publish coordination:

- Create `packages/shared-server/rallar-system/services/group-topology-management-service.ts`
- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-management-service.test.ts`
- Modify `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`

API-v1 routes and wiring:

- Create `apps/api-v1/src/routes/graph-topology-routes.ts`
- Modify `apps/api-v1/src/create-rallar-server.ts`
- Modify `apps/api-v1/src/services/rtc-topology-config.ts`
- Modify `apps/api-v1/test/routes/graph-topology-routes.test.ts` or create it if absent
- Modify `apps/api-v1/test/rallar-server.test.ts`

OpenAPI and docs:

- Modify `apps/api-v1/resources/api-v1-openapi.yaml`
- Modify `apps/api-v1/test/swagger-routes.test.ts`

Browser/client helper compatibility:

- Modify `packages/shared-web/browser/api-integration.ts`
- Modify `packages/tests/shared-web/api-workflows.test.ts`
- Modify `apps/rallar-black-box/src/rallar-server-workbench.ts`
- Modify `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`

## Iterations

### Iteration 1: Graph Diagnostics Contracts And Scoped Global Graph

**Goal:** Add JSON-safe diagnostic graph contracts and scoped graph computation without changing REST routes yet.

**Files:**

- Create `packages/shared/api/graph-topology-management-types.ts`
- Modify `packages/shared/mod.ts`
- Modify `packages/shared-graph/shared-graph-types.ts`
- Create `packages/shared-graph/graph-diagnostics-serialization.ts`
- Modify `packages/shared-graph/group-graphs-create-service.ts`
- Modify `packages/shared-graph/mod.ts`
- Modify `packages/tests/shared-graph/group-graph-services.test.ts`
- Modify `packages/tests/shared-graph/graphology-serialization.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-graph/group-graph-services.test.ts`, add `it('computes and caches scoped global graphs by app and workspace', ...)`:
  - create client snapshots in `app-1/workspace-a`, `app-1/workspace-b`, and `app-2/workspace-a`
  - call the new scoped global graph function for `app-1/workspace-a`
  - assert only sessions from that scope appear
  - assert the snapshot `groupRef` is `{ applicationId: 'app-1', workspaceId: 'workspace-a', groupId: '__global__' }`
  - assert `findGraphByRef(...)` returns that snapshot
- In `packages/tests/shared-graph/graphology-serialization.test.ts`, add `it('serializes graph snapshots through the shared diagnostic DTO helper', ...)`:
  - build a `GraphInfoSnapshot`
  - call `serializeGraphInfoSnapshot(snapshot)`
  - assert `serialized.predicted.graph` equals `predictedGraph.export()`
  - assert no `graphId` property exists

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-graph/group-graph-services.test.ts packages/tests/shared-graph/graphology-serialization.test.ts
```

**Expected Failure Before Implementation:**

- `computeScopedGlobalGraphAndCacheIt` or equivalent named export is missing.
- `serializeGraphInfoSnapshot` is missing.
- The graph DTO test fails if `graphId` remains part of the serialized contract.

**Checkbox Steps:**

- [ ] Add exported DTO types in `packages/shared/api/graph-topology-management-types.ts`: `SerializedWeightedGraph`, `SerializedGraphInfo`, `SerializedGraphInfoSnapshot`, `GraphDiagnosticRefreshMode`, `GraphDiagnosticReadResponse`.
- [ ] Export the new shared API type module from `packages/shared/mod.ts`.
- [ ] Add graphology DTO helper signatures in `packages/shared-graph/graph-diagnostics-serialization.ts`: `serializeGraphInfo(info: GraphInfo): SerializedGraphInfo` and `serializeGraphInfoSnapshot(snapshot: GraphInfoSnapshot): SerializedGraphInfoSnapshot`.
- [ ] Export serialization helpers from `packages/shared-graph/mod.ts`.
- [ ] Add `SCOPED_GLOBAL_GRAPH_GROUP_ID = '__global__'` in `packages/shared-graph/group-graphs-create-service.ts`.
- [ ] Add `toScopedGlobalGraphRef(scope: StateScope): GroupRef`.
- [ ] Add `computeScopedGlobalGraph(scope: StateScope, allNodes: readonly string[], includeMeasured = false): GraphInfoSnapshot`.
- [ ] Add `computeScopedGlobalGraphAndCacheIt(scope: StateScope, includeMeasured = false): GraphInfoSnapshot` that filters `clientStateSnapshotsRepository.getAllClientStateSnapshots()` by `principal.applicationId` and `principal.workspaceId`.
- [ ] Keep `GLOBAL_GRAPH_REF`, `computeGlobalGraph(...)`, and `computeGlobalGraphAndCacheIt()` for legacy compatibility.
- [ ] Run the focused command and confirm the new tests pass.

**Expected Pass After Implementation:**

- Scoped global graph test passes with same `groupId` safely separated by app/workspace.
- Serialization helper test passes and produces `groupRef`-based JSON-safe output.

**Verification Command:**

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit && npx tsc -p packages/shared-graph/tsconfig.json --noEmit
```

### Iteration 2: Topology Config Types, Validation, And Runtime-State Repository

**Goal:** Add durable and temporary topology config persistence with deterministic effective-config resolution.

**Files:**

- Modify `packages/shared/api/graph-topology-management-types.ts`
- Create `packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts`
- Create `packages/shared-server/rallar-system/services/group-topology-config-service.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-config-repository.test.ts`
- Create `packages/tests/shared-server/group-topology-config-service.test.ts`

**Tests To Add First:**

- `packages/tests/shared-server/group-topology-config-repository.test.ts`:
  - stores durable config under scoped group ref
  - keeps same `groupId` in different workspaces isolated
  - stores temporary override with `expiresAtEpochMs`
  - expired override reads as undefined through `RuntimeStateJsonStore`
  - deleting config removes only the matching scoped key
- `packages/tests/shared-server/group-topology-config-service.test.ts`:
  - resolves `serverDefaults -> durable -> temporary -> requestOptions`
  - rejects non-positive integers
  - rejects `meshMinSize < treeMinSize`
  - rejects `meshParamK > degreeLimit`
  - defaults temporary override expiry to 15 minutes and caps it at 24 hours

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts
```

**Expected Failure Before Implementation:**

- New repository and config service imports cannot resolve.
- Effective config resolution helpers are missing.

**Checkbox Steps:**

- [ ] Add shared types: `GroupTopologyKindSetting`, `GroupTopologyConfigPatch`, `StoredGroupTopologyConfig`, `StoredGroupTopologyOverride`, `GroupTopologyConfigView`, `PutGroupTopologyConfigRequest`, `PutGroupTopologyOverrideRequest`, `ReconfigureGroupTopologyRequest`, `ReconfigureGroupTopologyResponse`, and `GroupTopologyValidationError`.
- [ ] Implement `GroupTopologyConfigRepository` as a `RuntimeStateJsonStore` with namespaces `group-topology:config` and `group-topology:override`.
- [ ] Add repository methods: `findConfig(ref)`, `putConfig(input)`, `deleteConfig(ref)`, `findOverride(ref)`, `putOverride(input, expiresAtEpochMs)`, `deleteOverride(ref)`, `configKey(ref)`, `overrideKey(ref)`.
- [ ] Store keys as `[scopeKey(ref), idKey('group', ref.groupId)].join(':')`, matching `RtcTopologySnapshotRepository`.
- [ ] Implement config service helpers: `resolveGroupTopologyConfig(...)`, `validateGroupTopologyConfigPatch(...)`, `validateEffectiveGroupTopologyConfig(...)`, and `resolveOverrideExpiresAtEpochMs(...)`.
- [ ] Define default override TTL constants: `DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 15 * 60 * 1000` and `MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000`.
- [ ] Export the repository and helpers from `packages/shared-server/mod.ts`.
- [ ] Run the focused command and confirm the new tests pass.

**Expected Pass After Implementation:**

- Runtime-state repository tests prove scoped storage and expiry.
- Config service tests prove deterministic resolution and validation.

**Verification Command:**

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit && npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

### Iteration 3: RTC Topology Service Supports Effective Per-Group Config

**Goal:** Make `RallarRtcTopologyService` accept effective config per update, including forced topology kind, without duplicating topology algorithms.

**Files:**

- Modify `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Modify `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`, add:
  - `it('honors request topology kind override for star topology', ...)` with 8 active sessions and `topologyKind: 'star'`
  - `it('honors request topology kind override for mesh topology when group size can support mesh', ...)` with 16 active sessions and `topologyKind: 'mesh'`
  - `it('uses per-update degree limit without replacing service-wide defaults', ...)` by calling `updateGroupTopology` twice with different `degreeLimit` values and checking `snapshot.degreeLimit`

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts
```

**Expected Failure Before Implementation:**

- `updateGroupTopology(...)` does not accept a `topologyOptions` or `effectiveConfig` option.
- `RallarRtcTopologyServiceOptions` has no `topologyKind`.
- Forced topology assertions fail because `selectTopology(...)` only uses thresholds.

**Checkbox Steps:**

- [ ] Extend `RallarRtcTopologyServiceOptions` with `topologyKind?: 'auto' | 'star' | 'tree' | 'mesh'`.
- [ ] Extend `RallarRtcTopologyUpdateOptions` with `topologyOptions?: RallarRtcTopologyServiceOptions`.
- [ ] Add internal helper `readTopologyOptions(updateOptions)` that overlays `this.options` with per-update options.
- [ ] Update `selectTopology(group, options)` to return explicit `star`, `tree`, or `mesh` when `topologyKind` is not `auto` or undefined.
- [ ] Update degree/threshold/mesh helper reads to use effective options for the current update.
- [ ] Preserve `queueRttTopologyUpdate(...)`, metrics, snapshot versioning, and previous snapshot handling.
- [ ] Keep default behavior unchanged when no per-update options are passed.
- [ ] Run the focused command and confirm all existing topology tests plus new tests pass.

**Expected Pass After Implementation:**

- Existing star/tree/mesh behavior remains unchanged by default.
- New tests prove effective per-group config can force topology and degree limit per update.

**Verification Command:**

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

### Iteration 4: Shared-Server Topology Management Service And WS Reuse

**Goal:** Extract topology recompute/publish behavior into a reusable shared-server service used by both REST routes and existing WS topic flows.

**Files:**

- Create `packages/shared-server/rallar-system/services/group-topology-management-service.ts`
- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-management-service.test.ts`
- Modify `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`

**Tests To Add First:**

- `packages/tests/shared-server/group-topology-management-service.test.ts`:
  - reads group snapshot by full `GroupRef`
  - resolves effective config and passes it into `RallarRtcTopologyService.updateGroupTopology(...)`
  - reads RTTs through `RtcRttRepository.listMeasurementsForSessionIds(...)` when runtime state is configured
  - uses `RtcTopologySnapshotRepository.withSnapshotLock(...)`
  - persists changed topology snapshots
  - returns `published: true` and calls the publisher when `publish` is true and topology changed
  - returns `published: false` when `publish` is false
  - returns `changed: false` when previous next-hop map is unchanged
- `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`:
  - keep existing behavior passing after `ws-system-topics.ts` delegates to the new service

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
```

**Expected Failure Before Implementation:**

- `GroupTopologyManagementService` does not exist.
- WS topic tests fail after initial extraction until private helper behavior is faithfully moved.

**Checkbox Steps:**

- [ ] Define `GroupTopologyManagementService` with injected dependencies: group snapshot reader, config repository, RTC topology service, optional topology snapshot repository, optional RTT repository, fallback process RTT reader, publisher, server defaults, `now`.
- [ ] Add public methods: `readTopologyView(groupRef)`, `readConfig(groupRef)`, `putConfig(input)`, `deleteConfig(input)`, `putOverride(input)`, `deleteOverride(input)`, `reconfigureGroupTopology(input)`.
- [ ] Define `GroupTopologyPublisher` as a callback or small interface that receives `group`, `result`, and `publish` metadata.
- [ ] Move `publishRtcOverlayTopologyResult(...)` behavior from `ws-system-topics.ts` into a reusable exported helper that still creates `newALBroadcastMessage(...)` with `AppTopics.overlayTopology`, `groupRef`, `minSnapshotVersion`, `best-effort`, and `ack: 'none'`.
- [ ] Move runtime-state update behavior equivalent to `updateRtcOverlayTopology(...)` into the service so REST and WS share snapshot locking.
- [ ] Keep `initRallarSystemWsTopics(...)` public API backward compatible.
- [ ] Refactor `ws-system-topics.ts` to delegate group-snapshot and RTT recomputes to the new service while keeping coalesced app-inbox behavior.
- [ ] Export the new service from `packages/shared-server/mod.ts`.
- [ ] Run the focused command and confirm new service tests and existing WS-topic tests pass.

**Expected Pass After Implementation:**

- Shared-server service tests prove REST-usable recompute behavior.
- Existing WS topic tests continue to pass, proving no behavior regression for live topology updates.

**Verification Command:**

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

### Iteration 5: API-V1 Scoped Graph And Topology Routes

**Goal:** Add the new scoped REST routes with dependency injection, auth, errors, and no real DB dependency in route tests.

**Files:**

- Create `apps/api-v1/src/routes/graph-topology-routes.ts`
- Create `apps/api-v1/test/routes/graph-topology-routes.test.ts`

**Tests To Add First:**

- `GET /api/state/apps/app-1/workspaces/workspace-1/groups/room-1/graphs/latest`:
  - returns `200`
  - passes `{ applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }` to the graph service
  - returns serialized graph DTO with `groupRef`
- `GET /api/state/apps/app-1/workspaces/workspace-1/graphs/global`:
  - returns scoped synthetic `groupRef.groupId === '__global__'`
- strict read auth:
  - active group member can read group graph and topology
  - non-member receives `403` with group policy code
- writes:
  - active group owner/admin can `PUT /topology/config`
  - regular active member cannot write config
  - platform admin listed in route deps can write any group
- `PUT /topology/override`:
  - forwards TTL and config to topology service
- `DELETE /topology/config` and `DELETE /topology/override`:
  - default to reconfigure and publish
- `POST /topology/reconfigure`:
  - forwards request-time options
  - returns `changed`, `published`, `snapshot`, and effective config
- missing group returns `404`
- invalid config returns `422`

**Exact Focused Test Command:**

```bash
cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts
```

**Expected Failure Before Implementation:**

- Importing `../../src/routes/graph-topology-routes.ts` fails.
- All new route requests return `404` because routes are not mounted in the test app.

**Checkbox Steps:**

- [ ] Create route dependency types matching existing route modules: injectable `getGroupStateService`, `graphDiagnostics`, `topologyManagement`, `requireApiAuthSession`, `adminClientIds`, and `now`.
- [ ] Implement route-local `toScope(c)` and `toGroupRef(c)` helpers matching existing `group-state-routes.ts`.
- [ ] Implement route-local error response mapping: group policy denied -> `403`, unauthorized -> `401`, not found -> `404`, conflict -> `409`, validation -> `422`, other bad input -> `400`.
- [ ] Implement strict read auth using `RALLAR_STATE_STRICT_READ_AUTH` and `canReadGroupSnapshot(...)`, matching group state behavior.
- [ ] Implement manage auth using `canUpdateGroupSnapshot(...)` or platform admin client id.
- [ ] Add graph diagnostics routes and serialize graph snapshots before returning JSON.
- [ ] Add topology read/config/override/reconfigure routes.
- [ ] Use `Idempotency-Key` as fallback `requestId` for PUT/DELETE/POST mutations, matching existing state routes.
- [ ] Run the focused Deno route test command and confirm all route tests pass.

**Expected Pass After Implementation:**

- New route tests pass without Postgres, real WS, or real graph algorithms.
- Route behavior matches current state-route auth and error conventions.

**Verification Command:**

```bash
cd apps/api-v1 && deno task check
```

### Iteration 6: API-V1 Server Wiring And OpenAPI

**Goal:** Mount the new routes in the real server, wire durable topology runtime-state/app-inbox behavior, and publish accurate OpenAPI documentation.

**Files:**

- Modify `apps/api-v1/src/create-rallar-server.ts`
- Modify `apps/api-v1/src/services/rtc-topology-config.ts`
- Modify `apps/api-v1/test/rallar-server.test.ts`
- Modify `apps/api-v1/resources/api-v1-openapi.yaml`
- Modify `apps/api-v1/test/swagger-routes.test.ts`

**Tests To Add First:**

- In `apps/api-v1/test/rallar-server.test.ts`:
  - `createRallarServer` mounts the new scoped graph/topology route module
  - default system topic setup passes runtime-state topology options and coalesced app-inbox options into `initRallarSystemWsTopics(...)`
  - existing topic lists remain unchanged
- In `apps/api-v1/test/swagger-routes.test.ts`:
  - `/api/openapi.json` includes all new scoped graph/topology paths
  - `/api/graph` and `/api/graph/tree/{groupId}` have `deprecated: true`
  - `GraphInfo` and `GraphInfoSnapshot` schemas require `groupRef`, not `graphId`
  - topology config schemas exist with expected enum and integer constraints

**Exact Focused Test Command:**

```bash
cd apps/api-v1 && deno test --allow-env --allow-read test/rallar-server.test.ts test/swagger-routes.test.ts
```

**Expected Failure Before Implementation:**

- New route path assertions fail because routes are not mounted.
- Runtime-state/app-inbox assertions fail because `create-rallar-server.ts` does not pass those options.
- OpenAPI assertions fail because paths and schemas are missing or stale.

**Checkbox Steps:**

- [ ] Import and mount `graph-topology-routes.ts` after `groupStateRoutes.init` and before legacy `graphRoutes.init`.
- [ ] Create a runtime-state repository in `createRallarServer(...)` for topology config, topology snapshots, and RTTs. Reuse `createRuntimeStateRepository(sql)` from `apps/api-v1/src/repository/createStateRepositories.ts`.
- [ ] Construct real `GroupTopologyConfigRepository`, `GroupTopologyManagementService`, and graph diagnostics dependencies for the route module.
- [ ] Pass `rtcTopologyRuntimeState: { repository: runtimeStateRepository }` into `initRallarSystemWsTopics(...)`.
- [ ] Pass `rtcTopologyAppInbox: { inboxQueueReader: runtime.inboxQueueReader, senderId: myServerId, wake: () => runtime.qboxEngine.wake(), findGroupSnapshotByRef: ... }` into `initRallarSystemWsTopics(...)`.
- [ ] Preserve `initDynamicTopics: false` and existing CRDT topic installation.
- [ ] Update `getApiRtcTopologyServiceOptions(...)` only if Iteration 3 adds server-default `topologyKind`; read a new env var only if the implementation supports it cleanly. If added, use `RALLAR_RTC_TOPOLOGY_KIND` with accepted values `auto`, `star`, `tree`, `mesh`.
- [ ] Update OpenAPI paths and schemas for all scoped graph/topology endpoints.
- [ ] Mark legacy `/api/graph` and `/api/graph/tree/{groupId}` deprecated.
- [ ] Run the focused Deno command and confirm server wiring and OpenAPI tests pass.

**Expected Pass After Implementation:**

- Real `createRallarServer(...)` exposes new routes and still exposes legacy graph routes.
- OpenAPI accurately documents `groupRef` graph snapshots and topology management.
- Default API-v1 topology WS behavior uses durable runtime-state/app-inbox infrastructure.

**Verification Command:**

```bash
cd apps/api-v1 && deno task check
```

### Iteration 7: Shared-Web Helpers And Black-Box Workbench Compatibility

**Goal:** Expose client-side helper functions and update the black-box REST workbench endpoint catalog to prefer scoped graph/topology routes while keeping legacy endpoints visible as deprecated diagnostics.

**Files:**

- Modify `packages/shared-web/browser/api-integration.ts`
- Modify `packages/tests/shared-web/api-workflows.test.ts`
- Modify `apps/rallar-black-box/src/rallar-server-workbench.ts`
- Modify `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-web/api-workflows.test.ts`:
  - `readStateScopedGlobalGraph(...)` builds `/api/state/apps/{applicationId}/workspaces/{workspaceId}/graphs/global?includeMeasured=true&refresh=always`
  - `readStateGroupGraph(...)` encodes `groupId` and query params
  - `readStateGroupTopology(...)` builds `/groups/{groupId}/topology`
  - `putStateGroupTopologyConfig(...)`, `putStateGroupTopologyOverride(...)`, and `reconfigureStateGroupTopology(...)` use auth-capable `PUT`/`POST` paths
- In `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`:
  - endpoint presets include `graph-scoped-global`, `group-graph-latest`, `group-topology-read`, `group-topology-config-put`, `group-topology-override-put`, and `group-topology-reconfigure`
  - legacy `graph-global` and `graph-group` remain present and can be labeled deprecated

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts
```

**Expected Failure Before Implementation:**

- New shared-web helper imports are missing.
- Workbench preset assertions fail because only legacy graph endpoints are listed.

**Checkbox Steps:**

- [ ] Import graph/topology DTO request/response types from `@shared/api/graph-topology-management-types.ts` in `api-integration.ts`.
- [ ] Add helper functions using existing `executeHttpRequest(...)` and `toStateScopePath(...)`.
- [ ] Keep helper functions graphology-free by returning serialized DTO types.
- [ ] Add endpoint presets for new scoped graph/topology routes in `rallar-server-workbench.ts`.
- [ ] Keep existing `/api/graph` and `/api/graph/tree/{groupId}` presets for backward compatibility, but label them as legacy/deprecated in user-facing preset labels.
- [ ] Run the focused Vitest command and confirm tests pass.

**Expected Pass After Implementation:**

- Browser helper tests prove route encoding and auth behavior.
- Black-box workbench tests prove operators can discover the new scoped product API.

**Verification Command:**

```bash
npx tsc -p packages/shared-web/tsconfig.json --noEmit
```

## Local Validation Matrix

Run focused tests first:

```bash
npx vitest run packages/tests/shared-graph/group-graph-services.test.ts packages/tests/shared-graph/graphology-serialization.test.ts
npx vitest run packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts
cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts
npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts
```

Run type and app checks:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-graph/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
```

Run broader relevant suites when the focused checks pass:

```bash
npm run test:rallar-server-hardening
npm run test:deno
```

Postgres/runtime-state smoke is useful because this feature relies on runtime-state stores:

```bash
npm run db:test:up
npm run test:postgres:presence-expiry
npm run db:test:down
```

## CI/Deployment Validation

Real CI exists in `.github/workflows/release-gate.yml` and is reused by `.github/workflows/branch-release-gate.yml`.

Release gate validation:

- `npm ci`
- `npx playwright install --with-deps chromium`
- `npm run test:ci`
- `npm run build:ar-eye-hunter-v1`
- `npm run build:relic-hunters-v1`
- `npm run build:rallar`
- `(cd apps/api-v1 && deno task check)`
- `(cd apps/relic-hunter-server-v1 && deno task check)`
- `(cd apps/rallar-black-box-control-server && deno task check)`
- `npm run db:migrate`
- `npm run test:postgres:presence-expiry`
- `npm run test:rallar:full-stack:postgres:rest`
- `npm run test:rallar:full-stack:postgres:control`

Deployment notes:

- No new Prisma migration is expected because new config uses `runtime_state_store` namespaces.
- Existing production hardening still requires `RALLAR_STATE_STRICT_READ_AUTH=1`, which protects topology reads.
- If `RALLAR_RTC_TOPOLOGY_KIND` is added, document it beside the existing `RALLAR_RTC_TOPOLOGY_*` env vars and default it to `auto`.

## Rollback/Compatibility Plan

- Legacy `/api/graph` and `/api/graph/tree/:groupId` remain available throughout rollout.
- New routes are additive. If issues appear, remove or stop calling the new scoped routes without breaking existing clients.
- Durable topology config can be rolled back operationally by deleting rows in `runtime_state_store` namespaces `group-topology:config` and `group-topology:override`.
- If runtime-state/app-inbox topology wiring causes production trouble, temporarily omit `rtcTopologyRuntimeState` and `rtcTopologyAppInbox` from `create-rallar-server.ts` while keeping REST config storage intact.
- Browser/shared-web helper additions are additive; existing room and RTC flows continue to use `AppTopics.overlayTopology`.
- OpenAPI deprecation of legacy graph routes is documentation-only and does not remove handlers.

## Final Acceptance Criteria

- Scoped graph diagnostics routes return serialized `groupRef` graph snapshots and never depend on bare `groupId`.
- Scoped global graph diagnostics include only active sessions from the requested `applicationId` and `workspaceId`.
- Topology config persists durable and temporary overrides by full `GroupRef`.
- Effective topology config resolves in this order: server defaults, durable group config, temporary override, request-time options.
- Invalid topology config returns `422` and does not publish topology.
- Group owners/admins can manage topology for their groups.
- Platform admin client ids from `AUTH_ADMIN_CLIENT_IDS` can manage any group.
- Non-admin members cannot mutate topology config.
- REST reconfigure and WS-triggered recompute use the same shared-server recompute/publish path.
- API-v1 wires durable RTC topology runtime-state and coalesced app-inbox behavior.
- OpenAPI documents all new routes and uses `groupRef`, not `graphId`, for graph schemas.
- Legacy graph endpoints still work and are marked deprecated.
- Focused tests, type checks, and `cd apps/api-v1 && deno task check` pass.

