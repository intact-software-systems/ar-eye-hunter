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
| 4: Data-channel reuse and closed-channel behavior | Unit, real-server reload, public RTC status API, and peer-id naming cleanup implemented | Focused `QRtcDataChannel` tests proved stale closed channel references blocked receiver-side replacement waits. `QRtcDataChannel` now clears terminal channel references so reconnect waits can observe replacement channels. `WebRtcConnectionService` tests document lane-ready state separately from active/no-reconnectable-lane peer state. Real browser-Rallar reload scenarios now pass for `realtime` and `messages.rtc` with attached RTC/WS status snapshots. `Rallar.rtc.onStatus(...)` and `Rallar.rtc.onLifecycle(...)` now expose public RTC subscription APIs. `connectedPeerIds()` is now a deprecated compatibility alias for the more exact `peerIdsWithNoReconnectableLanes()`, and Rallar uses active/known/lane-ready peer sets for the call sites that need those semantics. |
| 5: `disconnect()` and WS reconnect cleanup behavior | WS reconnect suppression, bounded retry, public WS lifecycle/status API, and targeted real-server disconnect/reconnect proof implemented | Focused tests prove unexpected WS close still reconnects, intentional service close suppresses reconnect, disabling reconnect stops a pending retry loop, reconnect exhaustion disables automatic reconnect, and session eligibility suppresses stale reconnects. `Rallar.disconnect()` now closes WS through `WsQueueBoxClientService.close(...)`. `Rallar.ws.onStatus(...)` and `Rallar.ws.onLifecycle(...)` expose WS status/lifecycle subscriptions. A targeted two-agent browser-Rallar smoke proves intentional disconnect does not background-reconnect and explicit reconnect restores delivery. Broader real-browser logout/session-replacement/unexpected-close scenarios are moved to Iteration 10. |
| 6: Wait APIs for RTC and WS | Initial facade wait APIs implemented and locally verified | `rallar.ws.waitForOpen(...)`, `rallar.rtc.waitForLane(...)`, and `rallar.rtc.waitForOpen(...)` now return structured wait results. Focused facade tests cover open, timeout, aborted, observe-only no-connect, missing peer, and opt-in RTC connect-before-wait behavior. Real-server integration adoption is deferred until the black-box scenarios are updated to use these waits. |
| 7: RTC establishment timeout and retry policy | Initial peer establishment timeout policy and explicit start/open APIs implemented and locally verified | Deterministic `WebRtcConnectionService` tests prove a peer that never establishes is evicted after an explicit timeout and can be recreated, while an opened lane clears the timeout. Browser Rallar enables the policy with a 30 second timeout, and `rallar.rtc.onLifecycle(...)` now surfaces service timeout events as `peer-timeout`. `ensurePeerConnectionStarted()` is now synchronous and start-only, `connectToPeerIfAbsent()` remains a deprecated alias, and `ensurePeerLaneOpen(...)` provides the opt-in readiness path using `PullPushCommand`. Rallar uses `ensurePeerLaneOpen(...)` internally for connect-and-wait RTC facade calls and realtime sends, while observe-only waits still avoid starting peers. `rallar.rtc.waitForRoomLane(...)` adds a room-level readiness wrapper that separates ready and not-ready peers. Peer establishment watchdog bookkeeping moved into reusable `AsyncCommand`. Real-server bad-condition scenarios and reconnect-exhaustion service cleanup remain pending. |
| 10: Manual real-browser/server integration proofs | Planned | Convert selected live browser/server scenarios into repeatable manual runbooks first, then graduate stable scenarios into automated integration tests. Owns logout reconnect suppression, session replacement/no-valid-session stale reconnect suppression, unexpected server/network close reconnect behavior, and broader real-browser status artifact capture. |

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

Status: unit proof, narrow data-channel fix, real-server reload proof, reload status snapshot artifacts, additional terminal-wait lifecycle tests, and public RTC lifecycle/status subscription APIs implemented on 2026-05-17.

Facade lifecycle callback check added on 2026-05-16:

