# API V1 Graph Topology Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Build the scoped graph diagnostics and group topology management REST product described in `playground/api-v1-graph-topology-management-design.md`, remove the obsolete unscoped graph endpoints, and reuse current Rallar graph, runtime-state, group-state, auth, error, and WS topology infrastructure.

## Source Inputs Inspected

- `playground/api-v1-graph-topology-management-design.md`
- `plans/api-v1-graph-topology-management-implementation-plan.md`
- `AGENTS.md` instructions from the conversation
- `.agents/skills/rallar-platform/SKILL.md`
- `.agents/skills/rallar-platform/references/package-map.md`
- `.agents/skills/rallar-realtime/SKILL.md`
- `.agents/skills/rallar-code-writing/SKILL.md`
- `.agents/skills/rallar-code-writing/references/repo-code-style.md`
- `.agents/skills/rallar-testing/SKILL.md`
- `.agents/skills/rallar-testing/references/test-commands.md`
- `docs/rallar-api-reference.md`
- `docs/rallar-rtc-rtt-reporting.md`
- `docs/environment-variables.md`
- `apps/api-v1/src/create-rallar-server.ts`
- `apps/api-v1/src/middleware.ts`
- `apps/api-v1/src/routes/group-state-routes.ts`
- `apps/api-v1/src/routes/client-state-routes.ts`
- `apps/api-v1/src/routes/config-route.ts`
- `apps/api-v1/src/routes/crdt-admin-routes.ts`
- `apps/api-v1/src/services/request-auth-service.ts`
- `apps/api-v1/src/services/rtc-topology-config.ts`
- `apps/api-v1/src/services/ws-topic-room-authorizer.ts`
- `apps/api-v1/src/repository/createStateRepositories.ts`
- `apps/api-v1/resources/api-v1-openapi.yaml`
- `apps/api-v1/deno.json`
- `apps/api-v1/test/routes/state-api-routes-hardening.test.ts`
- `apps/api-v1/test/rallar-server.test.ts`
- `apps/api-v1/test/swagger-routes.test.ts`
- `apps/api-v1/test/rtc-topology-config.test.ts`
- `packages/shared/mod.ts`
- `packages/shared/api/api-type-utils.ts`
- `packages/shared/api/group-types.ts`
- `packages/shared/api/overlay-topology.ts`
- `packages/shared/api/state-types.ts`
- `packages/shared/services/WebRtcGroupManager.ts`
- `packages/shared-web/browser/api-integration.ts`
- `packages/shared-web/browser/data-caches.ts`
- `packages/shared-web/package.json`
- `packages/shared-graph/mod.ts`
- `packages/shared-graph/architecture.md`
- `packages/shared-graph/shared-graph-types.ts`
- `packages/shared-graph/group-graphs-create-service.ts`
- `packages/shared-graph/group-topology-validation.ts`
- `packages/shared-graph/repository/graphs-repository.ts`
- `packages/shared-server/mod.ts`
- `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- `packages/shared-server/rallar-system/group-policy.ts`
- `packages/shared-server/rallar-system/ws-system-topics.ts`
- `packages/shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts`
- `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- `packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts`
- `packages/shared-server/rallar-system/repositories/RtcRttRepository.ts`
- `packages/shared-server/runtime-state/RuntimeStateJsonStore.ts`
- `packages/shared-server/runtime-state/RuntimeStateRepository.ts`
- `packages/tests/shared-graph/group-graph-services.test.ts`
- `packages/tests/shared-graph/graphology-serialization.test.ts`
- `packages/tests/shared-graph/group-topology-validation.test.ts`
- `packages/tests/shared-server/fake-runtime-state-repository.ts`
- `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`
- `packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`
- `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
- `packages/tests/shared-web/api-workflows.test.ts`
- `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
- `apps/rallar-black-box/src/rallar-server-workbench.ts`
- `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`
- `.github/workflows/release-gate.yml`
- `.github/workflows/branch-release-gate.yml`
- root `package.json`

## Repo Truths

- `apps/api-v1` is a Deno/Hono composition layer. Reusable graph, topology, config, and runtime-state behavior belongs in `packages/**`.
- Current state REST routes already use `/api/state/apps/:applicationId/workspaces/:workspaceId/...` and route-local dependency injection for tests.
- `packages/shared` owns cross-runtime REST DTO contracts and must stay graphology-free.
- `packages/shared-graph` owns graphology algorithms, graph diagnostics, graph cache keys, and the existing `group-topology-validation.ts` helper.
- `packages/shared-graph/group-topology-validation.ts` now exists and is exported from `packages/shared-graph/mod.ts`; it validates graphology `WeightedGraph` outputs, but it does not validate REST config patches or next-hop maps yet.
- `packages/shared-server` owns runtime-state repositories, group policy, app inbox services, WS topics, and `RallarRtcTopologyService`.
- `packages/shared-web/browser/api-integration.ts` currently supports `GET`, `POST`, and `PUT` only; REST helper work for topology deletes must add `DELETE` support.
- Only scoped graph diagnostics are part of the API product; the former unscoped graph routes and bare-group lookup helper are removed.
- `computeGroupGraph(groupRef, includeMeasured)` accepts a full `GroupRef`.
- `GraphInfoSnapshot` already carries `groupRef`, but OpenAPI still requires `graphId`.
- `GLOBAL_GRAPH_REF` still uses `{ applicationId: 'global', workspaceId: 'global', groupId: DEFAULT_GRAPH_PROP.id }`; scoped global diagnostics need a synthetic per-scope ref instead.
- `graphsRepository.toGraphRepositoryKey(ref)` already keys by application, workspace, and group id.
- `RallarRtcTopologyServiceOptions` currently supports thresholds and debounce only: `degreeLimit`, `treeMinSize`, `meshMinSize`, `meshParamK`, `rttRebuildDebounceMs`, and `now`.
- `RallarRtcTopologyService.updateGroupTopology(...)` currently accepts a previous snapshot only; it cannot apply per-request effective topology config yet.
- `initRallarSystemWsTopics(...)` supports `rtcTopologyRuntimeState` and `rtcTopologyAppOutbox`.
- `RallarMiddlewareRuntime` exposes `outboxQueueReader`, `qboxEngine`, `groupsRepository`, and `wsQBoxServerService`, so API-v1 can wire durable APP_OUTBOX topology recompute without inventing a new worker.
- `GroupStateSnapshotReadThroughCache` supplies durable, scoped group snapshots to APP_OUTBOX topology work by `GroupRef`.
- Read authorization should reuse strict read behavior from state routes: `RALLAR_STATE_STRICT_READ_AUTH` gates full group reads.
- Write authorization should reuse `canUpdateGroupSnapshot(...)`; platform admin bypass should use existing `AUTH_ADMIN_CLIENT_IDS` client-id convention from config/CRDT admin routes.
- Runtime-state JSON stores already provide namespaces, scoped key helpers, expiry cleanup, and transactional locks. No migration is needed for topology config storage.
- Current API-v1 topology env parsing is in `apps/api-v1/src/services/rtc-topology-config.ts`; do not add a new global `RALLAR_RTC_TOPOLOGY_KIND` env var for this work. Use hard-coded server default `topologyKind: 'auto'` plus existing threshold envs.
- CI is real: `.github/workflows/release-gate.yml` runs `npm run test:ci`, deployable app builds, app Deno checks, migrations, and Postgres full-stack smoke tests.

