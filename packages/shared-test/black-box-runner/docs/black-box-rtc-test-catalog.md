# Black-box RTC Test Catalog

This document catalogs the RTC test categories currently supported by the black-box runner.

The runner-level RTC contract is provider-neutral:

```text
rtc.connect
rtc.send
rtc.wait
rtc.close
```

Provider-specific behavior is selected with `request.provider` or a connection config `provider`.

## Provider Summary

| Provider | Main test purpose | Real network/browser? |
| --- | --- | --- |
| `rallar-stub` | Fast parser, report, and wait/matching smoke tests. | No |
| `rallar-memory` | Deterministic multi-peer routing tests without network cost. | No |
| `rallar-signaling` | Explicit WebSocket signaling-only Rallar provider. | WebSocket signaling only |
| `rallar` | Legacy alias for `rallar-signaling`. | WebSocket signaling only |
| `rallar-browser` | Browser-backed Rallar RTC tests through Playwright and the browser `rallar` facade. | Yes |
| `rallar-remote-browser` | Control-server-backed provider that drives a visible or remote browser agent. | Yes |
| Custom `RtcProvider` | Unit/integration tests with injected clients or runtimes. | Depends on injection |

Important boundary: `rallar-signaling` and the legacy `rallar` alias are not
real WebRTC data paths. Use `rallar-browser` or `rallar-remote-browser` for real
browser RTC/data-channel behavior.

## 1. Scenario And Provider Smoke Tests

Use these tests to verify that RTC steps are parsed, normalized, and reported correctly.

Supported checks:

- `rtcProviderNames` includes configured/default RTC providers
- `--dry-run` does not invoke providers or mutate RTC state
- missing providers fail with available provider diagnostics
- unsupported RTC actions fail with supported action diagnostics
- common RTC fields appear in success/failure reports

Typical provider:

```text
rallar-stub
```

Useful step:

```json
{
  "name": "connectAlice",
  "type": "rtc.connect",
  "connection": "aliceRtc"
}
```

## 2. Connection Lifecycle Tests

Use these tests to verify connection creation, close behavior, reconnect behavior, and cleanup.

Supported checks:

- successful `rtc.connect`
- duplicate connect failure where the provider enforces uniqueness
- `rtc.close` on open connections
- `rtc.close` on already absent connections
- reconnect after close
- runner auto-close for connections left open at the end of a run
- close failure diagnostics
- provider-specific resource cleanup

Recommended providers:

| Provider | Good for |
| --- | --- |
| `rallar-stub` | Basic lifecycle report shape. |
| `rallar-memory` | Duplicate connect, reconnect, deterministic close diagnostics. |
| `rallar-browser` | Browser context/page cleanup, auto-close, setup failure cleanup, unexpected page close cleanup. |

Example close expectation:

```json
{
  "name": "waitForAliceClose",
  "type": "rtc.wait",
  "connection": "aliceRtc",
  "expect": {
    "connection": "aliceRtc",
    "withinMs": 1000,
    "close": {
      "closedBy": "rallar-in-memory-runtime",
      "connection": "aliceRtc"
    }
  }
}
```

## 3. Single Message Delivery Tests

Use these tests to verify that one sent RTC payload is observed on the expected connection.

Supported checks:

- send without expectation returns a send success result
- `rtc.send` with `expect.message` waits for a matching message
- `rtc.wait` with `expect.message` waits for a previously emitted message
- `expect.connection` selects the receiving connection
- timeout failure reports include expected message and observed messages
- `expect.consume: true` removes the matched message from the stored message list

Example:

```json
{
  "name": "aliceSendsToBob",
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
    "withinMs": 1000,
    "message": {
      "payload": {
        "text": "hello bob"
      }
    }
  }
}
```

## 4. Multi-message And Ordering Tests

Use these tests when one interaction should produce several RTC messages.

Supported checks:

- `expect.messages` waits for multiple expected messages
- unordered matching by default
- `ordered: true` requires the expected order
- timeout failure reports matched/missing messages
- `consume: true` removes matched messages

Example:

```json
{
  "name": "waitForTwoMessages",
  "type": "rtc.wait",
  "connection": "bobRtc",
  "expect": {
    "connection": "bobRtc",
    "withinMs": 1000,
    "ordered": true,
    "messages": [
      {
        "topic": "chat.message",
        "payload": {
          "text": "first"
        }
      },
      {
        "topic": "chat.message",
        "payload": {
          "text": "second"
        }
      }
    ]
  }
}
```

