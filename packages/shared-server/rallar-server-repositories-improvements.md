# Rallar Server Repositories Improvement Areas

This document lists problem areas found while analysing Rallar Server repositories, persistence, caches, and REST/WS
data flow. It is intentionally separate from the architecture document so the descriptive model and hardening work stay
distinct.

## 1. State Snapshot Broadcasts Are Global

Current behavior:

- `StateSyncPublisher` creates broadcast AL messages with scope `all`.
- `ws-system-topics.ts` handles state snapshot and event topics by calling `server.broadcast(data)`.
- Browser `data-caches.ts` accepts client/group snapshot messages and writes them into local caches without checking
  app/workspace or room membership.

Risk:

- In a multi-workspace or multi-tenant deployment, every open WS client can receive every client/group state snapshot
  and event broadcast by that API process.
- Browser caches may contain state outside the user current scope.
- Room-level privacy depends on higher-level code not using sensitive data in snapshots.

Recommended hardening:

- Target client/group state messages by application/workspace and, for room details, by group membership.
- Add server-side recipient resolution for state sync instead of raw `server.broadcast`.
- Add browser-side scope rejection before accepting snapshots into caches.
- Add tests with two workspaces and two logged-in users proving that cross-scope snapshots do not arrive.

Implementation status:

- Started on 2026-05-18.
- Completed focused test-first proof for client snapshot cross-scope routing and browser cache hydration scope
  rejection.
- Added server-side state-sync recipient filtering for the QueueBox target resolver path and the system-topic
  `server.broadcast(...)` path.
- Client state snapshots/events now route only to open sessions whose cached client snapshot is in the same
  application/workspace.
- Group state snapshots/events now route only to open sessions for active/invited group members in the same
  application/workspace; removed/left/banned members and cross-workspace sessions are excluded.
- Malformed state-sync payloads fail closed with no recipients instead of falling back to global broadcast.
- Browser state caches now reject out-of-scope client/group snapshots before writing local caches. Rallar scoped
  operations pass their scope through to cache hydration.
- The in-memory group snapshot repository now stores snapshots under an application/workspace/group composite key, so
  identical `groupId` values in different workspaces no longer overwrite each other.
- Group state-event routing now uses the event application/workspace scope when falling back to the in-memory snapshot
  repository.

Verification:

- Up-front failing proof:
  `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-web/data-caches.test.ts`
  failed because client state broadcasts resolved all open sessions and browser hydration accepted out-of-scope
  snapshots.
- Up-front failing proof for repository isolation:
  `npx vitest run packages/tests/shared/repository-modules.test.ts --testNamePattern "same group id"` failed because
  only the last same-`groupId` workspace snapshot remained in the repository.
- After implementation:
  `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`.
- After repository isolation:
  `npx vitest run packages/tests/shared/repository-modules.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared/webrtc-group-service.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-graph/group-graph-services.test.ts`.
- Type/runtime checks: `npx tsc -p packages/shared-server/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, and
  `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`.
- Repository isolation type checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit`.

Remaining gaps:

- The proof is focused/unit-level. The originally recommended two-real-browser/two-workspace integration scenario is
  still pending.
- Some public/internal APIs still accept only `groupId` and therefore remain ambiguous when one process intentionally
  works with multiple scopes at the same time. The repository now has a scoped lookup, but higher-level APIs should
  gradually move toward `GroupRef`/scope-aware signatures where the caller knows the scope.
- Event routing for group events depends on a cached group snapshot. If the group snapshot cache is cold, the event
  fails closed rather than broadcasting.

GroupId-only API audit:

- Repository/cache: the deprecated `findGroupStateSnapshotById(groupId)`,
  `findFirstGroupStateSnapshotIdSessionIdIsIn(sessionId)`, and `setGroupStateSnapshotById(groupId, snapshot)` helpers
  have been removed. New repository code uses `findGroupStateSnapshotByRef(ref)`,
  `findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId)`, and `setGroupStateSnapshot(snapshot)`.
- RTC group management: `WebRtcGroupManager` and `WebRtcGroupService` still model tracked groups around `groupId`. This
  is the first implementation target because it can merge RTC desired peers when the same room id exists in two scopes.
