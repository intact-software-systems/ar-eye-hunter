# Rallar WebRTC Signaling and Negotiation Performance Audit

Date: 2026-07-02  
Mode: static analysis only  
Scope: WebRTC offer/answer negotiation, ICE candidate exchange, ICE restart/reconnect, WebSocket/QueueBox signaling, room join/leave reconciliation, participant updates, and server-side signaling fanout.  
Related docs:
- `playground/rallar-webrtc-performance-map-2026-07-02.md`
- `playground/rallar-webrtc-static-performance-audit-2026-07-02.md`
- `playground/rallar-webrtc-memory-retained-resource-audit-2026-07-02.md`
- `playground/rallar-webrtc-datachannel-backpressure-audit-2026-07-02.md`

## Executive Summary

Top WebRTC signaling/negotiation performance risks:

1. **Unbounded, non-deduplicated ICE candidate queue per peer** (`QRtcPeerConnection.processSignal`, `flushIceCandidateQueue`). Confidence: Proven from code.
2. **Potential reconnect/renegotiation storms from repeated disconnect timers plus direct/manual ICE restarts** (`QRtcPeerConnection.setupStateChangeCallbacks`, `handleReconnect`, `Rallar.restartRtcIce`). Confidence: Strong suspicion.
3. **Heavy JSON serialization/logging on signaling hot paths, including full SDP/candidate payloads** (`QRtcPeerConnection.onnegotiationneeded`, `sendSignal`, `processSignal`, `WebRtcConnectionService.toSignalingProtocol`, QueueBox resource conversion). Confidence: Proven from code.
4. **Stale/duplicate signaling messages are only partly guarded**: stale answers are guarded, but messages lack negotiation/session generation IDs and ICE candidates are not deduped (`QRtcSignalingMessage`, `WebRtcConnectionService.toSignalingProtocol`, `QRtcPeerConnection.processSignal`). Confidence: Strong suspicion.
5. **Room/presence reconciliation scans room, client, and peer sets on each update; overlapping reconcile calls serialize but are not coalesced into a follow-up run** (`WebRtcGroupManager.reconcileAllGroups`, `WebRtcGroupService.acceptGroupUpdate`). Confidence: Needs runtime measurement.

## Signaling Flow Map

### Browser setup and transport

1. `initialiseRtcConnectionService` constructs `WebRtcConnectionService` with `WsRtcSignalingTransportUsingWsQBox`, session ID, ICE config, lane config, peer-establishment timeout, attempt budget, and max peer count in `packages/shared-web/browser/rtc-engine.ts:114`.
2. `WebRtcConnectionService.connectSignaler` registers the signaling protocol callbacks through `this.signaler.connect(...)` in `packages/shared/services/WebRtcConnectionService.ts:343`.
3. `WsRtcSignalingTransportUsingWsQBox.connect` registers WebSocket lifecycle callbacks with `qbox.socket.onWebsocketCallbacksDo(...)` and inbox callbacks with `qbox.onInboxMessageDo(...)` in `packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts:21`.
4. `JsonWebSocketClient.openSocket` parses every incoming WebSocket message with `JSON.parse(ev.data)` before invoking registered callbacks in `packages/shared/websocket/JsonWebSocketClient.ts:157`.

### Outbound offer/answer/candidate path

