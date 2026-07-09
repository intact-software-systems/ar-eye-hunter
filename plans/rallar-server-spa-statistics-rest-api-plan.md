# Rallar Server SPA Statistics REST API Plan

Date: 2026-07-08

Status: Follow-on planning document. Reviewed against current code/docs on
2026-07-09. This plan depends on the admin operations foundation in
`plans/rallar-server-admin-operations-rest-api-plan.md`, but the SPA statistics
surface must stay separate from admin operations.

## Goal

Plan a scoped, read-only statistics surface that helps browser SPAs show useful
Rallar state to normal authorised users without exposing platform-wide admin
operations data.

The SPA statistics surface should make product experiences better:

- room lobby occupancy
- online people summaries where visibility is clear
- connection and realtime readiness hints for the current actor
- lightweight activity counts
- safe "what is happening in this workspace or room?" views

It should not become an admin dashboard, support diagnostic bundle, or hidden
admin operations proxy.

## Audience

Primary consumers:

- `packages/shared-web` browser facades
- app SPAs such as AR Eye Hunter and Relic Hunters
- future admin UI components that need scoped non-dangerous reads

Primary viewers:

- a logged-in user
- an active group member
- a group owner/admin
- a workspace-level user where workspace concepts exist

## Current Code And Doc Truths

- API-v1 is composed by `apps/api-v1/src/create-rallar-server.ts`; process
  startup in `apps/api-v1/src/main.ts` installs `/api/state/*` bearer auth,
  timing, CORS, and state API resilience/rate limiting before mounting Rallar
  REST routes.
- `/api/state/*` routes already require a bearer token and matching
  `x-client-id` in production startup, but individual route modules still call
  `requireApiAuthSession(...)` when they need actor identity.
- `RALLAR_STATE_STRICT_READ_AUTH` is optional and disabled by default. Existing
  state read routes only apply self/group read policy when this flag is enabled.
  SPA statistics routes must enforce their own actor and group-policy checks
  regardless of this flag.
- Client self-read behavior lives in `apps/api-v1/src/routes/client-state-routes.ts`:
  strict mode limits client snapshot/event reads to the authenticated
  `clientId`.
- Group full-read behavior lives in `apps/api-v1/src/routes/group-state-routes.ts`
  and `packages/shared-server/rallar-system/group-policy.ts`. Full group reads
  require `canReadGroupSnapshot(...)`; owner/admin details should use
  `canUpdateGroupSnapshot(...)`.
- `canReadGroupSnapshot(...)` grants full reads only to active members. Open
  directory visibility exists through `readGroupVisibility(...)`, but current
  full-state route filtering does not expose a separate limited directory DTO.
- `StateScope` requires both `applicationId` and `workspaceId`. Browser API
  helpers build encoded paths through `toStateScopePath(scope)` and
  `toStateGroupPath(scope, groupId)` in
  `packages/shared-web/browser/api-integration.ts`.
- `ClientStateRepository` and `GroupStateRepository` snapshots already filter
  `activeSessions` to non-disconnected, non-expired sessions. Stats should not
  re-label stale rows as online.
- WebSocket status is process-local. `RallarServerWsStatus` exposes connection
  ids, and API-v1 uses the auth `sessionId` as the WS connection id. SPA stats
  may compare only the current actor's session id and must not expose other
  users' connection ids.
- Admin operations currently live under `/api/admin/operations/*` with public
  DTOs in `packages/shared/api/admin-operations-types.ts`, Hono routes in
  `apps/api-v1/src/routes/admin-operations-routes.ts`, and broad admin
  aggregate readers. SPA stats should not reuse admin response types or global
  readers directly.
- API-v1 OpenAPI is the checked-in YAML at
  `apps/api-v1/resources/api-v1-openapi.yaml`. Route work must update that file
  and the existing swagger route tests.
- REST API additions should add or update no-browser API-v1 black-box recipes in
  `packages/shared-test/black-box-runner` alongside unit/route coverage.

## Recommended Namespace