- Browser Rallar facade: `rooms.join(roomId, options)`, `rooms.leave(...)`, `messages.rtc.send({ roomId })`,
  `messages.ws.send({ roomId })`, and `rtc.waitForRoomLane(roomId, ...)` use room id as the public handle. They often
  carry `scope` in options, but cached/current-room helpers still resolve snapshots by id.
- Server WS routing and authorization: `CreateRallarMiddlewareOptions.findGroupSnapshotById`,
  `createWsServerTargetResolver`, `StateSyncRoutingOptions.findGroupSnapshotById`, and `createGroupRoomWsAuthorizer`
  still use `groupId`-only resolver callbacks.
- AL message targeting: resolved for multicast. Multicast targets now require scoped `groupRef` and no longer carry a
  target-level `groupId`; remaining scope ambiguity is in overlay/graph topology identity, not AL target identity.

Implementation order:

- First: update RTC group manager/service internals to key tracked groups by `GroupRef` when a snapshot/scope is
  available, keeping `groupId` wrappers for single-scope callers.
- Second: make repository API names less misleading by using scoped/readable alternatives and removing `ById` wrappers.
- Third: update server WS routing/authorizer options to accept scoped resolver forms while preserving current callbacks
  as compatibility fallbacks.
- Fourth: evaluate public Rallar room handles. Public `roomId` can remain ergonomic, but methods that can operate
  outside the current scope should accept or derive `GroupRef` consistently.

Implementation status for groupId-only audit:

- Started on 2026-05-18.
- Added focused proof that `WebRtcGroupManager` collapsed two snapshots with the same `groupId` from different
  workspaces into one tracked RTC group.
- `WebRtcGroupManager` now keys tracked groups by `GroupRef` when available, while string-based compatibility lookups
  still work when exactly one matching scoped group exists.
- `WebRtcGroupService` now accepts either `groupId` or `GroupRef` and reads the matching scoped cached snapshot when
  multiple same-id snapshots exist.
- Browser cache group-update handling now calls RTC manager `has/delete` with `snapshot.group`, avoiding accidental
  misses after scoped tracking.
- Added `setGroupStateSnapshot(snapshot)` and `findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId)` repository
  helpers so new code does not have to use misleading `ById` APIs.
- Updated server state-sync snapshot cache writers to use `setGroupStateSnapshot(snapshot)`.
- Added scoped server WS resolver callbacks: `resolveGroupRef(groupId, message)` and
  `findGroupSnapshotByRef(ref, message)` on `createWsServerTargetResolver`/middleware options.
- Added scoped room authorization callbacks: `resolveGroupRef(input)` and `findGroupSnapshotByRef(ref, input)` on
  `createGroupRoomWsAuthorizer`.
- Server-side `findGroupSnapshotById(groupId)` callbacks remain as compatibility fallbacks, but are ignored when a known
  scoped `GroupRef` exists and the fallback snapshot belongs to a different scope.
- Browser Rallar room sends and waits now accept scoped room refs: `messages.rtc.send({ roomRef })`,
  `messages.ws.send({ roomRef })`, `realtime.*({ roomRef })`, and `rtc.waitForRoomLane(roomRef, ...)`.
- Browser Rallar now preserves `currentRoomRef` after create/join and resolves current-room/cache lookups by `GroupRef`
  when available.
- AL multicast targets now carry mandatory scoped `groupRef` and no target-level `groupId`. Browser Rallar must resolve
  a scoped room ref before RTC multicast sends, server multicast recipient resolution reads the target ref directly, and
  room authorization can infer scope from the target without an external resolver callback.
- RTC overlay multicast context resolution now uses target `groupRef` to choose the room snapshot when same-id rooms
  exist in multiple scopes.

Verification for groupId-only audit:

- Up-front failing proof:
  `npx vitest run packages/tests/shared/webrtc-group-manager.test.ts --testNamePattern "same group id"` failed because
  `manager.size()` was `1` instead of `2`.
- Up-front failing proof:
  `npx vitest run packages/tests/shared-web/data-caches.test.ts --testNamePattern "deletes scoped RTC"` failed because
  browser cache handling called `has("shared-room")` instead of `has(snapshot.group)`.
- Up-front failing proof:
  `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts --testNamePattern "scoped group snapshot resolver"`
  routed a same-`groupId` room broadcast to workspace A instead of workspace B.
- Up-front failing proof: `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts` rejected a
  workspace B room message because the id-only fallback returned the workspace A snapshot.
