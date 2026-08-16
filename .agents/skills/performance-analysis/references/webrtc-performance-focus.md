# WebRTC Performance Focus

Use this reference when a performance-analysis task targets Rallar WebRTC,
RTC-backed realtime messaging, media tracks, signaling, room topology, or
browser/server RTC lifecycle. Keep static analysis as hypothesis generation
unless a cost is proven from code or validated by measurements.

Do not put WebRTC-specific detail in `SKILL.md`. Keep this file as the focused
reference for future WebRTC audits.

## 1. WebRTC-Specific Hot Paths To Inspect

- Peer connection lifecycle: create, connect, offer/answer, ICE candidate
  exchange, reconnect, reset, disconnect, and final map deletion.
- Offer/answer negotiation: `onnegotiationneeded`, `setLocalDescription`,
  `setRemoteDescription`, glare handling, rollback, and stale answer handling.
- SDP and signaling payloads: repeated stringify/parse, SDP munging, verbose
  logs, per-recipient serialization, and delayed or duplicate messages.
- ICE candidate flow: pre-remote-description queues, candidate dedupe, queue
  flushing, restart behavior, stale session candidates, and TURN/STUN config
  refresh.
- DataChannel send path: JSON/binary serialization, `bufferedAmount`, queue
  policy, replace/drop behavior, fanout, large payloads, and close/error cleanup.
- DataChannel receive path: `onmessage`, JSON parse, binary copies,
  callback/listener fanout, user-facing state updates, and logging.
- Media flow: `getUserMedia`, `getDisplayMedia`, `MediaStreamTrack` ownership,
  `RTCRtpSender.replaceTrack`, transceivers, sender parameter updates, remote
  stream maps, and track stop/release paths.
- Browser UI integration: React effects, subscriptions, component unmount,
  video/audio element attach/detach, high-frequency state updates, and hidden
  tab behavior.
- Stats and diagnostics: `getStats()`, candidate-pair diagnostics, RTC status
  recomputation, heartbeat intervals, and diagnostics polling.
- Room/session/participant state: group membership scans, peer owner maps,
  readiness checks, retained peer connections, topology graph construction, and
  signaling fanout.

## 2. WebRTC Resource Lifecycle Checklist

For each resource type, answer:

- Where is it created?
- Which class/service/component owns it?
- What map, set, queue, closure, or timer can retain it?
- What is the intended lifetime: component, call, peer, room, session, or page?
- Where is normal cleanup performed?
- Where is error/reconnect cleanup performed?
- Is cleanup guaranteed on component unmount, logout, navigation, and server
  shutdown?
- Are event handlers/listeners/timers/subscriptions removed before references
  become unreachable?
- Are queues, send buffers, pending promises, and callback maps bounded and
  cleared?
- Does cleanup stop owned media tracks, close sockets/channels, and delete peer
  or room entries from maps?

## 3. PeerConnection Cleanup Checklist

Inspect:

- `RTCPeerConnection` creation and owner map insertion.
- `onicecandidate`, `onnegotiationneeded`, `ondatachannel`, `ontrack`,
  connection-state, signaling-state, and ICE-state handlers.
- Event listeners added with `addEventListener`; verify stored listener
  references are removed.
- Transceivers and senders: whether transceivers are stopped, senders removed or
  replaced, and old sender tracks are stopped only when owned.
- Reconnect and disconnect timers.
- Signaling promise chains and pending async work.
- ICE queues, remote stream maps, local sender maps, callback maps, and
  diagnostic counters.
- Final deletion from peer maps after reset/close.

Good cleanup evidence should include handler nulling, listener removal, timer
clear, `pc.close()`, queue clear, and owner map deletion.

## 4. MediaStreamTrack Cleanup Checklist

Track ownership carefully; do not assume every stream passed into the facade is
owned by the facade.

- Identify all capture sites: `getUserMedia`, `getDisplayMedia`, generated test
  streams, and caller-provided raw streams.
- For managed local sources, confirm same-kind replacement stops the previous
  source or documents caller ownership.
- For raw `setLocalStream(stream)`, verify whether previous raw tracks are
  stopped, detached, or explicitly caller-owned.
- For `replaceTrack`, check whether the replaced old track should be stopped.
- When a new stream lacks an audio/video kind, check whether old senders or
  tracks for that kind remain active.
