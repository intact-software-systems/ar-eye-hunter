# Shared server

`packages/shared-server` owns reusable server-side Rallar behavior. Applications
provide process configuration, database lifecycle, HTTP routing, and deployment
policy; this package owns the domain and infrastructure behavior that remains
the same across those applications.

Start here when following a call:

- [Runtime navigation](./docs/runtime-navigation.md) traces API-v1 construction,
  HTTP/AppInbox calls, WebSocket calls, first invocations, and shutdown.
- [Persistence and replay](./docs/persistence-and-replay.md) maps current stores,
  transaction boundaries, outboxes, replay, cursors, expiry, and retention.

Historical plans are context for their original work only. These three package
documents describe the current implementation.

## Package ownership

| Owner            | Responsibility                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `al-runtime/`    | Server AL admission and runtime-state persistence adapters.                                                                                   |
| `app-data/`      | Typed application stores, current-value codecs, cache/hydration, optimistic writes, and PostgreSQL persistence.                               |
| `game/`          | Reusable authoritative game command decoding and publication.                                                                                 |
| `http/`          | Reusable request authentication and HTTP boundary helpers.                                                                                    |
| `postgres/`      | The shared `PSqlSql` port and transaction helper only.                                                                                        |
| `queuebox/`      | QueueBox and ResourceInbox PostgreSQL entry, reservation, retry, finalization, results, and maintenance owners.                               |
| `rallar-ai/`     | RallarAI generation, provider policy, persistence, publication, and HTTP/WebSocket installers.                                                |
| `rallar-server/` | Final reusable server application assembly.                                                                                                   |
| `rallar-system/` | AppInbox, auth, client/group/CRDT state, topology, RTC-RTT, state sync, WebSocket, presence, state events, administration, and observability. |
| `runtime-state/` | Current runtime-state contract, batched reads, guarded writes, JSON storage, PostgreSQL execution, and expiry.                                |
| `mod.ts`         | Curated cross-package public exports. It is not an internal import shortcut.                                                                  |

Concrete PostgreSQL adapters live beside the feature that owns their row shape
and corruption boundary. Do not create a general repository bucket or move a
domain adapter into `postgres/` merely because it uses SQL.

## Application boundary

`apps/api-v1` owns:

- configuration and environment decoding;
- database creation, notification transport, and shutdown;
- runtime and publisher identities;
- Hono, CORS, OpenAPI, and route registration;
- deployment-specific background-task and process policy.

Shared server owns:

- `createRallarMiddleware(...)`, including complete inbox-handler construction
  and exact queue-task registration;
- `createRallarServerApplication(...)`, which exposes the real WebSocket router
  and app-data owner;
- domain read/compute/validate/write services;
- QueueBox, AppInbox, runtime-state, state-event, topology replay, and
  feature-owned persistence behavior.

The live API-v1 startup chain is:

```text
apps/api-v1/src/main.ts
  -> composition/create-default-rallar-server.ts
  -> composition/create-api-v1-runtime.ts
       -> composition/create-api-v1-mutation-runtime.ts
       -> composition/create-api-v1-topology-services.ts
       -> rallar-system/middleware/create-rallar-middleware.ts
  -> composition/create-api-v1-admin-services.ts
  -> composition/create-api-v1-system-installers.ts
  -> composition/create-api-v1-route-installers.ts
  -> composition/create-rallar-server.ts
  -> rallar-server/rallar-server-application.ts
```

`main.ts` installs system topics and WebSocket lifecycle, mounts WebSocket and
REST routes, binds the HTTP server, awaits runtime readiness, and only then
starts QueueBox workers when the configured runtime permits them. All configured
AppInbox handlers and all four queue task families are registered before a
queue engine can be returned or started.

## Incoming database mutations

**AppInbox is mandatory for incoming database mutations.** HTTP and WebSocket
entry owners authenticate and decode a current typed command, then call the
owning domain inbox service. There is no direct-write fallback.

```text
HTTP or WebSocket entry
  -> domain AppInbox queue client
  -> ResourceInboxRepository reservation and durable enqueue
  -> QueueBox worker
  -> registered domain decoder and handler
  -> read -> compute -> validate
  -> AppInbox-owned transaction
       -> service write receives the transaction
       -> conditional authority guard
       -> current state/event/receipt
       -> APP_OUTBOX or WS_OUTBOX
       -> typed durable result and reservation finalization
  -> commit
  -> result waiter decodes the durable result
  -> after-commit cache observation or publication
```

AppInbox owns the ingress transaction and retry boundary. Its current
ResourceInbox retry policy allows **20 total processing attempts**. A domain
service never opens, commits, replaces, or retries that transaction.
`RtcTopologyOutboxWork` and other downstream work run under their own
ResourceInbox/QueueBox attempt boundary; neither service owns the transaction
or retry boundary.

Logical WebSocket audience resolution happens only after commit. Transactional
writes persist semantic outbox intent; target resolution and delivery use
committed authority. Queue notifications are wake-ups, not mutation or result
authority.

Authoritative persisted, replicated, queued, event, snapshot, receipt, and
successful response fields are mandatory fields by default. Current writers
define the accepted stored shape. A malformed value or schema mismatch fails at
its owning typed corruption boundary; there is no runtime dual-read, backfill,
or predecessor-format fallback.

