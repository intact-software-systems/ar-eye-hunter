# Rallar Troubleshooting Checklist

Use this checklist when Rallar behavior is surprising in a browser or server integration.

## Startup

- Initial configuration uses `rallar.setup(...)` with the API base URL and the
  correct `applicationId` and `workspaceId`.
- Configured reconnect or after-login flows may use `rallar.start(...)`.
- `rallar.auth.restore()` returns a session when startup expects one.
- `rallar.status()` is not stuck at `connecting`.

## Auth

- Login writes a session through `rallar.auth.login(...)`.
- Logout uses `rallar.auth.logout(...)`, not only `clearSession`.
- Authenticated local data scopes are closed or destroyed on logout when they contain sensitive data.
- User switching disconnects existing middleware before new session use.

## Rooms

- `rooms.refresh()` was called after login or startup.
- The current room is set by `rooms.create(...)`, `rooms.createAndSwitch(...)`,
  or `rooms.join(...)`.
- New-room flows that should leave the previous room use
  `rooms.createAndSwitch(...)`; `rooms.create(...)` intentionally keeps the
  previous membership.
- `leaveCurrent` behavior is intentional when joining another room.
- Multi-workspace code passes `roomRef` instead of only `roomId`.
- `rooms.session(room).refresh()` is expected to make one exact group point
  read; `rooms.refresh()` is the complete room/client collection refresh.
- A room-session refresh `404` is rethrown after conditional local cleanup. A
  newer snapshot racing that response is preserved.
- `rooms.waitForPresence(...)` uses the right expectation for the flow:
  `{ min, max? }`, `{ exact }`, or `{ sessionIds, allowExtras? }`.
- Room event subscriptions use the correct `scope`, `roomId`, `roomRef`, and `eventTypes`.

## People And Presence

- `people.refresh()` was called after login or startup.
- Presence UI listens through `people.onChange(...)`.
- Client events are not assumed to arrive while disconnected unless replay is used.
- Server websocket lifecycle cleanup is installed.
- Server presence expiry reconciliation is initialized.

## REST Snapshot Reads

- Client floors use one canonical `minStateRevision`; group floors provide
  both `minGroupRevision` and `minPresenceRevision`.
- `400` means the floor query is malformed. Authorized `409` with
  `state-revision-floor-not-satisfied` means durable state has not reached or
  does not dominate the requested floor. Treat `503` as infrastructure or
  stable-snapshot-read failure instead.
- Successful point responses include `Cache-Control: no-store`,
  `rallar-state-source`, and revision headers that agree with the body.
- Browser point readers validate authoritative body and response metadata. A
  malformed success response is rejected and is not reconciled into caches.
- Collection omission and heartbeat/point `404` cleanup is conditional on the
  originally observed object identity. It is physical deletion, not a
  tombstone; delayed stale publication can reinsert the snapshot.
- Browser diagnostics use `setBrowserStateReadDiagnosticsSink(...)`. Keep
  dimensions bounded and never add tenant, entity, session, or request IDs as
  metric labels.

## WebSocket

- `rallar.ws.status().isOpen` is true before relying on WS send.
- `rallar.ws.waitForOpen(...)` is used for flows that need immediate send after startup.
- `rallar.ws.onLifecycle(...)` is installed for UI status or debugging.
- The server websocket route is mounted.
- The server queuebox engine is started.
- Default middleware topics are installed.

## RTC Topology Durable Replay

- QueueBox is still the expected low-latency path. A lost PostgreSQL
  notification may add up to the one-second anti-entropy interval; it must not
  cause permanent topology loss.
- `RALLAR_RTC_TOPOLOGY_REPLAY` is `enabled` unless rollback deliberately sets
  it to `disabled`. Disabling replay also disables reconnect/gap hydration but
  does not disable stream logging, leases, compaction, or QueueBox.
- Standard processes keep `RALLAR_API_QUEUE_WORKERS=enabled`. A disabled worker
  process is PostgreSQL-only and should be deliberately passive.
- `GET /api/admin/operations/realtime` exposes process-local values under
  `rtcTopology.metrics.replay`. Check wake counts, drain failures, maximum lag,
  entry outcomes, cursor conflicts/gaps, and hydration outcomes. Do not add
  tenant, group, session, publication, stream, or request IDs as metric labels.
