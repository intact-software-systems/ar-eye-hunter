# Rallar RTC Topology And Connection Implementation Progress

Date: 2026-06-04

## Goal

Implement the main vertical slice from
`plans/rallar-rtc-topology-tree-mesh-plan.md` first, then implement the first
room-transport slice from
`plans/rallar-rtc-connection-product-and-implementation-plan.md`.

## Audit Checklist

- [x] Read root Rallar docs relevant to RTC, realtime, media, server runtime,
  environment, troubleshooting, API usage, and AI implementation guidance.
- [x] Inspected root package scripts and workspace layout.
- [x] Inspected shared-graph tree and mesh services, graph primitives, dynamic
  mesh insertion/removal, and current shared-graph tests.
- [x] Confirmed current docs still expose manual RTC readiness checks through
  `waitForRoomLane(...)`, `readyPeerIds(...)`, and explicit fallback handling.
- [x] Initial audit confirmed tree and mesh update services existed, but
  standalone create/rebuild APIs and browser overlay next-hop behavior still
  needed implementation.
- [x] Confirmed current implementation now includes shared-graph create
  services, server-authoritative `overlay.topology`, scoped overlay keys,
  browser next-hop reconciliation, and RTT-triggered topology updates.

## Milestones

### Topology Plan

- [x] Add shared-graph create/rebuild APIs and validation helpers for
  member-only, degree-limited tree and mesh graphs.
- [x] Fix `graphs-mesh-service.ts` reconfiguration so it evaluates the updated
  group mesh, passes that mesh into reconfiguration, honors remove behavior,
  and reports enough failure metadata for Rallar fallback/rebuild.
- [x] Add a server-side Rallar topology service with star/tree/mesh size
  selection and scoped per-group state.
- [x] Add compact `overlay.topology` snapshots and publish only changed
  next-hop maps.
- [x] Update browser overlay application and `WebRtcGroupManager` so desired
  RTC peers follow overlay next hops with star fallback.
- [x] Add integration coverage for group growth, shrinkage, and no full-mesh
  connection growth. Coverage now proves topology tier selection, server topic
  publish, browser topology application, scoped overlay lookup, and desired RTC
  peers following overlay next hops.
- [x] Add RTT-triggered rebuild coverage.
- [x] Debounce and coalesce RTT-triggered topology rebuilds per scoped overlay
  so heartbeat bursts publish at most one changed overlay after the debounce
  window.

### Connection/Product First Slice

- [x] Add `RallarRoomTransportStatus`.
- [x] Add `rallar.rtc.openRoom(...)`.
- [x] Add `rallar.rtc.waitForRoom(...)`.
- [x] Make app-facing RTC send results honest for no-peer and no-route cases.
- [x] Add strategy-aware typed channel sends while preserving existing
  `sendWs` and `sendRtc`.

### Connection/Product Targeted Calls Slice

- [x] Add `rallar.channels.targeted(...)` for one-to-one and one-to-many
  direct RTC data-channel sends with per-peer send results.
- [x] Add `rallar.channels.room(...)` for live room-targeted data channels that
  re-resolve room membership on each send.
- [x] Add `rallar.calls.start(...)` with explicit participant selection,
  data-lane opening, per-participant status, call-local targeted channels, and
  `end(...)`.
- [x] Keep media opt-in: call start can attach an application-provided local
  stream and toggle audio/video, but it does not request camera or microphone
  permissions.
- [x] Keep media-only calls from opening data lanes unless data lanes are
  requested.

### Connection/Product Media Source Slice

- [x] Add explicit `rallar.media.microphone.start(...)`,
  `rallar.media.camera.start(...)`, and `rallar.media.screen.start(...)`
  source handles.
- [x] Source handles expose status, attach, enable/disable, and stop lifecycle.
- [x] Compose separately started local sources before attaching to the existing
  single-stream RTC media layer.
- [x] Add call-local source controls under `call.sources`.
- [x] Keep permission/capture explicit: no room join, room wait, or call start
  requests microphone, camera, or screen capture unless the app calls a source
  start API or passes a stream.

### Connection/Product Call Signaling Slice

- [x] Add lightweight WS-backed call signaling over `app.rallar.calls`.
- [x] Add `rallar.calls.invite(...)` for one-to-one and one-to-many unicast
  call invitations.
- [x] Add `rallar.calls.onInvite(...)` with incoming invite helpers for
  `accept(...)` and `decline(...)`.
- [x] Add `rallar.calls.onSignal(...)` for accepted, declined, cancelled, and
  invite signal observation.
- [x] Keep this as client-side signaling without a persistent server-side call
  registry for this slice.

### Connection/Product RTC Diagnostics And Recovery Slice

- [x] Add `rallar.rtc.diagnostics(...)` with per-peer connection state, lane
  health, selected ICE candidate-pair stats, relay detection, RTT, bitrate, and
  byte counters when browser stats are available.
- [x] Extend peer connection status with ICE gathering state, local/remote
  description presence, and trickle-ICE capability.
- [x] Add `rallar.rtc.restartIce(peerId)` for direct ICE restart when supported
  by the active peer connection.
- [x] Add `rallar.rtc.reconnectPeer(peerId, ...)` for explicit peer teardown and
  reconnect, optionally waiting for a requested lane.
- [x] Keep diagnostics honest when not connected, when no peer exists, or when
  browser stats/restart APIs are unavailable.

### Topology RTT Debounce Slice

- [x] Add configurable RTT topology debounce to
  `RallarRtcTopologyService` with deterministic queue and flush APIs.
- [x] Wire server RTT ingestion to mark affected cached groups dirty, schedule
  due overlay recomputation, and publish only changed next-hop maps.
