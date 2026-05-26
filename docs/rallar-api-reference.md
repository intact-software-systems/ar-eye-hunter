# Rallar API Reference

This document describes the public facade APIs in:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`

It also references the server facade wrappers where they are the normal way to consume the middleware runtime.

## Browser Rallar

Import one shared facade instance, or create an isolated facade:

```ts
import { rallar, createRallarFacade } from '@shared-web/browser/rallar.ts';

const isolated = createRallarFacade();
```

### Defaults And Configuration

`configure(config)` sets the browser API base URL. It must be called before the facade connects.

```ts
rallar.configure({ apiBaseUrl: 'http://localhost:8080' });
```

`setDefaults(defaults)` stores facade defaults for scope, room, RTC, realtime, and operation policies.

```ts
rallar.setDefaults({
  applicationId: 'game',
  workspaceId: 'default',
  room: { roomId: 'lobby' },
  realtime: { laneId: 'realtime', openTimeoutMs: 1000 },
  rtc: { waitTimeoutMs: 1000, connectOnWait: true },
  operations: { timeoutMs: 5000, maxAttempts: 3 },
});
```

`defaults()` returns a clone of the current defaults or `undefined`.

### Lifecycle

`connect(options?)` initializes browser middleware and opens the websocket transport.

`start(options?)` is the higher-level startup API. It can restore a session, connect, and refresh room/people state.

```ts
await rallar.auth.login({ username: 'alice', password: 'secret' });

const started = await rallar.start({
  restoreSession: true,
  connect: true,
  refreshRooms: true,
  refreshPeople: true,
});
```

`disconnect()` closes active middleware resources.

`status()` returns `'idle'`, `'connecting'`, or `'connected'`.

`isConnected()` returns whether the facade is connected.

`session()` returns the current stored `AuthSession`, if present.

`subscriptions()` creates a scope for grouping unsubscribe callbacks:

```ts
const scope = rallar.subscriptions();
scope.add(rallar.rooms.onChange((state) => renderRooms(state)));
scope.add(rallar.ws.onLifecycle((event) => console.log(event.kind)));

scope.unsubscribe();
```

`flow(policies?)` creates a `CommandsOrchestrator` for caller-owned command orchestration.

`advanced.middleware()` returns the initialized browser middleware. Use this only when the facade does not expose the lower-level operation you need.

### Auth

`auth.login(request, options?)` logs in, writes the session locally, and disconnects any existing middleware if the API base/session changes.

`auth.register(request, options?)` registers a user. Pass `adminSession` if the API requires an admin session.

`auth.registerAndLogin(request, options?)` registers and then logs in.

`auth.logout(options?)` disconnects, calls the logout API when a session exists, closes authenticated data scopes, clears the local session, and emits state.

`auth.restore()` reads the locally stored session.

`auth.isLoggedIn()` returns whether a stored session exists.

```ts
await rallar.auth.registerAndLogin({
  username: 'alice',
  password: 'secret',
  displayName: 'Alice',
});
```

### Rooms

`rooms.state()` returns the current derived room state.

`rooms.list()` returns room summaries.

`rooms.refresh(input?)` fetches current room and client snapshots from the API and updates local caches.

`rooms.create(input)` creates a group/room and joins it. `input` can be a display name string or an object.

`rooms.join(roomId, options?)` joins a room. By default it leaves the current room if different.

`rooms.leave(input?)` leaves a room. It can use explicit `roomId`, `roomRef`, the default room, or the current room.

`rooms.current()` returns the current room snapshot.

`rooms.onChange(listener, options?)` subscribes to derived room state.

`rooms.onEvent(listener, options?)` subscribes to group state-sync events received over WS.

`rooms.listEvents(input)` lists persisted group events.

`rooms.listEventPage(input)` returns a paged event response with cursor metadata.

`rooms.replayEvents(input, listener?)` fetches pages of persisted room events, dedupes events already seen by the facade, and optionally feeds the events to a listener.

```ts
const room = await rallar.rooms.create({
  displayName: 'Lobby',
  scope: { applicationId: 'game', workspaceId: 'default' },
});

await rallar.rooms.join(room.group.groupId);

