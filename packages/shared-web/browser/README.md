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
      "path": "packages/shared-web/browser/composition/browser-facade-assembly.ts",
      "symbol": "createBrowserFacadeAssembly"
    }
  ],
  "failures": [
    {
      "path": "packages/shared-web/browser/session/rallar-session-controller.ts",
      "symbol": "createRallarSessionController"
    }
  ]
}
```

## Construction and registration timeline

1. [createRallarFacade](./rallar.ts) delegates to
   [createRallarFacade](./composition/create-rallar-facade.ts).
2. [createBrowserRuntimeFoundation](./composition/browser-runtime-composition.ts)
   creates the per-facade runtime ports and lifecycle coordinator.
3. [createBrowserStateComposition](./composition/browser-runtime-composition.ts)
   creates [createRallarStateCacheReadPort](./state-cache/rallar-state-store.ts)
   before constructing both the room-state store and aggregate state store from
   that completed cache-read/observation port.
4. [createBrowserStateEventComposition](./composition/browser-runtime-composition.ts)
   creates one [createBrowserWebSocketInbox](./websocket/browser-websocket-inbox.ts)
   subscription capability from the completed connection runtime, then gives
   room events and people state events direct access to it.
5. [createBrowserSessionCoreComposition](./composition/browser-session-composition.ts)
   creates immutable session identity and Data. The public Data entry owns
   facade and scope lifecycle, while
   [RepositoryBackedRallarDataStore](./data/repository-backed-rallar-data-store.ts)
   owns repository reads, writes, clearing, and disposal. The session composer then
   [createRallarSessionController](./session/rallar-session-controller.ts) constructs the
   completed transport-connection lifecycle, auth-session lifecycle, and public
   connection/auth operations in that order before any product consumer receives
   them.
6. [createBrowserMessagingComposition](./composition/browser-communication-composition.ts),
   [createBrowserRealtimeCoreComposition](./composition/browser-communication-composition.ts),
   and the granular feature compositions construct completed message, RTC,
   realtime, media, room, people, stats, call, and director capabilities
   directly. No grouping factory sits between a feature owner and the composer.
   Call signal routing lives in
   [BrowserCallSignalRuntime](./calls/browser-call-signal-runtime.ts),
   while each accepted or started call creates one
   [BrowserCallSessionRuntime](./calls/browser-call-session-runtime.ts).
   Realtime composition delegates inbound subscriptions, sending/target
   policy, room readiness, targeted channels, and health reads to five owners
   under [`realtime/`](./realtime/). RTC composition uses
   [BrowserRallarRtcController](./rtc/browser-rallar-rtc-controller.ts) only to
   construct the public capability from the status, lifecycle, wait/readiness,
   room transport, and recovery owners under [`rtc/`](./rtc/), plus diagnostic
   collection under [`rtc-diagnostics/`](./rtc-diagnostics/).
7. [createBrowserStartupComposition](./composition/browser-session-composition.ts)
   and [createBrowserCrdtComposition](./composition/browser-session-composition.ts)
   run only after their completed session, rooms, people, state, and messaging
   dependencies exist.
8. The composer registers state, transport, and media lifecycle participants through
   [registerBrowserStateLifecycle](./composition/browser-lifecycle-composition.ts),
   [registerBrowserTransportLifecycle](./composition/browser-lifecycle-composition.ts),
   and
   [registerBrowserMediaLifecycle](./composition/browser-lifecycle-composition.ts),
   then returns the aggregate facade from
   [createBrowserFacadeAssembly](./composition/browser-facade-assembly.ts).

State, state-event, session, and startup construction use completed values:
neither room state nor room events reads a later-created owner, and the auth
session lifecycle receives a completed transport connection lifecycle rather
than a callback to a future controller.

## State and event invocation timeline

1. [RoomEvents.onEvent](./rooms/room-events.ts) registers a room-event
   listener and registers the room-event owner with the completed WS inbox.
2. [createBrowserWebSocketInbox](./websocket/browser-websocket-inbox.ts) provides the WS inbox that receives
   messages, orders subscribed owners, and invokes the room-event handler.
3. [RoomEvents.dispatch](./rooms/room-events.ts) validates a group event,
   filters it by room and scope, deduplicates it, then notifies matching room
   listeners.
4. [RallarStateEvents.onPeopleEvent](./people/browser-rallar-people-events.ts)
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
- [createRoomFormation](./rooms/formation/create-room-formation.ts) owns the room-bound formation
  handle over the public types in
  [rallar-room-formation-contracts.ts](./rooms/formation/rallar-room-formation-contracts.ts):
  [commandRoomFormation](./rooms/formation/command-room-formation.ts) posts the lifecycle commands
  through `commandLifecycle` in [room-group-state-http-api.ts](./rooms/room-group-state-http-api.ts)
  and accepts each receipt into the state cache;
  [room-formation-observation.ts](./rooms/formation/room-formation-observation.ts) projects the
  status from the snapshot and the two overlay slots of
  [createRoomLayoutSlots](./rooms/formation/room-layout-slots.ts) and derives the change and layout
  subscriptions from it; [waitForRoomLayout](./rooms/formation/wait-for-room-formation.ts) and its
  stage and condition siblings run on the shared
  [waitForSettledRead](./connection/wait-for-settled-read.ts) engine;
  [readRoomFormationView](./rooms/formation/read-room-formation-view.ts) fetches the formation view
  and decodes it with the shared `decodeGroupFormationView`;
  [toRoomFormationDenial](./rooms/formation/to-room-formation-denial.ts) classifies a thrown
  command error.
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

1. [setup](./session/rallar-startup-controller.ts) configures
   the API base URL and defaults, then starts restored-session work.
2. [createRallarStartupController](./session/rallar-startup-controller.ts)
   restores auth, connects when a session exists, and refreshes the requested
   room/people state.
3. [BrowserTransportRuntime.init](./connection/browser-transport-runtime.ts)
   starts [initialiseMiddleware](./connection/initialise-browser-middleware.ts),
   whose visible phases create
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
  owns the persisted database, store, and session-key names: one database per
  scope, `rallar-al-runtime:<applicationId>:<workspaceId>` with each part
  URI-encoded, and session-scoped keys inside;
  [browser-al-runtime-stores.ts](./al-runtime/browser-al-runtime-stores.ts)
  owns session-scoped AL runtime store factories over the database of the scope
  the connect resolved, whose durable pairs are always IndexedDB;
  [browser-al-storage-availability.ts](./al-runtime/browser-al-storage-availability.ts)
  owns the connect's storage availability (`missing` without IndexedDB, any
  other cause re-decided by the next durable admission), the checkpoint lane's
  skip (`missing`, or a checkpoint store whose health reads `failing`, for a lag
  beyond its bound or any other cause, until that store reads `healthy` or
  `delayed` again) and its
  one request for persistent storage, asked by the first durable or
  `local-checkpoint` admission;
  [browser-al-checkpoint-stores.ts](./al-runtime/browser-al-checkpoint-stores.ts)
  owns the connect's two checkpoint pairs, one per outbound carrier under the
  store ids `browser-ws-client-checkpoint:<sessionId>` and
  `browser-rtc-overlay-checkpoint:<sessionId>`: a memory pair a
  `local-checkpoint` admission goes to, whose writer checkpoints it into the
  scope's database while the connect owns the session's work. The browser
  composition sets `checkpointIntervalMs` and `checkpointLagBoundMs` on the store
  factory input, which default to `AL_CHECKPOINT_DEFAULT_SETTINGS` (1,000 ms and
  10,000 ms); no app-facing option exposes them yet. The pairs are built once per connect
  under its claim, after `configureBrowserALRuntimeStores` registered their
  factories beside each outbound scope's durable pair, and the WS client and the
  RTC overlay each take their own;
  [browser-page-lifecycle-flush.ts](./al-runtime/browser-page-lifecycle-flush.ts)
  is the one adapter of the page lifecycle: per connect, and only once the
  connect owns the session's work,
  [BrowserTransportRuntime.init](./connection/browser-transport-runtime.ts)
  listens for `visibilitychange` to hidden, `pagehide` and `freeze`, each of which
  starts both checkpoints without awaiting them, and removes the listeners when
  the connect ends. It flushes the two checkpoint ports `initialiseMiddleware`
  returns beside the middleware, which never carries them;
  [browser-al-runtime-cleanup.ts](./al-runtime/browser-al-runtime-cleanup.ts)
  owns IndexedDB scanning, expiry scheduling, and session cleanup over every
  scope's database that `indexedDB.databases()` lists, or the current scope's
  alone where the browser cannot list them; a failing database does not stop
  the others, and the first failure is rethrown after all were tried. The
  pre-scope database `ar-eye-hunter-al-runtime` is never opened or deleted; the
  browser evicts it.
- [browser-al-durable-work-claim.ts](./al-runtime/browser-al-durable-work-claim.ts)
  owns one connect's claim on its session's durable work in its scope: the Web
  Lock `rallar:al-durable-owner:<applicationId>:<workspaceId>:<sessionId>` (the
  scope's parts URI-encoded), requested once per connect by
  [BrowserTransportRuntime.init](./connection/browser-transport-runtime.ts)
  with the connect's own signal and released when the connect ends, after its
  runtimes stop, or when the connect fails. The tab it is granted to drains the
  session's durable lanes; every other tab admits and waits, and the next
  tab's lock is granted when the owner's connect ends, whose bootstrap batch
  takes over. Ownership turns true at most once per connect and never back
  while its runtimes live; a connect that fails after its WS transport is built
  leaves those runtimes owning (a carried limit).
  Without the Locks API, or when the request fails, every connect owns its
  work as before. The WS client, the RTC overlay and the RTC receiver hand it
  to their durable lanes only. A waiting tab's commit reaches the owner on the
  connect's session channel (below), and a foreign commit reaches a lane only
  while its connect holds the work.
- [browser-al-session-channel.ts](./al-runtime/browser-al-session-channel.ts)
  owns one `BroadcastChannel` per connect,
  `rallar-alm:<applicationId>:<workspaceId>:<sessionId>` with the scope parts
  URI-encoded, opened through the transport runtime's injected port factory
  behind the same missing-API guard as the Rallar Data and CRDT channels. The
  connect's durable work claim holds it and closes it on release. It carries
  two messages, each filtered by version, session key and the posting
  instance's echo: `committed`, the commit a waiting tab announced under a lane
  work type, which the claim hands to its lane of that work type
  (`applyForeignCommit`) only while it owns the work, so nothing is announced
  twice; and `settlement`, a durable lane's settlement a tab recorded for a
  message it holds no handle for, recorded once by the tab that holds it.
  Without `BroadcastChannel` a tab reaches no other tab, and a waiting tab's
  row waits for the owner's age-bound probe.
- [delete-ended-session-al-runtime-entries.ts](./session/delete-ended-session-al-runtime-entries.ts)
  purges an ended session's rows on logout, and a replaced session's rows after
  the disconnect on a login over it or a session switch in `connect`, when the
  session id differs; a failed purge reports failing `health` on the `storage`
  port for each of the session's stores, and the session ends anyway.
- [browser-al-work-cleanup.ts](./al-runtime/browser-al-work-cleanup.ts)
  selects canonical payload, identity and action rows in the shared admission
  QueueBox for expiry and session cleanup. The current scan visits the AL work
  range before selecting a session.
- [createBrowserQueueBoxEngine](./queuebox/create-browser-queue-box-engine.ts)
  owns engine construction and startup.
- [createBrowserWebSocketQueueBox](./websocket/create-browser-web-socket-queue-box.ts)
  owns WS AL store composition, initial connect,
  and reconnect activation.
- [BrowserRallarWsController](./websocket/browser-rallar-ws-controller.ts)
  owns public WS status, lifecycle observation, and wait cleanup.

The deleted root engine namespace exports and global WS/RTC message-router
wrappers had no verified production consumer. Public message send and receive
continue through the facade's message capability and its owned subscriptions;
there is no forwarding export for the deleted paths.

Message ownership is concentrated under [`messages/`](./messages/):

- [BrowserRallarMessagesController](./messages/browser-rallar-messages-controller.ts)
  constructs the completed capability and exposes its lifecycle owners.
- [BrowserRallarMessageSender](./messages/browser-rallar-message-sender.ts)
  owns RTC/WS envelope construction and scoped targets, returning a `RallarMessageHandle`
  immediately after submission. Every room send -- the RTC multicast, the WS room broadcast and the
  room broadcast a fallback send becomes -- carries `minSnapshotVersion` and `rosterVersion` from
  the cached room snapshot, read through one resolver of the
  [room state store](./rooms/room-state-store.ts); a send whose room has no cached snapshot
  carries neither, unless it states a floor, which then travels alone, and no caller sets the roster. Consumers await admission with `handle.wait(...)` and inspect
  its lifecycle; the delivery registry observes carrier settlements in memory. Each connect's
  settlement epoch ([`BrowserDeliverySettlements`](./connection/browser-delivery-settlements.ts))
  relays once, on the session channel, a durable lane's settlement for a msgId this tab holds no
  handle for: the owner tab sends every tab's durable messages, and any tab may admit the
  acknowledgement of one. A volatile lane's settlement, and one no lane stated, stays in its tab.
  The receiving tab records it through its own observers, which ignore a msgId they never opened,
  and never relays it again. A handle's `cancel()` reaches only its own tab's carriers.
- [BrowserTypedMessageChannels](./messages/browser-typed-message-channels.ts)
  owns typed channels and the current RTC-with-WS and WS-then-RTC policies. A
  channel definition's optional `recovery: RallarChannelRecovery` names the
  application's owner of resynchronization, `onResyncRequired(cursor)`, which
  `channel(...)` registers by route (topic and type, or type alone) in
  [BrowserChannelRecoveryOwners](./messages/browser-channel-recovery-owners.ts);
  the latest declaration for a route stands.
- [BrowserResyncRecovery](./messages/browser-resync-recovery.ts) is the
  `onResyncRequired` sink of the WS and RTC inbound runtimes, composed before
  the session by `createBrowserResyncRecoveryComposition` in
  [browser-communication-composition.ts](./composition/browser-communication-composition.ts).
  When an inbound runtime can no longer order a sender's messages it hands the
  sink the refused message and its `ALInboundResyncCursor`; the sink invokes the
  message's route owner once per ordering track (ordering key, sender, epoch)
  while the track goes on resynchronizing (the sink forgets a track 5 minutes
  after its last resynchronization, and remembers at most 256 tracks, the first
  remembered leaving first, D191), states `recovery-owner-invoked` with that cursor
  on the `storage` diagnostics port even when the owner throws (the error is
  logged), and states nothing for a route without an owner, whose message is
  dropped as before. A new epoch is a new track; a reload invokes the owner
  again.
- [BrowserRallarMessageSubscriptions](./messages/browser-rallar-message-subscriptions.ts)
  owns selector registries, WS inbox lifetime, RTC callback lifetime, and
  listener delivery.
- [`rallar-message-contracts.ts`](./messages/rallar-message-contracts.ts),
  [`rallar-message-selectors.ts`](./messages/rallar-message-selectors.ts), and
  [`to-rallar-message.ts`](./messages/to-rallar-message.ts) keep the public
  contracts and wire-to-facade translation beside those runtime owners.

Obsolete contract, selector, and message-conversion paths were deleted after
every verified consumer moved; no old-path re-export or forwarder remains.

Connection initialization failures leave connection state idle and propagate an
`Error` to the caller. A 401 additionally ends the captured auth session once.
Manual logout preserves disconnect, revoke, and Data-cleanup failures in that
order while browser-local AL deletion remains best-effort. `start` and `setup`
return the restored session, connection status, middleware, and requested room
or people state through `RallarStartResult`.

## Canonical and deleted paths

The current public browser surface is `rallar.ts`, the five narrow
`rallar-*` entrypoints, `game/mod.ts`, and package `mod.ts`. Runtime consumers
follow the feature owners above. Obsolete forwarding facade modules,
late-binding construction hooks, duplicate shutdown ownership, forwarding
factories, rename-only aliases, predecessor-only fallback modes, and
compatibility-only tests are not navigation paths and have no replacement
shim. RTC-with-WS fallback remains current message delivery policy; it is not
predecessor compatibility behavior.