- [x] Keep group snapshot and membership churn updates immediate.
- [x] Keep the process-global graph cache recompute opportunistic so partial RTT
  sets do not prevent topology scheduling.

### Coalesced APP_OUTBOX Topology Ownership Slice

- [x] Add an atomic `enqueueOrUpdate(...)` queuebox primitive so callers can
  build replacement work from the existing active row.
- [x] Add `CoalescedAppOutboxWorkService` for fixed-key APP_OUTBOX work that
  coalesces pending rows, reopens completed/failed rows, preserves `RESERVED`
  rows while merging newer payload generations, and detects stale reserved
  work.
- [x] Preserve newer coalesced payloads when in-memory and IndexedDB queuebox
  releases an older reserved entry.
- [x] Add opt-in RTC topology APP_OUTBOX ownership for RTT-triggered recomputes
  through `initRallarSystemWsTopics(..., { rtcTopologyAppOutbox })`, with local
  timer debounce remaining as fallback.
- [x] Route group-snapshot-triggered topology publication through the same
  coalesced APP_OUTBOX ownership path when `rtcTopologyAppOutbox` is configured,
  while keeping state-sync group snapshot broadcasts immediate.
- [x] Allow the APP_OUTBOX topology worker to resolve group snapshots through an
  injected async resolver, so production can use
  `GroupStateSnapshotReadThroughCache.findOrLoadByRef(...)` or another durable
  group source.
- [x] Add opt-in runtime-state continuity for RTC topology recomputes through
  `rtcTopologyRuntimeState`, storing overlay snapshots in
  `rtc-topology:snapshots` and latest RTT inputs in `rtc-rtt:latest`.

## Verified

- `npx vitest run packages/tests/shared-graph/group-topology-validation.test.ts packages/tests/shared-graph/group-topology-create-services.test.ts packages/tests/shared-graph/graphs-tree-service.test.ts packages/tests/shared-graph/graphs-mesh-service.test.ts`
  passed: 4 files, 12 tests.
- `npm --workspace @ar-eye-hunter/shared-graph run build` passed.
- `npx vitest run packages/tests/shared-graph` passed: 24 files, 63 tests.
- `npx vitest run packages/tests/shared-graph packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/repository-modules.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared-web/data-caches.test.ts`
  passed: 31 files, 114 tests.
- `npm --workspace @ar-eye-hunter/shared-server run build` passed.
- `npm --workspace @ar-eye-hunter/shared-web run build` passed.
- `npx tsc -p packages/shared/tsconfig.json --noEmit` passed.
- `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts`
  passed: 1 file, 95 tests.
- `npx vitest run packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-web/rallar-message-selectors.test.ts`
  passed: 2 files, 98 tests.
- `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
  passed: 2 files, 10 tests.
- `npx vitest run packages/tests/shared-server/coalesced-app-outbox-work-service.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
  passed: 3 files, 15 tests.
- `npx vitest run packages/tests/shared-server/coalesced-app-outbox-work-service.test.ts packages/tests/shared/in-memory-queuebox.test.ts packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared/psql-queuebox.test.ts`
  passed: 4 files, 29 tests.
- `npx vitest run packages/tests/shared-server/coalesced-app-outbox-work-service.test.ts packages/tests/shared/in-memory-queuebox.test.ts packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared/psql-queuebox.test.ts packages/tests/shared-graph packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/repository-modules.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-web/rallar-message-selectors.test.ts`
  passed: 37 files, 250 tests.
- `npm --workspace @ar-eye-hunter/shared-server run build` passed after the
  coalesced APP_OUTBOX topology slice.
- `npx tsc -p packages/shared/tsconfig.json --noEmit` passed after the
  queuebox contract extension.
- `npm --workspace @ar-eye-hunter/shared-web run build` passed after the
  queuebox contract extension.
- `npx vitest run packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
  passed: 3 files, 17 tests.
- `npm --workspace @ar-eye-hunter/shared-server run build` passed after the
  runtime-state topology/RTT continuity slice.
- `npx tsc -p packages/shared/tsconfig.json --noEmit` passed after the
  runtime-state topology/RTT continuity slice.
- `npx vitest run packages/tests/shared-graph packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/repository-modules.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared-web/rallar-message-selectors.test.ts`
  passed: 33 files, 219 tests.
- `npm run build` passed across workspaces, including the Vite app builds. Vite
  reported chunk-size warnings only.

## Broad Suite Notes

- `npm test` did not pass as a full-suite command in the sandbox. The failures
  were outside the RTC topology/connection slice:
  `postgres-presence-expiry-concurrency.test.ts` requires `Deno` under a Node
  Vitest run, two shared-test files import `https:` modules unsupported by the
  default Node ESM loader, `shared/tictactoe.test.ts` imports a missing
  `@shared/tictactoe/types.ts` package path, and shared-test HTTP tests hit
  sandbox `listen EPERM` on `127.0.0.1`.
- Retrying the full `npm test` command outside the sandbox was rejected by the
  approvals reviewer as too broad. Focused relevant tests passed as listed
  above.

## Remaining Limitations

- The public browser facade now has room RTC status/open/wait, typed channel
  strategy fallback, targeted channels, basic call handles, and explicit
  microphone/camera/screen source handles.
- Call invite/accept/decline signaling and RTC diagnostics/recovery now exist,
  but a persistent server-side call registry and missed-invite recovery are
  still future work.
- Topology recomputes from group snapshots and RTT updates now share the same
  opt-in APP_OUTBOX ownership path, with optional runtime-state storage for
  previous topology snapshots and latest RTT inputs across workers.
- Large audio/video rooms still require a future SFU/relay boundary; the new
  tree/mesh topology is for RTC data overlay routing.