rallar.rooms.onEvent((event) => {
  if (event.eventType === 'member-joined') {
    console.log('Room membership changed');
  }
});
```

### People

`people.state()` returns derived people/client state.

`people.list()` returns known people.

`people.refresh(input?)` fetches client snapshots from the API and updates local caches.

`people.get(principalId)` returns one known person.

`people.onChange(listener, options?)` subscribes to derived people state.

`people.onEvent(listener, options?)` subscribes to client state-sync events received over WS.

`people.listEvents(principalId, options?)`, `people.listEventPage(...)`, and `people.replayEvents(...)` read persisted client events.

```ts
rallar.people.onChange((state) => {
  for (const person of state.people) {
    console.log(person.principalId, person.isOnline);
  }
});
```

### WS And RTC Messages

Rallar has two generic message lanes:

- `messages.ws` sends AL messages through websocket routing.
- `messages.rtc` sends AL messages through the WebRTC overlay.

Both lanes expose:

- `send(input)`
- `onMessage(selector, handler)`

Selectors can be a `typeId` string or `{ topicId, typeId }`.

```ts
rallar.messages.ws.onMessage('chat.message', (message) => {
  console.log(message.payload);
});

await rallar.messages.ws.send({
  typeId: 'chat.message',
  payload: { text: 'hello' },
  scope: 'room',
  roomRef: room.group,
});
```

Typed channels reduce boilerplate when one payload type has one topic/type pair:

```ts
type ChatMessage = { text: string };

const chat = rallar.messages.channel<ChatMessage>({
  topicId: 'chat',
  typeId: 'message',
});

chat.onWs((payload) => console.log(payload.text));
await chat.sendWs({ text: 'hello' }, { scope: 'room', roomRef: room.group });
```

### RTC Status And Readiness

`rtc.status(options?)` returns a snapshot of peer/lane readiness.

`rtc.onStatus(listener, options?)` subscribes to RTC status snapshots.

`rtc.onLifecycle(listener, options?)` subscribes to RTC lifecycle events such as `peer-created`, `lane-open`, `lane-close`, and `peer-timeout`.

`rtc.waitForLane(peerId, laneId, options?)` waits for a specific peer/lane.

`rtc.waitForOpen(peerId, options?)` waits for the default or configured lane.

`rtc.waitForRoomLane(room, laneId, options?)` waits for all known active peers in a room and returns separate `ready` and `notReady` lists.

`rtc.peer(peerId, options?)`, `knownPeerIds()`, `activePeerIds()`, `peerIdsWithNoReconnectableLanes()`, and `readyPeerIds(laneId?)` expose peer subsets.

```ts
const readiness = await rallar.rtc.waitForRoomLane('lobby', 'realtime', {
  connect: true,
  timeoutMs: 1000,
});

if (readiness.status === 'open' || readiness.status === 'partial') {
  console.log('Ready peers', readiness.ready.map((entry) => entry.peerId));
}
```

### WebSocket Status And Readiness

`ws.status()` returns websocket status.

`ws.onStatus(listener, options?)` subscribes to status snapshots.

`ws.onLifecycle(listener, options?)` subscribes to events such as `open`, `close`, `error`, `connected`, and `disconnected`.

`ws.waitForOpen(options?)` waits until the websocket is open or returns a non-open status.

```ts
const result = await rallar.ws.waitForOpen({ timeoutMs: 1000 });
if (result.status !== 'open') {
  throw new Error(`WS not ready: ${result.status}`);
}
```

### Realtime Data Channels

The `realtime` facade sends directly over RTC data channels. It is for low-latency peer traffic after room membership and RTC readiness exist.

`realtime.sendJson(input)` sends JSON to selected peer IDs, a room, or the default/current room.

`realtime.sendBinary(input)` sends binary data.

`realtime.onJson(laneId, handler)` subscribes to JSON messages on a lane.

`realtime.onBinary(laneId, handler)` subscribes to binary messages.

`realtime.json(defaults?)` creates a typed JSON lane.

`realtime.health(options?)` returns RTC data channel health records.

```ts
const lane = rallar.realtime.json<{ x: number; y: number }>({
  laneId: 'realtime',
  roomId: 'lobby',
  openTimeoutMs: 1000,
});

lane.on((message) => {
  updateRemotePlayer(message.peerId, message.data);
});

await rallar.rtc.waitForRoomLane('lobby', 'realtime', {
  connect: true,
  timeoutMs: 1000,
});

