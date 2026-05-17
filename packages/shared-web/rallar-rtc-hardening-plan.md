# Rallar RTC Hardening Plan

This document organizes the RTC lifecycle findings from `packages/shared-web/browser/rallar.ts`
and the lower-level RTC services it uses. It is intentionally analysis and planning only.

## Scope

Primary code paths reviewed:

- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/middleware.ts`
- `packages/shared-web/browser/rtc-engine.ts`
- `packages/shared/services/WebRtcConnectionService.ts`
- `packages/shared/webrtc/QRtcPeerConnection.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `packages/shared/services/WebRtcGroupManager.ts`
- `packages/shared/services/WebRtcRxStreamerService.ts`
- `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`
- `packages/shared/services/WsQueueBoxClientService.ts`

## Current Lifecycle

### 1. Facade Connection

`rallar.connect()` is a single-flight facade-level initializer:

- If `this.ctx` exists, it returns the existing middleware context.
- If `this.connectPromise` exists, concurrent callers await the same promise.
- On first success it stores `this.ctx`, marks `connectState = 'connected'`, registers message callbacks, registers realtime lifecycle callbacks, registers remote stream callbacks, and emits state.
- On failure it resets `connectState = 'idle'`.

Important consequence: `dataChannelLanes` are only applied on the first successful connect. Later `connect({ dataChannelLanes })` calls return the cached context and do not update lane configuration.

### 2. Middleware Initialization

`initialiseMiddleware()` performs the runtime setup:

1. Initialize browser repositories and AL runtime stores.
2. Read API config.
3. Create a WebSocket ticket.
4. Create and connect `JsonWebSocketClient`.
5. Start `InboxOutboxEngine`.
6. Initialize `WsQueueBoxClientService`.
7. Read ICE candidates.
8. Initialize `WebRtcConnectionService` and connect signaling over the WebSocket queuebox.
9. Initialize RTC overlay multicast and RX streamer services.
10. Register peer lifecycle callbacks so new peers are added to the RX streamer.
11. Hydrate state caches.
12. Initialize heartbeat.

The state-cache hydration installs repository observers. Group and client presence updates call `WebRtcGroupManager.reconcileAllGroups()`, which connects missing online peers and disconnects peers no longer desired.

### 3. Peer Creation

`WebRtcConnectionService.ensurePeerConnectionStarted(peerId)` serializes connection attempts per peer through `pendingConnections`.

For a new peer it creates:

- One `QRtcPeerConnection`.
- A default reliable `QRtcDataChannel`.
- Any configured extra data-channel lanes, such as the default `realtime` lane.
- One `QRtcMediaChannel`.

After storing the peer DTO in `peerDtoByPeerId`, it calls peer lifecycle `onCreated` callbacks. The middleware-registered callback attaches the peer to `WebRtcRxStreamerService`, which registers reliable-channel message handling, heartbeats, media callbacks, and existing RTC message callbacks.

### 4. Signaling

The signaling transport is `WsRtcSignalingTransportUsingWsQBox`, which registers:

- WebSocket open, close, and error callbacks.
- An inbox callback for RTC signaling messages on the configured signaling topic.

Incoming signaling messages are handled by `WebRtcConnectionService.toSignalingProtocol()`:

- Wrong session id: throw.
- Message not addressed to local session: ignore.
- Message from self: ignore.
- Unknown peer: accept/create peer, then handle signal.
- Existing peer: pass signal to `QRtcPeerConnection.handleSignal()`.

`QRtcPeerConnection` uses a serialized signaling chain and a separate outbound signaling chain.

### 5. PeerConnection Setup

`QRtcPeerConnection.connect()`:

- Creates a new `RTCPeerConnection`.
- Registers `onnegotiationneeded`, `onicecandidate`, `ondatachannel`, `ontrack`, and connection state callbacks.
- Sends offers, answers, and ICE candidates through the signaling transport.
- Uses a perfect-negotiation style polite/impolite collision rule.

Connection state handling:

- `connected`: marks session open, resets reconnect attempts, clears reconnect timer.
- `disconnected`: starts a 5 second timer, then attempts reconnect if still disconnected.
- `failed`: marks failed and starts reconnect immediately.
- `closed`: marks closed and calls `onClosed`, which removes the peer from `WebRtcConnectionService`.

### 6. Data Channel Setup

Each `QRtcDataChannel.connect(isInitiator)`:

- Marks the wrapper as `Connecting`.
- Registers a per-label `onDataChannelDo()` callback on the peer connection.
- If initiator, calls `createDataChannel()` immediately and attaches handlers.
- If receiver, waits for an incoming `RTCDataChannel` with a matching label.

On channel open:

- Marks wrapper `Open`.
- Resolves open waiters with `true`.
- Calls registered lifecycle `onOpen` callbacks.

On channel close:

- Marks wrapper `Closed`.
- Resolves open waiters with `false`.
- Calls registered lifecycle `onClose` callbacks.
- Does not clear `status.dc`.

On channel error:

- Marks wrapper `Failed`.
- Resolves open waiters with `false`.
- Calls registered lifecycle `onError` callbacks.
- Does not clear `status.dc`.

## Reconnect Behavior

### Facade Reconnect

There is no explicit facade reconnect mode. A full facade reconnect means:

1. Call `rallar.disconnect()`.
2. Call `rallar.connect()` again.

`disconnect()` removes some callbacks, stops local media, stops the queue engine, closes the WebSocket, clears facade state, and calls `clearMiddleware()`.

### WebSocket Reconnect

`WsQueueBoxClientService.enableReconnect()` registers socket callbacks that call `reconnect()` on WebSocket close or error. `reconnect()` retries `socket.connect()` with an unbounded retry helper.

This also fires for intentional close unless something removes or suppresses the callback.

### PeerConnection Reconnect

`QRtcPeerConnection.handleReconnect()` tries an ICE restart:

- Maximum reconnect attempts: 5.
- Backoff: 2s, 4s, 8s, 16s, 32s.
- If the connection becomes connected, connecting, or new during the wait, reconnect attempts reset.
- Otherwise it calls `pc.restartIce()`.
- If attempts are exhausted, it calls `reset()`.

This reconnect path does not directly remove the peer from `WebRtcConnectionService`.

### Data Channel Reconnect

Data-channel reconnect is not timer-driven. A closed or failed `QRtcDataChannel` becomes `isReadyToConnect() === true`, and a later call to `WebRtcConnectionService.ensurePeerConnectionStarted(peerId)` may reuse the existing peer DTO and reconnect channels.

When a peer connection is still active and any data channel is reconnectable:

- `connectedPeerIds()` excludes that peer.
- `computeRtcPeerDtoIfAbsent()` reuses the existing `QRtcPeerDto`.
- `_ensurePeerConnectionStarted()` calls `connection.connect(...)`, which is ignored if the peer connection is already open.
- It then calls `channel.connect(isInitiator)` for all channels and `media.connect()`.

For initiators, this creates a new browser `RTCDataChannel` and overwrites `status.dc`.

For receivers, this waits for an incoming matching channel. Until the new incoming channel arrives, `status.dc` can still reference the old closed channel.

## Situation Matrix