1. `QRtcPeerConnection.connect` creates `new RTCPeerConnection(this.configuration)` in `packages/shared/webrtc/QRtcPeerConnection.ts:217`.
2. `pc.onnegotiationneeded` gates on `makingOffer` and `pc.signalingState === 'stable'`, then calls `pc.setLocalDescription()` and sends `QRtcSignalingType.Offer` in `packages/shared/webrtc/QRtcPeerConnection.ts:236`.
3. `pc.onicecandidate` sends each non-null candidate immediately as `QRtcSignalingType.IceCandidate` in `packages/shared/webrtc/QRtcPeerConnection.ts:265`.
4. `QRtcPeerConnection.sendSignal` wraps the payload as `QRtcSignalingMessage`, appends it to `outboundSignalingChain`, logs `JSON.stringify(signal)`, and calls `signaler.send(signal)` in `packages/shared/webrtc/QRtcPeerConnection.ts:599`.
5. `WsRtcSignalingTransportUsingWsQBox.send` wraps the signaling message in an AL unicast message and calls `qbox.enqueueOutboxIfAbsent(...)` in `packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts:71`.
6. `WsQueueBoxClientService.enqueueOutboxIfAbsent` forwards to `outboundRuntime.enqueueIfAbsent(...)` in `packages/shared/services/WsQueueBoxClientService.ts:493`.
7. `QueueBoxUtilities.toResourceEntryFromMsg` serializes AL messages with `JSON.stringify(msg)` in `packages/shared/services/QueueBoxUtilities.ts:79`.
8. `WsQueueBoxClientService.dispatchOutboxEntry` sends the already-stringified entry through `socket.sendAsJsonString(entry.resource)` in `packages/shared/services/WsQueueBoxClientService.ts:581`.

### Inbound signaling path

1. `WsQueueBoxClientService.handleIncomingWsMessage` hands inbound AL messages to `inboundRuntime.handleIncomingMessage(...)` in `packages/shared/services/WsQueueBoxClientService.ts:525`.
2. Stored inbound entries are parsed with `JSON.parse(entry.resource)` in `WsQueueBoxClientService.dispatchInboxEntry` at `packages/shared/services/WsQueueBoxClientService.ts:529`.
3. The signaling transport callback checks the AL payload type and calls `WebRtcConnectionService.toSignalingProtocol().onMessage(...)` in `packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts:49`.
4. `WebRtcConnectionService.toSignalingProtocol().onMessage` logs `message.payload.resource`, parses it into `QRtcSignalingMessage`, validates `toId`/self messages, creates a peer for plausible missing-peer inbound offers/candidates, then dispatches to `peerDto.connection.handleSignal(...)` in `packages/shared/services/WebRtcConnectionService.ts:428`.
5. `QRtcPeerConnection.handleSignal` serializes inbound signaling through `signalingChain`, then `processSignal` handles Answer, Offer, or IceCandidate in `packages/shared/webrtc/QRtcPeerConnection.ts:418`.

### Server-side fanout path

1. `WsQueueBoxServerService.enqueueOutboxIfAbsent` may pre-resolve broadcast recipients before enqueueing in `packages/shared/services/WsQueueBoxServerService.ts:306`.
2. `WsQueueBoxServerService.planOutgoingMessage` validates and resolves recipients, then materializes one prepared message per recipient in `packages/shared/services/WsQueueBoxServerService.ts:485`.
3. `WsQueueBoxServerService.sendPreparedMessage` sends each prepared message with `this.socket.send(...)`, which JSON-encodes per send in `packages/shared/services/WsQueueBoxServerService.ts:618` and `packages/shared/websocket/JsonWebSocketServer.ts:177`.
4. The live send path `sendToTargetsWithResult` is better for fanout because it encodes once and reuses `sendEncoded(...)` per recipient in `packages/shared/services/WsQueueBoxServerService.ts:414`.

## Negotiation State Machine Summary

### Create/connect

- `WebRtcGroupManager.reconcileAllGroups` decides which peers should connect based on desired room peers, online session IDs, retained peers, and known WebRTC peers in `packages/shared/services/WebRtcGroupManager.ts:231`.
- `WebRtcConnectionService.ensurePeerConnectionStarted` creates or reuses the peer DTO, starts the peer connection, connects data-channel lanes, and connects media in `packages/shared/services/WebRtcConnectionService.ts:672`.
- `WebRtcConnectionService.computeRtcPeerDtoIfAbsent` creates `QRtcPeerConnection`, data channels, and media channel, then stores the peer DTO in `peerDtoByPeerId` in `packages/shared/services/WebRtcConnectionService.ts:932`.
- `QRtcPeerConnection.connect` creates the browser `RTCPeerConnection` and registers negotiation, ICE, data-channel, track, and state handlers in `packages/shared/webrtc/QRtcPeerConnection.ts:217`.

