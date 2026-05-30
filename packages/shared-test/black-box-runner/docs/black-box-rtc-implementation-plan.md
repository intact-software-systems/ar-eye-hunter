# Black-box RTC Browser Implementation Plan

## Goal

Build a browser-backed RTC test mode for the black-box runner.

The runner should be able to:

- start one or more headless browser instances
- connect each browser to a deployed Rallar REST API and signaling server
- execute configured RTC communication steps
- collect browser-side RTC events and diagnostics
- return the normal black-box runner report

At first this is for headless runs only. A visible SPA/debug UI can come later, but the first implementation should still be structured as a small browser runtime that the runner can drive.

## Direction

Use Rallar as the real WebRTC bridge.

Do not reimplement WebRTC negotiation, ICE, peer lifecycle, data-channel lifecycle, room membership, or Rallar routing in the black-box runner.

The runner should orchestrate and report:

```text
black-box-runner
    -> RTC provider contract
        -> browser-backed Rallar provider
            -> headless browser page
                -> browser-side black-box runtime
                    -> existing Rallar browser facade
```

## Provider Strategy

Keep the existing providers:

| Provider | Role |
| --- | --- |
| `rallar-stub` | Fast fake provider for parser and runner smoke tests. |
| `rallar-memory` | Deterministic in-memory multi-peer provider for runner semantics. |
| `rallar` | Current WebSocket signaling-only provider. Do not promote yet. |

Add a new opt-in real provider:

```text
rallar-browser
```

Candidate factory:

```ts
createRallarBrowserRtcProvider()
```

The provider should plug into the existing runtime seam:

```ts
createRallarWebRtcProvider({
  createSession: async (args, dispatcher) => {
    // start/reuse browser page
    // call browser-side connect
    // wire browser events into dispatcher
    return {
      send: message => browserSession.send(message),
      close: () => browserSession.close(),
    }
  },
})
```

This keeps `rtc-provider.ts` as the report facade and `rallar-webrtc-runtime.ts` as the session facade.

## Browser Runtime

Add a small browser-side runtime that exposes a narrow API to Playwright:

```ts
connect(config): Promise<ConnectDiagnostics>
send(message): Promise<SendDiagnostics>
close(): Promise<CloseDiagnostics>
health(): Promise<HealthDiagnostics>
```

It should push asynchronous events back to the runner:

```ts
onMessage(message)
onClose(event)
onDiagnostic(event)
```

The browser runtime should use the existing Rallar browser facade:

```ts
rallar.configure({ apiBaseUrl })
await rallar.auth.login(...)
await rallar.connect(...)
await rallar.rooms.join(roomId)
```

Then it should choose the configured transport:

```ts
rallar.realtime
```

or:

```ts
rallar.messages.rtc
```

## Transport Modes

The selected Rallar RTC surface should be a config option.

Recommended field:

```json
{
  "rallar": {
    "transport": "realtime"
  }
}
```

Supported values:

| Value | Meaning |
| --- | --- |
| `realtime` | Use `rallar.realtime.sendJson`, `onJson`, health, and direct data-channel lanes. |
| `messages.rtc` | Use `rallar.messages.rtc.send` and `onMessage` for Rallar AL room/multicast behavior. |

Use `realtime` to test raw browser WebRTC data-channel readiness and peer-to-peer payload delivery.

Use `messages.rtc` to test Rallar app-level room, overlay, routing, type ID, and AL message semantics.

## Initial Config Shape

Example:

