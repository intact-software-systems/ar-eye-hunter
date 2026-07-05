# Rallar WebRTC Runtime Measurement Validation

Date: 2026-07-02  
Mode: runtime measurement validation, no optimization changes  
Artifacts: `tmp/perf/results/**` and temporary harnesses under `tmp/perf/scripts/**`

Related static reports:

- [WebRTC performance map](rallar-webrtc-performance-map-2026-07-02.md)
- [WebRTC static performance audit](rallar-webrtc-static-performance-audit-2026-07-02.md)
- [WebRTC memory and retained-resource audit](rallar-webrtc-memory-retained-resource-audit-2026-07-02.md)
- [WebRTC DataChannel backpressure audit](rallar-webrtc-datachannel-backpressure-audit-2026-07-02.md)
- [WebRTC signaling and negotiation audit](rallar-webrtc-signaling-negotiation-audit-2026-07-02.md)
- [WebRTC media pipeline CPU/memory audit](rallar-webrtc-media-pipeline-cpu-memory-audit-2026-07-02.md)

## Environment Assumptions

Runtime:

- Node.js `v26.4.0`
- npm `11.17.0`
- Deno `2.9.0`, V8 `14.9.207.2-rusty`, `aarch64-apple-darwin`
- Local macOS desktop sandbox. Headless Chromium required an escalated rerun because the first sandboxed launch failed with `MachPortRendezvousServer ... Permission denied`.

Scenario assumptions:

- The full three-browser live RTC scripts exist in `package.json` (`test:rallar:full-stack:memory:live-rtc-3`, `test:rallar:full-stack:postgres:live-rtc-3`, and `test:rallar:full-stack:postgres:live-rtc-3:all`) at [`package.json`](../../package.json#L53), [`package.json`](../../package.json#L60), and [`package.json`](../../package.json#L62).
- I did not run the full-stack matrix because it would mix WebRTC runtime behavior with server startup, login, UI automation, database/API latency, and test orchestration noise. The smallest realistic local scenario was a same-page Chromium `RTCPeerConnection` pair plus focused synthetic harnesses for wrapper internals.
- Existing repo perf tooling already covers the targeted areas: room graph, multicast serialization, ICE queue flush, listener cleanup, DataChannel queue policies, browser DataChannel soak, and peer diagnostics in [`scripts/perf/README.md`](../../scripts/perf/README.md#L57).

## Commands Run

Environment and inventory:

```bash
node --version
npm --version
deno --version
rg -n "live-rtc|rtc-data-channel|perf|playwright|benchmark|bench" package.json scripts/perf apps packages --glob 'package.json' --glob '*.md'
```

Measurements:

```bash
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-peer-connection-diagnostics-burst.ts --peers=250 --ice-candidates=20 --offer-collisions=5 --runs=3 --out=tmp/perf/results/webrtc-runtime-peer-connection-diagnostics-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-ice-candidate-queue-bench.ts --candidates=25000 --runs=5 --out=tmp/perf/results/webrtc-runtime-ice-candidate-queue-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-data-channel-replace-key-bench.ts --queue-size=5000 --replacements=25000 --runs=5 --out=tmp/perf/results/webrtc-runtime-datachannel-replace-key-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-peer-listener-cleanup-bench.ts --peers=5000 --runs=5 --out=tmp/perf/results/webrtc-runtime-peer-listener-cleanup-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write --no-check --v8-flags=--expose-gc tmp/perf/scripts/webrtc-resource-lifecycle-validation.ts --queue-items=256 --close-runs=5 --media-cycles=1000 --media-runs=3 --out=tmp/perf/results/webrtc-runtime-resource-lifecycle-2026-07-02.json
node tmp/perf/scripts/webrtc-browser-datachannel-validation.mjs --iterations=30 --messages=128 --payload-bytes=4096 --out=tmp/perf/results/webrtc-runtime-browser-datachannel-validation-2026-07-02.json
node tmp/perf/scripts/webrtc-browser-datachannel-validation.mjs --iterations=100 --messages=32 --payload-bytes=4096 --out=tmp/perf/results/webrtc-runtime-browser-datachannel-validation-100cycles-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write tmp/perf/scripts/webrtc-multicast-serialization-validation.ts --peer-counts=10,100,1000 --payload-bytes=4096,65536 --runs=3 --out=tmp/perf/results/webrtc-runtime-multicast-serialization-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-room-graph-no-rtt-bench.ts --sessions=100 --runs=5 --out=tmp/perf/results/webrtc-runtime-room-graph-no-rtt-100-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-room-graph-no-rtt-bench.ts --sessions=500 --runs=3 --out=tmp/perf/results/webrtc-runtime-room-graph-no-rtt-500-2026-07-02.json
deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-room-graph-no-rtt-bench.ts --sessions=1000 --runs=3 --out=tmp/perf/results/webrtc-runtime-room-graph-no-rtt-1000-2026-07-02.json
```

Failed or adjusted attempts:

- `node tmp/perf/scripts/webrtc-browser-datachannel-validation.mjs ...` failed once inside the sandbox; rerun with escalation succeeded.
- `deno run ... scripts/perf/rtc-data-channel-close-retention-bench.ts ...` failed because that script imports `../../../packages/...`, which resolves outside this repo when run from `scripts/perf`.
- `deno run ... scripts/perf/rtc-multicast-serialization-bench.ts ...` failed for the same relative-import issue. I used a temporary copy at `tmp/perf/scripts/webrtc-multicast-serialization-validation.ts`, where the import path resolves inside the repo.

## Scenario Description

1. **Real browser local peer pair.** `tmp/perf/scripts/webrtc-browser-datachannel-validation.mjs` launches Chromium, creates `pcA` and `pcB`, manually exchanges offer/answer and ICE candidates, sends a DataChannel burst, waits for `bufferedAmount` to drain, closes both channels and peer connections, and samples JS heap through CDP GC/Performance metrics. The core loop is in `runIteration` at [`tmp/perf/scripts/webrtc-browser-datachannel-validation.mjs`](../../tmp/perf/scripts/webrtc-browser-datachannel-validation.mjs#L80).
2. **Peer connection diagnostics burst.** `scripts/perf/rtc-peer-connection-diagnostics-burst.ts` creates synthetic `QRtcPeerConnection` objects, queues ICE before remote description, injects offer collisions, exercises reconnect timers, drains synthetic timers, and reads `QRtcPeerConnection.readDiagnostics()`. See [`scripts/perf/rtc-peer-connection-diagnostics-burst.ts`](../../scripts/perf/rtc-peer-connection-diagnostics-burst.ts#L76).
3. **ICE candidate flush.** `scripts/perf/rtc-ice-candidate-queue-bench.ts` directly fills `QRtcPeerConnection.status.iceCandidateQueue` and calls the private flush path against a fake `addIceCandidate`. See [`scripts/perf/rtc-ice-candidate-queue-bench.ts`](../../scripts/perf/rtc-ice-candidate-queue-bench.ts#L50).
4. **DataChannel backpressure queue.** `scripts/perf/rtc-data-channel-replace-key-bench.ts` forces `QRtcDataChannel` into backpressure with `replace-by-key` overflow and measures queue fill/replacement.
5. **DataChannel close retention and media lifecycle.** `tmp/perf/scripts/webrtc-resource-lifecycle-validation.ts` tests queued DataChannel close/reconnect behavior and repeated synthetic media attach/replace/stop/reset cycles. DataChannel close coverage starts at [`tmp/perf/scripts/webrtc-resource-lifecycle-validation.ts`](../../tmp/perf/scripts/webrtc-resource-lifecycle-validation.ts#L114); media lifecycle coverage starts at [`tmp/perf/scripts/webrtc-resource-lifecycle-validation.ts`](../../tmp/perf/scripts/webrtc-resource-lifecycle-validation.ts#L346).
6. **Room/multicast fanout and topology.** `tmp/perf/scripts/webrtc-multicast-serialization-validation.ts` measures `WebRtcOverlayMulticastService.createOriginatingPlan` and per-next-hop serialization at [`tmp/perf/scripts/webrtc-multicast-serialization-validation.ts`](../../tmp/perf/scripts/webrtc-multicast-serialization-validation.ts#L145). `scripts/perf/rtc-room-graph-no-rtt-bench.ts` measures `RallarRtcTopologyService.createRoomGraph`, whose nested edge construction is in [`rallar-rtc-topology-service.ts`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L395).

## Metrics Collected

- Connection setup time: browser local `RTCPeerConnection` pair, offer/answer through DataChannel open.
- Renegotiation/glare proxy counters: synthetic inbound offer collisions and ignored offer collisions.
- ICE candidate count: browser candidate counts and synthetic queued/flushed candidate counts.
- Signaling message count: browser in-memory SDP/candidate message count and synthetic `QRtcPeerConnection` outbound signaling count.
- DataChannel `bufferedAmount`: browser burst peak and drain time.
- Queue lengths: `QRtcDataChannel.readHealth().queuedItemCount`, ICE queue remaining count.
- CPU time: wall-clock duration for each measurement case.
- Event loop blocking/long tasks: browser Long Tasks API count.
- Heap/RSS: browser JS heap delta after forced GC; Deno heap/RSS in synthetic lifecycle harness after best-effort GC.
- Retained objects/listeners: fake peer connection handler/listener counts; DataChannel handler slots after close; synthetic local stream/sender references after stop/reset.

## Results Table

| Area | Location | Measurement | Result | Interpretation |
| --- | --- | --- | --- | --- |
| Browser PC/DataChannel lifecycle | `RTCPeerConnection`/`RTCDataChannel` in [`webrtc-browser-datachannel-validation.mjs`](../../tmp/perf/scripts/webrtc-browser-datachannel-validation.mjs#L80) | 100 connect/send/close cycles, 32 x 4 KiB sends per cycle | 100/100 opened and closed; setup mean `7.43 ms`, p95 `7.80 ms`; `400` ICE candidates; `600` in-memory signal messages; max `bufferedAmount` `132,118`; JS heap delta `87,588 bytes`; long tasks `0` | No obvious leak or long-task issue in the minimal browser scenario. This does not cover full app signaling, rooms, or wrapper-level reconnect paths. |
| Browser burst buffering | Same browser harness | 30 cycles, 128 x 4 KiB sends per cycle | setup mean `8.08 ms`; max `bufferedAmount` `528,402`; drain mean `15.98 ms`; heap delta `84,120 bytes`; send errors `0` | Browser SCTP buffer drains cleanly locally, but the burst shows how quickly `bufferedAmount` grows when producers send without waiting. |
| Peer negotiation/reconnect diagnostics | `QRtcPeerConnection.handleSignal`, `processSignal`, `handleReconnect` in [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L482) and [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L619) | 3 runs, 250 logical peer pairs, 20 queued ICE candidates per polite peer, 5 offer collisions per impolite peer | mean `7.38 ms`; per run: `5,000` queued ICE, `5,000` flushed ICE, `1,250` offer collisions, `1,250` ignored collisions, `250` reconnect attempts, `250` `restartIce()` calls, no remaining ICE queue | Glare and reconnect guards function in this synthetic case. It confirms high message/counter volume under storms, but not full network behavior. |
| ICE queue flush | `QRtcPeerConnection.flushIceCandidateQueue` in [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L605) | 5 runs, 25,000 queued candidates | mean `1.61 ms`, max `2.46 ms`, remaining queue `0` | Sequential flush is not CPU-hot with fake `addIceCandidate`. The unbounded queue remains a memory/stale-message risk because candidates are pushed at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L590). |
| DataChannel replace-by-key queue | `QRtcDataChannel.handleBackPressure` and keyed queue index in [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L625) and [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L729) | 5 runs, queue size 5,000, 25,000 replacements | queue fill mean `1.94 ms`; replacement mean `7.67 ms`; total mean `9.64 ms`; queued count stayed `5,000`; sent count `0` | Keyed replacement is bounded and fast in this synthetic path. Static concern about an `O(queue)` scan is refuted for current code because the queue now has `sendQueueIndexByKey`. |
| DataChannel close retention | `QRtcDataChannel.dc.onclose` in [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L456) | 5 runs, 256 queued sends, native close, reconnect | queued before close `256`; queued after close `0`; queued after reconnect `0`; handlers after close `0`; stale flush `false` | Static queue-retention hypothesis is refuted for current code. `onclose` clears queued sends and native handlers. The run did expose expected-close stack logging at [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L462). |
| Peer listener cleanup | `QRtcPeerConnection.closePeerConnectionIfPresent` in [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L189) | 5 runs, 5,000 connect/reset cycles | retained `icegatheringstatechange` listeners `0`; uncleared handler slots `0` | Listener cleanup is confirmed for the normal `reset()` path. The current code stores/removes `iceGatheringStateChangeListener` at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L213). |
| Media attach/stop/reset lifecycle | `QRtcPeerConnection.setLocalMediaStream` and `stopLocalMedia` in [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L759) and [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L808) | 3 runs, 1,000 synthetic cycles per run | per run: `2,000` `addTrack`, `2,000` `replaceTrack`; old replaced tracks still live after `stopLocalMedia('all')`: `2,000`; current tracks stopped: `2,000`; local stream retained after stop: `1,000`; sender entries retained after stop: `2,000`; reset cleared stream/senders: `1,000/1,000` | Confirms the ownership/lifetime shape: `replaceTrack` does not stop old caller-owned tracks, and `stopLocalMedia` stops current tracks but retains stream/sender references until reset or replacement. |
| Multicast serialization fanout | `WebRtcOverlayMulticastService.prepareTransportReadyCopies` in [`WebRtcOverlayMulticastService.ts`](../../packages/shared/multicast/WebRtcOverlayMulticastService.ts#L73) | 10/100/1000 peers, 4 KiB and 64 KiB payloads | 1,000 peers x 64 KiB produced `1,000` unique serialized messages, `66.21 MB` total serialized bytes, serialize mean `16.01 ms`; 1,000 peers x 4 KiB serialized `4.77 MB` in mean `2.34 ms` | Confirms `O(peers x message size)` serialization/copy cost for room/overlay fanout. |
| Room graph construction | `RallarRtcTopologyService.createRoomGraph` in [`rallar-rtc-topology-service.ts`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L366) | 100, 500, 1000 active sessions, no RTT | 100 sessions: `4,950` edges, mean `2.88 ms`; 500 sessions: `124,750` edges, mean `67.96 ms`; 1000 sessions: `499,500` edges, mean `317.30 ms` | Confirms the static `O(n^2)` topology risk. This was the largest measured local cost. |

## Confirmed Bottlenecks

1. **Room topology graph construction is the largest measured cost.** `createRoomGraph` constructs a complete graph with nested loops at [`rallar-rtc-topology-service.ts`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L395). The 1000-session no-RTT run built `499,500` edges and averaged `317.30 ms`.
2. **Overlay/multicast serialization scales with peers times payload size.** `prepareTransportReadyCopies` creates one transport-ready message per next hop at [`WebRtcOverlayMulticastService.ts`](../../packages/shared/multicast/WebRtcOverlayMulticastService.ts#L89), and the measurement serialized `66.21 MB` for one 64 KiB payload to 1000 peers.
3. **Media track ownership risk is real for direct/replacement flows.** `setLocalMediaStream` replaces senders by `track.kind` at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L769), and `stopLocalMedia` only stops tracks from the current `status.localStream` at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L808). The synthetic run confirmed old replaced tracks remain live unless their owner stops them.
4. **Expected DataChannel close logs stack traces.** `dc.onclose` calls `console.error(..., new Error().stack)` at [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L462). The close-retention validation emitted one stack trace per expected close.

## Refuted Hypotheses

1. **Native DataChannel close retaining queued sends is refuted for current code.** The current `dc.onclose` path clears queued sends at [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L466). Runtime result: queue `256 -> 0`, no stale flush on reconnect.
2. **PeerConnection listener cleanup leak on normal reset is refuted in the focused harness.** `closePeerConnectionIfPresent` nulls handlers and removes the stored ICE gathering listener at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L205). Runtime result: zero retained listeners/handler slots after 5,000 reset cycles.
3. **Current DataChannel keyed replacement is not an `O(queue)` scan in the measured path.** `findQueuedSendIndexByKey` uses `sendQueueIndexByKey` at [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L729). Runtime result: 25,000 replacements against a 5,000-item queue averaged `7.67 ms`.
4. **Minimal browser peer/data-channel churn did not show leak-like growth.** The 100-cycle real Chromium pass ended with 100/100 closed cycles and only `87,588` bytes JS heap delta after forced GC.

## Inconclusive Hypotheses

1. **Full-stack signaling fanout and QueueBox/WebSocket cost.** The local browser harness used in-memory signaling, not `WsRtcSignalingTransportUsingWsQBox` or server-side `WsQueueBoxServerService`. The real signaling transport path still needs full-stack counters around [`WsRtcSignalingTransportUsingWsQBox.send`](../../packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts#L71) and QueueBox dispatch.
2. **Reconnect storms under real network flaps.** The synthetic diagnostics confirmed guard counters, but did not simulate browser ICE state churn, TURN failures, tab backgrounding, or delayed WebSocket delivery. The relevant production paths remain [`QRtcPeerConnection.setupStateChangeCallbacks`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L392) and [`QRtcPeerConnection.handleReconnect`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L619).
3. **Real camera/microphone/screen CPU and frame processing.** The media lifecycle run used fake tracks. It validates reference ownership, not encoder CPU, capture constraints, screen-share frame rate, or Babylon render-loop cost in [`BabylonArena.tsx`](../../apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx#L853).
4. **`getStats()`/diagnostics polling overhead.** No long-running stats polling workload was run. The on-demand diagnostics path remains [`readSelectedCandidatePairDiagnostics`](../../packages/shared-web/browser/rallar.ts#L9213).
5. **Database/API calls inside full signaling hot paths.** No full-stack server was launched, so server persistence or HTTP/API participation in signaling remains unmeasured.

## Do Not Optimize Yet: Validation Plan

1. Add temporary production-style counters, not behavior changes:
   - room active session count
   - topology graph build duration and edge count
   - multicast transport message count and serialized byte count
   - signaling SDP/candidate count and byte count
   - DataChannel `bufferedAmount`, queued count, replaced/dropped count, and close count
   - media `replaceTrack` count and old-track stop/ended count
2. Run `npm run test:rallar:full-stack:memory:live-rtc-3` with counters enabled before broader Postgres/full-stack runs.
3. Run one real-browser media lifecycle profile with fake media devices: repeated direct `media.setLocalStream`, source start/stop, and screen-share start/stop.
4. Capture Chrome allocation sampling and heap snapshots only after the counter run identifies a reproducible leak-like case.
5. Keep all generated profiles under `tmp/perf/` and do not commit them unless explicitly requested.

## Top 3 Measurement Tasks Next

1. **Full-stack signaling/room counter pass.** Run the memory-mode three-browser RTC matrix with counters for QueueBox depth, signal messages, candidate count, room graph build duration, and multicast serialized bytes.
2. **Real media retention pass.** Use Chromium fake camera/microphone devices to repeat direct stream replacement and stop/reset cycles, then inspect retained `MediaStreamTrack` objects in heap snapshots.
3. **Wrapper DataChannel browser backpressure pass.** Exercise `QRtcDataChannel` in-browser with induced `bufferedAmount` pressure, reconnect, and `readHealth()` sampling over time.

## Recommended First Optimization After Measurement

The first optimization to consider is **reducing complete room graph rebuild cost in `RallarRtcTopologyService.createRoomGraph`** if production counters show rooms or overlays approaching hundreds of active sessions. The measured `317.30 ms` at 1000 sessions is much larger than the other local costs and follows directly from the complete graph construction at [`rallar-rtc-topology-service.ts`](../../packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts#L395).

If production rooms are usually small, the first low-risk cleanup to consider instead is gating the expected-close `console.error(... new Error().stack)` in `QRtcDataChannel.dc.onclose` at [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L462), because repeated normal disconnect/reconnect cycles currently allocate and emit stack traces.

## Uncertainty and Noise

- Absolute timings are laptop-local and should not be treated as production benchmarks.
- Synthetic Deno harnesses isolate wrapper behavior but do not include browser ICE, SCTP, capture devices, WebSocket, QueueBox, or database work.
- Browser heap deltas used forced GC through CDP and are useful for coarse leak checks, not precise retained-size accounting.
- The media lifecycle heap/RSS values are inconclusive because fake objects, Deno runtime allocation, and module/JIT warmup can dominate; the reference-count results are more reliable than the memory deltas.
