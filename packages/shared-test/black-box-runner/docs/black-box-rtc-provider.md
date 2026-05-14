# Black-box RTC provider guide

This document describes RTC support in the black-box runner.

## Current provider status

| Provider | Purpose | Real transport? | Notes |
| --- | --- | --- | --- |
| `rallar-stub` | Simple fake RTC provider | No | Useful for parser/runner smoke tests. |
| `rallar-memory` | Deterministic multi-peer in-memory RTC runtime | No | Useful for direct, broadcast, close, reconnect, and routing tests. |
| `rallar` | Default Rallar provider | WebSocket signaling only | Opens WebSocket signaling and waits for open by default. Does not create `RTCPeerConnection` or `RTCDataChannel` yet. |
| `rallar-browser` | Browser-backed Rallar provider | Yes | Opt-in Playwright/Vite provider that loads the browser harness and delegates RTC behavior to the existing browser `rallar` facade. |

The default CLI provider named `rallar` currently maps to:

```ts
createRallarWebRtcWebSocketSignalingProvider()
```

The `rallar-browser` provider currently maps to:

```ts
createRallarBrowserRtcProvider()
```

It is intended for headless browser runs against deployed Rallar REST and signaling services. Provider registration, `rtc.connect`, `rtc.close`, browser event bridging, and realtime target resolution are in place.

Operational runbook:

```text
packages/shared-test/black-box-runner/rallar-browser-rtc-runbook.md
```

Supported RTC test catalog:

```text
packages/shared-test/black-box-runner/black-box-rtc-test-catalog.md
```

Provider-mode examples:

| Example | Purpose |
| --- | --- |
| `examples/rtc-rallar-browser-connect.json` | Connect and close two browser-backed Rallar RTC connections. |
| `examples/rtc-rallar-browser-realtime.json` | Send and wait for browser realtime data-channel messages. |
| `examples/rtc-rallar-browser-messages-rtc.json` | Send and wait for app-level `rallar.messages.rtc` messages. |

Live validation command:

```bash
deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
  --mode=both \
  --transport=both \
  --record-dir=.artifacts/rallar-browser-rtc
```

For realtime sends, prefer `expect.connection` instead of hardcoding `peerIds`:

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

The provider resolves `bobRtc` to Bob's browser-side Rallar `sessionId` and passes it as `peerIds` to `rallar.realtime.sendJson`.

For app-level Rallar RTC messages, use `transport: "messages.rtc"` and configure at least `typeId`:

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

The provider resolves `bobRtc` to Bob's browser-side Rallar `sessionId` and passes it as `nextHopPeerIds` to `rallar.messages.rtc.send`.