## 5. Routing And Target Resolution Tests

Use these tests to verify how messages select their receiving peers/connections.

Runner-level target fields:

| Field | Meaning |
| --- | --- |
| `expect.connection` | Expected receiving RTC connection. |
| `expect.onConnection` | Alias-style expected receiving connection. |
| `request.expectConnection` | Request-side target hint. |
| `request.deliverTo` | Explicit delivery target for stub/provider routing. |
| `request.to` | Explicit delivery target for stub/provider routing. |
| `request.toConnection` | Browser provider target hint. |

`rallar-memory` target fields:

| Field | Meaning |
| --- | --- |
| `send.toPeerId` | Direct peer target. |
| `send.targetPeerId` | Direct peer target. |
| `send.to` | Direct peer target. |
| `send.payload.toPeerId` | Direct peer target in payload. |
| `send.payload.targetPeerId` | Direct peer target in payload. |
| `send.payload.to` | Direct peer target in payload. |
| connection `remotePeerId` | Fallback direct peer target. |
| `send.broadcast: true` | Broadcast to connected peers in the same group. |
| `send.payload.broadcast: true` | Payload-level broadcast flag. |

Target precedence in `rallar-memory`: payload/request target fields are preferred before `remotePeerId`.

Group/broadcast scoping in `rallar-memory` uses:

```text
groupId || overlayId || roomId
```

Browser provider target resolution:

| Transport | `expect.connection` becomes |
| --- | --- |
| `realtime` | `peerIds` containing the target browser Rallar `sessionId`. |
| `messages.rtc` | `nextHopPeerIds` containing the target browser Rallar `sessionId`. |

## 6. Broadcast Tests

Use these tests when one sender should deliver to every other connected peer in the same group.

Supported with:

```text
rallar-memory
```

Supported checks:

- broadcast with no explicit direct target
- broadcast with `send.broadcast: true`
- broadcast with `send.payload.broadcast: true`
- failure when there are no eligible targets
- delivery envelope includes `deliveryMode: "broadcast"`
- delivery envelope includes `deliverySequence`, `deliveryGroup`, `sentBy`, and `deliveredTo`

Example payload:

```json
{
  "broadcast": true,
  "payload": {
    "text": "hello everyone"
  }
}
```

## 7. Close Event Tests

Use these tests to verify provider/runtime close events.

Supported checks:

- `rtc.wait` with `expect.close`
- `expect.close: true` matches any close event
- object-shaped `expect.close` matches fields by compatible JSON comparison
- close wait timeouts report observed close events
- `consume: true` removes matched close events
- runtime close events are flattened enough to match provider-specific fields

Example:

```json
{
  "name": "waitForBrowserClose",
  "type": "rtc.wait",
  "connection": "aliceRtc",
  "expect": {
    "connection": "aliceRtc",
    "withinMs": 1000,
    "close": {
      "topic": "rallar.browser.closed"
    }
  }
}
```

## 8. Failure And Diagnostic Tests

Use these tests to ensure failures are visible in the black-box report.

Generic failure categories:

- RTC connection is not open
- RTC connect failed
- RTC send failed
- RTC close failed
- expected RTC message was not received
- expected RTC messages were not received
- expected RTC messages were not received in order
- expected RTC close event was not received

Data-channel/runtime failure categories:

- message cannot be encoded
- custom decode fails and emits close diagnostics
- data channel is not open
- data channel open times out
- data channel closes before open
- data channel errors before open
- send throws
- close throws

Signaling failure categories:

- missing `signalingUrl`
- signaling transport open timeout
- signaling transport closes before open
- signaling transport errors before open
- signaling decode failure
- transport send failure

Browser-provider failure categories:

- harness page load failure
- browser runtime connect failure
- Rallar auth/login/register failure
- Rallar connect/join phase failure
- browser console error/warning
- failed Rallar API request
- peer not found
- data channel not open
- send result `queued`, `dropped`, `replaced`, or `closed`
- unexpected page close
- browser/context cleanup failure

## 9. Wire Format And Codec Tests

Use these tests when a runtime uses a data channel or signaling transport with encoded messages.

Supported checks:

- object messages encode as JSON
- string messages remain strings
- undefined messages fail clearly
- JSON strings decode into objects
- non-JSON strings remain strings
- non-string data remains unchanged
- custom wire encoder/decoder hooks
- decode failures emit close diagnostics
- encode failures report send failure

