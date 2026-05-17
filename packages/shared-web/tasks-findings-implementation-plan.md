# TASKS Findings Implementation Plan

Date: 2026-05-16

Source: `tasks-findings.md`

This plan is intentionally evidence-first. Suspected RTC, storage, and queueing problems should be proven with tests, diagnostics, or real-server reproduction before behavior is changed. The exception is obvious missing public API surface, such as wait/status APIs, where the absence itself is already proven by the current facade.

## Principles

- Prove before fixing. Each suspected bug should first produce a failing unit/integration test, a deterministic diagnostic, or a reproducible real-server scenario.
- Prefer smallest proof first, then confirm with real browser/server scenarios for RTC and WebSocket behavior.
- Keep API additions read-only or additive first where possible. Do not change routing/reconnect semantics until current behavior is captured.
- Real scenario testing with a real server is a priority, especially for RTC setup, reconnect, signaling, data-channel reuse, and message delivery.
- Preserve compatibility until richer APIs are proven useful. Add new methods such as `sendWithResult()` before changing existing `send()` return contracts.
- Every iteration should leave behind tests or diagnostics that become regression coverage.

## Test Strategy

Use layered tests, but do not stop at unit tests for RTC lifecycle work.

1. Unit tests
   - Fast proof for AL policy, IndexedDB retention helpers, send result mapping, and wrapper state transitions.
   - Existing locations include `packages/tests/shared`, `packages/tests/shared-web`, and `packages/tests/rallar-black-box`.

2. Browser-like integration tests
   - Use fake IndexedDB and browser test setup for storage and facade behavior.
   - Use existing `packages/tests/shared-web` coverage style for `Rallar` facade additions.

3. Playwright full-stack tests
   - Use existing `apps/rallar-black-box` and `tests/playwright/rallar-black-box` infrastructure.
   - Prioritize two-agent tests for RTC because single-agent tests cannot prove peer setup and reconnect behavior.

4. Real-server scenario tests
   - Run against `apps/api-v1` plus the black-box app/control server when validating RTC and WS behavior.
   - Useful scripts already exist:

```sh
npm run dev:rallar-black-box:servers
npm run dev:rallar-black-box:all
npm run test:e2e:rallar-black-box:full-stack:real
npm run test:e2e:rallar-black-box:full-stack:real:manual
npm run test:e2e:rallar-black-box:full-stack:real:control
```

Real-server test runs should record enough evidence to debug failures: peer IDs, room ID, message IDs, route decisions, connection states, lane states, reconnect attempts, and skipped enqueue outcomes.

## Iteration Status

| Iteration | Status | Evidence |
| --- | --- | --- |
| 0: Baseline evidence and reproduction harness | Completed | `packages/shared-web/tasks-findings-iteration-0-baseline.md`; targeted unit/typecheck runs; full-stack real suite; two-agent real `realtime` and `messages.rtc` smoke. |
| 1: Read-only diagnostics and status surface | Implemented and locally verified | Added read-only RTC/WS diagnostics APIs and focused tests. Real two-agent smoke still passes. Playwright status snapshot artifacts are still a follow-up. |
| 2: IndexedDB growth and session isolation proof | Browser IndexedDB eviction implemented | `packages/tests/shared-web/browser-al-runtime-stores.test.ts`; `packages/tests/shared-web/browser-queuebox-expiry-eviction.test.ts`; existing generic IndexedDB AL runtime tests still pass. Confirms per-prefix lazy eviction and storage bloat risk, with no cross-session read reproduced for the tested browser AL outbound state path. Added explicit cleanup helpers and browser middleware expiry eviction loops. |
| 3: `enqueueOutboxIfAbsent()` quiet outcomes | Result statuses implemented and locally verified | `ALOutboundMessageRuntime`, RTC overlay/Rx streamer, WS client/server queue-box services, and `Rallar.messages.rtc/ws.send()` now return structured enqueue/send outcomes. |
| 4: Data-channel reuse and closed-channel behavior | Unit and real-server reload proof implemented | Focused `QRtcDataChannel` tests proved stale closed channel references blocked receiver-side replacement waits. `QRtcDataChannel` now clears terminal channel references so reconnect waits can observe replacement channels. `WebRtcConnectionService` tests document lane-ready state separately from active/connected peer state. Real browser-Rallar reload scenarios now pass for `realtime` and `messages.rtc` with attached RTC/WS status snapshots. |

## Iteration 0: Baseline Evidence And Reproduction Harness

Goal: make current behavior measurable before changing it.

Status: completed on 2026-05-16.

Artifacts:

- `packages/shared-web/tasks-findings-iteration-0-baseline.md`
- `npm --workspace @ar-eye-hunter/shared-web run typecheck`
- `npm run test -- packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/webrtc-connection-service.test.ts`
- `npm run test:e2e:rallar-black-box:full-stack:real`
- Two-agent browser-rallar smoke with `VITE_RALLAR_ROOM_ID=bb-group`, `VITE_RALLAR_USERNAME=alice`, and `VITE_RALLAR_PASSWORD=secret`

Scope:

- Inventory current tests that already cover RTC, Rallar facade, IndexedDB AL stores, WS queue-box, and black-box real provider flows.
- Add or document a repeatable local runbook for a two-agent real-server RTC run.
- Capture baseline success/failure rates for:
  - first RTC connection establishment
  - reconnect after closing/reloading one browser
  - `messages.rtc` delivery
  - `realtime.sendJson()` delivery
  - logout/disconnect cleanup