Use the existing state API shape:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId/stats/*
```

Room-scoped routes should use the existing scoped group path structure:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats
```

This keeps SPA statistics near the state resources they summarize and allows
the existing `/api/state/*` auth, timing, CORS, and resilience middleware to
apply.

## Authorization Model

SPA stats must be scoped and policy-aware.

Rules:

- always call `requireApiAuthSession(...)` route-locally to get the current
  actor, even though `/api/state/*` middleware also authenticates requests in
  `main.ts`
- client-level stats about "me" require `authSession.clientId` and
  `authSession.sessionId` self checks
- group stats require reading the scoped `GroupRef` and checking
  `canReadGroupSnapshot(...)`
- owner/admin-only fields must use `canUpdateGroupSnapshot(...)` and should be
  omitted, not returned as null, for regular members
- workspace summary in phase 1 should count only full-readable groups for the
  actor; directory-visible open groups need a separately designed limited DTO
- no global platform stats for normal SPA users
- no queue, runtime-state, app-data, auth-session, CRDT storage pressure, or raw
  topology graph stats for normal users

## Response And Error Model

Public REST DTOs should live in a new shared contract file:

```text
packages/shared/api/spa-statistics-types.ts
```

The shared base response should include:

- `generatedAtEpochMs`
- `scope`
- `actor` with current principal id and, only where useful, the actor's own
  session id
- `warnings` for partial visibility, bounded counts, process-local realtime
  checks, or unavailable optional sources

Responses should avoid:

- raw event payloads
- raw queue, runtime-state, app-data, auth-session, or CRDT data
- exact session ids or connection ids for other users
- unbounded member/client/group lists
- topology graphs or full overlay snapshots

Errors should mirror current state route behavior:

- `401` for missing/invalid auth
- `403` for authenticated self/group-policy denial
- `404` for missing scoped groups
- `400` for malformed input or unsupported options
- group policy errors should preserve `{ error, code, message, details }`
  where `GroupPolicyDeniedError` is available

Because responses are actor-specific, default HTTP responses should be
`Cache-Control: no-store`. ETags or polling-friendly cache hints can come later
only for fields proven safe to share across actors.

## Endpoint Sketch

### Workspace Summary

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/summary
```

Returns scoped, actor-visible product counts:

- full-readable group count
- joined group count for the actor
- online member count across full-readable groups
- actor active client session count
- actor group presence count
- recent visible activity count as a bounded count, not an exact global count,
  unless a scoped count reader is added
- optional limited `topGroups` list with an explicit limit and no member/session
  ids
- generated timestamp and warnings

This should be safe for dashboards and lobbies. Phase 1 should not include
open directory groups unless a limited directory DTO and tests are added.

### Group Summary

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats
```

Returns the core room/lobby product summary after `canReadGroupSnapshot(...)`:

- member count
- online member count
- active session count
- group status, kind, join mode, and snapshot/presence versions
- actor role
- actor active presence/session count for this group
- recent group event count as a bounded count
- optional topology summary only when explicitly safe, such as topology kind and
  overlay version, not graph nodes, peer ids, or full overlay payloads
- generated timestamp and warnings

Owner/admin-only additions must be gated by `canUpdateGroupSnapshot(...)`.

### My Realtime Status

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/me/realtime
```

Returns self-only connection readiness hints:

- actor principal id
- current auth session id
- whether the current auth session has an open WS connection on this server
- active client session count for the actor
- whether the current auth session appears in actor client state
- groups where this auth session has active presence, returned as scoped
  `GroupRef` plus safe group display fields only after group read policy passes
- warnings for missing WS, missing client-state session, expired presence, or
  process-local realtime checks

This should help SPAs show connection repair prompts without exposing other
users' session ids.

### People Summary

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/people
```

Defer this until visibility rules are settled. Current state read policy has no
first-class workspace membership model; strict client reads are self-only.

When implemented, it should return only people visible through full-readable
groups or a future workspace membership model:

- online people visible to the actor
- presence buckets: online, away, busy, offline where available
- active session count for the actor
- optional top active groups if policy allows

The endpoint must not reveal hidden users or users in private groups the actor
cannot read.

## Architecture And File Boundaries

Recommended package split:

- `packages/shared/api/spa-statistics-types.ts`
  - public request/response DTOs for SPA statistics
  - warning codes and bounded-count types
  - exported from `packages/shared/mod.ts`

- `packages/shared-server/rallar-system/spa-statistics/SpaStatisticsService.ts`
  - Hono-free dependency-injected service
  - accepts current auth session, `StateScope`, optional `GroupRef`, clocks, and
    narrow client/group state service interfaces
  - enforces actor/group visibility before deriving summaries
  - shares only small pure helpers with future admin/support code; do not return
    admin operation DTOs

- `apps/api-v1/src/routes/spa-statistics-routes.ts`
  - Hono route mounting under `/api/state/.../stats`
  - route-local `requireApiAuthSession(...)`
  - request parsing, error mapping, and `Cache-Control: no-store`

- `apps/api-v1/src/create-rallar-server.ts`
  - route installer registration
  - dependency wiring from `getClientStateService()`, `getGroupStateService()`,
    process-local `rallarApplication?.ws.status()`, `myServerId`, and optional
    topology summary reader

- `apps/api-v1/resources/api-v1-openapi.yaml`
  - SPA Statistics tag
  - path entries and schemas for every implemented stats endpoint
  - reusable unauthorized/forbidden/state policy error responses

- `docs/rallar-api-reference.md`
  - document the SPA stats namespace, auth behavior, strict-read-auth
    independence, and relationship to admin/support statistics

- `packages/shared-web/browser/api-integration.ts`
  - typed `readStateWorkspaceStatsSummary(...)`,
    `readStateGroupStats(...)`, and `readStateMyRealtimeStatus(...)` helpers
  - paths should reuse the existing encoded state scope/group path helpers

- `packages/shared-web/browser/rallar-stats-facade.ts`
  - new narrow `RallarStatsFacade`
  - initial helpers should prefer `rallar.stats.summary(...)`,
    `rallar.stats.group(...)`, and `rallar.stats.meRealtime(...)`

- `packages/shared-web/browser/rallar.ts`,
  `packages/shared-web/browser/rallar-core.ts`, and `packages/shared-web/mod.ts`
  - compose/export the facade without breaking existing imports

- `packages/shared-test/black-box-runner/examples/api-v1-spa-statistics.json`
  and `packages/shared-test/black-box-runner/recipe-matrix.json`
  - no-browser recipe coverage for representative auth/policy and success paths

## Data Sources

Initial read sources:

- `ClientStateService.readSnapshot(...)` for the current actor
- `ClientStateService.readPresenceSnapshot(...)` for self-only presence details
- `GroupStateService.listSnapshots(...)` filtered by `canReadGroupSnapshot(...)`
  for workspace summary
- `GroupStateService.readSnapshot(...)` for group summary
- `GroupStateService.listRecentEvents(...)` with small explicit limits for
  bounded activity counts
- process-local `rallar.ws.status()` only for the current actor's session id
- optional topology management read view only after redaction to a safe summary

The implementation should avoid expensive global list-and-filter operations for
large workspaces. If phase 1 uses `listSnapshots(...)`, responses must include a
warning such as `bounded-snapshot-scan` or `policy-filtered-scan`, and follow-up
work should add scoped/indexed readers if real workloads need it.

If exact activity counts are required, add a dedicated scoped event count reader
rather than fetching event payloads only to count them. Postgres can count from
`client_state_events` and `group_state_events`, but any new index/statistics
work must keep Prisma schema, in-memory schema, and shared-server storage docs
aligned.

## Browser Facade Direction

After server routes exist, `packages/shared-web` should expose narrow helpers
through a new stats facade:

- `rallar.stats.summary(options?)`
- `rallar.stats.group(groupRefOrId, options?)`
- `rallar.stats.meRealtime(options?)`

Optional convenience aliases can be considered later, such as
`rallar.rooms.stats(groupRefOrId)` or
`rallar.connection.readMyRealtimeStatus()`, but phase 2 should keep the first
public surface small.

The facade should keep responses typed and scoped. It should not expose admin
operations through the normal browser package.

## Phasing

### Phase 1: Scoped Server Read Routes

- Add public SPA statistics DTOs in
  `packages/shared/api/spa-statistics-types.ts`.
- Add a dependency-injected SPA statistics service in `packages/shared-server`.
- Add workspace summary.
- Add group summary.
- Add my realtime status.
- Add route tests for auth, self checks, group policy, missing groups, redacted
  session ids, and stable empty-state responses.
- Update OpenAPI, Swagger route tests, and API reference docs.
- Add API-v1 black-box recipe coverage for missing auth, non-member denial, and
  one successful scoped read path.

### Phase 2: Browser Facade Helpers

- Add typed `packages/shared-web` API integration helpers and stats facade.
- Wire `rallar.stats.*` into `RallarFacade` and public browser exports.
- Add shared-web public API snapshot and browser bundle-boundary coverage.
- Add app-level usage in one SPA or black-box workbench as a proving ground.
- Add browser workflow tests if a visible UI consumes the new stats surface.

### Phase 3: Product Polish

- Add people summary once visibility rules are settled.
- Add directory-visible open group summaries if product lobbies require them.
- Add indexed/exact activity count readers if bounded recent counts are not
  enough.
- Add caching hints or ETags only for actor-safe fields if stats are polled.
- Add optional field selection if payloads grow.

## Validation Plan

Tests should cover:

- unauthenticated request denial
- invalid bearer or mismatched `x-client-id` denial
- self-principal access for my realtime status
- group member read access
- non-member denial for private group stats
- owner/admin expanded group details if included
- no leakage of other users' session ids, connection ids, or raw event payloads
- process-local WS warning behavior
- stable empty-state responses
- browser facade request path construction and auth option forwarding
- OpenAPI path/schema coverage
- black-box recipe coverage for representative auth and success paths

Candidate commands:

- `cd apps/api-v1 && deno task check`
- focused api-v1 Deno route tests for SPA statistics
- `cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts`
- focused shared-server tests for SPA statistics derivation helpers
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit` when browser helpers
  change
- `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  when the public browser facade changes
- `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts` when
  black-box recipe matrix entries change
- `npm run test:api-v1:black-box:memory` when black-box recipe coverage is
  added and memory-mode services are suitable

## Open Decisions For Implementation

- Whether workspace summary should ever include directory-visible open groups.
  Phase 1 should count only full-readable groups.
- Whether topology kind and overlay version are safe for all active members or
  should remain owner/admin-only. Phase 1 can omit topology until this is
  settled.
- Whether recent activity should be a bounded "recent events observed" count or
  an exact indexed count.
- Whether to accept a duplicate auth-session repository read in stats routes or
  introduce typed Hono context storage for the `/api/state/*` auth middleware.
- Whether polling should be supported directly or left to SPAs to schedule.

## Implementation Progress

Updated: 2026-07-09 11:50 CEST

- [x] Iteration 1: server contracts and route behavior.
  - Added `packages/shared/api/spa-statistics-types.ts` and exported it from
    `packages/shared/mod.ts`.
  - Added dependency-injected `SpaStatisticsService` under
    `packages/shared-server/rallar-system/spa-statistics/` and exported it from
    `packages/shared-server/mod.ts`.
  - Added API-v1 SPA statistics routes for workspace summary, group summary,
    and my realtime status under the `/api/state/apps/:applicationId/workspaces/:workspaceId`
    namespace.
  - Wired the service and routes in `apps/api-v1/src/create-rallar-server.ts`.
  - Covered auth, group policy, missing groups, redaction, bounded counts,
    warnings, and empty-state behavior with shared/shared-server/API-v1 tests.
- [x] Iteration 2: OpenAPI, docs, and black-box recipe coverage.
  - Updated `apps/api-v1/resources/api-v1-openapi.yaml` with the SPA
    Statistics tag, paths, response schemas, security, and `Cache-Control:
    no-store` response headers.
  - Updated `docs/rallar-api-reference.md` and
    `docs/environment-variables.md` with the new user-scoped stats surface and
    its route-local auth behavior.
  - Added `packages/shared-test/black-box-runner/examples/api-v1-spa-statistics.json`
    and registered it in the recipe matrix.
  - Verified the black-box memory matrix after fixing recipe matcher
    expectations for deterministic booleans and avoiding OpenAPI template-key
    placeholder expansion inside the mixed scenario.
- [x] Iteration 3: browser helpers and facade.
  - Added typed shared-web API helpers for the three SPA statistics reads.
  - Added `createRallarStatsFacade(...)` and wired `rallar.stats.summary()`,
    `rallar.stats.group(...)`, and `rallar.stats.meRealtime()` into
    `RallarFacade`.
  - Updated shared-web public exports, public API snapshots, bundle-boundary
    tests, and low-level/facade workflow coverage.
- [ ] Phase 3 polish remains intentionally deferred.
  - People summary, directory-visible group stats, exact activity indexes,
    polling cache hints, and field selection still need separate product and
    visibility decisions before implementation.
- [x] Final validation sweep completed.
  - `npx vitest run packages/tests/shared/spa-statistics-types.test.ts packages/tests/shared-server/spa-statistics-service.test.ts packages/tests/shared-test/recipe-matrix.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-stats-facade.test.ts packages/tests/shared-web/rallar-stats-compat.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
    passed 69 tests across 9 files.
  - `npx tsc -p packages/shared/tsconfig.json --noEmit` passed.
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
  - `npx tsc -p packages/shared-web/tsconfig.json --noEmit` passed.
  - `cd apps/api-v1 && deno test --allow-env --allow-read test/routes/spa-statistics-routes.test.ts test/swagger-routes.test.ts`
    passed 14 tests.
  - `cd apps/api-v1 && deno task check` passed.
  - `npm run test:api-v1:black-box:memory` passed with the escalated local
    port binding required by the sandbox; the matrix reported 8 passed, 0
    failed, 0 skipped.

Updated: 2026-07-09 12:54 CEST

- [x] Review fix: bounded SPA statistics scans.
  - Added `GroupStateRepository.listSnapshotsPage(...)` and
    `GroupStateService.listSnapshotsPage(...)` so SPA statistics can read a
    bounded group page from runtime state instead of loading every group,
    member, and presence session in the workspace.
  - Updated `SpaStatisticsService` workspace summary and my-realtime reads to
    prefer the bounded page path and emit `bounded-snapshot-scan` warnings when
    a scan has more groups beyond the configured limit.
  - Capped `recentVisibleGroupEventCount.count` to its advertised total
    `limit`, rather than summing a per-group limit into a larger number.
  - Added regressions for bounded page use, repository page behavior, and event
    count limit consistency.

Validation for the review fix:

- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared-server/spa-statistics-service.test.ts packages/tests/api-v1/client-and-group-state-repositories.test.ts`
  - Red before implementation: expected failures for unbounded SPA scans and
    event count limit mismatch.
  - Passed after implementation and formatting cleanup: `24 passed | 0 failed`.
- `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared-server/spa-statistics-service.test.ts packages/tests/api-v1/client-and-group-state-repositories.test.ts packages/tests/shared/spa-statistics-types.test.ts packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-web/rallar-stats-compat.test.ts packages/tests/shared-web/rallar-stats-facade.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
  - Passed: `77 passed | 0 failed`.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
  - Passed.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - Passed.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
  - Passed.
- `cd apps/api-v1 && deno task check`
  - Passed.
- `cd apps/api-v1 && deno test --allow-env --allow-read test/request-admin-auth-service.test.ts test/routes/admin-operations-routes.test.ts test/routes/spa-statistics-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  - Passed: `36 passed | 0 failed`.
- `npm run test:api-v1:black-box:memory`
  - First sandboxed run timed out waiting for the local API server on
    `127.0.0.1:18080`.
  - Escalated rerun passed: `api-v1-black-box` reported `passed=8 failed=0
    skipped=0`, including `api-v1-spa-statistics` with `success=15 failure=0`.