- A live listener-outage check expects `wakeCountBySource.poll` to advance while
  notification and local-commit wakes remain zero on the passive process.
- Diagnose delivery with publisher-qualified positions such as A/11 and B/21.
  Never compare bare sequence numbers from different streams.
- A consumer cursor must equal the relevant captured publisher HEAD only after
  its contiguous prefix was handled. A stalled cursor with `corrupt` or
  `send-failed` evidence is fail-closed behavior, not permission to skip.
- A retention gap should increment the gap outcome and hydrate all currently
  open local sessions before cursor advancement.
- Reconnect hydration requires current durable membership, principal/session
  identity, live unexpired presence, and the exact socket generation. A retry
  or unauthorized outcome should be traced to those facts before changing
  retry limits.
- Run `npm run test:api-v1:black-box:postgres:topology-replay` for the managed
  A/B/passive-C/C' proof. Inspect `rtc-topology-replay-proof.json`, or the
  current-run failure artifact and all four isolated server logs.

## RTC

- `rallar.rtc.status()` shows the expected known peers.
- For room-scoped app/game sends, `rallar.realtime.room(...).status()` or the
  `send(...)` result shows expected `desiredPeerIds` and ready peers.
- For low-level direct sends, `readyPeerIds(laneId)` includes the target peer
  before `realtime.sendJson(...)`.
- For low-level direct sends, `waitForRoomLane(room, laneId, { connect: true })`
  is used before the first send.
- Room-lane waits pass `expect` when the caller knows the required peer count or
  exact peer/session IDs, and handle `over-capacity` separately from
  `not-ready`.
- The lane ID matches configured data channel lanes.
- The room has active presence sessions for peer routing.
- Partial readiness is handled explicitly.
- Repeated initial setup stalls are bounded: browser RTC defaults to six
  attempts, 180 seconds total, then a 30 second cooldown. Facade waits report
  this as `status: 'failed'` with reason
  `rtc-connect-attempt-budget-exhausted`.
- Inbound RTC offers from peers missing from the local group cache can be
  admitted tentatively because group ownership is eventually consistent. Hard
  rejects still apply to malformed/self/wrong-target signals and exhausted or
  cap-blocked peers.

## Realtime Data Channels

- Prefer `realtime.room<T>(...)` for room-scoped low-latency peer traffic.
- Use `realtime.sendJson(...)` directly only when the caller owns peer targeting
  and readiness decisions.
- Use `messages.room<T>(...)` or WS fallback for important messages if RTC is
  not ready.
- Check each `RallarRealtimeSendResult.result` for per-peer send outcome.
- Add lifecycle logging for `lane-open`, `lane-close`, and `lane-error`.

## Rallar Motion

- Use a dedicated motion lane for high-rate pose updates instead of sharing the lane used by shots, commands, or director relay traffic.
- Configure custom data-channel lanes before the first `connect()` or `start()` call.
- Drive `RallarMotionBuffer` with receiver-local `observedAtEpochMs`; do not interpolate from sender `sentAtEpochMs` unless the app has clock sync.
- If remote avatars trail too far behind, lower `interpolationDelayMs`; if they snap during jitter, raise it slightly.
- Keep `maxExtrapolationMs` short so lost motion packets hold the latest observed pose instead of drifting.
- Use `readInterpolationDelayMs` with `createRallarMotionAdaptiveDelay()` when packet spacing varies by room or device.
- Enable discontinuity handling for respawns, teleports, dashes, or AR relocalization so the buffer snaps instead of interpolating through space.
- Use correction blending for small visual corrections, but set snap thresholds for large authoritative jumps.
- Use `createRallarMotionSendGate()` when pose traffic should respect cadence, movement thresholds, idle cadence, and force-send freshness.
- Treat quantization ranges and precision as app-specific; choose them from the game world scale instead of using them as generic compression.

## WS/RTC Message Selectors

- `topicId` and `typeId` match on both sender and receiver.
- A string selector matches `typeId`, not `topicId`.
- Room messages include `scope: 'room'` and a `roomId` or `roomRef`.
- Cross-workspace traffic uses `roomRef`.
- Server target resolver can find the group snapshot by ref.

