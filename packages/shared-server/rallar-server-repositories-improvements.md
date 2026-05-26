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
- WebSocket lifecycle client connect/disconnect now enqueue typed app-inbox commands through `AppClientInboxService`.
- WebSocket lifecycle group cleanup now enqueues a typed app-inbox command through `AppGroupInboxService`, which owns
  publication for the returned group written results.
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
- Retryable app-inbox publish failures now leave the command in QueueBox retry state instead of writing a failed
  app-inbox result, but the durable domain mutation can still commit before the WS enqueue failure is observed.
- Non-retryable app-level validation failures are recorded as failed app-inbox results so waiting HTTP callers can get a
  terminal application error.
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
  written-result idempotency, WS lifecycle app-inbox routing, browser HTTP workflow request IDs, facade retry options,
  and auth-session-independent WS close cleanup.
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
- Browser Rallar state workflows now generate stable per-step `requestId` values before entering `Command` retry
  handling. A retried create/join/leave/heartbeat HTTP command reuses the same body `requestId`, so the server app-inbox
  and service-level idempotency ledgers can replay the same command instead of treating retry attempts as new mutations.
- Browser Rallar operation options and defaults now support `maxAttempts` and `shouldRetry`. The default retry classifier
  retries network/unknown errors, HTTP `429`, and HTTP `5xx`, but does not retry HTTP `4xx` validation/auth/conflict
  failures.
- Browser HTTP errors now carry structured `status`, `method`, `path`, and `bodyText` fields, so retry policy does not
  need to parse error text.
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
- Authorised WS client disconnect now falls back to durable client-session state when the auth-session row has already
  been removed, covering the common browser logout order where WS close cleanup races with `/api/auth/logout`.
- `AppClientInboxService` folds the `ClientStateWritten` result, publishes snapshot/event only when the result contains
  an event, and skips publish for semantic no-op results.
- `AppClientInboxService` now also maps authorised WS connect/disconnect lifecycle commands to typed app-inbox payloads.
  The connect payload stores the auth session fields needed for state mutation without persisting the access token in the
  app-inbox resource entry.
- `GroupStateService.disconnectPresenceSessionsBySessionIdWritten(...)` returns the written disconnect results for all
  active presence sessions owned by a WS session without publishing directly.
- `AppGroupInboxService` now maps WS-session presence cleanup to a typed app-inbox payload and publishes each returned
  `GroupStateWritten` result.
- `AppInboxService` now treats only `NonRetryableException` as a terminal failed app-inbox result. Other handler errors
  rethrow into QueueBox release handling, which keeps the command retryable until the QueueBox retry policy is
  exhausted.
- API-v1 WS upgrade and WS-close lifecycle callbacks now route authorised client connect/disconnect and group presence
  cleanup through the app-inbox services instead of calling the state services directly.
- Current behavior is now documented in tests:
    - group mutation state and event rows are committed before snapshot enqueue failure is returned by
      `AppGroupInboxService`, with the app-inbox command left retryable and no failed result row written;
    - the process-local group snapshot cache can already be updated when snapshot enqueue fails;
    - client mutation state and event rows are committed before snapshot enqueue failure is returned by
      `AppClientInboxService`, with the app-inbox command left retryable and no failed result row written;
    - group snapshot enqueue can succeed before a later group event enqueue failure leaves the app-inbox command
      retryable, leaving snapshot/event publication split until retry;
    - group app-inbox processes create/update/member/presence commands, WS-session presence cleanup, and publishes stored
      idempotent mutation results on handler replay;
    - client app-inbox processes principal/instance/session commands, authorised WS connect/disconnect commands,
      publishes returned written results, stores readable success/failure results, and publishes stored idempotent
      mutation results on handler replay;
    - browser HTTP workflows reuse request IDs across `Command` retries for create-and-join, join, leave, and heartbeat
      mutation steps;
    - browser operation retry options are forwarded to state workflows with retryable/non-retryable HTTP status
      classification;
    - browser room mutation responses hydrate local state caches immediately, without waiting for WS state-sync echo;
    - authorised WS disconnect app-inbox handling can still clean up client session state after auth-session deletion;
    - real-browser/full-stack Playwright coverage now proves browser `Rallar.rooms.create` retries injected transient
      `503` and `429` failures with stable per-step `requestId` values before succeeding against API-v1;
    - real-browser/full-stack Playwright coverage now proves WS close cleanup records the disconnected client state
      when `/api/auth/logout` deletes the auth session before the browser socket is closed.
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
- Focused shared-server regression run:
  `npx vitest run packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/group-state-service-idempotency.test.ts packages/tests/shared-server/state-sync-publish-failure-characterization.test.ts`.
