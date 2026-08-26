# Shared-server runtime navigation

This document answers two questions: where is a callback registered, and what
invokes it at runtime? Follow the concrete owners below instead of searching for
a generic service or repository directory.

## API-v1 construction timeline

```text
apps/api-v1/src/main.ts
  1. readApiV1Configuration
  2. createApiV1DatabaseLifecycle
  3. createDefaultRallarServer
       -> createApiV1Runtime
            -> createApiV1MutationRuntime
            -> createApiRtcTopologyRuntime
            -> createApiV1TopologyServices
            -> createRallarMiddleware
       -> createApiV1AdminServices
       -> createApiV1SystemInstallers
       -> createApiV1RouteInstallers
       -> createRallarServer
            -> createRallarServerApplication
  4. installSystemTopics
  5. installWebSocketLifecycle
  6. mountWebSocket
  7. mountRest
  8. startApiProcess
       -> bind HTTP
       -> await runtime readiness
       -> start QueueBox workers when enabled
```

`create-default-rallar-server.ts` is the application-specific composition root.
It supplies every runtime, repository, app-data, WebSocket, system-installer,
and route-installer dependency to the reusable
`rallar-server/rallar-server-application.ts` owner.

`RallarServerApplication` is deliberately small. Its public operations expose
the lifecycle directly:

- `installSystemTopics()` installs current system features and the router;
- `installWebSocketLifecycle()` registers close handling;
- `mountWebSocket(app)` registers the WebSocket upgrade route;
- `mountRest(app)` registers REST routes in composition order;
- `start()` starts the already-complete queue engine.

## Middleware construction barrier

`rallar-system/middleware/create-rallar-middleware.ts` has four visible phases:

1. `rallar-middleware-queue-registration.ts` creates the single queue
   registration owner but exposes no engine to start.
2. `create-rallar-middleware-infrastructure.ts` creates the WebSocket QueueBox
   service, inbox/outbox readers, resilience values, and pub/sub readiness.
3. `create-rallar-middleware-inbox-services.ts` invokes all configured domain
   factories. Each service constructs its queue client and registers its exact
   typed handlers synchronously.
4. `rallar-middleware-queue-registration.ts` registers the WebSocket inbox,
   WebSocket outbox, application inbox, and application outbox task families.
   `assemble-rallar-middleware-runtime.ts` consumes the owner-bound single-use
   registration handle and only then exposes the queue engine.

The first possible `qboxEngine.start()` invocation is
`RallarServerApplication.start()`, called from `main.ts` through
`startApiProcess`. No inbox dependency or handler is installed after that
point.

## HTTP read timeline

```text
main.ts
  -> RallarServerApplication.mountRest
  -> create-api-v1-route-installers.ts selected installer
  -> route boundary authenticates and decodes request
  -> explicit query/repository owner
  -> route translates current typed result to HTTP
```

Client and group snapshot reads enter through
`routes/state-snapshot-read/create-state-snapshot-read-route-registrars.ts`.
Topology reads enter through `routes/graph-topology-routes.ts`. Administration
reads use the named owners built by `create-api-v1-admin-services.ts`. A read
route does not acquire a mutation capability merely because its response comes
from the same domain.

## HTTP and WebSocket mutation timeline

Registration and invocation are separate:

```text
construction
  domain inbox service constructor
    -> AppInboxHandlerRegistry.registerHandler
    -> InboxQueueReader.onInboxMessageDo

runtime
  HTTP route or mutating WebSocket topic
    -> authenticate and decode current command
    -> domain inbox service
    -> AppInboxQueueClient reserve/enqueue/wait
    -> QueueBox application-inbox task
    -> InboxQueueReader invokes the registered callback once per reserved attempt
    -> validateAppInboxCommandIdentity
    -> registration.decodeCommand(JsonWireValue)
    -> domain handler read/compute/validate
    -> AppInboxTransactionWriter
         -> runInPSqlTransaction
         -> domain write(transaction, computed)
         -> registration.encodeResult
         -> durable typed result
         -> reservation-fenced finalization
    -> commit
    -> AppInboxResultWaiter decodes the durable result
    -> caller translates success or AppInboxFailure
```

The QueueBox retry controller may reserve the entry again under the current
attempt policy. Each attempt re-enters the registered handler and therefore
re-reads current authority. Terminal classification persists one typed
`AppInboxFailure`; retryable failures return to QueueBox without manufacturing a
terminal result.

