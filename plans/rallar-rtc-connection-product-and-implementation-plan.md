# Rallar RTC Connection Product And Implementation Plan

Date: 2026-06-03

## Purpose

This plan captures the current WebRTC connection handling situation in Rallar,
why it feels sub-optimal for the range of applications Rallar should support,
and how to move toward a clearer product and implementation model.

The core conclusion:

> Rallar should expose intent-oriented room transport policies, not make most
> applications coordinate RTC peer readiness, next hops, and fallback manually.

The current WebRTC stack is real and capable. The problem is that the public
application model still leaks too much of the transport machinery: peer
creation, overlay readiness, `readyPeerIds()`, `nextHopPeerIds`, lane waits, and
message fallback are spread across app code, facade code, and lower-level
multicast services.

## Current Code And Docs Checked

Primary local references:

- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-product-and-implementation-evaluation.md`
- `playground/FUTURE_WORK.md`
- `playground/TASKS.md`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/middleware.ts`
- `packages/shared-web/browser/app-context.ts`
- `packages/shared-web/browser/rtc-engine.ts`
- `packages/shared-web/browser/data-caches.ts`
- `packages/shared/services/WebRtcConnectionService.ts`
- `packages/shared/services/WebRtcGroupManager.ts`
- `packages/shared/services/WebRtcGroupService.ts`
- `packages/shared/services/WebRtcRxStreamerService.ts`
- `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`
- `packages/shared/multicast/WebRtcOverlayMulticastService.ts`
- `packages/shared/webrtc/QRtcPeerConnection.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `apps/relic-hunters-v1/src/game/useRelicHunters.ts`
- `apps/relic-hunters-v1/src/game/scene/networking.ts`
- `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`

## Current Situation

Rallar currently has two different meanings of "connected":

1. Browser middleware is connected.
   `rallar.connect()` initializes the browser runtime, WebSocket, queue engine,
   ICE config, RTC signaling transport, RTC multicast/streamer services, group
   manager, state caches, and heartbeat.

2. Individual RTC peer lanes are open.
   `WebRtcConnectionService.ensurePeerConnectionStarted(...)` creates or reuses
   a per-peer `RTCPeerConnection`, creates data-channel lanes, starts perfect
   negotiation, and waits for channel lifecycle events.

Those are both useful states, but application code often needs a third state:

> Is this room's intended realtime transport usable enough for this app action?

That state does not have a clean product-level owner today.

### How RTC Connections Start Today

RTC peer startup currently happens from several paths:

- State cache hydration and later group/client snapshot changes call into
  `WebRtcGroupManager.reconcileAllGroups()`, which connects online desired
  peers in joined groups.
- Incoming RTC signaling from an unknown peer accepts and creates the peer
  connection on demand.
- `rallar.rtc.waitForOpen(...)` and `waitForLane(...)` can initiate connection
  only when `connect: true` is passed or `defaults.rtc.connectOnWait` is set.
- `rallar.realtime.sendJson(...)` and `sendBinary(...)` actively call
  `ensurePeerLaneOpen(...)` before sending.
- `rallar.messages.rtc.send(...)` enqueues an RTC overlay message, but does not
  itself guarantee that a peer lane is open or initiate a fallback route.

### Relic Hunters Symptom

Relic currently marks `rtcReady` when middleware is connected and a current room
exists. The scene still checks `rallar.rtc.readyPeerIds()` before sending live
position updates, and the runtime does the same before publishing RTC snapshot
repairs.

That is a healthy defensive pattern for the current APIs, but it reveals the
product issue: app code is carrying transport policy that Rallar should own.

## Product Diagnosis

The existing implementation is strongest as a transport substrate. It is weaker
as an application SDK.

Good current properties:

- The browser facade is single-flight and session-aware.
- Room and people snapshots drive group membership and peer reconciliation.
- Incoming signaling can create missing peers.
- `rallar.rtc.status(...)`, `onStatus(...)`, and `onLifecycle(...)` expose useful
  low-level diagnostics.
- `rallar.realtime` can actively open data-channel lanes before sending.
- `rallar.messages.ws` and `rallar.messages.rtc` share typed channel concepts.
- The lower-level WebRTC service already tracks peer/lane health and
  establishment timeout.

Main product gaps:

- "Room realtime readiness" is not a first-class concept.
- Connection policy is implicit and scattered.
- RTC message send results can look successful even when no open route exists.
- Fallback is caller-owned.
- App authors need to understand session IDs, ready peer IDs, next hops, and
  overlay constraints too early.
- The same API surface is asked to serve turn-based games, collaborative docs,
  cursor/avatar streams, media calls, headless agents, monitoring tools, and
  future game authority layers.

## Product Direction

Rallar should move from transport-first APIs to intent-first APIs.

Low-level APIs should remain available, but common apps should use room transport
policies and typed channels that own routing, fallback, and diagnostics.

Target/proposed mental model:

- `rallar.start(...)`: authenticate, connect the control/event plane, hydrate
  state.
- `rallar.rooms.join(...)`: join membership and state-sync.
- `rallar.room.open(...)` or `rallar.transports.openRoom(...)`: declare desired
  transport behavior for this room.
- `rallar.calls.start(...)`: start an explicit one-to-one, one-to-many, or
  room-scoped call session with owned lifecycle and participant status.
- Existing `rallar.messages.channel(...)`, plus proposed `rallar.channels.*` or
  `rallar.realtime.room(...)`: send application traffic using a transport
  strategy.
- `rallar.transport.status(...)`: inspect health and degradation when needed.

Target product capabilities:

- One-to-one on-demand calls.
- One-to-many on-demand calls to an explicit participant set.
- Room/group multicast where membership churn is detected from room state and
  topology updates.
- Optional media on call sessions, never automatic camera/microphone activation
  from ordinary room join.
- Media source modes for microphone, camera, and screen/presentation tracks.
- Typed realtime/data channels for non-media call and room traffic.
- Data-channel profiles for realtime, reliable, control/RPC, and bulk binary
  traffic.
- WebRTC platform diagnostics and recovery for ICE/TURN, permissions, network
  changes, stats, and cleanup.

Success bar:

> Common app code should not manually coordinate `readyPeerIds()`,
> `nextHopPeerIds`, lane opening, overlay selection, or fallback routing.

## Application Type Presets

Different application types need different defaults.

### Turn-Based And Async Apps

Default transport shape:

- WS required.
- RTC off or lazy.
- Commands, accepted events, snapshots, and recovery over WS/server.

Rallar should optimize for reliability and reconnect clarity, not eager peer
links.

### Collaborative Documents

Default transport shape:

- WS as durable server-routed path.
- RTC as optional accelerator.
- Strategy: `ws-then-rtc` or `rtc-with-ws-fallback`.
- Reconnect and late join through server log or snapshot.

CRDT updates should not use raw `rallar.realtime` as the authoritative V1 path.
Realtime can carry previews, cursors, selections, or optimistic hints.

### Casual Realtime Rooms

Default transport shape:

- RTC warm on room join.
- Latest-value or replace-by-key flow control.
- Stale-message dropping by sequence/time.
- WS fallback configurable per lane.

This covers cursors, avatars, lightweight co-op state, presence decorations, and
party game signals.

### Media Calls

Default transport shape:

- Explicit media/RTC connect.
- One-to-one and one-to-many call sessions are first-class app concepts.
- Audio, video, and screen/presentation tracks are controlled independently.
- No automatic camera/microphone behavior on ordinary room join.
- Clear permission, policy, and lifecycle state.

Media should be opt-in even when room realtime lanes are warm.

Small peer-to-peer media calls are in scope for this plan. Large media rooms,
webinars, and stage rooms should be treated as a future SFU/relay integration
boundary; the tree/mesh data overlay plan should not be presented as scalable
audio/video fanout.

### Headless, Admin, And Monitor Apps

Default transport shape:

- WS-only.
- RTC disabled unless explicitly requested.
- Strong diagnostics and event replay.

These apps often need observability, not peer mesh complexity.

### Authoritative Realtime Games

Default transport shape:

- Server authority over commands, snapshots, and results.
- WS/server path for authoritative state.
- RTC only for low-value ephemeral signals unless a dedicated game layer owns
  tick, reconciliation, and anti-cheat policy.

Rallar is a multiplayer substrate, not yet a full authoritative game-server
framework.

## Proposed Public API Shape

Names are provisional. The important part is the product boundary.

Current repo alignment:

- The current public facade exposes `rallar.messages.ws`,
  `rallar.messages.rtc`, `rallar.messages.channel(...)`, `rallar.rtc.status`,
  `rallar.rtc.waitForLane`, `rallar.rtc.waitForOpen`,
  `rallar.rtc.waitForRoomLane`, `rallar.realtime.sendJson`,
  `rallar.realtime.sendBinary`, `rallar.realtime.json(...)`, and
  `rallar.media.*`.
- The current docs present room realtime as
  `rallar.rtc.waitForRoomLane(...)` followed by `rallar.realtime.json(...)` or
  `sendJson(...)`.
- The current middleware has a built-in reliable RTC data-channel lane and can
  add configured lanes. The browser middleware config currently adds the
  `realtime` lane as unordered, lossy, latest-by-key style traffic.
- The current media facade is stream-level: `setLocalStream`,
  `setAudioEnabled`, `setVideoEnabled`, `stopLocal`, `setPolicy`, and
  `onRemoteStream`. It does not yet expose call sessions or separate microphone,
  camera, and screen-source handles.
- `rallar.room.open(...)`, `rallar.transports.openRoom(...)`,
  `rallar.calls.start(...)`, `rallar.channels.room(...)`,
  `rallar.channels.targeted(...)`, `rallar.channels.rpc(...)`,
  `rallar.realtime.room(...)`, `rallar.rtc.diagnostics(...)`,
  `rallar.rtc.restartIce(...)`, and `rallar.transport.status(...)` are proposed
  product APIs, not current APIs.
- `WebRtcGroupManager` currently reconciles desired peers from joined group
  membership. The tree/mesh topology plan must change that so desired RTC peers
  follow overlay next hops for scalable group multicast.

### Room Transport Runtime

```ts
const roomRuntime = await rallar.room.open(roomRef, {
    transports: {
        ws: 'required',
        rtc: {
            mode: 'off' | 'lazy' | 'warm' | 'eager',
            lanes: ['realtime'],
            fallback: 'ws' | 'drop' | 'queue',
            timeoutMs: 1500,
            minReadyPeers: 1
        }
    }
});