```json
{
  "connections": {
    "aliceRtc": {
      "type": "rtc",
      "provider": "rallar-browser",
      "actor": "alice",
      "peerId": "alice-session-id",
      "remotePeerId": "bob-session-id",
      "roomId": "room-1",
      "browser": {
        "headless": true,
        "baseUrl": "https://app.example.com"
      },
      "rallar": {
        "apiBaseUrl": "https://api.example.com",
        "username": "alice",
        "password": "secret",
        "transport": "realtime",
        "laneId": "realtime",
        "openTimeoutMs": 5000
      }
    },
    "bobRtc": {
      "type": "rtc",
      "provider": "rallar-browser",
      "actor": "bob",
      "peerId": "bob-session-id",
      "remotePeerId": "alice-session-id",
      "roomId": "room-1",
      "browser": {
        "headless": true,
        "baseUrl": "https://app.example.com"
      },
      "rallar": {
        "apiBaseUrl": "https://api.example.com",
        "username": "bob",
        "password": "secret",
        "transport": "realtime",
        "laneId": "realtime",
        "openTimeoutMs": 5000
      }
    }
  },
  "steps": [
    {
      "name": "connectAlice",
      "type": "rtc.connect",
      "connection": "aliceRtc"
    },
    {
      "name": "connectBob",
      "type": "rtc.connect",
      "connection": "bobRtc"
    },
    {
      "name": "aliceSendsToBob",
      "type": "rtc.send",
      "connection": "aliceRtc",
      "request": {
        "send": {
          "data": {
            "text": "hello bob"
          }
        }
      },
      "expect": {
        "connection": "bobRtc",
        "withinMs": 5000,
        "message": {
          "data": {
            "text": "hello bob"
          }
        }
      }
    }
  ]
}
```

The exact auth shape can change, but the connection config should keep browser setup, Rallar setup, and transport selection separate.

## Connect Semantics

For `rallar-browser`, `rtc.connect` should not mean only "page loaded" or "signaling socket opened".

Recommended semantics:

| Transport | `rtc.connect` should complete when |
| --- | --- |
| `realtime` | Rallar is connected, room is joined, target peer is connected or connectable, the configured lane is open or `waitUntilOpen` succeeds. |
| `messages.rtc` | Rallar is connected, room is joined, RTC subscription is installed, and the peer/routing state needed for room delivery is ready. |

If readiness cannot be fully proven, report that explicitly:

```json
{
  "topic": "rallar.browser.connected",
  "connection": "aliceRtc",
  "transport": "realtime",
  "rallarConnected": true,
  "roomJoined": true,
  "peerId": "alice-session-id",
  "remotePeerId": "bob-session-id",
  "laneId": "realtime",
  "dataChannelReadyState": "open"
}
```

## Report Diagnostics

The provider should emit normalized diagnostics through the existing dispatcher.

Message event shape:

```json
{
  "topic": "rallar.browser.rtc.message",
  "transport": "realtime",
  "connection": "bobRtc",
  "actor": "bob",
  "peerId": "bob-session-id",
  "remotePeerId": "alice-session-id",
  "roomId": "room-1",
  "laneId": "realtime",
  "data": {
    "text": "hello bob"
  }
}
```

Close/error event shape:

```json
{
  "phase": "data-channel",
  "reason": "channel closed",
  "closedBy": "rallar-browser-runtime",
  "connection": "aliceRtc",
  "actor": "alice",
  "peerId": "alice-session-id",
  "remotePeerId": "bob-session-id",
  "roomId": "room-1",
  "transport": "realtime",
  "laneId": "realtime",
  "health": {}
}
```

Failure reports should preserve the existing top-level black-box result categories:

- `RTC connect failed`
- `RTC send failed`
- `RTC close failed`
- `Expected RTC message was not received`

Provider-specific details should go in `actual`.

## Implementation Iterations

### Iteration 1: Browser Runtime Spike

Create a minimal browser runtime page or script that can be loaded by Playwright.

It should:

- configure Rallar
- log in
- connect
- join a room
- install one `realtime` JSON listener
- send one JSON message
- expose health diagnostics

Expected result:

```text
Two manually controlled headless pages can exchange one realtime JSON message through deployed Rallar services.
```

Current iteration 1 artifact:

| File | Purpose |
| --- | --- |
| `browser/rallar-browser-harness.html` | Minimal page served by Vite for the headless browser. |
| `browser/rallar-browser-runtime.ts` | Browser-side API exposed as `window.__blackBoxRallar`. |
| `browser/rallar-browser-spike.mts` | Node/Playwright driver that starts the harness, opens one page per connection, runs RTC steps, and prints a JSON report. |
| `browser/rallar-browser-spike.example.json` | Two-peer realtime example using environment variables for deployed Rallar credentials and room ID. |

Run shape:

```bash
tsx packages/shared-test/black-box-runner/browser/rallar-browser-spike.mts \
  --config packages/shared-test/black-box-runner/browser/rallar-browser-spike.example.json
```

Required environment variables for the example:

- `RALLAR_API_BASE_URL`
- `RALLAR_ROOM_ID`
- `RALLAR_ALICE_USERNAME`
- `RALLAR_ALICE_PASSWORD`
- `RALLAR_BOB_USERNAME`
- `RALLAR_BOB_PASSWORD`

Iteration 1 deliberately does not register `rallar-browser` as a first-class RTC provider yet. It validates the browser/Rallar/WebRTC bridge first, then iteration 2 can wrap the same runtime behind `rtc-provider.ts` and `rallar-webrtc-runtime.ts`.

Readiness note: the spike completes `rtc.connect` after Rallar is authenticated, connected, the room join succeeds, and the realtime listener is installed. It passes the target browser session ID into `rallar.realtime.sendJson` from `expect.connection`, so lane-open readiness is proven during `rtc.send` rather than during `rtc.connect`.

### Iteration 2: Playwright-backed Provider Skeleton

Add:

```text
rallar-browser-rtc-provider.ts
```

Register it as:

```text
rallar-browser
```

The first provider can support only:

- `rtc.connect`
- `rtc.close`
- dry-run compatibility

Expected result:

```text
The default report includes rallar-browser in rtcProviderNames.
```

Current iteration 2 artifact:

| File | Purpose |
| --- | --- |
| `rallar-browser-rtc-provider.ts` | RTC provider wrapper that starts/reuses Playwright Chromium and the Vite browser harness, then delegates to `window.__blackBoxRallar`. |
| `execute-black-box.ts` | Registers `rallar-browser` in the default RTC provider registry. |
| `examples/rtc-rallar-browser-connect.json` | Provider-mode connect/close example for deployed Rallar services. |

Provider notes:

- Playwright/Vite imports are lazy, so dry-run and non-browser providers do not load browser tooling.
- Dry-run remains handled by `executeRtcInteraction`, so `rallar-browser` is listed without launching Chromium.
- The provider currently emits browser runtime diagnostics into `rtcMessages` and close events into `rtcCloseEvents`.
- Realtime `send` is wired through the runtime but still considered spike-level until Iteration 4 hardens target resolution and expectations.

### Iteration 3: Event Bridge

Wire browser events into the existing black-box dispatcher.

Use Playwright `page.exposeFunction` or equivalent to push events from the browser page back to Deno.

Expected result:

```text
Browser-side messages appear in report.rtcMessages[connectionName].
Browser-side close/errors appear in report.rtcCloseEvents[connectionName].
```

Current iteration 3 artifact:

| File | Purpose |
| --- | --- |
| `rallar-browser-rtc-provider.ts` | Accepts injectable browser dependencies for deterministic provider tests and forwards `window.__blackBoxRallarEmit` events into the RTC dispatcher. |
| `packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts` | Adds a fake-browser provider test proving runtime diagnostics/messages land in `rtcMessages` and runtime/provider close events land in `rtcCloseEvents`. |

Bridge event shape in the report:

```json
{
  "rtcMessages": {
    "aliceRtc": [
      {
        "data": {
          "kind": "message",
          "topic": "rallar.browser.realtime.message",
          "connection": "aliceRtc",
          "actor": "alice",
          "provider": "rallar-browser",
          "roomId": "room-1",
          "laneId": "realtime",
          "data": {
            "text": "hello from browser"
          }
        }
      }
    ]
  }
}
```

