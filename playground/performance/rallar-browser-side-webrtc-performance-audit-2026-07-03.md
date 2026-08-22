# Rallar Browser-Side WebRTC Performance Audit

Date: 2026-07-03

Source context:

- [`rallar-webrtc-performance-map-2026-07-02.md`](rallar-webrtc-performance-map-2026-07-02.md)
- [`rallar-webrtc-static-performance-audit-2026-07-02.md`](rallar-webrtc-static-performance-audit-2026-07-02.md)
- [`rallar-webrtc-datachannel-backpressure-audit-2026-07-02.md`](rallar-webrtc-datachannel-backpressure-audit-2026-07-02.md)
- [`rallar-webrtc-media-pipeline-cpu-memory-audit-2026-07-02.md`](rallar-webrtc-media-pipeline-cpu-memory-audit-2026-07-02.md)

Scope: static analysis only. No production code was edited, no destructive
commands were run, and no browser profiling or benchmarks were performed.

Focus: browser-side WebRTC lifecycle, main-thread work, component ownership,
local/remote media track attachment, DataChannel/WebSocket handlers, stats and
status diagnostics, reconnect timers, event listeners, and background behavior.

Confidence labels:

- Proven from code: the cited code directly shows the cost shape or lifecycle
  behavior.
- Strong suspicion: the static shape is risky, but runtime impact depends on
  message rate, peer count, room size, browser, or UI subscription patterns.
- Needs runtime measurement: the code path is plausible, but the actual cost or
  retention needs DevTools, heap snapshots, counters, or WebRTC internals.

## Executive Summary

Top browser-side WebRTC risks:

1. Raw `facade.media.setLocalStream(stream)` can replace sender tracks without
   stopping tracks from the previous raw stream. Managed media-source starts are
   safer because `RallarFacade.startMediaSource` calls `stopMediaSource(kind,
   false)` first.
2. High-frequency realtime messages do browser-thread parse, allocation,
   callback dispatch, and sometimes React state updates per message.
3. Realtime room sends serialize once per peer and can repeat room/transport
   status resolution on hot gameplay paths.
4. ICE candidates received before remote description are queued without an
   explicit bound or dedupe.
5. WebRTC signaling, RTC application messages, and heartbeat paths contain
   verbose JSON/string logging on potentially hot browser paths.
6. Recurring background loops for browser QueueBox and AL runtime expiry are
   singleton loops but have no visible cancel or visibility-throttle hook.

Positive controls observed:

- Peer close clears `RTCPeerConnection` event handlers, removes the stored
  `icegatheringstatechange` listener, closes the peer connection, and clears
  reconnect/disconnect timers in
  [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L193).
