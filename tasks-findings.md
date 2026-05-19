# TASKS.md Findings

Date: 2026-05-16

Scope reviewed:

- `TASKS.md`
- Browser facade: `packages/shared-web/browser/rallar.ts`
- Browser middleware/runtime setup: `packages/shared-web/browser`
- Shared AL, RTC, WS, persistence services: `packages/shared`
- Server facade and middleware: `packages/shared-server`

This document is analysis only. It records follow-up findings and proposed hardening work; it does not implement code changes.

## Executive Summary

- `ar-eye-hunter-al-runtime.entries` is TTL-based, but cleanup is mostly lazy. Normal current-session reads filter expired rows, but old prefixes and old sessions can remain in IndexedDB indefinitely unless the same prefix is read/listed or an explicit cleanup is run.
- Different login sessions are isolated by session-scoped namespaces in normal runtime access. The larger risk is stale data for a reused/restored same session ID, plus storage bloat from old session prefixes.
- `Rallar` exposes coarse application connection state and realtime send/health helpers, but it does not expose a first-class RTC facade with wait, status, retry, or lifecycle APIs.
- RTC reconnect had important object reuse risks. A peer DTO could be reused after data-channel close/failure, while the channel wrapper could still hold the stale closed browser `RTCDataChannel`. The follow-up cleanup split the old connected-peer concept into explicit known, active, no-reconnectable-lane, and ready-lane peer sets.
- The removed `connectedPeerIds()` API mixed peer connection health with data-channel lane health. That affected routing, health reporting, cleanup, and reconnect behavior.
- WebSocket and RTC APIs are not symmetric today. WS has auto-reconnect but little exposed status; RTC has peer/channel health internally but little facade-level API.
- `rallar.ts` around the `enqueueOutboxIfAbsent()` call can report success to the caller even when no outbox entry was created or when a dispatch was intentionally skipped.
- Browser RTC overlay topology identity is still scoped only by string `overlayId`, which commonly defaults to `groupId`. `graphId` is also used as the bridge for graph topology updates into overlays. In a single SPA runtime that can see same-`groupId` rooms from multiple workspaces, overlay and graph topology can collide even after AL multicast targets carry mandatory scoped `groupRef`.

## 1. IndexedDB: `ar-eye-hunter-al-runtime.entries`

### Current Storage Shape

Browser AL runtime storage is configured in `packages/shared-web/browser/browser-al-runtime-stores.ts`.

- The database name is `ar-eye-hunter-al-runtime`.
- Browser runtime store IDs include the current session ID:
  - `browser-ws-client:${sessionId}`
  - `browser-rtc-rx:${sessionId}`
  - `browser-rtc-overlay:${sessionId}`
- Persistent AL store namespaces are prefixed as `browser:${runtimeStoreId}`.
- All these stores ultimately share IndexedDB object stores named `entries`.

The shared runtime store factories live in `packages/shared/alm/ALRuntimeStores.ts`. They create:

- inbound admission stores
- outbound admission stores
- outbound supersedence stores
- outbound runtime state stores for sent messages, pending acks, and repair attempts

Default retention is defined in `packages/shared/alm/ALStoreRetention.ts`:

- ephemeral TTL: 30 minutes
- repository TTL: 60 minutes

### Eviction Behavior

There is eviction logic, but it is mostly not proactive for the browser AL runtime database.

- `IndexedDbStringPersistenceProvider` deletes expired records during `getItem()` and `getAllKeys()`.
- It also exposes `deleteExpired()`.
- IndexedDB admission backends in `ALInboundAdmissionStore.ts` and `ALOutboundAdmissionStore.ts` delete expired records during `get`, `list`, and write transactions.
- I did not find a scheduled/global browser sweep for `ar-eye-hunter-al-runtime.entries`.

Impact:

- Active current-session prefixes are cleaned opportunistically.
- Expired rows for inactive prefixes, old sessions, or prefixes that are never listed again can remain indefinitely.
- The table can therefore keep growing even though individual records have TTLs.

### Expired Data Read Risk

Normal reads appear guarded against expired rows:

- Provider-backed reads delete and suppress expired values.
- Admission-store reads and lists delete and suppress expired values.
- Outbound runtime state reads go through provider key listing plus `getItem()`, so expired values are filtered before being returned.

The main caveat is that this safety is prefix-local and access-driven. Expired data under a prefix that is no longer touched can stay physically present, but should not be returned through normal current-prefix reads.

### Different Login Session Risk

Normal session isolation is good because browser AL runtime namespaces include `sessionId`. A fresh login with a different session ID should not read old session runtime entries through the normal resolver path.

The remaining risks are:

- Same-session reuse/restoration can read prior unexpired runtime state for that session. That may be intended for reconnect/resume, but it should be an explicit product decision.
- Logout in `packages/shared-web/browser/rallar.ts` disconnects and closes authenticated data scopes, then clears auth session state. I did not find corresponding cleanup of AL runtime IndexedDB prefixes for the old session.
- Old-session records remain in the same IndexedDB database and object store, which is a privacy/storage concern even if normal reads are scoped correctly.

### Recommended Follow-up

- Add an explicit AL runtime cleanup entry point for current session prefixes and call it during logout and failed session replacement.
- Add a startup/background sweep for expired rows in `ar-eye-hunter-al-runtime.entries`, including prefixes for old sessions.
- Add a lightweight diagnostic API or development utility to count rows by namespace/prefix and report expired/unexpired counts.
- Decide whether same-session resume should preserve AL runtime rows across reloads. If yes, document that contract and keep TTLs short. If no, clear session-scoped runtime prefixes on connect/logout boundaries.

## 2. Web RTC Signaling And Connection Lifecycle

### Current Start-to-Finish Flow

The browser facade flow is:

1. `Rallar.connect()` in `packages/shared-web/browser/rallar.ts` calls `initMiddleware()`.
2. `initMiddleware()` reads the stored auth session and calls `initialiseMiddleware()`.
3. `initialiseMiddleware()` configures browser AL runtime stores for the current session, reads API config, creates a WebSocket ticket, opens a WebSocket, creates queue-box services, reads ICE config, and creates `WebRtcConnectionService`.
4. RTC signaling uses `WsRtcSignalingTransportUsingWsQBox`, which sends signaling messages over the WS queue-box path.
5. `WebRtcConnectionService.connectSignaler()` registers signaling callbacks.
6. RTC peer connections are not eagerly connected for all peers during `Rallar.connect()`. They are created when group/cache logic, realtime send, media, or overlay routing asks `ensurePeerConnectionStarted(peerId)`.
7. `ensurePeerConnectionStarted()` serializes per-peer attempts through `pendingConnections`.
8. `computeRtcPeerDtoIfAbsent()` either reuses an existing DTO, reconnects an existing DTO, or creates a new `QRtcPeerConnection` plus one or more `QRtcDataChannel` wrappers.
9. `QRtcPeerConnection.connect()` creates the browser `RTCPeerConnection`, wires negotiation/ICE/datachannel/track/state callbacks, and uses perfect-negotiation handling for offers/answers.
10. Data channels are created by the initiator and accepted by the receiver through `ondatachannel`.

### API Surface Gap

`Rallar` currently exposes:

- `connect()`, `disconnect()`, `status()`, and `isConnected()` for the whole browser middleware.
- `messages.rtc.send()` for AL multicast over the RTC overlay.
- `realtime.sendJson()`, `realtime.sendBinary()`, and `realtime.health()`.

It does not expose a first-class `Rallar.rtc` facade for:

- waiting for peer connections to reach connected/open state
- waiting for specific data-channel lanes to open
- inspecting all known peers, including degraded peers
- subscribing to per-peer/per-lane lifecycle events
- distinguishing signaling, peer-connection, and data-channel failure states
- manually retrying or resetting a peer

This makes user code choose between sending optimistically or reaching through `advanced.middleware()`.

### Reconnect Flow

Peer connection reconnect:

- `QRtcPeerConnection` marks `connected`, `disconnected`, `failed`, and `closed` states.
- `disconnected` schedules reconnect after 5 seconds if still disconnected.
- `failed` starts reconnect immediately.
- `handleReconnect()` attempts an ICE restart with exponential backoff for up to 5 attempts.
- When attempts are exhausted it calls `reset()`.

