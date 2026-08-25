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
   [createBrowserRallarFacade](./rallar-runtime/composition.ts#L58).
2. [createBrowserRuntimeFoundation](./rallar-runtime/composition/browser-runtime-composition.ts#L68)
   creates the per-facade runtime ports and lifecycle coordinator.
3. [createBrowserStateComposition](./rallar-runtime/composition/browser-runtime-composition.ts#L110)
   creates [createRallarStateCacheReadPort](./rallar-runtime/state-store.ts#L54)
   before constructing both the room-state store and aggregate state store from
   that completed cache-read/observation port.
4. [createBrowserStateEventComposition](./rallar-runtime/composition/browser-runtime-composition.ts#L151)
   creates one [createRallarWsInbox](./rallar-runtime/ws-inbox.ts#L24)
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
2. [createRallarWsInbox](./rallar-runtime/ws-inbox.ts#L24) provides the WS inbox that receives
   messages, orders subscribed owners, and invokes the room-event handler.
3. [RoomEvents.dispatch](./rooms/room-events.ts#L152) validates a group event,
   filters it by room and scope, deduplicates it, then notifies matching room
   listeners.
4. [RallarStateEvents.onPeopleEvent](./rallar-runtime/state-events.ts#L161)
   registers the separate people-event owner; its WS handler validates,
   filters, deduplicates, and notifies client-event listeners.

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