roomRuntime.onStatus((status) => renderRoomTransport(status));

await roomRuntime.waitFor({
    rtc: 'partial',
    timeoutMs: 1500
});
```

Mode meanings:

- `off`: do not create RTC peer links for this room.
- `lazy`: create links only on explicit send or wait.
- `warm`: start links after room join, but app can proceed before full readiness.
- `eager`: start links and surface degraded status if they do not open in time.

### Calls And Targeted Sessions

Calls are explicit RTC sessions that may include media, data, or both.

```ts
const directCall = await rallar.calls.start({
    peerId,
    media: { audio: true, video: false },
    data: { lanes: ['realtime'] }
});

const groupCall = await rallar.calls.start({
    peerIds,
    media: { audio: true, video: true },
    data: { lanes: ['realtime'] }
});

const liveRoomCall = await rallar.calls.start({
    roomRef,
    membership: 'live',
    topology: 'auto',
    media: { audio: true, video: false }
});

directCall.onStatus((status) => renderCallStatus(status));
await directCall.end();
```

Call session responsibilities:

- Own participant selection and lifecycle.
- Open RTC lanes only because the app explicitly requested a call.
- Track per-participant connecting, open, degraded, left, and failed states.
- Attach local media only after the app provides or approves media.
- Add, replace, pause, resume, and remove microphone, camera, and screen tracks
  independently.
- Reconcile `membership: 'live'` room calls from room snapshots and overlay
  topology updates.

### Additional WebRTC Communication Patterns

Rallar should explicitly recognize these WebRTC patterns even if not all of
them are implemented in the first slice:

- One-to-one audio/video calls.
- Small one-to-many audio/video calls.
- Screen share or presentation tracks inside a call.
- Audio-room or stage-room flows with speakers and listeners.
- Low-latency latest-value data, such as cursor, avatar, and game signals.
- Reliable ordered data, such as explicit peer commands or durable hints.
- Control/RPC data, such as request/response peer actions and diagnostics.
- Bulk binary transfer, such as files, assets, or snapshots with progress and
  cancellation.
- Group data multicast over server-authoritative overlay topology.

The first implementation should support the API vocabulary for these patterns,
but can defer heavy media-room infrastructure. In particular, stage rooms and
large audio/video rooms should be designed as an SFU/relay integration point,
not a browser mesh promise.

### WebRTC Platform Capabilities

Rallar should expose the WebRTC platform state that app authors need to make
good product decisions without forcing them into raw browser APIs.

Important platform capabilities:

- ICE/TURN diagnostics: candidate-pair type, relay usage, ICE failures, and
  explicit ICE restart support.
- Connectivity policy: allow direct/prefer-relay/relay-only policies for
  restricted networks and enterprise deployments.
- Device and permission state: denied, unavailable, changed, muted, stopped, and
  screen-share-ended states.
- Network recovery: browser sleep, tab backgrounding, network handoff, VPN
  changes, temporary ICE disconnects, and reconnect attempt state.
- Stats and observability: RTT, jitter, packet loss, bitrate, frame rate,
  buffered amount, drops, reconnect count, and selected candidate pair.
- Bandwidth adaptation: quality presets and sender caps for voice, camera,
  screen, and low-bandwidth modes.
- Security and privacy: session-to-peer identity binding, signed signaling,
  allowed-peer checks, and future E2EE/insertable-streams boundary.
- Signaling lifecycle: invite, accept, reject, cancel, timeout, glare handling,
  stale signaling, and session replacement.
- Browser compatibility: Safari/iOS behavior, autoplay restrictions,
  background throttling, permissions, and codec support.
- Resource cleanup: deterministic stop/close behavior for tracks, senders,
  receivers, data channels, peer connections, and call handles.

### Typed Traffic Strategies

```ts
const cursors = rallar.realtime.room<CursorUpdate>('cursor.v1', {
    roomRef,
    transport: 'rtc-with-ws-fallback',
    qos: 'latest-by-peer',
    staleAfterMs: 250
});