## API Contract Summary

Base path:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId
```

Graph diagnostics:

- `GET /graphs/global?includeMeasured=true&refresh=if-missing`
- `GET /groups/:groupId/graphs/latest?includeMeasured=true&refresh=if-missing`

Topology management:

- `GET /groups/:groupId/topology`
- `GET /groups/:groupId/topology/config`
- `PUT /groups/:groupId/topology/config`
- `DELETE /groups/:groupId/topology/config`
- `GET /groups/:groupId/topology/override`
- `PUT /groups/:groupId/topology/override`
- `DELETE /groups/:groupId/topology/override`
- `POST /groups/:groupId/topology/reconfigure`

Graph diagnostic response:

```ts
type GraphDiagnosticReadResponse = Readonly<{
    groupRef: GroupRef;
    snapshot: SerializedGraphInfoSnapshot;
    cache: {
        hit: boolean;
        refreshed: boolean;
    };
}>;
```

Topology config resolution order:

```text
server defaults -> durable group config -> temporary override -> request-time reconfigure options
```

Topology config fields:

- `topologyKind?: 'auto' | 'star' | 'tree' | 'mesh'`
- `degreeLimit?: number`
- `treeMinSize?: number`
- `meshMinSize?: number`
- `meshParamK?: number`

Temporary override rules:

- default TTL is 15 minutes
- max TTL is 24 hours
- store with runtime-state expiry so stale overrides disappear

Authorization:

- reads follow existing strict group read behavior
- writes always require an auth session
- active group owner/admin can manage their group
- platform admin client id can manage any group

Removed unscoped surface:

- Do not mount or document unscoped graph endpoints.
- Do not expose black-box workbench presets for unscoped graph endpoints.
- Keep absence assertions in API/OpenAPI/workbench tests.

## Current-Code Conflicts To Resolve

- `apps/api-v1/resources/api-v1-openapi.yaml` still documents graph schemas with `graphId`.
- `apps/api-v1/test/swagger-routes.test.ts` only checks server URL behavior and does not assert graph/topology schema correctness.
- `computeGlobalGraphAndCacheIt()` reads all process client snapshots, not one app/workspace scope.
- No shared graph diagnostic read helper implements `refresh=never | if-missing | always`.
- `packages/shared-graph/group-topology-validation.ts` validates graphology graphs only; REST topology management needs config validation and next-hop validation before publish.
- `RallarRtcTopologyService` cannot receive effective per-group config per update.
- RTC topology recompute, persistence, RTT reads, and publish helpers are private in `ws-system-topics.ts`.
- API-v1 needs durable RTC topology runtime-state and APP_OUTBOX wiring.
- `packages/shared-web/browser/api-integration.ts` lacks `DELETE` support.
- `apps/rallar-black-box/src/rallar-server-workbench.ts` needs scoped graph diagnostic presets.

## Decisions And Tradeoffs

- Keep graph diagnostics separate from live overlay topology. Graph diagnostics return serialized graphology exports; topology management returns and publishes `RallarOverlayTopologySnapshot`.
- Reuse `GroupRef` everywhere; do not add a bare-group graph lookup compatibility path.
- Store durable config and temporary overrides in runtime-state namespaces, not `Group.metadata`, because this is server transport control rather than group identity/roster state.
- Extend existing `RallarRtcTopologyService`; do not create a parallel topology planner.
- Reuse existing `group-topology-validation.ts` by adding next-hop validation there; keep REST config patch validation in shared-server because it concerns API/server config semantics.
- Extract WS recompute/publish behavior into a shared-server service so WS-triggered recomputes and REST-triggered recomputes use one path.
- Do not add a new `RALLAR_RTC_TOPOLOGY_KIND` env var. Server defaults are existing threshold envs plus `topologyKind: 'auto'`.
- Keep route modules dependency-injected like state routes so Deno route tests run without Postgres, real app inbox, or real WebSocket.
- Add shared-web helpers and black-box workbench presets after server contracts exist; they are product ergonomics, not the source of truth.

## Non-Goals

- No manual REST editing of graph nodes or edges.
- No historical durable storage for diagnostic graph snapshots.
- No database migration for topology config.
- No new web framework, queue system, or persistence framework.
- No replacement of client/group state routes.
- No compatibility shim for the removed unscoped graph routes.
- No new global topology-kind environment variable or Hetzner manifest/workflow env expansion.
- No role-based platform admin model beyond `AUTH_ADMIN_CLIENT_IDS`.
- No SFU, TURN, or media relay architecture changes.

## Files By Responsibility

Shared REST contracts:

- Create `packages/shared/api/graph-topology-management-types.ts`
- Modify `packages/shared/mod.ts`

Graph diagnostics and serialization:

- Create `packages/shared-graph/graph-diagnostics-serialization.ts`
- Create `packages/shared-graph/graph-diagnostics-service.ts`
- Modify `packages/shared-graph/group-graphs-create-service.ts`
- Modify `packages/shared-graph/mod.ts`
- Modify `packages/tests/shared-graph/group-graph-services.test.ts`
- Modify `packages/tests/shared-graph/graphology-serialization.test.ts`

Topology validation:

- Modify `packages/shared-graph/group-topology-validation.ts`
- Modify `packages/tests/shared-graph/group-topology-validation.test.ts`

Topology config persistence and resolution:

- Create `packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts`
- Create `packages/shared-server/rallar-system/services/group-topology-config-service.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-config-repository.test.ts`
- Create `packages/tests/shared-server/group-topology-config-service.test.ts`

RTC topology effective config:

- Modify `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Modify `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`

Topology recompute and publish coordination:

- Create `packages/shared-server/rallar-system/services/group-topology-management-service.ts`
- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-management-service.test.ts`
- Modify `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`

API-v1 routes and wiring:

- Create `apps/api-v1/src/routes/graph-topology-routes.ts`
- Create `apps/api-v1/test/routes/graph-topology-routes.test.ts`
- Modify `apps/api-v1/src/create-rallar-server.ts`
- Modify `apps/api-v1/test/rallar-server.test.ts`

OpenAPI and product docs:

- Modify `apps/api-v1/resources/api-v1-openapi.yaml`
- Modify `apps/api-v1/test/swagger-routes.test.ts`
- Modify `docs/rallar-api-reference.md`
- Modify `docs/rallar-rtc-rtt-reporting.md`

Browser/client helper compatibility:

- Modify `packages/shared-web/browser/api-integration.ts`
- Modify `packages/tests/shared-web/api-workflows.test.ts`
- Modify `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` if snapshots include `api-integration.ts` exports
- Modify `apps/rallar-black-box/src/rallar-server-workbench.ts`
- Modify `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`

## Iterations

### Iteration 1: Shared Contracts And Graph Diagnostic Reads

**Goal:** Add JSON-safe graph diagnostic contracts, scoped global graph reads, and cache refresh semantics without touching API-v1 routes.

**Files:**

- Create `packages/shared/api/graph-topology-management-types.ts`
- Modify `packages/shared/mod.ts`
- Create `packages/shared-graph/graph-diagnostics-serialization.ts`
- Create `packages/shared-graph/graph-diagnostics-service.ts`
- Modify `packages/shared-graph/group-graphs-create-service.ts`
- Modify `packages/shared-graph/mod.ts`
- Modify `packages/tests/shared-graph/group-graph-services.test.ts`
- Modify `packages/tests/shared-graph/graphology-serialization.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-graph/group-graph-services.test.ts`, add `it('computes and caches scoped global graphs by app and workspace', ...)`:
  - create client snapshots in `app-1/workspace-a`, `app-1/workspace-b`, and `app-2/workspace-a`
  - call `computeScopedGlobalGraphAndCacheIt({ applicationId: 'app-1', workspaceId: 'workspace-a' }, true)`
  - assert only sessions from `app-1/workspace-a` appear
  - assert `snapshot.groupRef` is `{ applicationId: 'app-1', workspaceId: 'workspace-a', groupId: '__global__' }`
  - assert `findGraphByRef(snapshot.groupRef)` returns that snapshot
- In the same file, add `it('honors graph diagnostic refresh modes', ...)`:
  - call `readScopedGlobalGraphDiagnostic(scope, { includeMeasured: false, refresh: 'if-missing' })` and assert `{ cache: { hit: false, refreshed: true } }`
  - call it again with `refresh: 'if-missing'` and assert `{ cache: { hit: true, refreshed: false } }`
  - call it with `refresh: 'always'` and assert `{ cache: { hit: true, refreshed: true } }`
  - call a missing group diagnostic with `refresh: 'never'` and assert a left/error result
- In `packages/tests/shared-graph/graphology-serialization.test.ts`, add `it('serializes graph snapshots through the shared diagnostic DTO helper', ...)`:
  - build a `GraphInfoSnapshot`
  - call `serializeGraphInfoSnapshot(snapshot)`
  - assert exported `graph` and `groupGraph` values equal graphology `.export()` output
  - assert no `graphId` property exists

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-graph/group-graph-services.test.ts packages/tests/shared-graph/graphology-serialization.test.ts
```

**Expected Failure Before Implementation:**

- `packages/shared/api/graph-topology-management-types.ts` does not exist.
- `computeScopedGlobalGraphAndCacheIt`, `readScopedGlobalGraphDiagnostic`, and `serializeGraphInfoSnapshot` imports fail.
- Refresh-mode assertions cannot compile.

**Checkbox Steps:**

- [x] Add DTO types in `packages/shared/api/graph-topology-management-types.ts`: `SerializedWeightedGraph`, `SerializedGraphInfo`, `SerializedGraphInfoSnapshot`, `GraphDiagnosticRefreshMode`, `GraphDiagnosticReadOptions`, and `GraphDiagnosticReadResponse`.
- [x] Add topology DTO types in the same file for later iterations: `GroupTopologyKindSetting`, `GroupTopologyConfigPatch`, `StoredGroupTopologyConfig`, `StoredGroupTopologyOverride`, `GroupTopologyConfigView`, `GroupTopologyManagementView`, `PutGroupTopologyConfigRequest`, `PutGroupTopologyOverrideRequest`, `ReconfigureGroupTopologyRequest`, `ReconfigureGroupTopologyResponse`, and `GroupTopologyValidationErrorResponse`.
- [x] Export the new shared API module from `packages/shared/mod.ts`.
- [x] Implement `serializeGraphInfo(info)` and `serializeGraphInfoSnapshot(snapshot)` in `packages/shared-graph/graph-diagnostics-serialization.ts`.
- [x] Add `SCOPED_GLOBAL_GRAPH_GROUP_ID = '__global__'` and `toScopedGlobalGraphRef(scope: StateScope): GroupRef` in `packages/shared-graph/group-graphs-create-service.ts`.
- [x] Add `computeScopedGlobalGraph(scope: StateScope, allNodes: readonly string[], includeMeasured = false): GraphInfoSnapshot`.
- [x] Add `computeScopedGlobalGraphAndCacheIt(scope: StateScope, includeMeasured = false): GraphInfoSnapshot` that filters `clientStateSnapshotsRepository.getAllClientStateSnapshots()` by snapshot principal scope and active session scope.
- [x] Keep internal global graph computation used by topology diagnostics, and remove the obsolete bare-group `computeLatestGroupGraphById(...)` compatibility helper.
- [x] Implement `readScopedGlobalGraphDiagnostic(scope, options)` and `readGroupGraphDiagnostic(groupRef, options)` in `packages/shared-graph/graph-diagnostics-service.ts`.
- [x] Make `refresh: 'never'` return a left/error when no cached snapshot exists; make `if-missing` compute only on cache miss; make `always` compute and replace cache.
- [x] Export graph diagnostic helpers from `packages/shared-graph/mod.ts`.
- [x] Run the focused command and confirm the new tests pass.

**Expected Pass After Implementation:**

- Scoped global diagnostics are cache-keyed by full `GroupRef`.
- Diagnostic responses use `groupRef` and graphology export DTOs.
- Refresh mode behavior is deterministic and covered before routes exist.

**Verification Command:**

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit && npx tsc -p packages/shared-graph/tsconfig.json --noEmit
```

### Iteration 2: Config Persistence, Resolution, And Validation

**Goal:** Add runtime-state storage for durable and temporary topology config, plus deterministic config validation/resolution that reuses current server defaults.

**Files:**

- Modify `packages/shared-graph/group-topology-validation.ts`
- Modify `packages/tests/shared-graph/group-topology-validation.test.ts`
- Create `packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts`
- Create `packages/shared-server/rallar-system/services/group-topology-config-service.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-config-repository.test.ts`
- Create `packages/tests/shared-server/group-topology-config-service.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-graph/group-topology-validation.test.ts`, add `it('validates next-hop topology maps without graphology callers', ...)`:
  - pass active sessions `peer-a`, `peer-b`, `peer-c`
  - pass a connected map within degree and assert `valid: true`
  - pass a map missing `peer-c`, containing inactive `peer-x`, and over degree for `peer-a`; assert issue codes `missing-active-session`, `inactive-session-present`, `degree-limit-exceeded`, and `disconnected`
- In `packages/tests/shared-server/group-topology-config-repository.test.ts`:
  - store durable config under full `GroupRef`
  - prove same `groupId` in different workspaces is isolated
  - store a temporary override with `expiresAtEpochMs`
  - prove expired override reads as `undefined`
  - prove deleting config removes only the matching scoped key
- In `packages/tests/shared-server/group-topology-config-service.test.ts`:
  - resolve `serverDefaults -> durable -> temporary -> requestOptions`
  - default server config to `topologyKind: 'auto'` plus existing threshold defaults
  - reject non-positive integers
  - reject `meshMinSize < treeMinSize`
  - reject `meshParamK > degreeLimit`
  - default temporary override expiry to 15 minutes and cap it at 24 hours

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-graph/group-topology-validation.test.ts packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts
```