Data-channel reconnect:

- `QRtcDataChannel.onclose` sets wrapper state to `Closed`.
- `QRtcDataChannel.onerror` sets wrapper state to `Failed`.
- A later `WebRtcConnectionService.ensurePeerConnectionStarted(peerId)` can see reconnectable data channels and reuse the peer DTO while calling `channel.connect(...)` again.

The data-channel reconnect is therefore demand-driven. It depends on a later send, group reconciliation, or other caller touching the peer.

### Object Reuse After Data Channel Close

This is the highest-risk RTC area found.

`QRtcDataChannel.reset()` closes the current browser data channel, clears queued sends, resolves waiters, and sets `status.dc` to undefined. That path is relatively clean.

However, normal `onclose` and `onerror` do not clear `status.dc`; they only update wrapper state and resolve waiters. After that:

- `waitUntilOpen()` returns `false` immediately if the stored `RTCDataChannel.readyState` is `closed` or `closing`.
- `connect()` may reuse the same wrapper object.
- Receiver-side reconnect can be especially fragile because it waits for a new incoming channel, but the stale closed channel can still influence wait/health behavior.
- The old `connectedPeerIds()` calculation excluded the whole peer if any channel was considered reconnectable.

Result:

- A single closed or failed lane can hide an otherwise active peer from routing and health.
- `realtime.sendJson()` and `realtime.sendBinary()` can return a closed result even when a reconnect attempt was just started.
- `rallar.disconnect()` previously looped over `connectedPeerIds()`, so degraded peers hidden by reconnectable channels could be skipped during cleanup.

### Signaling Timeouts And Retries

Signaling rides over WebSocket queue-box delivery.

- WS reconnect exists in `WsQueueBoxClientService.enableReconnect()`.
- The reconnect helper retries without a small explicit attempt budget by default.
- `Rallar.disconnect()` closes the WebSocket, but the WS reconnect callback is still registered and can react to close/error.
- `WsRtcSignalingTransportUsingWsQBox.connect()` calls `qbox.socket.connect()`. The middleware has already connected the socket, and WS engine initialization also calls connect. `JsonWebSocketClient.connect()` guards open/in-flight connects, so this is likely benign, but it makes readiness ownership unclear.

I did not find an RTC-specific timeout for:

- "offer sent, answer never received"
- "ICE candidates exchanged, connection never reaches connected"
- "data channel never opens"
- "signaling path unavailable while peer connection remains pending"

The realtime lane send path has an open timeout, defaulting to 5 seconds, but RTC overlay message send does not wait for a lane to open.

### Speed And Stability Considerations

Potential causes of slow or failed setup:

- Peer connections are mostly lazy, so the first user action that needs RTC can pay the full setup cost.
- Signaling readiness is implicit through WS queue-box setup, not exposed as a clear state.
- There is no facade-level wait API to gate operations until a peer or lane is ready.
- The old connected-peer calculation could exclude peers with recoverable lane issues, reducing routing candidates and triggering unnecessary reconnect behavior.
- Terminal peer-connection reconnect exhaustion resets the peer connection object but does not clearly notify `WebRtcConnectionService` to remove/recreate the peer DTO.

### Recommended Follow-up

- Add `Rallar.rtc` with explicit methods such as `connectPeer`, `waitForPeer`, `waitForLane`, `status`, `health`, `disconnectPeer`, and `retryPeer`.
- Separate peer connection state from data-channel lane state. Keep "known peers", "active peer connections", and "ready lane peers" as distinct concepts.
- Make `disconnect()` close all known peers, not only peers that have no reconnectable lanes.
- Clear or replace stale `status.dc` on data-channel close/error, or make `waitUntilOpen()` aware of an in-progress replacement channel.
- Surface terminal reconnect exhaustion from `QRtcPeerConnection` back to `WebRtcConnectionService`.
- Add explicit timeouts for signaling, peer connection establishment, and lane opening.
- Add metrics/events for offer, answer, ICE candidate, connection state, lane state, reconnect attempt, reconnect exhausted, and timeout.

