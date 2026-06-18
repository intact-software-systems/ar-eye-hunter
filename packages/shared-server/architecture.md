# Shared-Server Architecture Notes

`packages/shared-server` owns reusable Rallar server-side domain code. It should
stay independent of one HTTP app, one deployment process, and one environment
configuration. `apps/api-v1` wires routes, runtime IDs, CORS/OpenAPI, concrete
database lifecycle, and deployment settings around these shared services.

## Current Public Surface

- `mod.ts` is the broad compatibility barrel for server facade, middleware,
  app-data, app-inbox, auth, state services, repositories, WS topics, Postgres
  adapters, and runtime-state helpers.
- `rallar-facade/` exposes `RallarServer` and `RallarServerApplication` style
  builders for composing reusable REST, WS, system, and data behavior.
- `rallar-system/middleware/` builds the WebSocket middleware, QueueBox engine,
  dynamic topic router, lifecycle cleanup, and server runtime dependencies.
- `rallar-system/services/` owns auth, client/group state, state sync,
  app-inbox, room authorization, timing, rate-limit, request-auth, and routing
  behavior.
- `rallar-system/repositories/` defines durable auth, client, group, runtime
  state, app-inbox result, and QueueBox repository contracts.
- `app-data/` owns server app-data contracts and the app-data facade.
- `postgres/` contains the current concrete Postgres adapters. A future
  non-Postgres server should add a concrete adapter package rather than moving
  app-specific code into shared-server.

## Active Data Flow

- HTTP client/group mutations are enqueued as durable AppInbox commands, then
  processed by `AppClientInboxService` or `AppGroupInboxService`.
- Client/group services mutate client/group snapshots in `runtime_state_store`.
  They append durable state-event logs in `client_state_events` and
  `group_state_events`. AppInbox services own state-sync publication for those
  results.
- State-sync publication updates process-local snapshot caches and enqueues
  messages into the durable WS QueueBox outbox through `StateSyncPublisher`.
- Built-in WS system topics include state sync, RTC signaling, overlay topology,
  and RTT. RTT measurements can trigger topology recomputes through the same
  durable/coalesced AppInbox path used for group-snapshot topology work.
- Retryable AppInbox publication failures keep the command retryable instead of
  writing a terminal failed app-inbox result. On retry, idempotency ledgers allow
  stored mutation results to be republished without applying the mutation again.
- The current architecture intentionally does not have a separate
  `state-sync-outbox.ts` publication-intent table. Add one only after a new
  design decision; the simpler AppInbox plus QueueBox retry path is the active
  model.

## App Data

- `server.data.open(...)` persists application data in `app_data_store`, not in
  Rallar middleware namespaces.
- `get(...)` defaults to fresh repository reads. `read(...)`,
  `readEntries(...)`, and `keys()` are explicitly memory-only helpers.
- Repositories can opt into `AppDataConditionalRepositoryLike` for atomic
  `insertIfAbsent`, `upsertIfRevision`, and `deleteIfRevision` operations.
- No app-data LISTEN/NOTIFY invalidation bus exists. Cross-process correctness
  currently comes from fresh reads and conditional writes.

## Presence And Routing

- Durable client/group snapshot reads exclude logically expired sessions.
- Read-through snapshot caches treat warm snapshots with expired embedded
  sessions as stale and refresh from durable repositories.
- Room authorization, middleware fanout, and state-sync recipient routing reject
  or filter expired sessions even if the WebSocket connection is still open.
- Scoped group identity matters on every room path. Prefer resolver signatures
  and message targets that carry `GroupRef` when scope is known.

## Documentation Map

- `README.md` describes package ownership, app/server boundaries, timing, and
  storage responsibilities.
- `rallar-server-repositories.md` is the current detailed data-flow and
  repository map.
- `rallar-server-repositories-improvements.md` is a historical hardening log.
  It is useful evidence, but it should not be read as the active backlog.
- `rallar-system/app-inbox-completion-notifications.md` is a proposal for
  faster waiter wakeups; durable app-inbox results remain the source of truth.

## Validation

Common package-focused checks:

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx vitest run packages/tests/shared-server
```

If API-v1 wiring changes too, add the relevant Deno check/test command from
`apps/api-v1`.
