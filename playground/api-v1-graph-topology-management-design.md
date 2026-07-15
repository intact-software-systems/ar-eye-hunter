# API V1 Graph And Topology Management Design

Date: 2026-07-07
Status: brainstormed design

## Product Intent

`apps/api-v1` should become the complete Rallar Server product package for managing scoped clients, groups, and group distribution graphs. The existing client and group state APIs already use `applicationId` and `workspaceId`; graph APIs should use the same scope model so same-id groups in different workspaces never collide.

The design treats two related concepts as first-class resources:

- Graph diagnostics: computed graph snapshots for inspecting predicted/measured connectivity and group graph shape.
- Overlay topology management: the actual RTC distribution plan clients use, including `star`, `tree`, or `mesh` topology, next hops, versions, and reconfiguration controls.

## Current API Review

Existing scoped state routes are already product-shaped:

- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/clients`
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups`
- `GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId`
- group and client mutation routes under the same app/workspace scope.

The historical unscoped graph surface is intentionally not mounted and is
absent from OpenAPI. Product graph reads use the scoped state API exclusively.

The lower-level graph code is already closer to the desired model:

- `computeGroupGraph(groupRef, includeMeasured)` accepts the full `GroupRef`.
- Graph repository keys include `applicationId`, `workspaceId`, and `groupId`.
- `GraphInfoSnapshot` carries `groupRef`, although the OpenAPI schema still describes older `graphId` fields.
- RTC distribution is now represented by `RallarOverlayTopologySnapshot`, keyed with `toScopedOverlayId(groupRef)` and published on `AppTopics.overlayTopology`.

## Decisions From Brainstorming

- Expose both graph diagnostics and overlay topology management as first-class APIs.
- Support scoped graph reads with `applicationId`, `workspaceId`, and `groupId`.
- Support on-demand group topology reconfiguration with per-group configuration.
- Resolve topology configuration in this order: server defaults, durable group config, temporary override, request-time reconfigure options.
- Allow group owners/admins to manage topology for their groups, and platform admins to manage any group.
- Defer manual node/edge editing. The product API should reconfigure through the RTC topology service instead of letting REST callers mutate graph edges directly.

## Proposed Resource Model