### Offer creation

- Trigger: browser fires `onnegotiationneeded`, commonly after data-channel creation (`QRtcPeerConnection.createDataChannel`) or track/transceiver changes.
- Guard: if `makingOffer` is true or `pc.signalingState !== 'stable'`, the handler returns in `packages/shared/webrtc/QRtcPeerConnection.ts:241`.
- Action: set `makingOffer = true`, call `pc.setLocalDescription()` to auto-create the offer, log the local description, send `QRtcSignalingType.Offer`, then clear `makingOffer` in `packages/shared/webrtc/QRtcPeerConnection.ts:246`.

### Answer creation

- Trigger: inbound `QRtcSignalingType.Offer` in `QRtcPeerConnection.processSignal`.
- Glare handling: compute `offerCollision = makingOffer || pc.signalingState !== 'stable'`; impolite peers ignore colliding offers, polite peers roll back then set the remote offer in `packages/shared/webrtc/QRtcPeerConnection.ts:458`.
- Action: flush queued ICE candidates, call `pc.setLocalDescription()` to auto-create the answer, clear `makingOffer`/`ignoreOffer`, and send `QRtcSignalingType.Answer` in `packages/shared/webrtc/QRtcPeerConnection.ts:481`.

### Answer receive

- Guard: inbound answers are ignored unless `pc.signalingState === 'have-local-offer'` in `packages/shared/webrtc/QRtcPeerConnection.ts:444`.
- Action: `pc.setRemoteDescription(msg.description)`, flush ICE candidates, and clear offer/glare flags in `packages/shared/webrtc/QRtcPeerConnection.ts:452`.

### ICE candidate exchange

- Outbound: every candidate event sends one signaling message immediately in `packages/shared/webrtc/QRtcPeerConnection.ts:265`.
- Inbound: if remote description exists, `pc.addIceCandidate(msg.candidate)` runs immediately; otherwise the candidate is pushed into `status.iceCandidateQueue` in `packages/shared/webrtc/QRtcPeerConnection.ts:507`.
- Flush: `flushIceCandidateQueue` splices the full queue and awaits `pc.addIceCandidate` sequentially for each candidate in `packages/shared/webrtc/QRtcPeerConnection.ts:525`.

### Reconnect and ICE restart

- `QRtcPeerConnection.setupStateChangeCallbacks` schedules a delayed reconnect on `connectionState === 'disconnected'` and calls `handleReconnect` immediately on `failed` in `packages/shared/webrtc/QRtcPeerConnection.ts:335`.
- `QRtcPeerConnection.handleReconnect` caps attempts at five, uses exponential backoff, and appends `pc.restartIce()` onto `signalingChain` in `packages/shared/webrtc/QRtcPeerConnection.ts:537`.
- The public recovery facade `Rallar.restartRtcIce` directly calls `pc.restartIce()` without checking `QRtcPeerConnection`'s reconnect timer or signaling chain in `packages/shared-web/browser/rallar.ts:6340`.
- `Rallar.reconnectRtcPeer` disconnects a peer and then starts a fresh connection or waits for a lane to open in `packages/shared-web/browser/rallar.ts:6386`.

### Close/dispose

- `WebRtcConnectionService.removePeerIfPresent` clears the peer establishment watchdog, tentative/attempt state, resets media and data channels, calls `rtcPeer.connection.reset()`, and deletes from `peerDtoByPeerId` in `packages/shared/services/WebRtcConnectionService.ts:305`.
- `QRtcPeerConnection.reset` calls `closePeerConnectionIfPresent` and restores initial state in `packages/shared/webrtc/QRtcPeerConnection.ts:108`.
- `QRtcPeerConnection.closePeerConnectionIfPresent` stops transceivers, nulls event handlers, removes the ICE gathering listener, closes the PC, and clears reconnect/disconnect timers in `packages/shared/webrtc/QRtcPeerConnection.ts:133`.

