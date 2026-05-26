# Rallar Troubleshooting Checklist

Use this checklist when Rallar behavior is surprising in a browser or server integration.

## Startup

- `rallar.configure(...)` is called before `connect()` or `start()`.
- `rallar.setDefaults(...)` has the correct `applicationId` and `workspaceId`.
- `rallar.auth.restore()` returns a session when startup expects one.
- `rallar.start({ restoreSession: true, connect: true })` is used for normal app boot.
- `rallar.status()` is not stuck at `connecting`.

## Auth

- Login writes a session through `rallar.auth.login(...)`.
- Logout uses `rallar.auth.logout(...)`, not only `clearSession`.
- Authenticated local data scopes are closed or destroyed on logout when they contain sensitive data.
- User switching disconnects existing middleware before new session use.

## Rooms

- `rooms.refresh()` was called after login or startup.
- The current room is set by `rooms.create(...)` or `rooms.join(...)`.
- `leaveCurrent` behavior is intentional when joining another room.
- Multi-workspace code passes `roomRef` instead of only `roomId`.
- Room event subscriptions use the correct `scope`, `roomId`, `roomRef`, and `eventTypes`.

## People And Presence

- `people.refresh()` was called after login or startup.
- Presence UI listens through `people.onChange(...)`.
- Client events are not assumed to arrive while disconnected unless replay is used.
- Server websocket lifecycle cleanup is installed.
- Server presence expiry reconciliation is initialized.

## WebSocket

- `rallar.ws.status().isOpen` is true before relying on WS send.
- `rallar.ws.waitForOpen(...)` is used for flows that need immediate send after startup.
- `rallar.ws.onLifecycle(...)` is installed for UI status or debugging.
- The server websocket route is mounted.
- The server queuebox engine is started.
- Default middleware topics are installed.

## RTC

- `rallar.rtc.status()` shows the expected known peers.
- `readyPeerIds(laneId)` includes the target peer before direct realtime send.
- `waitForRoomLane(room, laneId, { connect: true })` is used before the first realtime send.
- The lane ID matches configured data channel lanes.
- The room has active presence sessions for peer routing.
- Partial readiness is handled explicitly.

## Realtime Data Channels

- Use `realtime.sendJson(...)` only for low-latency peer traffic.
- Use WS fallback for important messages if RTC is not ready.
- Check each `RallarRealtimeSendResult.result` for per-peer send outcome.
- Add lifecycle logging for `lane-open`, `lane-close`, and `lane-error`.

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
- First realtime send after explicit `waitForRoomLane`.
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
- Add `waitForOpen` or `waitForRoomLane` before immediate send flows.
- Use `roomRef` in messages and state calls when application/workspace matters.
- Move cleanup through `auth.logout`.
- Use app inbox services for state mutations that must be durable and publish state sync.