- Up-front failing proof:
  `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts --testNamePattern "roomRef"` produced the
  workspace A cached `minSnapshotVersion` for a workspace B RTC send.
- Up-front failing proof:
  `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts --testNamePattern "roomRef scope for cached snapshotVersion on RTC"`
  showed RTC multicast targets carried only `groupId`, not `groupRef`.
- Up-front failing proof:
  `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts --testNamePattern "multicast targets using target groupRef"`
  routed a scoped multicast target to workspace A because recipient resolution ignored the target ref.
- Up-front failing proof:
  `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts --testNamePattern "target groupRef"`
  rejected a workspace B multicast message because authorization could not infer target scope.
- After implementation:
  `npx vitest run packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/webrtc-group-service.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared/repository-modules.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-graph/group-graph-services.test.ts`.
- After second pass:
  `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts`.
- After browser roomRef cleanup:
  `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts --testNamePattern "roomRef"`.
- After AL multicast target cleanup:
  `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/al-policy.test.ts`.
- After AL multicast target cleanup:
  `npx vitest run packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/api-v1/rallar-server-ws-facade.test.ts`.
- After mandatory target `groupRef` cleanup:
  `npx vitest run packages/tests/shared/al-policy.test.ts packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/al-durable-runtime.test.ts packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/shared/webrtc-rx-policy.test.ts packages/tests/shared-web/rallar-message-selectors.test.ts packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts`.
- Mandatory target `groupRef` type checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, `npx tsc -p packages/shared-server/tsconfig.json --noEmit`,
  and `npm --workspace apps/web run typecheck`.
- Type/runtime checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, `npx tsc -p packages/shared-server/tsconfig.json --noEmit`,
  and `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`.

Remaining groupId-only gaps:

- Browser Rallar still keeps `roomId` as the ergonomic default handle for single-scope use. Multi-scope callers should
  pass `roomRef`; future cleanup can add overloads for `rooms.join/leave` if those workflows need to target multiple
  scopes concurrently from one facade.
- AL overlay identity is still a string `overlayId` that commonly defaults to `groupId`. The multicast target is now
  scoped, but overlay cache keying remains a separate cleanup if one runtime must maintain multiple overlays with the
  same room id across scopes.
- Graph topology snapshots now carry mandatory `groupRef` instead of `graphId`, so graph updates can identify their room
  scope. The browser graph handler still updates overlay next hops by `graph.groupRef.groupId`, so overlay cache keying
  remains ambiguous until overlay identity is scoped too.

Overlay and graph identity follow-up:

- Treat browser overlay identity as a separate iteration from AL target scoping. `groupRef` now protects message
  authorization/routing and graph snapshots, but overlay topology lookup still depends on `overlayId`.
- Prove the bug first with same-`groupId` rooms in two workspaces in one browser runtime:
    - `createAndSetStarOverlays([workspaceA, workspaceB])` should not collapse or overwrite overlays.
    - `removeOverlayById(groupId)` should not delete another workspace's overlay.
    - a `GraphInfoSnapshot` with workspace B `groupRef` should update only workspace B's overlay next hops.
    - RTC multicast with a scoped `groupRef` should use the matching scoped overlay topology, not whatever same-id
      overlay was last written.
- Candidate fix: introduce a scoped overlay key derived from `GroupRef`, while retaining human-readable `groupId` and
  optional custom `overlayId` for diagnostics or explicitly shared topologies.
- Candidate API direction: add helpers such as `toOverlayRef(groupRef)` and `toOverlayKey(groupRef)`. Graph snapshots
  already carry `groupRef`; avoid bridging from graph state to room overlay topology through a raw string key.

## 2. Room Routing And Authorization Depend On Process-Local Snapshot Cache

Current behavior:

- `createWsServerTargetResolver(...)` still resolves room recipients synchronously from process-local group snapshot
  cache state.
- Dynamic inbound room authorization can now use scoped `groupRef` from multicast and room-broadcast targets and can
  hydrate from durable `GroupStateRepository` before fanout.
- After authorization hydrates the cache, normal Rallar-originated room broadcasts can route by scoped `groupRef`.
- Legacy/id-only room broadcasts and server-initiated messages that bypass dynamic-topic authorization still depend on
  process-local cache state or a `groupId` compatibility fallback.