| Situation | Current behavior | Risk | Desired behavior |
| --- | --- | --- | --- |
| Concurrent `rallar.connect()` | Single-flight via `connectPromise`. | Good. | Keep. |
| First connect succeeds | Context cached and callbacks registered. | Good. | Keep. |
| First connect fails before resources are created | State resets to idle. | Generally safe. | Keep. |
| First connect fails after WebSocket or queue engine starts | `initPromise` resets, but partial resources may remain alive. | Socket, callbacks, queue timers, or stores can leak. | Add cleanup on partial middleware init failure. |
| `connect()` called later with different `dataChannelLanes` | Existing context returned, options ignored. | Caller may believe lanes were added but they were not. | Document first-connect-only behavior or reject incompatible options after connect. |
| Incoming signal from wrong session | Throws. | Error is caught/logged by signaling transport, message is dropped. | Keep, but consider metrics. |
| Incoming signal not addressed to local session | Ignored. | Good. | Keep. |
| Incoming signal from self | Ignored. | Good. | Keep. |
| Incoming signal for unknown peer | Peer is created, signal handled. | Good for passive acceptance. | Keep. |
| Peer already active and channels healthy | Existing peer reused, no reconnect. | Good. | Keep. |
| Peer active but any channel is closed or failed | Peer is excluded from `connectedPeerIds()` and later `ensurePeerConnectionStarted()` reconnects channels. | A single closed lane hides the whole peer from multicast and health. | Separate peer connection health from channel health. |
| Reliable channel open, realtime lane closed | Whole peer can disappear from `connectedPeerIds()`. | Reliable RTC multicast may stop using an otherwise usable peer. | Treat lane health independently. |
| Data channel closes | Wrapper state becomes `Closed`; old `status.dc` remains set. | Reconnect for receiver lanes may immediately report closed before new channel arrives. | Clear stale `dc` or distinguish stale closed channel from pending replacement. |
| Data channel errors | Wrapper state becomes `Failed`; old `status.dc` remains set. | Same stale reference risk as close. | Same handling as close. |
| Data channel closes without further send/group event | Heartbeat stops, but no reconnect is scheduled. | Connection can stay degraded indefinitely. | Add service-level data-channel close policy. |
| PeerConnection enters `disconnected` | Waits 5s, then tries ICE restart. | Reasonable. | Keep, but track state and outcomes. |
| PeerConnection enters `failed` | Starts ICE restart path immediately. | Reasonable. | Keep, but verify renegotiation behavior. |
| PeerConnection reconnect attempts exhausted | `QRtcPeerConnection.reset()` is called. | Peer remains in `peerDtoByPeerId` until another code path removes or reconnects it. | Notify service or remove peer on terminal failure. |
| PeerConnection closes | `onClosed` removes peer from service. | Good. | Keep. |
| `rallar.disconnect()` | Disconnects peers from `connectedPeerIds()`, stops qbox engine, closes WebSocket. | Peers hidden by reconnectable channels may be skipped. WebSocket reconnect may fire on intentional close. | Disconnect all known peers and suppress intentional WS reconnect. |
| `rallar.realtime.sendJson()` to closed lane | Calls `ensurePeerConnectionStarted()`, waits for lane, returns closed if not open. | Receiver side can return closed immediately because stale closed `dc` remains. | Wait on current connection attempt, not stale closed channel. |
| `messages.rtc.send()` | Enqueues to multicast outbox; send later uses `readPeer(peerId)?.channel.send(...)`. | If reliable channel is closed, dequeue throws or retries; if peer hidden, planning may skip. | Reconnect before reliable send or classify retryable channel-closed failures. |

## Main Problem Areas

### 1. `connectedPeerIds()` Mixes Peer Health And Channel Health

`WebRtcConnectionService.connectedPeerIds()` returns peers where:

- The peer connection is connected, connecting, or new.
- No data channel is reconnectable.

This means one closed or failed lane removes the whole peer from the connected set.

Impact:

- RTC multicast planning can stop selecting a peer whose reliable lane may still be usable.
- `rallar.realtime.health()` defaults to `connectedPeerIds()` and can hide degraded peers.
- `rallar.disconnect()` loops over `connectedPeerIds()` and can skip degraded peers, leaving peer objects and browser connections alive.
- Group reconciliation sees degraded peers as not connected and calls `ensurePeerConnectionStarted()`, which is currently the only implicit data-channel reconnect trigger.

Hardening direction:

- Add separate APIs for peer connection membership and channel readiness.
- Keep `connectedPeerIds()` focused on peer connection state, or introduce `activePeerIds()` and `readyPeerIdsForLane(laneId)`.
- Make multicast planning depend on reliable-channel readiness if it requires the reliable lane.
- Make health and disconnect operate on all known peers, not only fully-ready peers.

### 2. Stale `RTCDataChannel` Object Remains After Close/Error

`QRtcDataChannel.onclose` and `onerror` mark wrapper state but leave `status.dc` pointing at the old browser `RTCDataChannel`.