- `Rallar` currently exposes read-only status snapshots through `rallar.rtc.status(options?)`, `rallar.rtc.peer(...)`, `rallar.rtc.knownPeerIds()`, `rallar.rtc.activePeerIds()`, `rallar.rtc.readyPeerIds(...)`, and `rallar.ws.status()`.
- The public facade now exposes RTC subscription APIs through `rallar.rtc.onStatus(listener, options?)` and `rallar.rtc.onLifecycle(listener, options?)`.
- The public facade exposes WS subscription APIs through `rallar.ws.onStatus(listener, options?)` and `rallar.ws.onLifecycle(listener, options?)` after the first Iteration 5 implementation pass.
- Lower layers already have lifecycle hooks, including WebSocket callbacks, RTC peer lifecycle callbacks, and data-channel close/open/error callbacks, but those are internal plumbing and not an application-facing Rallar API.
- RTC lifecycle callbacks fit Iteration 4 because proving stale data-channel reuse needs observable peer/lane events for open, close, error, replace/reset, reconnecting, and reconnected transitions.
- WS lifecycle callbacks fit Iteration 5 because they are tied to intentional disconnect, logout, reconnect suppression, and unexpected WebSocket close/error behavior.

Proof findings:

- `QRtcDataChannel.onclose` did leave `status.dc` pointing at a closed `RTCDataChannel`.
- That stale closed channel caused `waitUntilOpen()` to resolve `false` immediately during receiver-side reconnect, before the replacement incoming channel could be delivered through `ondatachannel`.
- Initiator-side reconnect already created a replacement channel on a later `connect(true)`, but clearing terminal references makes the state and health snapshot explicit.
- `WebRtcConnectionService` already exposes `knownPeerIds()`, `activePeerIds()`, and `readyPeerIdsForLane(...)`, which allows lane readiness to be observed separately from broad connected-peer semantics.
- The old `connectedPeerIds()` name was misleading: if any configured lane is reconnectable, the peer is excluded even when the reliable/default lane is open. This is now named `peerIdsWithNoReconnectableLanes()` in the low-level service, while `connectedPeerIds()` remains only as a deprecated compatibility alias.

Implemented after proof:

- `QRtcDataChannel` now clears its current `RTCDataChannel` reference on close, leaving `state: Closed` while removing stale `readyState: closed` from `readHealth()`.
- `QRtcDataChannel.connect(...)` clears terminal channel references before starting a new connection attempt, covering failed/closed stale references that might otherwise block waits.
- Receiver-side reconnect can now call `waitUntilOpen(...)` after `connect(false)` and remain pending until the replacement incoming channel opens.
- Added real browser-Rallar reload tests that keep the same browser auth session across a page reload, so the remote peer ID remains stable and the opposite browser must recover from closed data channels for the same peer.
- Extended browser black-box health diagnostics with facade-level `wsStatus` and lane-scoped `rtcStatus`, then captured Playwright JSON artifacts for before-reload, after-page-reload, after-reconnect, and after-reload-delivery phases.
- Added public RTC subscription APIs:
  - `rallar.rtc.onStatus(listener, options?)` emits lane-scoped `RallarRtcStatus` snapshots.
  - `rallar.rtc.onLifecycle(listener, options?)` emits lifecycle events for `snapshot`, `connected`, `disconnected`, `peer-created`, `peer-deleted`, `lane-open`, `lane-close`, and `lane-error`, with the current status snapshot attached.
  - RTC status/lifecycle subscriptions are backed by `WebRtcConnectionService` peer lifecycle callbacks and `QRtcDataChannel` open/close/error callbacks.