- The durable source of truth is `runtime_state_store`; only the dynamic room authorization path currently has an async
  durable read-through point.

Risk:

- After process restart, a server can have open sockets but an empty group snapshot cache until a state mutation or
  explicit cache hydration happens.
- Server-initiated or id-only room-scoped WS messages can be rejected or have no recipients even when durable group
  membership exists.
- In a multi-server setup, cache lag can make authorization and routing inconsistent between nodes.

Recommended hardening:

- Hydrate client/group snapshot caches on server startup for active scopes, or lazily hydrate a group snapshot from
  `GroupStateRepository` on cache miss.
- Prefer a resolver/authorizer that can fall back to durable state when the cache is cold.
- Add real-server tests that restart the API process, reconnect clients, and send a room WS message before any new group
  mutation.

Implementation status:

- Started on 2026-05-19.
- Added an `ObservableLoanedRepository`-backed `GroupStateSnapshotReadThroughCache` for server-side group snapshots.
- The read-through cache loads snapshots from durable `GroupStateRepository.readSnapshot(ref)` on cache miss, writes
  successful loads back into the process-local observable latest snapshot repository, and reuses the loaned cache for
  TTL/coalescing behavior.
- Added an `ObservableLoanedRepository`-backed `ClientStateSnapshotReadThroughCache` for server-side client snapshots.
- The client read-through cache loads snapshots from durable `ClientStateRepository.readSnapshot(ref)` on cache miss,
  keeps internally loaded same-`principalId` snapshots isolated by application/workspace/principal ref, and writes
  successful loads back into the existing process-local client snapshot repository for current callers.
- `createGroupRoomWsAuthorizer(...)` now supports async scoped snapshot resolvers, so API-v1 can await durable
  read-through hydration before making a final room authorization decision.
- AL room-broadcast targets can now carry `groupRef`, matching multicast targets. Rallar WS room sends include that
  scoped reference when it can resolve one from `roomRef`, defaults, or cached room snapshots.
- Server WS authorization and target resolution now read scoped `groupRef` from both multicast targets and
  room-broadcast targets before falling back to `groupId`-only lookup.
- `RallarServerWsFacade` now passes room-broadcast target `groupRef` into the room authorization context, so normal
  Rallar-originated WS room messages can use the same scoped authorizer path as multicast messages.
- API-v1 now builds its room authorizer with `middleware.groupsRepository`, allowing inbound room/multicast WS messages
  to hydrate a cold or stale process-local group snapshot cache before authorization.
- When a message carries `minSnapshotVersion`, the read-through cache returns a warm cached snapshot only if it is new
  enough; otherwise it refreshes from durable state before authorization. This avoids returning an avoidable
  `not-yet-in-sync` decision when the durable store is already current.
- API-v1 middleware target resolution now reads through the shared snapshot read-through cache synchronously. The actual
  durable hydration remains on the async authorizer path; after authorization hydrates the observable latest cache, the
  existing synchronous target resolver can route the same message fanout from the hot cache.

How `GroupStateSnapshotReadThroughCache` is used:

- `apps/api-v1/src/middleware.ts` creates one `GroupStateSnapshotReadThroughCache` around the API-v1
  `GroupStateRepository`.
- Middleware target resolution calls `groupSnapshotReadThroughCache.findByRef(ref)`. This is intentionally synchronous
  and only checks the process-local observable latest snapshot repository and the read-through cache's already-loaded
  loaned value.
- `apps/api-v1/src/create-rallar-server.ts` builds the dynamic WS room authorizer with `middleware.groupsRepository`.
- `apps/api-v1/src/services/ws-topic-room-authorizer.ts` creates a second read-through cache for the authorizer and
  wires `findGroupSnapshotByRef` to `await readThroughCache.findOrLoadByRef(ref, { minSnapshotVersion })`.
- In the inbound dynamic WS topic path, `RallarServerWsFacade.authorizeDynamicTopic(...)` awaits the room authorizer
  before fanout. That gives the authorizer a safe async point where it can load or refresh the group snapshot from
  durable `GroupStateRepository.readSnapshot(ref)`.
- Successful durable loads emit an `ObservableLoanedRepository` change event. The read-through cache uses that callback
  to write the snapshot into the shared process-local `group-state-snapshots` observable latest repository.