const result = await cursors.send({
    x,
    y,
    heading
});
```

Suggested strategies:

- `ws`
- `rtc`
- `realtime`
- `ws-then-rtc`
- `rtc-with-ws-fallback`
- `local-only`

Targeted and room channel facades should cover the common data cases:

```ts
const whisper = rallar.channels.targeted<Whisper>({
    peerIds: [peerId],
    strategy: 'rtc-with-ws-fallback'
});

const roomSignals = rallar.channels.room<GameSignal>({
    roomRef,
    membership: 'live',
    topology: 'auto',
    strategy: 'rtc-with-ws-fallback'
});
```

`membership: 'live'` means joins/leaves are detected from current room state.
`topology: 'auto'` means group multicast follows the server-authoritative
overlay topology, including the tree/mesh topology plan for larger groups.

### Data-Channel Lane Profiles

App authors should choose intent-level lane profiles rather than raw
`RTCDataChannelInit` settings for common cases.

```ts
const state = rallar.channels.room<PlayerState>({
    roomRef,
    lane: 'realtime',
    strategy: 'rtc-with-ws-fallback'
});

const files = rallar.channels.targeted<FileChunk>({
    peerIds,
    lane: 'bulk',
    strategy: 'rtc'
});

const peerControl = rallar.channels.rpc<PeerRequest, PeerResponse>({
    peerId,
    lane: 'control',
    timeoutMs: 1500
});
```

Suggested lane profiles:

- `realtime`: unordered, lossy, latest-by-key, stale messages can be dropped.
- `reliable`: ordered reliable delivery for important peer data.
- `control`: small request/response messages with timeout and correlation IDs.
- `bulk`: binary chunks with backpressure, progress, cancel, and optional resume.

### Send Results

All app-facing sends should report what happened.

```ts
type RallarAppSendStatus =
    | 'sent'
    | 'sent-with-fallback'
    | 'queued'
    | 'dropped-no-peers'
    | 'dropped-no-route'
    | 'dropped-stale'
    | 'failed';