Proof artifacts:

- A short baseline report checked into docs or attached to the tracking issue.
- One real-server Playwright run that can be repeated locally.
- A list of missing observability fields blocking diagnosis.

Tests to run:

```sh
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm run test -- packages/tests/shared/al-indexeddb-runtime-stores.test.ts
npm run test -- packages/tests/shared/qrtc-data-channel.test.ts
npm run test -- packages/tests/shared/webrtc-connection-service.test.ts
npm run test:e2e:rallar-black-box:full-stack:real
```

Exit criteria:

- The team can reproduce a real two-agent RTC setup with a real server.
- Current success/failure behavior is recorded before fixes.
- Any missing diagnostic fields needed for later proof are identified.

## Iteration 1: Read-only Diagnostics And Status Surface

Goal: add observability needed to prove or disprove suspected lifecycle problems.

This is an obvious gap, but keep the first pass read-only.

Status: implemented and locally verified on 2026-05-16.

Implemented:

- Added low-level RTC peer set diagnostics:
  - `WebRtcConnectionService.knownPeerIds()`
  - `WebRtcConnectionService.activePeerIds()`
  - `WebRtcConnectionService.readyPeerIdsForLane(laneId)`
- Added low-level WS diagnostics:
  - `WsQueueBoxClientService.readHealth()`
- Added additive browser facade APIs:
  - `rallar.rtc.status(options?)`
  - `rallar.rtc.peer(peerId, options?)`
  - `rallar.rtc.knownPeerIds()`
  - `rallar.rtc.activePeerIds()`
  - `rallar.rtc.readyPeerIds(laneId?)`
  - `rallar.ws.status()`

Verification completed:

- `npm --workspace @ar-eye-hunter/shared-web run typecheck`
- `npm run test -- packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared/webrtc-connection-service.test.ts`
- Real two-agent browser-rallar smoke with `realtime` and `messages.rtc` still passes after the read-only API additions.

Remaining evidence gap:

- The APIs now expose the needed status shape, but the Playwright black-box reports do not yet capture `rallar.rtc.status()` snapshots as first-class artifacts. Add that when the test harness is extended for reconnect/failure scenarios.

Original proposed implementation:

- Add a read-only `Rallar.rtc` facade or equivalent additive API exposing:
  - known peer IDs
  - peer connection state
  - lane state per peer
  - current browser `RTCDataChannel.readyState`
  - reconnect attempt count where available
  - whether each peer is routable for `messages.rtc`
- Add matching low-level service methods if needed, for example:
  - `knownPeerIds()`
  - `readAllPeerHealth()`
  - `readyPeerIdsForLane(laneId)`
- Add WS read-only status if a low-risk shape is available:
  - socket ready state
  - reconnect in progress
  - queue/outbox counts if exposed safely

Testing plan:

- Unit test facade status normalization.
- Browser integration test that `Rallar.rtc.status()` returns empty/disconnected state before RTC setup and populated state after a mocked/controlled connection service.
- Real-server two-agent Playwright test should print or assert status transitions around connect and message send.

Exit criteria:

- Diagnostics can distinguish "peer connection exists", "peer connection connected", "reliable lane open", and "realtime lane open".
- Real-server test artifacts include these states.

## Iteration 2: Prove IndexedDB Growth And Session Isolation Behavior

Goal: verify whether `ar-eye-hunter-al-runtime.entries` grows indefinitely in real use and whether expired/session data can be read.

Do not implement cleanup first. Prove the behavior.

Status: proof tests, explicit cleanup helpers, and browser middleware expiry eviction loops added and locally verified on 2026-05-16. Explicit logout/session-replacement purge wiring is still pending a lifecycle decision.

Findings from proof tests:

- Current browser session prefix reads suppress expired outbound state rows through the existing lazy eviction behavior.
- Expired rows under old browser session prefixes remain in `ar-eye-hunter-al-runtime.entries` until that exact prefix is scanned or a future explicit cleanup path removes them.
- Expired rows under unrelated browser runtime prefixes also remain when only the current session prefix is scanned.
- Fresh browser session IDs do not read old-session outbound state rows in the tested path.
- Reusing the same browser session ID restores unexpired outbound state, which is expected for crash/reload continuity but means same-session stale state can survive until expiry.

Risk classification after proof:

- Confirmed storage bloat risk for expired rows outside active/scanned prefixes.
- No cross-session read reproduced for browser AL outbound sent-state stores with session-scoped runtime IDs.
- Same-session restore of unexpired data is confirmed behavior, not a cleanup bug by itself.

Implemented after proof:

- `deleteExpiredBrowserALRuntimeEntries()` sweeps expired rows across browser AL runtime entry prefixes in `ar-eye-hunter-al-runtime.entries`.
- `deleteExpiredBrowserALRuntimeEntriesForSession(sessionId)` performs the same expired-row cleanup scoped to the three browser runtime prefixes for one session.
- `deleteBrowserALRuntimeEntriesForSession(sessionId)` purges all browser AL runtime rows for one session and is intended for explicit logout/session-replacement cleanup decisions.
- Cleanup helpers return `scanned` and `deleted` counts plus the database, store, and prefixes used, so tests and diagnostics can report what happened.
- `initBrowserALRuntimeExpiryEviction()` now mirrors the server `initRuntimeStateExpiryEviction` pattern for browser IndexedDB AL runtime rows.
- `initBrowserQueueBoxExpiryEviction()` now mirrors the server `initResourceInboxExpiryEviction` pattern for browser IndexedDB `queuebox:*` object stores.
- Browser middleware starts both eviction loops when middleware is initialized.

