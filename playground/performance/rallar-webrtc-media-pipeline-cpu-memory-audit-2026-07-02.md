# Rallar WebRTC Media Pipeline CPU and Memory Audit

Date: 2026-07-02  
Mode: static analysis only  
Scope: WebRTC camera/microphone/screen capture, MediaStream/MediaStreamTrack ownership, track replacement, sender parameters, remote stream callbacks, canvas/screen-share interaction, and stats diagnostics.  
Non-goals: no code changes, no benchmarks, no runtime profiling.

Related docs:
- `playground/rallar-webrtc-performance-map-2026-07-02.md`
- `playground/rallar-webrtc-static-performance-audit-2026-07-02.md`
- `playground/rallar-webrtc-memory-retained-resource-audit-2026-07-02.md`
- `playground/rallar-webrtc-signaling-negotiation-audit-2026-07-02.md`

## Executive Summary

Top WebRTC media CPU/memory risks:

1. **Track replacement does not stop or detach old tracks.** `QRtcPeerConnection.setLocalMediaStream` uses `replaceTrack` by media kind and does not stop the previous track; direct callers of `media.setLocalStream` must own cleanup. Confidence: Strong suspicion.
2. **Stopping local media stops current tracks but leaves stream/sender references in service and peer state.** This can retain stopped `MediaStream`/`MediaStreamTrack` objects until a later stream attach or peer reset. Confidence: Proven from code.
3. **Camera + screen or multiple same-kind tracks are collapsed through one sender per kind.** The attachment loop can call `replaceTrack` repeatedly on the same sender, with only the last track of each kind effectively attached. Confidence: Proven from code.
4. **Source `setEnabled` reattaches media to every peer.** A toggle on a media source can trigger stream recomposition and per-peer `replaceTrack` work instead of only changing `track.enabled`. Confidence: Proven from code.
5. **Screen share can amplify main-thread render-loop costs.** The game canvas render loop writes diagnostics every frame and uses `preserveDrawingBuffer`; if the user shares the app/tab, these costs become part of the captured media workload. Confidence: Strong suspicion.

## Media Flow Map

### Source-controller capture path

1. `BrowserRallarFacade.media` exposes microphone, camera, screen, direct stream, toggles, policy, and remote-stream subscription through `createRallarMediaFacade` in `packages/shared-web/browser/rallar.ts:4030` and `packages/shared-web/browser/rallar-media-facade.ts:27`.
2. `createMediaSourceController` calls `startMediaSource` for `microphone`, `camera`, or `screen` in `packages/shared-web/browser/rallar.ts:5408`.
3. `startMediaSource` stops any existing source of the same kind, captures or accepts a provided stream, stores a `RallarMediaSourceRuntime` in `localMediaSources`, registers track-ended callbacks, and optionally attaches it in `packages/shared-web/browser/rallar.ts:5427`.
4. `captureMediaSource` calls:
   - `navigator.mediaDevices.getUserMedia({ audio, video: false })` for microphone in `packages/shared-web/browser/rallar.ts:5477`.
   - `navigator.mediaDevices.getUserMedia({ audio: false, video })` for camera in `packages/shared-web/browser/rallar.ts:5485`.
   - `navigator.mediaDevices.getDisplayMedia({ audio, video })` for screen in `packages/shared-web/browser/rallar.ts:5492`.
5. `attachLocalMediaSources` filters open runtimes and live tracks, composes a stream, sends it to `rtcRxStreamer.setLocalMediaStream`, then updates audio/video enabled state in `packages/shared-web/browser/rallar.ts:5613`.
6. `toComposedMediaStream` reuses a single source stream when possible; otherwise it allocates `new MediaStream([...tracks])` in `packages/shared-web/browser/rallar.ts:9391`.

### Direct stream path

1. `media.setLocalStream(stream)` bypasses `localMediaSources` and directly calls `rtcRxStreamer.setLocalMediaStream(stream)` in `packages/shared-web/browser/rallar.ts:4034`.
2. The black-box media console creates a stream with `navigator.mediaDevices.getUserMedia({ audio, video })`, calls `facade.media.setLocalStream(stream)`, and stores only the stream ID in UI state in `apps/rallar-black-box/src/App.tsx:23181`.
3. Calls can also attach media through `RallarCallHandle.setLocalStream`, which delegates to `this.media.setLocalStream(stream)` in `packages/shared-web/browser/rallar.ts:6014`.

