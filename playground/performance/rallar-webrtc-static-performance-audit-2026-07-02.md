# Rallar WebRTC Static Performance Audit

Date: 2026-07-02

Source map: [`rallar-webrtc-performance-map-2026-07-02.md`](rallar-webrtc-performance-map-2026-07-02.md)

Scope: static analysis only. No code was edited, no destructive commands were
run, and no benchmarks or profiling runs were performed.

Focus areas:

- Peer connection creation and teardown.
- Signaling, offer/answer, SDP handling, ICE candidates, and ICE restarts.
- Reconnection, renegotiation, and offer glare handling.
- Media track handling, screen/audio/video capture, transceivers, and senders.
- DataChannel send/receive paths, backpressure, and binary/JSON payloads.
- `getStats` diagnostics and telemetry paths.
- Room/session/participant state and server-side RTC forwarding/topology.

Confidence labels:

- Proven from code: the referenced implementation directly shows the issue or
  cost shape.
- Strong suspicion: the static shape is risky, but runtime impact depends on
  workload.
- Needs runtime measurement: behavior or impact depends heavily on browser,
  network, room size, traffic rate, or deployment configuration.

## Executive Summary

Top WebRTC performance risks:

1. Server RTC topology builds complete room graphs with `O(n^2)` edges per group
   update, then may add mesh/tree planning work.
2. Realtime `RTCDataChannel` hot paths allocate and serialize/parse per message,
   with callback fanout and queue work under backpressure.
3. Peer and lane readiness checks can repeatedly fan out across room peers and
   lanes, especially AR Eye Hunter's 5-lane polling loop.
4. Lifecycle cleanup has leak-risk edges around peer connection listeners,
   heartbeat callbacks, WebSocket listeners, and retained peer connections.
5. Signaling and ICE paths do repeated JSON serialization/logging, allow
   unbounded pre-remote-description ICE queues, and can accumulate async
   reconnect/negotiation work during churn.

## Findings: Proven From Code