- After authorization has warmed that shared snapshot repository, the existing synchronous `WsQueueBoxServerService`
  target resolver can route the same message fanout from the hot cache.
- `ClientStateSnapshotReadThroughCache` is available as the matching client-side server cache helper, but it is not yet
  wired into state-sync recipient routing because that path is still synchronous. It is ready for the same async-routing
  direction as group snapshots once state-sync routing can await durable reads.

Verification:

- Up-front failing proof:
  `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts --testNamePattern "cold group snapshot"`
  failed because the read-through cache did not exist.
- Up-front failing proof: `npx vitest run packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts`
  failed because the client read-through cache did not exist.
- Added proof that a cold process-local group snapshot cache is hydrated from durable `GroupStateRepository` before room
  authorization succeeds.
- Added proof that a stale process-local and loaned group snapshot is refreshed from durable state when
  `minSnapshotVersion` requires a newer version.
- Added proof that a cold process-local client snapshot cache is hydrated from durable `ClientStateRepository`.
- Added proof that a stale process-local and loaned client snapshot is refreshed from durable state when
  `minSnapshotVersion` requires a newer version.
- Added proof that the client read-through cache can keep same-principal snapshots isolated internally across
  workspaces.
- Added proof that Rallar WS room sends attach scoped room-broadcast `groupRef`, that server room authorization receives
  it, and that server target resolution prefers it over an ambiguous `groupId`.
- After implementation: `npx vitest run packages/tests/shared-server/ws-topic-room-authorizer.test.ts`.
- Related regression run:
  `npx vitest run packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared/observable-loaned-repository.test.ts`.
- Room-broadcast scoped target regression run:
  `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/api-v1/rallar-server-ws-facade.test.ts`.
- Combined related regression run:
  `npx vitest run packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared/observable-loaned-repository.test.ts packages/tests/api-v1/rallar-server-ws-facade.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`.
- Type/runtime checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and
  `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`.