await lane.send({ x: 10, y: 5 });
```

### Media

`media.setLocalStream(stream)` attaches local media to RTC peer connections.

`media.setAudioEnabled(enabled)` toggles audio tracks.

`media.setVideoEnabled(enabled)` toggles video tracks.

`media.stopLocal(kind)` stops `audio`, `video`, or `all` local tracks.

`media.setPolicy(policy)` updates the RTC media policy.

`media.onRemoteStream(handler)` subscribes to remote streams.

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true,
});

await rallar.media.setLocalStream(stream);
rallar.media.onRemoteStream(({ peerId, stream }) => attachVideo(peerId, stream));
```

## Rallar Data

Rallar Data is a browser IndexedDB-backed key-value facade with observable in-memory repositories.

Import through `rallar.data`, or directly:

```ts
import {
  createRallarDataFacade,
  defineRallarDataStore,
} from '@shared-web/browser/rallar-data.ts';
```

### Facade API

`define(name, options?)` returns a store definition.

`open(input, options?)` opens or creates a store. If `hydrate` is `eager`, it hydrates before returning.

`lookup(input, options?)` returns an already-open store, or `undefined`.

`close(input, options?)` flushes and disposes an open store.

`closeScope(scope)` closes active stores in a scope.

`clearScope(scope)` clears active stores in a scope without closing them.

`destroy(input, options?)` clears persisted data and closes/disposes the store.

`destroyStore(...)` aliases `destroy(...)`.

`destroyScope(scope)` clears and closes active stores in a scope.

`estimateUsage()` returns browser storage usage/quota when available.

```ts
type Settings = { volume: number };

const settingsDef = rallar.data.define<Settings>('settings', {
  scope: 'principal',
  durability: 'write-through',
});

const settings = await rallar.data.open(settingsDef);
await settings.set('audio', { volume: 0.8 });
```

### Store Options

- `scope`: logical grouping, defaults to `'app'`.
- `dbName`: IndexedDB database name, defaults to `rallar-custom-data`.
- `storeName`: IndexedDB object store name, defaults to `entries`.
- `keyPrefix`: key namespace; normally leave unset.
- `ttlMs`: time-to-live for entries.
- `durability`: `'write-through'` persists on mutation; `'write-behind'` persists asynchronously.
- `hydrate`: `'eager'` or `'lazy'`.
- `schemaVersion`: persisted envelope schema version, defaults to `1`.
- `migrate`: converts old values to the current schema.
- `sync`: enables `BroadcastChannel` cross-tab sync when available.
- `isValid`: rejects invalid values during repository operations.
- `equals`: custom equality function.
- `expireAtFor`: per-value expiry timestamp.
- `onPersistenceError`: write-behind persistence error handler.

### Store API

Read methods:

- `read(key)` reads memory only.
- `get(key)` reads persistence when needed.
- `readEntries()`, `readAllValues()`, `keys()` read memory.
- `getEntries()`, `getAll()`, `listKeys()`, `exportData()` include persistence.

Write methods:

- `set(key, value)`
- `update(key, updater)`
- `updateOrCreate(key, updater)`
- `setIfAbsent(key, creator)`
- `compareAndSet(key, expect, update)`
- `getAndSet(key, update)`
- `delete(key)`
- `deleteExpired()`
- `clear()` / `clearAll()`

Lifecycle methods:

- `hydrate()`
- `whenHydrated()`
- `isHydrated()`
- `whenIdle()`
- `flush()`
- `close()`
- `destroy()`
- `estimateUsage()`
- `onChange(listener)`

```ts
const drafts = await rallar.data.open<{ body: string }>('drafts', {
  scope: 'session',
  durability: 'write-behind',
  hydrate: 'lazy',
  ttlMs: 24 * 60 * 60 * 1000,
});

drafts.onChange((event) => {
  console.log(event.key, event.value);
});

await drafts.updateOrCreate('room:lobby', (current) => ({
  body: current?.body ?? '',
}));

await drafts.whenIdle();
```

## Rallar Middleware

`createRallarMiddleware(options)` builds the server-side runtime used by the Rallar server facade.

### Runtime

The returned `RallarMiddlewareRuntime` contains:

- `qboxEngine`: `InboxOutboxEngine` with WS and app-inbox tasks installed.
- `wsQBoxServerService`: websocket queuebox service.
- `inboxQueueReader`: app-inbox queue reader.
- `appInboxResilience`: app-inbox resilience settings.
- `appGroupInboxService`: durable group mutation inbox.
- `appClientInboxService`: durable client mutation inbox.
- `clientsRepository`: client snapshot repository.
- `groupsRepository`: group snapshot repository.

### Options

Required:

- `inbox`: queuebox repository for inbound app/WS work.
- `createAppGroupInboxService(input)`: factory for the group app inbox service.
- `createAppClientInboxService(input)`: factory for the client app inbox service.
- `resilience.inbox`: resilience policy for inbox work.
- `clientsRepository`: client snapshot repository.
- `groupsRepository`: group snapshot repository.

Optional:

- `outbox`: queuebox repository for outbound work; defaults to `inbox`.
- `webSocketServer`: defaults to a new `JsonWebSocketServer`.
- `wsRuntimeName`: defaults to `default-qbox-server`.
- `targetResolver`: custom WS target resolver.
- `findGroupSnapshotByRef`, `findGroupSnapshotById`, `resolveGroupRef`: used by the default target resolver.
- `inboundStores`, `outboundStores`: AL runtime stores.
- `resilience.outbox`: defaults to `resilience.inbox`.
- `resilience.appInbox`: defaults to `resilience.inbox`.

### Middleware Example

```ts
const runtime = createRallarMiddleware({
  inbox: queueBox,
  outbox: queueBox,
  webSocketServer,
  wsRuntimeName: 'api-v1',
  findGroupSnapshotByRef: (ref) => groupSnapshotCache.findByRef(ref),
  inboundStores,
  outboundStores,
  createAppGroupInboxService: ({ inboxQueueReader, wsQBoxServerService }) =>
    new AppGroupInboxService(
      inboxQueueReader,
      resourceInboxRepository,
      resourceInboxResultsRepository,
      groupStateService,
      createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
      serverId,
    ),
  createAppClientInboxService: ({ inboxQueueReader, wsQBoxServerService }) =>
    new AppClientInboxService(
      inboxQueueReader,
      resourceInboxRepository,
      resourceInboxResultsRepository,
      clientStateService,
      createWsStateSyncPublisher(wsQBoxServerService, { serverId }),
      serverId,
    ),
  resilience: {
    inbox: resilienceInbox,
    outbox: resilienceOutbox,
  },
  clientsRepository,
  groupsRepository,
});

runtime.qboxEngine.start();
```

### Queue Engine Helpers

`includeWsQueueBoxEngineTasks(engine, wsQBoxServerService, resilienceInbox, resilienceOutbox)` installs WS inbox/outbox dequeue tasks.

`includeInboxQueueReaderEngineTasks(engine, inboxQueueReader, resilience)` installs app-inbox dequeue tasks.

Use these only if you are composing your own engine instead of calling `createRallarMiddleware`.

### Target Resolver

`createWsServerTargetResolver(webSocketServer, options?)` creates the default target resolver.

It supports:

- Direct peer routing by open websocket connection ID.
- Group routing through scoped group snapshots and active group presence sessions.
- Broadcast routing to room, state-sync recipients, or all open sockets depending on AL message scope.

Prefer `groupRef`-aware messages where possible. If only `groupId` is available, the resolver can fall back to `findGroupSnapshotById`, but scoped `GroupRef` avoids cross-workspace ambiguity.

## Server Facade Wrappers

Most applications should use `createRallarServerApplication(...)` or `createRallarServerFacade(...)` around the middleware runtime.

```ts
const rallarServer = createRallarServerApplication({
  runtime,
  routes: {
    ws: (app) => installWsRoutes(app),
    rest: [installAuthRoutes, installStateRoutes],
  },
});

rallarServer.system
  .useDefaultMiddlewareTopics()
  .useWebSocketLifecycle();

rallarServer.ws.mount(app);
rallarServer.rest.mount(app);
rallarServer.start();
```

The server facade exposes:

- `system.useDefaultMiddlewareTopics()`
- `system.useWebSocketLifecycle()`
- `ws.install()`
- `ws.defineTopic(definition)`
- `ws.removeTopic(selector)`
- `ws.on(selector, handler)`
- `ws.proxy(rule)`
- `ws.publish(message, fanout?)`
- `ws.status()`
- `data.define/open/lookupStore/closeStore(...)`
- repository manager operations under `data`
