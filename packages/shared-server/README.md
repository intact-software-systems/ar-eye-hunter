# packages/shared-server

`packages/shared-server` owns reusable Rallar server-side domain code. It should stay independent of one HTTP app, one
runtime entrypoint, and one deployment configuration.

## Owns

- Rallar server facade APIs in `rallar-facade/`.
- Rallar middleware construction in `rallar-system/middleware/`.
- Server-side WebSocket topic routing, system topic installation, lifecycle wiring, and queue pub/sub bridge contracts.
- Server domain services for clients, groups, auth sessions, auth users, request auth, rate limiting, and state sync.
- Runtime-state repository contracts plus JSON store helpers.
- Current Postgres adapters under `postgres/`.

## Does Not Own

- Hono route registration and app startup.
- Runtime-specific adapters that are only meaningful for one app process.
- Environment variable loading and process-local runtime identity generation.
- Static app resources such as `authorised-clients.json`.
- API-v1 OpenAPI, CORS, and route composition details.
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

## Runtime State Storage

`runtime_state_store` is shared-server infrastructure storage. It is used for middleware state such as auth sessions,
client/group presence, and AL runtime bookkeeping. Rows are isolated by `store_namespace`, and expired rows are evicted
both lazily on read and periodically by the Postgres runtime-state expiry evictor.

Application-specific durable data should not write directly into middleware namespaces. If server-side custom data is
needed, expose it through an explicit app-data facade with app-owned namespace rules or, preferably, a separate
app-data table/package once the persistence API is stable. Keeping app data separate avoids retention, backup, and
schema-evolution coupling with middleware state.

## Deliberate Temporary Coupling

The `postgres/` folder is still in `shared-server` because it is currently the shared server persistence implementation.
If another server app or non-Postgres backend appears, the next split should be a `packages/shared-postgres` package
that contains those concrete adapters behind interfaces already owned by `shared-server`.

No Deno KV QueueBox adapter is currently carried. The api-v1 middleware path is Postgres-backed through
`PSqlQueueBox`, and any future non-Postgres queuebox backend should be introduced through a concrete adapter package
after the shared-server interfaces are stable.