- Split misleading connected-peer usage by intent:
  - Rallar status now exposes `peerIdsWithNoReconnectableLanes` and peer-level `hasNoReconnectableLanes`, while retaining deprecated compatibility aliases `connectedPeerIds` and `isConnectedPeer`.
  - Rallar RTC routeability now uses `readyPeerIdsForLane(laneId)`, so a peer can be routable for the reliable lane even if another lane is reconnectable.
  - Rallar realtime health and callback registration use `activePeerIds()`, so closed/reconnecting lanes remain visible for diagnostics instead of disappearing from health output.
  - Rallar disconnect and realtime callback cleanup use `knownPeerIds()`, so stale peers with closed/reconnectable lanes are still cleaned up.
  - WebRTC group reconciliation still uses `peerIdsWithNoReconnectableLanes()` to decide when a desired peer needs a lane reconnect, but it now uses `knownPeerIds()` when disconnecting peers that left all groups.
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
- Added facade tests proving `rallar.rtc.onStatus(...)` and `rallar.rtc.onLifecycle(...)`:
  - emit current snapshots by default
  - register callbacks on existing RTC peers/lanes after connect
  - emit lifecycle events for lane-open and peer-deleted transitions
  - unregister lower-level callbacks when the last public subscriber unsubscribes

Remaining potential implementation after proof:

- "Split peer-level health from lane-level readiness" means callers should not have to infer two different concepts from one broad `connectedPeerIds()` result:
  - peer-level health: whether the `RTCPeerConnection` exists, is connecting/connected, is reconnecting, or is disconnected/failed
  - lane-level readiness: whether a specific data-channel lane such as `reliable` or `realtime` is open and sendable
- This is partly addressed by the existing explicit APIs and status fields: `knownPeerIds()`, `activePeerIds()`, `readyPeerIds(laneId)`, `RallarRtcPeerStatus.connection`, and per-lane `RallarRtcLaneStatus`.
- The `connectedPeerIds()` cleanup is implemented as an additive rename: use `peerIdsWithNoReconnectableLanes()` for that exact conservative state, `activePeerIds()` for peer connection presence/health, `readyPeerIdsForLane(laneId)` for routing, and `knownPeerIds()` for teardown/cleanup. The old name remains available only for compatibility.

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
- `npm run test -- packages/tests/shared-web/rallar-operation-options.test.ts`
- `npm run test -- packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared/webrtc-connection-service.test.ts packages/tests/shared/webrtc-group-manager.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts`
- `npm run test -- packages/tests/shared/qrtc-data-channel.test.ts`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
- `npm --workspace rallar-black-box run typecheck`
- `git diff --check`
- `VITE_RALLAR_API_BASE_URL=http://localhost:8080 VITE_RALLAR_ROOM_ID=bb-group VITE_RALLAR_USERNAME=alice VITE_RALLAR_PASSWORD=secret npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts -g "reloading one real agent"`
- `VITE_RALLAR_API_BASE_URL=http://localhost:8080 VITE_RALLAR_ROOM_ID=bb-group VITE_RALLAR_USERNAME=alice VITE_RALLAR_PASSWORD=secret npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts -g "messages.rtc after reloading one real agent"`

## Iteration 5: Prove `disconnect()` And WS Reconnect Cleanup Behavior

Goal: prove whether intentional disconnect leaves RTC peers alive or triggers unwanted WS reconnect.

Status: completed for focused proof, implementation, and one targeted real-server browser proof on 2026-05-17. Broader live browser/server coverage is intentionally moved to Iteration 10 instead of blocking this implementation iteration.

Proof findings:

- Iteration 4 already fixed the main RTC peer cleanup gap by changing `Rallar.disconnect()` to disconnect `knownPeerIds()` instead of the conservative connected/no-reconnectable-lane set.
- Code inspection confirmed the WS reconnect risk: `WsQueueBoxClientService.enableReconnect()` attached close/error callbacks that called `reconnect()` for every socket close/error, while `Rallar.disconnect()` closed the raw `JsonWebSocketClient` directly.
- Focused tests now prove the desired WS lifecycle split:
  - unexpected WS close while reconnect is enabled calls `socket.connect()`
  - intentional `WsQueueBoxClientService.close(1000, 'rallar-disconnect')` disables reconnect before closing and does not reconnect when the close callback fires
  - disabling reconnect while a retry loop is pending prevents the next retry attempt from calling `socket.connect()`
  - WS reconnect gives up after the configured attempt budget and then disables automatic reconnect until the app explicitly reconnects again
  - WS reconnect does not start when the reconnect eligibility predicate returns false, which covers the no-valid-session browser case