- Browser HTTP workflow idempotency proof run:
  `npx vitest run packages/tests/shared-web/api-workflows.test.ts`.
- Browser facade retry/cache proof run:
  `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts`.
- Real-browser/full-stack retry and logout/WS-close proof run:
  `RALLAR_BLACK_BOX_FULL_STACK=1 VITE_RALLAR_API_BASE_URL=http://localhost:8080 npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts`.
- Full shared-server regression run remains blocked by an unrelated syntax error in
  `packages/tests/shared-server/rallar-middleware.test.ts`.
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
- `AppGroupInboxService` and `AppClientInboxService` can publish stored written results if a command re-enters the
  handler after a retryable publication failure, but there is still no separate durable publication intent that can be
  drained independently of the original app-inbox command.
- Deferred by decision: group/client service idempotency does not validate a command fingerprint. Reusing the same
  `requestId` with a different payload replays the stored result rather than raising an idempotency conflict. That is
  idempotent, but it can hide caller bugs.
- Direct `api-integration.ts` callers can still omit `requestId` and rely on server-generated IDs. The Rallar facade
  workflows now generate stable IDs, which covers normal browser facade usage; lower-level direct callers remain
  responsible for providing request IDs if they need retry idempotency.
- Real server/browser retry proof now exists for browser-injected transient `503`/`429` failures on the normal Rallar
  facade room-create path. A server-side fault-injection endpoint is still not present, so this proves browser retry and
  real API success after retry, not API process fault injection.
- Future direct `ClientStateService` or `GroupStateService` callers must either go through the app-inbox service or
  explicitly publish returned written results. Calling the state services alone mutates durable state without emitting
  state sync.
- App-inbox enqueue for WS close lifecycle still depends on the process observing the WS close callback. If the process
  dies before that callback runs and enqueues the cleanup command, this iteration does not provide a recovery mechanism.
- The app-inbox command layer protects HTTP command durability, but it does not guarantee eventual WS delivery of the
  resulting state-sync snapshot/event.
- Real server/browser integration tests for API process death after app-inbox enqueue and before command drain are still
  pending.

Next implementation direction:

- Before the deferred transactional outbox work, the remaining real-server/browser proof should focus on API process
  death or server-side fault injection after app-inbox enqueue. Browser `maxAttempts` retry/request-id stability and
  logout/WS-close cleanup now have full-stack Playwright coverage.
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

Status: implemented as scoped live callbacks in the browser facade.

Original behavior:

- Server publishes `client-state.event` and `group-state.event` over WS.
- Browser `data-caches.ts` ignores those event topic payloads.
- High-level `rallar.rooms.onChange(...)` and `rallar.people.onChange(...)` are snapshot-cache driven.
- Lower-level `rallar.messages.ws.onMessage(...)` can observe raw WS messages if callers register for them.

Proof-first characterization added:

- `packages/tests/shared-web/data-caches.test.ts` proves that `client-state.event` and `group-state.event` messages do
  not mutate the snapshot repositories, do not notify high-level snapshot listeners, and do not drive RTC group manager
  membership updates.
- This preserves the intended split: snapshots remain authoritative state, while events are live mutation/audit signals.

Implemented browser facade behavior:

- `rallar.rooms.onEvent(listener, options?)` subscribes to `group-state.event`.
- `rallar.people.onEvent(listener, options?)` subscribes to `client-state.event`.
- Both APIs use the existing WS any-message callback internally and only register it when needed.
- Event subscriptions support scope filtering, entity filtering, and event-type filtering:
  - rooms: `scope`, `roomId`, `roomRef`, `eventTypes`
  - people: `scope`, `principalId`, `eventTypes`