### Peer attachment path

1. `middleware.ts` registers `rtcRxStreamer.addPeer(peerDto)` and `removePeer(peerDto)` on WebRTC peer lifecycle callbacks in `packages/shared-web/browser/middleware.ts:247`.
2. `WebRtcRxStreamerService.addPeer` stores the peer, attaches data-channel callbacks, subscribes to remote media, applies current media policy, and if `status.localMediaStream` exists calls `peerDto.media.setParameters(...)` in `packages/shared/services/WebRtcRxStreamerService.ts:105`.
3. `WebRtcRxStreamerService.setLocalMediaStream` stores the stream and then awaits `peer.media.setLocalMediaStream(stream)` for each known peer in `packages/shared/services/WebRtcRxStreamerService.ts:414`.
4. `QRtcMediaChannel.setLocalMediaStream` delegates to `QRtcPeerConnection.setLocalMediaStream` and reapplies toggles in `packages/shared/webrtc/QRtcMediaChannel.ts:178`.
5. `QRtcPeerConnection.setLocalMediaStream` sets `status.localStream`, loops `stream.getTracks()`, maps senders by `track.kind`, and uses either `sender.replaceTrack(track)` or `pc.addTrack(track, stream)` in `packages/shared/webrtc/QRtcPeerConnection.ts:654`.

### Remote stream path

1. `QRtcPeerConnection.ontrack` stores the remote stream by `stream.id`, then invokes remote-stream and track callbacks in `packages/shared/webrtc/QRtcPeerConnection.ts:296`.
2. `QRtcMediaChannel.subscribe` caches remote streams and forwards callbacks in `packages/shared/webrtc/QRtcMediaChannel.ts:112`.
3. `WebRtcRxStreamerService.addPeer` forwards remote streams to registered service callbacks in `packages/shared/services/WebRtcRxStreamerService.ts:143`.
4. `BrowserRallarFacade.registerRemoteStreamCallback` fans out each remote stream event to facade listeners with `Promise.all([...this.remoteStreamListeners].map(...))` in `packages/shared-web/browser/rallar.ts:8437`.

### Stats diagnostics path

1. `rallar.rtc.diagnostics()` calls `toRtcDiagnostics`, which maps selected peers through `toRtcPeerDiagnostics` in `packages/shared-web/browser/rallar.ts:6247`.
2. `toRtcPeerDiagnostics` calls `readSelectedCandidatePairDiagnostics(peer?.connection.status.pc)` in `packages/shared-web/browser/rallar.ts:6304`.
3. `readSelectedCandidatePairDiagnostics` calls `pc.getStats()`, converts the report to an array, builds a `Map` by ID, and searches for the selected candidate pair in `packages/shared-web/browser/rallar.ts:9213`.
4. `useRallarArena.refreshDiagnostics` only includes `rallar.rtc.diagnostics(...)` when `includeRtcStats` is true in `apps/ar-eye-hunter-v1/src/game/useRallarArena.ts:1809`.

## CPU Hotspot Hypotheses