| Severity | Confidence | Category | Location | Why it is costly | WebRTC impact | How to validate | Suggested fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| High | Proven from code | Algorithmic complexity | [`RallarRtcTopologyService.createRoomGraph`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L217) | The implementation adds a graph edge for every active session pair with nested loops. | Room topology construction grows `O(n^2)` before mesh/tree planning. | Measure topology update CPU for 3, 10, 30, and 100 active sessions. | If validated, cache or incrementally update graph edges, or avoid complete graph construction for large rooms. |
| Medium-High | Proven from code | ICE queue | [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L485), [`QRtcPeerConnection.flushIceCandidateQueue`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L513) | ICE candidates queue until remote description exists; flushing uses `shift()` inside a loop. | Candidate storms can grow memory and make queue flushing more expensive than necessary. | Count queued candidates and flush duration during glare and reconnect tests. | If validated, cap and dedupe candidates, and flush by index or splice instead of repeated `shift()`. |
| Medium | Proven from code | Signaling CPU and logging | [`QRtcPeerConnection.connect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L225), [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L418), [`QRtcPeerConnection.sendSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L586), [`initRtcSignalingTopic`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L707) | Offer/answer/candidate objects are stringified for logs on signaling paths. | SDP descriptions and candidate payloads can be large; negotiation storms amplify CPU, allocation, and log I/O. | Run offer/ICE storm scenarios with logging on and off; profile stringify/log cost. | If validated, gate verbose signaling logs behind debug mode or sampling. |
| Medium | Proven from code | Room readiness fanout | [`useRallarArena` lane polling](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L1099), [`RallarFacade.waitForRtcRoomLaneOpen`](../../packages/shared-web/browser/rallar.ts#L6631), [`RallarFacade.waitForRtcLaneOpenWithConnect`](../../packages/shared-web/browser/rallar.ts#L6782) | The app checks five lanes every 2.5 seconds; each room-lane wait maps over room peer IDs with `Promise.all`. | Active gameplay can create repeated lane waiters and connection checks. | Instrument lane refresh count, peer count, waiter count, and time per refresh. | If validated, cache lane readiness or drive UI state from RTC lifecycle events. |
| Low-Medium | Proven from code | Diagnostics allocation | [`RallarFacade.toRtcDiagnostics`](../../packages/shared-web/browser/rallar.ts#L6247), [`readSelectedCandidatePairDiagnostics`](../../packages/shared-web/browser/rallar.ts#L9213) | Diagnostics calls `pc.getStats()`, builds an array from the report, then builds a `Map`. | Fine on demand, but expensive if diagnostics are polled during gameplay. | Count diagnostics frequency and profile `getStats()` with many peers. | If validated, throttle diagnostics and only request stats for selected peers. |

## Findings: Strong Suspicion

| Severity | Confidence | Category | Location | Why it is costly | WebRTC impact | How to validate | Suggested fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| High | Strong suspicion | DataChannel hot path | [`QRtcDataChannel.sendJson`](../../packages/shared/webrtc/QRtcDataChannel.ts#L238), [`QRtcDataChannel.setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L388), [`RallarFacade.dispatchRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L8037) | Sends stringify JSON; receives dispatch raw callbacks and may parse JSON in facade/service paths. | High-rate gameplay messages can spend CPU in serialization, parsing, and callback fanout. | Measure messages/sec, parse/stringify CPU, allocations, and listener counts. | If validated, reduce JSON on hottest lanes or use compact/binary payloads selectively. |
| High | Strong suspicion | Backpressure and queue work | [`QRtcDataChannel.handleBackPressure`](../../packages/shared/webrtc/QRtcDataChannel.ts#L612), [`DEFAULT_REALTIME_DATA_CHANNEL_LANE`](../../packages/shared-web/browser/middleware.ts#L72) | `replace-by-key` scans queued sends with `findIndex`; the default realtime queue is bounded to 64 items. | Bursts may spend CPU scanning/replacing and may drop stale gameplay updates. | Track queued, replaced, dropped, stale, flushed, and `bufferedAmount` counters. | If validated, use keyed map plus ordered queue, or tune lane-specific policies. |
| Medium-High | Strong suspicion | Group/session scans | [`WebRtcGroupManager.reconcileAllGroups`](../../packages/shared/services/WebRtcGroupManager.ts#L199), [`WebRtcGroupManager.onlinePeerIds`](../../packages/shared/services/WebRtcGroupManager.ts#L282), [`WebRtcGroupService.readCachedGroup`](../../packages/shared/services/WebRtcGroupService.ts#L156) | Reconcile scans groups, client cache sessions, known peers, retained peers; fallback group lookup scans and sorts all cached groups. | Room churn can make connect/disconnect decisions scale with total local state. | Count groups, sessions, peers scanned per reconcile and p95 reconcile time. | If validated, maintain indexes by scoped group and session, then update incrementally. |
| Medium-High | Strong suspicion | PeerConnection cleanup | [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L132), [`QRtcPeerConnection.setupStateChangeCallbacks`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L317), [`icegatheringstatechange` listener](../../packages/shared/webrtc/QRtcPeerConnection.ts#L374) | Cleanup nulls selected handlers but does not remove the anonymous `icegatheringstatechange` listener or every assigned handler. | Repeated peer churn may retain closed peer-connection closures longer than intended. | Browser heap snapshots after 100+ connect/disconnect cycles. | If validated, store listener references and clear all peer-connection handlers/listeners on close. |
| Medium | Strong suspicion | Heartbeat callback lifetime | [`WebRtcHeartbeatService.start`](../../packages/shared/services/WebRtcHeartbeatService.ts#L54), [`WebRtcHeartbeatService.stop`](../../packages/shared/services/WebRtcHeartbeatService.ts#L64), [`WebRtcRxStreamerService.removePeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167), [`QRtcDataChannel.clearCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L167) | `stop()` clears the interval but does not unregister the channel message handler installed by `setupMessageHandler`. | Callback maps may grow or retain closures if peer/channel DTOs survive churn. | Inspect `readHealth().messageCallbackCount` and heap after peer removal. | If validated, add explicit heartbeat unsubscribe and/or clear callback maps on reset. |
| Medium | Strong suspicion | Overlay message copies | [`WebRtcOverlayMulticastService.prepareTransportReadyCopies`](../../packages/shared/multicast/WebRtcOverlayMulticastService.ts#L73), [`WebRtcOverlayMulticastManager.sendImmediately`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L627) | Forwarding creates one copied message per next hop and sends or enqueues serially. | Large rooms or multicast bursts allocate many message copies and serialize sends. | Measure transport message count, allocation, and send latency per room message. | If validated, share immutable payload body and vary only the forwarding envelope. |

## Findings: Needs Runtime Measurement

| Severity | Confidence | Category | Location | Why it is costly | WebRTC impact | How to validate | Suggested fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| High | Needs runtime measurement | RTT/topology loop | [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L132), [`WebRtcRxStreamerService.startRtcHeartbeats`](../../packages/shared/services/WebRtcRxStreamerService.ts#L224), [`initRttTopic`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L638) | Heartbeats feed RTT updates; accepted RTT can trigger global graph recomputation and topology work. | Peer count multiplies RTT rate; server CPU may spike in active rooms. | Run room sizes 3, 10, 30, and 100 with RTT counters and CPU profiles. | If confirmed, debounce/coalesce per group and avoid global recompute per RTT. |
| Medium-High | Needs runtime measurement | Reconnect/renegotiation storms | [`QRtcPeerConnection.setupStateChangeCallbacks`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L317), [`QRtcPeerConnection.handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L524), [`RallarFacade.restartRtcIce`](../../packages/shared-web/browser/rallar.ts#L6340) | Disconnect schedules reconnect; failure reconnects immediately; recovery calls `restartIce()`. | Network flaps may trigger repeated ICE restarts, offers, and signaling churn. | Simulate network drops, tab backgrounding, and TURN-only conditions; count offers, restarts, and candidates. | If confirmed, add stronger debounce/state gates around restart and renegotiation. |
| Medium | Needs runtime measurement | WebSocket/QueueBox signaling overhead | [`WsRtcSignalingTransportUsingWsQBox.send`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L71), [`WebRtcConnectionService.toSignalingProtocol`](../../packages/shared/services/WebRtcConnectionService.ts#L445), [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L100) | Signaling goes through QueueBox/WebSocket parse, enqueue, and dequeue layers. | Offer and ICE bursts may accumulate async queue work. | Count QueueBox entries, parse time, WebSocket send latency, and event-loop delay during setup storms. | If confirmed, fast-path transient signaling or batch/debounce candidates. |
| Medium | Needs runtime measurement | Binary receive copies | [`RallarFacade.dispatchRealtimeBinary`](../../packages/shared-web/browser/rallar.ts#L8065), [`toArrayBuffer`](../../packages/shared-web/browser/rallar.ts#L9704) | ArrayBuffer views are copied with `slice()`, and Blob payloads call `arrayBuffer()`. | Binary realtime lanes may allocate per message. | Send binary bursts with `ArrayBufferView` and `Blob` payloads; profile allocations. | If confirmed, pass views through where API allows or document copy semantics. |
| Medium | Needs runtime measurement | WebSocket/listener cleanup | [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L100), [`JsonWebSocketClient.close`](../../packages/shared/websocket/JsonWebSocketClient.ts#L242), [`WsRtcSignalingTransportUsingWsQBox.connect`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L21) | Socket listeners are anonymous and signaling transport callbacks are tied to socket/QueueBox lifetime. | Reconnect churn may retain old sockets or callback closures until GC. | Heap snapshots and callback-map sizes after repeated middleware reconnects. | If confirmed, add explicit unsubscribe/dispose paths for signaling transports. |

## False-Positive Risks

- The current `getStats()` path appears on-demand, not a clear telemetry loop.
- Default realtime send queues are bounded to 64 items, so the main risk is
  burst CPU/drop behavior rather than unbounded queue memory.
- Some full-scan group fallback paths may be rare if direct scoped cache keys are
  consistently present.
- Verbose signaling logs may be acceptable in local development if disabled or
  reduced in production builds.
- Small room sizes may never make topology graph construction material.

## Do Not Optimize Yet: Validation Plan

1. Add temporary counters under `tmp/perf/` or debug-only logs:
   - offers, answers, ICE candidates queued/flushed
   - `restartIce()` calls
   - data-channel sends, queued sends, replacements, drops, stale drops
   - callback counts
   - topology build duration
   - group reconcile duration
2. Run browser RTC churn scenarios:
   - repeated connect/disconnect
   - room join/leave
   - network drop/reconnect
   - tab background/foreground
   Capture heap snapshots before and after GC, and count retained
   `RTCPeerConnection`, `RTCDataChannel`, timers, sockets, and callback maps.
3. Run high-rate realtime lane traffic using AR Eye Hunter or black-box RTC
   traffic fixtures. Collect CPU profile, allocation profile, `bufferedAmount`,
   queue counters, parse/stringify cost, and p95 send latency.
4. Run server topology scale tests with room sizes 3, 10, 30, and 100 and RTT
   rates 1, 10, and 50 Hz. Capture CPU time in `createRoomGraph`, mesh/tree
   planning, RTT topic handling, and outbound topology notifications.
5. Confirm false positives before optimizing:
   - diagnostics/getStats are not polled in production gameplay
   - expected production room sizes
   - whether signaling QueueBox uses persistent storage in the deployed path
   - whether verbose signaling logs are enabled outside local development

## Top 3 Measurement Tasks Next

1. DataChannel traffic profile:
   - high-rate JSON and binary gameplay lanes
   - serialization, parsing, queue/backpressure counters, and allocation
2. Room/topology scale profile:
   - RTT heartbeat fan-in
   - `RallarRtcTopologyService.createRoomGraph`
   - mesh/tree planning at increasing room sizes
3. Lifecycle churn leak check:
   - repeated peer connect/disconnect and room churn
   - heap snapshots and callback/timer/socket counts

## Notes

- Do not accept optimization work until at least one finding is confirmed by a
  benchmark, profile, heap snapshot, telemetry signal, or clear algorithmic
  proof.
- Generated profiling artifacts should go under `tmp/perf/` and should not be
  committed unless explicitly requested.