Proof work:

- Add tests that create expired records under:
  - current session prefix
  - old session prefix
  - unrelated runtime prefix
- Verify current-prefix reads suppress expired rows.
- Verify old-prefix expired rows remain until that prefix is scanned or explicit cleanup runs.
- Verify fresh session IDs do not read old session rows.
- Verify same-session restore can read unexpired rows if the session ID is reused.

Potential implementation only after proof:

- Add explicit cleanup helpers for browser AL runtime prefixes. Implemented.
- Add logout/session-replacement cleanup. Still pending an explicit lifecycle decision.
- Add startup/background expired-row sweep for `ar-eye-hunter-al-runtime.entries`. Implemented for browser AL runtime rows and browser queuebox stores.

Testing:

- Fake IndexedDB unit/integration tests for provider and AL runtime stores.
- Browser facade logout test proving cleanup behavior after it is implemented.
- Optional real-browser storage diagnostic in black-box app to count rows by prefix before and after logout.

Verification completed:

- `npm run test -- packages/tests/shared-web/browser-al-runtime-stores.test.ts`
- `npm run test -- packages/tests/shared-web/browser-al-runtime-stores.test.ts packages/tests/shared-web/browser-queuebox-expiry-eviction.test.ts packages/tests/shared/al-indexeddb-runtime-stores.test.ts`
- `npm run test -- packages/tests/shared-web/rallar-operation-options.test.ts`
- `npm --workspace @ar-eye-hunter/shared-web run typecheck`

Additional verification note:

- `npx tsc -p packages/tests/tsconfig.json --noEmit` is not currently a clean targeted gate for this iteration because the broader tests/app graph has existing unrelated TypeScript errors, including Deno globals, missing `@shared-test` path resolution, existing test typing issues, and unrelated relic-hunters type mismatches. Filtering that output showed no errors for `packages/tests/shared-web/browser-al-runtime-stores.test.ts`.

Exit criteria:

- The exact storage risk is documented as one of:
  - confirmed storage bloat only
  - confirmed same-session stale read
  - confirmed cross-session read
  - not reproducible with current code
- Cleanup is only implemented for confirmed or policy-decided risks.

## Iteration 3: Prove `enqueueOutboxIfAbsent()` Quiet Outcomes

Goal: classify all `messages.rtc.send()` outcomes before changing the API.

Status: result statuses implemented and locally verified on 2026-05-16. This intentionally changes `Rallar.messages.rtc.send()` and `Rallar.messages.ws.send()` from returning a bare `ALMessage` to returning a structured send result that includes the `ALMessage`.

Proof findings before implementation:

- Previously, `Rallar.messages.rtc.send()` returned the created `ALMessage` even when `ctx.middleware.rtcRxStreamer.enqueueOutboxIfAbsent()` resolved to an empty entry list.
- Previously, `WebRtcOverlayMulticastManager.enqueueIfAbsent()` collapsed both dropped/left outcomes and successful zero-entry outcomes to `[]`.
- Skipped/drop outcomes whose reason contains `Skipping` are intentionally quiet at the overlay manager boundary; missing overlay context can still warn during context resolution.
- Untargeted messages, missing overlay context, no next hop, missing RTC channel, successful volatile immediate send, superseded messages, and immediate prepared dispatch can all produce no outbox entries.
- Durable/local-outbox RTC sends return an outbox entry and persist it in the RTC outbox.
- Re-enqueuing the same durable RTC `ALMessage` returns an entry again but only leaves one RTC outbox row, so this duplicate/idempotent path is not currently a quiet `[]` outcome.
- Expired multicast sends return no entries and do not persist to the RTC outbox.
- Previously, `ALOutboundMessageRuntime.enqueueIfAbsent()` returned `left` for planner `dropReason`, and `WebRtcOverlayMulticastManager.enqueueIfAbsent()` folded that into `[]`.
- A planner with `persist: false` and no `preparedMessages` still persists an outbox entry for enqueue intent because `shouldEnqueueOutbox` ignores `plan.persist` for normal enqueue. This is confirmed current behavior and should be reviewed before assuming "no prepared messages" means "no route".
- A facade-only result wrapper could not accurately distinguish the quiet outcomes from the old `readonly ResourceEntry[]` return alone, so the implementation introduced a structured lower-layer enqueue outcome first.

Implemented after proof:

- `ALOutboundMessageRuntime.enqueueIfAbsent()` now returns `ALOutboundEnqueueResult` with:
  - `status`
  - `message`
  - optional `entry`
  - `entries`
  - optional `reason`
- Current statuses are:
  - `enqueued`
  - `sent-immediate`
  - `skipped`
  - `duplicate`
  - `superseded`
  - `expired`
  - `no-route`
  - `rate-limited`
  - `circuit-open`
  - `failed`
- `WebRtcOverlayMulticastManager.enqueueIfAbsent()` and `WebRtcRxStreamerService.enqueueOutboxIfAbsent()` now preserve the structured result instead of collapsing outcomes to `[]`.
- `WsQueueBoxClientService.enqueueOutboxIfAbsent()` and `WsQueueBoxServerService.enqueueOutboxIfAbsent()` now return the same structured result shape. WS cannot currently produce every RTC-specific route outcome, but it now reports immediate sends, queued sends, duplicate sends, and server-side no-recipient/no-route cases.
- `Rallar.messages.rtc.send()` and `Rallar.messages.ws.send()` now return `RallarMessageSendResult`:
  - `transport`
  - `status`
  - `message`
  - optional `entry`
  - `entries`
  - optional `reason`