- Confirm `track.stop()` is called on local camera, microphone, and screen-share
  tracks during explicit stop, disconnect, logout, unmount, and error paths.
- Do not stop remote tracks unless the code clearly owns them.
- Check `ended` listeners for `{ once: true }`, manual removal needs, and
  closures retaining runtime/source objects.
- For video/canvas processing, look for per-frame allocations, ImageBitmap,
  Blob/ArrayBuffer copies, `requestVideoFrameCallback`,
  `MediaStreamTrackProcessor`, workers, WASM, or insertable streams.

## 5. DataChannel Backpressure Checklist

Inspect per lane:

- Creation options: ordered/unordered, reliable/unreliable,
  `maxRetransmits`, `maxPacketLifeTime`, and `binaryType`.
- `send()` entry points for JSON stringify, binary copies, Blob handling, and
  per-peer fanout.
- `bufferedAmount` checks before every send.
- `bufferedAmountLowThreshold` and `onbufferedamountlow` flushing.
- Queue policy: max size, drop-new/drop-old/replace-by-key/coalesce behavior,
  stale item expiry, and whether high-frequency messages have keys.
- Queue operations: `shift`, `splice`, scans, index rebuilds, and worst-case
  complexity under full queues.
- Whether a slow peer can grow memory, block other peers, or force repeated
  serialization.
- Whether queues clear on close, error, reconnect, and peer reset.
- Whether event handlers are nulled and callback maps are removed or become
  unreachable.
- Whether broadcasts serialize once total, once per peer, or once per
  peer-message copy.

## 6. Signaling And Negotiation Performance Checklist

Inspect:

- Offer creation and `setLocalDescription()` frequency.
- Answer creation and `setRemoteDescription()` ordering.
- `onnegotiationneeded` gates: stable signaling state, already-making-offer
  flags, debounce, and coalescing.
- Glare handling: polite/impolite roles, rollback, ignored offers, and stale
  answer handling.
- Pending signaling chains or queues and whether they are cancelled on close.
- Duplicate offers/answers/candidates and stale session messages.
- JSON stringify/parse and full SDP/candidate logging in hot paths.
- WebSocket/QueueBox/pubsub fanout and per-recipient serialization.
- Database/API calls inside signaling message handling.
- Room join/leave and participant update work triggered by signaling.

## 7. ICE Candidate Queue Checklist

Inspect:

- Candidate queue owner and lifetime.
- Whether candidates are queued before remote description.
- Bounds on queue length and total bytes.
- Duplicate candidate detection.
- Stale candidate rejection after peer reset, reconnect generation change, or
  ignored glare offer.
- Flush strategy: `splice` plus iteration is usually better than repeated
  `shift()` on large arrays.
- Error handling during `addIceCandidate`.
- Queue metrics exposed in diagnostics.
- TURN/STUN config loading and refresh frequency.

## 8. Reconnect And Renegotiation Storm Checklist

Inspect:

- Disconnect timers and guards against duplicate timers.
- Reconnect timers, max attempts, backoff, jitter, and cancellation on close.
- ICE restart triggers and whether repeated failures call `restartIce()` too
  often.
- Whether data channels, peer connections, listeners, and heartbeats can be
  duplicated across reconnect.
- Whether pending offers, answers, candidates, and callbacks are stale-checked.
- Whether reconnect loops continue after logout/navigation/shutdown.
- Whether heartbeat missed-ping handling stops, disconnects, or repeatedly
  invokes callbacks while the channel remains open.
- Whether diagnostics expose reconnect, timer, offer collision, and ICE restart
  counters.

## 9. Browser And Client Profiling Guidance

Use browser profiling when the task concerns UI, media, DataChannel receive,
WebSocket receive, or component lifecycle.

Suggested tools and signals:

- Chrome DevTools Performance: long tasks, JS CPU, event handler duration, React
  commits, message bursts, and timer wakeups.
- Chrome Memory/Allocation instrumentation: retained `RTCPeerConnection`,
  `RTCDataChannel`, `MediaStream`, `MediaStreamTrack`, callbacks, and closures.
- `chrome://webrtc-internals`: peer connection count, ICE candidates,
  candidate-pair state, media tracks, bytes, codec, and stats.