- Event callbacks receive both the decoded event and the `RallarMessage<TEvent>` transport wrapper.
- Duplicate event delivery is suppressed by a bounded in-memory dedupe set keyed by scope, entity id, and `eventId`.
- `rooms.onChange(...)` and `people.onChange(...)` remain snapshot-cache subscriptions; event messages do not trigger
  those listeners.

Known boundaries:

- The new APIs are live subscriptions, not event caches. They do not replay old events to late subscribers.
- They do not provide durable exactly-once delivery. WS reconnect/replay behavior still depends on the underlying
  QueueBox delivery path.
- Ordering is whatever order the browser receives from WS; no additional ordering buffer was added.

Verification:

- `npx vitest run packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`

Resolved risk:

- Applications may assume they are subscribing to all changes, but the high-level state API only exposes snapshot
  results. They now have explicit event APIs for event-specific details, while snapshot APIs keep snapshot semantics.

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

Status: 9.1 characterization, 9.2 minimal event-history reads, 9.3 versioned event identity, 9.4 cursor page
reads, 9.5 explicit browser replay convenience, and 9.6 real browser/server proof implemented and locally verified.
Do not implement a full replay protocol until a real application workflow requires durable event processing.

Current behavior:

- State mutations append durable events.
- Browser state caches are hydrated and updated primarily from snapshots.
- Missed WS messages can be corrected by REST refresh, but there is no explicit client cursor/replay protocol.
- Group and client event routes already exist for per-entity historical reads:
  - `/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events`
  - `/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events`
- Browser Rallar now has live event callbacks through `rooms.onEvent(...)` and `people.onEvent(...)`, but these are
  live subscriptions only. They intentionally do not replay old events to late subscribers.

Risk:

- Clients can miss transient event details while still converging to latest snapshot.
- There is no built-in "subscribe from revision N" or "replay events since timestamp" path in the browser facade.
- Existing event ordering is not a strong replay contract. Events are listed by `occurredAtEpochMs`, but equal
  timestamps and cross-process clock skew can make replay ordering ambiguous.
- Events do not currently carry an aggregate `snapshotVersion`, so a client cannot directly connect "I have snapshot
  version N" with "replay the events after N".

Recommended hardening:

- Treat snapshots as convergence and events as optional audit unless a replay contract is added.
- Prefer a small browser facade wrapper around existing event-list routes before adding automatic replay behavior.
- Add event cursor APIs only if applications need guaranteed event processing.
- Include profile/presence/roster versions in client-side stale update rejection tests.

Proof-first implementation plan:

1. Characterize current behavior before adding replay semantics.
   - Prove a browser can miss `rooms.onEvent(...)` or `people.onEvent(...)` messages while disconnected.
   - Prove `rooms.refresh(...)` and `people.refresh(...)` still converge to the latest snapshot after missed WS events.
   - Prove the existing REST event routes can recover historical events manually.
   - Prove the current event ordering limitations around equal `occurredAtEpochMs` values.

   9.1 evidence added:

   - `packages/tests/shared-web/rallar-operation-options.test.ts` proves live state-event callbacks are not replayed
     after disconnect/reconnect, while new live events still flow after reconnect.
   - `packages/tests/shared-web/rallar-operation-options.test.ts` proves `rooms.refresh(...)` and `people.refresh(...)`
     use snapshot refresh/hydration as the convergence path and do not synthesize missed event callbacks.
   - `packages/tests/shared-web/data-caches.test.ts` proves ignored/missed state-event details do not mutate snapshot
     caches, while later snapshot hydration updates the client/group snapshot repositories.
   - `packages/tests/shared-server/state-sync-event-replay-characterization.test.ts` proves durable group/client events
     can be listed after mutations through the same service path that the current REST event routes delegate to.
   - `packages/tests/shared-server/state-sync-event-replay-characterization.test.ts` documents the current equal
     timestamp ordering limitation: events do not carry `snapshotVersion`, so same-timestamp ordering falls back to
     persisted event-key ordering rather than an explicit aggregate-version replay contract.

   Verification:

   ```sh
   npx vitest run packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts
   npx vitest run packages/tests/shared-server/state-sync-event-replay-characterization.test.ts
   ```

   Remaining 9.1 caveat:

   - The historical event read proof started at the service/repository level. 9.2 adds shared route filtering tests and
     route wiring, but there is still no Hono-wrapper test with mocked state services because the current route modules
     resolve concrete services directly.