## Rallar Data

- The same store is not opened with different options.
- `hydrate: 'lazy'` code calls `get`, `getEntries`, `getAll`, or `hydrate` before assuming persisted values are in memory.
- `write-behind` code calls `whenIdle()` or `flush()` before closing if data loss matters.
- `ttlMs` and `expireAtFor` are not expiring values earlier than expected.
- `sync: true` only syncs open tabs through `BroadcastChannel`; it is not server sync.
- `compareAndSet` is not used as a cross-process transactional lock.
- `schemaVersion` changes include a `migrate` function when old data exists.

## Rallar CRDT

- The app is using `rallar.crdt`, not `rallar.data`, for mergeable documents.
- Room documents include a full `roomRef` with application, workspace, and
  group ID.
- The selected transport is one of `local-only`, `ws`, `rtc`, `ws-then-rtc`, or
  `rtc-with-ws-fallback`.
- Pending updates are expected to remain pending until a durable append response
  accepts or dedupes them.
- `doc.health()` is checked for failed pending, dependency-blocked, live
  rejected, corrupt local artifact count, last server append sequence, and last
  server ACK time.
- Feature policies are checked when WS/RTC sends are skipped with statuses such
  as `rtc-disabled`, `ws-disabled`, `network-disabled`, or
  `rollout-disabled`.
- Repository admin exports pass `verifyIntegrity(...)` before backup restore or
  projection rebuild.
- Quarantined documents reject writes until an operator changes lifecycle state.
- Server `room.crdt` topics are installed and room authorization can resolve the
  current group snapshot.
- API-v1 has the `crdt_documents`, `crdt_updates`, and `crdt_snapshots` tables
  from the latest migration or in-memory schema.
- Raw blobs are stored outside CRDT updates; operation values contain JSON
  metadata or attachment references only.
- Principal live fanout is not expected to work; principal documents need the
  durable append/catch-up path.

## Server Middleware

- `createRallarMiddleware(...)` receives durable queuebox repositories in production.
- `outbox` is set when inbound and outbound queues are separate.
- `createAppGroupInboxService` and `createAppClientInboxService` use durable resource inbox and results repositories.
- `createWsStateSyncPublisher(...)` uses the same `wsQBoxServerService`.
- `findGroupSnapshotByRef` uses a current or read-through cache.
- `inboundStores` and `outboundStores` are configured for AL runtime persistence.
- `runtime.qboxEngine.start()` is called.
- Runtime-state expiry eviction, resource-inbox expiry eviction, and presence-expiry reconciliation are initialized.

## Tests To Add For Connection Bugs

- Browser startup with no session.
- Browser startup with restored session.
- WS close while logged in.
- Logout followed by socket close.
- RTC wait timeout.
- RTC partial room readiness.
- RTC attempt-budget exhaustion and cooldown.
- Inbound offer before group cache hydration.
- First room realtime send through `realtime.room(...).send(...)`, including
  `not-ready` and `no-targets` results.
- Room message scoped by `roomRef` in two workspaces with same `roomId`.
- Server restart with existing room/client state.
- App-inbox retry after transient publish failure.

## Useful Debug Logging

Browser:

```ts
rallar.ws.onLifecycle((event) => console.log('ws', event));
rallar.rtc.onLifecycle((event) => console.log('rtc', event));
rallar.rooms.onEvent((event) => console.log('room event', event));
rallar.people.onEvent((event) => console.log('client event', event));
```

Server:

```ts
console.log(runtime.wsQBoxServerService.status?.());
console.log(server.ws.status());
```

## Common Fixes

- Configure defaults once near app startup.
- Replace direct API calls with facade calls so state caches and lifecycle logic stay coherent.
- Use `rooms.createAndSwitch(...)` when a newly created room should replace the
  current room.
- Use `realtime.room<T>(...)` for room-scoped sends, or add `waitForOpen` /
  `waitForRoomLane` with an explicit `expect` before immediate low-level send
  flows.
- Use `roomRef` in messages and state calls when application/workspace matters.
- Move cleanup through `auth.logout`.
- Use app inbox services for state mutations that must be durable and publish state sync.
