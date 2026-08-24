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

1. [createRallarFacade](./rallar.ts#L246) delegates to
   [createBrowserRallarFacade](./rallar-runtime/composition.ts#L24).
2. [createBrowserRuntimeFoundation](./rallar-runtime/composition/browser-runtime-composition.ts#L61)
   creates the per-facade runtime ports and lifecycle coordinator.
3. [createBrowserStateComposition](./rallar-runtime/composition/browser-runtime-composition.ts#L107)
   creates [createRallarStateCacheReadPort](./rallar-runtime/state-store.ts#L32)
   before constructing both the room-state store and aggregate state store from
   that completed cache-read/observation port.
4. [createBrowserStateEventComposition](./rallar-runtime/composition/browser-runtime-composition.ts#L147)
   creates one [createRallarWsInbox](./rallar-runtime/ws-inbox.ts#L24)
   subscription capability from the completed connection runtime, then gives
   room events and people state events direct access to it.
5. [createBrowserSessionCoreComposition](./rallar-runtime/composition/browser-session-composition.ts)
   creates immutable session identity, Data, and completed connection/auth
   capabilities before state-event, transport, or product consumers receive them.
6. [createBrowserSessionProductComposition](./rallar-runtime/composition/browser-session-composition.ts)
   constructs startup and CRDT only after the completed session, rooms, people,
   and messaging capabilities exist.
7. The composer registers state and transport lifecycle participants through
   [registerBrowserStateLifecycle](./rallar-runtime/composition/browser-lifecycle-composition.ts#L29)
   and
   [registerBrowserTransportLifecycle](./rallar-runtime/composition/browser-lifecycle-composition.ts#L45),
   then returns the aggregate facade from
   [createBrowserFacadeAssembly](./rallar-runtime/composition/browser-facade-assembly.ts#L20).

State and state-event construction is complete-value construction: neither
room state nor room events reads a later-created state owner. Session/startup
construction still has its own distinct lifecycle boundary.

## State and event invocation timeline

1. [RoomEvents.onEvent](./rooms/room-events.ts#L137) registers a room-event
   listener and registers the room-event owner with the completed WS inbox.
2. [createRallarWsInbox](./rallar-runtime/ws-inbox.ts#L24) provides the WS inbox that receives
   messages, orders subscribed owners, and invokes the room-event handler.
3. [RoomEvents.dispatch](./rooms/room-events.ts#L152) validates a group event,
   filters it by room and scope, deduplicates it, then notifies matching room
   listeners.
4. [RallarStateEvents.onPeopleEvent](./rallar-runtime/state-events.ts#L132)
   registers the separate people-event owner; its WS handler validates,
   filters, deduplicates, and notifies client-event listeners.

## Runtime invocation and cleanup timeline

1. [setup](./rallar-runtime/startup.ts) configures
   the API base URL and defaults, then starts restored-session work.
2. [createRallarStartupController](./rallar-runtime/startup.ts)
   restores auth, connects when a session exists, and refreshes the requested
   room/people state.
3. [createRallarSessionController](./rallar-runtime/session.ts)
   owns connection state, auth expiry, 401 termination, and the public
   connection/auth operations.
4. Its disconnect operation detaches lifecycle participants, asks the completed
   [BrowserTransportRuntime](./connection/browser-transport-runtime.ts) to shut
   down pending or active middleware exactly once, clears room state, then emits
   disconnected lifecycle notification.
5. The transport runtime keeps best-effort shutdown ordering for heartbeat, RTC,
   multicast, QueueBox, and WebSocket resources while session ownership keeps
   auth timing and lifecycle notification visible.