2. Add minimal browser event-read APIs, not automatic replay.
   - Candidate APIs:
     - `rallar.rooms.listEvents(roomId | roomRef, options?)`
     - `rallar.people.listEvents(principalId, options?)`
   - Options should include `scope`, `eventTypes`, and `limit`.
   - A later pass can add `after`/cursor options once the server route has a stable cursor contract.

   Proposed first API shape:

   ```ts
   rallar.rooms.listEvents(
       input: string | {
           roomId?: string;
           roomRef?: GroupRef;
           scope?: StateScope;
           eventTypes?: readonly GroupEventType[];
           limit?: number;
           signal?: AbortSignal;
           timeoutMs?: number;
           maxAttempts?: number;
       },
   ): Promise<readonly GroupEvent[]>;

   rallar.people.listEvents(
       principalId: string,
       options?: {
           scope?: StateScope;
           eventTypes?: readonly ClientEventType[];
           limit?: number;
           signal?: AbortSignal;
           timeoutMs?: number;
           maxAttempts?: number;
       },
   ): Promise<readonly ClientEvent[]>;
   ```

   Room event scope resolution should be explicit and predictable:

   - `roomRef` scope first.
   - Explicit `options.scope` second.
   - Facade defaults third.
   - API default scope last.

   Room id resolution should be:

   - `roomRef.groupId` first.
   - Explicit `roomId` second.
   - String input third.

   Do not silently use current/default room in the first pass. Historical event reads should remain explicit until real
   usage proves a convenience default is helpful.

   Implementation shape for this step:

   - Add `listStateGroupEvents(groupId, scope, options?)` and `listStateClientEvents(principalId, scope, options?)` to
     the browser API integration layer.
   - Use the existing server routes:
     - `/groups/:groupId/events`
     - `/clients/:principalId/events`
   - Add query params for `eventType` and `limit`.
   - Add server-side route filtering without changing repositories initially:
     - call existing `listEvents(...)`
     - filter by event type
     - apply bounded `limit`
     - return events in chronological order
   - Do not call `connect()`, hydrate caches, register WS callbacks, or mutate snapshot repositories from these facade
     methods. They should be read-only REST commands using the existing timeout/retry policy path.

   Tests for this step:

   - Server route characterization:
     - existing `/events` returns all events in chronological order
     - `eventType` filters correctly
     - `limit` returns the latest N events while preserving chronological order in the response
   - Browser REST helper tests:
     - encodes `groupId` and `principalId`
     - sends the scope path correctly
     - serializes repeated `eventType`
     - serializes `limit`
   - Rallar facade tests:
     - `rooms.listEvents(roomRef)` uses `roomRef` scope
     - `rooms.listEvents({ roomId, scope })` uses explicit scope
     - `people.listEvents(principalId, options)` returns client events
     - calls do not connect or mutate snapshot caches
     - `signal`, `timeoutMs`, and retry options flow through the existing command policy

   9.2 implemented:

   - Added `filterStateEventsForList(...)` and `readStateEventListQuery(...)` in shared-server for server route
     filtering.
   - Group and client event routes now accept repeated `eventType` query params and `limit`.
   - `limit` returns the latest N matching events while preserving chronological order in the response.
   - Event-list routes default to `100` events and clamp requested limits to `500`, so a caller cannot ask the HTTP
     response path to return the full event history accidentally. This bounds response size, but the current repository
     call still reads the full per-entity event list before filtering; repository-level range pagination remains the
     stronger future fix.
   - Added browser REST helpers:
     - `listStateGroupEvents(groupId, scope, options?)`
     - `listStateClientEvents(principalId, scope, options?)`
   - Added browser facade APIs:
     - `rallar.rooms.listEvents(input)`
     - `rallar.people.listEvents(principalId, options?)`
   - These methods are explicit read-only REST calls. They do not call `connect()`, register WS callbacks, hydrate
     caches, or replay events through `onEvent(...)`.
   - The browser facade methods are wrapped in `runRallarCommand(...)`, so callers can use existing `signal`,
     `timeoutMs`, `maxAttempts`, and retry classification options.
   - Added `/api/state/*` Hono resilience middleware:
     - General state requests are rate-limited per authenticated `x-client-id`.
     - Event-list requests use a stricter rate-limit namespace.
     - A state-route scoped circuit breaker counts 5xx responses and thrown errors as failures, returns `503` while
       open, and ignores client-side 4xx responses.

   9.2 verification:

   ```sh
   npx vitest run packages/tests/shared-server/state-event-listing.test.ts packages/tests/shared-server/state-sync-event-replay-characterization.test.ts
   npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts
   cd apps/api-v1 && deno test --allow-env --allow-read --config deno.json test/services/state-api-resilience-middleware.test.ts
   npx tsc -p packages/shared-web/tsconfig.json --noEmit
   npx tsc -p packages/shared-server/tsconfig.json --noEmit
   cd apps/api-v1 && deno check src/main.ts
   ```