```

The result should include transport attempts, peer counts, fallback decision,
and degradation reason.

## Implementation Direction

Do not start with a deep rewrite. Add a thin product layer over the existing
runtime first, then use it from Relic Hunters and the black-box runner.

### Phase 1: Name The States

Add a room transport status model.

Suggested fields:

```ts
type RallarRoomTransportStatus = Readonly<{
    roomRef: GroupRef;
    ws: RallarWsStatus;
    rtc: Readonly<{
        desired: boolean;
        mode: 'off' | 'lazy' | 'warm' | 'eager';
        state:
            | 'off'
            | 'idle'
            | 'connecting'
            | 'partial'
            | 'open'
            | 'degraded'
            | 'failed';
        desiredPeerIds: readonly string[];
        knownPeerIds: readonly string[];
        activePeerIds: readonly string[];
        readyPeerIds: readonly string[];
        failedPeerIds: readonly string[];
        laneId: string;
        lastChangedAtEpochMs?: number;
        reason?: string;
    }>;
}>;
```

Acceptance criteria:

- The status can distinguish "room exists" from "RTC room transport usable".
- Status can be computed without sending app traffic.
- Existing `rallar.rtc.status(...)` remains available.

### Phase 2: Add Room RTC Open/Wait Facade

Build a small facade that wraps existing `WebRtcGroupManager` and
`WebRtcConnectionService` behavior.

Candidate API:

```ts
await rallar.rtc.openRoom(roomRef, {
    mode: 'warm',
    laneId: 'realtime',
    timeoutMs: 1500
});

