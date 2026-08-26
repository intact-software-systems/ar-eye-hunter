# API-v1 Composition

This directory is the production construction map for the API-v1 server. Operational policy is
resolved once by `configuration/`; composition receives that immutable snapshot plus the explicit
database lifecycle and keeps each runtime, topology, admin, installer, and lifecycle owner directly
reachable from the entry point.

## Construction and registration

Start at [`main.ts`](../main.ts). It resolves and validates one configuration snapshot, logs its safe
summary, constructs [`ApiV1DatabaseLifecycle`](../db/api-v1-database-lifecycle.ts), and passes both
owners to [`createDefaultRallarServer`](./create-default-rallar-server.ts). Construction then proceeds
in this order:

1. Register the database lifecycle's close operation with one
   [`ApiV1BackgroundTaskLifecycle`](./api-v1-background-task-lifecycle.ts), so SQL closes after the
   runtime resources that depend on it.
2. Build
   the complete [`ApiV1Runtime`](./api-v1-runtime.ts) through
   [`createApiV1Runtime`](./create-api-v1-runtime.ts).
3. `createApiV1Runtime` creates the mutation boundary through
   [`createApiV1MutationRuntime`](./create-api-v1-mutation-runtime.ts), creates the RTC runtime,
   assembles shared middleware, attaches replay, and registers owned background work.
4. [`createApiV1TopologyServices`](./create-api-v1-topology-services.ts) constructs topology and RTT
   repositories, planning, refinement, management, AppInbox dependencies, and admin metrics.
5. [`createApiV1AdminServices`](./create-api-v1-admin-services.ts) constructs operations, support,
   and statistics services from the completed runtime and topology capabilities.
6. [`createApiV1SystemInstallers`](./create-api-v1-system-installers.ts) owns system-topic and
   WebSocket-lifecycle installation.
   [`createApiV1RouteInstallers`](./create-api-v1-route-installers.ts) owns the ordered WebSocket
   and REST route registrations.
7. The required-input [`createRallarServer`](./create-rallar-server.ts) performs the single final
   `createRallarServerApplication` call. It reads no environment, chooses no defaults, and creates
   no services.
8. `main.ts` invokes the system installers and mounts the routes. `startApiProcess` binds the HTTP
   server, awaits database and runtime readiness, then starts queue workers under the resolved
   replay policy. A readiness failure shuts the bound server and all constructed runtime owners
   before startup returns.

The Relic server starts at [`apps/relic-hunter-server-v1/src/main.ts`](../../../relic-hunter-server-v1/src/main.ts)
and supplies the same required API-v1 configuration and database-lifecycle owners with its
intentional WebSocket options.

## Runtime invocation and shutdown

- REST and WebSocket reads enter an installed route, authenticate through the runtime's auth
  repository, call the explicit state/topology/admin read owner, and translate its result at the
  route boundary.
- Database mutations enter the runtime's AppInbox service. AppInbox owns the stable read, pure
  compute and validation, short transaction, durable result, final outbox effects, commit, retry,
  and wake behavior. Route installers do not provide a direct-write fallback.
- System WebSocket topics use the same completed runtime and topology services. WebSocket close
  handling translates close facts into client-disconnect and group-session-cleanup AppInbox work.
- Database construction establishes SQL readiness before composition returns. Runtime readiness
  then combines the remaining startup owners. API-v1 binds HTTP before awaiting that barrier but
  does not start queue workers or report successful startup until readiness succeeds and the replay
  configuration permits them.
- Process unload and RTC delivery health failure both call `rallar.runtime.backgroundTasks.stop()`.
  Startup failure invokes the same owner. The lifecycle snapshots and clears registered stops,
  stops runtime-state expiry, runs captured stops sequentially in reverse registration order, and
  exposes any failure to its caller. This keeps SQL available until dependent workers, publishers,
  and listeners stop.

There is no module-global API runtime, SQL client, configuration reader, service locator, optional
server factory, or alternate SQL translation path in this composition graph.