Close events are routed through the existing RTC close event store, so `rtc.wait` with `expect.close` can match browser runtime close events.

### Iteration 4: Realtime Transport

Implement:

- `transport: "realtime"`
- `rallar.realtime.onJson`
- `rallar.realtime.sendJson`
- lane ID config
- open timeout config
- health diagnostics

Expected result:

```text
A two-browser realtime send/wait scenario passes against deployed Rallar services.
```

Current iteration 4 artifact:

| File | Purpose |
| --- | --- |
| `rallar-browser-rtc-provider.ts` | Stores browser connect diagnostics per connection and resolves `expect.connection`/`onConnection` to the target browser's real Rallar `sessionId` before `sendJson`. |
| `rtc-provider.ts` | Passes the current RTC interaction/config/context as optional args to `RtcClient.send`, keeping existing providers compatible while allowing provider-specific send routing. |
| `browser/rallar-browser-runtime.ts` | Treats arbitrary objects, including objects with a `payload` field, as the realtime message data unless they include explicit send-control fields such as `data`, `peerIds`, `roomId`, or `laneId`. |
| `examples/rtc-rallar-browser-realtime.json` | Provider-mode two-browser realtime send/wait example. |
| `packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts` | Adds a fake-browser test proving `expect.connection: "bobRtc"` becomes `peerIds: ["bob-rallar-session"]`. |

Provider-mode realtime send semantics:

```json
{
  "type": "rtc.send",
  "connection": "aliceRtc",
  "request": {
    "send": {
      "data": {
        "text": "hello bob"
      }
    }
  },
  "expect": {
    "connection": "bobRtc",
    "message": {
      "kind": "message",
      "topic": "rallar.browser.realtime.message",
      "data": {
        "text": "hello bob"
      }
    }
  }
}
```

The provider uses Bob's stored `connectDiagnostics.sessionId` as the `peerIds` value passed to the browser runtime. This keeps scenario authors from hardcoding volatile Rallar session IDs.

### Iteration 5: Messages RTC Transport

Implement:

- `transport: "messages.rtc"`
- `rallar.messages.rtc.onMessage`
- `rallar.messages.rtc.send`
- type ID config
- topic/context/resource config
- room/overlay config

Expected result:

```text
A two-browser app-level RTC message scenario passes against deployed Rallar services.
```

Current iteration 5 artifact:

| File | Purpose |
| --- | --- |
| `browser/rallar-browser-runtime.ts` | Supports `transport: "messages.rtc"` using `rallar.messages.rtc.onMessage` and `rallar.messages.rtc.send`. |
| `rallar-browser-rtc-provider.ts` | Resolves target browser connections to `nextHopPeerIds` for `messages.rtc`, while preserving `peerIds` for `realtime`. |
| `packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts` | Adds a fake-browser provider test proving `expect.connection: "bobRtc"` becomes `nextHopPeerIds: ["bob-rallar-session"]`. |

Provider-mode `messages.rtc` config:

```json
{
  "connections": {
    "aliceRtc": {
      "type": "rtc",
      "provider": "rallar-browser",
      "roomId": "room-1",
      "rallar": {
        "apiBaseUrl": "https://api.example.com",
        "username": "alice",
        "password": "secret",
        "transport": "messages.rtc",
        "typeId": "chat.message",
        "topicId": "chat"
      }
    }
  }
}
```

Send shape:

```json
{
  "type": "rtc.send",
  "connection": "aliceRtc",
  "request": {
    "send": {
      "payload": {
        "text": "hello bob"
      }
    }
  },
  "expect": {
    "connection": "bobRtc",
    "message": {
      "kind": "message",
      "topic": "rallar.browser.messages.rtc.message",
      "typeId": "chat.message",
      "topicId": "chat",
      "data": {
        "text": "hello bob"
      }
    }
  }
}
```

The provider uses Bob's stored `connectDiagnostics.sessionId` as `nextHopPeerIds`, so scenario files still use stable connection names rather than volatile Rallar session IDs.