- DataChannel close/error clears queued sends and nulls browser channel handlers
  in [`QRtcDataChannel.setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L454)
  and [`QRtcDataChannel.clearDataChannelReference`](../../packages/shared/webrtc/QRtcDataChannel.ts#L515).
- Facade disconnect unregisters WebRTC/WS callbacks, stops local media sources,
  and shuts down middleware in
  [`RallarFacade.disconnectConnection`](../../packages/shared-web/browser/rallar.ts#L4225).
- Middleware shutdown stops heartbeats, disconnects known peers, stops local
  peer media, stops QueueBox, and closes the WebSocket queuebox in
  [`shutdownMiddleware`](../../packages/shared-web/browser/app-context.ts#L102).
- Managed media-source start stops the existing same-kind source before capture
  in [`RallarFacade.startMediaSource`](../../packages/shared-web/browser/rallar.ts#L5431).
- Default realtime DataChannel flow control is unordered/unreliable with
  `bufferedAmount` thresholds and a bounded keyed queue in
  [`DEFAULT_REALTIME_DATA_CHANNEL_LANE`](../../packages/shared-web/browser/middleware.ts#L72).

## Client WebRTC Lifecycle Map

### 1. Runtime connect and browser middleware creation

`RallarFacade.connectConnection` resolves the authenticated session, starts
middleware, registers state/message/status/realtime/remote-stream callbacks, and
emits initial WS/RTC lifecycle events
([`packages/shared-web/browser/rallar.ts#L4084`](../../packages/shared-web/browser/rallar.ts#L4084)).

`initialiseMiddleware` then creates the browser WebSocket client, QueueBox
engine, WebSocket QueueBox service, ICE config, WebRTC connection service,
overlay multicast manager, and RTC RX streamer
([`packages/shared-web/browser/middleware.ts#L137`](../../packages/shared-web/browser/middleware.ts#L137)).

### 2. Signaling and peer creation

`WebRtcConnectionService.computeRtcPeerDtoIfAbsent` owns browser-side peer DTO
creation: it constructs `QRtcPeerConnection`, DataChannel lanes, and
`QRtcMediaChannel`, stores the DTO in `peerDtoByPeerId`, and emits peer lifecycle
creation callbacks
([`packages/shared/services/WebRtcConnectionService.ts#L932`](../../packages/shared/services/WebRtcConnectionService.ts#L932)).

`QRtcPeerConnection.connect` creates `new RTCPeerConnection`, attaches
`onnegotiationneeded`, `onicecandidate`, `ondatachannel`, `ontrack`, and state
callbacks
([`packages/shared/webrtc/QRtcPeerConnection.ts#L276`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L276)).

### 3. Active data and signaling flow

Browser WebSocket signaling messages are parsed and delivered serially through
`JsonWebSocketClient.openSocket`
([`packages/shared/websocket/JsonWebSocketClient.ts#L157`](../../packages/shared/websocket/JsonWebSocketClient.ts#L157)).
QueueBox-delivered WS inbox entries parse `entry.resource` again in
`WsQueueBoxClientService.dispatchInboxEntry`
([`packages/shared/services/WsQueueBoxClientService.ts#L533`](../../packages/shared/services/WsQueueBoxClientService.ts#L533)).

DataChannel inbound messages enter `QRtcDataChannel.setupDataChannelCallbacks`,
dispatch raw callbacks, parse JSON for typed callbacks, then await callbacks
sequentially
([`packages/shared/webrtc/QRtcDataChannel.ts#L410`](../../packages/shared/webrtc/QRtcDataChannel.ts#L410)).
Facade realtime JSON dispatch parses, constructs a message object, and
`Promise.all`s listeners in
[`RallarFacade.dispatchRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L8048)
and [`RallarFacade.notifyRealtimeListeners`](../../packages/shared-web/browser/rallar.ts#L8101).

### 4. Active media flow

Managed browser capture uses `navigator.mediaDevices.getUserMedia` for
microphone/camera and `getDisplayMedia` for screen sharing in
[`RallarFacade.captureMediaSource`](../../packages/shared-web/browser/rallar.ts#L5469).
Managed sources are composed into a `MediaStream` and sent to peers through
[`RallarFacade.attachLocalMediaSources`](../../packages/shared-web/browser/rallar.ts#L5617),
[`WebRtcRxStreamerService.setLocalMediaStream`](../../packages/shared/services/WebRtcRxStreamerService.ts#L414),
and [`QRtcPeerConnection.setLocalMediaStream`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L776).

Remote track arrival is handled by `pc.ontrack`, which stores the remote stream
and awaits registered remote stream and track callbacks
([`packages/shared/webrtc/QRtcPeerConnection.ts#L362`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L362)).
`WebRtcRxStreamerService.addPeer` relays remote streams to facade listeners
([`packages/shared/services/WebRtcRxStreamerService.ts#L143`](../../packages/shared/services/WebRtcRxStreamerService.ts#L143)).

The inspected browser WebRTC media path is track-based. No WebRTC-specific
per-frame `MediaStreamTrackProcessor`, `requestVideoFrameCallback`, canvas copy,
ImageBitmap, WebAssembly, or insertable stream pipeline was found in the cited
media facade and peer-connection paths.

### 5. Reconnect and renegotiation

`QRtcPeerConnection.connect` gates `onnegotiationneeded` with `makingOffer` and
`pc.signalingState !== 'stable'`
([`packages/shared/webrtc/QRtcPeerConnection.ts#L298`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L298)).
Inbound signaling is serialized through `signalingChain` in
[`QRtcPeerConnection.handleSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L477).

Disconnect state schedules a 5-second disconnect timer before reconnect logic
in [`QRtcPeerConnection.scheduleDisconnectTimer`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L747).
Reconnect uses a single reconnect timer guard, exponential delay, and
`pc.restartIce()` in [`QRtcPeerConnection.handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L614).

WebSocket reconnect has a single reconnect task guard and fixed jitter ratio of
0 in [`WsQueueBoxClientService.reconnect`](../../packages/shared/services/WsQueueBoxClientService.ts#L378)
and [`WsQueueBoxClientService.toReconnectPolicy`](../../packages/shared/services/WsQueueBoxClientService.ts#L435).

### 6. Close and dispose

Normal facade disconnect unregisters callbacks, stops local sources, and shuts
down middleware
([`packages/shared-web/browser/rallar.ts#L4225`](../../packages/shared-web/browser/rallar.ts#L4225)).
Peer deletion clears establishment state, calls peer lifecycle deletion
callbacks, resets media, resets all channels, resets the peer connection, and
deletes the peer DTO map entry in
[`WebRtcConnectionService.removePeerIfPresent`](../../packages/shared/services/WebRtcConnectionService.ts#L305).

`QRtcMediaChannel.reset` unsubscribes from peer callbacks and replaces the remote
stream map
([`packages/shared/webrtc/QRtcMediaChannel.ts#L50`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L50)).
`QRtcDataChannel.reset` resolves open waiters, closes the active channel, clears
the send queue, and returns the state to idle
([`packages/shared/webrtc/QRtcDataChannel.ts#L159`](../../packages/shared/webrtc/QRtcDataChannel.ts#L159)).

## Component and Resource Ownership Table

| Resource                               | Created at                                                                                                                                                                                                               | Owner                                                                     | Intended lifetime                      | Cleanup path                                                                                                                                                                                                                             | Browser-side risk                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Browser middleware context             | [`RallarFacade.connectConnection`](../../packages/shared-web/browser/rallar.ts#L4084), [`initialiseMiddleware`](../../packages/shared-web/browser/middleware.ts#L137)                                                    | Singleton facade/runtime context                                          | Authenticated browser session          | [`RallarFacade.disconnectConnection`](../../packages/shared-web/browser/rallar.ts#L4225), [`shutdownMiddleware`](../../packages/shared-web/browser/app-context.ts#L102)                                                                  | Low if `facade.disconnect()` is called; component unmount without facade disconnect can leave singleton session intentionally alive. |
| WebSocket client                       | [`initialiseMiddleware`](../../packages/shared-web/browser/middleware.ts#L161), [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L100)                                          | `WsQueueBoxClientService`                                                 | Middleware lifetime with reconnect     | [`WsQueueBoxClientService.close`](../../packages/shared/services/WsQueueBoxClientService.ts#L338), [`JsonWebSocketClient.close`](../../packages/shared/websocket/JsonWebSocketClient.ts#L242)                                            | Main-thread JSON parse/callback dispatch on every WS message.                                                                        |
| QueueBox engine timer                  | [`initialiseMiddleware`](../../packages/shared-web/browser/middleware.ts#L170)                                                                                                                                           | Middleware                                                                | Middleware lifetime                    | [`InboxOutboxEngine.stop`](../../packages/shared/services/InboxOutboxEngine.ts#L54), called by [`shutdownMiddleware`](../../packages/shared-web/browser/app-context.ts#L119)                                                             | Low cleanup risk; runtime cost depends on queue volume.                                                                              |
| Browser expiry loops                   | [`initBrowserQueueBoxExpiryEviction`](../../packages/shared-web/browser/browser-queuebox.ts#L123), [`initBrowserALRuntimeExpiryEviction`](../../packages/shared-web/browser/browser-al-runtime-stores.ts#L249)           | Module-level singleton promises                                           | Browser page lifetime                  | No exposed cancel handle in [`tryRunInIntervals`](../../packages/shared/resilience/TryWith.ts#L301)                                                                                                                                      | Proven long-lived timers; impact in background tabs needs measurement.                                                               |
| `RTCPeerConnection`                    | [`QRtcPeerConnection.connect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L276)                                                                                                                                  | `QRtcPeerConnection`, stored in `WebRtcConnectionService.peerDtoByPeerId` | Per remote peer                        | [`WebRtcConnectionService.removePeerIfPresent`](../../packages/shared/services/WebRtcConnectionService.ts#L305), [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L193)            | Cleanup path is strong; retention risk is mainly from external references to peer DTOs/callback closures.                            |
| `RTCDataChannel`                       | [`QRtcDataChannel.connect`](../../packages/shared/webrtc/QRtcDataChannel.ts#L339)                                                                                                                                        | `QRtcDataChannel` per lane per peer                                       | Per peer/lane connection               | [`QRtcDataChannel.reset`](../../packages/shared/webrtc/QRtcDataChannel.ts#L159), close/error handlers at [`#L454`](../../packages/shared/webrtc/QRtcDataChannel.ts#L454)                                                                 | Active channel handlers are cleared; callback maps remain on the channel wrapper until wrapper GC.                                   |
| DataChannel send queue                 | [`QRtcDataChannel` fields](../../packages/shared/webrtc/QRtcDataChannel.ts#L141), [`RtcDataChannelSendQueue`](../../packages/shared/webrtc/RtcDataChannelSendQueue.ts#L35)                                               | `QRtcDataChannel`                                                         | Channel lifetime                       | [`QRtcDataChannel.reset`](../../packages/shared/webrtc/QRtcDataChannel.ts#L159), close/error at [`#L454`](../../packages/shared/webrtc/QRtcDataChannel.ts#L454)                                                                          | Queue is bounded, but `shift()` rebuilds the key index per flushed item.                                                             |
| Managed local media sources            | [`RallarFacade.startMediaSource`](../../packages/shared-web/browser/rallar.ts#L5431)                                                                                                                                     | `RallarFacade.localMediaSources`                                          | Until source handle stop or disconnect | [`stopMediaSource`](../../packages/shared-web/browser/rallar.ts#L5564), [`stopLocalMediaSourcesForKind`](../../packages/shared-web/browser/rallar.ts#L5586), disconnect at [`#L4247`](../../packages/shared-web/browser/rallar.ts#L4247) | Managed path stops existing same-kind source before new capture; risk is lower than raw stream path.                                 |
| Raw `MediaStream` via `setLocalStream` | [`RallarFacade.media.setLocalStream`](../../packages/shared-web/browser/rallar.ts#L4038), [`MediaConsolePanel.attachLocal`](../../apps/rallar-black-box/src/App.tsx#L23181)                                              | Caller plus `WebRtcRxStreamerService.status.localMediaStream`             | Caller-defined                         | [`RallarFacade.media.stopLocal`](../../packages/shared-web/browser/rallar.ts#L4050), peer stop in [`QRtcPeerConnection.stopLocalMedia`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L825)                                         | High risk if replaced or component unmounts without explicit stop.                                                                   |
| Remote streams                         | [`QRtcPeerConnection.ontrack`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L362), [`WebRtcRxStreamerService.addPeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L143)                             | Peer/media channel maps and facade listeners                              | Peer lifetime                          | [`QRtcMediaChannel.reset`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L50), [`WebRtcRxStreamerService.removePeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167)                                                 | Low ownership risk; React consumers can still re-render on each remote stream event.                                                 |
| Heartbeat intervals                    | [`WebRtcRxStreamerService.startRtcHeartbeats`](../../packages/shared/services/WebRtcRxStreamerService.ts#L224), [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L142) | `WebRtcRxStreamerService.heartbeatByPeerId`                               | Open RTC data channel lifetime         | [`WebRtcRxStreamerService.removePeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167), [`stopAllHeartbeats`](../../packages/shared/services/WebRtcRxStreamerService.ts#L181)                                            | Missed-ping threshold keeps interval alive while channel stays open; cleanup callback ownership is slightly unclear.                 |
| ICE candidate queue                    | [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L567)                                                                                                                            | `QRtcPeerConnection.status.iceCandidateQueue`                             | Before remote description is set       | [`flushIceCandidateQueue`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L600), peer reset                                                                                                                                          | No explicit cap or dedupe before remote description.                                                                                 |
| Realtime listeners                     | [`RallarFacade.onRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L3976), [`registerRealtimeCallbacksForPeer`](../../packages/shared-web/browser/rallar.ts#L8007)                                              | Facade listener maps plus channel raw callbacks                           | Subscription lifetime                  | Returned unsubscribe, [`deleteRealtimeLaneIfUnused`](../../packages/shared-web/browser/rallar.ts#L8116), disconnect                                                                                                                      | Hot listeners can cause per-message allocation and UI updates.                                                                       |
| Black-box React RTC realtime panel     | [`RtcRealtimePanel.addReceived`](../../apps/rallar-black-box/src/App.tsx#L20229)                                                                                                                                         | React component state and facade subscriptions                            | Panel lifetime                         | Unmount cleanup at [`App.tsx#L19990`](../../apps/rallar-black-box/src/App.tsx#L19990), explicit clear subscription                                                                                                                       | Arrays are bounded, but every message creates state, row ids, runtime events, and re-renders.                                        |
| Black-box media console                | [`MediaConsolePanel.attachLocal`](../../apps/rallar-black-box/src/App.tsx#L23181), [`subscribeRemote`](../../apps/rallar-black-box/src/App.tsx#L23248)                                                                   | React component plus singleton facade                                     | Panel/session lifetime                 | Remote unsubscribe at [`App.tsx#L23076`](../../apps/rallar-black-box/src/App.tsx#L23076), explicit `stopLocal` at [`#L23226`](../../apps/rallar-black-box/src/App.tsx#L23226)                                                            | Unmount only unsubscribes remote stream listener; it does not stop raw local stream capture.                                         |
| Relic Hunters realtime motion          | [`subscribeRelicScenePositionUpdates`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L146), [`sendRelicMotionSample`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L300)                          | Game scene runtime plus facade realtime channel                           | Scene lifetime                         | Subscription returns unsubscribe; scene effects return cleanup in [`RelicScene.tsx`](../../apps/relic-hunters-v1/src/game/RelicScene.tsx#L535)                                                                                           | High-rate motion path sends/receives realtime JSON and updates motion buffers on the main thread.                                    |

## Main-Thread CPU Risks

| Severity    | Confidence                | Location                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why it is costly                                                                                                                                                                                          | WebRTC impact                                                                                                       | How to validate                                                                                                           | Candidate fix to validate later                                                                                                                      |
| ----------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| High        | Strong suspicion          | [`RallarFacade.sendRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L3922), [`QRtcDataChannel.sendJson`](../../packages/shared/webrtc/QRtcDataChannel.ts#L238), [`sendRoomRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L5211), [`sendRelicMotionSample`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L300)                                                                                               | Room realtime sends resolve room/transport status, map peers, and call `sendJson` per ready peer; `sendJson` stringifies per peer.                                                                        | Broadcast cost is at least `O(peers * payload size)` for JSON serialization, plus readiness/status overhead.        | Count sends/sec, peer count, JSON bytes, `sendRealtimeJson` duration, and per-peer stringify samples during Relic motion. | Reuse room realtime channel objects on hot paths, cache room readiness briefly, and pre-serialize immutable payloads when sending to multiple peers. |
| High        | Strong suspicion          | [`QRtcDataChannel.setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L410), [`RallarFacade.dispatchRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L8048), [`notifyRealtimeListeners`](../../packages/shared-web/browser/rallar.ts#L8101)                                                                                                                                                                 | Inbound messages dispatch raw callbacks, parse JSON, allocate message envelopes, spread listener sets into arrays, and run listeners through `Promise.all`.                                               | High-rate DataChannel traffic can create main-thread CPU and allocation pressure.                                   | Chrome Performance profile with a high-rate RTC lane; record parse time, listener count, task duration, and messages/sec. | Coalesce high-rate listeners, reduce per-message envelope allocation, and prefer binary/compact payload only after measurements justify it.          |
| Medium-High | Proven from code          | [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L157), [`WsQueueBoxClientService.dispatchInboxEntry`](../../packages/shared/services/WsQueueBoxClientService.ts#L533)                                                                                                                                                                                                                               | WebSocket messages are `JSON.parse`d and callbacks are awaited serially on the browser thread; QueueBox inbox dispatch parses `entry.resource`.                                                           | Signaling, room, and presence bursts can block each other and delay WebRTC control flow.                            | Count WS messages, parse errors, callback duration, and long tasks during join/reconnect/ICE bursts.                      | Batch or defer non-critical message handling and keep signaling callbacks short.                                                                     |
| Medium-High | Proven from code          | [`QRtcPeerConnection.connect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L298), [`processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L490), [`sendSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L682), [`WebRtcRxStreamerService.addPeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L104), [`enableDefaultCallbacks`](../../packages/shared/services/WebRtcRxStreamerService.ts#L188) | Offer/answer/candidate payloads and RTC AL messages are JSON-stringified for logs; outbound RTC outbox logs include the full entry resource.                                                              | Negotiation storms, ICE bursts, or high-rate RTC messages pay CPU/GC/log I/O costs.                                 | Compare profiles and log volume with verbose logs enabled/disabled during connect and high-rate message tests.            | Gate full payload logs behind an explicit debug flag or sample them.                                                                                 |
| Medium      | Strong suspicion          | [`RtcDataChannelSendQueue.shift`](../../packages/shared/webrtc/RtcDataChannelSendQueue.ts#L76), [`rebuildIndexByKey`](../../packages/shared/webrtc/RtcDataChannelSendQueue.ts#L169), [`QRtcDataChannel.flushQueuedSends`](../../packages/shared/webrtc/QRtcDataChannel.ts#L648)                                                                                                                                                               | Each flushed queued send uses `items.shift()` and rebuilds the key index. Queue size is bounded, but flush cost is `O(queue size^2)` in the worst case for a full queue.                                  | During backpressure recovery, a peer can spend extra main-thread work draining queued realtime messages.            | Record queue length, flush count, flush duration, and `bufferedAmount` when a slow peer recovers.                         | Use an index cursor or deque-like structure if full-queue drain cost is measurable.                                                                  |
| Medium      | Strong suspicion          | [`WebRtcGroupManager.reconcileAllGroups`](../../packages/shared/services/WebRtcGroupManager.ts#L231), [`buildPeerOwners`](../../packages/shared/services/WebRtcGroupManager.ts#L157), [`onlinePeerIds`](../../packages/shared/services/WebRtcGroupManager.ts#L323), [`WebRtcGroupService.readCachedGroup`](../../packages/shared/services/WebRtcGroupService.ts#L156)                                                                         | Group reconcile scans groups, target peer ids, known peers, retained peers, and all cached client sessions; fallback group lookup scans all group cache values.                                           | Browser room/participant churn can cause main-thread spikes before peer connect/disconnect decisions.               | Instrument reconcile duration, group count, active session count, and cache scan count.                                   | Maintain scoped indexes for active sessions and group snapshots if large-room traces show p95 spikes.                                                |
| Medium      | Needs runtime measurement | [`RallarFacade.toRtcDiagnostics`](../../packages/shared-web/browser/rallar.ts#L6251), [`readSelectedCandidatePairDiagnostics`](../../packages/shared-web/browser/rallar.ts#L9224), [`RtcDiagnosticsPanel.runAction`](../../apps/rallar-black-box/src/App.tsx#L12901)                                                                                                                                                                          | Diagnostics can call `pc.getStats()`, materialize stats into arrays/maps, and scan candidate pairs per peer. The inspected black-box diagnostic action calls status/health, not continuous stats polling. | On-demand is acceptable; polling diagnostics during active calls could add browser-thread and WebRTC-internal work. | Count diagnostics frequency and measure `getStats()` duration with 1, 5, and 10 peers.                                    | Throttle diagnostics and avoid `getStats()` polling in gameplay or high-rate UI loops.                                                               |
| Medium      | Needs runtime measurement | [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L142), [`WebRtcRxStreamerService.startRtcHeartbeats`](../../packages/shared/services/WebRtcRxStreamerService.ts#L224)                                                                                                                                                                                                                      | Each peer heartbeat uses an interval, `performance.now()`, JSON stringify, and callback work. After max missed pings, the interval calls `onMissedHeartbeat` every tick while the channel remains open.   | Dead-but-open channels can keep async heartbeat work alive.                                                         | Count active heartbeat intervals, missed-heartbeat callback rate, and CPU during network pause/background tab tests.      | Stop or escalate channel cleanup after max missed pings if measurements show churn.                                                                  |
| Low-Medium  | Proven from code          | [`RallarFacade.dispatchRealtimeBinary`](../../packages/shared-web/browser/rallar.ts#L8076), [`toArrayBuffer`](../../packages/shared-web/browser/rallar.ts#L9715)                                                                                                                                                                                                                                                                              | `ArrayBuffer` is passed through, but `ArrayBufferView` payloads are copied with `slice()` and `Blob` payloads call `arrayBuffer()`.                                                                       | Binary realtime lanes can allocate per message for views/blobs.                                                     | Send `ArrayBuffer`, `Uint8Array`, and `Blob` bursts; compare allocation profiles.                                         | Preserve views where the API can expose `(buffer, byteOffset, byteLength)` without copying.                                                          |

## Memory Leak and Retained-Resource Risks

| Severity    | Confidence                | Location                                                                                                                                                                                                                                                                                                                                                                                          | Risk                                                                                                                                                                                                                                                                               | Why it matters                                                                                                                              | Validation                                                                                                                                                           |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High        | Proven from code          | [`RallarFacade.media.setLocalStream`](../../packages/shared-web/browser/rallar.ts#L4038), [`WebRtcRxStreamerService.setLocalMediaStream`](../../packages/shared/services/WebRtcRxStreamerService.ts#L414), [`QRtcPeerConnection.setLocalMediaStream`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L776), [`MediaConsolePanel.attachLocal`](../../apps/rallar-black-box/src/App.tsx#L23181) | Raw local streams can be replaced without stopping previous raw capture tracks. `replaceTrack` swaps sender tracks, but the old raw stream's tracks are not stopped by this path.                                                                                                  | Camera/microphone indicators and device capture can remain active after repeated attach/replace or panel unmount.                           | Monkey-patch `MediaStreamTrack.stop`, repeat Attach local stream 20 times, then inspect live tracks, camera indicator, `chrome://webrtc-internals`, and heap.        |
| Medium-High | Strong suspicion          | [`MediaConsolePanel` unmount cleanup](../../apps/rallar-black-box/src/App.tsx#L23076), [`stopLocal`](../../apps/rallar-black-box/src/App.tsx#L23226)                                                                                                                                                                                                                                              | The media console unmount cleanup unsubscribes only the remote stream listener; raw local stream stop is an explicit button action.                                                                                                                                                | Component unmount or navigation within the black-box app can leave local raw capture in the singleton facade.                               | Mount panel, attach stream, navigate/unmount without Stop, then check track `readyState`, device indicator, and facade media status.                                 |
| Medium-High | Proven from code          | [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L567), [`flushIceCandidateQueue`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L600)                                                                                                                                                                                                                | ICE candidates received before remote description are pushed into `iceCandidateQueue` with no explicit bound or duplicate check.                                                                                                                                                   | Glare, reconnect, or stale signaling can grow per-peer queues and then flush many candidates serially.                                      | Track `iceCandidateQueue.length`, duplicate candidate count, and flush duration during delayed-answer and reconnect tests.                                           |
| Medium      | Strong suspicion          | [`WebRtcRxStreamerService.addPeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L113), [`removePeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167), [`QRtcDataChannel.reset`](../../packages/shared/webrtc/QRtcDataChannel.ts#L159), [`QRtcDataChannel.clearCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L166)                                    | Heartbeat lifecycle callbacks are registered with `onRtcCallbacksDo`, but `removePeer` removes the heartbeat id through `removeOnRtcMessageCallbackById`. Channel reset does not clear callback maps, although the wrapper should normally become unreachable after peer deletion. | If old peer/channel wrappers are retained by a lifecycle closure or diagnostic object, callback maps may retain heartbeat/service closures. | After repeated peer deletion, inspect retained `QRtcDataChannel` objects and `readHealth()` callback counts, and verify no external references to deleted peer DTOs. |
| Medium      | Needs runtime measurement | [`startCall`](../../packages/shared-web/browser/rallar.ts#L5917), call `end` cleanup at [`#L6047`](../../packages/shared-web/browser/rallar.ts#L6047)                                                                                                                                                                                                                                             | Call cleanup is handle-driven. If a component drops a call handle without calling `end`, media and peer resources depend on broader facade disconnect/stop paths.                                                                                                                  | Call-specific UI ownership can leak active media or peer state if lifecycle code misses `end`.                                              | Add a browser test that starts a call, unmounts the owner without `end`, and checks peer/track/channel counts.                                                       |
| Low-Medium  | Proven from code          | [`initBrowserQueueBoxExpiryEviction`](../../packages/shared-web/browser/browser-queuebox.ts#L123), [`initBrowserALRuntimeExpiryEviction`](../../packages/shared-web/browser/browser-al-runtime-stores.ts#L249), [`tryRunInIntervals`](../../packages/shared/resilience/TryWith.ts#L301)                                                                                                           | Expiry loops are module singletons and not per-connect leaks, but they are long-lived and have no exposed cancel handle.                                                                                                                                                           | They can continue work after disconnect and in background tabs.                                                                             | Measure timer wakeups and IndexedDB work after `facade.disconnect()` and after `document.visibilityState === 'hidden'`.                                              |

## Re-Render Risks

| Severity    | Confidence       | Location                                                                                                                                                                                                                          | Risk                                                                                                                                              | Why it matters                                                                                            | Validation                                                                                                            |
| ----------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Medium-High | Strong suspicion | [`RtcRealtimePanel.addReceived`](../../apps/rallar-black-box/src/App.tsx#L20229), [`subscribeRealtime`](../../apps/rallar-black-box/src/App.tsx#L20239), [`subscribeRtcMessages`](../../apps/rallar-black-box/src/App.tsx#L20276) | Every received RTC realtime/message event creates a row id, appends to React state, slices the array to 50, and records a runtime event.          | Arrays are bounded, but high-rate DataChannel traffic can re-render the panel for every message.          | React Profiler with 10, 60, and 120 messages/sec while panel is subscribed.                                           |
| Medium      | Strong suspicion | [`MediaConsolePanel.subscribeRemote`](../../apps/rallar-black-box/src/App.tsx#L23248)                                                                                                                                             | Every remote stream event appends React state, slices to 30, and records a runtime event.                                                         | Usually low frequency, but repeated renegotiation or duplicate remote stream events can trigger UI churn. | Simulate reconnect/renegotiation and count remote stream events and renders.                                          |
| Medium      | Strong suspicion | [`RallarFacade.emitRtcLifecycle`](../../packages/shared-web/browser/rallar.ts#L7141), [`emitRtcStatus`](../../packages/shared-web/browser/rallar.ts#L7154), [`toRtcStatus`](../../packages/shared-web/browser/rallar.ts#L6177)    | Every RTC lifecycle event emits full status to every status listener; status builds arrays/sets over known/active/ready peers and maps all peers. | Peer/lane churn can produce `O(status listeners * peer count)` work and React updates.                    | Count RTC lifecycle events, status listener count, peers scanned, and React commits during connect/disconnect cycles. |
| Low-Medium  | Strong suspicion | [`subscribeRelicScenePositionUpdates`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L146), [`applyRelicMotionPayload`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L169)                                 | Relic motion receive path does per-message validation, `players.find`, sample object creation, kinematics push, and buffer push.                  | This is game-loop-adjacent main-thread work; cost grows with message rate and player count.               | Profile Relic motion with 2, 8, and 16 peers and record per-message handler duration.                                 |

## Background Tab Behavior

Static scan note: a targeted search for `visibilitychange`, `document.hidden`,
`visibilityState`, `pagehide`, and `beforeunload` in the inspected browser
WebRTC paths returned no matches.

Relevant recurring browser work:

- QueueBox expiry loop starts in
  [`initBrowserQueueBoxExpiryEviction`](../../packages/shared-web/browser/browser-queuebox.ts#L123).
- AL runtime expiry loop starts in
  [`initBrowserALRuntimeExpiryEviction`](../../packages/shared-web/browser/browser-al-runtime-stores.ts#L249).
- Both use [`tryRunInIntervals`](../../packages/shared/resilience/TryWith.ts#L301),
  which schedules repeated `setTimeout` calls without returning a cancel handle.
- QueueBox engine itself has a stop path in
  [`InboxOutboxEngine.stop`](../../packages/shared/services/InboxOutboxEngine.ts#L54)
  and is stopped by middleware shutdown
  ([`shutdownMiddleware`](../../packages/shared-web/browser/app-context.ts#L119)).
- DataChannel heartbeats use per-peer intervals in
  [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L142)
  and are stopped by peer/channel cleanup or middleware shutdown
  ([`WebRtcRxStreamerService.stopAllHeartbeats`](../../packages/shared/services/WebRtcRxStreamerService.ts#L181)).

Risk: browser timer throttling will reduce wake frequency in many hidden-tab
cases, but there is no explicit app-level pause, heartbeat throttle, or expiry
loop cancellation visible in the cited code. This needs browser runtime
measurement before changing behavior.

## Browser Profiling Plan

Do not optimize yet. Validate the static hypotheses with the smallest scenarios
that exercise the actual browser facade and React consumers.

1. Local media replacement leak test
   - Scenario: open black-box Media Console, click Attach local stream multiple
     times without Stop, then navigate/unmount the panel.
   - Counters: live `MediaStreamTrack` count, monkey-patched `track.stop` count,
     camera/mic indicator state, `chrome://webrtc-internals` sender tracks,
     heap snapshots.
   - Code under test:
     [`MediaConsolePanel.attachLocal`](../../apps/rallar-black-box/src/App.tsx#L23181),
     [`RallarFacade.media.setLocalStream`](../../packages/shared-web/browser/rallar.ts#L4038),
     [`QRtcPeerConnection.setLocalMediaStream`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L776).

2. High-rate DataChannel receive/render test
   - Scenario: use the realtime panel or Relic motion lane to deliver 10, 60,
     and 120 JSON messages/sec.
   - Metrics: long tasks, JS CPU samples in parse/dispatch/listeners, allocation
     rate, React commits, listener counts, dropped/coalesced message count,
     DataChannel `bufferedAmount`.
   - Code under test:
     [`QRtcDataChannel.setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L410),
     [`RallarFacade.dispatchRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L8048),
     [`RtcRealtimePanel.addReceived`](../../apps/rallar-black-box/src/App.tsx#L20229),
     [`applyRelicMotionPayload`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L169).

3. Realtime room send fanout test
   - Scenario: send Relic-style motion payloads with 1, 3, 8, and 16 ready peers.
   - Metrics: `sendRoomRealtimeJson` duration, peer count, payload bytes,
     stringify samples, per-peer send result, queue length, `bufferedAmount`.
   - Code under test:
     [`sendRelicMotionSample`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L300),
     [`sendRoomRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L5211),
     [`sendRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L3922).

4. ICE queue and reconnect churn test
   - Scenario: delay remote descriptions, flap network, and repeat reconnects.
   - Metrics: queued candidate count, duplicate candidate count, offer/answer
     count, ICE restart count, reconnect timer count, signaling chain backlog.
   - Code under test:
     [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L567),
     [`flushIceCandidateQueue`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L600),
     [`handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L614).

5. Background tab timer test
   - Scenario: connect, open one peer/data channel, then background the tab for
     5, 15, and 30 minutes.
   - Metrics: timer wakeups, heartbeat missed count, reconnect attempts, QueueBox
     expiry runs, AL runtime expiry runs, heap/RSS before and after foreground.
   - Code under test:
     [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L142),
     [`tryRunInIntervals`](../../packages/shared/resilience/TryWith.ts#L301),
     [`shutdownMiddleware`](../../packages/shared-web/browser/app-context.ts#L102).

## Top Fixes To Validate First

These are not optimization changes to make yet; they are the first candidates to
validate after measurements.

1. Add explicit raw-stream ownership rules.
   - Candidate: when `facade.media.setLocalStream(stream)` replaces a previous
     raw stream, stop tracks that are no longer used, or require the caller to
     pass an ownership flag.
   - First validation target:
     [`RallarFacade.media.setLocalStream`](../../packages/shared-web/browser/rallar.ts#L4038),
     [`QRtcPeerConnection.setLocalMediaStream`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L776),
     [`MediaConsolePanel.attachLocal`](../../apps/rallar-black-box/src/App.tsx#L23181).

2. Throttle or coalesce high-frequency UI updates.
   - Candidate: batch realtime panel rows and runtime event recording on an
     animation frame or fixed interval during high message rates.
   - First validation target:
     [`RtcRealtimePanel.addReceived`](../../apps/rallar-black-box/src/App.tsx#L20229),
     [`MediaConsolePanel.subscribeRemote`](../../apps/rallar-black-box/src/App.tsx#L23248).

3. Fast-path high-rate room realtime sends.
   - Candidate: reuse the room realtime channel object in Relic motion, cache
     ready peer ids briefly, and avoid repeated status/wait work when the lane is
     already known open.
   - First validation target:
     [`sendRelicMotionSample`](../../apps/relic-hunters-v1/src/game/scene/networking.ts#L300),
     [`createRoomRealtimeJsonChannel`](../../packages/shared-web/browser/rallar.ts#L5160),
     [`sendRoomRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L5211).

4. Bound and dedupe pre-remote-description ICE candidates.
   - Candidate: cap queue length per peer, drop exact duplicates, and ignore
     stale candidates after peer reset/session generation changes.
   - First validation target:
     [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L567),
     [`flushIceCandidateQueue`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L600).

5. Gate verbose WebRTC payload logs.
   - Candidate: keep state-transition logs, but put full SDP/candidate/message
     payload logs behind a debug flag or sampling.
   - First validation target:
     [`QRtcPeerConnection.connect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L298),
     [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L490),
     [`QRtcPeerConnection.sendSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L682),
     [`WebRtcRxStreamerService.addPeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L104).

6. Clarify heartbeat callback ownership.
   - Candidate: remove the heartbeat lifecycle callback with the matching
     lifecycle-callback remover, or call `clearCallbacks()` only when a channel
     wrapper is known to be disposed.
   - First validation target:
     [`WebRtcRxStreamerService.addPeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L113),
     [`WebRtcRxStreamerService.removePeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167),
     [`QRtcDataChannel.clearCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L166).

7. Add visibility-aware measurement before background throttling.
   - Candidate: first instrument, then decide whether heartbeats or expiry loops
     need visibility-aware throttling.
   - First validation target:
     [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L142),
     [`tryRunInIntervals`](../../packages/shared/resilience/TryWith.ts#L301).

## Questions Requiring Runtime Validation

- Do raw local tracks actually survive repeated `MediaConsolePanel.attachLocal`
  calls after browser GC, or does the browser stop unused replaced tracks
  opportunistically?
- At what realtime message rate do `QRtcDataChannel` parse/dispatch and
  `RallarFacade.notifyRealtimeListeners` begin producing long tasks?
- Does Relic motion call `rallar.realtime.room(...).send(...)` often enough for
  room status resolution and per-peer stringify to matter in gameplay?
- How large do browser-side ICE queues get during real glare/reconnect cases?
- Are deleted `QRtcDataChannel` wrappers retained anywhere after
  `WebRtcConnectionService.removePeerIfPresent`, especially through lifecycle
  callbacks or diagnostic objects?
- How frequently do QueueBox and AL-runtime expiry loops wake in hidden tabs,
  and do they perform meaningful IndexedDB work when disconnected?
- Does `getStats()` diagnostics remain manual-only in browser use, or do any
  tests/tools poll it during active calls?
