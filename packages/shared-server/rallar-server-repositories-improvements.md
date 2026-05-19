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

Implementation status:

- Started on 2026-05-18.
- Completed focused test-first proof for client snapshot cross-scope routing and browser cache hydration scope rejection.
- Added server-side state-sync recipient filtering for the QueueBox target resolver path and the system-topic `server.broadcast(...)` path.
- Client state snapshots/events now route only to open sessions whose cached client snapshot is in the same application/workspace.
- Group state snapshots/events now route only to open sessions for active/invited group members in the same application/workspace; removed/left/banned members and cross-workspace sessions are excluded.
- Malformed state-sync payloads fail closed with no recipients instead of falling back to global broadcast.
- Browser state caches now reject out-of-scope client/group snapshots before writing local caches. Rallar scoped operations pass their scope through to cache hydration.
- The in-memory group snapshot repository now stores snapshots under an application/workspace/group composite key, so identical `groupId` values in different workspaces no longer overwrite each other.
- Group state-event routing now uses the event application/workspace scope when falling back to the in-memory snapshot repository.

Verification:

- Up-front failing proof: `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-web/data-caches.test.ts` failed because client state broadcasts resolved all open sessions and browser hydration accepted out-of-scope snapshots.
- Up-front failing proof for repository isolation: `npx vitest run packages/tests/shared/repository-modules.test.ts --testNamePattern "same group id"` failed because only the last same-`groupId` workspace snapshot remained in the repository.
- After implementation: `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`.
- After repository isolation: `npx vitest run packages/tests/shared/repository-modules.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared/webrtc-group-service.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-graph/group-graph-services.test.ts`.
- Type/runtime checks: `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, and `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`.
- Repository isolation type checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and `npx tsc -p packages/shared-web/tsconfig.json --noEmit`.

Remaining gaps:

- The proof is focused/unit-level. The originally recommended two-real-browser/two-workspace integration scenario is still pending.
- Some public/internal APIs still accept only `groupId` and therefore remain ambiguous when one process intentionally works with multiple scopes at the same time. The repository now has a scoped lookup, but higher-level APIs should gradually move toward `GroupRef`/scope-aware signatures where the caller knows the scope.
- Event routing for group events depends on a cached group snapshot. If the group snapshot cache is cold, the event fails closed rather than broadcasting.

GroupId-only API audit:

- Repository/cache: the deprecated `findGroupStateSnapshotById(groupId)`, `findFirstGroupStateSnapshotIdSessionIdIsIn(sessionId)`, and `setGroupStateSnapshotById(groupId, snapshot)` helpers have been removed. New repository code uses `findGroupStateSnapshotByRef(ref)`, `findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId)`, and `setGroupStateSnapshot(snapshot)`.
- RTC group management: `WebRtcGroupManager` and `WebRtcGroupService` still model tracked groups around `groupId`. This is the first implementation target because it can merge RTC desired peers when the same room id exists in two scopes.
- Browser Rallar facade: `rooms.join(roomId, options)`, `rooms.leave(...)`, `messages.rtc.send({ roomId })`, `messages.ws.send({ roomId })`, and `rtc.waitForRoomLane(roomId, ...)` use room id as the public handle. They often carry `scope` in options, but cached/current-room helpers still resolve snapshots by id.
- Server WS routing and authorization: `CreateRallarMiddlewareOptions.findGroupSnapshotById`, `createWsServerTargetResolver`, `StateSyncRoutingOptions.findGroupSnapshotById`, and `createGroupRoomWsAuthorizer` still use `groupId`-only resolver callbacks.
- AL message targeting: resolved for multicast. Multicast targets now require scoped `groupRef` and no longer carry a target-level `groupId`; remaining scope ambiguity is in overlay/graph topology identity, not AL target identity.

Implementation order:

- First: update RTC group manager/service internals to key tracked groups by `GroupRef` when a snapshot/scope is available, keeping `groupId` wrappers for single-scope callers.
- Second: make repository API names less misleading by using scoped/readable alternatives and removing `ById` wrappers.
- Third: update server WS routing/authorizer options to accept scoped resolver forms while preserving current callbacks as compatibility fallbacks.
- Fourth: evaluate public Rallar room handles. Public `roomId` can remain ergonomic, but methods that can operate outside the current scope should accept or derive `GroupRef` consistently.

Implementation status for groupId-only audit:

- Started on 2026-05-18.
- Added focused proof that `WebRtcGroupManager` collapsed two snapshots with the same `groupId` from different workspaces into one tracked RTC group.
- `WebRtcGroupManager` now keys tracked groups by `GroupRef` when available, while string-based compatibility lookups still work when exactly one matching scoped group exists.
- `WebRtcGroupService` now accepts either `groupId` or `GroupRef` and reads the matching scoped cached snapshot when multiple same-id snapshots exist.
- Browser cache group-update handling now calls RTC manager `has/delete` with `snapshot.group`, avoiding accidental misses after scoped tracking.
- Added `setGroupStateSnapshot(snapshot)` and `findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId)` repository helpers so new code does not have to use misleading `ById` APIs.
- Updated server state-sync snapshot cache writers to use `setGroupStateSnapshot(snapshot)`.
- Added scoped server WS resolver callbacks: `resolveGroupRef(groupId, message)` and `findGroupSnapshotByRef(ref, message)` on `createWsServerTargetResolver`/middleware options.
- Added scoped room authorization callbacks: `resolveGroupRef(input)` and `findGroupSnapshotByRef(ref, input)` on `createGroupRoomWsAuthorizer`.
- Server-side `findGroupSnapshotById(groupId)` callbacks remain as compatibility fallbacks, but are ignored when a known scoped `GroupRef` exists and the fallback snapshot belongs to a different scope.
- Browser Rallar room sends and waits now accept scoped room refs: `messages.rtc.send({ roomRef })`, `messages.ws.send({ roomRef })`, `realtime.*({ roomRef })`, and `rtc.waitForRoomLane(roomRef, ...)`.
- Browser Rallar now preserves `currentRoomRef` after create/join and resolves current-room/cache lookups by `GroupRef` when available.
- AL multicast targets now carry mandatory scoped `groupRef` and no target-level `groupId`. Browser Rallar must resolve a scoped room ref before RTC multicast sends, server multicast recipient resolution reads the target ref directly, and room authorization can infer scope from the target without an external resolver callback.
- RTC overlay multicast context resolution now uses target `groupRef` to choose the room snapshot when same-id rooms exist in multiple scopes.

Verification for groupId-only audit:

- Up-front failing proof: `npx vitest run packages/tests/shared/webrtc-group-manager.test.ts --testNamePattern "same group id"` failed because `manager.size()` was `1` instead of `2`.
- Up-front failing proof: `npx vitest run packages/tests/shared-web/data-caches.test.ts --testNamePattern "deletes scoped RTC"` failed because browser cache handling called `has("shared-room")` instead of `has(snapshot.group)`.
- Up-front failing proof: `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts --testNamePattern "scoped group snapshot resolver"` routed a same-`groupId` room broadcast to workspace A instead of workspace B.
- Up-front failing proof: `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts` rejected a workspace B room message because the id-only fallback returned the workspace A snapshot.
- Up-front failing proof: `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts --testNamePattern "roomRef"` produced the workspace A cached `minSnapshotVersion` for a workspace B RTC send.
- Up-front failing proof: `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts --testNamePattern "roomRef scope for cached snapshotVersion on RTC"` showed RTC multicast targets carried only `groupId`, not `groupRef`.
- Up-front failing proof: `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts --testNamePattern "multicast targets using target groupRef"` routed a scoped multicast target to workspace A because recipient resolution ignored the target ref.
- Up-front failing proof: `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts --testNamePattern "target groupRef"` rejected a workspace B multicast message because authorization could not infer target scope.
- After implementation: `npx vitest run packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/webrtc-group-service.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared/repository-modules.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-graph/group-graph-services.test.ts`.
- After second pass: `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts`.
- After browser roomRef cleanup: `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts --testNamePattern "roomRef"`.
- After AL multicast target cleanup: `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/al-policy.test.ts`.
- After AL multicast target cleanup: `npx vitest run packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/api-v1/rallar-server-ws-facade.test.ts`.
- After mandatory target `groupRef` cleanup: `npx vitest run packages/tests/shared/al-policy.test.ts packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/al-durable-runtime.test.ts packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/shared/webrtc-rx-policy.test.ts packages/tests/shared-web/rallar-message-selectors.test.ts packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts`.
- Mandatory target `groupRef` type checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and `npm --workspace apps/web run typecheck`.
- Type/runtime checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`.