- Additional type/runtime checks after room-broadcast scoped target work:
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit`,
  `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`, and `git diff --check`.

Iteration 2 evaluation:

- OK for now.
- The high-value correctness hole for normal inbound Rallar WS room messages is covered: browser-originated room
  broadcasts can now carry `groupRef`, the server authorizer can await durable read-through by scoped ref, and the
  synchronous target resolver can fan out from the warmed process-local cache.
- The remaining gaps are larger design work rather than blockers for iteration 2: startup-wide hydration, async
  lower-level WS target resolution for server-initiated messages that bypass dynamic-topic authorization, and real
  restart/reconnect browser tests.
- Those remaining gaps should stay documented as future work instead of expanding this iteration further.

Remaining gaps:

- The current hardening covers the inbound dynamic topic authorizer path, which is the path that can await durable state
  before fanout.
- Normal Rallar-originated WS room sends now provide a scoped `groupRef` on the AL room-broadcast target when available.
  That lets the authorizer and hot-cache target resolver select the correct workspace/application snapshot without
  relying on ambiguous `groupId`.
- `WsQueueBoxServerService` target resolution is still synchronous. `resolveGroupRecipients(...)` returns recipients
  immediately, and `enqueueOutboxIfAbsent(...)`, `sendToTargetsWithResult(...)`, and outbound planning all call
  synchronous recipient resolution.
- Server-initiated outbound messages that do not pass through `RallarServerWsFacade.authorizeDynamicTopic(...)` have no
  async authorization step where the server can `await GroupStateRepository.readSnapshot(ref)`. Those messages can only
  use already-hot process-local snapshots, or they fail closed with no recipients/no route.
- "Hot cache" means the process-local snapshot repository has already been populated by startup hydration, a recent
  local mutation, state sync, or a prior read-through authorizer load.
- A full lower-level fix would require an async routing design, for example allowing
  `WsServerTargetResolver.resolveGroupRecipients(...)` to return a promise and updating outbound planning, live sends,
  repair sends, and tests to await recipient resolution.
- Client state-sync routing has the same broad limitation. The client read-through cache can load a known
  `ClientPrincipalRef`, but current state-sync routing mainly consumes a synchronous list of already-cached client
  snapshots. Async routing or startup hydration is still needed before client read-through can fully repair cold-cache
  state-sync broadcasts.
- Startup-wide cache hydration and real restart/reconnect browser tests are still pending.

## 3. State Mutation Commit And WS Publish Are Not Atomic

Current behavior:

- Client state services mutate `runtime_state_store` inside `runtimeRepository.begin(...)` and return a
  `ClientStateWritten` result with the snapshot and optional event.
- Group state services return a `GroupStateWritten` result from the transaction.
- For HTTP mutations, `AppClientInboxService` and `AppGroupInboxService` publish the written result after the state
  write has committed.
- WebSocket lifecycle client cleanup still calls `ClientStateService` directly, but publication is delegated to
  `AppClientInboxService.publishClientStateWritten(...)` so publishing remains outside `client-state-service.ts`.
- WebSocket lifecycle group cleanup still calls `disconnectPresenceSessionsBySessionId(...)` directly; that path
  explicitly publishes the returned group written result because it does not pass through `AppGroupInboxService`.
- The publisher updates process-local cache and enqueues an AL message through
  `WsQueueBoxServerService.enqueueOutboxIfAbsent`.
- HTTP client and group mutation routes now enqueue durable app-inbox commands first and then wait for the app-inbox
  result.

Outbox terminology clarification:

- `WsQueueBoxServerService` does use a durable WS QueueBox outbox. Once `enqueueOutboxIfAbsent(...)` has successfully
  written the WS outbox entry, that queued WS message is durable.
- The missing outbox described in this section is a different boundary: a durable state-sync publication intent written
  in the same transaction as the domain state mutation.
- Today the domain mutation commits first, then publication code later attempts to write to the durable WS QueueBox
  outbox. If the process dies, throws, or loses connectivity after the domain commit but before the WS outbox write
  succeeds, there is no durable state-sync intent for a drainer to retry.
- A transactional state-sync outbox would persist "snapshot/event X must be published" together with the client/group
  mutation. A separate drainer would then convert that intent into the existing durable WS QueueBox outbox entry and
  retry until delivered.

Risk:

- If DB mutation succeeds but WS enqueue fails, the durable state changes but clients do not receive a live update.
- If cache update succeeds but enqueue fails, the local process cache can observe a value that was not broadcast.
- There is no obvious repair job that scans durable state changes and republishes missed state sync messages.
- A failed app-inbox publish can be recorded as a failed app-inbox result even though the durable domain mutation has
  already committed.
- Client mutations now have a service-level written-result ledger for request-keyed retries, but callers must still
  provide or derive a stable request key for replay semantics.

Recommended hardening:

- Introduce a transactional outbox for state sync events, ideally committed in the same database transaction as the
  state mutation.
- Make WS publication a consumer of that durable outbox.
- Track publish failures with metrics/logging that include application/workspace/group/principal ids.
- Add characterization tests that inject a failing publisher and assert the exact durable-state and cache outcomes.

Implementation status:

- Started on 2026-05-19; updated on 2026-05-20 after the app-inbox split; updated on 2026-05-21 after client
  written-result idempotency.
- Added characterization tests before changing runtime behavior.
- Added a shared `InboxQueueReader` app-inbox path for `APP_INBOX` AL messages. Missing payload-type handlers now fail
  the queue item instead of accidentally completing it.
- `RallarMiddleware` now owns an `InboxQueueReader`, wires an app-inbox engine task into `InboxOutboxEngine`, and uses
  the same `PSqlQueueBox` repository as the durable app inbox in API-v1.
- `RallarMiddlewareRuntime` now exposes mandatory `appGroupInboxService` and `appClientInboxService` instances.
- `AppInboxService` is now the shared base for app-inbox enqueue/wait/result lookup behavior.
- `AppGroupInboxService` maps HTTP group mutations to typed app-inbox payloads and executes `GroupStateService`.
- `AppClientInboxService` maps HTTP client mutations to typed app-inbox payloads, executes `ClientStateService`, and
  owns client state-sync publication for the returned `ClientStateWritten` result.
- API-v1 group and client mutation routes now enqueue typed `APP_INBOX` commands before executing the mutation. The HTTP
  response shape is preserved by draining the command immediately and returning the resulting snapshot.
- `ResourceInboxResultsRepository` and `PSqlResultsQueueBox` persist completed/failed app-inbox results separately from
  the queue entry, so waiting HTTP callers can read the durable result after the inbox worker has handled the command.
- `GroupStateService` mutating methods now use `request.requestId` as a service-level idempotency key when present. The
  result is checked and written inside the same `runtimeRepository.begin(...)` transaction as the group mutation.
- Repeated group commands with the same `requestId` return the stored snapshot/event result instead of applying the
  mutation again. This avoids duplicate group versions/events and lets `AppGroupInboxService` publish the stored event
  for replays that actually re-enter the handler.
- `createGroup` also stores an error result when the same group is created with a different idempotency key, so
  duplicate creates can return a stable app-level conflict result.
- `AppGroupInboxService` owns group state-sync publication for HTTP group mutations. It folds the `GroupStateWritten`
  result, publishes snapshot/event only when the result contains an event, and skips publish for left/error or semantic
  no-op results.
- `ClientStateService` mutating methods now return `ClientStateWritten` values instead of raw `ClientSnapshot` values.
  The service no longer calls `StateSyncPublisher` internally.
- `ClientStateRepository` now has `addIdempotentClientStateWritten(...)` and `findIdempotentClientStateWritten(...)`,
  mirroring the group repository pattern.
- `ClientStateService` mutating methods use `request.requestId` as a service-level idempotency key when present. The
  result is checked and written inside the same `runtimeRepository.begin(...)` transaction as the client mutation.
- Authorised WS client register/disconnect operations derive stable idempotency keys from the websocket session id, so
  lifecycle retries can replay the original `ClientStateWritten` result.
- `AppClientInboxService` folds the `ClientStateWritten` result, publishes snapshot/event only when the result contains
  an event, and skips publish for semantic no-op results.
- Direct WS lifecycle client registration/disconnect calls publish their returned `ClientStateWritten` through
  `AppClientInboxService.publishClientStateWritten(...)`, keeping publication out of `client-state-service.ts` while
  preserving lifecycle state-sync behavior.
- Current behavior is now documented in tests:
    - group mutation state and event rows are committed before snapshot enqueue failure is returned by
      `AppGroupInboxService`;
    - the process-local group snapshot cache can already be updated when snapshot enqueue fails;
    - client mutation state and event rows are committed before snapshot enqueue failure is returned by
      `AppClientInboxService`;
    - group snapshot enqueue can succeed before a later group event enqueue failure is returned, leaving snapshot/event
      publication split;
    - group app-inbox processes create/update/member/presence commands and publishes stored idempotent mutation results
      on handler replay;
    - client app-inbox processes principal/instance/session commands, publishes returned written results, stores
      readable success/failure results, and publishes stored idempotent mutation results on handler replay.
- No transactional state-sync outbox fix has been applied yet. The current runtime change is a durable command-inbox
  layer plus group/client command idempotency and app-inbox-owned publication; it is not a state-sync publication intent
  committed atomically with the domain mutation.

Verification:

- Characterization run:
  `npx vitest run packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts`.
- Group command idempotency run: `npx vitest run packages/tests/shared-server/group-state-service-idempotency.test.ts`.
- Client command idempotency run:
  `npx vitest run packages/tests/shared-server/client-state-service-idempotency.test.ts`.
- App-inbox base proof run: `npx vitest run packages/tests/shared/inbox-queue-reader.test.ts`.
- Group app-inbox proof run: `npx vitest run packages/tests/shared-server/app-inbox-service.test.ts`.
- Client app-inbox proof run: `npx vitest run packages/tests/shared-server/app-client-inbox-service.test.ts`.
- Middleware wiring proof run: `npx vitest run packages/tests/shared-server/rallar-middleware.test.ts`.
- Related regression run:
  `npx vitest run packages/tests/shared-server/group-state-service-idempotency.test.ts packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts packages/tests/shared-server/ws-topic-room-authorizer.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/api-v1/client-and-group-state-repositories.test.ts`.
- Latest shared-server regression run: `npx vitest run packages/tests/shared-server`.
- Type/runtime checks: `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and
  `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`.