Impact:

- `readHealth()` reports the stale closed channel.
- `waitUntilOpen()` returns `false` immediately while `status.dc.readyState` is `closed`.
- Receiver-side reconnect can be blocked by the old closed channel until a matching incoming channel arrives.
- Send paths can see a closed result even though a reconnect attempt has started.

Hardening direction:

- On close/error, detach event handlers and clear `status.dc`, or move it into a stale/last-known field for diagnostics.
- If retaining diagnostics is needed, keep `lastReadyState` separately.
- Ensure `waitUntilOpen()` can wait during a new receiver-side connection attempt instead of short-circuiting on the stale channel.

### 3. Data Channel Reconnect Is Passive

When a data channel closes:

- Heartbeat stops.
- The wrapper becomes reconnectable.
- No service-level timer or callback schedules reconnection.

Reconnect happens only if another path later calls `ensurePeerConnectionStarted()`.

Hardening direction:

- Add a service-level data-channel lifecycle callback.
- On reliable-channel close, decide whether to remove the peer, reconnect the channel, or reconnect the full peer connection.
- On optional lanes like realtime, reconnect only that lane where possible, or mark degraded but keep reliable traffic unaffected.
- Avoid reconnect storms with per-peer/lane backoff.

### 4. Terminal PeerConnection Failure Does Not Remove The Service Peer

When `QRtcPeerConnection.handleReconnect()` exhausts attempts, it calls `reset()` on the peer connection object. It does not notify `WebRtcConnectionService` through `onClosed`, and the peer DTO can remain in `peerDtoByPeerId`.

Impact:

- Service state can contain an idle/reset peer DTO.
- Lifecycle `onDeleted` may not fire.
- RX streamer, heartbeats, media callbacks, and realtime callbacks may remain registered on wrappers until an external remove path runs.

Hardening direction:

- Add an `onTerminalFailure` or reuse `onClosed` semantics when reconnect attempts are exhausted.
- Have `WebRtcConnectionService` remove the peer on terminal connection failure.
- Preserve enough failure reason for diagnostics.

### 5. Intentional WebSocket Close Can Trigger Reconnect

`WsQueueBoxClientService.enableReconnect()` reconnects on every close/error. `rallar.disconnect()` closes the WebSocket but does not disable reconnect first.

Impact:

- A user-driven disconnect can race with a reconnect attempt.
- `clearMiddleware()` can clear facade/global state while the old socket reconnect task is still trying to reconnect.

Hardening direction:

- Add an explicit shutdown flag or `disableReconnect()` method.
- Suppress reconnect for intentional close code/reason, including `1000` and `rallar-disconnect`.
- Remove reconnect callbacks before closing the socket during facade disconnect.

### 6. Partial Middleware Initialization Cleanup Is Missing

If middleware initialization fails after creating resources, the facade and app-context promises reset, but already-created resources may not be closed.

Impact:

- WebSocket connection may stay open.
- Queue engine timer may keep running.
- Callback registrations may survive in partially constructed objects.

Hardening direction:

- Wrap `initialiseMiddleware()` resource creation in a cleanup-on-failure block.
- Close socket, stop queue engine, and reset partially created RTC services on failure.
- Add tests for failure after WebSocket connect, after qbox start, and after signaling registration.

## Prioritized Hardening Plan

### P0: Make Shutdown Deterministic

Goals:

- `rallar.disconnect()` closes all known peers, not only peers returned by `connectedPeerIds()`.
- Intentional WebSocket close does not reconnect.
- Queue engine and socket cannot survive facade disconnect.

Tasks:

- Add `allPeerIds()` or `allPeers()` to `WebRtcConnectionService`.
- Use that in `rallar.disconnect()`.
- Add `disableReconnect()` or an intentional shutdown flag to `WsQueueBoxClientService`.
- Suppress reconnect for `rallar-disconnect`.
- Add tests that simulate a closed data channel before `rallar.disconnect()` and verify the peer is still removed.

### P1: Separate Peer State From Lane State

Goals:

- A degraded lane does not hide the whole peer.
- Reliable multicast and realtime health can make lane-specific decisions.

