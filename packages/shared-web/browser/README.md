# Browser Runtime Navigation

`browser/rallar.ts` is the canonical full browser-facade entry, alongside
narrow capability entrypoints and a capability-oriented runtime composition.
This map starts at production symbols so a reader can trace construction,
registration, invocation, and cleanup without consulting a historical plan.

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "packages/shared-web/browser/rallar.ts",
    "symbol": "createRallarFacade"
  },
  "results": [
    {
      "path": "packages/shared-web/browser/rallar-runtime/composition/browser-facade-assembly.ts",
      "symbol": "createBrowserFacadeAssembly"
    }
  ],
  "failures": [
    {
      "path": "packages/shared-web/browser/rallar-runtime/session.ts",
      "symbol": "createRallarSessionController"
    }
  ]
}
```

## Construction and registration timeline

1. [createRallarFacade](./rallar.ts#L238) delegates to
   [createRallarFacade](./rallar-runtime/composition.ts#L58).
2. [createBrowserRuntimeFoundation](./rallar-runtime/composition/browser-runtime-composition.ts#L68)
   creates the per-facade runtime ports and lifecycle coordinator.
3. [createBrowserStateComposition](./rallar-runtime/composition/browser-runtime-composition.ts#L110)
   creates [createRallarStateCacheReadPort](./rallar-runtime/state-store.ts#L54)
   before constructing both the room-state store and aggregate state store from
   that completed cache-read/observation port.
4. [createBrowserStateEventComposition](./rallar-runtime/composition/browser-runtime-composition.ts#L151)
   creates one [createBrowserWebSocketInbox](./websocket/browser-websocket-inbox.ts)
   subscription capability from the completed connection runtime, then gives
   room events and people state events direct access to it.
5. [createBrowserSessionCoreComposition](./rallar-runtime/composition/browser-session-composition.ts)
   creates immutable session identity and Data. The public Data entry owns
   facade and scope lifecycle, while
   [RepositoryBackedRallarDataStore](./data/repository-backed-rallar-data-store.ts)
   owns repository reads, writes, clearing, and disposal. The session composer then
   [createRallarSessionController](./rallar-runtime/session.ts) constructs the
   completed transport-connection lifecycle, auth-session lifecycle, and public
   connection/auth operations in that order before any product consumer receives
   them.
6. [createBrowserMessagingComposition](./rallar-runtime/composition/browser-communication-composition.ts),
   [createBrowserRealtimeCoreComposition](./rallar-runtime/composition/browser-communication-composition.ts),
   and the granular feature compositions construct completed message, RTC,
   realtime, media, room, people, stats, call, and director capabilities
   directly. No grouping factory sits between a feature owner and the composer.
   Call signal routing lives in
   [BrowserRallarCallsController](./calls/browser-rallar-calls-controller.ts),
   while each accepted or started call creates one
   [BrowserCallSessionRuntime](./calls/browser-call-session-runtime.ts).
   Realtime composition delegates inbound subscriptions, sending, room
   readiness, and targeted channels to the four owners under
   [`realtime/`](./realtime/). RTC composition delegates connection and status
   operations to
   [BrowserRallarRtcController](./rtc/browser-rallar-rtc-controller.ts), lane
   waiting to [BrowserRtcWaitRuntime](./rtc/browser-rtc-wait-runtime.ts), and
   observation/diagnostics to the owners under
   [`rtc-diagnostics/`](./rtc-diagnostics/).
7. [createBrowserStartupComposition](./rallar-runtime/composition/browser-session-composition.ts)
   and [createBrowserCrdtComposition](./rallar-runtime/composition/browser-session-composition.ts)
   run only after their completed session, rooms, people, state, and messaging
   dependencies exist.
8. The composer registers state, transport, and media lifecycle participants through
   [registerBrowserStateLifecycle](./rallar-runtime/composition/browser-lifecycle-composition.ts#L31),
   [registerBrowserTransportLifecycle](./rallar-runtime/composition/browser-lifecycle-composition.ts#L47),
   and
   [registerBrowserMediaLifecycle](./rallar-runtime/composition/browser-lifecycle-composition.ts#L92),
   then returns the aggregate facade from
   [createBrowserFacadeAssembly](./rallar-runtime/composition/browser-facade-assembly.ts#L35).

State, state-event, session, and startup construction use completed values:
neither room state nor room events reads a later-created owner, and the auth
session lifecycle receives a completed transport connection lifecycle rather
than a callback to a future controller.

## State and event invocation timeline

1. [RoomEvents.onEvent](./rooms/room-events.ts#L137) registers a room-event
   listener and registers the room-event owner with the completed WS inbox.
2. [createBrowserWebSocketInbox](./websocket/browser-websocket-inbox.ts) provides the WS inbox that receives
   messages, orders subscribed owners, and invokes the room-event handler.
3. [RoomEvents.dispatch](./rooms/room-events.ts#L152) validates a group event,
   filters it by room and scope, deduplicates it, then notifies matching room
   listeners.
4. [RallarStateEvents.onPeopleEvent](./rallar-runtime/state-events.ts#L161)
   registers the separate people-event owner; its WS handler validates,
   filters, deduplicates, and notifies client-event listeners.

## Feature-owned HTTP and workflow paths

Browser HTTP starts from the operation's product owner. Generic request
execution and typed HTTP failures remain under [`api/`](./api/), but that
directory does not own product workflows.

- [createAndJoinStateGroup](./rooms/room-group-state-workflows.ts) translates
  room intent, then calls
  [createStateGroup](./rooms/room-group-state-http-api.ts) and
  [connectStateGroupPresenceSession](./rooms/room-group-state-http-api.ts).
  Both operations return an authoritative `GroupSnapshot`; rejected HTTP
  responses surface as `ApiHttpError` from
  [executeHttpRequest](./api/http-request.ts).
- [refreshStateSnapshots](./state-read/refresh-state-snapshots.ts) coordinates
  the client and group collection reads in
  [state-snapshot-http-api.ts](./state-read/state-snapshot-http-api.ts), then
  returns the validated `StateSnapshots` result.
- [refreshStateHeartbeat](./session/refresh-state-heartbeat.ts) owns heartbeat
  retry and missing-presence repair. Client-session HTTP lives in
  [client-session-http-api.ts](./session/client-session-http-api.ts), while
  room presence HTTP remains with the room group-state owner.
- [appointStateGroupDirector](./director/appoint-room-director.ts) owns director
  command policy and calls the dedicated appointment operation in
  [room-group-state-http-api.ts](./rooms/room-group-state-http-api.ts).
- Connection config and ICE reads live in
  [connection-http-api.ts](./connection/connection-http-api.ts), CRDT catch-up
  in [crdt-catch-up-http-api.ts](./crdt/crdt-catch-up-http-api.ts), topology and
  graph reads in [rtc-topology-http-api.ts](./rtc/rtc-topology-http-api.ts), and
  statistics reads in [rallar-stats-http-api.ts](./stats/rallar-stats-http-api.ts).

These paths keep request construction, the HTTP side effect, validation, and
the typed result or failure visible without crossing a feature-blind module.

## Runtime invocation and cleanup timeline

1. [setup](./rallar-runtime/startup.ts) configures
   the API base URL and defaults, then starts restored-session work.
2. [createRallarStartupController](./rallar-runtime/startup.ts)
   restores auth, connects when a session exists, and refreshes the requested
   room/people state.
3. [BrowserTransportRuntime.init](./connection/browser-transport-runtime.ts)
   starts [initialiseMiddleware](./middleware.ts), whose visible phases create
   runtime stores, WebSocket/QueueBox transport, RTC services/group ownership,
   initial state and topology hydration plus reopen resync, and heartbeat in
   that order.
4. [BrowserSessionAuthLifecycle](./session/session-auth-lifecycle.ts) owns auth
   expiry, 401 termination, login activation, logout/revoke, browser-local data
   cleanup, and auth notifications. It delegates transport work to the completed
   [BrowserSessionConnectionLifecycle](./session/session-connection-lifecycle.ts).
5. Connection disconnect detaches lifecycle participants, asks the canonical
   [BrowserTransportRuntime](./connection/browser-transport-runtime.ts) to shut
   down pending or active middleware exactly once, clears room state, then emits
   disconnected lifecycle notification.
6. The transport runtime keeps best-effort shutdown ordering for heartbeat, RTC,
   multicast, QueueBox, and WebSocket resources while session ownership keeps
   auth timing and lifecycle notification visible.

The browser transport storage and WebSocket owners are feature-colocated:

- [browser-al-runtime-identity.ts](./al-runtime/browser-al-runtime-identity.ts)
  owns the persisted database, store, and session-key names;
  [browser-al-runtime-stores.ts](./al-runtime/browser-al-runtime-stores.ts)
  owns session-scoped AL runtime store factories;
  [browser-al-runtime-cleanup.ts](./al-runtime/browser-al-runtime-cleanup.ts)
  owns IndexedDB scanning, expiry scheduling, and session cleanup.
- [browser-queuebox-persistence.ts](./queuebox/browser-queuebox-persistence.ts)
  owns the browser QueueBox repositories, durable store names, and expiry
  cleanup; [createBrowserQueueBoxEngine](./queuebox/create-browser-queue-box-engine.ts)
  owns engine construction and startup.
- [createBrowserWebSocketQueueBox](./websocket/create-browser-web-socket-queue-box.ts)
  owns WS inbox/outbox repositories, AL stores, queue tasks, initial connect,
  and reconnect activation.
- [BrowserRallarWsController](./websocket/browser-rallar-ws-controller.ts)
  owns public WS status, lifecycle observation, and wait cleanup.

The deleted root engine namespace exports and global WS/RTC message-router
wrappers had no verified production consumer. Public message send and receive
continue through the facade's message capability and its owned subscriptions;
there is no forwarding export for the deleted paths.

Connection initialization failures leave connection state idle and propagate an
`Error` to the caller. A 401 additionally ends the captured auth session once.
Manual logout preserves disconnect, revoke, and Data-cleanup failures in that
order while browser-local AL deletion remains best-effort. `start` and `setup`
return the restored session, connection status, middleware, and requested room
or people state through `RallarStartResult`.

## Canonical and deleted paths

The current public browser surface is `rallar.ts`, the five narrow
`rallar-*` entrypoints, `game/mod.ts`, and package `mod.ts`. Runtime consumers
follow the feature owners above. The deleted `rallar-runtime/compose.ts`,
`rallar-runtime/contracts.ts`, room/people/stats forwarding facade modules,
late-binding `read*`/`bind*` construction hooks, duplicate app-context shutdown
algorithm, forwarding factories, rename-only aliases, predecessor-only fallback
modes, and compatibility-only tests for those predecessor paths are not
navigation paths and have no replacement shim. RTC-with-WS fallback remains
current message delivery policy; it is not predecessor compatibility behavior.
