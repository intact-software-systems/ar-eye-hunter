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
2. [createDefaultBrowserRuntimeFoundation](./composition/browser-runtime-composition.ts)
   reads the page's WebCrypto and builds the IndexedDB publication-key store;
   [createBrowserRuntimeFoundation](./composition/browser-runtime-composition.ts)
   takes those two platform inputs and creates the per-facade runtime ports and
   lifecycle coordinator.
   [createBrowserParticipantCore](./composition/create-browser-participant-core.ts)
   then composes steps 3–5 and the messaging and realtime-core compositions of
   step 6, with the session's resync recovery, granted topics, topic
   subscriptions and publication verifier, over that foundation and the root's
   session QoS inputs; the product root and the black-box runtime root both
   call it.
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
   directly. The participant core is the one grouping between these owners and
   a composition root, because two roots share it; every other feature
   composition is called by the root itself.
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
  [sendApiHttpRequest](./api/send-api-http-request.ts).
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

Every browser HTTP request to api-v1 or the Relic server builds its headers with
`newApiRequestHeaders` in [send-api-http-request.ts](./api/send-api-http-request.ts),
which mints a fresh `x-request-id` trace per request, so a retry carries a new
trace; a caller that continues an earlier operation's trace names it in
`ApiRequestOptions.traceId`, which is validated before any fetch. [`point-read.ts`](./state-read/point-read.ts) and the Relic client use it
with their own `fetch`, because they need the raw `Response`, and read a failed
body with the same `readApiErrorBody`.

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
- Reply correlation is owned in [`messages/reply/`](./messages/reply/) and the delivery registry. A send takes an
  optional `corrId` (a non-empty string of at most 128 UTF-8 bytes, refused as `$.corrId`); absent, the message
  correlates as its `msgId`. A `RallarMessageHandle` carries `corrId`, `replyToMsgId` and
  `awaitReply<T>({ timeoutMs, signal? })`, which never throws and resolves `replied` (with the reply
  `RallarMessage<T>`), `timeout`, `aborted` or `undelivered`, each with the request's lifecycle. The reply timeout
  is the caller's own clock beside the ACK timeout and the message deadline: a `timeout` leaves the request alive,
  the first timeout ends every wait of the request, and a request deadline that lapses during the wait ends it
  `undelivered`. A reply that arrives after the deadline is still matched and kept, so a later `awaitReply` resolves
  `replied`.
  [BrowserMessageReplySlot](./messages/reply/browser-message-reply-slot.ts) is the reply side of one
  delivery-registry entry, so the registry's retention (terminal entries for 60 s, 512 entries; an entry with an
  open reply wait outlives the age rule) is its only bound; the slot is `open`, `replied`, `timed-out`, or
  `released` once retention drops the entry, and it keeps the first matched reply for a later wait.
  [BrowserMessageReplyInbox](./messages/reply/browser-message-reply-inbox.ts) is the WS any-message handler
  `message-replies` (order 15) that hands each message with `actions.replyToMsgId` to the registry, and the
  subscriptions skip replies, so no reply reaches an `onMessage` subscriber of its type. A dropped reply states
  `reply-late` or `reply-wrong-responder` on the session's inbound diagnostics port, payload-free (see the
  [inbound navigation map](../../shared/alm/inbound/README.md#replies-and-their-diagnostics)).
  `RallarMessage.reply(payload, { typeId?, ttlMs? })` goes through `BrowserRallarMessageSender.sendReply`, the one
  place that sets `replyToMsgId`: a WS unicast to the requester's session on the request's topic, in the room's id
  when the request named a room (the request's custom `contextId` is not used), on the `command` purpose's
  defaults. A request on a topic that WS cannot carry rejects `reply()` with the `$.topicId` issue. Replies travel
  over WS only: a reply that arrives over RTC is dropped with `reply-late` (cause `unobserved`) when the page subscribes to its type over RTC. Room and people
  event listeners take `RallarStateEventMessage<T>`, the message without `reply`, because those events replay
  locally. `messages.readUsage()` returns `RallarMessagesUsage`, the volatile ledger report with `repliesHeld`
  (retained entries holding a matched reply), `replyWaitsOpen` (reply waits in flight), `publication` (the live
  channels' stage), `ordering` (`ALInboundOrderingCounters`: the connect's `entered`, `omitted`, `witnessed` and
  `beforeEntry` position events, counted by
  [`BrowserInboundOrderingCountersSink`](./connection/browser-inbound-ordering-counters-sink.ts), a tee around the
  connect's inbound diagnostics sink that both carriers share) and `edgeOrder` (what the page's edge-ordered
  channels keep and gave up; see edge order below).
- Trace identity rides the envelope's `id.traceId`. A send takes an optional `traceId`, checked by
  [`browser-message-input-validator.ts`](./messages/browser-message-input-validator.ts) against the trace grammar
  (1 to 128 characters of `[A-Za-z0-9_-]`, refused as `$.traceId` before anything is queued); absent, the envelope
  builder mints one per send. The fallback, the post-admission hand-over, repair and checkpoint restore re-send that
  envelope, so they keep its trace. `RallarMessageHandle.traceId` is read from the envelope when the delivery
  registry opens the observation, and `RallarMessage.traceId` from the received envelope. `sendReply` copies the
  request's trace into the reply ([`to-browser-reply-send-input.ts`](./messages/reply/to-browser-reply-send-input.ts)).
- Edge order is owned in [`messages/edge-order/`](./messages/edge-order/). A room channel declared
  `order: 'edge'` hands one sender page's messages to this page's handlers in the order that page called `send`,
  whichever carrier each came over. No hop orders them: the messages travel as unordered messages and the two ends
  do the work, in memory.
  - **Send.** [EdgeOrderSendStreams](./messages/edge-order/edge-order-send-streams.ts) keeps one stream per channel
    (topic and type) and room, with an id minted in memory, never from the session id: a reload or another tab is a
    new stream. `BrowserRallarMessageSender` takes the send's position in the application's own call, after the
    send's options passed validation and before the connect is awaited, so a refused send takes none. When the
    message is built, [EdgeOrderSender](./messages/edge-order/edge-order-sender.ts) states the stamp: the stream,
    the position, the lowest position still open, how long an earlier open send can still arrive, and the holes
    between the lowest open position and its own. The payload is wrapped as
    `{ "edgeOrder": <stamp>, "payload": <the application's payload> }`
    ([`edge-order-wire-payload.ts`](./messages/edge-order/edge-order-wire-payload.ts)) before the message is
    created, so a publisher proof would sign it, and the payload limit counts the wrapper.
  - **How a send ends, as receivers are told.** The stream reads each open send from its handle when it stamps the
    next one, with no listener or timer. `acknowledged` ends it as delivered: every recipient has it, so it is
    neither open nor a hole. `rejected`, `cancelled`, `expired` and `superseded`, and any send past its deadline,
    end it as a hole: nothing of it can be handed over any more. A `failed` or `unobservable` send stays open
    until its deadline, because a copy can still be on its way, and is a hole from then on. A send that fails
    before it has a handle, or whose handle is refused at once, gives its position to the next send when no later
    send has taken one, and is a hole otherwise. A stamp states at most 16 runs of holes, the lowest first; a hole
    above them is stated by a later stamp once those are passed, and until then it is waited for like any missing
    message. A hole leaves the stamps when every send below it has ended, because the lowest open position then
    says it. A stamp with no hole carries no `holes` field.
  - **Receive.** `BrowserRallarMessageSubscriptions.dispatch` passes every message of a declared topic and type to
    [EdgeOrderArrivals](./messages/edge-order/edge-order-arrivals.ts), which unwraps it and runs it through one
    [EdgeOrderReceiver](./messages/edge-order/edge-order-receiver.ts) that both carriers share. The page listens
    on both carriers for a declared channel, whichever the application handles, so a stream is sorted whole. A
    released message goes to the listeners of the carrier it arrived on. One stream's messages are handed over
    one at a time, through [KeyedSerialRuns](../../shared/resilience/keyed-serial-runs.ts): an async handler
    finishes a message before any handler is given the next of that stream, and another stream's turns do not
    wait for it. A message whose deadline passes while it waits behind its stream's handler is not handed over:
    its position is a `held-message-expired` gap. The handler's `payload` is the application's own;
    `message.order` is `{ stream, position }`; `message.raw` is the envelope as it travelled, wrapper included.
  - **Gaps.** A receiver waits for a missing position only while it can still arrive. It skips at once a
    position that a stamp it has says is over: one below the lowest open position, or a hole stated by a message
    it holds. A message it holds is never skipped, so a send cancelled after a copy arrived is still handed over.
    Each run of positions given up is reported once to the `onOrderGap` its channel declared, as a
    `RallarMessageOrderGap` (topic, type, sender, stream, positions, reason), in the stream's turn: after the
    handlers of the message before it and before those of the message after it. The latest `onOrderGap` declared
    for a topic and type stands, for every room, as the latest `recovery` does; what it throws or rejects with is
    logged and does not stop the stream. The reasons are `ended-at-sender` and `cannot-arrive` (the message could
    no longer arrive), `held-message-deadline`, `channel-wait-cap`, `held-message-cap`, `held-byte-cap` and
    `stream-cap` (a bound of this page was reached; the message is dropped as late if it still arrives), and
    `held-message-expired` (the position arrived and was held past its own deadline).
  - **A reload, a second tab and a late joiner.** A sender's streams are independent. A reloaded page, or another
    tab of the same login, sends on a new stream that starts at once at its receivers and neither closes nor waits
    for any other stream, so each stream is in its own order and nothing orders two streams against each other. A
    receiver whose first message of a stream is past position 1 waits its entry window (500 ms) for earlier ones,
    unless the sender says nothing earlier can still arrive, and then starts at the lowest message it holds, with
    no gap report. A message from before its entry that reaches it later is dropped as `late` and counted.
  - **What is not handed over** is stated in the connect's inbound diagnostics: `edge-order-arrival` for an
    arrival that is `held` for its turn or dropped (`unwrapped`, `late`, `duplicate`, `expired`), `edge-order-gap`
    for positions the receiver gave up, with its channel and reason, and `edge-order-held-dropped` when the
    connect goes away and the held messages with it (the `edge-order-held-messages` lifecycle participant). A
    stream keeps its position across that, so a copy of a message already handed over stays late.
  - **Memory.** A receiver holds at most 256 messages and 1 MiB per stream, each until its own deadline at the
    latest, and follows 256 streams. A stream it follows is never forgotten for being quiet: one that resumes after
    a pause is still sorted by the gap rule, not entered anew. At the 256-stream cap the least recently heard
    stream that holds nothing is pushed out, and its position is kept in one of 256 records, so a late copy of a
    message it handed over stays late and it goes on where it stood when it is heard again. Past 256 records the
    oldest goes, and that stream enters as new. The send side keeps 256 streams, one per channel and room, the one
    sent on least recently going first, and per stream its open sends and the holes it still states: a send leaves
    the table when it ends, at the latest at its deadline, which the stream reads when it stamps its next send and
    when usage is read. No count caps that table. `messages.readUsage().edgeOrder` (`RallarEdgeOrderUsage`) gives
    what is kept at the read (`streams`, `heldMessages`, `evictedStreams`, `sendStreams`, `openSends`) and what was
    given up since the page loaded (`lateDrops`, `gaps`, `heldDropped`). An idle page holds no message and has no
    open send; its stream and record counts stay where the caps left them.
  - **Refused as `unsupported`**, at the definition: a `live` channel, a `granted` channel, a channel with a
    durability other than `volatile`, `channel(...)` without a room, and `onOrderGap` on a channel that declares no
    order. At the send, before it takes a position: `reliability: 'best-effort'`, `ack: 'none'` or
    `'group-leader'`, a `qos.delivery` other than at-least-once, a `qos.ack` other than `receiver`,
    `exceptPeerIds`, `recipientPeerIds`, `principalId`, `peerId` (the server included), a `scope` other than
    `room`, `orderingKey`, `seq`, `qos.supersedence`, a `qos.durability` other than `volatile`, and the
    `ws-then-rtc` strategy. A granted channel still waits: a late subscriber is a late joiner, which is now
    handled, but its wrapped payload has not been proven through the publisher proof and the `subscribe` election.
  - **Limits.** Both ends must declare the channel: a receiver that did not is given the wrapped payload in
    arrival order, and a receiver that did drops a message without a stamp. The declaration, and with it
    `onOrderGap`, is per topic and type on a page, for every room; a gap report names its stream, and a stream
    belongs to the one room its messages carry. A hole is closed by a later message that states it: when the
    sender sends nothing more, a receiver waits for a missing message until the time the last stamp gave it. A
    receiver waits until the latest deadline among the sender's earlier open sends, not the missing message's
    own. A sender reads `acknowledged` when every recipient has admitted the message, which can be before a
    recipient's own sorter has it: a later message that says so, and overtakes it inside that recipient, makes
    the receiver skip it and drop it as late. Nothing is stored, so order restarts at a reload. A handler that
    never settles stops the later turns of its own stream, and, as a handler of any channel does, the deliveries
    of the carrier its message came over; a stream that arrives over the other carrier goes on.
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