## WebSocket entry

`RallarServerWsRouter` owns topic registration, exact ingress decoding,
authorization, dispatch, proxy behavior, publication, and status. API-v1
installs topology AppOutbox, chat, RTC signaling, RTC-RTT, CRDT, and finally the
router from `create-api-v1-system-installers.ts`.

State-sync messages are decoded before ordinary user-topic routing. Client,
group, fixed-topology, and CRDT-principal recipient resolution lives under
`rallar-system/websocket/targets/`. WebSocket close handling enqueues client
disconnect and group-session cleanup through AppInbox.

## Domain map

| Domain                   | Entry or first owner                                                                                  | Durable or external side effect                                         | Mirrored tests                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| AppInbox                 | `rallar-system/app-inbox/app-inbox-queue-client.ts`, `app-inbox/handler/app-inbox-handler-runtime.ts` | Reservation, typed result, retry/failure, transaction finalization      | `packages/tests/shared-server/rallar-system/app-inbox/`                   |
| Runtime state            | `runtime-state/runtime-state-repository.ts`                                                           | Guarded current state and expiry                                        | `packages/tests/shared-server/runtime-state/`                             |
| QueueBox                 | `queuebox/postgres/create-p-sql-resource-inbox-repository.ts`                                         | Entry, reservation, finalization, results, maintenance                  | AppInbox, AppOutbox, and PostgreSQL integration suites                    |
| Client state             | `rallar-system/client-state/inbox/`, `client-state/mutation/`                                         | Snapshot, event, receipt, outbox                                        | `packages/tests/shared-server/client-state/`                              |
| Group state and presence | `rallar-system/group-state/inbox/`, `group-state/mutation/`, `group-state/presence/`                  | Aggregate/session state, event, topology intent                         | `packages/tests/shared-server/group-state/`                               |
| Auth                     | `rallar-system/auth/inbox/`, `auth/login/`                                                            | Current hashed user, session, and ticket state                          | `packages/tests/shared-server/auth/`                                      |
| CRDT                     | `rallar-system/crdt/inbox/`, `crdt/mutation/`, `crdt/persistence/`                                    | Document/update/snapshot rows and outbox                                | `packages/tests/shared-server/crdt/`                                      |
| Topology                 | `rallar-system/topology/inbox/`, `topology/mutation/`, `topology/runtime/`                            | Config, snapshot, publication, topology work                            | `packages/tests/shared-server/rallar-system/topology/`                    |
| RTC-RTT                  | `rallar-system/rtc-rtt/inbox/`, `rtc-rtt/mutation/`                                                   | Measurement, receipt, topology work                                     | `packages/tests/shared-server/rallar-system/rtc-rtt/`                     |
| Topology replay          | `rallar-system/topology/replay/`                                                                      | Delivery log, cursor advancement, current-state hydration               | Topology replay test tree and PostgreSQL integration suites               |
| State events and sync    | `rallar-system/state-events/`, `state-sync/`                                                          | Ordered event reads, exact cache hydration, WebSocket state publication | `packages/tests/shared-server/rallar-system/state-events/`, `state-sync/` |
| WebSocket                | `rallar-system/websocket/router/`, `websocket/targets/`                                               | Authorized routing and live/outbox delivery                             | `packages/tests/shared-server/rallar-system/websocket/`                   |
| Administration           | `rallar-system/admin-operations/`, `admin-support/`                                                   | Typed use cases and read models                                         | `packages/tests/shared-server/admin-operations/`, `admin-support/`        |
| App data                 | `app-data/rallar-server-app-data.ts`                                                                  | Schema-versioned application values                                     | `packages/tests/shared-server/app-data/`                                  |
| RallarAI                 | `rallar-ai/create-rallar-server-ai.ts`                                                                | Validated proposal persistence/publication                              | `packages/tests/shared-server/rallar-ai/`                                 |
| Game authority           | `game/install-rallar-game-authority-server.ts`                                                        | Validated authority result publication                                  | `packages/tests/shared-server/game/`                                      |

## Imports and public exports

Inside this repository, import the canonical owner directly:

```ts
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/create-rallar-middleware.ts';
```

Use `@shared-server/mod.ts` only as the supported package boundary for an
external or cross-package consumer. Add an export there only when the symbol is
a useful current public contract. Do not add nested barrels, forwarding files,
rename-only aliases, or a compatibility path for an old deep import.

## Focused checks

Run the smallest mirrored suite first, then expand in this order:

```bash
npx vitest run packages/tests/shared-server/rallar-system/app-inbox
npx vitest run packages/tests/shared-server/rallar-system/middleware
npx vitest run packages/tests/shared-server/rallar-system/websocket
npx vitest run packages/tests/shared-server/rallar-system/topology
npx vitest run packages/tests/shared-server/runtime-state
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm run typecheck:tests
cd apps/api-v1 && deno task check
npm run check:repo-style -- --root packages/shared-server
npm run check:repo-structure -- --base origin/main
npm run test:repo-governance
```

Mutation-path or concurrency-domain changes also require the PostgreSQL,
medium-scale, topology-replay, and state-write comparative gates documented in
[Persistence and replay](./docs/persistence-and-replay.md#validation).