**Expected Failure Before Implementation:**

- `validateGroupTopologyNextHops` is missing.
- `GroupTopologyConfigRepository` and `group-topology-config-service` imports fail.
- Config resolution helpers are missing.

**Checkbox Steps:**

- [x] Extend `packages/shared-graph/group-topology-validation.ts` with `GroupTopologyNextHopValidationInput` and `validateGroupTopologyNextHops(input)`.
- [x] Keep existing `validateGroupTopology(input)` behavior and tests intact.
- [x] Implement `GroupTopologyConfigRepository` as a `RuntimeStateJsonStore`.
- [x] Use namespaces `group-topology:config` and `group-topology:override`.
- [x] Build config keys as `[scopeKey(ref), idKey('group', ref.groupId)].join(':')`, matching `RtcTopologySnapshotRepository`.
- [x] Add repository methods `findConfig(ref)`, `putConfig(input)`, `deleteConfig(ref)`, `findOverride(ref)`, `putOverride(input, expiresAtEpochMs)`, `deleteOverride(ref)`, `configKey(ref)`, and `overrideKey(ref)`.
- [x] Store overrides with runtime-state expiry equal to `expiresAtEpochMs`.
- [x] Implement config helpers in `group-topology-config-service.ts`: `readDefaultGroupTopologyConfig(serverOptions)`, `validateGroupTopologyConfigPatch(patch)`, `validateEffectiveGroupTopologyConfig(config)`, `resolveGroupTopologyConfig(input)`, and `resolveOverrideExpiresAtEpochMs(input)`.
- [x] Define constants `DEFAULT_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 15 * 60 * 1000` and `MAX_GROUP_TOPOLOGY_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000`.
- [x] Represent validation failures with an exported `GroupTopologyConfigValidationError` that carries a `422` status and structured issues.
- [x] Export the repository and config helpers from `packages/shared-server/mod.ts`.
- [x] Run the focused command and confirm tests pass.

**Expected Pass After Implementation:**

- Runtime-state config is scoped, expiring, and deletable.
- Config resolution is deterministic and does not require a new env var.
- Existing graphology validation remains compatible while next-hop validation is available for topology snapshots.

**Verification Command:**

```bash
npx tsc -p packages/shared-graph/tsconfig.json --noEmit && npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

### Iteration 3: RTC Topology Service Per-Update Config

**Goal:** Make `RallarRtcTopologyService` use effective per-update topology options, including explicit topology kind, while preserving default behavior.

**Files:**

- Modify `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- Modify `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`, add:
  - `it('honors request topology kind override for star topology', ...)` with 8 active sessions and per-update `topologyKind: 'star'`
  - `it('honors request topology kind override for tree topology', ...)` with 4 active sessions and per-update `topologyKind: 'tree'`
  - `it('honors request topology kind override for mesh topology when group size can support mesh', ...)` with 16 active sessions and per-update `topologyKind: 'mesh'`
  - `it('uses per-update degree limit without replacing service-wide defaults', ...)` by calling `updateGroupTopology` twice with different per-update `degreeLimit` values and checking `snapshot.degreeLimit`
  - `it('keeps default threshold behavior when no per-update topology options are passed', ...)` to protect existing star/tree/mesh thresholds

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts
```

**Expected Failure Before Implementation:**

- `RallarRtcTopologyServiceOptions` has no `topologyKind`.
- `RallarRtcTopologyUpdateOptions` has no `topologyOptions`.
- Forced topology tests fail because `selectTopology(...)` only uses thresholds.

**Checkbox Steps:**

- [x] Import `GroupTopologyKindSetting` from the shared API contract.
- [x] Extend `RallarRtcTopologyServiceOptions` with `topologyKind?: GroupTopologyKindSetting`.
- [x] Extend `RallarRtcTopologyUpdateOptions` with `topologyOptions?: RallarRtcTopologyServiceOptions`.
- [x] Add internal `readTopologyOptions(updateOptions)` that overlays constructor options with per-update options.
- [x] Change `selectTopology(group, options)` to return explicit `star`, `tree`, or `mesh` when `topologyKind` is set to that value; keep threshold behavior for `auto` or undefined.
- [x] Thread effective options through `degreeLimit`, `treeMinSize`, `meshMinSize`, `meshArgs`, `createRoomGraph`, `createNextHopMap`, `createNoRttMeshNextHopMap`, and no-RTT tree creation.
- [x] Keep `rttRebuildDebounceMs` service-level only; request-time topology reconfigure must not alter pending debounce behavior.
- [x] Preserve metrics, snapshot versioning, previous snapshot handling, pending RTT queue behavior, and `removeGroupTopology(...)`.
- [x] Run the focused command and confirm new and existing tests pass.

**Expected Pass After Implementation:**

- Default topology selection remains unchanged.
- Per-update config can force topology kind and degree limit for one recompute.
- Service-level defaults are not mutated by request-time options.

**Verification Command:**

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

### Iteration 4: Shared-Server Topology Management Service And WS Reuse

**Goal:** Extract recompute, validation, persistence, RTT reads, and publish behavior into one shared-server service used by REST and WS topic flows.

**Files:**

- Create `packages/shared-server/rallar-system/services/group-topology-management-service.ts`
- Modify `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify `packages/shared-server/mod.ts`
- Create `packages/tests/shared-server/group-topology-management-service.test.ts`
- Modify `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-server/group-topology-management-service.test.ts`:
  - read topology view by full `GroupRef`
  - return no `snapshot` when the group exists but no topology snapshot exists
  - resolve effective config and pass it into `RallarRtcTopologyService.updateGroupTopology(...)`
  - read RTTs through `RtcRttRepository.listMeasurementsForSessionIds(...)` when runtime state is configured
  - use `RtcTopologySnapshotRepository.withSnapshotLock(...)`
  - persist changed topology snapshots
  - validate next-hop maps before persisting/publishing and return/throw a structured `422` validation error on invalid topology
  - return `published: true` and call publisher when `publish` is true and topology changed
  - return `published: false` when `publish` is false
  - return `changed: false` when previous next-hop map is unchanged
  - write/delete durable config and temporary override, defaulting `reconfigure` to true