- API-v1 Deno regression run:
  `deno test --allow-env --allow-read --config apps/api-v1/deno.json apps/api-v1/test/rallar-server.test.ts apps/api-v1/test/services/client-state-service.test.ts apps/api-v1/test/services/group-state-service.test.ts`.

Remaining iteration 3 issues:

- The original atomicity issue remains: state mutation commit and WS state-sync publication are still separate
  operations.
- There is no durable state-sync outbox table/namespace that stores snapshot/event publication intents in the same
  transaction as the domain mutation.
- There is no state-sync outbox drainer that can retry missed snapshot/event publication independently of the original
  HTTP request.
- `AppGroupInboxService` can publish a stored `GroupStateWritten` result if a command re-enters the handler, but
  app-inbox failed results are currently stored in `resource_inbox_results`. A retry using the same app-inbox queue key
  can read the failed result instead of forcing a fresh publish attempt until the result expires or a different queue
  key is used.
- Group service idempotency does not validate a command fingerprint. Reusing the same `requestId` with a different
  payload replays the stored result rather than raising an idempotency conflict. That is idempotent, but it can hide
  caller bugs.
- Direct `ClientStateService` callers must explicitly publish the returned `ClientStateWritten` result through
  `AppClientInboxService` or another publisher. Calling the service alone now mutates durable state without emitting
  state sync.
