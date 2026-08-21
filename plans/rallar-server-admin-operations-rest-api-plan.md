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

## Repo Truths To Preserve

- Public REST DTOs that may be consumed by browser/admin UI code belong in
  `packages/shared/api`, then should be exported from `packages/shared/mod.ts`.
  Server-only orchestration and repository contracts belong in
  `packages/shared-server`.
- api-v1 OpenAPI is a checked-in YAML document at
  `apps/api-v1/resources/api-v1-openapi.yaml`, loaded by
  `apps/api-v1/src/config-repo.ts`. Route work must update that file and the
  existing swagger route tests.
- `runtime_state_store` is a JSON string key-value table. Client/group/auth/AL
  state lives under namespaces and encoded `store_key` prefixes, not normalized
  relational columns. Aggregate readers must either count by namespace/prefix or
  deliberately cast `store_value` to JSON for fields that cannot be derived from
  keys.
- `client_state_events` and `group_state_events` are normalized enough for
  scoped count queries. Their `workspace_key` uses `_` for missing workspace
  ids.
- api-v1 currently starts periodic eviction for `runtime_state_store` and
  `resource_inbox`. `resource_inbox_results` and `app_data_store` have
  `deleteExpired(...)` support, but api-v1 startup does not visibly schedule
  periodic pruning for those tables.
- `PSqlAppDataRepository.deleteExpired(...)` requires an app-data namespace and
  optional store name. A platform-wide app-data prune therefore needs a dedicated
  SQL-level admin helper or explicit namespace/store targets; it cannot be
  implemented through the generic app-data facade alone.
- Existing CRDT admin routes already expose document list, integrity,
  debug-export, backup-export, projection rebuild, compaction, lifecycle, and
  erase under `/api/crdt/admin/documents/*`. They wrap successful responses as
  `{ ok: true, result }` and repository failures as `{ ok: false, error }`.
- Existing topology reconfiguration is
  `/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/reconfigure`.
  `GroupTopologyManagementService.reconfigureGroupTopology(...)` accepts
  `groupRef`, optional request-time topology options, optional group snapshot,
  and publish behavior. It does not currently persist an admin `requestId` or
  `reason` for a plain recompute, so admin audit/timing must carry that context
  unless the service contract is extended.
- REST API additions should add or update no-browser API-v1 black-box recipes in
  `packages/shared-test/black-box-runner` alongside unit/route coverage.
- Admin authorization is currently route-local: CRDT admin has a private
  `requireCrdtAdminSession(...)`, topology routes accept platform admins through
  `adminClientIds`, and `create-rallar-server.ts` reads
  `AUTH_ADMIN_CLIENT_IDS` for each installer. Admin operations should extract or
  add a reusable api-v1 admin auth helper instead of copying CRDT-specific code.
- Existing `toAuthErrorResponse(...)` maps `Unauthorized:` errors to `401` and
  other auth failures to `400`. New admin routes should follow the newer
  state/topology route error mapping and return `403` for authenticated
  non-admin callers.
- Storage schema docs are guarded by
  `packages/tests/shared-server/rallar-server-schema-docs.test.ts`. Any admin
  aggregate that needs new indexes, planner statistics, or schema notes must
  update Prisma migrations/schema, the in-memory schema when applicable, and the
  shared-server storage docs together.

## Recommended Approach

Create one coherent admin namespace:

```text
/api/admin/operations/*
```

This namespace should require:

- normal bearer API auth
- `x-client-id` matching the authenticated session
- platform admin authorization using `AUTH_ADMIN_CLIENT_IDS`