## Hot Path Findings

| Severity | Confidence | Category | Location | Finding | WebRTC impact | How to validate | Suggested fix after measurement |
|---|---|---|---|---|---|---|---|
| High | Proven from code | ICE candidate handling | `QRtcPeerConnection.processSignal`, `flushIceCandidateQueue` (`packages/shared/webrtc/QRtcPeerConnection.ts:497`, `:525`) | Candidates arriving before remote description are appended to `iceCandidateQueue` with no cap, TTL, dedupe key, or per-offer generation check. Flush drains the whole queue and awaits `addIceCandidate` one-by-one. | Candidate bursts or stale duplicate candidates can grow memory and add sequential async work before a call becomes connected. | Count `iceCandidateQueue.length`, duplicate candidate strings/foundations, max age in queue, and flush duration per peer. | Add bounded/deduped candidate queues keyed by candidate identity and negotiation generation; record/drop stale candidates after close or generation change. |
| High | Strong suspicion | Reconnect / renegotiation storms | `QRtcPeerConnection.setupStateChangeCallbacks`, `handleReconnect`, `Rallar.restartRtcIce` (`packages/shared/webrtc/QRtcPeerConnection.ts:335`, `:537`; `packages/shared-web/browser/rallar.ts:6340`) | `disconnected` assigns a new `disconnectTimer` without clearing an existing one; `connected` clears `reconnectTimer` but not `disconnectTimer`; manual `restartRtcIce` calls `pc.restartIce()` outside the peer's `signalingChain`/timer guard. | Repeated disconnect/connect flapping can schedule multiple delayed reconnect checks or duplicate ICE restarts, each potentially triggering negotiationneeded and offer generation. | Trace disconnect timer creation/clear counts, restartIce calls, `negotiationneeded` events, offers sent per peer per minute, and reconnect timer overlap. | Coalesce disconnect timers, clear pending disconnect timers on `connected`, and route all ICE restarts through one guarded peer-level restart path. |
| High | Proven from code | Serialization and logging | `QRtcPeerConnection.onnegotiationneeded`, `processSignal`, `sendSignal`; `WebRtcConnectionService.toSignalingProtocol`; `QueueBoxUtilities.toResourceEntryFromMsg` (`packages/shared/webrtc/QRtcPeerConnection.ts:249`, `:436`, `:614`; `packages/shared/services/WebRtcConnectionService.ts:445`; `packages/shared/services/QueueBoxUtilities.ts:79`) | Full local descriptions, inbound signal payloads, outbound signal payloads, and AL messages are stringified/logged on hot signaling paths. SDP strings and ICE candidates can be large and frequent. | CPU allocation pressure and log I/O during offer/answer and ICE storms; can distort timing-sensitive negotiation. | Measure count/bytes of signal logs, JSON stringify time, SDP byte length, candidate message rate, and long tasks during candidate gathering. | Gate verbose logging by level/sampling; log message metadata instead of full SDP/candidate payloads on hot paths. |
| Medium | Strong suspicion | Stale or duplicate signaling | `QRtcSignalingMessage`, `WebRtcConnectionService.toSignalingProtocol`, `QRtcPeerConnection.processSignal` (`packages/shared/webrtc/QRtcSignalingContracts.ts:17`; `packages/shared/services/WebRtcConnectionService.ts:451`; `packages/shared/webrtc/QRtcPeerConnection.ts:444`, `:507`) | Signaling messages carry `fromId`, `toId`, `sessionId`, and type, but no negotiation generation, peer-connection generation, or offer sequence. Stale answers are guarded by signaling state, but stale offers/candidates from the same peer can still be plausible after peer recreation. | Recreated peer connections may spend CPU on old offers/candidates or create unnecessary peers for stale inbound candidates/offers. | Add traces with peer-generation ID, offer ID, message age, and whether each signal targets the current PC instance. Count ignored stale answers vs accepted stale-looking offers/candidates. | Add generation/offer IDs to signaling and reject messages not matching the current peer connection generation. |
| Medium | Proven from code | Candidate trickle fanout | `QRtcPeerConnection.onicecandidate`, `WsRtcSignalingTransportUsingWsQBox.send`, `WsQueueBoxClientService.enqueueOutboxIfAbsent` (`packages/shared/webrtc/QRtcPeerConnection.ts:265`; `packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts:71`; `packages/shared/services/WsQueueBoxClientService.ts:493`) | Each ICE candidate becomes its own signaling message and QueueBox enqueue. There is no batching or coalescing at this layer. | Bursty candidate gathering translates directly into JSON, QueueBox planning, WebSocket sends, and server routing work. | Count candidates per connection, qbox enqueues per offer, enqueue latency, outbox depth, and WebSocket send bytes during ICE gathering. | Consider candidate batching/coalescing only after confirming enqueue/send overhead is material. |
| Medium | Needs runtime measurement | Room reconciliation cost | `WebRtcGroupManager.reconcileAllGroups`, `WebRtcGroupService.acceptGroupUpdate` (`packages/shared/services/WebRtcGroupManager.ts:231`; `packages/shared/services/WebRtcGroupService.ts:84`) | Each group update computes before/after targets, notifies callbacks, then `reconcileAllGroups` rebuilds peer owners, online peer set, known peer set, connectable peers, disconnect peers, and retained-peer eviction. `reconcileInFlight` serializes overlap but does not mark that another reconcile is needed after an in-flight run. | Frequent presence changes can repeatedly scan group/client/peer state and may miss/coalesce updates depending on callback timing; reconnect/offer work may be clustered after room churn. | Trace reconcile duration, pending/skipped reconcile count, group count, member count, known peer count, and connection starts per reconcile. | Add a dirty flag/follow-up reconcile if updates arrive during a run; debounce only if runtime traces show churn. |
| Medium | Proven from code | Server-side fanout serialization | `WsQueueBoxServerService.planOutgoingMessage`, `sendPreparedMessage`, `JsonWebSocketServer.send` (`packages/shared/services/WsQueueBoxServerService.ts:485`, `:618`; `packages/shared/websocket/JsonWebSocketServer.ts:177`) | Persisted/prepared server sends materialize one prepared message per recipient and call `socket.send`, which JSON-stringifies per recipient. The live path encodes once in `sendToTargetsWithResult`. | Broadcast/multicast signaling-like traffic can become O(recipients x message size) serialization instead of O(message size + recipients). | Count server send mode, recipient count, JSON stringify bytes/time per fanout, and message size. | Reuse encoded payloads for prepared fanout where semantics allow. |
| Medium | Proven from code | Broadcast recipient resolution | `WsQueueBoxServerService.enqueueOutboxIfAbsent`, `validateMessage`, `resolveRecipients` (`packages/shared/services/WsQueueBoxServerService.ts:306`, `:516`, `:671`) | Broadcast enqueue pre-resolves recipients to check no-route, then `planOutgoingMessage`/`validateMessage` resolves recipients again. Broadcast filtering also uses `exceptPeerIds?.includes` inside recipient filtering. | Broadcast-heavy room/session updates can repeat O(recipients) work; large `exceptPeerIds` could make filtering O(recipients x exceptPeerIds). | Count recipient resolution calls per message, recipient count, except list length, and resolve time. | Cache the resolved recipient list during planning and convert except lists to a `Set` when large. |
| Low | Proven from code | SDP munging/parsing | Scoped search; `QRtcPeerConnection` (`packages/shared/webrtc/QRtcPeerConnection.ts:247`, `:452`, `:474`, `:482`, `:813`) | No string-level SDP parsing/munging was found in the scoped code paths. SDP handling goes through browser APIs plus `setCodecPreferences`. | Low risk for repeated custom SDP parsing. SDP cost is mostly browser API work plus serialization/logging of descriptions. | Keep search in CI or audit notes if SDP munging is added later. | None now; do not optimize. |