### Iteration 6: Runner Cleanup and Reuse

Add browser/session lifecycle management:

- reuse a browser per scenario when possible
- use one page/context per actor unless isolation requires more
- close all browser resources on normal completion
- close all browser resources on failure
- include auto-close diagnostics

Expected result:

```text
Headless browser resources are cleaned up like RTC and WebSocket connections.
```

Current iteration 6 artifact:

| File | Purpose |
| --- | --- |
| `rallar-browser-rtc-provider.ts` | Treats browser cleanup as provider-owned lifecycle work, not only as an explicit `rtc.close` side effect. |
| `packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts` | Adds fake-browser tests for runner auto-close, setup failure cleanup, and unexpected page close cleanup. |

Cleanup semantics now covered:

- one Chromium instance is reused through the provider state for a black-box scenario
- each RTC connection still gets its own isolated browser context and page
- explicit `rtc.close` closes the runtime, browser context, and idle shared browser resources
- runner auto-close at the end of a run drives the same provider close path
- setup failures after the shared browser is launched close any partial context and the idle shared browser
- unexpected browser page close emits an RTC close event, removes the session from provider state, and closes idle shared resources

Provider cleanup diagnostics are emitted into `rtcMessages` with topics such as:

- `rallar.browser.provider.context_closed`
- `rallar.browser.provider.browser_closed`
- `rallar.browser.provider.connect_failed`
- `rallar.browser.provider.context_close_failed`
- `rallar.browser.provider.browser_close_failed`
- `rallar.browser.provider.page_close_cleanup_failed`

The generic runner auto-close event is still recorded in `rtcCloseEvents` with `autoCloseRequested` and `autoCloseSucceeded`.

### Iteration 7: Robust Diagnostics

Add structured diagnostics for:

- page load failure
- Rallar configure/login/connect failure
- room join failure
- peer not found
- data channel did not open
- send result closed/queued/dropped/replaced
- browser console errors
- browser page errors
- browser network failures relevant to Rallar

Expected result:

```text
Failures can be diagnosed from the black-box report without opening the browser debugger.
```

Current iteration 7 artifact:

| File | Purpose |
| --- | --- |
| `browser/rallar-browser-runtime.ts` | Emits phase-aware connect/auth diagnostics, send start/completion diagnostics, and realtime send outcome diagnostics. |
| `rallar-browser-rtc-provider.ts` | Adds provider diagnostics for page-load failure, runtime-connect failure, send failure, browser console errors/warnings, and Rallar API request failures. |
| `packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts` | Adds fake-browser tests for console/request diagnostics, page-load failure diagnostics, and runtime send failure diagnostics. |

Runtime connect diagnostics now include generic phase events:

- `rallar.browser.connect.phase_started`
- `rallar.browser.connect.phase_completed`
- `rallar.browser.connect.phase_failed`

The phase field identifies where the failure happened:

- `transport-config`
- `configure`
- `auth`
- `rallar-connect`
- `room-join`
- `subscribe-realtime`
- `subscribe-messages.rtc`

Auth-specific diagnostics are also emitted:

- `rallar.browser.auth.restore_started`
- `rallar.browser.auth.restore_completed`
- `rallar.browser.auth.restore_failed`
- `rallar.browser.auth.register_started`
- `rallar.browser.auth.register_completed`
- `rallar.browser.auth.register_failed`
- `rallar.browser.auth.login_started`
- `rallar.browser.auth.login_completed`
- `rallar.browser.auth.login_failed`

Realtime send diagnostics now identify delivery and data-channel problems:

- `rallar.browser.realtime.send_started`
- `rallar.browser.realtime.send_completed`
- `rallar.browser.realtime.peer_not_found`
- `rallar.browser.realtime.data_channel_not_open`
- `rallar.browser.realtime.send_result_attention`

Provider-side diagnostics now add:

- `rallar.browser.provider.page_load_failed`
- `rallar.browser.provider.runtime_connect_failed`
- `rallar.browser.provider.send_failed`
- `rallar.browser.console_error`
- `rallar.browser.console_warning`
- `rallar.browser.rallar_request_failed`

This keeps the black-box report useful when the browser cannot load the harness, Rallar auth/connect/join fails, a target peer cannot be resolved, a data channel never opens, or the browser logs/network layer reports a relevant failure.

### Iteration 8: CI and Operational Shape

Add documentation and examples for:

- running headless locally
- running against deployed API/signaling servers
- required environment variables for secrets
- Playwright browser install requirements
- timeout recommendations for global browser tests
- when to use `rallar-memory` versus `rallar-browser`

Expected result:

```text
The browser-backed RTC tests can run in CI against a deployed environment.
```

Current iteration 8 artifact:

| File | Purpose |
| --- | --- |
| `rallar-browser-rtc-runbook.md` | Operational runbook for local dry-run, live realtime, live `messages.rtc`, headful debugging, CI setup, timeouts, report signals, and provider choice. |
| `examples/rtc-rallar-browser-messages-rtc.json` | Provider-mode two-browser `messages.rtc` send/wait scenario for deployed Rallar services. |
| `black-box-rtc-provider.md` | Links to the runbook and lists the browser-provider examples. |
| `black_box_rtc_current_status.md` | Records Iterations 6-8 as implemented and narrows the remaining gap to live deployed-service hardening. |

Operational guidance now covers:

- installing repository dependencies and Playwright Chromium
- using `npx playwright install --with-deps chromium` on Linux CI images
- passing deployed-service secrets with CLI `-r` replacements
- running dry-run before browser/network execution
- running live `realtime` and live `messages.rtc` scenarios
- switching to headful/slow-mo mode for local debugging
- timeout recommendations for local and CI runs
- using report topics to diagnose browser/Rallar failures
- choosing `rallar-memory`, `rallar`, or `rallar-browser`

### Iteration 9: Live Deployed-Service Validation Harness

Add a repeatable live validation command for deployed-service hardening.

It should:

- run browser-provider dry-run validation for `realtime` and `messages.rtc`
- run live `realtime` and `messages.rtc` scenarios when deployed-service environment variables are present
- fail early when live credentials or endpoint variables are missing
- optionally write redacted result artifacts for CI
- avoid printing raw passwords in validation wrapper output
- provide a single command that can be used locally and in CI

Expected result:

```text
The same command can validate dry-run expansion everywhere and live browser RTC delivery in environments with Rallar credentials.
```

Current iteration 9 artifact:

| File | Purpose |
| --- | --- |
| `rallar-browser-live-validation.mts` | Deno wrapper around the scenario CLI for dry-run/live realtime and `messages.rtc` validation. |
| `package.json` | Adds `rtc:browser:validate` in the shared-test workspace. |
| `rallar-browser-rtc-runbook.md` | Documents the validation wrapper, required live environment, redacted artifacts, and CI command shape. |

Validation command:

```bash
deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
  --mode=both \
  --transport=both \
  --record-dir=.artifacts/rallar-browser-rtc
```

Required live environment:

- `RALLAR_API_BASE_URL`
- `RALLAR_ROOM_ID`
- `RALLAR_ALICE_USERNAME`
- `RALLAR_ALICE_PASSWORD`
- `RALLAR_BOB_USERNAME`
- `RALLAR_BOB_PASSWORD`

Remaining operational gap: this repository session has not executed the live mode against real deployed Rallar services. The wrapper is ready to capture that first baseline once credentials and endpoint access are available.

### Iteration 10: Soak And Monitoring Runner

Status: partially implemented after this original plan was written.

The generic runner now supports same-connection deterministic soak through
`execution.soak` and `npm run test:shared-black-box:memory:soak`. Short gated
live browser and remote-browser `messages.rtc` soak baselines are available
through `npm run test:shared-black-box:matrix:live:soak`. Long-running
browser-backed soak monitoring remains future work.