- In `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`:
  - keep existing group snapshot and RTT recompute behavior passing after delegation
  - add one assertion that WS recompute passes resolved default config through the new service path

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
```

**Expected Failure Before Implementation:**

- `GroupTopologyManagementService` does not exist.
- WS topic tests fail during extraction until private helper behavior is delegated correctly.

**Checkbox Steps:**

- [x] Define `GroupTopologyManagementService` with injected dependencies: group snapshot reader, `GroupTopologyConfigRepository`, `RallarRtcTopologyService`, optional `RtcTopologySnapshotRepository`, optional `RtcRttRepository`, fallback process RTT reader, publisher, server defaults, and `now`.
- [x] Add methods `readTopologyView(groupRef)`, `readConfig(groupRef)`, `putConfig(input)`, `deleteConfig(input)`, `readOverride(groupRef)`, `putOverride(input)`, `deleteOverride(input)`, and `reconfigureGroupTopology(input)`.
- [x] Make config writes/deletes default `reconfigure` to true and `publish` to true.
- [x] Make `reconfigureGroupTopology` apply request-time options only to that recompute.
- [x] Add a small exported publisher helper that builds the same `newALBroadcastMessage(...)` for `AppTopics.overlayTopology` currently built by `publishRtcOverlayTopologyResult(...)`.
- [x] Keep message target metadata: `groupRef`, `minSnapshotVersion`, reliability `best-effort`, and `ack: 'none'`.
- [x] Move durable topology snapshot locking behavior equivalent to `updateRtcOverlayTopology(...)` into the new service.
- [x] Move durable RTT read behavior equivalent to `readRtcTopologyRttMeasurements(...)` into the new service.
- [x] Validate computed next-hop maps with `validateGroupTopologyNextHops(...)` before persistence and publication.
- [x] Refactor `ws-system-topics.ts` so group snapshot, RTT timer, and APP_OUTBOX recomputes call the new service instead of private duplicate logic.
- [x] Keep `initRallarSystemWsTopics(...)` public options backward compatible.
- [x] Export the new service from `packages/shared-server/mod.ts`.
- [x] Run the focused command and confirm tests pass.

**Expected Pass After Implementation:**

- REST and WS have one recompute/publish path.
- Current WS topology behavior stays compatible.
- Invalid generated topologies cannot be persisted or published.

**Verification Command:**

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

### Iteration 5: API-V1 Scoped Graph And Topology Routes

**Goal:** Add scoped REST routes with current route dependency injection, auth, strict-read behavior, error mapping, and no real database dependency in route tests.

**Files:**

- Create `apps/api-v1/src/routes/graph-topology-routes.ts`
- Create `apps/api-v1/test/routes/graph-topology-routes.test.ts`

**Tests To Add First:**

- `GET /api/state/apps/app-1/workspaces/workspace-1/graphs/global?includeMeasured=true&refresh=always`:
  - returns `200`
  - passes `{ applicationId: 'app-1', workspaceId: 'workspace-1' }` to graph diagnostics
  - returns serialized graph DTO with `groupRef.groupId === '__global__'`
- `GET /api/state/apps/app-1/workspaces/workspace-1/groups/room-1/graphs/latest`:
  - returns `200`
  - passes full `{ applicationId, workspaceId, groupId }` to graph diagnostics
  - returns serialized graph DTO with `groupRef`
- Strict read auth:
  - active group member can read group graph and topology
  - non-member receives `403` with group policy code when `RALLAR_STATE_STRICT_READ_AUTH=true`
- Write auth:
  - active group owner/admin can `PUT /topology/config`
  - regular active member cannot mutate config
  - platform admin listed in route deps can mutate any existing group
- `PUT /topology/override` forwards TTL and config to topology service.
- `DELETE /topology/config` and `DELETE /topology/override` default to reconfigure and publish.
- `POST /topology/reconfigure` forwards request-time options and returns `changed`, `published`, `snapshot`, and effective config.
- Missing group returns `404`.
- Invalid config or invalid topology returns `422` with structured issues.
- `Idempotency-Key` is used as fallback `requestId` for `PUT`, `DELETE`, and `POST`.

**Exact Focused Test Command:**

```bash
cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts
```

**Expected Failure Before Implementation:**

- `../../src/routes/graph-topology-routes.ts` import fails.
- New route requests return `404` in a test Hono app.

**Checkbox Steps:**

- [x] Create route dependency types: injectable `getGroupStateService`, `graphDiagnostics`, `topologyManagement`, `requireApiAuthSession`, `adminClientIds`, and `now`.
- [x] Mirror state route helpers for `toScope(c)`, `toGroupRef(c)`, `readRequestWithRequestId(c)`, and strict read env parsing.
- [x] Implement `assertCanReadGroupRef(...)` using `canReadGroupSnapshot(...)` only when strict read auth is enabled.
- [x] Implement `assertCanManageGroupRef(...)` that reads the group snapshot, allows admin client ids, otherwise applies `canUpdateGroupSnapshot(...)`.
- [x] Return `404` when the group snapshot cannot be read before graph/topology group operations.
- [x] Map auth errors to `401`, group policy denial to `403`, missing group/cache to `404`, stale/conflict messages to `409`, validation errors to `422`, and malformed input to `400`.
- [x] Implement scoped graph routes and call `serializeGraphInfoSnapshot(...)` before JSON response.
- [x] Implement topology read/config/override/reconfigure routes.
- [x] Parse delete query `reconfigure=false` if present; default deletes to `reconfigure: true`.
- [x] Run the focused Deno route test command and confirm tests pass.

**Expected Pass After Implementation:**

- New route tests pass without Postgres, real WS, or real graph algorithms.
- Route behavior matches current state-route auth and error conventions.

**Verification Command:**

```bash
cd apps/api-v1 && deno task check
```

### Iteration 6: API-V1 Server Wiring, OpenAPI, And Docs

**Goal:** Mount the real routes, wire durable topology runtime-state/APP_OUTBOX behavior, and publish accurate OpenAPI and product docs.

**Files:**

- Modify `apps/api-v1/src/create-rallar-server.ts`
- Modify `apps/api-v1/test/rallar-server.test.ts`
- Modify `apps/api-v1/resources/api-v1-openapi.yaml`
- Modify `apps/api-v1/test/swagger-routes.test.ts`
- Modify `docs/rallar-api-reference.md`
- Modify `docs/rallar-rtc-rtt-reporting.md`

**Tests To Add First:**

- In `apps/api-v1/test/rallar-server.test.ts`:
  - `createRallarServer` mounts the new scoped graph/topology route module
  - default system topic setup passes `rtcTopologyRuntimeState` into `initRallarSystemWsTopics(...)`
  - default system topic setup passes `rtcTopologyAppOutbox` with `outboxQueueReader`, `senderId`, `wake`, and `findGroupSnapshotByRef`
  - existing topic lists remain unchanged
- In `apps/api-v1/test/swagger-routes.test.ts`:
  - `/api/openapi.json` includes every new scoped graph/topology path
  - unscoped graph paths are absent
  - `GraphInfo` and `GraphInfoSnapshot` schemas require `groupRef`, not `graphId`
  - topology config schemas contain the `auto | star | tree | mesh` enum and positive integer constraints
  - reconfigure response schema includes `changed`, `published`, `snapshot`, and `config`
- In docs checks or plain assertions if existing tests are extended:
  - `docs/rallar-api-reference.md` mentions scoped graph/topology REST routes
  - `docs/rallar-rtc-rtt-reporting.md` notes REST reconfigure shares the WS recompute path

**Exact Focused Test Command:**

```bash
cd apps/api-v1 && deno test --allow-env --allow-read test/rallar-server.test.ts test/swagger-routes.test.ts
```

**Expected Failure Before Implementation:**

- Route path assertions fail because routes are not mounted.
- Runtime-state/APP_OUTBOX assertions fail because `create-rallar-server.ts` currently passes only `rtcTopologyOptions`.
- OpenAPI assertions fail because new paths are missing and graph schemas still use `graphId`.

**Checkbox Steps:**

- [x] Import and mount `graph-topology-routes.ts` after `groupStateRoutes.init`.
- [x] Create one `runtimeStateRepository = createRuntimeStateRepository(sql)` inside `createRallarServer(...)` for topology config, topology snapshots, RTTs, and auth/session compatibility.
- [x] Construct `GroupTopologyConfigRepository`, `RtcTopologySnapshotRepository`, `RtcRttRepository`, and `GroupTopologyManagementService` with `serverDefaults` from existing `getApiRtcTopologyServiceOptions()` plus `topologyKind: 'auto'`.
- [x] Construct graph diagnostics dependencies from `packages/shared-graph/graph-diagnostics-service.ts`.
- [x] Pass `adminClientIds: readAdminClientIds()` into the new route module.
- [x] Pass `rtcTopologyRuntimeState: { repository: runtimeStateRepository }` into `initRallarSystemWsTopics(...)`.
- [x] Pass `rtcTopologyAppOutbox` with `outboxQueueReader: runtime.outboxQueueReader`, `senderId: myServerId`, `wake: () => runtime.qboxEngine.wake()`, and `findGroupSnapshotByRef` using `createGroupStateSnapshotReadThroughCache({ groupsRepository: runtime.groupsRepository }).findOrLoadByRef(...)`.
- [x] Preserve `initDynamicTopics: false` and CRDT topic installation.
- [x] Update OpenAPI with scoped graph diagnostics and topology management paths.
- [x] Replace Graph schemas from `graphId` to `groupRef` and document Graphology export shape as `additionalProperties: true`.
- [x] Remove the unscoped graph route module, OpenAPI paths, and workbench presets.
- [x] Update docs without changing environment variable surface.
- [x] Run the focused Deno command and confirm tests pass.

**Expected Pass After Implementation:**

- Real API-v1 exposes only the scoped graph/topology routes.
- OpenAPI matches runtime `groupRef` contracts.
- API-v1 default topology recompute uses runtime-state/APP_OUTBOX infrastructure.
- Docs describe the new REST product surface and shared recompute path.

**Verification Command:**

```bash
cd apps/api-v1 && deno task check
```

### Iteration 7: Shared-Web Helpers And Black-Box Workbench

**Goal:** Expose browser helper functions and update the black-box REST workbench catalog to expose only scoped graph/topology routes.

**Files:**

- Modify `packages/shared-web/browser/api-integration.ts`
- Modify `packages/tests/shared-web/api-workflows.test.ts`
- Modify `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` if the snapshot expects explicit export lists
- Modify `apps/rallar-black-box/src/rallar-server-workbench.ts`
- Modify `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`

**Tests To Add First:**

- In `packages/tests/shared-web/api-workflows.test.ts`:
  - `readStateScopedGlobalGraph(...)` builds `/api/state/apps/{applicationId}/workspaces/{workspaceId}/graphs/global?includeMeasured=true&refresh=always`
  - `readStateGroupGraph(...)` encodes `groupId` and query params
  - `readStateGroupTopology(...)` builds `/groups/{groupId}/topology`
  - `putStateGroupTopologyConfig(...)`, `putStateGroupTopologyOverride(...)`, and `reconfigureStateGroupTopology(...)` use auth-capable `PUT`/`POST` paths
  - `deleteStateGroupTopologyConfig(...)` and `deleteStateGroupTopologyOverride(...)` use `DELETE` and encode `reconfigure=false` when requested
- In `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`:
  - endpoint presets include `graph-scoped-global`, `group-graph-latest`, `group-topology-read`, `group-topology-config-put`, `group-topology-override-put`, and `group-topology-reconfigure`
  - delete presets exist for config and override
  - removed `graph-global` and `graph-group` presets are absent

**Exact Focused Test Command:**

```bash
npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts
```

**Expected Failure Before Implementation:**

- New shared-web helper imports are missing.
- `executeHttpRequest(...)` does not accept `DELETE`.
- Workbench preset assertions fail because scoped graph/topology endpoints are not yet listed.

**Checkbox Steps:**

- [x] Import graph/topology DTO request/response types from `@shared/api/graph-topology-management-types.ts`.
- [x] Extend `ApiHttpError.method` and `executeHttpRequest(...)` method union to include `DELETE`.
- [x] Make `executeHttpRequest(...)` allow `DELETE` without a JSON body.
- [x] Add helpers `readStateScopedGlobalGraph`, `readStateGroupGraph`, `readStateGroupTopology`, `readStateGroupTopologyConfig`, `putStateGroupTopologyConfig`, `deleteStateGroupTopologyConfig`, `readStateGroupTopologyOverride`, `putStateGroupTopologyOverride`, `deleteStateGroupTopologyOverride`, and `reconfigureStateGroupTopology`.
- [x] Keep helpers graphology-free by returning serialized DTO types.
- [x] Add endpoint presets for new scoped graph/topology routes in `rallar-server-workbench.ts`.
- [x] Remove the unscoped `graph-global` and `graph-group` presets.
- [x] Update public API snapshots only if they include `api-integration.ts` named exports.
- [x] Run the focused Vitest command and confirm tests pass.

**Expected Pass After Implementation:**

- Browser helper tests prove path encoding, query encoding, auth, and DELETE support.
- Black-box workbench tests prove operators can discover the scoped product API and cannot select removed unscoped presets.

**Verification Command:**

```bash
npx tsc -p packages/shared-web/tsconfig.json --noEmit && npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