| Severity | Confidence | Location | Why it can cost CPU | WebRTC media impact | Validation | Suggested fix after measurement |
|---|---|---|---|---|---|---|
| High | Proven from code | `BrowserRallarFacade.toMediaSourceHandle().setEnabled`, `attachLocalMediaSources`, `WebRtcRxStreamerService.setLocalMediaStream`, `QRtcPeerConnection.setLocalMediaStream` (`packages/shared-web/browser/rallar.ts:5518`, `:5613`; `packages/shared/services/WebRtcRxStreamerService.ts:414`; `packages/shared/webrtc/QRtcPeerConnection.ts:654`) | Source-level enable/disable toggles set `track.enabled` and then reattach local media, which loops all peers and may call `replaceTrack` for each track. | Audio/video mute toggles can become O(peers x tracks), doing sender work that is not needed for a simple enabled flag change. | Count `replaceTrack` calls during microphone/camera/screen enable toggles with 1, 5, and 10 peers. | Avoid reattaching on simple enabled toggles unless membership/track set changed. |
| High | Proven from code | `QRtcPeerConnection.setLocalMediaStream` (`packages/shared/webrtc/QRtcPeerConnection.ts:663`) | Senders are keyed only by `track.kind`; if a composed stream contains camera video and screen video, the loop calls `replaceTrack` multiple times on the same video sender. | Multiple same-kind tracks create redundant work and only the last same-kind track is attached. Screen + camera cannot both be sent through this path as separate video tracks. | Attach camera and screen together; record stream track order, `replaceTrack` calls, and outbound sender track IDs. | Choose one video source explicitly, or model separate lanes/transceivers per source before supporting simultaneous camera+screen. |
| Medium | Needs runtime measurement | `QRtcPeerConnection.applyMediaPolicy`, `applyCodecPreferences`, `applySenderEncodingParams` (`packages/shared/webrtc/QRtcPeerConnection.ts:724`, `:784`, `:819`) | Applying policy can add transceivers, call `RTCRtpSender.getCapabilities`, filter/sort codecs, scan senders/transceivers, and call `sender.setParameters`. It is also invoked after media attach when `status.mediaPolicy` exists. | Frequent policy updates or repeated source reattach can create unnecessary sender-parameter work and may trigger negotiation through transceiver additions. | Count policy applications, `setParameters` latency, transceiver count, and renegotiations after policy changes. | Debounce policy updates and only apply changed fields after measurement. |
| Medium | Strong suspicion | `captureMediaSource`, `applySenderEncodingParams` (`packages/shared-web/browser/rallar.ts:5477`; `packages/shared/webrtc/QRtcPeerConnection.ts:838`) | Capture defaults use `audio: true`, `video: true`, or screen `video: true` unless callers supply constraints. Sender bitrate/framerate/scale are optional and only applied via media policy. | Camera and screen capture may start at high browser-default resolution/fps, increasing encoder CPU, memory bandwidth, and network load. | Record actual track settings from `track.getSettings()`, outbound frame rate/resolution, encoder CPU, and bitrate before/after policy. | Add measured defaults or recommendations for media constraints; do not change defaults blindly. |
| Medium | Needs runtime measurement | `toRtcDiagnostics`, `readSelectedCandidatePairDiagnostics`, `toStatsArray` (`packages/shared-web/browser/rallar.ts:6247`, `:9213`, `:9259`) | Diagnostics call `getStats()` per peer and allocate an array and map from the whole stats report. | Frequent diagnostics across many peers can create main-thread allocation and CPU pressure, even though the core path is on demand. | Count diagnostics calls per minute, peers per call, report size, `getStats` duration, allocation rate, and UI long tasks. | Cache or sample stats only if runtime measurements show diagnostic overhead. |
| Medium | Strong suspicion | `BabylonArena` screen-share path (`apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx:654`, `:853`, `:3674`) | The render loop calls `scene.render()` and `writeArenaDiagnostics()` every frame; engine options include `preserveDrawingBuffer: true`; diagnostics write many `canvas.dataset` strings and compute filtered counts. | If a user screen-shares the game tab/canvas, this main-thread/GPU work contributes directly to captured-screen latency and CPU. | Profile while screen sharing the game tab; track frame time, long tasks, canvas capture frame rate, and CPU/GPU process usage. | Gate per-frame diagnostics or lower render/capture load only after measuring screen-share sessions. |

## Allocation Hotspot Hypotheses

| Severity | Confidence | Location | Allocation pattern | Impact | Validation |
|---|---|---|---|---|---|
| High | Strong suspicion | Direct `media.setLocalStream`, `QRtcPeerConnection.setLocalMediaStream`, black-box media console (`packages/shared-web/browser/rallar.ts:4034`; `packages/shared/webrtc/QRtcPeerConnection.ts:654`; `apps/rallar-black-box/src/App.tsx:23181`) | Repeated direct stream attach can allocate new browser capture streams and replace sender tracks without stopping the previous caller-created stream. | Previous camera/mic tracks may keep capture resources alive if the caller does not stop them. | Repeatedly click attach local stream; check camera/mic indicator, `MediaStreamTrack.readyState`, heap snapshots, and active capture device count. |
| Medium | Proven from code | `WebRtcRxStreamerService.stopLocalMedia`, `QRtcPeerConnection.stopLocalMedia` (`packages/shared/services/WebRtcRxStreamerService.ts:444`; `packages/shared/webrtc/QRtcPeerConnection.ts:703`) | Stop paths stop tracks but do not clear `status.localMediaStream`, `QRtcPeerConnection.status.localStream`, or `localSenders`. | Stopped stream/track/sender references can be retained until the next attach or peer reset. | Inspect object retention after `media.stopLocal('all')`; verify whether stopped track objects remain reachable through service/peer state. |
| Medium | Proven from code | `toComposedMediaStream` (`packages/shared-web/browser/rallar.ts:9391`) | Multi-source attach allocates `new MediaStream([...tracks])`. | Low per operation, but repeated attach/toggle can allocate composed streams and arrays. | Count composed stream allocations during toggles and source start/stop churn. |
| Medium | Needs runtime measurement | `toRtcStatus`, `toRtcDiagnostics`, `toStatsArray` (`packages/shared-web/browser/rallar.ts:6173`, `:6247`, `:9259`) | Status/diagnostics allocate sets, arrays, lane objects, stats arrays, and maps. | Harmless on user action; costly if polled or subscribed heavily. | Measure allocation rate with RTC status subscriptions and diagnostics refresh. |
| Low | Proven from code | `registerRemoteStreamCallback` (`packages/shared-web/browser/rallar.ts:8437`) | Each remote stream event clones listeners with `[...this.remoteStreamListeners]` and builds a `Promise.all` array. | Remote stream events are infrequent compared with frames, so this is likely small. | Count remote stream events and listener fanout size. |

