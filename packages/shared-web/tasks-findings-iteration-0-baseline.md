# Iteration 0 Baseline Report

Date: 2026-05-16

Source plan: `packages/shared-web/tasks-findings-implementation-plan.md`

Iteration 0 goal: make the current RTC, WS, and IndexedDB behavior measurable before fixing suspected issues.

## Summary

Local baseline checks passed. The existing full-stack real-server Playwright suite also passed against a local `apps/api-v1` server, control server, and Vite app.

The real-server two-agent browser-rallar smoke now also passes when run with API/control services plus the required room and login environment. That gives Iteration 0 baseline coverage for both `realtime` and `messages.rtc` delivery between two real browser agents.

## Commands Run

### Shared-web Typecheck

```sh
npm --workspace @ar-eye-hunter/shared-web run typecheck
```

Result: passed.

### Targeted Unit Baseline

```sh
npm run test -- \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts \
  packages/tests/shared/qrtc-data-channel.test.ts \
  packages/tests/shared/webrtc-connection-service.test.ts
```

Result: passed.

Observed result:

- 3 test files passed
- 27 tests passed
- `al-indexeddb-runtime-stores.test.ts`: 12 tests
- `qrtc-data-channel.test.ts`: 10 tests
- `webrtc-connection-service.test.ts`: 5 tests

### Targeted Full-stack Manual Realtime

```sh
npm run test:e2e:rallar-black-box:full-stack:real:manual
```

First sandboxed attempt failed because the sandbox could not bind the local API server port. The command was rerun with permission to start local servers.

Result after rerun: passed.

Observed result:

- 1 Playwright test passed
- Test: `full-stack Manual Rallar realtime delivery > two browsers send real realtime JSON through Manual Rallar`
- The run started:
  - `apps/api-v1` on `http://localhost:8080`
  - control server on `http://localhost:5180`
  - black-box app on `http://localhost:5176`
- The test exercised two browser contexts, real API login, real realtime delivery, event-stream evidence, and manual close of both Rallar connections.

Observed server warnings:

- The API logged `Unauthorized: Invalid or expired websocket auth ticket` twice during the run.
- The Playwright test still passed. This warning should be tracked as diagnostic noise or a real auth-ticket lifecycle issue in a later iteration.

### Full-stack Real Suite

```sh
npm run test:e2e:rallar-black-box:full-stack:real
```

Result: passed.

Observed result:

- 3 Playwright tests passed
- `full-stack control orchestration`: passed
- `full-stack Rallar Server REST workbench`: passed
- `full-stack Manual Rallar realtime delivery`: passed

Observed server warnings:

- The same `Unauthorized: Invalid or expired websocket auth ticket` warnings appeared during the manual realtime test.

### Existing Two-agent Browser-rallar Smoke Against Real API

The smoke was rerun with the required real services and the required room/login environment:

```sh
npm run start:rallar-black-box:api-v1
npm run start:rallar-black-box:control-server
```

In another shell:

```sh
VITE_RALLAR_API_BASE_URL=http://localhost:8080 \
VITE_RALLAR_ROOM_ID=bb-group \
VITE_RALLAR_USERNAME=alice \
VITE_RALLAR_PASSWORD=secret \
  npx playwright test \
  --config apps/rallar-black-box/playwright.config.ts \
  tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts
```

Result: passed.

Observed result:

- 2 Playwright tests passed.
- `browser-rallar provider delivers realtime payloads between two real agents`: passed in 5.6 seconds.
- `browser-rallar provider delivers messages.rtc payloads between two real agents`: passed in 9.8 seconds.
- Total run time: 16.2 seconds.

Observed diagnostic noise:

- Vite/browser console logged mismatched data-channel labels for `rtc-data-channel` vs `rtc-realtime`.
- Vite/browser console logged data-channel close events during cleanup.
- Vite/browser console logged `Signaling transport error: [object Event]` during cleanup.
- The run still passed; these should be treated as Iteration 0 diagnostic signals rather than delivery failures.

## Existing Test Inventory

### IndexedDB And AL Runtime

- `packages/tests/shared/al-indexeddb-runtime-stores.test.ts`
  - Covers IndexedDB AL runtime stores, shared DB/store usage, durable effects, outbound effects after restart, and IndexedDB runtime state.
- `packages/tests/shared/al-durable-runtime.test.ts`
  - Covers durable AL runtime behavior more generally.
- `packages/tests/shared/al-inbound-message-runtime.test.ts`
  - Covers inbound AL runtime behavior.
- `packages/tests/shared/al-outbound-message-runtime.test.ts`
  - Covers outbound AL runtime behavior.

Current Iteration 0 gap:

- No focused browser AL runtime test proves old session prefixes remain until cleanup.
- No test currently reports row counts by `ar-eye-hunter-al-runtime.entries` namespace/prefix.

### RTC Wrapper And Connection Service

- `packages/tests/shared/qrtc-data-channel.test.ts`
  - Covers initiator channels, receiver-side channels, mismatched labels, wait-until-open, timeouts, flow control, raw messages, and health.
- `packages/tests/shared/qrtc-peer-connection.test.ts`
  - Covers peer connection behavior.
- `packages/tests/shared/webrtc-connection-service.test.ts`
  - Covers signaling routing, peer creation, reconnectable stale channels, lanes, and peer health.
- `packages/tests/shared/webrtc-group-manager.test.ts`
  - Covers group-to-peer connection management.
- `packages/tests/shared/webrtc-overlay-services.test.ts`
  - Covers overlay routing behavior.