- Same-message `enqueueIfAbsent()` is now idempotent at the AL outbound runtime boundary: a repeated enqueue returns `duplicate` and does not schedule another immediate send.
- RTC immediate dispatch now preflights missing RTC channels and reports `no-route` instead of allowing that case to look like a successful immediate send.
- `WebRtcOverlayMulticastManager.enqueueIfAbsent()` now has outbound abuse protection so an out-of-control SPA cannot flood RTC overlay planning, immediate sends, or durable outbox writes.
- Default rate limit: allow 20 `messages.rtc` enqueue attempts per second per browser session/manager instance.
- Rationale for 20/s:
  - It is above the current `relic-hunters-v1` position broadcast cadence of one send every 80 ms, or 12.5/s, with operational headroom.
  - `messages.rtc` is application-message delivery, not the preferred path for unbounded frame-rate telemetry. Higher-frequency streams should use `realtime` data-channel APIs with coalescing/backpressure semantics.
  - A 20/s per-session cap keeps accidental render-loop sends from producing hundreds or thousands of multicast fanout attempts per second.
- The default `RateLimiter` is `RateLimiter.init(1_000, 20)`.
- The default `CircuitBreaker` uses 10 failures in a 10 second window with 10 second open/half-open/retry durations, matching the existing local resilience style.
- `RateLimiter.tryToExecuteOrDefault(...)` returns `rate-limited` with the original `ALMessage`, empty `entries`, and reason `RTC enqueue rate limit exceeded`.
- `CircuitBreaker.tryToExecute(...)` returns `circuit-open` with the original `ALMessage`, empty `entries`, and reason `RTC enqueue circuit breaker open` when execution is not allowed.
- Unexpected enqueue exceptions return `failed` with a clear reason while still counting as circuit-breaker failures.
- The circuit breaker treats normal handled outcomes as successful, including `enqueued`, `sent-immediate`, `duplicate`, `superseded`, `expired`, `no-route`, and `skipped`. It treats `rate-limited`, `circuit-open`, and `failed` as unsuccessful.
- Added tests:
  - configured limit of 2/s, third immediate `enqueueIfAbsent()` returns `rate-limited`
  - rate-limited call does not write to RTC outbox and does not send on a channel
  - successful calls still return `sent-immediate`
  - forced/open circuit breaker returns `circuit-open` without enqueue/send side effects

Protection applicability analysis added on 2026-05-16:

- The RTC enqueue guard is appropriate at public/application ingress boundaries where one SPA call can trigger overlay planning, immediate data-channel sends, and durable outbox writes.
- The same guard is riskier inside protocol paths because those paths preserve reliability, repair, signaling, and relay behavior. A blanket limiter there can make the system look healthy while silently dropping the traffic that would have recovered it.
- `WsQueueBoxClientService.enqueueOutboxIfAbsent()` is the best direct follow-up candidate, but only after traffic class is made explicit. It is currently used by:
  - `Rallar.messages.ws.send()` for application messages
  - `WsRtcSignalingTransportUsingWsQBox.send()` for RTC offer/answer/ICE signaling
  - `ALInboundMessageRuntime.sendControlMessage` for WS client ACK/NACK/repair control messages
  - browser RTT measurement forwarding in `middleware.ts`
- For browser WS, the proposed rule is: apply the same `rate-limited`/`circuit-open` result pattern to application `Rallar.messages.ws.send()` traffic, keep the default application-send limit near the RTC 20/s baseline, and prove that signaling/control traffic either bypasses it or uses a separate higher-priority policy.
- `WsQueueBoxServerService.enqueueOutboxIfAbsent()` can use the same result vocabulary, but not the same 20/s global default. Server-side outbox sends include topic-router fanout and state-sync broadcasts; those can legitimately burst. Any server guard should be scoped by producer, room/topic, tenant/app namespace, or connection class, and should be proven with real API scenarios before implementation.
- `WsQueueBoxServerService.sendToTargets()` and `forwardIncomingMessage()` bypass the durable outbox. They are possible future live-send protection points, especially for `live-only` topic fanout and server NACKs, but they need separate accounting from outbox enqueue because they do not return `ALOutboundEnqueueResult`.
- `WebRtcOverlayMulticastManager.forwardIfRequired()` should not receive the same manager-level 20/s limiter. It is called from the inbound runtime's durable `forward-message` effect and is part of mesh propagation, subtree ACK completion, and repair behavior. A global limiter here can partition the overlay or turn one overloaded relay into message loss for downstream peers.
- If forwarding protection is needed, it should be a separate proof item: high-threshold `forwardRateLimiter`, scoped by `fromPeerId` and overlay/topic where possible, with diagnostics for dropped/deferred forwards and real three-agent relay tests. Circuit-breaking repeated send failures may be useful, but the current `forwardIfRequired()` return type is `readonly ResourceEntry[]` and the caller ignores it, so observability/result shaping must come first.
- Current RTC enqueue caveat: `WebRtcRxStreamerService` uses `multicast.enqueueIfAbsent()` for AL control messages generated by the inbound runtime. That means ACK/NACK/repair controls can currently be rate-limited by the RTC application-send guard. Before expanding the pattern, add proof tests around `isALControlTypeId(...)` traffic and decide whether RTC control messages bypass the app limiter or use a separate higher-priority limiter.
- Do not put this pattern in `ALOutboundMessageRuntime.enqueueIfAbsent()` or the low-level QueueBox `enqueueIfAbsent()` primitives. Those layers do not know whether the caller is app traffic, signaling, control, repair, replay, or server fanout, so a shared limiter there would hide caller context and make correctness bugs harder to reason about.

