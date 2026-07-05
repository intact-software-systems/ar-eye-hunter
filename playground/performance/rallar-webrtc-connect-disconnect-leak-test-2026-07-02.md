# Rallar WebRTC Connect/Disconnect Leak Test

Date: 2026-07-02  
Mode: runtime leak validation, no production behavior changes  
Artifacts: `tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs`, `tmp/perf/results/webrtc-connect-disconnect-leak-200cycles-2026-07-02.json`

Related runtime report:

- [WebRTC runtime measurement validation](rallar-webrtc-runtime-measurement-validation-2026-07-02.md)

## Goal

Detect retained WebRTC resources across repeated connect/disconnect cycles:

- peer connections
- media tracks
- data channels
- WebSockets
- timers/intervals/listeners
- ICE candidate queues
- pending signaling messages
- DataChannel buffers
- room/session/participant state where observable

Leak threshold used here: do not claim a leak unless object counters remain nonzero after cleanup, or heap/RSS growth persists across many forced-GC cycles without flattening.

## Test Scenario

I created an isolated browser harness at [`tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs`](../../tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs#L1). It does not modify production code.

Each cycle:

1. Creates two local `RTCPeerConnection` instances.
2. Creates a `RTCDataChannel`.
3. Creates a canvas-backed video `MediaStreamTrack` through `canvas.captureStream(5)`.
4. Adds the track to the local peer connection.
5. Exchanges offer/answer and ICE candidates in memory.
6. Waits for the DataChannel and remote track path.
7. Sends JSON messages and waits for `bufferedAmount` to drain.
8. Closes cleanly for normal cycles.
9. Every 10th cycle closes the local peer abruptly first, then performs cleanup.
10. Stops tracks, closes channels and peer connections, removes listeners, forces GC, and records counters.

The active-resource registry and listener/timer instrumentation are installed inside the page at [`webrtc-connect-disconnect-leak-test.mjs`](../../tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs#L65). The cycle body starts at [`webrtc-connect-disconnect-leak-test.mjs`](../../tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs#L253), media and DataChannel setup at [`webrtc-connect-disconnect-leak-test.mjs`](../../tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs#L336), and cleanup at [`webrtc-connect-disconnect-leak-test.mjs`](../../tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs#L405).

## Commands

Smoke run:

```bash
node tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs --cycles=10 --messages=8 --payload-bytes=1024 --abrupt-every=5 --out=tmp/perf/results/webrtc-connect-disconnect-leak-smoke-2026-07-02.json
```

Main run:

```bash
node tmp/perf/scripts/webrtc-connect-disconnect-leak-test.mjs --cycles=200 --messages=32 --payload-bytes=2048 --abrupt-every=10 --out=tmp/perf/results/webrtc-connect-disconnect-leak-200cycles-2026-07-02.json
```

Note: Chromium launch required sandbox escalation, as in the prior browser measurement pass.

## Metrics

Collected per cycle:

- JS heap before/after forced GC
- Node harness RSS/heap before/after
- active peer connection count
- active media track count
- active data channel count
- active WebSocket count
- active timeout/interval count
- active listener count
- ICE candidates sent/added/queued/flushed
- pending signaling message count
- DataChannel `bufferedAmount` peak and post-drain value
- message send/receive count
- peer/channel/track final states

Not measured in this practical browser-only run:

- production WebSocket connections
- Rallar room/session/participant maps
- QueueBox inbox/outbox sizes
- `WebRtcGroupManager` retained peer state

Those require a full-stack Rallar session run, not just a local `RTCPeerConnection` pair.

## Results

| Metric | Result |
| --- | --- |
| Cycles | `200` total: `180` clean, `20` abrupt |
| Connection success | `200/200` DataChannel opens, `200/200` remote media paths observed |
| Message path | `6,400` sent, `6,400` received |
| Signaling path | `1,600` in-memory signaling messages |
| ICE candidates | `800` local-side candidate events, `400` remote-side candidate events |
| ICE queue | max queued candidates `0`, pending signaling after cleanup `0` |
| DataChannel buffer | max `bufferedAmount` `66,710`, post-drain `0` on measured cycles |
| Before cleanup | max `2` peer connections, `2` data channels, `2` active tracks, `11` listeners |
| After cleanup | max `0` peer connections, `0` data channels, `0` active tracks, `0` listeners, `0` timers, `0` WebSockets |
| Final counters | all tracked active resources `0` |
| Browser JS heap | `564,968` bytes before, `809,532` bytes after, delta `244,564` bytes |
| Heap trend | slope `~160 bytes/cycle`; first 20-cycle mean `787,637`; last 20-cycle mean `817,455` |
| Per-cycle heap delta | p50 `0` bytes, p95 `23,792` bytes |
| Node harness RSS | `+36,077,568` bytes; treated as harness/Playwright noise, not browser retained WebRTC proof |
| Cycle duration | mean `25.0 ms`, p95 `26.9 ms` |

Heap bucket check:

| Cycles | Mean JS heap after GC | After-cleanup max active resources |
| --- | ---: | --- |
| 1-20 | `787,637` | all `0` |
| 21-40 | `797,871` | all `0` |
| 41-60 | `801,538` | all `0` |
| 61-80 | `803,243` | all `0` |
| 81-100 | `804,331` | all `0` |
| 101-120 | `810,589` | all `0` |
| 121-140 | `815,427` | all `0` |
| 141-160 | `816,443` | all `0` |
| 161-180 | `817,545` | all `0` |
| 181-200 | `817,455` | all `0` |

## Leak Indicators

Measured indicators:

- **Peer connections:** no leak indicated. Active peer connection count returned to `0` after every cycle.
- **Data channels:** no leak indicated. Active DataChannel count returned to `0` after every cycle.
- **Media tracks:** no leak indicated in this raw-browser harness. Local and remote tracks ended and active track count returned to `0`.
- **Listeners:** no leak indicated. Active listener count returned to `0`.
- **Timers/intervals:** no leak indicated. Active timer and interval counters returned to `0`.
- **WebSockets:** not exercised; counter stayed `0`.
- **ICE queues:** no leak indicated in this scenario; no queued candidates remained.
- **Pending signaling:** no leak indicated; pending signaling returned to `0`.
- **DataChannel buffers:** no leak indicated; `bufferedAmount` drained to `0`.
- **Heap:** inconclusive but not leak-positive. JS heap rose during warmup and then flattened in the final 40 cycles. The p50 per-cycle heap delta was `0`.

## Cleanup Failures Found

No cleanup failure was proven by this 200-cycle browser harness.

The main limitation is that this test validates native browser WebRTC lifecycle behavior plus harness cleanup, not the full Rallar application lifecycle. It does not exercise:

- `WsRtcSignalingTransportUsingWsQBox`
- `JsonWebSocketClient`
- QueueBox inbox/outbox
- `WebRtcGroupManager` room/session ownership
- `WebRtcConnectionService` peer maps through real room join/leave
- real camera/microphone/screen capture devices

## Code Locations Responsible

Production cleanup paths to preserve and instrument in the full-stack version:

- `WebRtcConnectionService.removePeerIfPresent` clears peer establishment state, resets media, resets all DataChannels, resets the peer connection, and deletes `peerDtoByPeerId` at [`WebRtcConnectionService.ts`](../../packages/shared/services/WebRtcConnectionService.ts#L305).
- `QRtcPeerConnection.closePeerConnectionIfPresent` stops transceivers, nulls handlers, removes the ICE gathering listener, closes the peer connection, and clears reconnect/disconnect timers at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L189).
- `QRtcDataChannel.dc.onclose` resolves waiters, clears queued sends, and clears the native DataChannel reference at [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L456).
- `WebRtcRxStreamerService.removePeer` removes peer media/message/heartbeat callbacks and stops heartbeat state at [`WebRtcRxStreamerService.ts`](../../packages/shared/services/WebRtcRxStreamerService.ts#L167).
- `WebRtcGroupManager.delete` removes per-group callbacks and retained-group state before reconcile at [`WebRtcGroupManager.ts`](../../packages/shared/services/WebRtcGroupManager.ts#L94); `clear()` clears group and retained peer maps at [`WebRtcGroupManager.ts`](../../packages/shared/services/WebRtcGroupManager.ts#L118).

Static risk still requiring full-stack validation:

- `QRtcPeerConnection.setLocalMediaStream` replaces sender tracks by media kind without stopping old caller-owned tracks at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L759).
- `QRtcPeerConnection.stopLocalMedia` stops current stream tracks but does not clear `status.localStream` or `localSenders` until reset/replacement at [`QRtcPeerConnection.ts`](../../packages/shared/webrtc/QRtcPeerConnection.ts#L808). This is not proven as a leak here; it is an ownership edge to test with real Rallar media APIs.

## Suggested Minimal Fix

No production fix is justified by this browser-only measurement.

Minimal next step before any cleanup change:

1. Add temporary full-stack counters around `WebRtcConnectionService.removePeerIfPresent`, `WebRtcRxStreamerService.addPeer/removePeer`, `WebRtcGroupManager.delete/clear`, `QRtcDataChannel.readHealth`, and the signaling/WebSocket transport.
2. Run the memory-mode three-browser RTC matrix repeatedly with fake media enabled.
3. Only if counters remain nonzero after disconnect, apply the smallest cleanup fix at the responsible owner.

If the full-stack media run proves stopped tracks remain retained after user-intended local media release, the likely minimal code fix is to clarify or implement release semantics around `QRtcPeerConnection.stopLocalMedia`: either clear local stream/sender references after stop, or add an explicit dispose/release path distinct from mute/disable. Do not apply that based on this harness alone.

## Full-Stack Leak Test Proposal

Use the existing live RTC matrix entry point from `package.json`:

```bash
npm run test:rallar:full-stack:memory:live-rtc-3
```

Add temporary diagnostics only, under `tmp/perf/`:

- `WebRtcConnectionService`: `peerDtoByPeerId.size`, tentative peers, attempt-budget map size, establishment watchdog count.
- `WebRtcRxStreamerService`: peer map size, heartbeat map size, callback counts, local media stream/track IDs.
- `QRtcDataChannel`: `readHealth()` per lane, queued count, callback counts, buffered amount, counters.
- `QRtcPeerConnection`: diagnostics counters, pending ICE queue length, reconnect timer/disconnect timer flags.
- `WebRtcGroupManager`: group count, retained peer count, owner cache size.
- WebSocket/QueueBox: open socket count, inbox/outbox queue depth, pending dispatch tasks.

Pass criteria:

- after each leave/disconnect cycle and forced GC, peer/channel/track/socket/timer/listener counters return to baseline
- no monotonic heap/RSS growth over at least 50 full app cycles
- abrupt browser close/reload does not leave server-side session/room state beyond the expected TTL

## Conclusion

The practical browser leak test did not prove retained WebRTC resources. It exercised many native-cycle resources across `200` cycles, including abrupt close paths, and every tracked active resource returned to zero. The remaining leak risk is in the app-level lifecycle that this harness intentionally did not start: room/session maps, QueueBox/WebSocket signaling, and Rallar media ownership semantics.