- React Profiler: high-frequency RTC/status/message state updates.
- Browser counters: `bufferedAmount`, queue length, sent/dropped/replaced
  messages, listener counts, active timers, active tracks, and live peer count.
- Hidden-tab tests: `document.visibilityState`, timer wakeups, heartbeat missed
  count, reconnect attempts, and foreground recovery behavior.

Prefer real browser runs for media and DataChannel backpressure; Node/Deno
synthetic harnesses are useful for algorithmic shape but do not model browser
media internals.

## 10. Server, SFU, And Room Scalability Guidance

This repo currently has room topology, WebSocket/QueueBox signaling, overlay
multicast/relay-style forwarding, and browser peer mesh logic. Treat any SFU/MCU
claim as absent unless specific code proves otherwise.

Inspect server-side:

- Room/group join, leave, reconnect, participant update, and cleanup complexity.
- Peer/session maps and whether closed sockets or inactive sessions remain
  referenced.
- Signaling fanout and whether the same payload is serialized once or per
  recipient.
- ICE candidate relay paths and duplicate/stale candidate handling.
- Room topology graph construction and RTT-driven topology recomputation.
- Overlay/multicast forwarding, transport message copying, and per-hop
  serialization.
- QueueBox/pubsub queue bounds, slow-client behavior, retry behavior, and
  whether one slow participant can degrade a room.
- Database/API calls in signaling or room lifecycle hot paths.
- Metrics/logging cost under many rooms, peers, and RTT updates.

Classify complexity for join, leave, reconnect, broadcast, participant update,
cleanup, and topology rebuild as `O(1)`, `O(peers)`, `O(peers^2)`,
`O(rooms * peers)`, or worse.

## 11. Metrics To Collect

Connection and negotiation:

- Connection setup time and time to first open DataChannel.
- Offer, answer, glare, rollback, stale answer, negotiation-needed, and ICE
  restart counts.
- ICE candidates sent/received/queued/flushed/dropped/deduped, queue length, and
  queue flush duration.
- WebSocket signaling message count, bytes, parse time, and fanout count.

DataChannel:

- Messages/sec, bytes/sec, send latency, receive handler duration.
- `bufferedAmount` over time, threshold-crossing count, queue length, queued,
  sent, flushed, dropped, replaced, stale-dropped, and partial-send counts.
- JSON stringify/parse duration, binary copy bytes, payload size distribution,
  and per-peer serialization count.

Media:

- Active local/remote track count, track stop count, replacement count, ended
  events, camera/mic/screen capture state.
- Encoder/decoder stats, FPS, frame drops, resolution, bitrate, and CPU time.
- Per-frame allocation rate if any frame processing pipeline exists.

Memory and lifecycle:

- Heap/RSS before/after cycles, post-GC heap, retained peer/channel/stream/track
  objects, listener counts, timer counts, callback map sizes, and queue sizes.
- Room/session/participant map sizes and retained inactive topology snapshots.

Server/room:

- Room size, active sessions, topology graph nodes/edges, topology rebuild time,
  RTT update rate, overlay transport messages, pubsub queue length, DB query
  count, and slow-client backlog.

## 12. Suggested Repeated Connect/Disconnect Leak Test

Use this scenario as the default leak-test shape before optimizing:

1. Start the smallest local stack that supports real browser WebRTC. Prefer
   memory-mode black-box scripts when they cover the target path.
2. Create or join one room with two browser sessions.
3. Establish WebRTC, open the default realtime DataChannel, and send a small
   JSON message in both directions.
4. If media is in scope, start camera/microphone or screen sharing, attach it to
   the peer, then stop it.
5. Disconnect cleanly through the facade.
6. Repeat 25, 50, and 100 cycles.
7. Repeat with one abrupt path: close the page, close the WebSocket, or force a
   failed peer connection.
8. Force or wait for GC where the environment allows it.
9. Record heap/RSS, peer count, active tracks, active DataChannels, sockets,
   timers, listeners, queue lengths, ICE queue length, and room/session map
   sizes after each cycle.

Do not claim a leak unless retained growth persists across cycles or static code
shows a retained reference.

## 13. Repo-Specific WebRTC Files And Directories

Core browser/shared WebRTC:

- `packages/shared/webrtc/QRtcPeerConnection.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `packages/shared/webrtc/RtcDataChannelSendQueue.ts`
- `packages/shared/webrtc/QRtcMediaChannel.ts`
- `packages/shared/webrtc/WsRtcSignalingTransport.ts`
- `packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts`
- `packages/shared/webrtc/QRtcSignalingContracts.ts`
- `packages/shared/services/WebRtcConnectionService.ts`
- `packages/shared/services/WebRtcRxStreamerService.ts`
- `packages/shared/services/WebRtcHeartbeatService.ts`
- `packages/shared/services/WebRtcGroupService.ts`
- `packages/shared/services/WebRtcGroupManager.ts`
- `packages/shared/services/WsQueueBoxClientService.ts`
- `packages/shared/services/InboxOutboxEngine.ts`
- `packages/shared/websocket/JsonWebSocketClient.ts`
- `packages/shared/websocket/JsonWebSocketServer.ts`

Browser facade and runtime:

- `packages/shared-web/browser/middleware.ts`
- `packages/shared-web/browser/rtc-engine.ts`
- `packages/shared-web/browser/app-context.ts`
- `packages/shared-web/browser/rallar-runtime-context.ts`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-rtc-facade.ts`
- `packages/shared-web/browser/rallar-media-facade.ts`
- `packages/shared-web/browser/rallar-media-calls.ts`
- `packages/shared-web/browser/rallar-realtime-facade.ts`
- `packages/shared-web/browser/rallar-realtime.ts`
- `packages/shared-web/browser/ws-engine.ts`
- `packages/shared-web/browser/ws-message-router.ts`
- `packages/shared-web/browser/rtc-message-router.ts`
- `packages/shared-web/browser/browser-queuebox.ts`
- `packages/shared-web/browser/browser-al-runtime-stores.ts`

Server/room/signaling/topology:

- `packages/shared-server/rallar-system/ws-system-topics.ts`
- `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`
- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `packages/shared-server/rallar-system/services/client-state-service.ts`
- `packages/shared-server/rallar-system/services/ws-lifecycle-service.ts`
- `packages/shared-server/rallar-system/services/AppClientInboxService.ts`
- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- `packages/shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts`
- `packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts`
- `packages/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts`
- `packages/shared-server/rallar-system/rtc-topology/policy/rtc-rtt-measurement-policy.ts`
- `packages/shared-server/rallar-system/rtc-topology/topic/init-rtc-rtt-topic.ts`
- `packages/shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts`
- `apps/api-v1/src/routes/ice-route.ts`
- `apps/api-v1/src/routes/ws-routes.ts`
- `apps/api-v1/src/services/ws-topic-room-authorizer.ts`

Apps and browser test surfaces:

- `apps/rallar-black-box/src/App.tsx`
- `apps/rallar-black-box/src/rtc-diagnostics.ts`
- `apps/rallar-black-box/src/live-rtc-three-browser-coverage.ts`
- `apps/rallar-black-box/manifests/hetzner/*.json`
- `apps/rallar-black-box/manifests/hetzner/diagnostic/*.json`
- `apps/rallar-black-box/examples/rallar-server-rtc-connect-send.recipe.json`
- `apps/relic-hunters-v1/src/game/scene/networking.ts`
- `apps/relic-hunters-v1/src/game/RelicScene.tsx`
- `apps/relic-hunters-v1/src/game/RelicSceneNext.tsx`
- `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`
- `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts`

Tests and perf harnesses:

- `packages/tests/shared/webrtc-connection-service.test.ts`
- `packages/tests/shared/webrtc-rx-streamer-service.test.ts`
- `packages/tests/shared/webrtc-heartbeat.test.ts`
- `packages/tests/shared/webrtc-group-service.test.ts`
- `packages/tests/shared/webrtc-group-manager.test.ts`
- `packages/tests/shared/websocket-webrtc.test.ts`
- `packages/tests/shared-web/rallar-rtc-diagnostics-compat.test.ts`
- `packages/tests/shared-web/rallar-rtc-recovery-compat.test.ts`
- `packages/tests/shared-web/rallar-rtc-wait-compat.test.ts`
- `packages/tests/shared-web/rallar-media-sources-compat.test.ts`
- `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
- `scripts/perf/README.md`
- `scripts/perf/rtc-*.ts`
- `scripts/perf/webrtc-*.ts`
- `scripts/perf/rtc-data-channel-browser-soak.mjs`

## 14. Repo-Specific Commands Discoverable In This Repo

Use commands from the repository root. Put generated outputs under `tmp/perf/`
unless a script already documents a different ignored artifact directory.

Focused static/unit checks:

```sh
npm run test:unit
vitest run packages/tests/shared/webrtc-connection-service.test.ts packages/tests/shared/webrtc-rx-streamer-service.test.ts packages/tests/shared/webrtc-heartbeat.test.ts packages/tests/shared/webrtc-group-service.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/websocket-webrtc.test.ts
vitest run packages/tests/shared-web/rallar-rtc-diagnostics-compat.test.ts packages/tests/shared-web/rallar-rtc-recovery-compat.test.ts packages/tests/shared-web/rallar-rtc-wait-compat.test.ts packages/tests/shared-web/rallar-media-sources-compat.test.ts
vitest run packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
```

Black-box/browser RTC scenarios:

```sh
npm run test:rallar:full-stack:memory:live-rtc-3
npm run test:rallar:full-stack:postgres:live-rtc-3
npm run test:shared-black-box:memory:traffic
npm run test:shared-black-box:memory:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:browser:live
```

Reusable WebRTC perf harness examples from `scripts/perf/README.md`:

```sh
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-peer-connection-diagnostics-burst.ts --peers=500 --ice-candidates=5 --offer-collisions=3 --runs=3 --out=tmp/perf/results/rtc-peer-connection-diagnostics-burst-runs3.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-ice-candidate-queue-bench.ts --candidates=25000 --runs=5 --out=tmp/perf/results/rtc-ice-candidate-queue.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-data-channel-replace-key-bench.ts --queue-size=5000 --replacements=25000 --runs=5 --out=tmp/perf/results/rtc-data-channel-replace-key.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/webrtc-heartbeat-callback-churn-bench.ts --channels=10000 --runs=5 --out=tmp/perf/results/webrtc-heartbeat-callback-churn.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/webrtc-group-manager-state-bench.ts --clients=5000 --desired=1000 --lookups=20 --runs=5 --out=tmp/perf/results/webrtc-group-manager-state.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-room-graph-rtt-bench.ts --sessions=600 --runs=5 --out=tmp/perf/results/rtc-room-graph-rtt.json
node scripts/perf/rtc-data-channel-browser-soak.mjs
```

Diagnostics artifact capture:

```sh
RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/results npm run test:rallar:full-stack:memory:live-rtc-3
```

Profiling patterns documented in `scripts/perf/README.md`:

```sh
deno run --config apps/api-v1/deno.json --allow-read --allow-write --v8-flags=--prof,--expose-gc scripts/perf/runtime-validation-bench.ts --mode=full --runs=1 --out=tmp/perf/results/runtime-validation-focused-profiled-run.json
node --prof-process tmp/perf/profiles/runtime-validation-focused-v8.log > tmp/perf/profiles/runtime-validation-focused-v8-processed.txt
```

Do not run Postgres integration or live browser commands unless the task asks
for runtime validation and the environment is ready.

## 15. Known Open Questions

- Is there a documented ownership rule for raw streams passed to
  `facade.media.setLocalStream(stream)`?
- Which browser UI components are expected to call `facade.disconnect()` on
  unmount, versus intentionally keeping the singleton facade alive?
- What room sizes are representative for WebRTC mesh/overlay scenarios in
  production-like use?
- Are TURN/STUN credentials refreshed during long browser sessions, and should
  expiry be measured during reconnect tests?
- Which RTC diagnostics are safe to poll in UI, and which should remain manual?
- Should high-frequency game motion lanes prefer JSON, compact JSON, or binary
  once measurements justify a payload change?
- What is the acceptable DataChannel drop/coalesce policy per lane and payload
  type?
- Should browser background tabs pause or throttle heartbeats, QueueBox expiry,
  and AL-runtime expiry loops?
- Is any true SFU/MCU media forwarding planned, or is current scalability work
  limited to peer mesh, overlay multicast, and signaling/topology?
- What thresholds should gate performance regressions: setup time, reconnect
  time, max queued ICE candidates, max `bufferedAmount`, message loss/drop
  rate, heap growth per cycle, and room topology rebuild time?