## State and Lifecycle Risks

| Severity | Confidence | Location | Risk | Validation |
|---|---|---|---|---|
| High | Strong suspicion | `QRtcPeerConnection.setupStateChangeCallbacks` (`packages/shared/webrtc/QRtcPeerConnection.ts:351`) | Repeated `disconnected` events can overwrite `status.disconnectTimer` without clearing the previous timer. A later `connected` state does not clear `disconnectTimer`, and `stopReconnectTimer` is only defined, not used (`packages/shared/webrtc/QRtcPeerConnection.ts:647`). | Instrument timer IDs and lifecycle events. Confirm whether multiple delayed callbacks can survive a flap and whether they call `handleReconnect` after reconnection. |
| Medium | Strong suspicion | `QRtcPeerConnection.handleReconnect` (`packages/shared/webrtc/QRtcPeerConnection.ts:570`) | The delayed reconnect appends `pc.restartIce()` to `signalingChain` but does not attach a catch to that new chain the way `handleSignal` does. The closure reads `this.status.pc` at execution time, so stale delayed work could act on a later PC unless timer cleanup always wins. | Trace peer connection generation at timer creation and at restart execution; count rejected signaling chains. |
| Medium | Strong suspicion | `WsRtcSignalingTransportUsingWsQBox.connect`; `QRtcSignalingTransport` (`packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts:21`; `packages/shared/webrtc/QRtcSignalingContracts.ts:45`) | The transport interface exposes `connect`/`send` but no disconnect/unregister. The implementation registers qbox socket and inbox callbacks; cleanup depends on outer qbox/service lifetime rather than WebRTC signaling lifetime. | On repeated middleware connect/disconnect, count callback map sizes in `JsonWebSocketClient` and `WsQueueBoxClientService`. |
| Medium | Needs runtime measurement | `WsQueueBoxClientService.dequeueInbox` (`packages/shared/services/WsQueueBoxClientService.ts:514`) | `dequeueOutbox` skips when closed, but `dequeueInbox` lacks the same closed check. If the engine keeps invoking inbox dequeue after close, stale signaling callbacks may still dispatch. | Trace inbox dequeue after `WsQueueBoxClientService.close`, callback dispatch count after close, and qbox engine task lifecycle. |
| Medium | Proven from code | `WebRtcConnectionService.removePeerIfPresent` and `QRtcPeerConnection.closePeerConnectionIfPresent` (`packages/shared/services/WebRtcConnectionService.ts:305`; `packages/shared/webrtc/QRtcPeerConnection.ts:133`) | Normal peer cleanup is fairly complete: watchdog/tentative/attempt state is cleared, channels/media reset, PC handlers removed, listeners removed, PC closed, and timers cleared. | Runtime validation should verify this path runs for close, room leave, reconnect, navigation shutdown, and peer-establishment timeout. |

