# Rallar Server Admin Operations REST API Plan

Date: 2026-07-08

Status: Planning document for admin-facing Rallar Server statistics and
operations.

## Goal

Add a coherent admin operations REST surface for authorised Rallar Server
operators. The surface should expose useful operational statistics and a small
set of explicit write operations for maintenance, diagnostics, and recovery.

The first implementation slice should focus on admin operations. SPA product UX
and debug/support workflows are planned separately in:

- `plans/rallar-server-spa-statistics-rest-api-plan.md`
- `plans/rallar-server-debug-support-statistics-rest-api-plan.md`

## Current Context

Rallar Server is composed in `apps/api-v1` through
`createRallarServer()`. The reusable server facade lives in
`packages/shared-server`, while api-v1 owns Hono route registration, auth
composition, OpenAPI, CORS, environment variables, and process startup.

Useful operational data already exists, but it is spread across several
surfaces:

- `rallar.ws.status()` reports live WebSocket connection counts and ids.
- `RallarRtcTopologyService.readMetrics()` reports topology planning, RTT
  queueing, publish, and recompute counters.
- `RallarRtcTopologyService.resetMetrics()` can reset those in-memory counters.
- `runtime_state_store` stores auth sessions, state snapshots, presence, and AL
  runtime state.
- `resource_inbox` and `resource_inbox_results` store QueueBox and app-inbox
  work/results.
- `client_state_events` and `group_state_events` store durable state event
  logs.
- `crdt_documents`, `crdt_updates`, and `crdt_snapshots` store CRDT operational
  metadata and append/snapshot counts.
- Existing CRDT admin routes already provide integrity checks, debug export,
  backup export, compaction, lifecycle, and erasure operations.
- Existing topology management routes already expose scoped topology reads and
  reconfiguration paths.

The new admin API should collect these into one operational product instead of
requiring admins to know every subsystem route.

## Recommended Approach

Create one coherent admin namespace:

```text
/api/admin/operations/*
```

This namespace should require:

- normal bearer API auth
- `x-client-id` matching the authenticated session
- platform admin authorization using `AUTH_ADMIN_CLIENT_IDS`

The admin surface should offer broad read views and narrow write operations.
Reads can aggregate across scopes. Writes must be explicit, auditable, bounded,
and conservative by default.

## Non-Goals

- No unauthenticated metrics endpoint in this first slice.
- No Prometheus exporter in this first slice.
- No historical metrics warehouse in this first slice.
- No replacement of existing CRDT admin or topology routes.
- No raw token, password, queue payload, CRDT payload, or full user data export.
- No broad "run arbitrary SQL" or "delete arbitrary rows" operations.
- No product-facing SPA route changes in this first slice.

## API Shape

### Overview

```text
GET /api/admin/operations/overview
```

Returns a compact dashboard payload:

- generated timestamp
- server/runtime identity
- admin-visible health summary
- WebSocket connection counts
- active client/session/group summaries
- queue pressure summary
- topology metrics summary
- CRDT document/storage summary
- runtime/app-data row pressure summary
- warnings for unavailable or partial sources

This endpoint should be cheap enough for periodic dashboard refresh.

### Queues

```text
GET /api/admin/operations/queues
```

Returns QueueBox and app-inbox result statistics:

- counts by `ri_type_id` and `ri_status`
- counts by `ris_type_id` and `ris_status`
- oldest queued row age
- oldest reserved row age
- retry/attempt buckets
- expired row counts waiting for pruning
- top N type/status pressure rows

The implementation should use Postgres aggregate queries instead of loading all
queue rows into memory.

### Realtime

```text
GET /api/admin/operations/realtime
```

Returns live realtime state:

- `rallar.ws.status()` summary
- open/closed WebSocket counts
- redacted or limited connection identifiers
- topology metrics from `RallarRtcTopologyService.readMetrics()`
- pending RTT topology update count
- topology snapshot count
- topology publish/change counters

This endpoint may be partially process-local in multi-server deployments.
Responses should say which server generated the snapshot.

### State

```text
GET /api/admin/operations/state
GET /api/admin/operations/state/apps/:applicationId/workspaces/:workspaceId
```

Returns client, group, session, and event summaries:

- total client principals
- online clients
- active client sessions
- active groups
- groups by status
- total active members
- online members
- largest rooms by online member count
- recent client/group event counts
- stale or expired presence pressure where detectable

The scoped path should be the primary operational view. A global view can exist
for platform admins, but it should be designed around aggregate count queries.

### CRDT

```text
GET /api/admin/operations/crdt
GET /api/admin/operations/crdt/apps/:applicationId/workspaces/:workspaceId
```

Returns CRDT operational summaries:

- document counts by lifecycle
- document counts by scope/type
- total updates and snapshots
- stored update bytes
- largest documents by stored bytes
- stale documents by `updated_at_ts`
- documents with high update-to-snapshot ratios
- documents near retention/quota limits when policy data is available

The response should use CRDT metadata only. It should not include update or
snapshot payloads.

### System

```text
GET /api/admin/operations/system
```

Returns infrastructure summaries:

- runtime state row counts by namespace
- runtime state expired-row count
- app data row counts by namespace/store
- app data expired-row count
- state event table counts by scope bucket
- database/pubsub mode summaries that are already safe to expose
- relevant server configuration modes, excluding secrets

This should help an operator see storage pressure and configuration shape
without inspecting the database directly.

## Write Operations

### Reset Metrics

```text
POST /api/admin/operations/metrics/reset
```

Resets explicitly resettable in-memory counters.

Initial scope:

- RTC topology metrics through `RallarRtcTopologyService.resetMetrics()`

Request body:

```ts
type AdminMetricsResetRequest = Readonly<{
  requestId?: string;
  categories?: readonly ('rtc-topology')[];
  reason?: string;
}>;
```

The response should include before/after summaries and warnings for categories
that are not resettable.

### Recompute Topology

```text
POST /api/admin/operations/topology/recompute
```

Recomputes topology for one `GroupRef`.

Request body:

```ts
type AdminTopologyRecomputeRequest = Readonly<{
  requestId?: string;
  groupRef: GroupRef;
  publish?: boolean;
  options?: GroupTopologyConfigPatch;
  reason?: string;
}>;
```

The operation should:

- require an existing group
- read the durable group snapshot
- reuse the existing topology management service where possible
- publish by default unless `publish: false`
- return previous/new topology summaries

### Prune Expired Rows

```text
POST /api/admin/operations/maintenance/prune-expired
```

Runs safe expiry pruning for supported stores.

Request body:

```ts
type AdminPruneExpiredRequest = Readonly<{
  requestId?: string;
  categories?: readonly (
    | 'runtime-state'
    | 'resource-inbox'
    | 'resource-inbox-results'
    | 'app-data'
  )[];
  dryRun?: boolean;
  reason?: string;
}>;
```

Rules:

- default `dryRun` should be `true` until product confidence is high
- real execution deletes only expired rows
- no arbitrary key or namespace deletion
- response reports category counts and changed status

### CRDT Integrity

```text
POST /api/admin/operations/crdt/integrity
```

Runs integrity verification for one CRDT document. This can wrap or delegate to
the existing CRDT admin integrity path.

### CRDT Debug Export

```text
POST /api/admin/operations/crdt/debug-export
```

Produces a debug bundle for one CRDT document.

Defaults:

- payloads redacted
- reason required or defaulted to an admin-operation reason
- response shape mirrors existing CRDT admin routes where practical

### CRDT Lifecycle Operations

```text
POST /api/admin/operations/crdt/compact
POST /api/admin/operations/crdt/lifecycle
POST /api/admin/operations/crdt/erase
```

These should either wrap the existing CRDT admin route behavior or remain as
links in the admin overview until a wrapper adds real value.

Rules:

- one document per request
- explicit reason
- audit event where existing CRDT audit supports it
- dry-run where meaningful
- destructive operations stay payload-redacted by default

## Response Contract Principles

Every admin response should include:

- `generatedAtEpochMs`
- `serverId` or runtime identity when relevant
- `scope` when scoped
- compact aggregate sections
- `warnings` for partial reads, expensive fallbacks, or unavailable sources

Admin responses must not include:

- bearer tokens
- WebSocket auth tickets
- passwords, password hashes, salts, or auth secrets
- raw queue payloads
- CRDT update/snapshot payloads unless explicitly using a redacted debug export
- unbounded row lists

