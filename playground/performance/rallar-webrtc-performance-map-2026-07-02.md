# Rallar WebRTC Performance Map

Date: 2026-07-02

Scope: static analysis only. No code was optimized, no benchmarks were run, and
no profiling artifacts were created.

This map focuses only on WebRTC-related code paths:

- `RTCPeerConnection` lifecycle, negotiation, ICE, STUN/TURN config, and stats.
- Signaling over WebSocket, QueueBox, and server topics.
- `MediaStream`, tracks, transceivers, senders, receivers, and screen sharing.
- `RTCDataChannel` creation, traffic, backpressure, and cleanup.
- Room, session, participant, topology, relay, reconnect, and shutdown paths.

Confidence labels:

- Proven from code: the referenced implementation directly shows the claim.
- Strong suspicion: the static code shape makes the risk likely, but runtime
  measurement is still required.
- Needs runtime validation: the code path exists, but impact or behavior depends
  on browser, network, traffic, or room-size conditions.

## WebRTC Architecture Summary

Proven from code: the browser runtime creates middleware, fetches ICE config,
opens WebSocket/QueueBox signaling, and constructs `WebRtcConnectionService`;
per-peer runtime state is modeled as `QRtcPeerConnection` plus one or more
`QRtcDataChannel` lanes plus `QRtcMediaChannel`.

Refs:

- [`initialiseMiddleware`](../../packages/shared-web/browser/middleware.ts#L137)
- [`initialiseRtcConnectionService`](../../packages/shared-web/browser/rtc-engine.ts#L114)
- [`WebRtcConnectionService.computeRtcPeerDtoIfAbsent`](../../packages/shared/services/WebRtcConnectionService.ts#L932)
- [`QRtcPeerConnection`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L82)
- [`QRtcDataChannel`](../../packages/shared/webrtc/QRtcDataChannel.ts#L126)
- [`QRtcMediaChannel`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L32)

Proven from code: signaling is peer-to-peer WebRTC signaling carried over
WebSocket/QueueBox and a server topic, not over an SFU signaling API. Browser
messages are sent by `WsRtcSignalingTransportUsingWsQBox.send`, routed by
`initRtcSignalingTopic`, and delivered by `JsonWebSocketServer.send`.

Refs:

- [`WsRtcSignalingTransportUsingWsQBox.send`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L71)
- [`initRtcSignalingTopic`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L707)
- [`JsonWebSocketServer.send`](../../packages/shared/websocket/JsonWebSocketServer.ts#L173)

Proven from code: application-level relay and forwarding logic exists for
messages carried over RTC/data-channel lanes, especially multicast/overlay
dispatch. I did not find SFU/MCU media forwarding in the inspected WebRTC
runtime paths.

Refs:

- [`WebRtcOverlayMulticastManager.forwardIfRequired`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L202)
- [`WebRtcOverlayMulticastManager.sendPreparedMessage`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L586)
- [`WebRtcOverlayMulticastService.buildHandlingPlan`](../../packages/shared/multicast/WebRtcOverlayMulticastService.ts#L54)

Proven from code: explicit SDP parsing or SDP munging is not present in the
inspected runtime paths; `QRtcPeerConnection.processSignal` passes browser
session descriptions to `setRemoteDescription` and `setLocalDescription`.

Refs:

- [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L418)
- [`QRtcPeerConnection.processSignal` answer branch](../../packages/shared/webrtc/QRtcPeerConnection.ts#L426)
- [`QRtcPeerConnection.processSignal` offer branch](../../packages/shared/webrtc/QRtcPeerConnection.ts#L446)

## Entry Points and Key Files

| Area                    | File and symbol                                                                                                                                                                                                                                                                                                                                                       | Role                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Public browser API      | [`RallarFacade.connectConnection`](../../packages/shared-web/browser/rallar.ts#L4080), [`RallarFacade.disconnectConnection`](../../packages/shared-web/browser/rallar.ts#L4221)                                                                                                                                                                                       | Opens and closes the browser-side Rallar runtime that owns WebRTC services.                                           |
| Public RTC facade       | [`createRallarRtcFacade`](../../packages/shared-web/browser/rallar.ts#L3742), [`RallarRtcFacade`](../../packages/shared-web/browser/rallar-rtc-facade.ts#L22)                                                                                                                                                                                                         | Exposes peer status, room opening, lane waiting, diagnostics, ICE restart, and reconnect.                             |
| Public realtime facade  | [`RallarFacade.realtime`](../../packages/shared-web/browser/rallar.ts#L3902), [`sendRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L3918), [`sendRealtimeBinary`](../../packages/shared-web/browser/rallar.ts#L3945)                                                                                                                                      | Sends JSON/binary data through RTC data-channel lanes.                                                                |
| Public media facade     | [`RallarFacade.media`](../../packages/shared-web/browser/rallar.ts#L4030), [`RallarMediaFacade`](../../packages/shared-web/browser/rallar-media-facade.ts#L11)                                                                                                                                                                                                        | Starts, stops, attaches, and exposes local/remote media streams.                                                      |
| Middleware construction | [`initialiseMiddleware`](../../packages/shared-web/browser/middleware.ts#L137), [`initialiseRtcConnectionService`](../../packages/shared-web/browser/rtc-engine.ts#L114)                                                                                                                                                                                              | Wires WebSocket, QueueBox, ICE config, RTC connection service, group manager, overlay manager, and receiver streamer. |
| Peer lifecycle          | [`WebRtcConnectionService.ensurePeerConnectionStarted`](../../packages/shared/services/WebRtcConnectionService.ts#L672), [`computeRtcPeerDtoIfAbsent`](../../packages/shared/services/WebRtcConnectionService.ts#L932), [`removePeerIfPresent`](../../packages/shared/services/WebRtcConnectionService.ts#L305)                                                       | Creates, starts, retries, and disposes peer DTOs.                                                                     |
| Raw peer connection     | [`QRtcPeerConnection.connect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L206), [`processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L418), [`handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L524), [`closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L132)                          | Owns `RTCPeerConnection`, browser event handlers, negotiation, ICE, reconnect, tracks, and closure.                   |
| Data channels           | [`QRtcDataChannel.connect`](../../packages/shared/webrtc/QRtcDataChannel.ts#L340), [`sendRaw`](../../packages/shared/webrtc/QRtcDataChannel.ts#L252), [`setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L388)                                                                                                                             | Creates or accepts `RTCDataChannel` instances, sends payloads, receives messages, and handles backpressure.           |
| Media channel           | [`QRtcMediaChannel.connect`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L96), [`QRtcMediaChannel.subscribe`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L112), [`setLocalMediaStream`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L178)                                                                                                             | Bridges peer media callbacks to higher-level media APIs.                                                              |
| Signaling transport     | [`WsRtcSignalingTransportUsingWsQBox.connect`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L21), [`send`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L71), [`WsRtcSignalingTransport.connect`](../../packages/shared/webrtc/WsRtcSignalingTransport.ts#L19)                                                            | Carries `QRtcSignalingMessage` over QueueBox/WebSocket.                                                               |
| Server signaling        | [`initRtcSignalingTopic`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L707), [`JsonWebSocketServer.addConnection`](../../packages/shared/websocket/JsonWebSocketServer.ts#L61), [`JsonWebSocketServer.send`](../../packages/shared/websocket/JsonWebSocketServer.ts#L173)                                                                          | Routes signaling messages between authenticated sessions.                                                             |
| ICE config              | [`readIceCandidates`](../../packages/shared-web/browser/api-integration.ts#L589), [`iceRoute`](../../apps/api-v1/src/routes/ice-route.ts#L42), [`MeteredApi.getIceCandidates`](../../apps/api-v1/src/integration/metered-api.ts#L10)                                                                                                                                  | Reads browser ICE servers and fetches Metered TURN/STUN credentials when configured.                                  |
| Group/session targeting | [`WebRtcGroupManager.reconcileAllGroups`](../../packages/shared/services/WebRtcGroupManager.ts#L199), [`WebRtcGroupService.targetPeerIds`](../../packages/shared/services/WebRtcGroupService.ts#L71)                                                                                                                                                                  | Chooses desired peer connections from room/group state and online sessions.                                           |
| Overlay relay           | [`WebRtcOverlayMulticastManager.planOutgoingMessage`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L464), [`sendPreparedMessage`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L586)                                                                                                                                          | Forwards application messages over selected RTC lanes and overlay next hops.                                          |
| Topology                | [`RallarRtcTopologyService.updateGroupTopology`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L72), [`createRoomGraph`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L217), [`createNextHopMap`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L263) | Computes mesh/star/tree next-hop topology from active group/session state and RTT input.                              |
| App consumer            | [`useRallarArena` RTC lane readiness effect](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L1099), [`useRallarArena` realtime room sends](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L2033)                                                                                                                                                      | Opens and uses gameplay realtime lanes.                                                                               |
| Test/harness consumer   | [`rallar-browser-runtime.connect`](../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts#L1899), [`sendRealtime`](../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts#L2210), [`sendMessagesRtc`](../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts#L2261)                              | Browser-backed black-box runtime that exercises public Rallar RTC APIs.                                               |

## Lifecycle Map: create -> active -> reconnect/renegotiate -> close/dispose

### Create

1. Proven from code: `initialiseMiddleware` creates browser client data,
   WebSocket client, QueueBox, WebRTC connection service, overlay multicast
   manager, Rx streamer, and group manager.
   Refs: [`initialiseMiddleware`](../../packages/shared-web/browser/middleware.ts#L137),
   [`initialiseRtcConnectionService`](../../packages/shared-web/browser/rtc-engine.ts#L114),
   [`initialiseRtcRxStreamer`](../../packages/shared-web/browser/rtc-engine.ts#L74).
2. Proven from code: the browser obtains ICE candidates through
   `readIceCandidates`, and the API route either returns local empty ICE config
   or Metered TURN/STUN credentials.
   Refs: [`readIceCandidates`](../../packages/shared-web/browser/api-integration.ts#L589),
   [`iceRoute`](../../apps/api-v1/src/routes/ice-route.ts#L42),
   [`readFreshIceConfig`](../../apps/api-v1/src/routes/ice-route.ts#L73),
   [`MeteredApi.getIceCandidates`](../../apps/api-v1/src/integration/metered-api.ts#L10).
3. Proven from code: `WebRtcConnectionService.computeRtcPeerDtoIfAbsent`
   constructs `QRtcPeerConnection`, data channels, and `QRtcMediaChannel`, then
   stores the peer DTO in `peerDtoByPeerId`.
   Refs: [`computeRtcPeerDtoIfAbsent`](../../packages/shared/services/WebRtcConnectionService.ts#L932),
   [`WebRtcConnectionService.createDataChannels`](../../packages/shared/services/WebRtcConnectionService.ts#L1285).

### Active

1. Proven from code: `QRtcPeerConnection.connect` creates
   `new RTCPeerConnection(this.configuration)` and installs browser handlers for
   negotiation, ICE candidates, incoming data channels, tracks, and connection
   state.
   Refs: [`QRtcPeerConnection.connect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L206),
   [`setupStateChangeCallbacks`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L317).
2. Proven from code: `onnegotiationneeded` calls `pc.setLocalDescription()`
   and sends a `QRtcSignalingType.Offer`; `onicecandidate` sends
   `QRtcSignalingType.IceCandidate`.
   Refs: [`QRtcPeerConnection.connect` negotiation handler](../../packages/shared/webrtc/QRtcPeerConnection.ts#L225),
   [`QRtcPeerConnection.connect` ICE handler](../../packages/shared/webrtc/QRtcPeerConnection.ts#L254),
   [`QRtcPeerConnection.sendSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L586).
3. Proven from code: `QRtcDataChannel.connect` either creates a negotiated lane
   via `peerConnection.createDataChannel` for the initiator or waits for
   `ondatachannel` for the receiver.
   Refs: [`QRtcDataChannel.connect`](../../packages/shared/webrtc/QRtcDataChannel.ts#L340),
   [`QRtcPeerConnection.createDataChannel`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L392).
4. Proven from code: local media is attached by
   `QRtcPeerConnection.setLocalMediaStream`, which reuses senders with
   `replaceTrack` when possible or calls `pc.addTrack`.
   Refs: [`QRtcPeerConnection.setLocalMediaStream`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L641),
   [`RallarFacade.attachLocalMediaSources`](../../packages/shared-web/browser/rallar.ts#L5613).

### Reconnect and renegotiate

1. Proven from code: inbound answers, offers, and ICE candidates are serialized
   by `handleSignal` through `signalingChain`, and `processSignal` handles
   collision rollback for polite peers.
   Refs: [`QRtcPeerConnection.handleSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L406),
   [`QRtcPeerConnection.processSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L418),
   [`WebRtcConnectionService.isPolite`](../../packages/shared/services/WebRtcConnectionService.ts#L1329).
2. Proven from code: ICE candidates received before remote description are
   queued, then flushed after remote description is set.
   Refs: [`QRtcPeerConnection.processSignal` ICE branch](../../packages/shared/webrtc/QRtcPeerConnection.ts#L485),
   [`QRtcPeerConnection.flushIceCandidateQueue`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L513).
3. Proven from code: disconnected peers wait before reconnect, failed peers
   reconnect immediately, and `handleReconnect` uses capped attempts plus
   exponential backoff before calling `pc.restartIce()`.
   Refs: [`setupStateChangeCallbacks`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L324),
   [`QRtcPeerConnection.handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L524).
4. Proven from code: public recovery exposes direct ICE restart and peer
   reconnect through `RallarFacade.restartRtcIce` and `RallarFacade.reconnectRtcPeer`.
   Refs: [`RallarFacade.restartRtcIce`](../../packages/shared-web/browser/rallar.ts#L6340),
   [`RallarFacade.reconnectRtcPeer`](../../packages/shared-web/browser/rallar.ts#L6386).

### Close and dispose

1. Proven from code: per-peer removal resets media, data channels, and peer
   connection, then deletes the peer DTO.
   Refs: [`WebRtcConnectionService.removePeerIfPresent`](../../packages/shared/services/WebRtcConnectionService.ts#L305),
   [`QRtcMediaChannel.reset`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L50),
   [`QRtcDataChannel.reset`](../../packages/shared/webrtc/QRtcDataChannel.ts#L160),
   [`QRtcPeerConnection.reset`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L107).
2. Proven from code: `QRtcPeerConnection.closePeerConnectionIfPresent` stops
   transceivers where possible, nulls selected handlers, closes the peer
   connection, and clears reconnect/disconnect timers.
   Refs: [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L132).
3. Proven from code: full browser shutdown stops heartbeats, disconnects all
   known peers, stops local media, disposes overlay multicast, stops the QBox
   engine, and closes WebSocket QueueBox.
   Refs: [`RallarFacade.disconnectConnection`](../../packages/shared-web/browser/rallar.ts#L4221),
   [`shutdownApiMiddleware`](../../packages/shared-web/browser/rallar.ts#L9873),
   [`shutdownMiddleware`](../../packages/shared-web/browser/app-context.ts#L102).

## Signaling Flow

```text
Browser A QRtcPeerConnection
  -> QRtcPeerConnection.sendSignal
  -> WsRtcSignalingTransportUsingWsQBox.send
  -> WsQueueBoxClientService / JsonWebSocketClient
  -> API ws route / JsonWebSocketServer
  -> initRtcSignalingTopic
  -> JsonWebSocketServer.send(toId)
  -> Browser B WsRtcSignalingTransportUsingWsQBox.connect callback
  -> WebRtcConnectionService.toSignalingProtocol.onMessage
  -> QRtcPeerConnection.handleSignal/processSignal
```

Refs:

- [`QRtcPeerConnection.sendSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L586)
- [`WsRtcSignalingTransportUsingWsQBox.send`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L71)
- [`WsQueueBoxClientService.enableDefaultCallbacks`](../../packages/shared/services/WsQueueBoxClientService.ts#L345)
- [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L100)
- [`wsRoutes`](../../apps/api-v1/src/routes/ws-routes.ts#L7)
- [`JsonWebSocketServer.addConnection`](../../packages/shared/websocket/JsonWebSocketServer.ts#L61)
- [`initRtcSignalingTopic`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L707)
- [`WebRtcConnectionService.toSignalingProtocol`](../../packages/shared/services/WebRtcConnectionService.ts#L445)
- [`QRtcPeerConnection.handleSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L406)

## Media and Data Flow

### Media

1. Proven from code: microphone and camera are captured through
   `navigator.mediaDevices.getUserMedia`; screen sharing is captured through
   `getDisplayMedia`.
   Refs: [`RallarFacade.captureMediaSource`](../../packages/shared-web/browser/rallar.ts#L5465).
2. Proven from code: local tracks are composed into one `MediaStream` and
   attached to all peers through `rtcRxStreamer.setLocalMediaStream`.
   Refs: [`RallarFacade.attachLocalMediaSources`](../../packages/shared-web/browser/rallar.ts#L5613),
   [`WebRtcRxStreamerService.setLocalMediaStream`](../../packages/shared/services/WebRtcRxStreamerService.ts#L414).
3. Proven from code: media policy can create audio/video transceivers, set codec
   preferences with `RTCRtpSender.getCapabilities`, and set sender encoding
   parameters.
   Refs: [`QRtcPeerConnection.setMediaPolicy`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L711),
   [`QRtcPeerConnection.ensureTransceiversForPolicy`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L756),
   [`QRtcPeerConnection.applyPreferredCodec`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L778),
   [`QRtcPeerConnection.applyEncodingHints`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L813).
4. Proven from code: remote tracks are received by `QRtcPeerConnection.ontrack`,
   stored in `remoteStreams`, and delivered through media callbacks.
   Refs: [`QRtcPeerConnection.connect` track handler](../../packages/shared/webrtc/QRtcPeerConnection.ts#L285),
   [`QRtcMediaChannel.subscribe`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L112),
   [`WebRtcRxStreamerService.addPeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L104).

### Data

1. Proven from code: data channels are organized by lanes; the default realtime
   lane is unordered, has `maxRetransmits: 0`, and has bounded flow-control
   thresholds and replacement behavior.
   Refs: [`DEFAULT_REALTIME_DATA_CHANNEL_LANE`](../../packages/shared-web/browser/middleware.ts#L72),
   [`WebRtcConnectionService.dataChannelLanes`](../../packages/shared/services/WebRtcConnectionService.ts#L1310).
2. Proven from code: outgoing JSON/binary data goes through public realtime
   facade methods, waits for the target lane, then calls `QRtcDataChannel`
   send methods.
   Refs: [`RallarFacade.sendRealtimeJson`](../../packages/shared-web/browser/rallar.ts#L3918),
   [`RallarFacade.sendRealtimeBinary`](../../packages/shared-web/browser/rallar.ts#L3945),
   [`QRtcDataChannel.sendJson`](../../packages/shared/webrtc/QRtcDataChannel.ts#L232),
   [`QRtcDataChannel.sendBinary`](../../packages/shared/webrtc/QRtcDataChannel.ts#L244).
3. Proven from code: inbound data-channel messages are dispatched to raw,
   binary, or JSON callbacks depending on payload type and registered listener
   shape.
   Refs: [`QRtcDataChannel.setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L388),
   [`RallarFacade.registerRealtimeLaneCallbacks`](../../packages/shared-web/browser/rallar.ts#L4004).
4. Proven from code: overlay/multicast messages can be forwarded to next-hop
   peers over RTC data-channel lanes.
   Refs: [`WebRtcOverlayMulticastManager.forwardIfRequired`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L202),
   [`WebRtcOverlayMulticastManager.sendPreparedMessage`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L586).

## Resource Ownership Table

| Resource                         | Created by                                                                                                                                                                                                                                                              | Cleaned up by                                                                                                                                                                                                                                                                             | Notes                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `RTCPeerConnection`              | [`QRtcPeerConnection.connect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L206)                                                                                                                                                                                 | [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L132) via [`QRtcPeerConnection.reset`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L107)                                                                                    | Proven from code: one peer connection is owned per `QRtcPeerConnection` instance.            |
| Signaling messages               | [`QRtcPeerConnection.sendSignal`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L586)                                                                                                                                                                              | Not a retained resource in `QRtcPeerConnection`; delivered through transport callbacks in [`WebRtcConnectionService.toSignalingProtocol`](../../packages/shared/services/WebRtcConnectionService.ts#L445)                                                                                 | Proven from code: outbound signaling is serialized with `outboundSignalingChain`.            |
| ICE server config                | [`readIceCandidates`](../../packages/shared-web/browser/api-integration.ts#L589), [`readFreshIceConfig`](../../apps/api-v1/src/routes/ice-route.ts#L73)                                                                                                                 | Cache expiry on API side through [`iceConfigCache`](../../apps/api-v1/src/routes/ice-route.ts#L33)                                                                                                                                                                                        | Proven from code: API-side ICE config expiry is 5 minutes in `readFreshIceConfig`.           |
| ICE candidate queue              | [`QRtcPeerConnection.processSignal` ICE branch](../../packages/shared/webrtc/QRtcPeerConnection.ts#L485)                                                                                                                                                                | [`QRtcPeerConnection.flushIceCandidateQueue`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L513), [`QRtcPeerConnection.toStatus`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L114)                                                                                          | Proven from code: candidates are queued until remote description exists.                     |
| `RTCDataChannel`                 | [`QRtcDataChannel.connect`](../../packages/shared/webrtc/QRtcDataChannel.ts#L340), [`QRtcPeerConnection.createDataChannel`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L392)                                                                                    | [`QRtcDataChannel.reset`](../../packages/shared/webrtc/QRtcDataChannel.ts#L160), [`QRtcDataChannel.closeDataChannelIfPresent`](../../packages/shared/webrtc/QRtcDataChannel.ts#L173), [`QRtcDataChannel.clearDataChannelReference`](../../packages/shared/webrtc/QRtcDataChannel.ts#L524) | Proven from code: channel event handlers are nulled when the channel reference is cleared.   |
| Data-channel send queue          | [`QRtcDataChannel.handleBackPressure`](../../packages/shared/webrtc/QRtcDataChannel.ts#L612)                                                                                                                                                                            | [`QRtcDataChannel.reset`](../../packages/shared/webrtc/QRtcDataChannel.ts#L160), [`QRtcDataChannel.flushQueuedSends`](../../packages/shared/webrtc/QRtcDataChannel.ts#L672)                                                                                                               | Strong suspicion: queue scans/replacements can be hot on high-frequency lanes.               |
| Local captured media             | [`RallarFacade.startMediaSource`](../../packages/shared-web/browser/rallar.ts#L5433), [`RallarFacade.captureMediaSource`](../../packages/shared-web/browser/rallar.ts#L5465)                                                                                            | [`RallarFacade.stopMediaSource`](../../packages/shared-web/browser/rallar.ts#L5560), [`RallarFacade.stopLocalMediaSourcesForKind`](../../packages/shared-web/browser/rallar.ts#L5582), [`shutdownApiMiddleware`](../../packages/shared-web/browser/rallar.ts#L9873)                       | Proven from code: internally tracked source tracks are stopped on source stop and shutdown.  |
| Local peer media senders         | [`QRtcPeerConnection.setLocalMediaStream`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L641)                                                                                                                                                                     | [`QRtcPeerConnection.stopLocalMedia`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L690), [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L132)                                                                              | Proven from code: `replaceTrack` is preferred when a sender exists.                          |
| Remote streams/tracks            | [`QRtcPeerConnection.connect` track handler](../../packages/shared/webrtc/QRtcPeerConnection.ts#L285), [`QRtcMediaChannel.subscribe`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L112)                                                                            | [`QRtcMediaChannel.reset`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L50), [`QRtcMediaChannel.unsubscribe`](../../packages/shared/webrtc/QRtcMediaChannel.ts#L149)                                                                                                                 | Proven from code: callbacks are registered by id and removable.                              |
| Peer reconnect/disconnect timers | [`QRtcPeerConnection.setupStateChangeCallbacks`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L317), [`QRtcPeerConnection.handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L524)                                                              | [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L158)                                                                                                                                                                              | Proven from code: reconnect and disconnect timers are cleared during close.                  |
| Heartbeat interval               | [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L132)                                                                                                                                                                | [`WebRtcHeartbeatService.stop`](../../packages/shared/services/WebRtcHeartbeatService.ts#L64), [`WebRtcRxStreamerService.stopAllHeartbeats`](../../packages/shared/services/WebRtcRxStreamerService.ts#L181)                                                                              | Cleanup gap candidate: message callback ownership is less clear than interval ownership.     |
| WebSocket client                 | [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L100)                                                                                                                                                                         | [`JsonWebSocketClient.close`](../../packages/shared/websocket/JsonWebSocketClient.ts#L242), [`WsQueueBoxClientService.close`](../../packages/shared/services/WsQueueBoxClientService.ts#L338)                                                                                             | Needs runtime validation under reconnect churn because socket event listeners are anonymous. |
| WebSocket server connection      | [`wsRoutes`](../../apps/api-v1/src/routes/ws-routes.ts#L7), [`JsonWebSocketServer.addConnection`](../../packages/shared/websocket/JsonWebSocketServer.ts#L61)                                                                                                           | [`JsonWebSocketServer.addListeners` close handler](../../packages/shared/websocket/JsonWebSocketServer.ts#L129)                                                                                                                                                                           | Proven from code: duplicate session id closes the previous connection.                       |
| QBox engine scheduler            | [`InboxOutboxEngine.start`](../../packages/shared/services/InboxOutboxEngine.ts#L45)                                                                                                                                                                                    | [`InboxOutboxEngine.stop`](../../packages/shared/services/InboxOutboxEngine.ts#L54), [`shutdownApiMiddleware`](../../packages/shared-web/browser/rallar.ts#L9873)                                                                                                                         | Strong suspicion: serialized task loops can matter under RTC message bursts.                 |
| Room/group state                 | [`WebRtcGroupManager.getOrCreate`](../../packages/shared/services/WebRtcGroupManager.ts#L60), [`WebRtcGroupService.acceptGroupUpdate`](../../packages/shared/services/WebRtcGroupService.ts#L84)                                                                        | [`WebRtcGroupManager.delete`](../../packages/shared/services/WebRtcGroupManager.ts#L84), [`WebRtcGroupManager.clear`](../../packages/shared/services/WebRtcGroupManager.ts#L106), [`WebRtcGroupManager.evictRetainedPeer`](../../packages/shared/services/WebRtcGroupManager.ts#L385)     | Needs runtime validation under room churn and retained connection budgets.                   |
| Topology snapshots               | [`RallarRtcTopologyService.updateGroupTopology`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L72)                                                                                                                                | [`RallarRtcTopologyService.removeGroupTopology`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L118)                                                                                                                                                 | Proven from code: topology is derived from active group/session state and RTT graph data.    |
| WebRTC-specific workers          | No runtime `new Worker` or `SharedWorker` creation was found in scoped `packages/**` or `apps/**` runtime paths; matching worker-like code is black-box/test helper code such as [`runWorker`](../../packages/shared-test/black-box-runner/execute-black-box.ts#L3340). | Test helper worker-like loops clean up through their runner context, not WebRTC runtime ownership.                                                                                                                                                                                        | Static search only; browser/runtime worker behavior was not exercised.                       |

## Suspected Hot Paths

| Confidence                | Hot path                                | Why it may be costly                                                                                                                                   | Static refs                                                                                                                                                                                                                                                                                                      | Validation question                                                                                                 |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Strong suspicion          | Data-channel send/receive               | `sendRaw`, JSON serialization, inbound parsing, callback fanout, buffered-amount checks, and queue replacement can run per realtime message.           | [`QRtcDataChannel.sendRaw`](../../packages/shared/webrtc/QRtcDataChannel.ts#L252), [`setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L388), [`handleBackPressure`](../../packages/shared/webrtc/QRtcDataChannel.ts#L612)                                                             | At gameplay rates, what are CPU cost, queue depth, dropped/replaced count, and p95 send latency per lane?           |
| Strong suspicion          | Room lane readiness loops               | AR Eye Hunter periodically waits for room lanes and may trigger peer/lane opening checks during gameplay.                                              | [`useRallarArena` lane readiness effect](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L1099), [`RallarFacade.waitForRtcRoomLaneOpen`](../../packages/shared-web/browser/rallar.ts#L6250)                                                                                                               | Under room churn, does readiness polling create repeated negotiation/lane checks or measurable UI/network overhead? |
| Strong suspicion          | Group reconciliation                    | `reconcileAllGroups` computes desired peers, online peers, retained peers, connects desired peers, disconnects stale peers, and evicts retained peers. | [`WebRtcGroupManager.reconcileAllGroups`](../../packages/shared/services/WebRtcGroupManager.ts#L199), [`WebRtcGroupManager.onlinePeerIds`](../../packages/shared/services/WebRtcGroupManager.ts#L282), [`WebRtcGroupManager.targetPeerIdsForGroup`](../../packages/shared/services/WebRtcGroupManager.ts#L300)   | Does reconcile work scale with total groups/sessions or only changed groups?                                        |
| Proven from code          | Server topology graph construction      | `createRoomGraph` builds edges for every pair of active sessions in a group.                                                                           | [`RallarRtcTopologyService.createRoomGraph`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L217)                                                                                                                                                                            | At expected room sizes, is O(n^2) topology construction acceptable?                                                 |
| Strong suspicion          | RTT-driven topology updates             | RTT messages can trigger global graph recomputation and topology update scheduling.                                                                    | [`initRttTopic`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L638), [`RallarRtcTopologyService.queueRttTopologyUpdate`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L128)                                                                              | Does RTT fan-in cause topology CPU spikes or delayed signaling under load?                                          |
| Strong suspicion          | Overlay multicast forwarding            | `sendImmediately` and `enqueueMany` iterate prepared next-hop messages and call data-channel sends.                                                    | [`WebRtcOverlayMulticastManager.sendPreparedMessage`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L586), [`sendImmediately`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L627), [`enqueueMany`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L633) | How many next-hop copies are created per room message, and do copies dominate allocation?                           |
| Needs runtime measurement | QueueBox scheduler and serialized tasks | Browser middleware installs RTC/outbox tasks with `maxConcurrency: 1`, and `InboxOutboxEngine` self-schedules task loops.                              | [`initialiseRtcOverlayMulticastManager`](../../packages/shared-web/browser/rtc-engine.ts#L25), [`initialiseRtcRxStreamer`](../../packages/shared-web/browser/rtc-engine.ts#L74), [`InboxOutboxEngine.executeTaskEngine`](../../packages/shared/services/InboxOutboxEngine.ts#L122)                               | During RTC traffic bursts, does queue lag or scheduler wake frequency become the bottleneck?                        |
| Strong suspicion          | WebSocket signaling parse/stringify     | WebSocket client/server parse and serialize JSON messages on signaling and QueueBox paths.                                                             | [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L100), [`JsonWebSocketClient.sendAsJsonString`](../../packages/shared/websocket/JsonWebSocketClient.ts#L234), [`JsonWebSocketServer.send`](../../packages/shared/websocket/JsonWebSocketServer.ts#L173)                | Under negotiation storms, is signaling CPU dominated by JSON encode/decode or by network/browser operations?        |
| Needs runtime measurement | RTP/RTCP stats collection               | Candidate-pair diagnostics call `pc.getStats()` and materialize the report into arrays/maps.                                                           | [`readSelectedCandidatePairDiagnostics`](../../packages/shared-web/browser/rallar.ts#L9213)                                                                                                                                                                                                                      | How often is diagnostics called in normal gameplay or debugging, and does `getStats()` affect frame/input latency?  |

## Cleanup Gaps or Unclear Ownership

| Confidence               | Gap or unclear owner                                                                  | Why it matters                                                                                                                                                                                                                                                                                                                             | Static refs                                                                                                                                                                                                                                                                                                                                                                                                   | Runtime validation                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Strong suspicion         | Some peer-connection event handlers/listeners are not fully removed                   | `closePeerConnectionIfPresent` nulls selected handlers and closes the peer connection, but the `icegatheringstatechange` listener is added with `addEventListener` and is not removed; assigned handlers such as `ondatachannel`, `oniceconnectionstatechange`, and `onsignalingstatechange` are not all nulled in the same cleanup block. | [`QRtcPeerConnection.closePeerConnectionIfPresent`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L132), [`setupStateChangeCallbacks`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L317), [`icegatheringstatechange` listener](../../packages/shared/webrtc/QRtcPeerConnection.ts#L374)                                                                                                           | Heap snapshot after repeated connect/disconnect cycles should confirm whether closed peer connections and closures are retained.         |
| Strong suspicion         | Heartbeat message callback lifetime is less explicit than heartbeat interval lifetime | `WebRtcHeartbeatService.stop` clears the interval but does not unregister the channel callback installed by `setupMessageHandler`; `WebRtcRxStreamerService.removePeer` removes callback ids around peer removal, but ownership relies on peer/channel object disposal.                                                                    | [`WebRtcHeartbeatService.stop`](../../packages/shared/services/WebRtcHeartbeatService.ts#L64), [`WebRtcHeartbeatService.setupMessageHandler`](../../packages/shared/services/WebRtcHeartbeatService.ts#L71), [`WebRtcRxStreamerService.removePeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167), [`QRtcDataChannel.clearCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L167) | Confirm whether heartbeat callbacks remain reachable after peer deletion and whether `QRtcDataChannel.reset` should clear callback maps. |
| Needs runtime validation | Signaling transport callback disposal is mostly socket/QBox-level                     | Signaling transports register callbacks on WebSocket/QBox services, while teardown generally closes the socket/QBox rather than disposing an individual transport subscription.                                                                                                                                                            | [`WsRtcSignalingTransportUsingWsQBox.connect`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L21), [`WsRtcSignalingTransport.connect`](../../packages/shared/webrtc/WsRtcSignalingTransport.ts#L19), [`WsQueueBoxClientService.close`](../../packages/shared/services/WsQueueBoxClientService.ts#L338)                                                                                   | Reconnect churn should verify that signaling callbacks do not multiply across middleware instances.                                      |
| Needs runtime validation | WebSocket client event listener cleanup depends on socket close/GC                    | `JsonWebSocketClient.openSocket` registers anonymous browser WebSocket listeners; `close` closes the socket and clears references, but listeners are not explicitly removed.                                                                                                                                                               | [`JsonWebSocketClient.openSocket`](../../packages/shared/websocket/JsonWebSocketClient.ts#L100), [`JsonWebSocketClient.close`](../../packages/shared/websocket/JsonWebSocketClient.ts#L242)                                                                                                                                                                                                                   | Browser heap snapshots should confirm old sockets and listeners are collected after reconnect failures.                                  |
| Unclear ownership        | Externally supplied media streams may be caller-owned                                 | Internally captured streams are tracked and stopped by `RallarFacade`, but externally supplied streams enter through options and are then attached to peers.                                                                                                                                                                               | [`RallarFacade.startMediaSource`](../../packages/shared-web/browser/rallar.ts#L5433), [`RallarFacade.stopMediaSource`](../../packages/shared-web/browser/rallar.ts#L5560), [`RallarFacade.attachLocalMediaSources`](../../packages/shared-web/browser/rallar.ts#L5613)                                                                                                                                        | Decide whether facade stop should always stop externally supplied tracks or whether API docs should state caller ownership.              |
| Needs runtime validation | Retained peer connections are intentional but need budget validation                  | `WebRtcGroupManager.delete` can retain peer connections, and eviction is budgeted through `evictRetainedPeer`; room churn could stress the retention policy.                                                                                                                                                                               | [`WebRtcGroupManager.delete`](../../packages/shared/services/WebRtcGroupManager.ts#L84), [`WebRtcGroupManager.retainPeerConnections`](../../packages/shared/services/WebRtcGroupManager.ts#L330), [`WebRtcGroupManager.evictRetainedPeer`](../../packages/shared/services/WebRtcGroupManager.ts#L385)                                                                                                         | Long-running room join/leave tests should check retained-peer count, timers, handlers, and memory.                                       |
| Strong suspicion         | Missed heartbeat callback can continue firing after max missed pings                  | `startHeartbeat` calls `onMissedPing` when missed count exceeds max, but the interval continues unless channel state closes or `stop` is called.                                                                                                                                                                                           | [`WebRtcHeartbeatService.startHeartbeat`](../../packages/shared/services/WebRtcHeartbeatService.ts#L132)                                                                                                                                                                                                                                                                                                      | Validate whether repeated missed-ping callbacks are intended and whether they cause reconnect storms or log/queue churn.                 |

## Runtime Validation Questions

1. Does `pc.restartIce()` reliably trigger the expected negotiation in target
   browsers, or should recovery explicitly force/send a fresh offer?
   Refs: [`QRtcPeerConnection.handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L524),
   [`RallarFacade.restartRtcIce`](../../packages/shared-web/browser/rallar.ts#L6340).
2. What is the per-message cost of high-rate gameplay data channels, including
   JSON parse/stringify, callback fanout, queue replacement, and dropped
   messages?
   Refs: [`QRtcDataChannel.sendRaw`](../../packages/shared/webrtc/QRtcDataChannel.ts#L252),
   [`QRtcDataChannel.setupDataChannelCallbacks`](../../packages/shared/webrtc/QRtcDataChannel.ts#L388),
   [`useRallarArena` realtime sends](../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts#L2033).
3. During room churn, do group reconciliation and retained peer connection
   budgets keep peer count, timers, listeners, and memory bounded?
   Refs: [`WebRtcGroupManager.reconcileAllGroups`](../../packages/shared/services/WebRtcGroupManager.ts#L199),
   [`WebRtcGroupManager.retainPeerConnections`](../../packages/shared/services/WebRtcGroupManager.ts#L330).
4. At expected room sizes, is topology computation acceptable, especially the
   complete graph in `createRoomGraph` and RTT-triggered topology updates?
   Refs: [`RallarRtcTopologyService.createRoomGraph`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L217),
   [`initRttTopic`](../../packages/shared-server/rallar-system/ws-system-topics.ts#L638).
5. Do heartbeat callbacks and data-channel callback maps get released after
   repeated peer creation/removal?
   Refs: [`WebRtcHeartbeatService.setupMessageHandler`](../../packages/shared/services/WebRtcHeartbeatService.ts#L71),
   [`WebRtcRxStreamerService.removePeer`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167),
   [`QRtcDataChannel.reset`](../../packages/shared/webrtc/QRtcDataChannel.ts#L160).
6. Do screen-share ended events, permission failures, and disconnects while
   `getDisplayMedia` is pending leave media sources and peer senders in the
   expected state?
   Refs: [`RallarFacade.captureMediaSource`](../../packages/shared-web/browser/rallar.ts#L5465),
   [`RallarFacade.registerMediaSourceEndedCallbacks`](../../packages/shared-web/browser/rallar.ts#L5637),
   [`QRtcPeerConnection.stopLocalMedia`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L690).
7. How expensive is `pc.getStats()` diagnostics when called during active
   gameplay or debugging?
   Refs: [`readSelectedCandidatePairDiagnostics`](../../packages/shared-web/browser/rallar.ts#L9213).

## Suggested Measurement Targets For Later

These are not benchmarks run by this audit. They are candidate next steps if
runtime validation is requested.

1. Browser connect/disconnect churn with heap snapshots and retained object
   counts for `RTCPeerConnection`, `RTCDataChannel`, callbacks, and timers.
2. High-rate realtime lane traffic with counters for send attempts, queued
   sends, drops/replacements, `bufferedAmount`, JSON payload bytes, and callback
   fanout.
3. Room churn with group count, active session count, desired peer count,
   retained peer count, and reconcile duration.
4. Server topology load with room sizes 3, 10, 30, 100 and RTT rates 1, 10, 50
   Hz.
5. ICE restart and reconnect scenarios across Chrome/Safari/Firefox, including
   Wi-Fi changes, tab backgrounding, and TURN-only network conditions.

## Notes

- The WebRTC runtime appears primarily peer-to-peer with application-level
  overlay forwarding, based on `QRtcPeerConnection`, `QRtcDataChannel`,
  `WebRtcOverlayMulticastManager`, and server signaling topic references.
- The black-box runner includes browser-backed WebRTC exercises through public
  Rallar APIs, while `rallar-webrtc-runtime.ts` is signaling-oriented and does
  not create browser `RTCPeerConnection` objects in that runtime abstraction.
  Refs: [`rallar-browser-runtime.connect`](../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime.ts#L1899),
  [`rallar-webrtc-runtime.ts`](../../packages/shared-test/black-box-runner/rallar-webrtc-runtime.ts#L162).
- Temporary runtime profiling artifacts, if collected later, should go under
  `tmp/perf/` per repo guidance.