await rallar.rtc.waitForRoom(roomRef, {
    laneId: 'realtime',
    minReadyPeers: 1,
    timeoutMs: 1500
});
```

Implementation notes:

- Reuse `resolveRoomPeerIds(...)`.
- Use `ensurePeerLaneOpen(...)` only when policy calls for it.
- Avoid connecting peers that are no longer desired by current group state.
- Emit lifecycle/status events through existing RTC listener machinery.

Acceptance criteria:

- Apps can request room RTC readiness without manual `readyPeerIds()` polling.
- Results distinguish empty rooms, partial readiness, timeout, no lane, and
  connection failure.
- Existing tests for `waitForRoomLane(...)` keep passing.

### Phase 3: Make RTC Send Results Honest

Improve `rallar.messages.rtc.send(...)` and the multicast send path so callers
can tell when there was no usable route.

Current concern:

- A message can be enqueued or skipped by policy while the app still lacks a
  simple "nothing could be delivered" result.

Implementation notes:

- Preserve queuebox/AL internals.
- Add app-facing result metadata rather than changing the low-level AL contract
  first.
- Report planned next hops, open next hops, skipped next hops, and drop reason.

Acceptance criteria:

- Sending with no room returns a clear error or failed result.
- Sending with a room but no ready RTC peers returns `dropped-no-peers` or
  equivalent.
- Sending with hinted next hops that are not open reports `dropped-no-route` or
  equivalent.

### Phase 4: Add Transport Strategies To Typed Channels

Add a higher-level typed channel wrapper that owns fallback.

Candidate API:

```ts
const channel = rallar.messages.channel<GameSignal>({
    topicId: 'room.game.signal',
    typeId: 'game.signal.v1',
    roomRef,
    strategy: 'rtc-with-ws-fallback'
});

