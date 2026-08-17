# API-v1 Composition

This directory is the production construction map for the API-v1 server. It separates operational
defaults from required assembly and keeps each runtime, topology, admin, installer, and lifecycle
owner directly reachable from the entry point.

## Construction and registration

Start at [`main.ts`](../main.ts), which calls
[`createDefaultRallarServer`](./create-default-rallar-server.ts). The default factory performs these
phases in order:

1. Read database, pub/sub, auth, CRDT, topology, formation, capacity, replay, timing, and resilience
   configuration.
2. Resolve the raw SQL client in [`db.ts`](../db/db.ts) and translate it once through
   [`toPSqlSql`](../db/to-p-sql-sql.ts) for shared-server repositories.
3. Create one [`ApiV1BackgroundTaskLifecycle`](./api-v1-background-task-lifecycle.ts), then build
   the complete [`ApiV1Runtime`](./api-v1-runtime.ts) through
   [`createApiV1Runtime`](./create-api-v1-runtime.ts).
4. `createApiV1Runtime` creates the mutation boundary through
   [`createApiV1MutationRuntime`](./create-api-v1-mutation-runtime.ts), creates the RTC runtime,
   assembles shared middleware, attaches replay, and registers owned background work.
5. [`createApiV1TopologyServices`](./create-api-v1-topology-services.ts) constructs topology and RTT
   repositories, planning, refinement, management, AppInbox dependencies, and admin metrics.
6. [`createApiV1AdminServices`](./create-api-v1-admin-services.ts) constructs operations, support,
   and statistics services from the completed runtime and topology capabilities.
7. [`createApiV1SystemInstallers`](./create-api-v1-system-installers.ts) owns system-topic and
   WebSocket-lifecycle installation.
   [`createApiV1RouteInstallers`](./create-api-v1-route-installers.ts) owns the ordered WebSocket
   and REST route registrations.
8. The required-input [`createRallarServer`](./create-rallar-server.ts) performs the single final
   `createRallarServerApplication` call. It reads no environment, chooses no defaults, and creates
   no services.
9. `main.ts` invokes the system installers, mounts WebSocket and REST routes, binds the HTTP server,
   waits for runtime readiness, and starts queue workers under the replay policy.

The Relic server starts at
[`apps/relic-hunter-server-v1/src/main.ts`](../../../relic-hunter-server-v1/src/main.ts) and uses
the same default factory with only its intentional WebSocket options.

## Runtime invocation and shutdown

- REST and WebSocket reads enter an installed route, authenticate through the runtime's auth
  repository, call the explicit state/topology/admin read owner, and translate its result at the
  route boundary.
- Database mutations enter the runtime's AppInbox service. AppInbox owns the stable read, pure
  compute and validation, short transaction, durable result, final outbox effects, commit, retry,
  and wake behavior. Route installers do not provide a direct-write fallback.
- System WebSocket topics use the same completed runtime and topology services. WebSocket close
  handling translates close facts into client-disconnect and group-session-cleanup AppInbox work.
- Runtime readiness combines the required startup owners. API-v1 starts queue workers only after
  that readiness succeeds and the replay configuration permits them.
- Process unload and RTC delivery health failure both call `rallar.runtime.backgroundTasks.stop()`.
  The lifecycle snapshots and clears registered stops, stops runtime-state expiry, attempts every
  captured stop, and exposes any failure to its caller.

There is no module-global API runtime, service locator, optional server factory, or alternate SQL
translation path in this composition graph.
