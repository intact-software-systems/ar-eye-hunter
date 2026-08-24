# Browser Runtime Navigation

The browser facade has one public compatibility entry and a capability-oriented
runtime composition. This map starts at production symbols so a reader can
trace construction, registration, invocation, and cleanup without consulting a
historical plan.

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

1. [createRallarFacade](./rallar.ts:246) delegates to
   [createBrowserRallarFacade](./rallar-runtime/composition.ts:24).
2. [createBrowserRuntimeFoundation](./rallar-runtime/composition/browser-runtime-composition.ts:57)
   creates the per-facade runtime ports and lifecycle coordinator.
3. [createBrowserStateComposition](./rallar-runtime/composition/browser-runtime-composition.ts:103)
   creates the room-state and state-store pair; its room-state consumers
   currently receive late-bound state-store reads.
4. [createBrowserStateEventComposition](./rallar-runtime/composition/browser-runtime-composition.ts:146)
   creates the WS inbox, room events, and state events; room-event consumers
   currently receive late-bound state-event reads.
5. [createBrowserSessionComposition](./rallar-runtime/composition/browser-session-composition.ts:48)
   creates data, session, connection/auth, startup, and CRDT capabilities. Its
   data/session/startup connections currently use late-bound controller values.
6. The composer registers state and transport lifecycle participants through
   [registerBrowserStateLifecycle](./rallar-runtime/composition/browser-lifecycle-composition.ts:29)
   and
   [registerBrowserTransportLifecycle](./rallar-runtime/composition/browser-lifecycle-composition.ts:45),
   then returns the aggregate facade from
   [createBrowserFacadeAssembly](./rallar-runtime/composition/browser-facade-assembly.ts:20).

The next owned correction is to construct completed state/event and
session/startup ports before a consumer receives them. The current late binding
is intentionally documented here; it is not yet repaired.

## Runtime invocation and cleanup timeline

1. [setup](./rallar-runtime/startup.ts:30) configures
   the API base URL and defaults, then starts restored-session work.
2. [createRallarStartupController](./rallar-runtime/startup.ts:30)
   restores auth, connects when a session exists, and refreshes the requested
   room/people state.
3. [createRallarSessionController](./rallar-runtime/session.ts:82)
   owns connection state, auth expiry, 401 termination, and the public
   connection/auth operations.
4. Its disconnect operation detaches lifecycle participants, clears room and
   middleware runtime state, then emits disconnected lifecycle notification.
5. Transport effects currently have two live shutdown owners:
   [shutdownApiMiddleware](./rallar-runtime/session.ts:545)
   and [shutdownMiddleware](./app-context.ts:103), reached again
   when [clearMiddleware](./app-context.ts:96) clears the global
   middleware. Both keep best-effort teardown semantics for stale transports.

The next owned correction gives transport teardown one stateful owner so WS,
QueueBox, RTC, multicast, media, heartbeat, state-cache, and lifecycle effects
remain observable exactly once while preserving the current public ordering.