- Public WS lifecycle/status subscription tests prove applications can observe:
  - current WS status snapshots
  - facade-connected lifecycle snapshots
  - unexpected close events with close code/reason/cleanliness
  - intentional `Rallar.disconnect()` events with code `1000`, reason `rallar-disconnect`, and `intentional: true`
- Facade logout tests now prove `auth.logout()` uses the same queue-box close path after a connected session, so it inherits reconnect suppression from `disconnect()`.
- Default WS reconnect policy is 12 total attempts, starting immediately with 500 ms exponential backoff capped at 20 seconds. This gives roughly two minutes of automatic recovery with the `tryWithPolicy(...)` schedule, then stops instead of retrying forever.
- Real two-agent browser-Rallar smoke now proves:
  - message delivery works before an intentional disconnect
  - `rallar.disconnect()` leaves no background WS reconnect running
  - `rallar.ws.status()` reports `readyState: "missing"`, `reconnecting: false`, `reconnectEnabled: false`, and `reconnectExhausted: false` after intentional disconnect
  - explicit reconnect using the same restored session re-establishes RTC delivery

Implemented after proof:

- `WsQueueBoxClientService.readHealth()` now reports `reconnectEnabled`.
- `WsQueueBoxClientService.readHealth()` now reports `reconnectAttempts`, `maxReconnectAttempts`, and `reconnectExhausted`.
- `WsQueueBoxClientService.enableReconnect()` explicitly enables reconnect and clears prior attempt/exhaustion state.
- `WsQueueBoxClientService.disableReconnect()` suppresses future reconnect attempts and stops pending retry loops before their next socket connect attempt.
- `WsQueueBoxClientService.close(code, reason)` disables reconnect before closing the socket.
- `WsQueueBoxClientService` reconnect options now allow overriding max attempts, retry interval, max retry interval, and reconnect eligibility.
- `WsQueueBoxClientService` reconnect now uses `tryWithPolicy(...)` with a labeled reconnect policy, typed exhaustion handling, and a retry predicate tied to reconnect eligibility/generation.
- Browser WS engine wires reconnect eligibility to the current auth session, so a stale socket callback cannot reconnect after the session has been cleared or replaced.
- `Rallar.disconnect()` now calls `ctx.middleware.webSocketQueueBox.close(1000, 'rallar-disconnect')` instead of closing the raw socket directly.
- `Rallar.ws.status()` now includes `reconnectEnabled`, `reconnectAttempts`, `maxReconnectAttempts`, and `reconnectExhausted`.
- Added public WS subscription APIs:
  - `rallar.ws.onStatus(listener, options?)`
  - `rallar.ws.onLifecycle(listener, options?)`
- WS lifecycle events currently include `snapshot`, `connected`, `disconnected`, `open`, `close`, and `error` plus the current status snapshot and close/error metadata.

Proof completed in Iteration 5:

- Controlled facade tests prove `Rallar.disconnect()` disconnects every known RTC peer, including stale-lane peers that are not in the old conservative connected/no-reconnectable-lane set.
- Controlled service tests prove:
  - unexpected WS close reconnects while reconnect is enabled
  - intentional service close suppresses reconnect
  - disabling reconnect stops a pending retry loop before its next socket connect attempt
  - reconnect exhaustion disables automatic reconnect
  - reconnect eligibility suppresses stale reconnect attempts when the session is no longer valid
- Facade tests prove:
  - WS lifecycle/status subscriptions expose current snapshots, connected/disconnected snapshots, unexpected close/error, and intentional disconnect metadata
  - `auth.logout()` after connect uses the queue-box close path, so it inherits reconnect suppression
- Targeted real-server browser proof confirms intentional `rallar.disconnect()` does not background-reconnect and explicit reconnect restores delivery.

Implementation decisions completed:

- `Rallar.disconnect()` uses `knownPeerIds()` for RTC cleanup and closes WS through `WsQueueBoxClientService.close(1000, 'rallar-disconnect')`.
- `WsQueueBoxClientService` exposes reconnect health, bounded reconnect policy, explicit reconnect enable/disable, close-time reconnect suppression, and session-aware reconnect eligibility.
- Browser WS engine gates reconnect on the current auth session.
- Public WS APIs expose `rallar.ws.status()`, `rallar.ws.onStatus(listener, options?)`, and `rallar.ws.onLifecycle(listener, options?)`.

