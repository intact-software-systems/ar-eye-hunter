# Rallar Server Repositories Improvement Areas

This document lists problem areas found while analysing Rallar Server repositories, persistence, caches, and REST/WS data flow. It is intentionally separate from the architecture document so the descriptive model and hardening work stay distinct.

## 1. State Snapshot Broadcasts Are Global

Current behavior:

- `StateSyncPublisher` creates broadcast AL messages with scope `all`.
- `ws-system-topics.ts` handles state snapshot and event topics by calling `server.broadcast(data)`.
- Browser `data-caches.ts` accepts client/group snapshot messages and writes them into local caches without checking app/workspace or room membership.

Risk:

- In a multi-workspace or multi-tenant deployment, every open WS client can receive every client/group state snapshot and event broadcast by that API process.
- Browser caches may contain state outside the user current scope.
- Room-level privacy depends on higher-level code not using sensitive data in snapshots.

Recommended hardening:

- Target client/group state messages by application/workspace and, for room details, by group membership.
- Add server-side recipient resolution for state sync instead of raw `server.broadcast`.
- Add browser-side scope rejection before accepting snapshots into caches.
- Add tests with two workspaces and two logged-in users proving that cross-scope snapshots do not arrive.

## 2. Room Routing And Authorization Depend On Process-Local Snapshot Cache

Current behavior:

- `createWsServerTargetResolver(...)` resolves room recipients from `groupStateSnapshotsRepository.findGroupStateSnapshotById`.
- `authorizeApiV1RoomWsMessage(...)` also uses the group snapshot cache.
- The durable source of truth is `runtime_state_store`, but the resolver and authorizer read the in-memory snapshot cache.

Risk:

- After process restart, a server can have open sockets but an empty group snapshot cache until a state mutation or explicit cache hydration happens.
- Room-scoped WS messages can be rejected or have no recipients even when durable group membership exists.
- In a multi-server setup, cache lag can make authorization and routing inconsistent between nodes.

Recommended hardening:

- Hydrate client/group snapshot caches on server startup for active scopes, or lazily hydrate a group snapshot from `GroupStateRepository` on cache miss.
- Prefer a resolver/authorizer that can fall back to durable state when the cache is cold.
- Add real-server tests that restart the API process, reconnect clients, and send a room WS message before any new group mutation.

## 3. State Mutation Commit And WS Publish Are Not Atomic

Current behavior:

- Client/group services mutate `runtime_state_store` inside `runtimeRepository.begin(...)`.
- After the transaction completes, they call `StateSyncPublisher`.
- The publisher updates process-local cache and enqueues an AL message through `WsQueueBoxServerService.enqueueOutboxIfAbsent`.

Risk:

- If DB mutation succeeds but WS enqueue fails, the durable state changes but clients do not receive a live update.
- If cache update succeeds but enqueue fails, the local process cache can observe a value that was not broadcast.
- There is no obvious repair job that scans durable state changes and republishes missed state sync messages.

Recommended hardening:

- Introduce a transactional outbox for state sync events, ideally committed in the same database transaction as the state mutation.
- Make WS publication a consumer of that durable outbox.
- Track publish failures with metrics/logging that include application/workspace/group/principal ids.
- Add characterization tests that inject a failing publisher and assert the exact durable-state and cache outcomes.

## 4. State Events Are Broadcast But Not Modeled In Browser High-Level State

Current behavior:

- Server publishes `client-state.event` and `group-state.event` over WS.
- Browser `data-caches.ts` ignores those event topic payloads.
- High-level `rallar.rooms.onChange(...)` and `rallar.people.onChange(...)` are snapshot-cache driven.
- Lower-level `rallar.messages.ws.onMessage(...)` can observe raw WS messages if callers register for them.

Risk:

- Applications may assume they are subscribing to all changes, but the high-level state API only exposes snapshot results.
- Event-specific details, audit causes, and mutation reasons are not represented in the high-level browser facade.

Recommended hardening:

- Decide whether browser Rallar should expose `rooms.onEvent(...)` and `people.onEvent(...)`.
- If not, document that high-level subscriptions are snapshot subscriptions.
- If yes, add browser event caches or direct event callbacks and prove ordering/duplication behavior.

## 5. Server App-Data Cache Has No Cross-Process Invalidation

Current behavior:

- `RallarServerAppDataStore` persists to `app_data_store`.
- Each opened store keeps an in-process `Map` cache.
- Writes update only the local store cache.
- `compareAndSet` is a read-then-write check in process code, not a Postgres revision compare.

Risk:

- Multiple API processes can serve stale app-data reads from their own caches.
- Concurrent `compareAndSet`, `setIfAbsent`, or `updateOrCreate` calls can lose updates.
- The `revision` column is incremented but not used as an optimistic concurrency guard.

Recommended hardening:

- Document app-data cache consistency as local-read-through only until stronger semantics exist.
- Add revision-based conditional update APIs in `AppDataRepositoryLike`.
- Add Postgres LISTEN/NOTIFY or another invalidation mechanism for app-data writes.
- Add concurrent update tests against a real Postgres database.

## 6. `runtime_state_store` Is A Flexible JSON Store With Limited Domain Indexing

Current behavior:

- Auth, client state, group state, and AL runtime data all share `runtime_state_store`.
- Domain repositories use namespace plus encoded string keys.
- Listing by scope relies on prefix scans.
- Domain constraints live in TypeScript, not in table constraints.

Risk:

- High-cardinality namespaces can make list operations expensive.
- It is hard to query or validate domain fields directly in SQL.
- Accidentally malformed JSON can only be detected at repository read time.

Recommended hardening:

- Add load tests around `listSnapshots`, group session scans, and event listing.
- Consider dedicated tables for high-cardinality client/group state if the prefix model becomes a bottleneck.
- Add repository-level validation tests for malformed persisted rows.
- Keep AL runtime bookkeeping in the generic store, but separate domain state if querying needs grow.

## 7. `resource_inbox` Carries Both Queue Durability And PubSub Propagation

Current behavior:

- API-v1 passes the same `PSqlQueueBox` as WS inbox and outbox.
- The physical table is named `resource_inbox`, but it stores both `WS_INBOX` and `WS_OUTBOX` entries.
- QueueBox PubSub publishes serialized entries through Postgres LISTEN/NOTIFY. Self messages are ignored by publisher id.

Risk:

- The table name obscures that it is now a general queue table.
- Inbox and outbox share the same unique key shape and physical indexes, which may become a contention point.
- Postgres NOTIFY payloads have a small payload limit compared with the dynamic topic payload limit, so larger AL messages can fail pubsub propagation even if QueueBox persistence succeeds.

Recommended hardening:

- Rename or document the table as a general queuebox table in future schema work.
- Add metrics by `ri_type_id`, status, attempt count, and age.
- Add tests or guards for pubsub payload size before `sql.notify(...)`.
- Consider publishing only a durable queue key over LISTEN/NOTIFY and having peers load the payload from Postgres.

## 8. Snapshot Cache TTL Can Conflict With Durable Presence Semantics

Current behavior:

- Server and browser shared state snapshot repositories are TTL-based process caches.
- Durable sessions have their own `expiresAtEpochMs`.
- Snapshot active sessions are computed from durable state at snapshot creation time.

Risk:

- A snapshot can remain cached while one of its embedded sessions has expired in durable state.
- The cache has no independent reconciliation job that recomputes snapshots when embedded session rows expire.
- Room target resolution can use a cached snapshot whose active session list is stale.

Recommended hardening:

- Bound snapshot cache TTL to the shortest embedded session expiry.
- Recompute snapshots on heartbeat expiry or before room routing.
- Add tests where a group presence session expires without a disconnect event and then room routing is attempted.

## 9. Built-In State Sync Uses Snapshot Broadcasts More Than Event Replay

Current behavior:

- State mutations append durable events.
- Browser state caches are hydrated and updated primarily from snapshots.
- Missed WS messages can be corrected by REST refresh, but there is no explicit client cursor/replay protocol.

Risk:

- Clients can miss transient event details while still converging to latest snapshot.
- There is no built-in "subscribe from revision N" or "replay events since timestamp" path in the browser facade.

Recommended hardening:

- Treat snapshots as convergence and events as optional audit unless a replay contract is added.
- Add event cursor APIs if applications need guaranteed event processing.
- Include profile/presence/roster versions in client-side stale update rejection tests.

## 10. Lifecycle Cleanup Depends On WS Close Being Observed

Current behavior:

- `ws-lifecycle-service.ts` disconnects client and group sessions on socket close.
- Logout deletes auth session, and browser reconnect prevention exists client-side, but the server socket lifecycle is still the cleanup trigger for live presence.

Risk:

- Abrupt network loss or process failure can leave presence active until expiry.
- If close handling fails after socket close, durable presence can remain active until TTL.

Recommended hardening:

- Keep TTLs short enough for acceptable stale presence.
- Add server-side periodic reconciliation for expired presence sessions and snapshot publication.
- Add tests for abrupt socket termination and server restart.

## Suggested First Proofs

1. Multi-workspace isolation test: prove whether state snapshots from workspace A reach a browser connected to workspace B.
2. Cold-cache room routing test: restart server, reconnect two room members, and send a room WS message before any state mutation.
3. Publish failure characterization: inject a failing `StateSyncPublisher` and document committed DB state, process cache state, and enqueue result.
4. App-data concurrent write test: run two store instances against the same Postgres row and characterize `compareAndSet` and `updateOrCreate`.
5. PubSub payload limit test: publish a dynamic message near and above the NOTIFY payload limit.