Follow-up proof tests before applying the pattern elsewhere:

- Browser WS app send: exceeding the configured limit returns `rate-limited`, does not write to WS outbox, and does not send on an open socket.
- Browser WS control/signaling: AL ACK/NACK/repair and `WsRtcSignalingTransportUsingWsQBox.send()` are not throttled by the app-message limiter, or return a separately documented status if a dedicated control/signaling policy is introduced.
- RTC control traffic: ACK/NACK/repair generated by inbound RTC handling remains deliverable under normal message bursts and cannot be starved by user `messages.rtc.send()` loops.
- RTC forwarding: a real three-agent scenario proves `forwardIfRequired()` behavior under relay load before adding any limiter; expected assertions should cover downstream receipt, outbox entries, and diagnostic status/metrics.
- Server WS outbox: topic-router/state-sync broadcasts are tested with a realistic burst and scoped limiter policy before any default server-side guard is enabled.

Verification completed:

- `npm run test -- packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/al-durable-runtime.test.ts`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npm --workspace @ar-eye-hunter/shared-web run typecheck`
- `npm --workspace @ar-eye-hunter/shared-server run typecheck`
- `npm --workspace @ar-eye-hunter/shared-test run typecheck`
- `npm --workspace @ar-eye-hunter/relic-hunters run typecheck`

Proof work:

- Add focused tests around `WebRtcOverlayMulticastManager.enqueueIfAbsent()` and `ALOutboundMessageRuntime.enqueueIfAbsent()` for:
  - no targets
  - no overlay context
  - no next hop
  - superseded message
  - duplicate message
  - expired message
  - immediate dispatch success
  - missing peer/channel in immediate dispatch
- Add facade-level tests proving `Rallar.messages.rtc.send()` and `Rallar.messages.ws.send()` now expose the structured status and the created `ALMessage`.

Implemented API shape:

- `send()` itself now returns the structured result rather than adding a parallel `sendWithResult()` method.
- RTC and WS use the same status vocabulary, even though WS has fewer route/planning states in practice.

Real scenario testing:

- Run two-agent real-server scenarios for successful `messages.rtc`.
- Add a real-server scenario where one peer is absent/disconnected and assert the new result exposes `no-route` or `skipped`.
- Record message ID, target room, next hop, known peers, connected peers, and lane states.

Exit criteria:

- Each quiet/ambiguous outcome has a deterministic test.
- New result API is backed by tests and real-server evidence.

## Iteration 4: Prove Data-channel Reuse And Closed-channel Behavior

Goal: confirm whether stale `RTCDataChannel` reuse causes false closed results, hidden peers, or reconnect failure.

Status: unit proof, narrow data-channel fix, real-server reload proof, reload status snapshot artifacts, and additional terminal-wait lifecycle tests implemented on 2026-05-17. Public RTC lifecycle/status subscription APIs remain a follow-up API item.

Facade lifecycle callback check added on 2026-05-16:

- `Rallar` currently exposes read-only status snapshots through `rallar.rtc.status(options?)`, `rallar.rtc.peer(...)`, `rallar.rtc.knownPeerIds()`, `rallar.rtc.activePeerIds()`, `rallar.rtc.readyPeerIds(...)`, and `rallar.ws.status()`.
- The public facade does not currently expose RTC/WS lifecycle subscription APIs such as `rallar.rtc.onLifecycle(...)`, `rallar.ws.onLifecycle(...)`, `rallar.rtc.onStatus(...)`, or `rallar.ws.onStatus(...)`.
- Lower layers already have lifecycle hooks, including WebSocket callbacks, RTC peer lifecycle callbacks, and data-channel close/open/error callbacks, but those are internal plumbing and not an application-facing Rallar API.
- RTC lifecycle callbacks fit Iteration 4 because proving stale data-channel reuse needs observable peer/lane events for open, close, error, replace/reset, reconnecting, and reconnected transitions.
- WS lifecycle callbacks fit Iteration 5 because they are tied to intentional disconnect, logout, reconnect suppression, and unexpected WebSocket close/error behavior.

Proof findings:

- `QRtcDataChannel.onclose` did leave `status.dc` pointing at a closed `RTCDataChannel`.
- That stale closed channel caused `waitUntilOpen()` to resolve `false` immediately during receiver-side reconnect, before the replacement incoming channel could be delivered through `ondatachannel`.
- Initiator-side reconnect already created a replacement channel on a later `connect(true)`, but clearing terminal references makes the state and health snapshot explicit.
- `WebRtcConnectionService` already exposes `knownPeerIds()`, `activePeerIds()`, and `readyPeerIdsForLane(...)`, which allows lane readiness to be observed separately from broad connected-peer semantics.
- `connectedPeerIds()` remains conservative: if any configured lane is reconnectable, the peer is excluded even when the reliable/default lane is open. The new test documents this current behavior rather than changing it in Iteration 4.

Implemented after proof:

- `QRtcDataChannel` now clears its current `RTCDataChannel` reference on close, leaving `state: Closed` while removing stale `readyState: closed` from `readHealth()`.
- `QRtcDataChannel.connect(...)` clears terminal channel references before starting a new connection attempt, covering failed/closed stale references that might otherwise block waits.
- Receiver-side reconnect can now call `waitUntilOpen(...)` after `connect(false)` and remain pending until the replacement incoming channel opens.
- Added real browser-Rallar reload tests that keep the same browser auth session across a page reload, so the remote peer ID remains stable and the opposite browser must recover from closed data channels for the same peer.
- Extended browser black-box health diagnostics with facade-level `wsStatus` and lane-scoped `rtcStatus`, then captured Playwright JSON artifacts for before-reload, after-page-reload, after-reconnect, and after-reload-delivery phases.
- Added focused tests for:
  - clearing stale closed channel state
  - replacing a closed initiator channel
  - waiting for a replacement receiver channel
  - resolving pending open waits when `reset()` happens before open
  - resolving pending open waits when a data channel closes before open
  - replacing a failed initiator channel on reconnect
  - reliable lane ready while realtime lane is reconnectable/closed

Proof work completed/remaining:

- Added `QRtcDataChannel` tests for:
  - `onclose` no longer leaves `status.dc` pointing to a closed channel
  - `waitUntilOpen()` no longer resolves false immediately during receiver-side replacement-channel setup
  - pending `waitUntilOpen()` callers resolve `false` on reset and pre-open close
  - failed initiator data channels are detached before a later reconnect creates a replacement channel
  - `connect()` after close behaves correctly for initiator and receiver roles
  - `reset()` clears `status.dc`
- Added or retained `WebRtcConnectionService` tests proving how `connectedPeerIds()` behaves when:
  - peer connection is connected and all lanes are open
  - one lane is closed/failed
  - reliable lane is open but realtime lane is closed
  - peer connection is reset after reconnect exhaustion

Remaining potential implementation after proof:

- Split peer-level health from lane-level readiness.
- Add public RTC lifecycle/status subscription API after the close/reuse behavior is proven:
  - `rallar.rtc.onLifecycle(listener)` or `rallar.rtc.onStatus(listener)`
  - event fields should include peerId, laneId when applicable, peer connection state, data-channel state, event kind, close/error details where available, and whether the transition is part of reconnect/reset.
- Replace or supplement `connectedPeerIds()` with explicit APIs:
  - `knownPeerIds()`
  - `activePeerIds()`
  - `readyPeerIdsForLane(laneId)`

Real scenario testing completed/remaining:

- Completed two-agent real-server tests:
  - connect both clients
  - send realtime JSON successfully
  - reload one browser agent while preserving its auth session/session ID
  - reconnect that browser agent to the same room and transport
  - send realtime JSON again
  - send `messages.rtc` again in the equivalent `messages.rtc` transport scenario
  - assert status/lane transitions and delivery
  - attach RTC/WS status snapshots for the reload phases as Playwright JSON artifacts
- The `messages.rtc` reload run showed transient `Data channel not open` errors while durable outbound retry was waiting for the replacement reliable channel. The final delivery still succeeded after the replacement channel opened, so this is now captured behavior rather than a blocking Iteration 4 failure.
- Remaining real scenario improvement: add the same first-class RTC status/lane snapshot artifacts to broader non-reload and failure-path tests, if those tests start depending on lifecycle timing.

Exit criteria:

- The stale-channel hypothesis is either proven with failing tests or dismissed.
- Any behavior change has unit tests plus at least one real-server reconnect scenario.
- Applications can subscribe to RTC lifecycle/status changes once the event semantics are proven by the Iteration 4 tests.

Verification completed:

- `npm run test -- packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/webrtc-connection-service.test.ts`
- `npm run test -- packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/webrtc-connection-service.test.ts packages/tests/shared-web/rallar-operation-options.test.ts`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npm --workspace @ar-eye-hunter/shared-test run typecheck`
- `npm --workspace rallar-black-box run typecheck`
- `npm run test -- packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/webrtc-connection-service.test.ts`
- `VITE_RALLAR_API_BASE_URL=http://localhost:8080 VITE_RALLAR_ROOM_ID=bb-group VITE_RALLAR_USERNAME=alice VITE_RALLAR_PASSWORD=secret npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts -g "reloading one real agent"`
- `VITE_RALLAR_API_BASE_URL=http://localhost:8080 VITE_RALLAR_ROOM_ID=bb-group VITE_RALLAR_USERNAME=alice VITE_RALLAR_PASSWORD=secret npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts -g "messages.rtc after reloading one real agent"`

