# Rallar System

`rallar-system` owns reusable server-side runtime behavior. Its directories are
named for the domain or lifecycle they own; the package root is navigation,
not an implementation bucket. Import the owning module directly. Do not add a
forwarder, compatibility alias, or generic `services`/`repositories` bucket.

## Live Entry Chains

API-v1 starts here:

```text
apps/api-v1/src/main.ts
  -> composition/create-default-rallar-server.ts
  -> composition/create-api-v1-runtime.ts
  -> composition/create-api-v1-mutation-runtime.ts
  -> rallar-system/middleware/rallar-middleware.ts
  -> rallar-facade/create-rallar-server-application.ts
```

The package entry is `packages/shared-server/mod.ts`. It exports selected
current contracts from their canonical owner modules. Internal package and app
code should still import the owner directly so the dependency is visible.

## Call Entry Paths

HTTP mutations enter an API-v1 route installer, authenticate, create a typed
domain command, enqueue it through that domain's AppInbox client, and wait for
the typed durable result. A registered handler re-reads current authority and
runs the complete read/compute/validate/write flow inside the AppInbox-owned
transaction. The committed outbox is the boundary for later WebSocket effects.

WebSocket connections enter through the API-v1 WS mount and the shared facade.
API-v1 explicitly installs state-sync, topology publication and delivery,
chat, signalling, RTC-RTT, CRDT, and then the router. The router owns its topic
registry, ingress decoding and authorization, publication, and status under
`websocket/router/`; client, group, fixed-topology, and CRDT-principal audience
resolution lives under `websocket/targets/`. Mutating topics enqueue the same
typed domain commands used by HTTP. Queue pub/sub wakes workers but is never
mutation authority.

## Construction And First Invocation

1. API-v1 creates database adapters, repositories, caches, and the WebSocket
   server.
2. It creates domain services and every AppInbox queue client and handler.
3. Middleware assembles QueueBox and WebSocket infrastructure, registers all
   handlers, and returns the final runtime.
4. API-v1 attaches durable topology replay and awaits runtime readiness.
5. `main.ts` installs system topics and WebSocket lifecycle, mounts HTTP/WS,
   then starts QueueBox workers. No handler dependency is installed after the
   engine can start.

## Owner Map

| Domain                   | Entry and authority                                           | Durable/external side effect                                  | Focused tests                                         |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| AppInbox                 | `app-inbox/`                                                  | resource-inbox reservation, typed result, retry/failure       | `packages/tests/shared-server/app-inbox-*.test.ts`    |
| Client state             | `client-state/inbox/`, `client-state/mutation/`               | snapshot, event, outbox                                       | `packages/tests/shared-server/client-state/`          |
| Group state and presence | `group-state/inbox/`, `group-state/mutation/`, `presence/`    | snapshot, event, topology intent                              | `packages/tests/shared-server/group-state/`           |
| Auth                     | `auth/inbox/`, `auth/`                                        | current hashed session/ticket state                           | `packages/tests/shared-server/auth/`                  |
| CRDT                     | `crdt/inbox/`, `crdt/`                                        | document log and outbox                                       | `packages/tests/shared-server/crdt/`                  |
| Topology                 | `topology/mutation/`, `topology/replay/`, `topology/runtime/` | accepted publication and replay                               | `packages/tests/shared-server/topology-*`             |
| RTC-RTT                  | `rtc-rtt/inbox/`, `rtc-rtt/mutation/`, `rtc-rtt/persistence/` | measurement, receipt, topology work                           | `packages/tests/shared-server/rallar-system/rtc-rtt/` |
| State sync               | `state-sync/`                                                 | exact decoding, cache observation, post-commit WS publication | `packages/tests/shared-server/*state-sync*.test.ts`   |
| WebSocket                | `websocket/router/`, `websocket/targets/`                     | ingress policy, routing, connection lifecycle, topic delivery | `packages/tests/shared-server/*ws*.test.ts`           |
| Communication topics     | `communication/`                                              | chat broadcast and RTC signaling delivery                     | feature-owned communication topic tests               |
| Queue pub/sub            | `queue-pubsub/`                                               | low-latency worker wake-up                                    | `packages/tests/shared-server/*pubsub*.test.ts`       |
| Administration           | `admin-operations/`, `admin-support/`                         | typed admin AppInbox commands and read models                 | `packages/tests/shared-server/admin-*.test.ts`        |

Current writers define the accepted stored shape. Unexpected predecessor rows
fail at the owning typed validation/corruption boundary; runtime code does not
backfill, dual-read, scan, or fall back to predecessor formats. Prisma migration
history and current durable topology replay remain because they build and run
today's system.

## Public Exports

Add a `mod.ts` export only for a useful current cross-package contract. Export
it directly from its owner. Deep internal helpers stay unexported. Renames are
atomic across in-repo consumers: no redirect file or alias preserves the old
path.

## Focused Validation

Run the smallest affected suite first, then the package gates:

```bash
npx vitest run packages/tests/shared-server/app-inbox-service.test.ts
npx vitest run packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts
npx vitest run packages/tests/shared-server/rallar-system/rtc-rtt
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
npm run check:repo-style
npm run check:repo-structure
npm run test:repo-governance
```