Top lists must have explicit limits. Where identifiers are useful, return only
the identifiers needed for operator action.

## Error Model

Use route behavior consistent with current api-v1 routes:

- `401` for missing or invalid auth
- `403` for authenticated non-admin users
- `404` for missing groups, documents, or scoped targets
- `409` for stale/conflicting write requests
- `400` for malformed input
- `500` for unexpected operational failures

Errors should not leak secrets or raw payloads.

## Architecture

Recommended package split:

- `packages/shared-server/rallar-system/admin-operations/`
  - reusable DTOs and contracts
  - stat reader interfaces
  - aggregation helpers over client/group snapshots
  - operation result types
  - orchestration service for overview/read/write operations

- `packages/shared-server/postgres/admin-operations/`
  - Postgres aggregate readers for runtime state, queue, app data, CRDT, and
    event tables
  - count and age queries optimized for operations dashboards

- `apps/api-v1/src/routes/admin-operations-routes.ts`
  - Hono route mounting
  - bearer auth and admin authorization
  - request parsing
  - error responses
  - OpenAPI tags/schemas

- `apps/api-v1/src/create-rallar-server.ts`
  - dependency construction from existing runtime objects
  - route installer registration

This keeps `packages/shared-server` reusable and Hono-free while allowing
api-v1 to own deployment-specific auth and OpenAPI details.

## Data Sources

Initial read sources:

- live WebSocket status through the Rallar Server facade
- live RTC topology metrics from the topology service
- scoped client/group state repositories
- Postgres aggregate queries over runtime state
- Postgres aggregate queries over queue/result tables
- Postgres aggregate queries over CRDT metadata tables
- Postgres aggregate queries over state-event tables

Implementation should prefer direct aggregate queries for large tables. Snapshot
repository list calls are acceptable only for scoped views where data volume is
bounded or as a temporary implementation with a warning.

## Auditing And Timing

Write operations should emit either:

- existing CRDT audit events when using CRDT workflows
- structured Rallar timing events with operation, status, duration, admin
  client id, request id, target scope, and reason

Timing/audit events must avoid secrets and raw payloads.

## Phasing

### Phase 1: Admin Read Foundation

- Add contracts and dependency-injected admin operations service.
- Add Postgres aggregate readers for queue, runtime state, app data, CRDT, and
  state events.
- Add `/overview`, `/queues`, `/realtime`, `/state`, `/crdt`, and `/system`
  read routes.
- Add OpenAPI coverage.
- Add auth/admin tests.

### Phase 2: Controlled Admin Writes

- Add `/metrics/reset`.
- Add `/topology/recompute`.
- Add `/maintenance/prune-expired` with dry-run support.
- Add CRDT integrity/debug-export wrappers or documented links.
- Emit timing/audit events.

### Phase 3: Operator Polish

- Add top-N and age-bucket tuning.
- Add warnings for process-local metrics in multi-server deployments.
- Add optional dashboard-friendly response compression or field selection if
  payloads grow.
- Revisit historical metrics storage if current-state snapshots are not enough.

## Validation Plan

Focused validation should include:

- route auth tests for missing auth, invalid auth, and non-admin users
- overview composition with partial unavailable stats
- pglite/in-memory schema tests for aggregate readers
- queue age and status grouping tests
- runtime-state/app-data expiry count tests
- CRDT summary tests using CRDT metadata only
- topology recompute tests for existing and missing groups
- metrics reset tests proving only resettable counters reset
- prune dry-run and real execution tests
- CRDT debug export redaction default tests
- OpenAPI route/schema tests

Candidate commands:

- `cd apps/api-v1 && deno task check`
- focused api-v1 Deno tests for admin routes
- focused shared-server tests for aggregate readers
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`

## Open Decisions For Implementation

- Whether `/api/admin/operations/state` should support a global unscoped view
  in phase 1, or require application/workspace scope for all state counts.
- Whether `prune-expired` should default to dry-run permanently or only during
  early rollout.
- Whether CRDT lifecycle wrappers should be added immediately or whether the
  admin overview should deep-link/document the existing CRDT admin routes first.
- Whether a future unauthenticated `/healthz` or Prometheus endpoint should be
  added separately from this admin-only surface.