Tasks:

- Replace or supplement `connectedPeerIds()` with explicit APIs:
  - `activePeerIds()` for peer connection state.
  - `readyPeerIdsForLane(laneId)` for lane readiness.
  - `degradedPeerIds()` for diagnostics.
- Update multicast planning to use reliable-lane readiness when needed.
- Update `rallar.realtime.health()` to report degraded peers and closed lanes instead of hiding them.
- Add tests for reliable open plus realtime closed.

### P2: Fix Data Channel Close Semantics

Goals:

- Closed browser `RTCDataChannel` objects are not reused as active state.
- Receiver-side reconnect can wait for the replacement channel.

Tasks:

- On channel close/error, detach handlers and clear `status.dc`.
- Store diagnostic fields separately, such as `lastReadyState`, `lastCloseAtEpochMs`, and `lastErrorAtEpochMs`.
- Ensure `waitUntilOpen()` waits when wrapper state is `Connecting` even if a previous channel closed.
- Add tests for:
  - Initiator channel closes, reconnect creates a new channel.
  - Receiver channel closes, reconnect waits for a new incoming matching channel.
  - Realtime send after closed lane triggers reconnect wait instead of immediate stale closed result.

### P3: Add Active Data Channel Reconnect Policy

Goals:

- Channel closure is handled without waiting for unrelated future actions.
- Reconnect behavior is deliberate per lane.

Tasks:

- Add lane lifecycle callbacks or events from `QRtcDataChannel`.
- In `WebRtcConnectionService`, react to close/error using a per-peer/lane policy.
- Reliable lane policy should likely reconnect or remove the peer.
- Realtime lane policy can reconnect with backoff while keeping reliable traffic alive.
- Add backoff and max attempts to avoid repeated immediate renegotiation.

### P4: Terminal PeerConnection Failure Cleanup

Goals:

- Exhausted ICE restart attempts produce one clear service-level outcome.
- Lifecycle `onDeleted` fires consistently.

Tasks:

- Add a terminal failure callback from `QRtcPeerConnection` to `WebRtcConnectionService`.
- Remove the peer on terminal failure.
- Include reason diagnostics in logs and health.
- Add tests for exhausted reconnect attempts.

### P5: Partial Initialization Cleanup

Goals:

- Failed `rallar.connect()` attempts leave no live partial runtime.

Tasks:

- Track resources as they are created in `initialiseMiddleware()`.
- On failure, stop qbox engine, close socket, and reset any created peer services.
- Add tests for failures after each major initialization step.

## Validation Plan

Recommended test coverage:

- Unit tests for `QRtcDataChannel` close/error clearing and reconnect wait behavior.
- Unit tests for `WebRtcConnectionService` active peer IDs versus lane-ready peer IDs.
- Unit tests for `rallar.disconnect()` removing degraded peers.
- Unit tests for intentional WebSocket close not triggering reconnect.
- Integration-style test for reliable lane open plus realtime lane closed.
- Integration-style test for receiver-side data-channel replacement after close.
- Middleware initialization failure tests that assert cleanup.

Manual runtime scenarios:

- Two browsers join a room, reliable and realtime lanes connect.
- Close only realtime lane and verify reliable RTC messages still flow.
- Close reliable lane and verify reconnect or peer removal behavior is explicit.
- Drop network until PeerConnection enters `disconnected`, then restore before the 5 second timer fires.
- Drop network until PeerConnection enters `failed`, verify ICE restart attempts and terminal cleanup.
- Call `rallar.disconnect()` while a WebSocket reconnect attempt is pending.

## Open Decisions

- Should `connectedPeerIds()` keep its current strict meaning and a new API be added, or should its behavior change?
- Should reliable-channel close remove the whole peer, reconnect the full peer, or only recreate the reliable data channel?
- Should optional lanes like `realtime` be auto-reconnected by default?
- Should lane configuration after first `connect()` be rejected, ignored with warning, or supported through dynamic lane creation?
- What health surface should distinguish `peer active`, `reliable ready`, `realtime degraded`, and `terminal failed`?
