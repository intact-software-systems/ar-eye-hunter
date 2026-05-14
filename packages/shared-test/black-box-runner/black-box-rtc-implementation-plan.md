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

### Iteration 3: Event Bridge

Wire browser events into the existing black-box dispatcher.

Use Playwright `page.exposeFunction` or equivalent to push events from the browser page back to Deno.

Expected result:

```text
Browser-side messages appear in report.rtcMessages[connectionName].
Browser-side close/errors appear in report.rtcCloseEvents[connectionName].
```

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