Add a long-running RTC soak mode for monitoring behavior over hours.

This is different from Iteration 9:

- Iteration 9 repeatedly validates complete short scenarios.
- Iteration 10 should keep one browser-backed RTC topology alive and send periodic messages for a configured duration.

Target command shape:

```bash
deno run -A packages/shared-test/black-box-runner/rallar-browser-soak.mts \
  --duration=4h \
  --interval=30s \
  --transport=both \
  --record-dir=.artifacts/rallar-browser-soak
```

Planned capabilities:

- keep two or more browser RTC connections open for the full run
- send periodic `realtime` and/or `messages.rtc` payloads
- measure connect latency, send latency, wait latency, and close latency
- collect periodic browser runtime health snapshots
- collect Rallar realtime lane health when using `realtime`
- write redacted JSONL event logs for long runs
- write a final summary report with totals, failure counts, and percentiles
- support thresholds such as max failure rate or max consecutive failures
- support graceful shutdown and final cleanup on interruption
- optionally run headful for local observation

Metrics to capture:

- started/ended timestamps and planned duration
- messages attempted, delivered, timed out, and failed
- per-transport success/failure counts
- latency min/p50/p95/p99/max
- reconnects, unexpected closes, page crashes, and cleanup failures
- latest RTC diagnostics by connection
- browser provider resource cleanup status

Expected result:

```text
A user can run browser-backed RTC traffic for hours and inspect rolling behavior without manually looping short scenarios.
```

Open design questions:

- whether soak mode should reuse `executeBlackBox` internally or drive the `rallar-browser` provider directly
- how many actors should be supported initially
- whether runtime health should be a first-class `rtc.health` action or provider-specific diagnostic polling
- whether failures should stop the run, continue until duration, or follow threshold rules
- artifact format for large JSONL logs and final summaries

### Iteration 11: Seeded Random And Parallel Step Plans

Status: implemented for the generic deterministic runner after this original
plan was written.

Use `execution.trafficPlan` for seeded weighted traffic with
`expanded-plan.json` replay artifacts, and `type: "parallel"` for bounded
parallel groups. Deterministic `rallar-memory` examples are available through
`npm run test:shared-black-box:memory:traffic` and
`npm run test:shared-black-box:memory:parallel`.
Short gated live browser and remote-browser `messages.rtc` baselines are
available through `npm run test:shared-black-box:matrix:live:traffic` and
`npm run test:shared-black-box:matrix:live:parallel`.

Add a controlled randomness layer for black-box scenarios.

The goal is to trigger less predictable RTC timing, ordering, and lifecycle behavior while keeping failures reproducible.

Target capabilities:

- mark a subset of steps as randomized
- use a deterministic seed
- record the seed in the report
- record the fully expanded executable plan for replay
- support weighted random step selection
- support random delays/jitter
- optionally support bounded parallel execution
- support replay from a prior seed and expanded plan

Possible config shape:

```json
{
  "execution": {
    "seed": "rtc-chaos-2026-05-14",
    "failFast": false
  },
  "steps": [
    {
      "name": "connectAlice",
      "type": "rtc.connect",
      "connection": "aliceRtc"
    },
    {
      "name": "connectBob",
      "type": "rtc.connect",
      "connection": "bobRtc"
    },
    {
      "name": "traffic",
      "type": "plan.random",
      "seed": "{execution.seed}",
      "iterations": 500,
      "strategy": "weighted",
      "steps": [
        {
          "weight": 45,
          "step": {
            "type": "rtc.send",
            "connection": "aliceRtc"
          }
        },
        {
          "weight": 45,
          "step": {
            "type": "rtc.send",
            "connection": "bobRtc"
          }
        },
        {
          "weight": 10,
          "step": {
            "type": "rtc.wait",
            "connection": "aliceRtc"
          }
        }
      ]
    }
  ]
}
```

Possible bounded parallel shape:

```json
{
  "name": "parallelTraffic",
  "type": "plan.parallel",
  "concurrency": 4,
  "steps": [
    {
      "type": "rtc.send",
      "connection": "aliceRtc"
    },
    {
      "type": "rtc.send",
      "connection": "bobRtc"
    }
  ]
}
```

Good candidates for randomization:

- RTC send order between already-connected peers
- payload contents, within a schema or known value set
- message type/topic/resource IDs when the receiver is configured to expect them
- wait placement after sends
- short randomized delays between traffic steps
- direction of traffic, such as Alice-to-Bob or Bob-to-Alice
- target selection among connected peers
- broadcast versus direct delivery in `rallar-memory`
- harmless duplicate waits or diagnostics checks

Risky candidates for randomization:

- connection setup ordering when later steps depend on specific peers
- room IDs unless every actor is randomized consistently into the same room
- credentials or auth state
- provider selection in the same test unless the expected semantics are provider-neutral
- `rtc.close` while unrelated sends/waits still assume the connection is open
- changing transport between `realtime` and `messages.rtc` inside one connection lifecycle
- timeout values without lower/upper bounds
- schema-breaking payload mutations
- randomizing expected messages independently from sent messages

Events that should usually stay deterministic:

- initial connect/setup sequence
- account/session selection
- deployed endpoint selection
- room membership prerequisites
- cleanup/close at the end of the run
- final summary assertions
- seed and generated plan recording

Events that can be intentionally chaotic, but must be modeled as such:

- close/send races
- page close during traffic
- reconnect during traffic
- duplicate sends with the same key
- back-pressure scenarios
- dropped/replaced/queued realtime send results
- delayed receiver waits

Concerns and drawbacks:

- random tests can hide causality unless the expanded plan is always recorded
- parallel tests can introduce false negatives when waits race with sends or closes
- seeded randomness is reproducible only if the scheduler and timing model are also controlled
- browser/WebRTC timing can still vary across machines even with the same seed
- chaotic close/send races may produce valid failures that need explicit expected-outcome rules
- long random runs can create large reports and artifacts
- random payloads can make report comparison noisy
- randomizing too much at once makes failures hard to reduce
- parallel RTC operations may violate provider assumptions, especially one page/context per connection
- fail-fast can reduce diagnostic value for randomized tests; continuing can produce cascading failures

Recommended design guardrails:

- default to deterministic setup, randomized traffic, deterministic cleanup
- record both seed and expanded plan
- add a `replayPlan` mode before adding complex randomness
- start with serial randomized order before parallel execution
- require explicit `allowRace: true` or equivalent for close/send races
- define expected outcome sets for intentionally chaotic operations
- cap random delays, iteration counts, and concurrency
- include branch/iteration IDs in every result key
- support shrinking or reducing a failed random plan later

Expected result:

```text
A user can run reproducible random RTC traffic plans that uncover ordering and timing issues without making every failure impossible to replay.
```

## Open Decisions

| Decision | Current Leaning |
| --- | --- |
| Provider name | `rallar-browser` for clarity. |
| First transport | `realtime`, because readiness maps directly to data-channel open. |
| Auth config | Start with username/password or pre-issued session config. Avoid hardcoding secrets in scenario files. |
| Browser page source | Prefer loading the real app if it exports `rallar`; otherwise use a minimal test harness page. |
| Parallel actors | Start serial and deterministic. Add parallel browser startup once basic reporting works. |
| Default `rallar` provider | Keep signaling-only until real browser-backed flows are stable. |

## Completion Criteria

The first usable implementation is complete when:

- `rallar-browser` is registered as an RTC provider
- `--dry-run` does not launch browsers
- a two-browser `realtime` scenario passes
- browser messages appear in `rtcMessages`
- browser close/error events appear in `rtcCloseEvents`
- resources are closed at the end of a run
- failure reports include useful browser and Rallar diagnostics
- docs show how to run against deployed Rallar API/signaling servers