## Algorithmic Complexity Risks

| Confidence | Location | Complexity | Why it matters | Validation |
|---|---|---|---|---|
| Needs runtime measurement | `WebRtcGroupManager.buildPeerOwners` (`packages/shared/services/WebRtcGroupManager.ts:157`) | O(groups x target peers per group), plus array copies for each peer owner list. | Called through `peerOwners()` when the cache is invalidated by group state changes. Large rooms or many scoped rooms could make presence churn expensive. | Record group count, target peer count, cache invalidation count, and build duration. |
| Needs runtime measurement | `WebRtcGroupManager.onlinePeerIds` (`packages/shared/services/WebRtcGroupManager.ts:323`) | O(client cache keys + active sessions). | Every reconcile reads the client cache to rebuild online peer IDs. | Record client cache size, active sessions per client, and reconcile frequency. |
| Needs runtime measurement | `WebRtcGroupManager.reconcileAllGroups` (`packages/shared/services/WebRtcGroupManager.ts:231`) | O(desired peers + online peers + known peers + retained peers log retained peers) because retained eviction sorts retained peers. | Room churn can trigger repeated reconciles and peer start/disconnect loops. | Record reconcile duration buckets and retained peer sort size. |
| Proven from code | `WebRtcGroupService.computeDiff` (`packages/shared/services/WebRtcGroupService.ts:202`) | O(before + after) using Sets. | This part is appropriately linear; not a suspected bottleneck unless snapshots are huge or extremely frequent. | Measure only if group update rates are high. |
| Proven from code | `WsQueueBoxServerService.resolveRecipients` broadcast path (`packages/shared/services/WsQueueBoxServerService.ts:701`) | O(recipients x exceptPeerIds) when `exceptPeerIds` is large because `.includes` is inside the filter. | Usually harmless for small except lists, but can become visible for large broadcast exclusions. | Record except list length and broadcast recipient count. |