## Local Validation Matrix

Focused tests:

```bash
npx vitest run packages/tests/shared-graph/group-graph-services.test.ts packages/tests/shared-graph/graphology-serialization.test.ts
npx vitest run packages/tests/shared-graph/group-topology-validation.test.ts packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts
npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts
npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts
cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts
npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts
```

Type and app checks:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-graph/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

Broader relevant suites after focused checks pass:

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

- No Prisma migration is expected because new topology config uses existing `runtime_state_store` namespaces.
- Existing production hardening still requires `RALLAR_STATE_STRICT_READ_AUTH=1`, which protects group graph/topology reads.
- Keep topology-kind forcing as REST config/override/reconfigure data, not an environment variable, so existing Hetzner topology env handling remains unchanged.

## Rollback Plan

- The removed unscoped graph routes are not a rollback surface.
- Durable topology config can be rolled back operationally by deleting rows in `runtime_state_store` namespaces `group-topology:config` and `group-topology:override`.
- If runtime-state/APP_OUTBOX topology wiring causes production trouble, temporarily omit `rtcTopologyRuntimeState` and `rtcTopologyAppOutbox` from `create-rallar-server.ts` while keeping REST config storage and direct recompute behavior.
- Shared-web helper additions are additive.
- Existing browser room routing continues to consume `AppTopics.overlayTopology`.

## Final Acceptance Criteria