Relevant provider/runtime helpers:

```text
createRallarRtcProviderFromDataChannelFactory
createRallarWebRtcWebSocketSignalingFactory
createRallarWebRtcWebSocketSignalingProvider
```

## 10. Signaling-only Rallar Tests

Use these tests for `rallar-signaling` and the legacy `rallar` alias.

Supported checks:

- WebSocket-like transport creation
- optional wait for transport open
- request-level `waitForOpen`
- open timeout configuration
- optional connect/join message hook
- outgoing signaling send
- incoming signaling messages
- signaling close/error diagnostics
- group/overlay fields in diagnostics
- custom signaling codec

Not supported by this provider:

- real `RTCPeerConnection`
- real `RTCDataChannel`
- browser WebRTC behavior

Use `rallar-browser` for those.

## 11. Browser-backed Rallar Tests

Use these tests for deployed-service or browser-level RTC behavior.

Supported transports:

| Transport | Rallar API |
| --- | --- |
| `realtime` | `rallar.realtime.onJson` and `rallar.realtime.sendJson` |
| `messages.rtc` | `rallar.messages.rtc.onMessage` and `rallar.messages.rtc.send` |

Supported checks:

- browser harness loads in Playwright
- browser `rallar` facade configures API base URL
- login/register/restore path
- Rallar connect and room join
- realtime listener setup
- `messages.rtc` listener setup
- realtime send/wait between two browser sessions
- `messages.rtc` send/wait between two browser sessions
- browser runtime diagnostics bridge into `rtcMessages`
- browser close events bridge into `rtcCloseEvents`
- provider auto-close and cleanup diagnostics
- live validation dry-run
- live deployed-service validation when credentials are available

Provider-mode examples:

| Example | Purpose |
| --- | --- |
| `examples/rtc-rallar-browser-connect.json` | Connect and close two browser-backed RTC connections. |
| `examples/rtc-rallar-browser-realtime.json` | Two-browser realtime send/wait. |
| `examples/rtc-rallar-browser-messages-rtc.json` | Two-browser `messages.rtc` send/wait. |

Validation wrapper:

```bash
deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
  --mode=both \
  --transport=both \
  --record-dir=.artifacts/rallar-browser-rtc
```

## 12. Custom Provider And Runtime Tests

Use this when a test needs direct control over client/runtime behavior.

Supported seams:

- `createRtcProviderFromClientFactory`
- `createRallarRtcProvider`
- `createRallarRtcProviderFromRuntime`
- `createRallarRtcProviderFromDataChannelFactory`
- `createRallarWebRtcProvider`

Supported checks:

- injected client connect/send/close behavior
- injected runtime session behavior
- event dispatcher message/close forwarding
- runtime connect/send/close failure conversion to RTC result objects
- custom runtime close/message shapes
- ordered message and close expectations through injected sessions

## Provider Choice

| Goal | Provider |
| --- | --- |
| Validate RTC scenario parsing/report shape quickly | `rallar-stub` |
| Test deterministic direct routing | `rallar-memory` |
| Test deterministic broadcast routing | `rallar-memory` |
| Test reconnect/duplicate connect behavior | `rallar-memory` |
| Test generic provider contract with an injected client | `createRtcProviderFromClientFactory` |
| Test data-channel-like encode/decode/open behavior | `createRallarRtcProviderFromDataChannelFactory` |
| Test current Rallar signaling WebSocket behavior | `rallar-signaling` or legacy alias `rallar` |
| Test real browser Rallar realtime delivery | `rallar-browser` with `transport: "realtime"` |
| Test real browser Rallar app-level RTC delivery | `rallar-browser` with `transport: "messages.rtc"` |
| Test deployed-service readiness in CI | `rallar-browser-live-validation.mts` |

## Current Gaps

- No recorded live deployed-service baseline is committed in the repo yet.
- `rallar-signaling` and the legacy `rallar` alias remain signaling-only.
- `rallar-browser` live mode requires deployed Rallar endpoint access and test credentials.
- Browser-backed test stability still needs real-environment failure-mode tuning.
- Seeded traffic plans and bounded parallel step groups are implemented in the generic runner with deterministic `rallar-memory` examples and gated live `rallar-browser`/`rallar-remote-browser` baselines.