## Main-Thread Blocking Risks

| Severity | Confidence | Location | Risk | Validation |
|---|---|---|---|---|
| Medium | Strong suspicion | `BabylonArena.engine.runRenderLoop` and `writeArenaDiagnostics` (`apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx:853`, `:3674`) | Screen sharing a rendering-heavy tab can run game simulation/render plus capture/encoding; dataset writes and filtered counts every frame can add main-thread work. | Chrome Performance profile during screen share; flag long tasks over 50 ms and frame gaps. |
| Medium | Needs runtime measurement | `readSelectedCandidatePairDiagnostics` (`packages/shared-web/browser/rallar.ts:9213`) | `getStats()`, report materialization, map build, and candidate extraction happen on the main thread in the browser facade. | Measure `getStats` wall time and allocation size at peer counts 1/5/10. |
| Low | Proven from code | `QRtcPeerConnection.setLocalMediaStream` (`packages/shared/webrtc/QRtcPeerConnection.ts:654`) | Track attach/replace work is sequential per track and per peer through `WebRtcRxStreamerService.setLocalMediaStream`. | Measure attach latency as peer count and track count increase. |

## Track, Worker, and Frame Cleanup Risks

| Severity | Confidence | Location | Risk | Validation |
|---|---|---|---|---|
| High | Strong suspicion | `QRtcPeerConnection.setLocalMediaStream`; direct stream attach (`packages/shared/webrtc/QRtcPeerConnection.ts:668`; `packages/shared-web/browser/rallar.ts:4034`) | `replaceTrack` does not stop the old track. This is correct for caller-owned streams, but the API does not make ownership obvious and some UI code creates streams before direct attach. | Reattach direct local streams repeatedly and assert all old tracks reach `readyState === 'ended'` only when expected. |
| Medium | Proven from code | `BrowserRallarFacade.stopMediaSource`, `stopLocalMediaSourcesForKind` (`packages/shared-web/browser/rallar.ts:5560`, `:5582`) | Source-controller-owned streams are cleaned up: source entries are deleted and their tracks are stopped. | Validate normal source start/stop and screen-share ended events. |
| Medium | Proven from code | `registerMediaSourceEndedCallbacks` (`packages/shared-web/browser/rallar.ts:5637`) | Track-ended listeners are registered with `{ once: true }` and guard against stale runtimes before detaching. | Confirm ended callback runs once for screen-share stop and does not detach a replacement source. |
| Medium | Proven from code | `QRtcPeerConnection.closePeerConnectionIfPresent` (`packages/shared/webrtc/QRtcPeerConnection.ts:133`) | Peer close stops transceivers, removes handlers/listeners, closes the PC, and clears timers, but intentionally does not stop facade-owned capture tracks. | Verify peer disconnect does not stop active local camera/mic unless the user stops local media. |
| Low | Proven from code | Scoped media API search; media path entry points (`packages/shared-web/browser/rallar.ts:5465`; `packages/shared/webrtc/QRtcPeerConnection.ts:654`) | No `MediaStreamTrackProcessor`, `VideoFrame`, `MediaRecorder`, insertable streams, Worker, or WASM media transform path was found in the scoped WebRTC media stack. | Re-run scoped search if media processing is added later. |