- Scoped graph diagnostic routes return serialized `groupRef` graph snapshots and never depend on bare `groupId`.
- Scoped global graph diagnostics include only active sessions from the requested `applicationId` and `workspaceId`.
- Graph diagnostic refresh modes `never`, `if-missing`, and `always` are implemented and tested.
- Topology config persists durable and temporary overrides by full `GroupRef`.
- Effective topology config resolves in this order: server defaults, durable group config, temporary override, request-time options.
- Temporary overrides default to 15 minutes, cap at 24 hours, and expire through runtime-state expiry.
- Invalid config returns `422` and does not publish topology.
- Invalid computed topology returns `422` and is not persisted or published.
- Group owners/admins can manage topology for their groups.
- Platform admin client ids from `AUTH_ADMIN_CLIENT_IDS` can manage any existing group.
- Non-admin group members cannot mutate topology config.
- REST reconfigure and WS-triggered recompute use the same shared-server recompute/publish path.
- API-v1 wires durable RTC topology runtime-state and coalesced APP_OUTBOX behavior without changing existing topic IDs.
- OpenAPI documents all new routes and uses `groupRef`, not `graphId`, for graph schemas.
- Docs describe the new REST surface and shared topology recompute path.
- Shared-web helpers support GET, PUT, POST, and DELETE for the new product routes.
- Black-box workbench exposes scoped graph/topology presets and omits the removed unscoped presets.
- API-v1 and OpenAPI omit the removed unscoped graph paths.
- Focused tests, type checks, shared-web bundle boundary checks, and `cd apps/api-v1 && deno task check` pass.

## Implementation Progress

### Iteration 1: Shared Contracts And Graph Diagnostic Reads

- Date/time: 2026-07-07 23:00:55 CEST
- Completed steps: added graph/topology REST DTO contracts, graphology serialization helpers, scoped global graph ref/computation, diagnostic read helpers with `never`/`if-missing`/`always` refresh semantics, and graph/shared exports.
- Files changed: `packages/shared/api/graph-topology-management-types.ts`, `packages/shared/mod.ts`, `packages/shared-graph/graph-diagnostics-serialization.ts`, `packages/shared-graph/graph-diagnostics-service.ts`, `packages/shared-graph/group-graphs-create-service.ts`, `packages/shared-graph/mod.ts`, `packages/tests/shared-graph/group-graph-services.test.ts`, `packages/tests/shared-graph/graphology-serialization.test.ts`.
- Commands run:
  - `npx vitest run packages/tests/shared-graph/group-graph-services.test.ts packages/tests/shared-graph/graphology-serialization.test.ts` initially failed as expected because the diagnostic helper modules were missing.
  - `npx vitest run packages/tests/shared-graph/group-graph-services.test.ts packages/tests/shared-graph/graphology-serialization.test.ts` passed with 8 tests after implementation.
  - `npx tsc -p packages/shared/tsconfig.json --noEmit && npx tsc -p packages/shared-graph/tsconfig.json --noEmit` initially failed on serialized graph attribute typing, then passed after loosening exported graph attributes to `unknown`.
- Blockers: none.
- Follow-up validation still required: remaining iterations and final validation matrix.

### Iteration 2: Config Persistence, Resolution, And Validation

- Date/time: 2026-07-07 23:04:46 CEST
- Completed steps: added next-hop topology validation, runtime-state durable config/temporary override repository, deterministic config defaults/validation/resolution, override TTL capping, and shared-server exports.
- Files changed: `packages/shared-graph/group-topology-validation.ts`, `packages/tests/shared-graph/group-topology-validation.test.ts`, `packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts`, `packages/shared-server/rallar-system/services/group-topology-config-service.ts`, `packages/shared-server/mod.ts`, `packages/tests/shared-server/group-topology-config-repository.test.ts`, `packages/tests/shared-server/group-topology-config-service.test.ts`.
- Commands run:
  - `npx vitest run packages/tests/shared-graph/group-topology-validation.test.ts packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts` initially failed as expected because the next-hop validator and repository/service modules were missing.
  - `npx vitest run packages/tests/shared-graph/group-topology-validation.test.ts packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts` passed with 8 tests after implementation.
  - `npx tsc -p packages/shared-graph/tsconfig.json --noEmit && npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
- Blockers: none.
- Follow-up validation still required: remaining iterations and final validation matrix.

### Iteration 3: RTC Topology Service Per-Update Config

- Date/time: 2026-07-07 23:07:01 CEST
- Completed steps: added per-update topology options, explicit `star`/`tree`/`mesh` selection, per-update degree limits, option-aware graph/no-RTT planning, and retained service-level RTT debounce behavior.
- Files changed: `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`, `packages/tests/shared-server/rallar-rtc-topology-service.test.ts`.
- Commands run:
  - `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts` initially failed as expected because forced topology kind and per-update degree limit were ignored.
  - `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts` passed with 26 tests after implementation.
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
- Blockers: none.
- Follow-up validation still required: remaining iterations and final validation matrix.

### Iteration 4: Shared-Server Topology Management Service And WS Reuse

- Date/time: 2026-07-07 23:13:20 CEST
- Completed steps: added `GroupTopologyManagementService`, overlay topology broadcast helper, durable snapshot locking/persistence, durable RTT reads, computed topology validation, config/override write-delete reconfigure defaults, and WS delegation for group snapshot, APP_OUTBOX, and RTT timer recomputes.
- Files changed: `packages/shared-server/rallar-system/services/group-topology-management-service.ts`, `packages/shared-server/rallar-system/ws-system-topics.ts`, `packages/shared-server/mod.ts`, `packages/tests/shared-server/group-topology-management-service.test.ts`, `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`.
- Commands run:
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts` initially failed as expected because the management service module was missing and WS did not pass resolved config.
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts` passed with 11 tests after implementation.
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit` initially failed on publisher return typing, then passed after making WS publisher wrappers return `void`.
- Blockers: none.
- Follow-up validation still required: remaining iterations and final validation matrix.

### Iteration 5: API-V1 Scoped Graph And Topology Routes

- Date/time: 2026-07-07 23:17:56 CEST
- Completed steps: added dependency-injected scoped graph/topology API-v1 route module, strict-read checks, manage auth with platform admin bypass, scoped graph diagnostics, topology config/override/reconfigure endpoints, delete `reconfigure=false` parsing, and route-local error mapping.
- Files changed: `apps/api-v1/src/routes/graph-topology-routes.ts`, `apps/api-v1/test/routes/graph-topology-routes.test.ts`.
- Commands run:
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts` initially failed as expected because the route module was missing.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts` passed with 5 tests after implementation.
  - `cd apps/api-v1 && deno task check` passed.
- Blockers: none.
- Follow-up validation still required: remaining iterations and final validation matrix.

### Iteration 6: API-V1 Wiring, OpenAPI, And Docs

