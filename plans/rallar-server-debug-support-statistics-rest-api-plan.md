# Rallar Server Debug And Support Statistics REST API Plan

Date: 2026-07-08

Status: Phase 1 implemented and locally validated on 2026-07-09. This plan
depends on the admin operations foundation in
`plans/rallar-server-admin-operations-rest-api-plan.md`.

Review update: 2026-07-09. The admin operations foundation is now present in
the current repo/worktree, so this plan should be implemented as a narrow
extension of those routes, DTOs, auth helpers, readers, tests, and black-box
recipes rather than as a parallel admin product.

## Goal

Plan a focused debug and support workflow for Rallar Server that helps an
operator answer "what happened to this request, session, room, document, or
message?" without exposing broad admin data to normal users and without forcing
support staff to inspect database tables directly.

This is the third slice after:

1. admin operations
2. SPA product UX statistics

## Users And Scenarios

Primary users:

- platform admins investigating production incidents
- developers debugging realtime/state/CRDT issues
- support operators helping a user or game session recover

Core scenarios:

- A client claims they are online, but the room does not see them.
- A room has members, but WS room fanout is not reaching everyone.
- A REST mutation returned slowly or failed.
- A QueueBox item is stuck, retried, expired, or missing a result.
- A CRDT document is out of sync or needs a redacted debug bundle.
- A topology recompute did not publish the expected overlay.
- A support operator has a request id, session id, group id, document ref, or
  idempotency key and needs a compact explanation.

## Relationship To Admin Operations

The debug/support API should reuse the current admin operations foundation:

- `apps/api-v1/src/services/admin-auth-service.ts`
  `requireApiAdminSession(...)` for bearer auth plus
  `AUTH_ADMIN_CLIENT_IDS` platform-admin authorization.
- `apps/api-v1/src/routes/admin-operations-routes.ts` route style and error
  mapping: `401` for unauthenticated, `403` for authenticated non-admin,
  `404` for missing targets, `409` for conflicts/stale writes, and `400` for
  malformed input.
- `packages/shared/api/admin-operations-types.ts` response conventions,
  especially `generatedAtEpochMs`, `serverId`, `scope`, and warnings.
- `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`
  for admin write timing and existing CRDT/topology wrappers where those are
  already sufficient.
