# Black-box RTC Implementation Status

## Summary

The black-box RTC foundation is in a good state.

The current supported RTC test categories are cataloged in:

```text
packages/shared-test/black-box-runner/black-box-rtc-test-catalog.md
```

Latest observed test result:

```text
ok | 130 passed | 0 failed
```

The implementation now supports RTC scenario parsing, dry-run reporting, multiple RTC providers, deterministic in-memory routing, WebSocket signaling-only Rallar integration, rich diagnostics, and CLI/provider-level regression coverage.

The current default `rallar` provider is **not yet full real WebRTC**. It is WebSocket signaling-only and waits for signaling transport open by default.

## Implemented Provider Layers

| Provider | Status | Purpose |
| --- | --- | --- |
| `rallar-stub` | Implemented | Simple fake provider for smoke tests and runner validation. |
| `rallar-memory` | Implemented | Deterministic multi-peer runtime for direct, broadcast, reconnect, close, and routing tests. |
| `rallar` | Implemented as signaling-only | Uses global WebSocket for signaling, requires `signalingUrl`, waits for open by default. |
| `rallar-browser` | Browser-backed Rallar provider | Uses Playwright plus the browser Rallar facade. Provider registration, `rtc.connect`, `rtc.close`, event bridging, realtime sends, `messages.rtc` sends, cleanup, diagnostics, and operational docs are implemented at provider-test level. |
| Real Rallar RTC adapter | In progress | Should wrap the existing Rallar RTC implementation instead of reimplementing RTC in the black-box runner. |

## Current `rallar` Meaning

The CLI provider named `rallar` currently maps to:

```ts
createRallarWebRtcWebSocketSignalingProvider()
```

A successful `rallar` connect means:

```text
WebSocket signaling transport opened successfully.
```

It does **not** yet mean:

```text
RTCPeerConnection created
RTCDataChannel opened
real peer-to-peer data path established
```

## Completed Capabilities

### RTC Scenario Support

The runner supports these RTC step types:

```text
rtc.connect
rtc.send
rtc.wait
rtc.close
```

Connection-level configuration is merged into each RTC request.

Common RTC fields:

```json
{
  "provider": "rallar-memory",
  "actor": "alice",
  "peerId": "alice",
  "remotePeerId": "bob",
  "roomId": "room-1",
  "groupId": "group-1",
  "overlayId": "overlay-1"
}
```

### Dry-run Support

Two dry modes now have distinct behavior.

#### `-e dry`

Prints executable interactions and does not run the scenario engine.

```bash
deno run -A scenario-black-box.ts -w ./test-data -c config.json -e dry
```

#### `--dry-run` / `-n`

Runs the scenario engine in dry-run mode and returns a normal report.

```bash
deno run -A scenario-black-box.ts -w ./test-data -c config.json --dry-run
```

or:

```bash
deno run -A scenario-black-box.ts -w ./test-data -c config.json -n
```

Config-level dry-run is also supported:

```json
{
  "execution": {
    "dryRun": true
  }
}
```

RTC dry-run does not invoke RTC providers and does not mutate RTC runtime state.

### Generic RTC Report Diagnostics

RTC success and failure statuses include routing diagnostics at both the result top level and inside `actual`.

Example:

```json
{
  "status": "SUCCESS",
  "transport": "RTC",
  "provider": "rallar-memory",
  "actor": "alice",
  "peerId": "alice",
  "roomId": "room-1",
  "groupId": "group-1",
  "overlayId": "overlay-1",
  "remotePeerId": "bob",
  "action": "connect",
  "connection": "aliceRtc",
  "actual": {
    "provider": "rallar-memory",
    "actor": "alice",
    "peerId": "alice",
    "roomId": "room-1",
    "groupId": "group-1",
    "overlayId": "overlay-1",
    "remotePeerId": "bob",
    "action": "connect",
    "connection": "aliceRtc"
  }
}
```

### `rallar-memory`

`rallar-memory` is deterministic and does not use network transports.

It supports:

- peer connect
- peer close
- peer reconnect
- direct messages
- broadcast messages
- close diagnostics
- auto-close diagnostics
- target resolution from payload target fields or `remotePeerId`

Direct target resolution prefers payload targets over `remotePeerId`.

Common target fields:

```json
{
  "toPeerId": "bob",
  "targetPeerId": "bob",
  "to": "bob",
  "payload": {
    "toPeerId": "bob"
  }
}
```

Broadcast can be requested with:

```json
{
  "broadcast": true
}
```

or:

```json
{
  "payload": {
    "broadcast": true
  }
}
```

Delivered messages include an envelope such as:

```json
{
  "deliveredBy": "rallar-in-memory-runtime",
  "deliveryMode": "direct",
  "deliverySequence": 1,
  "deliveryGroup": "room-1",
  "sentBy": "alice",
  "deliveredTo": "bob"
}
```

Close events include diagnostics:

```json
{
  "phase": "close",
  "reason": "closed by rallar in-memory runtime",
  "closedBy": "rallar-in-memory-runtime",
  "connection": "aliceRtc",
  "actor": "alice",
  "peerId": "alice",
  "roomId": "room-1",
  "groupId": "group-1",
  "overlayId": "overlay-1"
}
```

### WebSocket Signaling-only `rallar`

The current `rallar` provider:

- uses global `WebSocket`
- requires `signalingUrl`
- waits for open by default
- supports codec hooks
- supports optional on-connect/join message hook
- reports signaling connected/message/close diagnostics
- does not create real peer connections or data channels

Example config:

```json
{
  "connections": {
    "aliceRtc": {
      "type": "rtc",
      "provider": "rallar",
      "actor": "alice",
      "peerId": "alice",
      "roomId": "room-1",
      "groupId": "group-1",
      "overlayId": "overlay-1",
      "signalingUrl": "ws://localhost:8080/ws",
      "waitForOpen": true,
      "openTimeoutMs": 1000
    }
  },
  "steps": [
    {
      "name": "connectAlice",
      "type": "rtc.connect",
      "connection": "aliceRtc"
    }
  ]
}
```

If `signalingUrl` is missing, connect fails with:

```text
Rallar WebRTC signalingUrl is required for connection: aliceRtc
```

Signaling connected diagnostics:

```json
{
  "topic": "rallar.webrtc.signaling.connected",
  "connection": "aliceRtc",
  "actor": "alice",
  "peerId": "alice",
  "roomId": "room-1",
  "groupId": "group-1",
  "overlayId": "overlay-1",
  "signalingUrl": "ws://localhost:8080/ws",
  "opened": true,
  "readyState": "open"
}
```

Signaling message wrapper:

```json
{
  "topic": "rallar.webrtc.signaling.message",
  "connection": "aliceRtc",
  "actor": "alice",
  "peerId": "alice",
  "roomId": "room-1",
  "groupId": "group-1",
  "overlayId": "overlay-1",
  "message": {
    "topic": "rallar.existing.signaling.answer"
  }
}
```

Signaling close diagnostics:

```json
{
  "phase": "signaling-close",
  "reason": "rallar WebRTC signaling session closed",
  "closedBy": "rallar-webrtc-signaling-only-runtime",
  "connection": "aliceRtc",
  "actor": "alice",
  "peerId": "alice",
  "roomId": "room-1",
  "groupId": "group-1",
  "overlayId": "overlay-1",
  "transportEvent": {
    "code": 1000,
    "reason": "closed"
  }
}
```

### Browser-backed `rallar-browser`

The `rallar-browser` provider:

- starts or reuses one Playwright Chromium browser per scenario context
- starts or reuses a Vite harness unless `harness.url`/`harnessUrl` is supplied
- loads `browser/rallar-browser-harness.html`
- calls `window.__blackBoxRallar.connect(...)` in the browser page
- delegates to the existing browser `rallar` facade for auth, room join, and realtime listener setup
- records browser runtime events in `rtcMessages` and close events in `rtcCloseEvents`

Iteration 2 scope:

- provider name is registered as `rallar-browser`
- `rtc.connect` opens the headless page and connects the browser runtime
- `rtc.close` closes the runtime page/session
- dry-run includes the provider name without launching Playwright

Iteration 3 adds a tested event bridge:

- `window.__blackBoxRallarEmit` browser events are exposed through Playwright
- browser diagnostics and realtime message events land in `rtcMessages[connectionName]`
- browser close events land in `rtcCloseEvents[connectionName]`
- `rtc.wait` with `expect.message` or `expect.close` can match bridged browser events

Iteration 4 adds provider-mode realtime send routing:

- each browser connection stores `connectDiagnostics.sessionId`
- `rtc.send` receives the current interaction/config/context as optional client args
- `expect.connection`/`expect.onConnection` resolves to the target browser's Rallar session ID
- the provider passes that session ID as `peerIds` to `rallar.realtime.sendJson`
- scenario authors do not need to hardcode volatile Rallar session IDs

Realtime `rtc.send` is now covered with fake-browser tests. A live deployed-service run is still needed before treating the provider as operationally stable.

Iteration 5 adds app-level `messages.rtc` transport:

- browser runtime accepts `transport: "messages.rtc"`
- browser runtime subscribes with `rallar.messages.rtc.onMessage`
- browser runtime sends with `rallar.messages.rtc.send`
- `rallar.typeId` is required for RTC subscriptions
- `rallar.topicId`, `contextId`, `resourceId`, overlay, reliability, and routing fields can be configured
- provider maps `expect.connection` to `nextHopPeerIds`

`messages.rtc` is covered with fake-browser provider tests. A live deployed-service run is still needed.

Iteration 6 adds runner cleanup and reuse:

- one Chromium instance is reused per scenario context
- each RTC connection gets an isolated browser context and page
- explicit `rtc.close`, runner auto-close, setup failure, and unexpected page close paths clean up browser resources
- cleanup diagnostics are emitted into `rtcMessages`

Iteration 7 adds robust diagnostics:

- browser page load and runtime-connect failures are reported
- Rallar auth/connect/join failures are phase-tagged by the browser runtime
- browser console errors/warnings and failed Rallar API requests are captured
- realtime peer-not-found, data-channel-not-open, and send-result attention diagnostics are captured
- provider send failures include the browser send response when available

Iteration 8 adds operational docs and live-run examples:

- `rallar-browser-rtc-runbook.md` covers local, CI, dry-run, live realtime, live `messages.rtc`, timeout, and provider choice guidance
- `examples/rtc-rallar-browser-realtime.json` covers two-browser realtime delivery
- `examples/rtc-rallar-browser-messages-rtc.json` covers two-browser app-level RTC delivery

Iteration 9 adds a deployed-service validation harness:

- `rallar-browser-live-validation.mts` runs dry-run or live validation for `realtime`, `messages.rtc`, or both
- live mode fails early unless deployed Rallar endpoint and credential environment variables are present
- validation output redacts password fields and known password environment values
- `--record-dir` writes redacted artifacts for CI/debug capture
- shared-test exposes `npm --workspace @ar-eye-hunter/shared-test run rtc:browser:validate`

Iteration 10 is documented as future work only:

- long-running soak/monitor mode for browser-backed RTC is not implemented yet
- the intended shape is a runner that keeps RTC connections open for hours and sends periodic messages
- planned outputs are rolling metrics, redacted JSONL event logs, and a final summary report

Iteration 11 is documented as future work only:

- seeded random step plans and bounded parallel step groups are not implemented yet
- the intended shape is deterministic setup, randomized traffic, deterministic cleanup
- the design must record both seed and expanded executable plan for replay
- not all events are safe to randomize; connection setup, credentials, room prerequisites, and cleanup should usually remain deterministic

## Important Naming Distinction

| Factory | Meaning |
| --- | --- |
| `createRallarWebRtcWebSocketSignalingProvider()` | Current default CLI `rallar` provider. Uses global WebSocket and is signaling-only. |
| `createRallarBrowserRtcProvider()` | Opt-in Playwright/Vite browser provider named `rallar-browser`. |
| `createRallarWebRtcSignalingOnlyProvider(...)` | Test/provider wrapper around an injected signaling factory. |
| `createRallarWebRtcSignalingOnlyRuntime(...)` | Runtime adapter exposing a signaling session through the generic RTC contract. |
| `createRallarWebRtcProvider(...)` | Wrapper around the future/real WebRTC runtime. Not the current CLI default. |
| `createRallarWebRtcRuntime(...)` | Runtime entry point that can be backed by an injected `createSession`. |
| `createRallarInMemoryProvider(...)` | Deterministic in-memory multi-peer provider. |

## Current Boundary

The black-box runner should not reimplement RTC if Rallar already has an implementation.

Still incomplete:

- browser/Deno integration tests around the real implementation
- first recorded live deployed-service run and failure-mode tuning using `rallar-browser-live-validation.mts --mode=live`
- Iteration 10 soak/monitor runner implementation
- Iteration 11 seeded random/parallel step plan implementation

## Recommended Next Step

The next step should run `rallar-browser-live-validation.mts --mode=live --transport=both --record-dir=.artifacts/rallar-browser-rtc` against deployed Rallar services and capture the first live failure modes.

The adapter already plugs into the existing runtime/client seam:

```ts
createRallarRtcProvider({
  createClient: (args, config, context) => {
    return createRallarRtcClientFromRuntime(args, {
      connect: (runtimeArgs, dispatcher) => {
        // create and wrap browser-backed Rallar session here
      }
    })
  }
})
```

Provider-mode realtime sends now resolve `expect.connection` to live browser session IDs. Provider-mode `messages.rtc` sends resolve `expect.connection` to `nextHopPeerIds`. The remaining work is live-service hardening.