## Iteration 5: Prove `disconnect()` And WS Reconnect Cleanup Behavior

Goal: prove whether intentional disconnect leaves RTC peers alive or triggers unwanted WS reconnect.

Proof work:

- Add tests around `Rallar.disconnect()` with a controlled `WebRtcConnectionService` where:
  - all peers are healthy
  - one peer has a closed lane and is excluded from `connectedPeerIds()`
  - one peer is known but not currently connected
- Verify which peers are disconnected.
- Add tests for `WsQueueBoxClientService.enableReconnect()` and intentional `JsonWebSocketClient.close(1000, 'rallar-disconnect')`.
- Add tests for lifecycle callbacks on explicit and remote WS/RTC close events:
  - WS closed intentionally by `Rallar.disconnect()`
  - WS closed during `auth.logout()`
  - WS closed unexpectedly while logged in
  - RTC data channel closed remotely
  - RTC peer connection closed/failed
- Prove that WS reconnect is suppressed when the user is logged out or the close was intentional.

Potential implementation after proof:

- Add `allPeerIds()` or use `readAllPeerHealth()` to disconnect every known peer.
- Add explicit reconnect suppression/disable path for intentional `Rallar.disconnect()`.
- Make reconnect state visible through WS diagnostics.
- Add Rallar WS lifecycle callbacks for transport closure/disconnect events:
  - `rallar.ws.onLifecycle(listener)` or fold into `rallar.ws.onStatus(listener)`
  - keep RTC lifecycle callback semantics aligned with the Iteration 4 RTC lifecycle/status API
  - event fields should include transport, peerId/laneId where applicable, close code/reason where available, intentional vs unexpected, reconnect scheduled, and current session/login state.