Moved out of Iteration 5:

- Real-browser logout reconnect-suppression proof.
- Real-browser session clear/replacement and no-valid-session stale reconnect proof.
- Real-browser unexpected server/network close reconnect proof.
- Broader live browser/server status artifact capture for non-disconnect scenarios.

These belong in Iteration 10 because they are integration/manual proof work, not additional cleanup implementation.

Verification completed:

- `npm run test -- packages/tests/shared-web/rallar-operation-options.test.ts packages/tests/shared/websocket-webrtc.test.ts packages/tests/shared/ws-qos-policy.test.ts`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
- `npm --workspace rallar-black-box run typecheck`
- `VITE_RALLAR_API_BASE_URL=http://localhost:8080 VITE_RALLAR_ROOM_ID=bb-group VITE_RALLAR_USERNAME=alice VITE_RALLAR_PASSWORD=secret npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts -g "suppresses WS reconnect"`
- `git diff --check`

Targeted real scenario completed:

- Real-server browser test implemented and passing:
  - connect two agents
  - establish RTC
  - call `rallar.disconnect()` in one browser
  - assert no background reconnect occurs
  - assert WS status reports reconnect suppressed after intentional disconnect
  - reconnect intentionally and verify delivery still works

Exit criteria:

- Cleanup behavior is proven before and after any fix.
- Intentional disconnect does not leave hidden peers or background reconnect tasks.
- Focused tests prove logout inherits reconnect suppression; real-browser logout proof is deferred to Iteration 10.
- Applications can subscribe to WS lifecycle callbacks and distinguish intentional close, unexpected close/error, and reconnect-suppressed status.

## Iteration 6: Add Wait APIs For RTC And WS

Goal: implement the obvious missing APIs once status diagnostics are available.

Status: initial facade API implementation completed locally on 2026-05-17. Real-server black-box adoption remains pending.

This iteration does not need proof that the API is missing; that is already clear. It still needs tests proving semantics before broader real-server scenarios depend on it.

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

- `rallar.rtc.waitForLane(peerId, laneId, options)`: implemented
- `rallar.rtc.waitForOpen(peerId, options)`: implemented as a convenience wrapper over the default RTC message lane or a caller-provided `laneId`
- `rallar.rtc.status(options?)`: implemented in Iteration 4
- `rallar.rtc.onStatus(listener)`: implemented in Iteration 4
- `rallar.rtc.waitForPeer(peerId, options)`: deferred until a peer-level readiness contract is needed separately from lane readiness
- `rallar.rtc.connectPeer(peerId, options)`: not added as a public method yet; `waitForLane(..., { connect: true })` provides an explicit opt-in connection path for wait callers

Proposed WS APIs:

- `rallar.ws.status()`: implemented in Iteration 5
- `rallar.ws.waitForOpen(options)`: implemented; this name is preferred over `waitUntilReady` because the state being waited for is specifically WebSocket `open`
- `rallar.ws.onStatus(listener)`: implemented in Iteration 5

Semantics to define:

- timeout behavior: implemented with structured `timeout` results
- abort behavior: implemented for already-aborted waits and abort races
- whether waiting triggers connection or only observes: implemented as observe-only by default; RTC supports explicit `connect: true`
- whether lane wait requires peer connection to be active first: implemented as `no-peer` in observe-only mode, or opt-in connect with `connect: true`
- whether RTC `waitForOpen` waits for peer connection only or data-channel lane open: implemented as lane-open readiness
- return shape for success vs timeout vs aborted vs failed: implemented with `open`, `timeout`, `aborted`, `not-connected`, `closed`, `no-peer`, `no-lane`, and `failed`
- behavior after logout/disconnect: implemented as non-open structured results without restarting WS reconnect or RTC setup unless explicitly requested for RTC

Testing:

- Unit/facade tests for timeout and abort handling: implemented for facade wait APIs.
- Facade tests for wait success/failure using controlled services: implemented.
- Facade tests proving `rallar.ws.waitForOpen()` resolves immediately when already open, resolves when a pending socket opens, returns `closed` for terminal closed state, times out when connecting, returns `aborted`, and does not call connect/reconnect in observe-only mode: implemented.
- Facade tests proving `rallar.rtc.waitForOpen(peerId, { laneId })` delegates to the correct `QRtcDataChannel.waitUntilOpen(timeoutMs)`, returns `no-peer` in observe-only mode, returns `no-lane`, returns `closed`, returns `aborted`, and returns `failed` when opt-in peer connection throws: implemented.
- Real-server two-agent test that waits for RTC lane before sending and proves lower flake rate than optimistic send.
- Real-server test should wait for `rallar.ws.waitForOpen()` after login/connect, then wait for `rallar.rtc.waitForOpen(peerId, ...)` before `messages.rtc` or realtime sends.

Exit criteria:

- Public APIs are documented by tests.
- Real-server test uses wait APIs before sending.

## Iteration 7: RTC Establishment Timeout And Retry Policy

Goal: add explicit timeouts only where tests prove indefinite or unclear waits.

Status: started on 2026-05-17. Initial deterministic proof, browser policy wiring, explicit start/open service APIs, and generic watchdog command extraction are implemented; real-server failure proofs remain pending.

Proof work:

- Use diagnostics from Iterations 1 and 6 to detect:
  - signaling sent but no answer
  - ICE candidates exchanged but no connected state
  - data channel never opens
  - reconnect attempts exhausted without service-level cleanup
- Add deterministic tests using fake/stub signaling and peer wrappers where possible: initial tests added for a peer that remains in setup until timeout, a peer whose lane opens before the deadline, explicit lane-open success, missing lane, timeout, abort, and opt-in cleanup.

Potential implementation after proof:

- Add configurable timeout policy for:
  - peer establishment timeout covering the current "created/connecting but no open connection or lane" case: implemented in `WebRtcConnectionService`, policy-gated, browser-enabled at 30 seconds
  - signaling answer wait: still pending; may become a separate diagnostic once real signaling timings are captured
  - peer connected wait: partially covered by peer establishment timeout; more granular connection-state deadline still pending
  - lane open wait: already bounded through `QRtcDataChannel.waitUntilOpen(...)`, public Rallar wait APIs, and the new `WebRtcConnectionService.ensurePeerLaneOpen(...)` service API
  - reconnect total elapsed time: still pending
- Surface timeout events through lifecycle/status APIs: initial Rallar lifecycle event `peer-timeout` implemented.
- On reconnect exhaustion, notify `WebRtcConnectionService` so it can remove or recreate the peer DTO.
- Naming cleanup: `ensurePeerConnectionStarted(...)` now describes the start-only behavior and returns synchronously. The older `connectToPeerIfAbsent(...)` remains as a deprecated compatibility alias.
- Pull/push command proof: `PullPushCommand` now lives in `packages/shared/cache/PullPushCommand.ts`, supports RTC-like start-then-wait workflows, and `CommandsOrchestrator.pullPushCommandStep(...)` can host the same pattern when orchestration wants to store the pushed value.
- Watchdog extraction: peer establishment timeout maps/timer ownership moved out of `WebRtcConnectionService` and into reusable `AsyncCommand` in `packages/shared/cache/AsyncCommand.ts`, which watches keyed async resources, cancels/completes pending watches, replaces stale watches by key, and routes timeout cleanup errors.
- Rallar facade adoption: `rallar.rtc.waitForLane(..., { connect: true })`, `rallar.rtc.waitForOpen(..., { connect: true })`, `rallar.realtime.sendJson(...)`, and `rallar.realtime.sendBinary(...)` now use `WebRtcConnectionService.ensurePeerLaneOpen(...)` internally. Observe-only RTC waits keep their local read-only path and do not start peers.
- Room-level readiness: `rallar.rtc.waitForRoomLane(roomId, laneId, options)` resolves room peers, excludes the current session, and returns `ready` and `notReady` peer result lists for game/lobby warmup flows.

Testing:

- `packages/tests/shared/webrtc-connection-service.test.ts` now proves timeout eviction, timeout clearing on lane open, synchronous start-only behavior, explicit lane-open readiness, missing lane, timeout, abort, and opt-in cleanup.
- `packages/tests/shared/command.test.ts` now covers additional `Command` retry/fallback behavior, `PullPushCommand` fallback/null-push cases, and `AsyncCommand` timeout/cancel/replacement/error-routing behavior.
- `packages/tests/shared/commands-orchestrator.test.ts` now covers `pullPushCommandStep(...)` and trailing `then(...)` callbacks.
- `packages/tests/shared-web/rallar-operation-options.test.ts` now proves Rallar forwards service timeout callbacks through `rallar.rtc.onLifecycle(...)`.

Real scenario testing:

- Use a real server with controlled bad conditions where practical:
  - one agent closes during setup
  - one agent reloads during setup
  - one agent loses WS signaling during RTC negotiation if test infrastructure can simulate it
- Assert the caller receives timeout/failure status instead of silent hanging or optimistic success.

Exit criteria:

- Timeout behavior is visible and covered by deterministic tests: partially complete for peer establishment timeout.
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

## Iteration 10: Manual Real-browser/server Integration Proofs

Goal: collect live browser/server scenarios that are valuable but too environment-dependent to block the focused implementation iterations, then graduate stable scenarios into automated integration tests.

This iteration is deliberately separate from Iteration 5. Iteration 5 owns the implementation and focused proof for WS reconnect cleanup. Iteration 10 owns live verification across real browsers, API server, control server, auth/session state, and RTC/WS timing.

Manual-first scenarios:

- Logout after connect:
  - connect two real browser agents
  - establish RTC delivery
  - call `rallar.auth.logout()` in one browser
  - assert WS reconnect remains suppressed
  - assert delivery only resumes after explicit login/connect
- Session clear/replacement:
  - connect a real browser agent
  - clear or replace the stored auth session while the socket callback path is still present
  - close the WS unexpectedly
  - assert stale reconnect is suppressed because `readSession()?.sessionId` no longer matches the original client session
- Unexpected server/network close while logged in:
  - connect a real browser agent
  - simulate server-side WS close or network loss where practical
  - assert reconnect is attempted while the browser still has a valid matching session
  - assert reconnect exhaustion becomes visible if the server remains unavailable past the configured attempt budget
- Broader status artifacts:
  - capture `rallar.ws.status()`, `rallar.rtc.status(...)`, lifecycle events, peer IDs, lane IDs, room ID, message IDs, route decisions, reconnect attempts, and enqueue/send outcomes as Playwright artifacts.

Integration-test graduation path:

- Start as manual or explicitly tagged Playwright tests that require local `apps/api-v1`, the black-box control server, and real credentials/session fixtures.
- Stabilize waits with Iteration 6 wait APIs instead of sleeps or optimistic sends.
- Promote scenarios to automated integration runs only after they are deterministic enough to diagnose without local observation.
- Keep unstable environment/failure-injection scenarios as manual runbook tests until the control server can simulate the failure deterministically.

Recommended commands:

- `npm run start:rallar-black-box:api-v1`
- `npm run start:rallar-black-box:control-server`
- `VITE_RALLAR_API_BASE_URL=http://localhost:8080 VITE_RALLAR_ROOM_ID=bb-group VITE_RALLAR_USERNAME=alice VITE_RALLAR_PASSWORD=secret npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts`

Exit criteria:

- Each manual scenario has a repeatable runbook and artifact expectations.
- At least logout-after-connect and session-replacement reconnect suppression are captured as runnable Playwright scenarios.
- Stable scenarios are tagged or moved into the integration suite with clear environment requirements.
- Flaky scenarios remain documented as manual-only until deterministic failure injection exists.

## Release Gates

Before considering the task set complete:

- Unit and integration tests prove each confirmed issue and each fix.
- Manual real-browser/server scenarios from Iteration 10 have either graduated to integration tests or are documented as intentionally manual with runbook evidence.
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
11. Manual real-browser/server proofs and integration-test graduation.