Use the existing state API scope as the product base:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId
```

This keeps graph and topology operations next to clients and groups, and avoids creating a second scoping convention.

### Existing Product Resources

| Resource | Purpose |
| --- | --- |
| `/clients` | Manage client principals, instances, sessions, and presence. |
| `/groups` | Manage group identity, membership, invites, roles, ownership, and presence. |

### New Product Resources

| Resource | Purpose |
| --- | --- |
| `/graphs/global` | Read app/workspace-scoped graph diagnostics across active sessions in the scope. |
| `/groups/:groupId/graphs/latest` | Read the latest diagnostic graph snapshot for one group. |
| `/groups/:groupId/topology` | Read the effective topology management view for one group. |
| `/groups/:groupId/topology/config` | Read, write, and delete durable group topology config. |
| `/groups/:groupId/topology/override` | Read, write, and delete temporary group topology override config. |
| `/groups/:groupId/topology/reconfigure` | Recompute and optionally publish the group topology immediately. |

## Graph Diagnostics API

### Read Scoped Global Graph

```http
GET /api/state/apps/:applicationId/workspaces/:workspaceId/graphs/global?includeMeasured=true&refresh=if-missing
```

This returns a diagnostic graph for active sessions in one app/workspace
scope. No process-wide graph route is mounted.

The scoped global graph should use a reserved synthetic ref such as `{ applicationId, workspaceId, groupId: "__global__" }` so cache keys and response contracts still use `GroupRef`.

### Read Group Graph

```http
GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/graphs/latest?includeMeasured=true&refresh=if-missing
```

Query parameters:

- `includeMeasured`: defaults to `false`; includes measured RTT graph data when available.
- `refresh`: `if-missing`, `always`, or `never`; defaults to `if-missing`.

Response shape:

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

`SerializedGraphInfoSnapshot` should be the JSON-safe Graphology export shape. Runtime code may still use `GraphInfoSnapshot` with graph objects internally, but the REST contract should document the exported graph structure explicitly.

### Graph Diagnostics Rules

- Group reads must use `GroupRef`, not `groupId`.
- App/workspace global graph reads should derive active sessions from scoped client snapshots, not every client in the process.
- Graph snapshots are diagnostics, not the source of truth for live RTC routing.
- OpenAPI schemas should be updated from `graphId` to `groupRef`.

## Topology Management API

### Read Effective Topology

```http
GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology
```

Response shape:

```ts
type GroupTopologyManagementView = Readonly<{
  groupRef: GroupRef;
  overlayId: string;
  snapshot?: RallarOverlayTopologySnapshot;
  config: GroupTopologyConfigView;
  pending?: {
    reconfigureQueued: boolean;
    dueAtEpochMs?: number;
  };
}>;
```

The `snapshot` is omitted when the group exists but no topology has been computed yet. A caller can trigger `POST .../topology/reconfigure` to compute one.

### Read Durable Config

```http
GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config
```

Returns the stored durable config and its metadata, or an empty config object when no durable group config exists.

### Write Durable Config

```http
PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config
```

Request shape:

```ts
type PutGroupTopologyConfigRequest = Readonly<{
  requestId?: string;
  config: GroupTopologyConfigPatch;
  reconfigure?: boolean;
}>;
```

`reconfigure` defaults to `true`, so config changes immediately affect live topology unless the caller explicitly writes config only.

### Delete Durable Config

```http
DELETE /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config
```

This removes durable group config and falls back to server defaults plus any active temporary override.

Deletes should recompute and publish by default, matching config writes. If a caller needs config-only deletion later, add an explicit `?reconfigure=false` query parameter rather than changing the default.

### Write Temporary Override

```http
PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override
```

Request shape:

```ts
type PutGroupTopologyOverrideRequest = Readonly<{
  requestId?: string;
  config: GroupTopologyConfigPatch;
  ttlMs?: number;
  expiresAtEpochMs?: number;
  reconfigure?: boolean;
}>;
```

Temporary overrides default to 15 minutes and may last at most 24 hours. This makes load-test and incident-response experiments possible without permanently changing group behavior.

### Delete Temporary Override

```http
DELETE /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/override
```

This removes the active override and recomputes topology using durable config and server defaults.

### Reconfigure Now

```http
POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure
```

Request shape:

```ts
type ReconfigureGroupTopologyRequest = Readonly<{
  requestId?: string;
  options?: GroupTopologyConfigPatch;
  publish?: boolean;
}>;
```

`publish` defaults to `true`. Request-time options apply only to this recompute and do not mutate durable config or the temporary override.

Response shape:

```ts
type ReconfigureGroupTopologyResponse = Readonly<{
  groupRef: GroupRef;
  overlayId: string;
  changed: boolean;
  snapshot: RallarOverlayTopologySnapshot;
  previous?: RallarOverlayTopologySnapshot;
  config: GroupTopologyConfigView;
  published: boolean;
}>;
```

## Topology Config Contract

```ts
type GroupTopologyKindSetting = 'auto' | 'star' | 'tree' | 'mesh';

type GroupTopologyConfigPatch = Readonly<{
  topologyKind?: GroupTopologyKindSetting;
  degreeLimit?: number;
  treeMinSize?: number;
  meshMinSize?: number;
  meshParamK?: number;
}>;

type StoredGroupTopologyConfig = Readonly<{
  groupRef: GroupRef;
  config: GroupTopologyConfigPatch;
  version: number;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  updatedByPrincipalId: string;
  requestId?: string;
}>;

type StoredGroupTopologyOverride = StoredGroupTopologyConfig & Readonly<{
  expiresAtEpochMs: number;
}>;

