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
| 2: IndexedDB growth and session isolation proof | Not started | Next evidence-first storage iteration. |

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

- Add explicit cleanup helpers for browser AL runtime prefixes.
- Add logout/session-replacement cleanup.
- Add startup/background expired-row sweep for `ar-eye-hunter-al-runtime.entries`.

Testing:

- Fake IndexedDB unit/integration tests for provider and AL runtime stores.
- Browser facade logout test proving cleanup behavior after it is implemented.
- Optional real-browser storage diagnostic in black-box app to count rows by prefix before and after logout.

Exit criteria:

- The exact storage risk is documented as one of:
  - confirmed storage bloat only
  - confirmed same-session stale read
  - confirmed cross-session read
  - not reproducible with current code
- Cleanup is only implemented for confirmed or policy-decided risks.

## Iteration 3: Prove `enqueueOutboxIfAbsent()` Quiet Outcomes

Goal: classify all `messages.rtc.send()` outcomes before changing the API.

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
- Add a facade-level test proving `Rallar.messages.rtc.send()` currently returns an `ALMessage` even when lower layers produce no outbox entries.

Potential implementation after proof:

- Add `sendWithResult()` for `messages.rtc`.
- Add result statuses such as:
  - `accepted`
  - `enqueued`
  - `sent-immediate`
  - `skipped`
  - `duplicate`
  - `superseded`
  - `expired`
  - `no-route`
  - `failed`
- Keep existing `send()` behavior initially for compatibility.
- Align `messages.ws` with the same outcome shape after RTC result mapping is proven.

Real scenario testing:

- Run two-agent real-server scenarios for successful `messages.rtc`.
- Add a real-server scenario where one peer is absent/disconnected and assert the new result exposes `no-route` or `skipped`.
- Record message ID, target room, next hop, known peers, connected peers, and lane states.

Exit criteria:

- Each quiet/ambiguous outcome has a deterministic test.
- New result API is backed by tests and real-server evidence.

## Iteration 4: Prove Data-channel Reuse And Closed-channel Behavior

Goal: confirm whether stale `RTCDataChannel` reuse causes false closed results, hidden peers, or reconnect failure.

Proof work:

- Add `QRtcDataChannel` tests for:
  - `onclose` leaves `status.dc` pointing to a closed channel
  - `waitUntilOpen()` returns false immediately for stale closed `dc`
  - `connect()` after close behaves differently for initiator and receiver roles
  - `reset()` clears `status.dc`
- Add `WebRtcConnectionService` tests proving how `connectedPeerIds()` behaves when:
  - peer connection is connected and all lanes are open
  - one lane is closed/failed
  - reliable lane is open but realtime lane is closed
  - peer connection is reset after reconnect exhaustion

Potential implementation after proof:

- Clear or replace stale `status.dc` on close/error.
- Make `waitUntilOpen()` wait for an in-progress replacement channel instead of short-circuiting on the old closed channel.
- Split peer-level health from lane-level readiness.
- Replace or supplement `connectedPeerIds()` with explicit APIs:
  - `knownPeerIds()`
  - `activePeerIds()`
  - `readyPeerIdsForLane(laneId)`

Real scenario testing:

- Two-agent real-server test:
  - connect both clients
  - send realtime JSON successfully
  - force one browser/client disconnect or reload
  - reconnect
  - send realtime JSON again
  - send `messages.rtc` again
  - assert status/lane transitions and delivery

Exit criteria:

- The stale-channel hypothesis is either proven with failing tests or dismissed.
- Any behavior change has unit tests plus at least one real-server reconnect scenario.

## Iteration 5: Prove `disconnect()` And WS Reconnect Cleanup Behavior

Goal: prove whether intentional disconnect leaves RTC peers alive or triggers unwanted WS reconnect.

Proof work:

- Add tests around `Rallar.disconnect()` with a controlled `WebRtcConnectionService` where:
  - all peers are healthy
  - one peer has a closed lane and is excluded from `connectedPeerIds()`
  - one peer is known but not currently connected
- Verify which peers are disconnected.
- Add tests for `WsQueueBoxClientService.enableReconnect()` and intentional `JsonWebSocketClient.close(1000, 'rallar-disconnect')`.

Potential implementation after proof:

- Add `allPeerIds()` or use `readAllPeerHealth()` to disconnect every known peer.
- Add explicit reconnect suppression/disable path for intentional `Rallar.disconnect()`.
- Make reconnect state visible through WS diagnostics.

Real scenario testing:

- Real-server browser test:
  - connect two agents
  - establish RTC
  - call `rallar.disconnect()` in one browser
  - assert no background reconnect occurs
  - assert remote side observes expected close/disconnect state
  - reconnect intentionally and verify delivery still works

Exit criteria:

- Cleanup behavior is proven before and after any fix.
- Intentional disconnect does not leave hidden peers or background reconnect tasks.

## Iteration 6: Add Wait APIs For RTC And WS

Goal: implement the obvious missing APIs once status diagnostics are available.

This iteration does not need proof that the API is missing; that is already clear. It still needs tests proving semantics.

Proposed RTC APIs:

- `rallar.rtc.waitForPeer(peerId, options)`
- `rallar.rtc.waitForLane(peerId, laneId, options)`
- `rallar.rtc.connectPeer(peerId, options)`
- `rallar.rtc.status(options?)`
- `rallar.rtc.onStatus(listener)`

Proposed WS APIs:

- `rallar.ws.status()`
- `rallar.ws.waitUntilReady(options)`
- `rallar.ws.onStatus(listener)`

Semantics to define:

- timeout behavior
- abort behavior
- whether waiting triggers connection or only observes
- whether lane wait requires peer connection to be active first
- return shape for success vs timeout vs aborted vs failed

Testing:

- Unit tests for timeout and abort handling.
- Facade tests for wait success/failure using controlled services.
- Real-server two-agent test that waits for RTC lane before sending and proves lower flake rate than optimistic send.

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