await channel.send({
    kind: 'cursor',
    x,
    y
});
```

Implementation notes:

- Keep existing `sendRtc` and `sendWs`.
- Add a new `send` method that follows strategy.
- Use WS for fallback only when the strategy allows it.
- Include result metadata from each attempted transport.

Acceptance criteria:

- Turn-based apps can choose WS-only.
- Realtime apps can choose RTC with fallback.
- CRDT/collaboration layers can choose WS durable plus RTC accelerator.

### Phase 5: Add Calls And Targeted Realtime Facades

Add first-class call and targeted-channel facades over the existing RTC,
realtime, media, and message layers.

Candidate APIs:

```ts
await rallar.calls.start({ peerId, media });
await rallar.calls.start({ peerIds, media });
await rallar.calls.start({ roomRef, membership: 'live', topology: 'auto', media });

const targeted = rallar.channels.targeted<T>({ peerIds, strategy });
const room = rallar.channels.room<T>({
    roomRef,
    membership: 'live',
    topology: 'auto',
    strategy
});
```

Implementation notes:

- Reuse room transport status and typed channel send results.
- Treat "call" as a session handle with status, participant state, and `end()`.
- Keep media permission/application consent outside automatic room join.
- Model microphone, camera, and screen share as separate media sources on the
  call handle.
- For room calls and room channels, update participants from group snapshots and
  overlay topology changes.
- For group multicast, use server-authoritative `overlay.topology` next hops
  rather than full-mesh assumptions.
- Add lane profile presets over existing data-channel configuration and flow
  control.
- Add a small RPC helper over data channels with correlation IDs, timeouts, and
  app-facing failure results.
- Treat bulk binary/file transfer as a separate lane profile with chunking,
  progress, cancellation, and backpressure.

Acceptance criteria:

- One-to-one calls open RTC only when explicitly started.
- One-to-many calls report per-participant state.
- Media is never requested or attached by ordinary room join.
- Screen share can be started and stopped independently from camera video.
- Targeted sends open lanes and return honest per-peer results.
- Room channels with `membership: 'live'` follow join/leave churn without app-side
  peer filtering.
- `realtime`, `reliable`, `control`, and `bulk` lane profiles map to concrete
  data-channel and flow-control behavior.

### Phase 6: Add WebRTC Platform Diagnostics And Recovery

Add a product-level diagnostics and recovery surface over lower-level WebRTC
state.

Candidate APIs:

```ts
const diagnostics = rallar.rtc.diagnostics({ roomRef });
const callDiagnostics = call.diagnostics();