type GroupTopologyConfigView = Readonly<{
  serverDefaults: Required<GroupTopologyConfigPatch>;
  durable?: StoredGroupTopologyConfig;
  temporary?: StoredGroupTopologyOverride;
  requestOptions?: GroupTopologyConfigPatch;
  effective: Required<GroupTopologyConfigPatch>;
}>;
```

Validation:

- `degreeLimit`, `treeMinSize`, `meshMinSize`, and `meshParamK` must be positive integers.
- `meshMinSize` must be greater than or equal to `treeMinSize` in the effective config.
- `meshParamK` must be less than or equal to `degreeLimit`.
- `topologyKind: 'auto'` uses thresholds; explicit `star`, `tree`, or `mesh` forces that topology when the active session count can support it.
- Forced `tree` or `mesh` must still produce a valid topology. If not, the API returns `422` with validation details and does not publish.

## Authorization

Graph and topology routes should reuse group-scoped policy instead of creating an unrelated permission model.

Reads:

- Group graph and topology reads require that the caller can read the target group when strict state read auth is enabled.
- Production hardening should continue to require strict read auth, which protects session topology details.

Writes:

- Durable config writes, temporary override writes, deletes, and reconfigure calls always require auth.
- Group owners/admins can manage topology for their own group, using the same policy as group updates.
- Platform admins can manage any group. The first implementation can use the existing `AUTH_ADMIN_CLIENT_IDS` convention; a later iteration can also honor auth-user roles when the product wants role-based platform administration.

## Persistence

Add a small shared-server repository rather than storing topology config inside group metadata:

- Namespace `group-topology:config` for durable config.
- Namespace `group-topology:override` for temporary overrides.
- Key by full `GroupRef`, using the same scoped key conventions as graph and RTC topology repositories.
- Store overrides with `purgeAfterEpochMs` so runtime-state expiry can remove them.

This keeps group state focused on group identity, roster, and presence while treating topology controls as server transport configuration.

## Service Architecture

Introduce a shared-server topology management service that both REST and WS-topic flows can use:

```text
Graph/topology routes
  -> GroupTopologyManagementService
      -> GroupStateService / GroupStateRepository
      -> GroupTopologyConfigRepository
      -> RtcRttRepository or rtt-repository
      -> RallarRtcTopologyService
      -> RtcTopologySnapshotRepository
      -> WsQueueBoxServerService publish path
```

Responsibilities:

- Resolve and validate effective config.
- Read the latest group snapshot by full `GroupRef`.
- Read relevant RTT measurements for active group sessions.
- Compute topology through `RallarRtcTopologyService`.
- Persist topology snapshots through `RtcTopologySnapshotRepository` when runtime state is configured.
- Publish `AppTopics.overlayTopology` when requested.
- Return the same snapshot the clients will observe.

The current private helpers around `updateRtcOverlayTopology`, `publishRtcOverlayTopology`, and runtime-state locks should be extracted or wrapped so REST reconfigure uses the same behavior as group snapshot and RTT-triggered recomputes.

## API V1 Route Organization

Prefer a new route module:

```text
apps/api-v1/src/routes/graph-topology-routes.ts
```

It should mount after group state routes and before Swagger. Do not mount a
parallel unscoped graph route module.

## OpenAPI Updates

Update `apps/api-v1/resources/api-v1-openapi.yaml`:

- Keep removed unscoped graph paths absent from the OpenAPI document.
- Add scoped graph diagnostics routes.
- Add topology management routes.
- Replace graph schemas that require `graphId` with schemas that require `groupRef`.
- Document Graphology export shape for `graph` and `groupGraph`.
- Add config, override, effective config, and reconfigure response schemas.

## Error Handling

Use the same status language as state routes:

- `401` when auth is required and missing or invalid.
- `403` when the caller cannot manage the group.
- `404` when the target group does not exist in the app/workspace scope.
- `409` for stale config versions when conditional updates are added.
- `422` when topology config is syntactically valid JSON but cannot produce a valid topology.

## Migration Plan

1. Add scoped read services and routes and remove the unscoped route surface.
2. Fix OpenAPI schemas to match `groupRef`.
3. Add durable and temporary config repository.
4. Extract topology recompute/publish behavior into a shared-server service.
5. Add topology management routes.
6. Assert removed unscoped graph routes stay unmounted and undocumented.
7. Update browser/admin tooling to use scoped graph and topology endpoints.

## Testing Plan

Route tests in `apps/api-v1`:

- Scoped group graph reads call `computeGroupGraph` with the full `GroupRef`.
- Same `groupId` in two workspaces returns separate graph/topology data.
- Strict read auth blocks non-members from graph/topology reads.
- Owners/admins can write topology config; non-admin members cannot.
- Platform admins can manage any group.
- Temporary overrides expire and fall back to durable config.
- `POST .../topology/reconfigure` returns and publishes the same topology snapshot.

Shared-server tests:

- Effective config resolution follows server defaults, durable config, temporary override, then request options.
- Runtime-state topology snapshot locking is reused for REST reconfigure.
- Reconfigure with unchanged next hops returns `changed: false`.

Shared-graph tests:

- Scoped global graph only includes active sessions from the requested app/workspace.
- Group graph diagnostics serialize using Graphology export shape.

OpenAPI tests:

- New routes appear in `/api/openapi.json`.
- `GraphInfoSnapshot` schemas require `groupRef`, not `graphId`.

## Deferred Work

- Manual REST editing of graph nodes and edges.
- Persisting diagnostic graph snapshots as durable historical records.
- Role-based platform admin authorization beyond `AUTH_ADMIN_CLIENT_IDS`.
- A dedicated operator dashboard for topology experiments.