3. Strengthen event identity for replay.
   - Add an aggregate version to events, preferably `snapshotVersion`, populated from the written group/client snapshot.
   - Use `(snapshotVersion, occurredAtEpochMs, eventId)` as the stable replay order when version is available.
   - Keep event consumers idempotent by `eventId`; replay should be treated as at-least-once delivery.

   9.3 implemented:

   - `GroupEvent` and `ClientEvent` now carry mandatory `snapshotVersion`.
   - Group events are populated from the written `Group.snapshotVersion`; client events are populated from the written
     `ClientPrincipal.snapshotVersion`.
   - Group/client event repositories now list events in replay order:
     `(snapshotVersion, occurredAtEpochMs, eventId)`.
   - State-sync routing and browser event payload guards require numeric `snapshotVersion`, so incomplete live event
     payloads are ignored instead of entering callbacks as valid events.
   - OpenAPI `GroupEvent` and `ClientEvent` schemas now require `snapshotVersion`. The existing `Group` and
     `ClientPrincipal` schemas were also aligned with their mandatory aggregate `snapshotVersion` fields.

   9.3 verification:

   ```sh
   npx vitest run packages/tests/shared-server/state-sync-event-replay-characterization.test.ts packages/tests/shared-server/state-event-listing.test.ts packages/tests/api-v1/client-and-group-state-repositories.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts
   cd apps/api-v1 && deno test --allow-env --allow-read --config deno.json test/services/group-state-service.test.ts test/services/client-state-service.test.ts test/services/state-api-resilience-middleware.test.ts
   npx tsc -p packages/shared/tsconfig.json --noEmit
   npx tsc -p packages/shared-server/tsconfig.json --noEmit
   npx tsc -p packages/shared-web/tsconfig.json --noEmit
   cd apps/api-v1 && deno check src/main.ts test/services/group-state-service.test.ts test/services/client-state-service.test.ts test/services/state-api-resilience-middleware.test.ts
   ```