### Overlay And Graph Identity

`OverlayId` is currently a SPA-side RTC multicast topology key. The server does not use it for room WS routing, but the shared RTC overlay manager and repository live in `packages/shared`.

Current flow:

- Browser group snapshot handling creates a default star overlay where `overlayId = groupId`.
- Browser graph messages update overlay next hops by calling `updateNextHopSessionIds(graph.graphId, neighbors)`.
- RTC multicast resolution reads room membership from the group cache and overlay topology from the overlay cache.
- Rallar RTC sends default `overlayId` to `roomId`, unless the caller passes an explicit `overlayId`.

Risk:

- Same-`groupId` rooms in two workspaces can overwrite each other's overlay entries because the overlay repository key is just `overlayId`.
- `removeOverlayById(groupId)` can delete the wrong workspace overlay.
- `graphId` has the same ambiguity as `overlayId` when a room graph uses `graphId = groupId`.
- Global graph snapshots such as `graphId = "global"` do not map cleanly to scoped room overlays, so graph updates may be ignored for room routing unless a matching overlay key already exists.
- Normal Rallar RTC sends now include mandatory scoped AL target `groupRef`, which protects the room context, but the topology lookup can still be wrong if same-id overlays collide.

Recommended follow-up:

- Add proof tests before changing behavior:
  - two same-`groupId` room snapshots from different workspaces should produce two independent overlays;
  - deleting one scoped room should not remove the other overlay;
  - a graph snapshot for workspace B should update only workspace B's overlay;
  - RTC multicast with scoped `groupRef` should use the matching scoped overlay topology.
- Introduce scoped overlay identity derived from `GroupRef`, keeping display/debug `groupId` separate.
- Extend graph topology snapshots or update paths so room graphs carry `groupRef` or an equivalent scoped graph ref, instead of relying only on raw `graphId`.
- Keep support for explicitly custom overlay ids only for intentionally shared or application-defined topologies.

## 3. WS And RTC API Symmetry

### Browser Facade

The browser `Rallar` facade has a global middleware connection status, but transport-level status is asymmetric:

- WS exposes message send/onMessage through `messages.ws`.
- RTC exposes AL multicast send/onMessage through `messages.rtc`.
- Realtime RTC has lane send/health helpers.
- WS auto-reconnect is internal and does not expose a lifecycle/status stream.
- RTC has internal peer health but no facade-level lifecycle/status stream.

Recommended symmetry:

- `rallar.ws.status()` and `rallar.rtc.status()` should expose comparable transport state.
- Both should support `waitUntilReady()` with timeout/abort options.
- Both should expose lifecycle subscriptions.
- Both send APIs should report accepted/enqueued/sent/skipped/failure outcomes rather than returning only the constructed `ALMessage`.

### Server Facade

`RallarServer` in `packages/shared-server/rallar-facade/RallarServer.ts` exposes `ws`, `system`, `data`, and `start()`. There is no server RTC facade, which appears consistent with the current architecture: server-side realtime is WebSocket based.

The server WS facade supports:

- installing routes
- defining/removing topics
- subscribing handlers
- proxy rules
- publish/fanout

It does not expose:

- server WS connection counts/status through the facade
- wait/readiness APIs
- lifecycle subscriptions for connection open/close/error
- delivery outcome detail beyond `publish()` returning live send count for `live-only` fanout

Recommended server follow-up:

- Add server WS status/readiness APIs if browser WS receives matching APIs.
- Expose live connection counts and optionally room/topic recipient counts.
- Make `publish()` outcomes explicit for `live-only`, `outbox`, and `none` fanout modes.

## 4. `rallar.ts` `enqueueOutboxIfAbsent()` Around Line 735

### Current Behavior

`messages.rtc.send()` constructs an RTC multicast `ALMessage`, calls:

```ts
await ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(msg);
return msg;
```

The return value from `enqueueOutboxIfAbsent()` is ignored. The caller receives the constructed `ALMessage` even if the lower layer skipped dispatch or produced no outbox entry.