- `packages/tests/shared/webrtc-rx-streamer-service.test.ts`
  - Covers RTC receive streamer behavior.

Current Iteration 0 gap:

- Existing unit tests already show reconnectable stale channels affect `connectedPeerIds()`, but they do not fully prove stale browser `RTCDataChannel` reuse after normal `onclose`/`onerror`.
- No real-server reconnect/reload baseline is captured yet.

### Browser Rallar Facade

- `packages/tests/shared-web/rallar-operation-options.test.ts`
  - Covers operation options, realtime send, lane open waiting, closed-lane send result, listener registration, and realtime health.
- `packages/tests/shared-web/rallar-message-selectors.test.ts`
  - Covers message selector behavior.
- `packages/tests/shared-web/rallar-data.test.ts`
  - Covers browser data storage behavior.

Current Iteration 0 gap:

- No facade-level test yet proves `messages.rtc.send()` returns success while lower layers skip or return no entries.
- No public `Rallar.rtc` wait/status API exists yet.

### Real Browser And Full-stack Tests

- `tests/playwright/rallar-black-box/full-stack-manual-rallar-realtime.spec.ts`
  - Passed in this baseline.
  - Covers two browsers, real API, real realtime delivery, event evidence, and manual close.
- `tests/playwright/rallar-black-box/full-stack-rest-workbench.spec.ts`
  - Passed in this baseline.
  - Covers real API login and authenticated REST requests.
- `tests/playwright/rallar-black-box/full-stack-control-orchestration.spec.ts`
  - Passed in this baseline.
  - Covers control-agent command execution and telemetry storage.
- `tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts`
  - Passed in this baseline when run with API/control services plus room/login environment.
  - Covers both `realtime` and `messages.rtc` delivery between two browser-rallar agents.
- `tests/playwright/rallar-black-box/browser-rallar-real-smoke.spec.ts`
  - Existing one-agent real-provider smoke.

## Baseline Coverage Matrix

| Behavior | Baseline status | Evidence |
| --- | --- | --- |
| Shared-web typecheck | Passed | `npm --workspace @ar-eye-hunter/shared-web run typecheck` |
| IndexedDB AL runtime unit coverage | Passed existing tests | 12 tests in `al-indexeddb-runtime-stores.test.ts` |
| Data-channel wrapper unit coverage | Passed existing tests | 10 tests in `qrtc-data-channel.test.ts` |
| WebRtcConnectionService unit coverage | Passed existing tests | 5 tests in `webrtc-connection-service.test.ts` |
| Real API plus control plus SPA startup | Passed | full-stack real suite |
| First real RTC realtime delivery | Passed | full-stack manual realtime test |
| Manual close/disconnect cleanup | Partially passed | full-stack manual realtime closes both Manual Rallar connections |
| `messages.rtc` real delivery | Passed | two-agent browser-rallar smoke with `VITE_RALLAR_ROOM_ID=bb-group` |
| Reconnect after browser close/reload | Not baselined | no current run exercises reconnect/reload |
| Logout cleanup | Not baselined | manual close is covered, auth logout is not |
| Quiet RTC enqueue outcomes | Not baselined | needs focused lower-layer/facade tests |

## Reproducible Real-server Runbook

### Full-stack Real Baseline

Use this first. It starts the API, control server, and app through Playwright web servers.

```sh
npm run test:e2e:rallar-black-box:full-stack:real
```

Targeted manual realtime only:

```sh
npm run test:e2e:rallar-black-box:full-stack:real:manual
```

### Existing Two-agent Realtime And `messages.rtc` Smoke

Current status: passing when API/control services are started and room/login environment is provided.

Run sequence used for this baseline:

```sh
npm run start:rallar-black-box:api-v1
npm run start:rallar-black-box:control-server
```

In another shell:

```sh
VITE_RALLAR_API_BASE_URL=http://localhost:8080 \
VITE_RALLAR_ROOM_ID=bb-group \
VITE_RALLAR_USERNAME=alice \
VITE_RALLAR_PASSWORD=secret \
  npx playwright test \
  --config apps/rallar-black-box/playwright.config.ts \
  tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts
```

Expected current result:

- 2 tests pass:
  - realtime delivery between two real browser-rallar agents
  - `messages.rtc` delivery between two real browser-rallar agents

Recommended next step:

- Keep this command in the Iteration 0 runbook.
- Consider adding a package script so the required environment is harder to omit.

## Missing Observability Blocking Later Iterations

The current tests can prove delivery, but they do not emit enough structured lifecycle data to diagnose flaky RTC setup.

Missing or insufficient fields:

- known peer IDs vs connected peer IDs vs lane-ready peer IDs
- peer connection state timeline
- data-channel lane state timeline
- browser `RTCDataChannel.readyState`
- offer/answer sent/received timestamps
- ICE candidate sent/received counts
- ICE connection state timeline
- reconnect attempt count and final outcome
- RTC send route decision
- RTC enqueue outcome: enqueued, immediate, skipped, duplicate, superseded, expired, no route, failed
- IndexedDB AL runtime row counts by namespace/prefix
- expired vs unexpired row counts
- logout/session replacement cleanup counts

## Iteration 0 Next Steps

1. Add a reconnect/reload real-server baseline:
   - connect two browsers
   - send realtime
   - reload or close one browser
   - reconnect
   - send realtime again
   - send `messages.rtc`
2. Add focused tests proving old IndexedDB AL runtime prefixes are retained until cleanup.
3. Add focused tests around `messages.rtc.send()` and lower-layer enqueue outcomes before changing send behavior.
4. Consider turning the two-agent real-server command into a root package script with the required env documented.