- `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
  as a reference for Postgres aggregate patterns, but not as the only reader:
  support explanations need target lookups that the aggregate reader does not
  currently expose.
- Existing CRDT admin repository operations and redacted debug export behavior.
- `GroupTopologyManagementService.readTopologyView(...)` for group topology
  explanation, not topology recompute.

It should not duplicate the broad admin dashboard. Instead, it should expose
targeted "explain" endpoints that gather a bounded diagnostic bundle for one
target.

## Current Repo Truths To Preserve

- Public REST DTOs should live in `packages/shared/api` and be exported from
  `packages/shared/mod.ts`. Server-only support orchestration belongs in
  `packages/shared-server`.
- api-v1 owns Hono route registration, admin auth composition, OpenAPI, and
  process wiring. Any support routes must update
  `apps/api-v1/resources/api-v1-openapi.yaml` and swagger route tests.
- `runtime_state_store` is a JSON key-value table. State rows are scoped by
  encoded key prefixes such as `app=<encoded>:ws=<encoded>`, and event-table
  `workspace_key` uses `_` for missing workspace ids. Support readers must
  normalize optional workspace ids consistently before looking up rows.
- `client-state:principals`, `client-state:sessions`,
  `group-state:groups`, `group-state:members`, and `group-state:sessions`
  are runtime-state namespaces, not separate tables.
- `client_state_events` and `group_state_events` already have bounded recent
  event readers through state services/repositories. Support endpoints should
  use bounded query options instead of full event replay.
- QueueBox keys are `Key` objects with `topicId`, `resourceId`, and
  `contextId`. The physical tables are `resource_inbox` and
  `resource_inbox_results`, with `findAnyByKey(...)` and `findByKey(...)`
  repository methods available. Support needs a narrow key lookup reader that
  redacts `resource` bodies by default.
- `rallarApplication.ws.status()` exposes live connection ids and open
  connection ids for the current process only. Support responses must label
  live WS facts as process-local in multi-server deployments.
- HTTP timing currently emits `rallar.timing` events to the configured timing
  sink and sets `x-request-id`/`server-timing`; there is no durable timing query
  store to search in phase 1.
- Existing admin operations write methods record timing with component
  `admin-operations`. Support bundle generation should either record timing
  with a new `admin-support` component or add a dedicated support audit event.
- Existing CRDT admin routes live under `/api/crdt/admin/documents/*`, and
  admin operations wrappers exist under `/api/admin/operations/crdt/*`.
  Support should keep payloads redacted and should not expose a
  `redactPayloads: false` escape hatch in the explain route.
- Current no-browser REST black-box practice uses recipes in
  `packages/shared-test/black-box-runner/examples` plus entries in
  `packages/shared-test/black-box-runner/recipe-matrix.json`.

## Recommended Namespace

Admin-only support diagnostics:

```text
/api/admin/support/*
```

Possible future scoped self-service diagnostics:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId/support/*
```

The first implementation should be admin-only. Scoped self-service support can
come later after redaction rules are proven.

## Endpoint Sketch

### Explain Client

```text
POST /api/admin/support/explain/client
```

Input:

- `scope: StateScope`
- `principalId`
- optional `clientInstanceId`
- optional `sessionId`
- optional `limitRecentEvents`

Returns:

- client snapshot summary
- active session summary
- live WS connection match status for the current process
- recent client events
- group presence references where available
- warnings about expired, disconnected, or mismatched sessions

Phase 1 should resolve the client by principal snapshot. If `sessionId` is
provided without `clientInstanceId`, search only the target principal snapshot's
bounded active sessions; do not perform a global session scan.

### Explain Group

```text
POST /api/admin/support/explain/group
```

Input:

- `groupRef: GroupRef`
- optional `principalId` focus
- optional `sessionId` focus
- optional `limitRecentEvents`

Returns:

- group snapshot summary
- active sessions and online member count
- topology view summary from `GroupTopologyManagementService.readTopologyView`
- graph diagnostic pointer or summarized result
- recent group events
- room fanout readiness hints
- warnings for stale presence, no active sessions, missing topology, or
  authorization ambiguity

This endpoint should prefer `GroupRef` over bare `groupId`. Any fallback from
legacy `groupId` input must emit an ambiguity warning.

### Explain Request

```text
POST /api/admin/support/explain/request
```

Input can include:

- `requestId`
- `idempotencyKey`
- `queueKey: Key`
- `target` describing the state, topology, CRDT, or queue surface to inspect

Returns:

- matching queue entries
- matching app-inbox results
- timing records only if a timing store exists in the future
- mutation result status where available
- likely next action

Phase 1 can support queue/result lookup by explicit QueueBox key and documented
request-id locations. A historical timing/event store can be a later upgrade.
If callers provide only `requestId`, phase 1 should require a target scope or
return a clear warning that global request-id search is intentionally not
available without indexed support.

### Explain CRDT Document

```text
POST /api/admin/support/explain/crdt-document
```

Input:

- `document: RallarCrdtDocumentRef`
- optional `includeIntegrity`
- optional `includeRedactedDebugBundle`

Returns:

- document metadata
- lifecycle
- append/update/snapshot counts
- stored bytes
- integrity result when requested
- redacted debug export when requested

Payload redaction remains the default.

Support explain should always request a redacted debug bundle. Raw CRDT payload
export, where allowed by lower-level admin APIs, is outside this support route.

### Explain Queue Item

```text
POST /api/admin/support/explain/queue-item
```

Input:

- `queueKey: Key`
- optional `includeExpired`

Returns:

- inbox row status if present
- result row status if present
- attempts
- age
- next retry time
- expiry
- redacted payload metadata, not raw payload

Use `findAnyByKey(...)` when `includeExpired` is true; otherwise use active-row
lookup. Return payload byte length, parsed JSON shape hints, and redaction
status instead of returning `resource`.

## Data Contract Principles

Support responses should be shaped as diagnostic narratives:

- `target`
- `generatedAtEpochMs`
- `serverId`
- `facts`
- `timeline`
- `warnings`
- `likelyCauses`
- `suggestedActions`
- `rawRefs`

The response should prefer exact facts over guesses. Any inference should be
marked as an inference.

Recommended shared DTO direction:

```ts
type AdminSupportFact = Readonly<{
  label: string;
  source: string;
  value: unknown;
  certainty: 'exact' | 'inferred' | 'unavailable';
  redacted?: boolean;
}>;

type AdminSupportTimelineItem = Readonly<{
  atEpochMs?: number;
  source: string;
  eventType: string;
  summary: string;
  rawRef?: string;
}>;
```

Keep suggested actions structured enough for an admin UI to render without
parsing prose:

```ts
type AdminSupportSuggestedAction = Readonly<{
  code: string;
  label: string;
  severity: 'info' | 'warning' | 'urgent';
  operationRef?: string;
}>;
```

## Safety And Privacy

Support APIs are risky because they cross user, group, and document boundaries.
The first version should be admin-only.

Rules:

- never return bearer tokens or auth tickets
- never return password material
- redact CRDT and queue payload bodies by default
- bound recent events by limit
- require explicit target identifiers
- avoid global searches in phase 1 unless indexed
- log/audit support bundle generation
- label process-local realtime facts explicitly
- do not expose CRDT or queue raw-payload opt-outs from support explain routes

If scoped self-service support is added later, it must reuse group/client policy
checks and return a smaller payload.

## Implementation Shape

Recommended file split:

- Create `packages/shared/api/admin-support-types.ts`
  - request and response DTOs for support explain endpoints
  - `AdminSupportFact`, `AdminSupportTimelineItem`,
    `AdminSupportSuggestedAction`, and endpoint-specific target types
  - exported from `packages/shared/mod.ts`
- Create `packages/shared-server/rallar-system/admin-support/AdminSupportService.ts`
  - Hono-free orchestration for explain client/group/request/queue/CRDT
  - composes target readers, CRDT admin repository, topology management, WS
    status, and timing/audit
- Create `packages/shared-server/postgres/admin-support/PSqlAdminSupportReader.ts`
  - target lookups for queue/result rows by `Key`
  - runtime-state scoped readers only where repository APIs are insufficient
  - payload redaction helpers shared by queue/request explanations
- Modify `packages/shared-server/mod.ts`
  - export the support service and Postgres reader only if they are intended as
    reusable server package surface
- Create `apps/api-v1/src/routes/admin-support-routes.ts`
  - route mounting under `/api/admin/support/*`
  - reuse `requireApiAdminSession(...)`
  - parse optional JSON bodies like admin operations routes
  - preserve admin operations error status mapping
- Modify `apps/api-v1/src/create-rallar-server.ts`
  - instantiate support service from existing middleware repositories,
    `rallarApplication?.ws.status()`, `topologyManagement`, `crdtLogRepository`,
    and `getApiTimingSink()`
  - register support routes before swagger routes
- Modify `apps/api-v1/resources/api-v1-openapi.yaml`
  - add Admin Support tag, paths, schemas, and 401/403/404 responses
- Add tests:
  - `packages/tests/shared/admin-support-types.test.ts`
  - `packages/tests/shared-server/admin-support-service.test.ts`
  - `apps/api-v1/test/routes/admin-support-routes.test.ts`
  - `apps/api-v1/test/db/admin-support-postgres-reader.test.ts`
  - swagger route coverage in `apps/api-v1/test/swagger-routes.test.ts`
  - no-browser black-box recipe
    `packages/shared-test/black-box-runner/examples/api-v1-admin-support.json`
    plus recipe matrix and examples README updates

## Phase 1 Acceptance Shape

Phase 1 should be accepted only when:

- support DTOs are exported from `packages/shared/mod.ts`
- admin support routes reuse the existing admin auth helper and return `401`
  and `403` consistently with admin operations
- explain queue item uses explicit `Key` lookup across both
  `resource_inbox` and `resource_inbox_results`
- explain client and group use bounded recent event reads
- explain group uses `GroupRef` and `readTopologyView(...)`
- explain CRDT document can optionally run integrity and redacted debug export
- explain request does not perform unindexed global request-id search
- OpenAPI and black-box recipe coverage include at least auth denial, one
  successful queue/key or group explanation, and schema visibility

## Phasing

### Phase 1: Admin Explain Endpoints

- Add admin-only support namespace.
- Add explain client, group, queue item, CRDT document, and constrained request
  explanation.
- Add request-id/idempotency lookup only where callers provide a specific
  target or QueueBox key and existing data supports it cheaply.
- Reuse admin operations contracts and readers.
- Add focused shared/server/api-v1 tests and a no-browser black-box recipe.

### Phase 2: Better Timelines

- Add optional durable timing/event collection if needed. Current timing is log
  sink based and not queryable.
- Correlate HTTP request id, app-inbox request id, QueueBox key, state event id,
  and WS publish result.
- Add timeline assembly helpers.

### Phase 3: Scoped Support UX

- Add scoped self-service endpoints for users to diagnose their own session or
  room membership.
- Restrict payloads with group policy and self-principal checks.
- Expose user-readable suggested actions to SPAs.

## Validation Plan

Tests should cover:

- admin-only authorization
- missing target handling
- redaction defaults
- bounded event lists
- explain group with and without topology
- explain client with and without live WS session
- queue item found/missing/expired/result-only cases
- CRDT document debug export redaction
- clear warnings for partial data

Focused commands for implementation:

```bash
npx vitest run packages/tests/shared/admin-support-types.test.ts packages/tests/shared-server/admin-support-service.test.ts
npm run test:api-v1:black-box:memory
```

From `apps/api-v1`, run:

```bash
deno test --allow-env --allow-read test/routes/admin-support-routes.test.ts test/db/admin-support-postgres-reader.test.ts test/swagger-routes.test.ts
```

When support DTO exports change public package surfaces, also run:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

## Open Decisions For Implementation

- Whether support endpoints should emit CRDT audit events or a separate support
  audit event type.
- Whether request explanation should search by request id across multiple
  tables immediately or require callers to provide a more specific key in phase
  1.
- Whether support timing should use only `rallar.timing` with component
  `admin-support`, or whether bundle generation needs a durable audit record.
- Whether `suggestedActions` should be hard-coded strings or structured action
  descriptors that an admin UI can render. This plan recommends structured
  descriptors, but implementation can start with a small fixed code list.

## Implementation Progress

### 2026-07-09 20:26 CEST - Phase 1 Admin Explain Endpoints

Completed steps:

- Added shared admin support DTOs in
  `packages/shared/api/admin-support-types.ts` and exported them from
  `packages/shared/mod.ts`.
- Added `AdminSupportService` in `packages/shared-server` with diagnostic
  narratives for client, group, request, CRDT document, and queue item targets.
  Client/group explanations use bounded state-service event reads. Group
  explanations use `GroupRef` and `readTopologyView(...)`. CRDT explanations can
  run integrity and redacted debug export summaries. Request-id-only explanation
  returns a clear no-global-search warning.
- Added `PSqlAdminSupportReader` for explicit QueueBox key lookups in
  `resource_inbox` and `resource_inbox_results`, including active-only versus
  include-expired lookup behavior.
- Added API-v1 support routes, admin-auth reuse, server wiring, and OpenAPI
  schemas/paths for `/api/admin/support/explain/*`.
- Added focused tests for DTO exports, support service redaction/bounded reads,
  API route auth/validation/forwarding, Postgres queue reader behavior, server
  route mounting, OpenAPI visibility, and recipe matrix coverage.
- Added no-browser black-box recipe
  `packages/shared-test/black-box-runner/examples/api-v1-admin-support.json`
  plus recipe matrix and examples README entries.
- Updated canonical docs in `docs/rallar-api-reference.md` and
  `docs/environment-variables.md`.

Implementation notes:

- The original plan has no checkbox work queue, so completion is tracked here
  instead of changing checkbox markers.
- Support generation records `rallar.timing` events with component
  `admin-support`. A durable support audit event remains a future decision.
- CRDT support exposes only metadata/integrity/debug-export summaries and always
  requests payload redaction for support debug bundles.
- The black-box recipe uses an explicit missing QueueBox key as the successful
  queue explanation so it does not require pre-seeded runtime rows.

Commands run:

- Red test: `npx vitest run packages/tests/shared-server/admin-support-service.test.ts`
  failed as expected before implementation because client/group/CRDT readers
  were not invoked.
- `npx vitest run packages/tests/shared/admin-support-types.test.ts packages/tests/shared-server/admin-support-service.test.ts`
  passed earlier in this iteration after DTO/service work.
- `npx vitest run packages/tests/shared-server/admin-support-service.test.ts`
  passed after client/group/CRDT support implementation.
- `deno test --allow-env --allow-read test/routes/admin-support-routes.test.ts`
  passed earlier after initial route work.
- `deno test --allow-env --allow-read test/db/admin-support-postgres-reader.test.ts`
  passed earlier after queue reader implementation.
- `deno test --allow-env --allow-read test/rallar-server.test.ts`
  passed earlier after server route registration.
- `deno test --allow-env --allow-read test/swagger-routes.test.ts --filter "admin support"`
  passed earlier after OpenAPI updates.
- `deno test --allow-env --allow-read test/routes/admin-support-routes.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  passed with 18 tests after richer service wiring and route validation.
- `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-admin-support.json --validate`
  passed with no recipe issues.
- `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts` passed.

Blockers:

- None for focused local implementation. Full API-v1 black-box execution still
  needs the final validation pass to start a local API-v1 backend.

Follow-up validation still required:

- Run the combined focused Vitest/Deno commands once more after final doc/plan
  edits.
- Run public package surface type checks for `packages/shared` and
  `packages/shared-server`.
- Run `npm run test:api-v1:black-box:memory` if the local API-v1 pglite-memory
  server starts successfully in this environment; otherwise record the exact
  blocker and keep the validated recipe as the local substitute.

### 2026-07-09 20:28 CEST - Final Local Validation

Completed steps:

- Re-ran focused support unit, API route, DB reader, server wiring, OpenAPI,
  recipe matrix, type-check, recipe validation, and API-v1 black-box memory
  validation after docs/progress updates.
- Confirmed the new `api-v1-admin-support` no-browser recipe participates in
  the `api-v1-black-box` profile.

Commands run:

- `deno fmt --check ...` on touched TS/JSON support files passed after
  formatting. Markdown was intentionally not auto-formatted because Deno would
  reflow large unrelated README/API-reference sections.
- `npx vitest run packages/tests/shared/admin-support-types.test.ts packages/tests/shared-server/admin-support-service.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  passed with 19 tests.
- From `apps/api-v1`:
  `deno test --allow-env --allow-read test/routes/admin-support-routes.test.ts test/db/admin-support-postgres-reader.test.ts test/rallar-server.test.ts test/swagger-routes.test.ts`
  passed with 20 tests.
- `npx tsc -p packages/shared/tsconfig.json --noEmit` passed.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit` passed.
- `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-admin-support.json --validate`
  passed with no recipe issues.
- First `npm run test:api-v1:black-box:memory` attempt failed because sandboxed
  `Deno.serve({ port }, ...)` could not bind localhost:
  `PermissionDenied: Operation not permitted (os error 1)`.
- Escalated `npm run test:api-v1:black-box:memory` passed:
  9 API-v1 recipes passed, 0 failed, 0 skipped. The new
  `api-v1-admin-support` recipe passed with 6 successful steps and 0 failures.

Blockers:

- None remaining for local validation.

Follow-up validation still required:

- Remote/staging deployment validation was not run from this workspace.

### 2026-07-09 20:29 CEST - Extra Partial-Data Coverage

Completed steps:

- Added support service coverage for client explanation without live WebSocket
  status, group explanation without topology management, and result-only
  QueueBox explanations.

Commands run:

- `deno fmt packages/tests/shared-server/admin-support-service.test.ts` checked
  the touched test file.
- `npx vitest run packages/tests/shared/admin-support-types.test.ts packages/tests/shared-server/admin-support-service.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  passed with 22 tests.
- `deno fmt --check packages/tests/shared-server/admin-support-service.test.ts packages/shared-server/rallar-system/admin-support/AdminSupportService.ts packages/shared/api/admin-support-types.ts`
  passed.

Blockers:

- None.