4. Add cursor-capable server event APIs only after the read API proves useful.
   - Return an envelope instead of a bare array:
     - `events`
     - `nextCursor`
     - `hasMore`
   - Candidate filters:
     - `afterSnapshotVersion`
     - `afterOccurredAtEpochMs`
     - `afterEventId`
     - `eventType`
     - `limit`
   - Start per group/principal. Avoid global workspace event replay until a concrete use case needs it.

   9.4 implemented:

   - Kept the existing `/events` array routes and Rallar `listEvents(...)` methods as latest-N convenience reads.
   - Added cursor page routes with forward replay semantics:
     - `/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/events/page`
     - `/api/state/apps/:applicationId/workspaces/:workspaceId/clients/:principalId/events/page`
   - Added cursor query params:
     - `afterSnapshotVersion`
     - `afterOccurredAtEpochMs`
     - `afterEventId`
   - Page responses return `{ events, nextCursor, hasMore }`, where `nextCursor` is derived from the last returned
     event.
   - Added browser REST helpers:
     - `listStateGroupEventPage(...)`
     - `listStateClientEventPage(...)`
   - Added Rallar facade methods:
     - `rallar.rooms.listEventPage(...)`
     - `rallar.people.listEventPage(...)`
   - OpenAPI now documents the page endpoints, cursor query params, `StateEventCursor`, `GroupEventPage`, and
     `ClientEventPage`.

   9.4 verification:

   ```sh
   npx vitest run packages/tests/shared-server/state-event-listing.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-web/rallar-operation-options.test.ts
   npx tsc -p packages/shared/tsconfig.json --noEmit
   npx tsc -p packages/shared-server/tsconfig.json --noEmit
   npx tsc -p packages/shared-web/tsconfig.json --noEmit
   cd apps/api-v1 && deno check src/main.ts src/routes/client-state-routes.ts src/routes/group-state-routes.ts
   ```

5. Add optional Rallar replay convenience.
   - Candidate APIs:
     - `rallar.rooms.replayEvents(...)`
     - `rallar.people.replayEvents(...)`
   - Do not make `onEvent(...)` silently replay old events unless the method name or options make that explicit.
   - Deduplicate overlap between live WS events and replayed REST events by `eventId`.

   9.5 implemented:

   - Added explicit replay facade methods:
     - `rallar.rooms.replayEvents(input, listener?)`
     - `rallar.people.replayEvents(principalId, options?, listener?)`
   - Replay uses the 9.4 cursor page APIs and returns:
     - `events`
     - `nextCursor`
     - `hasMore`
     - `pageCount`
     - `replayedCount`
     - `duplicateCount`
   - Replay dispatch is explicit:
     - If a listener is passed, replayed events are delivered to that listener.
     - If no listener is passed, replayed events are delivered to currently registered `onEvent(...)` subscriptions that
       match the event.
     - If neither applies, events are fetched but not marked as seen.
   - Replay shares the same dedupe sets as live WS event callbacks:
     - live-before-replay skips duplicate replay events
     - replay-before-live skips duplicate live WS callbacks
   - Replay is page bounded. The default is one page, with optional `maxPages`, clamped to avoid accidental large
     browser-side replay loops.
   - Replay callback messages use `message.transport === 'replay'`, making replayed callbacks distinguishable from live
     WS events.

   9.5 verification:

   ```sh
   npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts
   npx tsc -p packages/shared/tsconfig.json --noEmit
   npx tsc -p packages/shared-web/tsconfig.json --noEmit
   ```

6. Prove with a real browser/server scenario.
   - Browser A subscribes to events and records a cursor.
   - Browser A disconnects or loses WS.
   - Browser B mutates group/client state.
   - Browser A reconnects, refreshes snapshots, then lists/replays missed events from its cursor.
   - Verify snapshot convergence, recovered event details, and no duplicate event processing when live and replay
     overlap.

   9.6 implemented:

   - Added a gated full-stack Playwright proof in
     `tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts`.
   - The scenario uses two real browser contexts against the real API and SPA:
     - Browser A creates a room, records the `group-created` cursor, and subscribes to room member events.
     - Browser B joins while Browser A is connected, proving the live WS callback path.
     - Browser A disconnects, Browser B leaves, then Browser A reconnects.
     - Browser A refreshes room snapshots and explicitly replays events from the recorded cursor.
   - The assertions prove snapshot convergence, recovered missed `member-left` details, and live/replay overlap
     dedupe for the already-seen `member-joined` event.
   - Coverage was expanded with two additional direct Browser Rallar facade tests:
     - People/client event replay plus WS lifecycle/status around disconnect and reconnect.
     - RTC `waitForRoomLane(..., { connect: true })` plus direct `realtime.sendJson(...)` delivery between two real
       browser contexts.
   - The expanded tests register unique throwaway users through the real SPA login form when needed, so full-file runs do
     not depend on the login rate-limit window for the shared `alice`/`bob` test users.
   - This test is intentionally gated by `RALLAR_BLACK_BOX_FULL_STACK=1` because it needs the full API, SPA, and
     browser stack.

   9.6 verification:

   ```sh
   npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts -g "recovers missed" --list
   RALLAR_BLACK_BOX_FULL_STACK=1 npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts -g "recovers missed room events"
   RALLAR_BLACK_BOX_FULL_STACK=1 npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-browser-rallar-resilience.spec.ts
   ```