- Gate `WsQueueBoxClientService.enableReconnect()` behind explicit reconnect eligibility:
  - do not reconnect after `Rallar.disconnect()`
  - do not reconnect after `auth.logout()`
  - do not reconnect when no valid session exists
  - only reconnect unexpected closes while the facade/session still considers the user connected/logged in.

Real scenario testing:

- Real-server browser test:
  - connect two agents
  - establish RTC
  - call `rallar.disconnect()` in one browser
  - assert no background reconnect occurs
  - assert WS and RTC lifecycle callbacks report intentional close/disconnect
  - assert remote side observes expected close/disconnect state
  - reconnect intentionally and verify delivery still works

Exit criteria:

- Cleanup behavior is proven before and after any fix.
- Intentional disconnect does not leave hidden peers or background reconnect tasks.
- WS reconnect never runs after logout unless the user explicitly reconnects/logs in again.
- Applications can subscribe to WS/RTC lifecycle callbacks and distinguish intentional close, unexpected close, reconnecting, reconnected, and reconnect-suppressed states.

## Iteration 6: Add Wait APIs For RTC And WS

Goal: implement the obvious missing APIs once status diagnostics are available.

This iteration does not need proof that the API is missing; that is already clear. It still needs tests proving semantics.

`waitForOpen` analysis added on 2026-05-16:

- Rallar should expose wait-for-open APIs for both WS and RTC, but the RTC shape must be lane-scoped rather than a single ambiguous global "RTC open" flag.
- Current public Rallar APIs expose snapshots (`rallar.ws.status()`, `rallar.rtc.status(...)`, `rallar.rtc.readyPeerIds(...)`) and send methods, but no reusable facade-level `waitForOpen`/`waitUntilReady` method.
- The lower RTC layer already has `QRtcDataChannel.waitUntilOpen(timeoutMs)`, and `rallar.realtime.sendJson/sendBinary` already uses it internally before sending. Exposing a Rallar-level wait API would let callers and black-box tests gate sends explicitly instead of relying on optimistic send behavior.
- The WS layer has `JsonWebSocketClient.connect(...)` and `WsQueueBoxClientService.readHealth()`, but no separate public wait method for reconnect/open transitions. `rallar.connect()` is close to "open WS and middleware", but it is too broad when a caller wants to wait for the current WS transport to become open after reconnect.
- Recommended public naming:
  - `rallar.ws.waitForOpen(options?)`
  - `rallar.rtc.waitForOpen(peerId, options?)`
  - keep `rallar.rtc.waitForLane(peerId, laneId, options?)` as either the implementation name or an explicit alias for callers that prefer the less ambiguous lane terminology.
- RTC `waitForOpen` should default to the reliable/message lane used by `messages.rtc`, while realtime callers can pass a lane ID or use a later `rallar.realtime.waitForOpen(laneId, options)` helper if needed.
- The return value should be structured, not a bare boolean, so timeout/aborted/not-connected/closed/no-peer can be distinguished from success. This should align with the existing status/result style from Iteration 3.
- Waiting should not silently create hidden connections unless the caller opts into that. Use an option such as `connect?: boolean`, defaulting conservatively to observing existing state for WS reconnect and RTC lane readiness. `rallar.rtc.connectPeer(...)` can remain the explicit connection-triggering API.
- These APIs should be added before broad real-server RTC reconnect tests, because tests can then wait for explicit WS open and RTC lane open states instead of sleeping or sending optimistically.

Proposed RTC APIs:

- `rallar.rtc.waitForPeer(peerId, options)`
- `rallar.rtc.waitForLane(peerId, laneId, options)`
- `rallar.rtc.waitForOpen(peerId, options)` as a convenience wrapper over the default RTC message lane or a caller-provided `laneId`
- `rallar.rtc.connectPeer(peerId, options)`
- `rallar.rtc.status(options?)`
- `rallar.rtc.onStatus(listener)`

Proposed WS APIs:

- `rallar.ws.status()`
- `rallar.ws.waitForOpen(options)`; prefer this name over `waitUntilReady` because the state being waited for is specifically WebSocket `open`
- `rallar.ws.onStatus(listener)`

Semantics to define:

- timeout behavior
- abort behavior
- whether waiting triggers connection or only observes; default should be observe-only unless an explicit `connect: true` option is provided
- whether lane wait requires peer connection to be active first
- whether RTC `waitForOpen` waits for peer connection only or data-channel lane open; the recommended contract is lane open, with peer-open covered by `waitForPeer`
- return shape for success vs timeout vs aborted vs failed
- behavior after logout/disconnect: should return a non-open status and must not restart WS reconnect or RTC setup unless explicitly requested

Testing:

- Unit tests for timeout and abort handling.
- Facade tests for wait success/failure using controlled services.
- Facade tests proving `rallar.ws.waitForOpen()` resolves immediately when already open, times out when closed/connecting, and does not call connect/reconnect in observe-only mode.
- Facade tests proving `rallar.rtc.waitForOpen(peerId, { laneId })` delegates to the correct `QRtcDataChannel.waitUntilOpen(timeoutMs)` and returns a structured timeout/closed result when the lane is missing or closed.
- Real-server two-agent test that waits for RTC lane before sending and proves lower flake rate than optimistic send.
- Real-server test should wait for `rallar.ws.waitForOpen()` after login/connect, then wait for `rallar.rtc.waitForOpen(peerId, ...)` before `messages.rtc` or realtime sends.

Exit criteria:

- Public APIs are documented by tests.
- Real-server test uses wait APIs before sending.

## Iteration 7: RTC Establishment Timeout And Retry Policy

Goal: add explicit timeouts only where tests prove indefinite or unclear waits.

Proof work:

- Use diagnostics from Iterations 1 and 6 to detect:
  - signaling sent but no answer
  - ICE candidates exchanged but no connected state
  - data channel never opens
  - reconnect attempts exhausted without service-level cleanup
- Add deterministic tests using fake/stub signaling and peer wrappers where possible.

Potential implementation after proof:

- Add configurable timeout policy for:
  - signaling answer wait
  - peer connected wait
  - lane open wait
  - reconnect total elapsed time
- Surface timeout events through lifecycle/status APIs.
- On reconnect exhaustion, notify `WebRtcConnectionService` so it can remove or recreate the peer DTO.

Real scenario testing:

- Use a real server with controlled bad conditions where practical:
  - one agent closes during setup
  - one agent reloads during setup
  - one agent loses WS signaling during RTC negotiation if test infrastructure can simulate it
- Assert the caller receives timeout/failure status instead of silent hanging or optimistic success.

Exit criteria:

- Timeout behavior is visible and covered by deterministic tests.
- At least one real-server failure scenario produces a useful status/result.

## Iteration 8: Speed And Warmup Improvements

Goal: improve RTC establishment speed after observability proves where time is spent.

Do not start here. Speed work should be based on measured bottlenecks.

Proof work:

- Measure connect timeline in real-server two-agent tests:
  - auth restore/login
  - WebSocket open
  - signaling callback registration
  - peer DTO created
  - offer sent
  - answer received
  - ICE connected
  - data channel open
  - first successful payload delivery
- Compare lazy first-send setup vs optional room-peer preconnect.

Potential implementation after proof:

- Optional `rallar.rtc.preconnectRoom(roomId, options)`.
- Optional warmup after state hydration for active room peers.
- Smarter use of known room membership and lane readiness before `messages.rtc` or realtime sends.

Real scenario testing:

- Run before/after timing on real server.
- Include CI-tolerant thresholds or at least trend logs if timings are too variable for hard assertions.

Exit criteria:

- Speed improvement is backed by measured before/after data.
- Warmup does not increase failure rate or create unwanted connections after logout/disconnect.

## Iteration 9: Server WS Facade Symmetry

Goal: add server-side WS status/readiness APIs only after browser transport API shapes settle.

Proof work:

- Confirm what server operators and tests need:
  - live connection count
  - connection IDs/session IDs
  - topic/room recipient counts
  - publish outcome details
- Add tests around current `RallarServer.ws.publish()` outcomes:
  - `live-only`
  - `outbox`
  - `none`
  - zero recipients

Potential implementation:

- Add `RallarServer.ws.status()`.
- Add explicit publish result metadata.
- Add lifecycle subscriptions if useful for server tests or app observability.

Testing:

- Existing shared-server Vitest tests.
- Full-stack Playwright where browser WS sends and server status is queried through a test/control endpoint if available.

Exit criteria:

- Server WS status shape aligns with browser WS status where it makes sense.
- Publish outcomes are explicit and tested.

## Release Gates

Before considering the task set complete:

- Unit and integration tests prove each confirmed issue and each fix.
- Two-agent real-server Playwright RTC test passes for:
  - initial connect
  - wait before send
  - `messages.rtc`
  - `realtime.sendJson`
  - disconnect and intentional reconnect
  - browser reload or equivalent reconnect scenario
- IndexedDB tests prove expired data is not read and cleanup policy is enforced.
- Send outcome tests prove skipped/not-enqueued cases are visible.
- Public APIs have compatibility notes and minimal usage examples.

## Suggested Implementation Order

1. Baseline real-server reproduction and evidence capture.
2. Read-only diagnostics/status APIs.
3. IndexedDB proof tests and cleanup only if confirmed or policy-decided.
4. RTC send outcome proof tests and `sendWithResult()`.
5. Data-channel reuse proof tests, then lane/peer health separation if confirmed.
6. Disconnect and WS reconnect proof tests, then cleanup fixes if confirmed.
7. Wait APIs for RTC and WS.
8. Timeout/retry policy improvements.
9. Speed/warmup improvements based on measured bottlenecks.
10. Server WS symmetry after browser API shape stabilizes.
