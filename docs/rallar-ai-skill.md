# Rallar AI Skill Guide

Use this document as an AI skill when implementing, reviewing, or debugging code that uses Rallar.

## Purpose

Rallar is the browser facade for auth, room state, client presence, websocket messages, RTC overlay messages, RTC data-channel realtime messages, media streams, and browser IndexedDB-backed custom data.

Rallar Server is the server-side facade/middleware that wires websocket queuebox routing, durable app inboxes, state sync, and route installation.

## Source Of Truth

Read these files before changing behavior:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-server/rallar-system/middleware/rallar-middleware.ts`
- `packages/shared-server/rallar-facade/rallar-server.ts`
- `packages/shared-server/rallar-facade/rallar-server-application.ts`
- `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts`

## When To Use Rallar

Use `rallar` in browser code when the task involves:

- Login, logout, registration, or restoring a session.
- Creating, switching, joining, leaving, listing, or observing rooms.
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

1. Use `setup()` for initial facade configuration.
   Initial boot passes the API base URL to `rallar.setup(...)`.
   Use `rallar.configure(...)` directly only for lower-level or
   already-configured flows that manage lifecycle steps separately.

2. Pass initial application and workspace defaults through `setup()`.
   Include `applicationId` and `workspaceId` in `rallar.setup(...)`.
   Use `rallar.setDefaults(...)` directly only when updating an
   already-configured facade.

3. Login before state mutation.
   Room create/join/leave and most state APIs require an authenticated session.

4. Use `setup()` for initial app boot and `start()` for configured lifecycle continuation.
   Prefer `rallar.setup({ apiBaseUrl, applicationId, workspaceId, start })`
   when the app first configures the facade. After login or when configuration
   already exists, use `rallar.start({ connect: true, refreshRooms: true,
   refreshPeople: true })`.

5. Prefer room helpers for room-scoped low-latency sends.
   Use `rallar.realtime.room<T>({ roomId, laneId: 'realtime', waitTimeoutMs }).send(payload)` for app/game room traffic. It waits for RTC readiness by default and returns transport diagnostics.

6. Use `createAndSwitch` for replacement room creation.
   Use `rallar.rooms.createAndSwitch(...)` when creating a new room should
   leave the previous current room. Use `rooms.create(...)` only when staying in
   the previous room is intentional.

7. Use readiness expectations when counts matter.
   Use `rooms.waitForPresence(...)` or `rtc.waitForRoomLane(..., { expect })`
   for flows that require a minimum, maximum, exact count, or exact set of
   active sessions/peers.

8. Use WS for reliable server-routed messages.
   Use `rallar.messages.room<T>(definition)` when an important room message should use the typed message path with RTC and WS options. Use raw RTC/realtime APIs only when the caller needs custom peer selection or low-level readiness handling.

9. Use `roomRef` where scope matters.
   Prefer `GroupRef` over plain `roomId` when the app can operate in multiple application/workspace scopes.

10. Store unsubscribe callbacks.
    Use `rallar.subscriptions()` for UI component lifecycles.

11. Do not call `advanced.middleware()` unless the public facade is missing the needed operation.

12. For Rallar Data, do not open the same store with different options.
    The facade intentionally throws when an already-open store is requested with incompatible options.

## Browser Implementation Workflow

1. Identify the feature surface:
   auth, rooms, people, messages, rtc, ws, realtime, media, or data.

2. For initial app boot, call `rallar.setup(...)`:

```ts
await rallar.setup({
    apiBaseUrl,
    applicationId: 'app',
    workspaceId: 'default',
    start: {
        refreshPeople: true
    }
});
```

After login or for configured lifecycle continuation, call
`rallar.start(...)`.

3. Subscribe with cleanup:

```ts
const subs = rallar.subscriptions();
subs.add(rallar.rooms.onChange(renderRooms));
subs.add(rallar.people.onChange(renderPeople));

return () => subs.unsubscribe();
```

4. For room-scoped realtime sends, use the room helper:

```ts
const roomLane = rallar.realtime.room<{ type: 'move'; x: number; y: number; }>({
    roomId: 'lobby',
    laneId: 'realtime',
    waitTimeoutMs: 1000
});

const result = await roomLane.send({ type: 'move', x: 1, y: 2 });
if (result.status === 'not-ready') {
    console.warn(result.reason);
}
```

## Rallar Data Workflow

Use Rallar Data for local browser state that should survive reloads or coordinate across tabs.

```ts
interface Draft {
    readonly body: string;
    readonly updatedAt: number;
}

const drafts = await rallar.data.open<Draft>('drafts', {
    scope: 'principal',
    durability: 'write-behind',
    hydrate: 'lazy',
    sync: true
});

await drafts.updateOrCreate('room:lobby', (current) => ({
    body: current?.body ?? '',
    updatedAt: Date.now()
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
        rest: [installAuthRoutes, installStateRoutes]
    }
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

- Initial boot uses `rallar.setup(...)` to configure the API base URL before
  connection; direct `configure()` calls are limited to lower-level or
  already-configured flows.
- Initial `applicationId` and `workspaceId` defaults are passed through
  `rallar.setup(...)`; direct `setDefaults()` calls only update an
  already-configured facade.
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