- Date/time: 2026-07-07 23:24:47 CEST
- Completed steps: mounted scoped graph/topology REST routes in API-v1, wired durable runtime-state repositories for topology config/snapshots/RTTs, connected APP_OUTBOX topology recompute wiring, passed graph diagnostics/topology management/admin dependencies into the route module, kept removed unscoped graph routes absent from runtime and OpenAPI, and documented the REST surface plus shared recompute behavior.
- Files changed: `apps/api-v1/src/create-rallar-server.ts`, `apps/api-v1/test/rallar-server.test.ts`, `apps/api-v1/resources/api-v1-openapi.yaml`, `apps/api-v1/test/swagger-routes.test.ts`, `docs/rallar-api-reference.md`, `docs/rallar-rtc-rtt-reporting.md`, `plans/api-v1-graph-topology-management-implementation-plan.md`.
- Commands run:
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/rallar-server.test.ts test/swagger-routes.test.ts` initially failed because the server-level global graph route assertion treated an empty diagnostic-cache `404` as missing route registration.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/rallar-server.test.ts test/swagger-routes.test.ts` passed with 9 tests after asserting the mounted route through deterministic invalid-query handling.
  - `cd apps/api-v1 && deno task check` passed.
- Blockers: none.
- Follow-up validation still required: Iteration 7 and final validation matrix.

### Iteration 7: Shared-Web Helpers And Black-Box Workbench

- Date/time: 2026-07-07 23:29:56 CEST
- Completed steps: added serialized scoped graph/topology browser REST helpers, added authenticated `PUT`/`POST` and bodyless `DELETE` support, kept browser helpers free of Graphology runtime dependencies, added black-box workbench presets for scoped graph/topology routes, removed unscoped graph presets, and documented the shared-web/workbench surface in the package architecture notes.
- Files changed: `packages/shared-web/browser/api-integration.ts`, `packages/tests/shared-web/api-workflows.test.ts`, `apps/rallar-black-box/src/rallar-server-workbench.ts`, `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`, `packages/shared-web/architecture.md`, `plans/api-v1-graph-topology-management-implementation-plan.md`.
- Commands run:
  - `npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts` initially failed as expected because the shared-web helper exports and workbench presets were missing.
  - `npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts` passed with 55 tests after implementation and again after the doc update.
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` passed all browser bundle budgets.
- Blockers: none.
- Follow-up validation still required: final validation matrix completed below; remote CI/deployment validation was not run locally.

### Final Validation Matrix

- Date/time: 2026-07-07 23:33:57 CEST
- Completed steps: ran the local focused suites, type checks, API-v1 Deno checks, shared-web browser bundle check, broader hardening/Deno suites, Postgres presence-expiry smoke, Docker cleanup, and whitespace validation.
- Commands run:
  - `npx vitest run packages/tests/shared-graph/group-graph-services.test.ts packages/tests/shared-graph/graphology-serialization.test.ts` passed with 8 tests.
  - `npx vitest run packages/tests/shared-graph/group-topology-validation.test.ts packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts` passed with 8 tests.
  - `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts` passed with 26 tests.
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts` passed with 13 tests.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts` passed with 14 tests.
  - `npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box/rallar-server-workbench.test.ts` passed with 55 tests.
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npx tsc -p packages/shared-graph/tsconfig.json --noEmit`, `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
  - `cd apps/api-v1 && deno task check` passed.
  - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` passed all browser bundle budgets.
  - `npm run test:rallar-server-hardening` passed with 57 Vitest tests and 30 API-v1 Deno tests.
  - `npm run test:deno` passed with 132 API-v1 tests, 57 control-server tests, relic server check, and 146 shared-test Deno tests.
  - `npm run db:test:up` failed in the sandbox on Docker socket permissions, then outside the sandbox started the Postgres container but failed at `prisma migrate deploy` because `DATABASE_URL` was not configured for Prisma.
  - `npm run test:postgres:presence-expiry` failed in the sandbox on npm registry DNS for Deno `npm:vitest`, then passed outside the sandbox with 2 tests using the script's default `DATABASE_URL`.
  - `npm run db:test:down` failed in the sandbox on Docker socket permissions, then passed outside the sandbox and removed the local Postgres container/network.
  - `git diff --check` passed.
- Blockers: `npm run db:test:up` requires `DATABASE_URL` for Prisma migration in this environment; the direct Postgres smoke still passed against the script default database URL.
- Follow-up validation still required: remote CI/deployment validation was not run from this local workspace.

### Review Comment Fixes

- Date/time: 2026-07-07 23:43:09 CEST
- Completed steps: added regressions for failed reconfigure rollback and RTT due-flush effective config forwarding; restored previous durable config/override state when reconfigure validation fails; passed effective topology config into due RTT topology flushes.
- Files changed: `packages/shared-server/rallar-system/services/group-topology-management-service.ts`, `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`, `packages/tests/shared-server/group-topology-management-service.test.ts`, `plans/api-v1-graph-topology-management-implementation-plan.md`.
- Commands run:
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts` initially failed as expected because failed reconfigure writes remained persisted and RTT due flushes did not forward effective topology options.
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts` passed with 7 tests after implementation.
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts` passed with 39 tests.
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts` passed with 14 tests.
- Blockers: none.
- Follow-up validation still required: remote CI/deployment validation was not run from this local workspace.

### Review Comment Fixes 2

- Date/time: 2026-07-07 23:53:44 CEST
- Completed steps: added regressions for bodyless topology reconfigure requests and failed delete reconfigure rollback; accepted empty reconfigure request bodies as default options while preserving malformed JSON errors; restored previous durable config/override state when delete-triggered reconfigure validation fails.
- Files changed: `apps/api-v1/src/routes/graph-topology-routes.ts`, `apps/api-v1/test/routes/graph-topology-routes.test.ts`, `packages/shared-server/rallar-system/services/group-topology-management-service.ts`, `packages/tests/shared-server/group-topology-management-service.test.ts`, `plans/api-v1-graph-topology-management-implementation-plan.md`.
- Commands run:
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts` initially failed as expected because delete-triggered reconfigure validation left stored config/override rows deleted.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts` initially failed as expected because bodyless reconfigure returned `400`.
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts` passed with 8 tests after implementation.
  - `npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts` passed with 40 tests.
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts` passed with 15 tests.
  - `cd apps/api-v1 && deno task check` passed.
  - `git diff --check` passed.
- Blockers: none.
- Follow-up validation still required: remote CI/deployment validation was not run from this local workspace.

### Review Comment Fixes 3

- Date/time: 2026-07-08 00:04:46 CEST
- Completed steps: added an OpenAPI regression for graph/topology query parameters; documented `includeMeasured`, `refresh`, and delete `reconfigure` query parameters on the affected scoped graph/topology operations.
- Files changed: `apps/api-v1/resources/api-v1-openapi.yaml`, `apps/api-v1/test/swagger-routes.test.ts`, `plans/api-v1-graph-topology-management-implementation-plan.md`.
- Commands run:
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts` initially failed as expected because the scoped graph OpenAPI operation omitted `GraphIncludeMeasured` and `GraphRefresh`.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts` passed with 5 tests after the OpenAPI update.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/graph-topology-routes.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts` passed with 15 tests.
  - `cd apps/api-v1 && deno task check` passed.
  - `git diff --check` passed.
- Blockers: none.
- Follow-up validation still required: remote CI/deployment validation was not run from this local workspace.