- WebSocket lifecycle client cleanup still calls `disconnectAuthorisedWsClientSession(...)` directly for the domain
  mutation; it uses `AppClientInboxService.publishClientStateWritten(...)` for publication, but it does not use the
  durable app-inbox command path.
- The app-inbox command layer protects HTTP command durability, but it does not guarantee eventual WS delivery of the
  resulting state-sync snapshot/event.
- Real server/browser integration tests for API process death after app-inbox enqueue and before command drain are still
  pending.

Next implementation direction:

- Decide the durable state-sync outbox boundary before changing publication behavior. The clean target is to persist
  state-sync publication intents in the same `runtime_state_store` transaction as the client/group mutation.
- Add a publisher/drainer that converts durable state-sync outbox intents into WS QueueBox messages and marks them
  delivered or retryable.
- Keep the existing `StateSyncPublisher` API as the live WS enqueue adapter, or split it into a mutation-time durable
  writer and an async WS delivery worker.
- Add tests for retry after enqueue failure, idempotent drain, and no duplicate snapshot/event delivery for the same
  mutation outbox id.
- Decide whether group/client idempotency should reject same-`requestId`/different-payload calls via a command
  fingerprint, or whether current replay semantics are the intended contract.

## 4. State Events Are Broadcast But Not Modeled In Browser High-Level State

Current behavior:

- Server publishes `client-state.event` and `group-state.event` over WS.
- Browser `data-caches.ts` ignores those event topic payloads.
- High-level `rallar.rooms.onChange(...)` and `rallar.people.onChange(...)` are snapshot-cache driven.
- Lower-level `rallar.messages.ws.onMessage(...)` can observe raw WS messages if callers register for them.

Risk:

- Applications may assume they are subscribing to all changes, but the high-level state API only exposes snapshot
  results.
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
- QueueBox PubSub publishes serialized entries through Postgres LISTEN/NOTIFY. Self messages are ignored by publisher
  id.

Risk:

- The table name obscures that it is now a general queue table.
- Inbox and outbox share the same unique key shape and physical indexes, which may become a contention point.
- Postgres NOTIFY payloads have a small payload limit compared with the dynamic topic payload limit, so larger AL
  messages can fail pubsub propagation even if QueueBox persistence succeeds.

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
- Logout deletes auth session, and browser reconnect prevention exists client-side, but the server socket lifecycle is
  still the cleanup trigger for live presence.

Risk:

- Abrupt network loss or process failure can leave presence active until expiry.
- If close handling fails after socket close, durable presence can remain active until TTL.

Recommended hardening:

- Keep TTLs short enough for acceptable stale presence.
- Add server-side periodic reconciliation for expired presence sessions and snapshot publication.
- Add tests for abrupt socket termination and server restart.

## Suggested First Proofs

1. Multi-workspace isolation test: prove whether state snapshots from workspace A reach a browser connected to workspace
   B.
2. Cold-cache room routing test: restart server, reconnect two room members, and send a room WS message before any state
   mutation.
3. Publish failure characterization: inject a failing `StateSyncPublisher` and document committed DB state, process
   cache state, and enqueue result.
4. App-data concurrent write test: run two store instances against the same Postgres row and characterize
   `compareAndSet` and `updateOrCreate`.
5. PubSub payload limit test: publish a dynamic message near and above the NOTIFY payload limit.