Domain entry owners are located here:

| Domain          | Queue client and registration owner     | Read/compute/validate/write owner                              |
| --------------- | --------------------------------------- | -------------------------------------------------------------- |
| Auth            | `rallar-system/auth/inbox/`             | `auth/mutation/` and `auth/persistence/`                       |
| Client          | `rallar-system/client-state/inbox/`     | `client-state/mutation/`                                       |
| Group           | `rallar-system/group-state/inbox/`      | `group-state/mutation/`                                        |
| CRDT            | `rallar-system/crdt/inbox/`             | `crdt/mutation/` and `crdt/persistence/`                       |
| Admin           | `rallar-system/admin-operations/inbox/` | named use-case and PostgreSQL owners under `admin-operations/` |
| Topology config | `rallar-system/topology/inbox/`         | `topology/config/mutation/`                                    |
| RTC-RTT         | `rallar-system/rtc-rtt/inbox/`          | `rtc-rtt/mutation/`                                            |

## WebSocket registration and invocation

`create-api-v1-system-installers.ts` installs features in this exact order:

1. topology AppOutbox work;
2. chat;
3. RTC signaling;
4. RTC-RTT;
5. CRDT;
6. `RallarServerWsRouter.install()`.

The WebSocket upgrade route is registered separately by
`create-api-v1-route-installers.ts`. At runtime:

```text
WebSocket frame
  -> JsonWebSocketServer / WsQueueBoxServerService inbox
  -> QueueBox WebSocket-inbox task
  -> registered system handler or RallarServerWsRouter.route
  -> state-sync/system/reserved-topic classification
  -> exact JSON decoding
  -> room and topic authorization
  -> topic validation and handler dispatch
  -> optional proxy transformation
  -> live-only send, durable WebSocket outbox enqueue, or no fanout
```

`rallar-system/state-sync/state-sync-payload.ts` gets first refusal on state-sync
messages before ordinary user-topic routing. It performs one exact decoder
boundary; unsupported or malformed data does not hydrate caches.

`rallar-system/websocket/targets/` owns client, group, fixed-topology, and
CRDT-principal recipient resolution. The router does not duplicate target
policy. For durable delivery, `publish-rallar-server-ws-message.ts` enqueues the
WebSocket outbox and wakes the engine; the outbox worker resolves recipients
from committed authority.

## Topology work and replay invocation

Topology changes are two related but distinct flows:

```text
committed group/config/RTT mutation
  -> APP_OUTBOX topology work
  -> install-topology-app-outbox.ts handler
  -> topology read/compute/validate/write
  -> immutable topology publication + delivery log append
  -> local-commit and notification wakes

replay startup, poll, notification, or local-commit wake
  -> RtcTopologyReplayService single-flight turn
  -> RtcTopologyReplayDrain bounded pages
  -> RtcTopologyReplayPageProcessor
  -> validate durable entry
  -> reload current topology when publication is relevant
  -> WebSocket delivery or current-state hydration
  -> transactionally advance consumer/publisher cursor
```

Replay does not make an old publication authoritative. A retention gap invokes
current-state hydration before its cursor can advance beyond the missing range.
Reconnect hydration also reads current durable membership, presence, expiry,
and socket generation before sending.

## Background work and shutdown

`createApiV1BackgroundTaskLifecycle` owns registered stop operations. Runtime
construction registers database notification, replay, delivery, expiry, and
other background owners. WebSocket lifecycle adds its stop operation during
installation.

Process unload, startup failure, and topology-delivery health failure converge
on `runtime.backgroundTasks.stop()`. Stops run in reverse registration order so
workers and listeners release their database dependency before the database
lifecycle closes.

## Navigation probes

Use these when a call path becomes unclear:

```bash
rg -n "createDefaultRallarServer|createApiV1Runtime|createRallarMiddleware|createRallarServerApplication" apps/api-v1 packages/shared-server
rg -n "registerHandler|onInboxMessageDo|writeMutation" packages/shared-server/rallar-system
rg -n "installSystemTopics|installWebSocketLifecycle|mountWebSocket|mountRest" apps/api-v1 packages/shared-server
rg -n "installTopologyAppOutbox|RtcTopologyReplayService|hydrateGap" apps/api-v1 packages/shared-server
```