await rallar.rtc.restartIce({ peerId });
await call.setQuality({ video: 'low-bandwidth', screen: 'presentation' });
```

Implementation notes:

- Surface selected candidate pair, ICE state, relay usage, RTT, jitter, packet
  loss, bitrate, frame rate, data-channel buffered amount, drops, and reconnect
  count.
- Add explicit states for permission denied, device unavailable, device changed,
  track stopped, and screen share ended.
- Add reconnect and ICE restart behavior that reports degraded/recovering/failed
  status instead of leaving lanes silently dead.
- Bind RTC peers to authenticated Rallar session IDs and reject signaling from
  unexpected peers.
- Make cleanup deterministic when rooms, calls, tracks, lanes, or peer sessions
  end.

Acceptance criteria:

- Apps can explain why a call or room RTC path is degraded.
- ICE restart can be requested and reflected in status.
- Permission/device failures are distinct from transport failures.
- Browser sleep or network handoff results in recovering/degraded/failed state.
- Stopping a call releases local tracks, data channels, and peer resources.

### Phase 7: Migrate Relic Hunters

Relic should stop treating `rtcReady` as "room exists".

Replace it with:

- `roomReady`
- `rtcDesired`
- `rtcConnecting`
- `rtcPartial`
- `rtcOpen`
- `rtcDegraded`

Scene networking should use a room realtime adapter instead of manually reading
`readyPeerIds()`.

Acceptance criteria:

- Position sends do not need manual peer filtering in app code.
- Snapshot repair sends report fallback/drop status.
- Diagnostics panel distinguishes middleware, room, WS, RTC partial/open, and
  degraded.

### Phase 8: Black-Box Coverage

Add coverage around policy, not only raw transport mechanics.

Scenarios:

- One-to-one on-demand call starts and ends cleanly.
- One-to-many call reports partial and degraded participant state.
- Screen share attach/replace/stop does not affect microphone or camera tracks.
- Stage-room mode can model speaker/listener roles without promising P2P media
  scalability.
- WS-only room app never attempts RTC.
- Warm RTC room reaches partial/open readiness.
- Empty room returns empty readiness, not failure.
- RTC send with no peers reports no-peers.
- RTC send with closed lane falls back to WS when configured.
- Data-channel lane profiles apply expected ordering, reliability, stale-drop,
  and backpressure behavior.
- Data-channel RPC correlates responses, times out, and reports peer disconnects.
- Bulk binary transfer reports progress, can cancel, and respects backpressure.
- ICE/TURN diagnostics identify direct versus relay connections.
- ICE restart transitions through recovering/degraded/open or failed state.
- Permission denied, no device, device changed, and screen-share-ended states are
  reported separately from transport errors.
- Browser sleep or simulated network handoff does not leave stale open status.
- Call/resource cleanup releases tracks, data channels, and peer handles.
- Room channel with `membership: 'live'` follows join/leave churn.
- Group multicast follows overlay next hops instead of creating full-mesh RTC
  connections.
- Eager room emits degraded status after timeout.
- Rejoin/reconnect does not create duplicate peer loops.

## Implementation Guardrails

- Keep `rallar.connect()` focused on middleware/connectivity, not eager peer
  meshes.
- Do not auto-open camera/microphone as part of room RTC policy or room join.
- Do not make RTC the default for authoritative state.
- Preserve lower-level APIs for advanced users and tests.
- Prefer additive facade changes before modifying AL/QueueBox internals.
- Make fallback explicit and visible.
- Treat "partial" as a normal state for room RTC; not every app needs every peer
  connected.
- Keep call sessions explicit: one-to-one and one-to-many calls may warm RTC and
  attach media, but only because the app requested that call.
- Treat microphone, camera, and screen share as separate consent and lifecycle
  surfaces.
- Do not claim tree/mesh data overlays solve large-room audio/video; use an
  SFU/relay boundary for scalable media fanout.
- Do not hide TURN relay usage or ICE failure details behind a generic
  "connection failed" state.
- Treat permission/device failures, signaling failures, ICE failures, and
  data-channel backpressure as distinct product states.
- Make resource cleanup explicit and testable; avoid ghost camera/microphone
  tracks, lingering TURN sessions, and stale peer connections.
- Keep E2EE/insertable-streams as a named future boundary unless the first slice
  explicitly scopes it in.
- Do not expose raw data-channel reliability knobs as the primary app API when a
  lane profile can express the intent.
- Use the tree/mesh topology plan for scalable room multicast connection and
  forwarding decisions.

## Documentation Updates

Add or update:

- `docs/rallar-quickstart-and-recipes.md`: app-type transport recipes.
- `docs/rallar-api-reference.md`: room transport policy and send result docs.
- `docs/rallar-api-reference.md`: one-to-one, one-to-many, and live room call
  session APIs.
- `docs/rallar-api-reference.md`: media source controls for microphone, camera,
  and screen share.
- `docs/rallar-api-reference.md`: lane profiles for realtime, reliable, control,
  and bulk data channels.
- `docs/rallar-troubleshooting-checklist.md`: RTC room diagnostics and fallback.
- `docs/rallar-troubleshooting-checklist.md`: call participant state, media
  permission, and live membership diagnostics.
- `docs/rallar-troubleshooting-checklist.md`: screen-share lifecycle, lane
  profile, RPC timeout, and bulk-transfer backpressure diagnostics.
- `docs/rallar-troubleshooting-checklist.md`: ICE/TURN diagnostics, selected
  candidate pair, relay usage, ICE restart, device state, network recovery, and
  cleanup checks.
- Black-box runner docs: policy-level RTC scenarios.
- Relic docs: why gameplay authority remains WS/server while avatar signals use
  RTC.

## Working Defaults For Implementation

Use these defaults for the first implementation slice unless a later decision
overrides them:

- Add APIs as additive facades; do not remove or rename current
  `messages`, `rtc`, `realtime`, or `media` APIs.
- Use `rallar.rtc.openRoom(...)` and `rallar.rtc.waitForRoom(...)` for the first
  room readiness facade.
- Add a generic strategy-aware `send(...)` to typed message channels before
  introducing a separate `rallar.channels.room(...)` namespace.
- Treat room RTC default mode as `lazy`; apps can opt into `warm` or `eager`.
- Keep fallback explicit per channel or lane; do not silently route all RTC
  failures over WS.
- Keep call APIs under `rallar.calls.*` when call sessions are introduced.
- Use fixed participant sets for one-to-many calls by default; require
  `membership: 'live'` for room calls that should track churn.
- Keep `topology: 'auto'` as an internal default for room multicast unless an
  app explicitly needs diagnostics or override hooks.
- Treat `realtime`, `reliable`, and `control` as first slice lane profiles;
  defer `bulk` until chunking/progress/cancel semantics are designed.

## Open Questions

- Should the new product surface be `rallar.room.open(...)`,
  `rallar.rooms.openTransport(...)`, or `rallar.transports.openRoom(...)`?
- Should `rallar.messages.channel(...)` gain a generic `send(...)`, or should a
  new `rallar.channels.room(...)` facade own strategy-aware traffic?
- Should `messages.rtc.send(...)` remain queue-result-only and expose richer
  diagnostics separately, or should it return app-send semantics directly?
- What is the correct default for room RTC: `off`, `lazy`, or `warm`?
- Should room RTC policies be persistent defaults, per-room runtime handles, or
  both?
- How much fallback should be automatic before it surprises developers?
- Should call APIs live under `rallar.calls.*`, `rallar.media.calls.*`, or
  `rallar.rtc.calls.*`?
- Should one-to-many calls use fixed participant lists by default, or should room
  calls require explicit `membership: 'live'`?
- Should `topology: 'auto'` be visible on public APIs, or should it be an
  internal room multicast default?
- Which call media source API is clearest: `media.screen`, `shareScreen()`, or a
  generic `addSource('screen')`?
- Should stage-room support be API-only in v1, or should it wait until an
  SFU/relay integration exists?
- Should lane profiles be fixed presets or allow advanced override of
  `RTCDataChannelInit` and flow-control policy?
- What TURN/ICE policy should be exposed publicly: direct/prefer-relay/relay-only
  or a smaller preset set?
- How much `getStats()` detail should be normalized into stable Rallar
  diagnostics versus exposed as raw browser stats?
- Should E2EE/insertable-streams be a first-class roadmap item, or only a future
  extension point for apps that need it?

## Recommended First Slice

Start with the smallest useful product wrapper:

1. Add `RallarRoomTransportStatus`.
2. Add `rallar.rtc.openRoom(...)` and `rallar.rtc.waitForRoom(...)` as additive
   APIs.
3. Add focused tests around empty, partial, open, timeout, and no-peer states.
4. Add strategy-aware room channels with honest send results.
5. Add targeted channels for one-to-one and one-to-many data sends.
6. Add lane profiles for realtime, reliable, and control data channels.
7. Add call session handles for one-to-one and one-to-many media/data calls,
   including independent audio, video, and screen sources.
8. Add basic RTC diagnostics: ICE state, relay usage, RTT, data-channel health,
   permission/device state, and cleanup status.
9. Defer bulk transfer, deep stats dashboards, E2EE, and SFU-backed stage rooms
   until the core call/channel model is stable.
10. Migrate Relic diagnostics from `rtcReady` to room RTC status.

This keeps the current implementation intact while moving the product model
toward what application authors actually need: declare intent, observe health,
and let Rallar handle transport choice, membership churn, and call lifecycle.
