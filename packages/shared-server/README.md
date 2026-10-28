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
  app-data owner and application AppInbox;
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
       -> composition/create-api-v1-app-inbox.ts
  -> composition/create-api-v1-admin-services.ts
  -> composition/create-api-v1-system-installers.ts
  -> composition/create-api-v1-route-installers.ts
  -> composition/create-rallar-server.ts
  -> rallar-server/rallar-server-application.ts
```

`main.ts` installs system topics and WebSocket lifecycle, mounts WebSocket and
REST routes, binds the HTTP server, awaits runtime readiness, and then calls
`rallar.start({ queueWorkers })`. Startup always seals registration and opens
application admission. Local QueueBox workers start only when enabled; a passive
producer still admits durable work for another claimant. All configured
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
The RTC topology work handler and other downstream work run under their own
ResourceInbox/QueueBox attempt boundary; neither service owns the transaction
or retry boundary.

Logical WebSocket audience resolution happens only after commit. Transactional
writes persist semantic outbox intent; target resolution and delivery use
committed authority. Queue notifications are wake-ups, not mutation or result
authority.

**The request trace.** Every enqueue is an `AppInboxEnqueueInput`: the stored
command `AppInboxEnqueue` plus the trace of the request it serves (an HTTP
request's `x-request-id`, or a WS command's envelope trace).
`createDefaultAppInboxQueueMessage` stamps the trace on the command envelope's
`id.traceId`; the stored command, its idempotency identity and its hash never
carry it. The reservation winner's envelope is retained, so a replay under another
trace observes the first request's trace. A handler reads
`context.message.id.traceId` once and passes it in its compute input; several
families carry it in `AppInboxCommandAttempt { attemptCount, traceId }`. No trace
is minted inside a pure compute, because `validate` and the stored-row validators
recompute it. Work-derived rows take the retained work row's envelope trace, and
controls take their subject message's. Only an autonomous enqueue or publication
with no cause mints a trace at its boundary: the retention and expired-presence
sweeps, the session cleanup and client disconnect of a socket close, the
expired-session sweep, the planning service's local publication, the replay repair
and the reconnect hydration. The audit stamp and the group and client events take
the trace from the handler facts.

**The formation cycle keeps the trace.** The topology work cycle submits its
formation criterion, formation automation, topology publication and activation
status commands as one `GroupSystemCommandSubmission { command, atEpochMs, traceId }`
through a `GroupSystemCommandPort`
(`rallar-system/group-state/inbox/group-system-command-submission.ts`). The trace
is the one of the message that caused the submission. A trailing formation
criterion petition fires from a timer under the trace of the message that last
requested it. The activation status clock is armed with `armStatusClock(work,
traceId)` and writes its row under that trace. So a join, its formation timers and
its activation publication follow one trace, and the formation cycle mints none.

**Timing lines and receipt observations name the trace.** `RallarTimingEvent.traceId`
names the request or message a timing line describes. The HTTP line sets it beside
an equal `requestId`. The AppInbox client, waiter, executor, transaction and phase
lines take it from the enqueue input, the wait or the message, and the other
request- and message-scoped producers set it too. It is absent only where a producer
holds no decoded message or request, such as the AppInbox dequeue pass, its
boundary, the computed queue failure and the retry exhaustion; the field's JSDoc in
`rallar-system/observability/timing.ts` names that complete set. A WS receipt
observation names the trace of the message it is about: a business socket decision
and an issued receipt carry the subject's, an ACK's facts carry the ACK's own (its
subject's in production), and `ack-count` carries the live aggregate's. The
`ws-receipt` timing line copies the observation's trace. The admin realtime
receipt entry names the trace of the message's latest receipt fact.

Authoritative persisted, replicated, queued, event, snapshot, receipt, and
successful response fields are mandatory fields by default. Current writers
define the accepted stored shape. A malformed value or schema mismatch fails at
its owning typed corruption boundary; there is no runtime dual-read, backfill,
or predecessor-format fallback.

## Application operations

Server-side applications register namespaced operations through
`RallarServerApplication.appInbox`, exported as `RallarServerAppInbox` from
`@shared-server/mod.ts`. Every process owning an operation registers it on the same capability instance
before `rallar.start(...)` seals registration and opens admission. Different workers
may own different application operation sets; claims use each worker’s local inventory.
The complete database-wide room-owned retention catalog is a separate configuration
contract shared by every process using that database. `rallar.start()` keeps the default of starting
local workers; `rallar.start({ queueWorkers: 'disabled' })` opens a passive
producer's admission without starting local workers. API background-task shutdown
closes the same AppInbox owner in either mode. Applications do not assemble private AppInbox
clients, handlers, reservation or completion owners.

A registration supplies its canonical envelope codec, logical identity,
winner-only immutable fact capture, command-bound result decoder and one
read/compute/validate/write handler. The generic product owns admission,
identity validation, reservation, transaction completion and QueueBox retries;
the application owns authorization, proposals and mutation/publication policy.
`commit` receives the exact result and a transaction-bound write and resolves
after state, final outbox and completion commit together.

`enqueue` and `submit` take `{ command, traceId }`: the caller's trace (an HTTP
request's `x-request-id`, or a WS command's envelope trace) rides the admitted
envelope, and the retained command and its idempotency identity never carry it.
`enqueue` returns `Either<failure, Admission<Result>>` after durable admission;
its bound `wait()` decodes the exact retained winner's result. `readAdmission`
returns retained pending or completed admission immediately, or `undefined` only
for a validated miss. Only that miss permits an external proposal call.
`submit` and `readReplay` are completion-waiting conveniences over those same
paths. Expected lifecycle/idempotency failures are Left values; corrupt stored
invariants remain distinct failures. A WS delivery handler can finish after
admission while a REST boundary waits for completion.

See [the counter example](../../examples/server-app-inbox/README.md). Application consumers use the existing queue and transaction owner. Workers claim platform topics and their sealed local application topics; other applications' rows remain untouched. Room retention requires an explicit complete database-wide room-owned AppData catalog shared by every process using the database.

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

| Domain                   | Entry or first owner                                                                                                  | Durable or external side effect                                         | Mirrored tests                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| AppInbox                 | `rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts`, `app-inbox/handler/app-inbox-handler-runtime.ts` | Queue entry, reservation, typed result, retry/failure, finalization     | `packages/tests/shared-server/rallar-system/app-inbox/`                                                                     |
| Runtime state            | `runtime-state/runtime-state-repository.ts`                                                                           | Guarded current state and expiry                                        | `packages/tests/shared-server/runtime-state/`                                                                               |
| QueueBox                 | `queuebox/postgres/create-p-sql-resource-inbox-repository.ts`                                                         | Entry, reservation, finalization, results, maintenance                  | AppInbox, AppOutbox, and PostgreSQL integration suites                                                                      |
| Client state             | `rallar-system/client-state/inbox/`, `client-state/mutation/`                                                         | Snapshot, event, receipt, outbox                                        | `packages/tests/shared-server/rallar-system/client-state/`                                                                  |
| Group state and presence | `rallar-system/group-state/inbox/`, `group-state/mutation/`, `group-state/presence/`                                  | Aggregate/session state, event, topology intent                         | `packages/tests/shared-server/rallar-system/group-state/`                                                                   |
| Auth                     | `rallar-system/auth/inbox/`, `auth/login/`                                                                            | Current hashed user, session, and ticket state                          | `packages/tests/shared-server/rallar-system/auth/`                                                                          |
| CRDT                     | `rallar-system/crdt/inbox/`, `crdt/mutation/`, `crdt/persistence/`                                                    | Document/update/snapshot rows and outbox                                | `packages/tests/shared-server/rallar-system/crdt/`                                                                          |
| Topology                 | `rallar-system/topology/inbox/`, `topology/mutation/`, `topology/runtime/`                                            | Config, snapshot, publication, topology work                            | `packages/tests/shared-server/rallar-system/topology/`                                                                      |
| RTC-RTT                  | `rallar-system/rtc-rtt/inbox/`, `rtc-rtt/mutation/`                                                                   | Measurement, receipt, topology work                                     | `packages/tests/shared-server/rallar-system/rtc-rtt/`                                                                       |
| Topology replay          | `rallar-system/topology/replay/`                                                                                      | Delivery log, cursor advancement, current-state hydration               | Topology replay test tree and PostgreSQL integration suites                                                                 |
| State events and sync    | `rallar-system/state-events/`, `state-sync/`                                                                          | Ordered event reads, exact cache hydration, WebSocket state publication | `packages/tests/shared-server/rallar-system/state-events/`, `packages/tests/shared-server/rallar-system/state-sync/`        |
| WebSocket                | `rallar-system/websocket/router/`, `websocket/targets/`                                                               | Authorized routing and live/outbox delivery                             | `packages/tests/shared-server/rallar-system/websocket/`                                                                     |
| Administration           | `rallar-system/admin-operations/`, `admin-support/`                                                                   | Typed use cases and read models                                         | `packages/tests/shared-server/rallar-system/admin-operations/`, `packages/tests/shared-server/rallar-system/admin-support/` |
| App data                 | `app-data/rallar-server-app-data.ts`                                                                                  | Schema-versioned application values                                     | `packages/tests/shared-server/app-data/`                                                                                    |
| RallarAI                 | `rallar-ai/create-rallar-server-ai.ts`                                                                                | Validated proposal persistence/publication                              | `packages/tests/shared-server/rallar-ai/`                                                                                   |
| Game authority           | `game/install-rallar-game-authority-server.ts`                                                                        | Validated authority result publication                                  | `packages/tests/shared-server/game/`                                                                                        |

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