## Memory Retention Risks

| Severity | Confidence | Location | Risk | Validation |
|---|---|---|---|---|
| High | Proven from code | `QRtcPeerConnectionStatus.iceCandidateQueue`, `processSignal` (`packages/shared/webrtc/QRtcPeerConnection.ts:75`, `:510`) | Candidate queue can grow until remote description arrives; there is no cap/dedupe/expiry. | Track queue high-water marks, age, and retained candidate count over failed/stale negotiations. |
| Medium | Strong suspicion | `WebRtcConnectionService.peerDtoByPeerId`, `tentativePeerIds`, attempt state (`packages/shared/services/WebRtcConnectionService.ts:463`, `:474`, `:1121`) | Plausible missing-peer inbound offers/candidates can create peers. Cleanup exists, but stale candidate/offer storms may create tentative peers until timeout/budget paths run. | Count peers created by inbound missing-peer signals, tentative peer lifetime, timeout removals, and budget exhaustion. |
| Medium | Strong suspicion | `WsRtcSignalingTransportUsingWsQBox.connect` callback registrations (`packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts:21`) | Signaling callbacks may stay in qbox/socket maps for the lifetime of the QueueBox client because no transport-level unregister exists. | Measure callback map sizes before/after repeated `initialiseRtcConnectionService`/shutdown. |
| Medium | Needs runtime measurement | `WebRtcGroupManager.retainedPeerConnections` (`packages/shared/services/WebRtcGroupManager.ts:47`, `:371`, `:417`) | Retained peers intentionally survive group deletion with `retainConnections`; eviction is budgeted by `maxPeerConnections`, but actual lifetimes under room churn need validation. | Track retained peer count, retained age, evictions, and disconnects after room leave/rejoin. |

## Duplicate and Stale Message Handling

| Signal | Existing guard | Gap | Confidence |
|---|---|---|---|
| Answer | Ignored unless `pc.signalingState === 'have-local-offer'` in `QRtcPeerConnection.processSignal` (`packages/shared/webrtc/QRtcPeerConnection.ts:444`). | No explicit offer ID, so the guard depends on browser signaling state rather than matching the answer to the actual outbound offer. | Proven guard, suspected gap. |
| Offer | Perfect-negotiation glare handling with `makingOffer`, stable-state check, polite rollback, and impolite ignore in `QRtcPeerConnection.processSignal` (`packages/shared/webrtc/QRtcPeerConnection.ts:463`). | Duplicate/stale offers from the same peer are not rejected by message generation or timestamp. | Strong suspicion. |
| ICE candidate | Impolite ignored-offer state drops candidates; otherwise candidates are added or queued in `QRtcPeerConnection.processSignal` (`packages/shared/webrtc/QRtcPeerConnection.ts:502`). | No candidate dedupe, no generation matching, no queue cap, and no stale-message age check. | Proven from code. |
| Missing-peer Answer | Denied in `WebRtcConnectionService.isPlausibleMissingPeerSignal` (`packages/shared/services/WebRtcConnectionService.ts:531`). | Missing-peer Offer and ICE candidate can create a peer if otherwise plausible and capacity allows. | Proven from code. |