Pros:

- Recovers mutation details after sleep, reload, reconnect, mobile backgrounding, or transient WS loss.
- Supports activity feeds, audit views, notifications, moderation logs, and debugging.
- If events carry `snapshotVersion`, replay can be aligned with snapshot convergence.
- Gives applications a principled way to answer "what happened?" instead of only "what is true now?".

Cons:

- Adds cursor, ordering, dedupe, pagination, retention, and authorization complexity.
- Can encourage applications to treat events as primary state, even though snapshots should remain the convergence
  source.
- Presence and heartbeat events can be noisy and may require filtering or retention limits.
- Exactly-once delivery is not realistic; the practical contract is at-least-once replay with idempotent consumers.
- Event retention is a product and privacy decision if payloads include user metadata or audit details.

Real application need:

- Most simple realtime apps do not need durable event replay. If the UI only needs current room membership, online
  users, and RTC routing, snapshots plus live event callbacks are enough.
- Applications that are more likely to need this:
  - audit-heavy admin tools
  - moderation systems
  - notification centers
  - activity feeds
  - workflow/task systems where every transition matters
  - turn-based or replayable games
  - collaborative apps that need operation history
  - mobile/offline-first apps where clients often reconnect after missing WS messages

Recommended next step:

- Keep replay explicit in the facade and avoid automatic durable replay subscriptions until a real feature requires
  guaranteed event processing.
- If a product workflow starts depending on replay, add retention policy tests and repository-level range pagination
  before widening the API beyond per-group/per-principal reads.

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

Implementation status:

- Implemented logical-vs-physical session expiry for client and group session repositories. Session rows now remain in
  runtime state for a purge grace period after their logical `expiresAtEpochMs`, while snapshots still exclude logically
  expired sessions.
- Added client expiry reconciliation through `ClientStateService.expireExpiredSessions(...)` and
  `AppClientInboxService.processExpiredSessions(...)`. Expired client sessions are marked `status: 'expired'`, get a
  `session-expired` event, and are published through the app inbox.
- Added group presence expiry reconciliation through `GroupStateService.expireExpiredPresenceSessions(...)` and
  `AppGroupInboxService.processExpiredPresenceSessions(...)`. Group presence expiry reuses the existing
  `session-disconnected` event shape with `reason: 'expired'`.
- Added periodic middleware startup wiring via `initPresenceExpiryReconciliation(...)`, which enqueues no-wait app-inbox
  scans for client and group expiry reconciliation.
- Added terminal-state guards so late WS close cleanup does not rewrite an already expired/disconnected session or append
  duplicate events.
- Added per-session runtime-state advisory locks for client session mutations and group presence-session mutations. Expiry
  reconciliation and late WS cleanup now acquire the same lock before idempotency lookup and state mutation, reducing
  duplicate writes when multiple API processes scan the same expired session.

Verification:

- Added repository tests proving expired rows remain readable for reconciliation while snapshots omit them.
- Added client/group service tests proving expiry is applied once, direct publication does not happen inside state
  services, and late WS cleanup does not rewrite expired rows.
- Added app-inbox tests proving expiry reconciliation publishes snapshot/event results.
- Added a reconciliation enqueue test proving both client and group expiry scans are queued without waiting.
- Added lock coverage proving expiry and late cleanup use the same per-session lock key.

Remaining risk:

- The app-inbox and state-service unit tests prove lock acquisition and idempotent behavior, but there is still no
  real multi-process Postgres test that starts two API workers and forces both to reconcile the same expired session at
  the same time.

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
