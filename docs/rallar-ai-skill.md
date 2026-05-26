# Rallar AI Skill Guide

Use this document as an AI skill when implementing, reviewing, or debugging code that uses Rallar.

## Purpose

Rallar is the browser facade for auth, room state, client presence, websocket messages, RTC overlay messages, RTC data-channel realtime messages, media streams, and browser IndexedDB-backed custom data.

Rallar Server is the server-side facade/middleware that wires websocket queuebox routing, durable app inboxes, state sync, and route installation.

## Source Of Truth

Read these files before changing behavior:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- `packages/shared-server/rallar-facade/RallarServer.ts`
- `packages/shared-server/rallar-facade/RallarServerApplication.ts`
- `packages/shared-server/rallar-facade/ws-topic-router.ts`

## When To Use Rallar

Use `rallar` in browser code when the task involves:

- Login, logout, registration, or restoring a session.
- Creating, joining, leaving, listing, or observing rooms.
- Observing people/client presence.
- Sending AL messages over WS or RTC.
- Waiting for WS or RTC readiness.
- Sending low-latency JSON or binary data over RTC data channels.
- Managing local browser data with scoped IndexedDB stores.
- Handling media streams for RTC peers.

Use Rallar Server middleware/facade when the task involves:

- Mounting websocket and REST routes.
- Installing default middleware topics.
- Installing websocket lifecycle cleanup.
- Defining server-side websocket topics.
- Publishing or proxying WS messages.
- Creating server-side app data stores.

## Core Rules

1. Configure before connect.
   Call `rallar.configure({ apiBaseUrl })` before `connect()` or `start()`.

2. Prefer defaults for application and workspace.
   Call `rallar.setDefaults({ applicationId, workspaceId })` so app code can pass simple room IDs most of the time.

3. Login before state mutation.
   Room create/join/leave and most state APIs require an authenticated session.

4. Use `start()` for app boot.
   Prefer `rallar.start({ restoreSession: true, connect: true, refreshRooms: true, refreshPeople: true })` over manually calling many boot APIs.

5. Wait for readiness before first low-latency RTC send.
   Use `rallar.rtc.waitForRoomLane(room, 'realtime', { connect: true, timeoutMs })` before a first `realtime.sendJson`.

6. Use WS for reliable server-routed messages.
   Use RTC/realtime for peer-to-peer low-latency traffic when partial delivery is acceptable or handled by the app.

7. Use `roomRef` where scope matters.
   Prefer `GroupRef` over plain `roomId` when the app can operate in multiple application/workspace scopes.

8. Store unsubscribe callbacks.
   Use `rallar.subscriptions()` for UI component lifecycles.

9. Do not call `advanced.middleware()` unless the public facade is missing the needed operation.

10. For Rallar Data, do not open the same store with different options.
    The facade intentionally throws when an already-open store is requested with incompatible options.

## Browser Implementation Workflow

1. Identify the feature surface:
   auth, rooms, people, messages, rtc, ws, realtime, media, or data.

2. Add or confirm defaults:

```ts
rallar.setDefaults({
  applicationId: 'app',
  workspaceId: 'default',
  room: { roomId: 'lobby' },
});
```

3. Start the facade:

```ts
await rallar.start({
  restoreSession: true,
  connect: true,
  refreshRooms: true,
  refreshPeople: true,
});
```

4. Subscribe with cleanup:

```ts
const subs = rallar.subscriptions();
subs.add(rallar.rooms.onChange(renderRooms));
subs.add(rallar.people.onChange(renderPeople));

return () => subs.unsubscribe();
```

5. For first realtime send, ensure lane readiness:

```ts
const readiness = await rallar.rtc.waitForRoomLane('lobby', 'realtime', {
  connect: true,
  timeoutMs: 1000,
});

if (readiness.ready.length > 0) {
  await rallar.realtime.sendJson({
    laneId: 'realtime',
    roomId: 'lobby',
    data: { type: 'move', x: 1, y: 2 },
  });
}
```

## Rallar Data Workflow

Use Rallar Data for local browser state that should survive reloads or coordinate across tabs.

```ts
type Draft = { body: string; updatedAt: number };

const drafts = await rallar.data.open<Draft>('drafts', {
  scope: 'principal',
  durability: 'write-behind',
  hydrate: 'lazy',
  sync: true,
});

await drafts.updateOrCreate('room:lobby', (current) => ({
  body: current?.body ?? '',
  updatedAt: Date.now(),
}));
```

Choose:

- `scope: 'app'` for non-user-specific data.
- `scope: 'principal'` for user-owned data.
- `scope: 'session'` for short-lived session data.
- `write-through` for stronger persistence per write.
- `write-behind` for high-frequency UI state.

## Server Workflow

Prefer the server application facade:

```ts
const rallar = createRallarServerApplication({
  runtime,
  routes: {
    ws: installWsRoutes,
    rest: [installAuthRoutes, installStateRoutes],
  },
});

rallar.system
  .useDefaultMiddlewareTopics()
  .useWebSocketLifecycle();

rallar.ws.mount(app);
rallar.rest.mount(app);
rallar.start();
```

If creating middleware directly:

- Provide the queuebox repositories.
- Provide state repositories.
- Provide app inbox service factories.
- Provide state-sync publisher wiring.
- Start `runtime.qboxEngine`.
- Install websocket lifecycle cleanup.

## Review Checklist

Check browser code for:

- `configure()` is called before connect/start.
- `setDefaults()` exists when app/workspace/group IDs are repeated.
- Authenticated operations handle missing session.
- UI subscriptions are unsubscribed.
- First realtime send waits for RTC readiness or handles not-ready results.
- WS and RTC lifecycle callbacks are used for user-visible connection state.
- Rallar Data stores use stable names/options and close/destroy scopes on logout where needed.

Check server code for:

- `useDefaultMiddlewareTopics()` and `useWebSocketLifecycle()` are installed.
- `qboxEngine.start()` is called.
- `findGroupSnapshotByRef` is available for scoped room routing.
- App inbox services are durable and publish state-sync results.
- Runtime expiry and presence expiry reconciliation are initialized.

## Common Mistakes

- Sending RTC realtime data before the data channel is open.
- Using `roomId` in multi-workspace code when `roomRef` is available.
- Forgetting to refresh state after login/start.
- Opening the same Rallar Data store name with different durability or schema options.
- Treating `compareAndSet` in Rallar Data as cross-tab transactional locking. It is a facade-level convenience over current store state, not a database transaction.
- Mounting server routes but not starting the queuebox engine.