Remaining groupId-only gaps:

- Browser Rallar still keeps `roomId` as the ergonomic default handle for single-scope use. Multi-scope callers should pass `roomRef`; future cleanup can add overloads for `rooms.join/leave` if those workflows need to target multiple scopes concurrently from one facade.
- AL overlay identity is still a string `overlayId` that commonly defaults to `groupId`. The multicast target is now scoped, but overlay cache keying remains a separate cleanup if one runtime must maintain multiple overlays with the same room id across scopes.
- Graph topology snapshots now carry mandatory `groupRef` instead of `graphId`, so graph updates can identify their room scope. The browser graph handler still updates overlay next hops by `graph.groupRef.groupId`, so overlay cache keying remains ambiguous until overlay identity is scoped too.

Overlay and graph identity follow-up:

- Treat browser overlay identity as a separate iteration from AL target scoping. `groupRef` now protects message authorization/routing and graph snapshots, but overlay topology lookup still depends on `overlayId`.
- Prove the bug first with same-`groupId` rooms in two workspaces in one browser runtime:
  - `createAndSetStarOverlays([workspaceA, workspaceB])` should not collapse or overwrite overlays.
  - `removeOverlayById(groupId)` should not delete another workspace's overlay.
  - a `GraphInfoSnapshot` with workspace B `groupRef` should update only workspace B's overlay next hops.
  - RTC multicast with a scoped `groupRef` should use the matching scoped overlay topology, not whatever same-id overlay was last written.
- Candidate fix: introduce a scoped overlay key derived from `GroupRef`, while retaining human-readable `groupId` and optional custom `overlayId` for diagnostics or explicitly shared topologies.
- Candidate API direction: add helpers such as `toOverlayRef(groupRef)` and `toOverlayKey(groupRef)`. Graph snapshots already carry `groupRef`; avoid bridging from graph state to room overlay topology through a raw string key.

## 2. Room Routing And Authorization Depend On Process-Local Snapshot Cache

Current behavior:

- `createWsServerTargetResolver(...)` resolves room recipients from the process-local group snapshot cache. Scoped multicast uses `GroupRef`; id-only room broadcasts still depend on a local latest-by-`groupId` compatibility resolver.
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
