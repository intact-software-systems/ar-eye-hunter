# packages/shared-server

`packages/shared-server` owns reusable Rallar server-side domain code. It should stay independent of one HTTP app, one
runtime entrypoint, and one deployment configuration.

## Owns

- Rallar server facade APIs in `rallar-facade/`.
- Rallar middleware construction in `rallar-system/middleware/`.
- Server-side WebSocket topic routing, system topic installation, lifecycle wiring, and queue pub/sub bridge contracts.
- Server domain services for clients, groups, auth sessions, auth users, request auth, rate limiting, and state sync.
- Reusable timing event contracts and state-service/app-inbox instrumentation hooks.
- Runtime-state repository contracts plus JSON store helpers.
- Current Postgres adapters under `postgres/`.

## Does Not Own

- Hono route registration and app startup.
- Runtime-specific adapters that are only meaningful for one app process.
- Environment variable loading and process-local runtime identity generation.
- Static app resources such as `authorised-clients.json`.
- API-v1 OpenAPI, CORS, and route composition details.
- HTTP request timing middleware and deployment-specific timing sink configuration.
- Concrete app database connection lifecycle.

## Current Boundary

`apps/api-v1` should initialise app-specific dependencies, then pass them into shared-server builders. In practice that
means api-v1 owns:

- HTTP route installers.
- Runtime IDs such as `myServerId` and `myPublisherId`.
- The Postgres listen/notify adapter that implements `QueueBoxPubSubBridge`.
- Static JSON dev clients passed into shared auth services.

`shared-server` owns the reusable behaviour once those dependencies are supplied:

- `createRallarMiddleware(...)` constructs the queuebox engine and websocket queue service.
- `createRallarServerApplication(...)` composes facade, REST route installers, and WS route installer.
- `installQueueBoxPubSubBridge(...)` wires queuebox inbox/outbox events to a generic pub/sub bridge.
- `registerAuthUser(...)` and `loginAuthUser(...)` implement auth domain rules without app-local JSON loading.
- `rallar-system/services/timing.ts` defines timing events and no-op-safe instrumentation helpers. API apps decide
  whether those events go to console, metrics, traces, or tests.

## Timing And Observability

The shared services accept an optional timing sink. When supplied, group/client state-service methods and app-inbox
processing emit structured `rallar.timing` events with component, operation, duration, status, scope IDs, and request
IDs. They do not emit request bodies, auth tokens, or mutation payloads.

`apps/api-v1` owns the HTTP middleware and console sink. Its default sink logs one JSON line per timing event and can be
disabled with `RALLAR_TIMING_LOGS=false`.

App-inbox wait behaviour is configurable by the API app. `apps/api-v1` currently reads:

- `RALLAR_APP_INBOX_PHASE_TIMING`: emit optional `app-inbox-phase` events for enqueue, wait, result read, handler, and
  result write phases. Defaults to `false`.
- `RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS`: maximum synchronous wait for completion. Defaults to `30000`.
- `RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS`: initial completion poll interval. Defaults to `250`.
- `RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS`: maximum completion poll interval. Defaults to `1000`.
- `RALLAR_APP_INBOX_WAIT_JITTER_RATIO`: completion poll jitter ratio. Defaults to `0.1`.

Potential app-inbox completion notifications are described in
`rallar-system/app-inbox-completion-notifications.md`. Notifications should be used to wake waiters, while
`resource_inbox_results` remains the durable source of truth.

## Runtime State Storage

`runtime_state_store` is shared-server infrastructure storage. It is used for middleware state such as auth sessions,
client/group presence, and AL runtime bookkeeping. Rows are isolated by `store_namespace`, and expired rows are evicted
both lazily on read and periodically by the Postgres runtime-state expiry evictor.

Application-specific durable data should not write directly into middleware namespaces. Server-side custom data uses
the explicit app-data facade (`server.data.open(...)`) backed by `app_data_store`, with `app_namespace`, `store_name`,
and `data_key` as the isolation boundary. Keeping app data separate avoids retention, backup, and schema-evolution
coupling with middleware state.

## App Data Storage

`app_data_store` is for server-side application data, not Rallar middleware state. The shared contract lives in
`app-data/AppDataRepository.ts`, and the current Postgres adapter is
`postgres/app-data/PSqlAppDataRepository.ts`. API apps can inject a different repository into
`createRallarServerApplication(...)`, or use the API-v1 default Postgres adapter.

The facade keeps a process-local memory cache and persists JSON values in Postgres rows. Stores are opened
by name, can be scoped with `namespace` and `keyPrefix`, and can configure `ttlMs`, `expireAtFor`, `schemaVersion`, and
a lightweight `migrate` callback.

## Deliberate Temporary Coupling

The `postgres/` folder is still in `shared-server` because it is currently the shared server persistence implementation.
If another server app or non-Postgres backend appears, the next split should be a `packages/shared-postgres` package
that contains those concrete adapters behind interfaces already owned by `shared-server`.

No Deno KV QueueBox adapter is currently carried. The api-v1 middleware path is Postgres-backed through
`PSqlQueueBox`, and any future non-Postgres queuebox backend should be introduced through a concrete adapter package
after the shared-server interfaces are stable.