The lower layers are:

- `WebRtcRxStreamerService.enqueueOutboxIfAbsent()`
- `WebRtcOverlayMulticastManager.enqueueIfAbsent()`
- `ALOutboundMessageRuntime.enqueueIfAbsent()`

### Quiet Or Ambiguous Cases

Yes, it can be quietly not enqueued from the facade caller's perspective.

Cases found:

- If the overlay manager returns a left/error whose message includes `Skipping`, it folds that to an empty entry list without surfacing an error to `Rallar`.
- If there are no targets or no next hop, the overlay planner returns a skip/drop reason.
- If there is no overlay context, the overlay planner returns a skip/drop reason.
- If a message is superseded by AL admission/supersedence policy, the outbound runtime returns success with `entries: []`.
- Immediate dispatch paths can also return `entries: []`; in that case it may be a successful immediate send rather than a failure, so the current return shape is ambiguous.
- If a connected peer was hidden by the old connected-peer calculation because a lane was reconnectable, the overlay planner could have fewer/no routing candidates.
- In immediate dispatch, missing peer/channel can warn and return rather than reliably fail the facade call. In dequeue/repair paths, missing peer/channel can throw and be retried.

### Why Some Skips Are Correct

Some "not enqueued" results are valid:

- duplicate/superseded messages
- expired messages
- intentionally immediate dispatch
- no route because there is genuinely no eligible target

The issue is not that every skip is wrong. The issue is that `Rallar.messages.rtc.send()` reports all of these as the same successful `ALMessage` return.

### Recommended Follow-up

- Introduce a send result type for RTC and WS message sends, for example `accepted`, `enqueued`, `sent-immediate`, `skipped`, `duplicate`, `superseded`, `expired`, `no-route`, `failed`.
- Keep `send()` compatibility if needed, but add `sendWithResult()` or return richer metadata in a future breaking change.
- Treat "no overlay context" and "no route" as visible outcomes at the facade boundary.
- Log skipped outcomes with structured fields: message ID, topic, room/context, target mode, route decision, connected peers, known peers, and lane state.
- Add tests for no target, no overlay context, superseded, immediate dispatch, disconnected peer, closed lane, and reconnecting lane cases.

## Prioritized Hardening Plan

### P0: Make Outcomes And Cleanup Reliable

- Add explicit send outcome reporting for `messages.rtc.send()` and then align `messages.ws.send()`.
- Split peer health from lane health so no peer set hides peers solely because one lane is reconnectable.
- Make `disconnect()` clean up all known RTC peers.
- Prevent intentional `Rallar.disconnect()` from triggering background WS reconnect.
- Add AL runtime IndexedDB cleanup for logout/session replacement and a startup sweep for expired rows.

### P1: Add RTC Lifecycle APIs

- Add `Rallar.rtc.status()` for all known peers and lanes.
- Add `Rallar.rtc.waitForPeer()` and `Rallar.rtc.waitForLane()` with timeout and abort support.
- Add lifecycle subscriptions for signaling, peer connection, lane open/close/error, reconnect attempt, and reconnect exhaustion.
- Surface terminal `QRtcPeerConnection` reconnect exhaustion to `WebRtcConnectionService`.

### P2: Improve Setup Speed And Observability

- Add optional preconnect/warmup for room peers after state hydration.
- Add configurable RTC establishment timeout policies.
- Add signaling-specific timeout/retry metrics.
- Add browser diagnostics for AL runtime database row counts by prefix.
- Add server WS facade status/readiness APIs to match the browser facade direction.

## Open Decisions

- Should same-session restore preserve AL runtime rows across browser reloads, or should runtime state be cleared on every authenticated connect?
- Which real-server scenarios should be promoted next to automated coverage for `knownPeerIds()`, `activePeerIds()`, `peerIdsWithNoReconnectableLanes()`, and `readyPeerIdsForLane(laneId)`?
- Should existing `send()` methods remain optimistic and add separate `sendWithResult()`, or should send return richer delivery/admission metadata directly?
- What is the expected server-side symmetry target, given that `RallarServer` currently has WS but no RTC facade?
