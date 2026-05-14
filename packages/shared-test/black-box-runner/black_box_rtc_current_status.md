# Black-box RTC Implementation Status

## Summary

The black-box RTC foundation is in a good state.

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
| Real Rallar RTC adapter | Not integrated yet | Should wrap the existing Rallar RTC implementation instead of reimplementing RTC in the black-box runner. |

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

## Important Naming Distinction

| Factory | Meaning |
| --- | --- |
| `createRallarWebRtcWebSocketSignalingProvider()` | Current default CLI `rallar` provider. Uses global WebSocket and is signaling-only. |
| `createRallarWebRtcSignalingOnlyProvider(...)` | Test/provider wrapper around an injected signaling factory. |
| `createRallarWebRtcSignalingOnlyRuntime(...)` | Runtime adapter exposing a signaling session through the generic RTC contract. |
| `createRallarWebRtcProvider(...)` | Wrapper around the future/real WebRTC runtime. Not the current CLI default. |
| `createRallarWebRtcRuntime(...)` | Runtime entry point that can be backed by an injected `createSession`. |
| `createRallarInMemoryProvider(...)` | Deterministic in-memory multi-peer provider. |

## Current Boundary

The black-box runner should not reimplement RTC if Rallar already has an implementation.

Not integrated yet:

- existing Rallar RTC implementation as a black-box provider
- real `RTCPeerConnection` lifecycle through the black-box runner
- real `RTCDataChannel` lifecycle through the black-box runner
- offer/answer and ICE behavior through the existing Rallar RTC implementation
- browser/Deno integration tests around the real implementation

## Recommended Next Step

The next step should be to add a provider adapter around the existing Rallar RTC implementation.

The adapter should plug into the existing seam:

```ts
createRallarWebRtcProvider({
  createSession: async (args, dispatcher) => {
    // create and wrap existing Rallar RTC session here
  }
})
```

This allows the black-box runner to reuse the existing Rallar implementation instead of duplicating RTC logic.