Implementation should add one reusable api-v1 admin auth helper, probably beside
`apps/api-v1/src/services/request-auth-service.ts`, and use it from the new
admin operations routes. Existing CRDT admin behavior can remain compatible, but
new admin operations should not inherit its `403`-as-`400` response behavior.

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
    appData?: Readonly<{
        namespace?: string;
        storeName?: string;
    }>;
    dryRun?: boolean;
    reason?: string;
}>;
```

Rules:

- default `dryRun` should be `true` until product confidence is high
- real execution deletes only expired rows
- no arbitrary key or namespace deletion
- app-data pruning must either require `appData.namespace` or use a dedicated
  SQL helper that reports exactly which namespaces/stores it touched
- runtime-state and resource-inbox pruning should report that background
  eviction already exists in api-v1; resource-inbox-results and app-data pruning
  should report whether they are admin-triggered only
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

- `packages/shared/api/admin-operations-types.ts`
  - public request/response DTOs for the admin operations REST product
  - reusable enums for categories, warnings, and operation result statuses
  - exported from `packages/shared/mod.ts`

- `packages/shared-server/rallar-system/admin-operations/`
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
  - bearer auth and admin authorization through the shared api-v1 helper
  - request parsing
  - error responses
  - OpenAPI tags/schemas

- `apps/api-v1/src/services/request-auth-service.ts` or
  `apps/api-v1/src/services/admin-auth-service.ts`
  - reusable `requireApiAdminSession(...)`
  - `AUTH_ADMIN_CLIENT_IDS` allow-list checking
  - `401`/`403` error messages that route error mappers can preserve

- `apps/api-v1/src/create-rallar-server.ts`
  - dependency construction from existing runtime objects
  - route installer registration
  - one admin-client-id read that can be shared by topology, CRDT admin, and
    admin operations installers

- `apps/api-v1/resources/api-v1-openapi.yaml`
  - Admin Operations tag
  - path entries and schemas for every admin endpoint
  - reusable error responses for unauthorized/forbidden/admin operation errors

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

State aggregate readers should be explicit about their strategy:

- use `runtime_state_store.store_namespace` and `store_key` prefixes for cheap
  counts where possible
- use `store_value::jsonb` only for fields that cannot be derived from keys,
  such as group status or active session metadata
- avoid loading every JSON row into JavaScript for global admin views
- keep scoped fallback readers marked with warnings until SQL aggregate readers
  exist
- use existing indexes and planner statistics first; add migrations only when a
  representative aggregate query needs them
- when adding schema/index/statistics changes, keep
  `apps/api-v1/prisma/schema.prisma`,
  `apps/api-v1/src/db/in-memory-schema.sql`, and
  `packages/shared-server/rallar-server-repositories.md` aligned

## Docs And Discovery

Implementation should update:

- `docs/rallar-api-reference.md` with the admin operations namespace, auth
  requirements, response safety rules, and relationship to existing CRDT admin
  and topology routes
- `docs/environment-variables.md` so `AUTH_ADMIN_CLIENT_IDS` is documented as a
  platform-admin allow-list for registration, topology management, CRDT admin,
  and admin operations
- `apps/api-v1/resources/api-v1-openapi.yaml` as the source for generated
  Swagger/OpenAPI views
- black-box REST recipe docs when adding admin-operations recipes

This first slice should not add product SPA screens, but docs should make the
admin REST surface discoverable for operators and future SPA work.

## Auditing And Timing

Write operations should emit either:

- existing CRDT audit events when using CRDT workflows
- structured Rallar timing events with operation, status, duration, admin
  client id, request id, target scope, and reason

Timing/audit events must avoid secrets and raw payloads.

## Phasing

### Phase 1: Admin Read Foundation

- Add public REST contracts in `packages/shared/api/admin-operations-types.ts`.
- Add reusable api-v1 admin auth helper with explicit `401`/`403` behavior.
- Add shared-server dependency-injected admin operations service.
- Add Postgres aggregate readers for queue, runtime state, app data, CRDT, and
  state events.
- Add `/overview`, `/queues`, `/realtime`, `/state`, `/crdt`, and `/system`
  read routes.
- Update `apps/api-v1/resources/api-v1-openapi.yaml`.
- Add OpenAPI/swagger route coverage.
- Update API reference and environment variable docs.
- Add or update API-v1 black-box recipes for admin auth denial and one
  successful read path.
- Add auth/admin tests.

### Phase 2: Controlled Admin Writes

- Add `/metrics/reset`.
- Add `/topology/recompute`.
- Add `/maintenance/prune-expired` with dry-run support.
- Add CRDT integrity/debug-export wrappers or documented links.
- Add or update API-v1 black-box recipes for one safe write path, preferably
  dry-run pruning or redacted CRDT debug export.
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
- black-box recipe coverage for admin authorization and representative
  operations
- docs/schema alignment tests when storage docs, indexes, or migrations change

Candidate commands:

- `cd apps/api-v1 && deno task check`
- focused api-v1 Deno tests for admin routes
- `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts`
- focused shared-server tests for aggregate readers
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- `npx tsc -p packages/shared/tsconfig.json --noEmit` when public DTOs change
- `npx vitest run packages/tests/shared-server/rallar-server-schema-docs.test.ts`
  when storage docs, indexes, or migrations change
- `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts` when
  black-box recipe matrix entries change
- `npm run test:api-v1:black-box:memory` when black-box recipe coverage is
  added and memory-mode services are suitable

## Open Decisions For Implementation

- Whether `/api/admin/operations/state` should support a global unscoped view
  in phase 1, or require application/workspace scope for all state counts.
- Whether `prune-expired` should default to dry-run permanently or only during
  early rollout.
- Whether CRDT lifecycle wrappers should be added immediately or whether the
  admin overview should deep-link/document the existing CRDT admin routes first.
- Whether a future unauthenticated `/healthz` or Prometheus endpoint should be
  added separately from this admin-only surface.
- Whether app-data prune should support global expired-row cleanup in phase 1 or
  require explicit namespace/store targets until operator UX proves the need.
- Whether topology recompute should extend
  `GroupTopologyManagementService.reconfigureGroupTopology(...)` with
  `requestId`/`reason`, or keep that context only in admin timing/audit events.
- Whether the admin operations namespace should standardize direct DTO responses
  or a `{ ok, result }`/`{ ok, error }` envelope. Existing CRDT admin uses the
  envelope; state/topology routes generally return direct DTOs plus status-coded
  errors.

## Implementation Progress

### 2026-07-08 21:44:58 CEST

Completed steps:

- [x] Added a reusable api-v1 admin auth helper with explicit `401`/`403`
      behavior.
- [x] Added public admin operations REST DTOs and category/status constants in
      `packages/shared/api`.
- [x] Added admin operations route mounting for all planned read and write
      endpoints under `/api/admin/operations/*`.
- [x] Added reusable shared-server `AdminOperationsService` for overview/read
      composition, metrics reset, topology recompute, expiry pruning, and CRDT
      admin wrappers, including bounded write timing events.
- [x] Added PGlite/Postgres aggregate readers and pruners for queue,
      runtime-state, app-data, CRDT, and state-event statistics.
- [x] Wired the admin operations service into `apps/api-v1/src/create-rallar-server.ts`.
- [x] Updated checked-in OpenAPI YAML with admin operations paths, request
      bodies, response schemas, and auth responses.
- [x] Added no-browser API-v1 black-box recipe and recipe-matrix entry for
      admin operations auth denial, overview success, dry-run write execution, and
      OpenAPI coverage.
- [x] Updated canonical API and environment variable docs for implemented admin
      operations behavior.

Files changed:

- `packages/shared/api/admin-operations-types.ts`
- `packages/shared/mod.ts`
- `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`
- `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
- `packages/shared-server/mod.ts`
- `apps/api-v1/src/services/admin-auth-service.ts`
- `apps/api-v1/src/routes/admin-operations-routes.ts`
- `apps/api-v1/src/create-rallar-server.ts`
- `apps/api-v1/resources/api-v1-openapi.yaml`
- `apps/api-v1/test/request-admin-auth-service.test.ts`
- `apps/api-v1/test/routes/admin-operations-routes.test.ts`
- `apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
- `apps/api-v1/test/rallar-server.test.ts`
- `apps/api-v1/test/swagger-routes.test.ts`
- `packages/tests/shared/admin-operations-types.test.ts`
- `packages/tests/shared-server/admin-operations-service.test.ts`
- `packages/shared-test/black-box-runner/examples/api-v1-admin-operations.json`
- `packages/shared-test/black-box-runner/examples/README.md`
- `packages/shared-test/black-box-runner/recipe-matrix.json`
- `docs/rallar-api-reference.md`
- `docs/environment-variables.md`

Commands run:

- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/swagger-routes.test.ts`
  - Initial red: failed on missing admin auth service/routes.
  - Green after implementation: passed, `14 passed | 0 failed`.
- `npx vitest run packages/tests/shared/admin-operations-types.test.ts`
  - Initial red: failed on missing `@shared/api/admin-operations-types.ts`.
  - Green after implementation: passed, `2 passed`.
- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts`
  - Initial red: failed on missing `AdminOperationsService`.
  - Green after implementation: passed, `6 passed`.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/db/admin-operations-postgres-reader.test.ts`
  - Initial red: failed on missing Postgres admin operations reader module.
  - Green after implementation: passed, `2 passed`.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/rallar-server.test.ts`
  - Initial red: admin route was not mounted and returned `302`.
  - Green after wiring: passed, `4 passed`.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts`
  - Initial red: canonical docs did not describe admin operations.
  - Green after docs update: passed, `7 passed`.

Blockers:

- None currently.

Validation still required:

- Completed in the 2026-07-08 21:49:02 CEST validation pass below.

Implementation decisions made:

- The admin operations namespace uses direct DTO responses plus status-coded
  errors, matching state/topology routes rather than the CRDT route envelope.
- Global state reads are implemented with aggregate runtime-state and event
  counts; scoped state reads use application/workspace key prefixes.
- `prune-expired` defaults to dry-run.
- App-data pruning requires an explicit `appData.namespace` and optional
  `storeName`.
- CRDT lifecycle wrappers are implemented in the admin operations namespace.
- Topology recompute keeps `requestId` in the existing service input and keeps
  `reason` at the admin operation layer for now.

### 2026-07-08 21:49:02 CEST

Completed validation:

- [x] `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Passed after app formatting: `21 passed | 0 failed`.
- [x] `npx vitest run packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  - Passed after adding `api-v1-admin-operations` to the API-v1 black-box
    profile expectation: `20 passed`.
- [x] `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - Passed.
- [x] `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- [x] `cd apps/api-v1 && deno task check`
  - Passed before and after app formatting.
- [x] `npm run test:api-v1:black-box:memory`
  - First sandboxed run failed before recipe execution because API-v1 could not
    bind localhost: `PermissionDenied` at `Deno.serve`.
  - Escalated rerun passed: `api-v1-black-box` profile `passed=7 failed=0
    skipped=0`, including `api-v1-admin-operations`.
- [x] `deno fmt --check` on touched API-v1 Deno/YAML files
  - Failed before formatting, then passed after running `deno fmt` on those
    files.
- [x] `git diff --check`
  - Passed.

Commands intentionally not used as completion evidence:

- A broad `deno fmt --check` over touched Markdown/package files was too noisy
  for this repo because it would reflow large existing canonical docs and
  package files outside the local style. `git diff --check` and focused API-v1
  formatting were used instead.

Remaining blockers:

- None.

Remaining manual or remote validation:

- Postgres-backed `npm run test:api-v1:black-box:postgres` remains optional and
  was not run because this environment only validated the local PGlite memory
  profile.

### 2026-07-09 12:54:26 CEST

Review fix closure:

- [x] Added a regression that rejects admin-operations CRDT compaction when the
      request document and supplied snapshot document differ.
- [x] `AdminOperationsService.compactCrdt(...)` now validates supplied snapshot
      document identity before calling `writeSnapshot`, preventing a mismatched
      snapshot from being written under a different CRDT document.
- [x] `createRallarServer(...)` now wires SPA statistics to the runtime
      middleware repositories instead of constructing route dependencies through
      the global middleware singleton during server creation. This keeps fake and
      injected middleware construction side-effect free.

Commands run:

- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared-server/spa-statistics-service.test.ts packages/tests/api-v1/client-and-group-state-repositories.test.ts`
  - Red before implementation: 3 expected failures for mismatched CRDT compact
    snapshots, unbounded SPA group scans, and recent-event counts exceeding the
    advertised limit.
  - Passed after implementation and formatting cleanup: `24 passed | 0 failed`.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - Passed.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/routes/spa-statistics-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Initially exposed the server-construction middleware wiring issue.
  - Passed after the wiring fix: `36 passed | 0 failed`.
- `npm run test:api-v1:black-box:memory`
  - First sandboxed run timed out waiting for the local API server on
    `127.0.0.1:18080`.
  - Escalated rerun passed: `api-v1-black-box` reported `passed=8 failed=0
    skipped=0`, including `api-v1-admin-operations` with `success=6 failure=0`.

Remaining manual or remote validation:

- Postgres-backed `npm run test:api-v1:black-box:postgres` remains optional and
  was not run in this review-fix pass.

### 2026-07-09 09:43:39 CEST

Code review fixes:

- [x] Fixed admin state active session counts to honor logical
      `expiresAtEpochMs`, so sessions retained for purge grace are not reported as
      active or online.
- [x] Fixed online identity keys to include application and workspace scope for
      clients, and application, workspace, group, and principal scope for group
      members. This prevents the same principal id in different scopes or groups
      from being merged incorrectly.
- [x] Replaced the unscoped `/api/admin/operations/state` runtime-state JSON
      row scan with SQL aggregate count queries. Scoped state reads still use
      bounded key-prefix reads for application/workspace operator drill-downs.
- [x] Added regression coverage for retained expired sessions, globally scoped
      online identities, and avoiding unbounded global `runtime_state_store`
      `select store_key, store_value` scans.

Files changed in this closure:

- `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
- `apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
- `plans/rallar-server-admin-operations-rest-api-plan.md`

Commands run:

- `cd apps/api-v1 && deno test --allow-env --allow-read test/db/admin-operations-postgres-reader.test.ts`
  - Red before implementation: `4 passed | 3 failed`; failures proved retained
    expired sessions were counted, global identities were merged by principal id
    alone, and global state used runtime JSON scans.
  - Green after implementation and formatting: `7 passed | 0 failed`.
- `deno fmt packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
  - Passed; checked 2 files and formatted the reader.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `deno fmt --check packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
  - Passed: checked 2 files.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Passed: `26 passed | 0 failed`.
- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  - Passed: `21 passed | 0 failed`.
- `git diff --check`
  - Passed.

Remaining blockers:

- None.

Remaining manual or remote validation:

- Postgres-backed `npm run test:api-v1:black-box:postgres` remains optional and
  was not run because this review-fix pass validated the local PGlite-backed DB
  reader and API-v1 focused suites.

### 2026-07-09 09:53:58 CEST

Code review fixes:

- [x] Fixed scoped runtime-state prefix matching to avoid SQL `LIKE` wildcard
      interpretation of encoded `%` bytes. Scoped admin state reads now use a
      literal key range for the encoded application/workspace prefix.
- [x] Fixed admin CRDT compaction responses to return a compact snapshot summary
      with payload/state sidecars redacted instead of returning the full
      `RallarCrdtSnapshotEnvelope.value`.
- [x] Added runtime validation for admin write category arrays before execution,
      so malformed JSON bodies cannot silently skip or invent maintenance/reset
      categories.
- [x] Added regression coverage for literal encoded-prefix filtering, CRDT
      compact payload redaction, and invalid write category rejection.

Files changed in this closure:

- `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
- `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`
- `apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
- `packages/tests/shared-server/admin-operations-service.test.ts`
- `plans/rallar-server-admin-operations-rest-api-plan.md`

Commands run:

- `cd apps/api-v1 && deno test --allow-env --allow-read test/db/admin-operations-postgres-reader.test.ts`
  - Red before implementation: `7 passed | 1 failed`; failure proved encoded
    `%` bytes in scoped prefixes were being treated as SQL wildcards.
  - Green after implementation and formatting: `8 passed | 0 failed`.
- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts`
  - Red before implementation: `7 passed | 2 failed`; failures proved invalid
    write categories were accepted and compact responses returned unredacted
    snapshot payloads.
  - Green after implementation and formatting: `9 passed | 0 failed`.
- `deno fmt packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts apps/api-v1/test/db/admin-operations-postgres-reader.test.ts packages/tests/shared-server/admin-operations-service.test.ts`
  - Passed: checked 4 files.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - Passed.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `deno fmt --check packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts apps/api-v1/test/db/admin-operations-postgres-reader.test.ts packages/tests/shared-server/admin-operations-service.test.ts`
  - Passed: checked 4 files.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Passed: `27 passed | 0 failed`.
- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  - Passed: `23 passed | 0 failed`.
- `git diff --check`
  - Passed.

Remaining blockers:

- None.

Remaining manual or remote validation:

- Postgres-backed `npm run test:api-v1:black-box:postgres` remains optional and
  was not run because this review-fix pass validated the local PGlite-backed DB
  reader and API-v1 focused suites.

### 2026-07-09 11:26:56 CEST

Code review fixes:

- [x] Fixed queue/result `topPressure` ordering so the admin queue response
      reports the highest count buckets first instead of the first type/status
      groups alphabetically.
- [x] Fixed global online principal counting to count distinct
      application/workspace/principal tuples instead of concatenating fields with a
      lossy `:` separator.
- [x] Added regression coverage for count-desc pressure ordering and
      colon-bearing scoped identities that previously collided in the global
      principal aggregate.

Files changed in this closure:

- `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
- `apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
- `plans/rallar-server-admin-operations-rest-api-plan.md`

Commands run:

- `cd apps/api-v1 && deno test --allow-env --allow-read test/db/admin-operations-postgres-reader.test.ts`
  - Red before implementation: `8 passed | 2 failed`; failures proved
    `topPressure` was alphabetically ordered and colon-bearing global
    identities could collide.
  - Green after implementation and formatting: `10 passed | 0 failed`.
- `deno fmt packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
  - Passed: checked 2 files and formatted the DB reader test.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - Passed.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `deno fmt --check packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
  - Passed: checked 2 files.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Passed: `29 passed | 0 failed`.
- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  - Passed: `23 passed | 0 failed`.
- `git diff --check`
  - Passed.

Remaining blockers:

- None.

Remaining manual or remote validation:

- Postgres-backed `npm run test:api-v1:black-box:postgres` remains optional and
  was not run because this review-fix pass validated the local PGlite-backed DB
  reader and API-v1 focused suites.

### 2026-07-08 22:43:18 CEST

Code review fixes:

- [x] Fixed scoped admin state counts to use the same URL-encoded
      runtime-state key prefix shape as `RuntimeStateJsonStore`.
- [x] Fixed admin state active/online aggregates to inspect runtime
      `store_value` JSON instead of treating every unexpired row as active:
      active client sessions require `status: "active"` and no disconnect marker,
      online principals are counted distinctly, active groups/members require
      `status: "active"`, and online group members are active members with live
      group sessions.
- [x] Added regression tests for encoded application/workspace IDs, distinct
      online principals, inactive groups/members, and disconnected sessions.

Files changed in this closure:

- `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
- `apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
- `plans/rallar-server-admin-operations-rest-api-plan.md`

Commands run:

- `cd apps/api-v1 && deno test --allow-env --allow-read test/db/admin-operations-postgres-reader.test.ts`
  - Red before implementation: `2 passed | 2 failed`; failures proved the
    encoded-prefix and active/online-count regressions.
  - Green after implementation: `4 passed | 0 failed`.
- `deno fmt apps/api-v1/test/db/admin-operations-postgres-reader.test.ts packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
  - Passed; checked 2 files and formatted the reader.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `deno fmt --check apps/api-v1/test/db/admin-operations-postgres-reader.test.ts packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
  - Passed: checked 2 files.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Passed: `23 passed | 0 failed`.
- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  - Passed: `21 passed | 0 failed`.
- `git diff --check`
  - Passed.

Remaining blockers:

- None.

Remaining manual or remote validation:

- Postgres-backed `npm run test:api-v1:black-box:postgres` remains optional and
  was not run because this review-fix pass validated the local PGlite-backed DB
  reader and API-v1 focused suites.

### 2026-07-08 21:57:05 CEST

Gap closure:

- [x] Added `RallarTimingSink` support to `AdminOperationsService` write
      operations. Every admin write now records a `rallar.timing` event with
      operation name, duration, admin client/session id, request id, reason,
      bounded target metadata, and result status. Timing events intentionally avoid
      bearer tokens and raw operation payloads.
- [x] Wired API-v1 admin operations timing to the existing API timing sink, so
      `RALLAR_TIMING_LOGS` controls the default console output.
- [x] Expanded the admin operations black-box recipe with a safe
      `maintenance.prune-expired` dry-run POST.
- [x] Updated `docs/rallar-api-reference.md` to document implemented write
      timing behavior.

Files changed in this closure:

- `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`
- `apps/api-v1/src/create-rallar-server.ts`
- `packages/tests/shared-server/admin-operations-service.test.ts`
- `packages/shared-test/black-box-runner/examples/api-v1-admin-operations.json`
- `docs/rallar-api-reference.md`
- `plans/rallar-server-admin-operations-rest-api-plan.md`

Commands run:

- `deno fmt packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts apps/api-v1/src/create-rallar-server.ts packages/tests/shared-server/admin-operations-service.test.ts packages/shared-test/black-box-runner/examples/api-v1-admin-operations.json`
  - Passed; checked 4 files and formatted touched TS files.
- `npx vitest run packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  - Passed: `21 passed | 0 failed`.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Passed: `21 passed | 0 failed`.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - Passed.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `deno fmt --check packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts apps/api-v1/src/create-rallar-server.ts packages/tests/shared-server/admin-operations-service.test.ts packages/shared-test/black-box-runner/examples/api-v1-admin-operations.json apps/api-v1/src/routes/admin-operations-routes.ts apps/api-v1/src/services/admin-auth-service.ts apps/api-v1/resources/api-v1-openapi.yaml`
  - Passed: checked 7 files.
- `npm run test:api-v1:black-box:memory`
  - Escalated local-server rerun passed: `api-v1-black-box` profile `passed=7
    failed=0 skipped=0`, including `api-v1-admin-operations` with `success=6
    failure=0`.
- `git diff --check`
  - Passed.

Remaining blockers:

- None.

Remaining manual or remote validation:

- Postgres-backed `npm run test:api-v1:black-box:postgres` remains optional and
  was not run because this environment only validated the local PGlite memory
  profile.