## Frame Copy and Encoding Findings

- **No explicit per-frame JS frame copy was found in the WebRTC media stack.** Media is passed as native `MediaStreamTrack` objects from capture to `RTCRtpSender` through `addTrack`/`replaceTrack` (`packages/shared-web/browser/rallar.ts:5477`; `packages/shared/webrtc/QRtcPeerConnection.ts:654`). Confidence: Proven from code.
- **No canvas-to-WebRTC `captureStream` path was found.** Screen sharing uses browser `getDisplayMedia` rather than explicit `canvas.captureStream` in `captureMediaSource` (`packages/shared-web/browser/rallar.ts:5498`). Confidence: Proven from code.
- **No recording/transcription pipeline was found in the scoped media stack.** The inspected media entry points capture native streams and attach tracks through `captureMediaSource` and `QRtcPeerConnection.setLocalMediaStream`, with no recorder/transcription step in between (`packages/shared-web/browser/rallar.ts:5465`; `packages/shared/webrtc/QRtcPeerConnection.ts:654`). Confidence: Proven from code.
- **No insertable-stream encryption/decryption transform was found.** The inspected media path attaches normal browser sender tracks through `QRtcPeerConnection.setLocalMediaStream` and sender parameters through `applySenderEncodingParams`, not insertable transforms (`packages/shared/webrtc/QRtcPeerConnection.ts:654`, `:819`). Confidence: Proven from code.
- **Encoding control is limited to sender parameters.** `applySenderEncodingParams` edits the first encoding only, setting bitrate/framerate/scale/degradation preference when provided (`packages/shared/webrtc/QRtcPeerConnection.ts:838`). Confidence: Proven from code.

## Suggested Profiling Plan

Do not optimize yet. Validate the hypotheses with focused browser profiling:

### CPU Profile

- Scenario A: one peer, microphone + camera, then toggle source enabled 20 times.
- Scenario B: five peers, camera source replacement and `media.setLocalStream` replacement.
- Scenario C: screen-share the AR Eye Hunter tab while the Babylon scene is active.
- Capture Chrome Performance profiles with main-thread call stacks, long tasks, WebRTC internals if available, and browser process CPU.
- Confirm or refute: `replaceTrack`, `setParameters`, render-loop diagnostics, and stats conversion are visible in hot stacks.

### Allocation Profile

- Use Chrome allocation sampling during repeated source start/stop, source `setEnabled`, and direct stream reattach.
- Track object counts for `MediaStream`, `MediaStreamTrack`, arrays/maps from status/diagnostics, and retained stopped tracks.
- Confirm or refute: stopped tracks remain reachable through `WebRtcRxStreamerService.status.localMediaStream`, `QRtcPeerConnection.status.localStream`, or `localSenders`.

### Frame-Rate and Latency Metrics

- Record actual `track.getSettings()` for width/height/frameRate after capture.
- Record outbound WebRTC stats for frames encoded/sent, frame dimensions, jitter, RTT, and encode time where browser stats expose them.
- During screen share, compare game FPS, capture FPS, and peer receive FPS.

### Memory Growth Test

- Repeat 50 cycles:
  1. `media.camera.start({ attach: true })`
  2. `media.camera.stop()`
  3. direct `media.setLocalStream(await getUserMedia(...))`
  4. `media.stopLocal('all')`
- Track heap snapshots, active media device indicators, stopped-track retainers, and peer sender/transceiver counts.

### Long-Call Detection

- Wrap temporary diagnostics around:
  - `BrowserRallarFacade.attachLocalMediaSources`
  - `WebRtcRxStreamerService.setLocalMediaStream`
  - `QRtcPeerConnection.setLocalMediaStream`
  - `QRtcPeerConnection.applySenderEncodingParams`
  - `readSelectedCandidatePairDiagnostics`
- Log calls over 50 ms with peer count, track count, stream ID, track IDs, and policy fields.

## Top Measurement Tasks

1. **Track ownership/replacement reproduction.** Reattach direct local streams repeatedly and prove whether previous tracks are stopped or retained.
2. **Toggle attach-cost measurement.** Measure source `setEnabled` with multiple peers and count `replaceTrack` calls.
3. **Screen-share profile.** Profile AR Eye Hunter while sharing the tab and capture frame rate, long tasks, and render-loop costs.