## Suggested Runtime Counters and Traces

Do not optimize yet. Add temporary counters/traces first, preferably behind a diagnostics sink or debug flag:

1. **Negotiation counters per peer**
   - `negotiationneeded` events
   - offers created
   - offers sent
   - answers created
   - answers accepted/ignored as stale
   - glare collisions
   - polite rollbacks
   - time spent in `setLocalDescription` and `setRemoteDescription`

2. **ICE counters per peer**
   - local candidates emitted
   - candidates sent
   - candidates received
   - candidates added immediately
   - candidates queued
   - candidate queue high-water mark
   - duplicate candidate count
   - candidate age at flush
   - flush duration and `addIceCandidate` failures

3. **Reconnect and timer traces**
   - disconnect timer created/cleared/fired
   - reconnect timer created/cleared/fired
   - `restartIce` calls by source: auto reconnect, facade/manual, browser/app recovery
   - peer connection generation at timer creation/firing
   - connection state transition sequence

4. **Signaling serialization and queue metrics**
   - SDP byte length
   - candidate JSON byte length
   - `JSON.stringify`/`JSON.parse` counts on signaling paths
   - QueueBox enqueue latency
   - outbox/inbox queue depth
   - WebSocket send bytes and send failures
   - log bytes for offer/answer/candidate paths

5. **Room/session reconciliation metrics**
   - group count
   - members per group
   - client cache size
   - desired/online/known/retained peer counts
   - reconcile duration
   - reconcile calls while another reconcile is in flight
   - peer starts/disconnects per reconcile

6. **Server fanout metrics**
   - target mode: unicast/multicast/broadcast
   - recipient count
   - recipient resolution duration
   - prepared message count
   - encoded byte length
   - JSON encode count per outbound message

## Top 5 Fixes to Consider After Measurement

1. **Bound and dedupe ICE candidate queues.** Add queue caps, candidate identity dedupe, age limits, and negotiation/PC generation matching in `QRtcPeerConnection`.
2. **Unify ICE restart scheduling.** Route manual and automatic restart requests through a single guarded peer-level function; clear `disconnectTimer` on `connected`; prevent duplicate delayed reconnect callbacks.
3. **Add signaling generation IDs.** Include peer-connection generation and offer sequence/transaction IDs in `QRtcSignalingMessage`; reject stale offers, answers, and candidates early.
4. **Reduce hot-path serialization/logging.** Replace full SDP/candidate `JSON.stringify` logs with metadata logs under a debug flag; measure before removing or changing any diagnostics.
5. **Coalesce room reconciliation and fanout work.** If traces show churn, add dirty-follow-up behavior to `reconcileAllGroups`, reuse recipient resolution in server outbound planning, and reuse encoded payloads for prepared fanout where semantics allow.

## Questions Requiring Runtime Validation

1. How often does `onnegotiationneeded` fire per peer during normal data-channel setup, media attach, screen sharing, and ICE restart?
2. Are duplicate ICE candidates common in the supported browsers/network configurations?
3. Can `disconnectTimer` callbacks fire after a peer reconnects, and if so do they trigger extra `handleReconnect` calls?
4. Are stale offers/candidates observed after peer deletion/recreation or WebSocket reconnect?
5. Under room churn, how many reconcile calls arrive while `reconcileInFlight` is set, and does the final peer state always converge without a follow-up dirty run?
6. How many signaling messages are persisted through QueueBox stores versus sent live, especially while the socket is closed or reconnecting?
7. Does server signaling stay mostly unicast, or do room/session updates use multicast/broadcast enough for fanout serialization to matter?

