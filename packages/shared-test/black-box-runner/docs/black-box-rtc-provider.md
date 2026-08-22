# Black-box RTC provider guide

This document describes RTC support in the black-box runner.

For the general recipe contract and provider boundary, start with
`black-box-runner-recipe-guide.md`. For example classification, see
`../examples/README.md`. For the current shared-test improvement plan, see
`../../rallar-shared-test-gap-analysis.md`.

## Current provider status

| Provider                | Purpose                                        | Real transport?          | Notes                                                                                                                              |
| ----------------------- | ---------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rallar-stub`           | Simple fake RTC provider                       | No                       | Useful for parser/runner smoke tests.                                                                                              |
| `rallar-memory`         | Deterministic multi-peer in-memory RTC runtime | No                       | Useful for direct, broadcast, close, reconnect, and routing tests.                                                                 |
| `rallar-signaling`      | Rallar signaling provider                      | WebSocket signaling only | Opens WebSocket signaling and waits for open by default. Does not create `RTCPeerConnection` or `RTCDataChannel` yet.              |
| `rallar`                | Compatibility alias                            | WebSocket signaling only | Kept for existing recipes; prefer `rallar-signaling` in new recipes.                                                               |
| `rallar-browser`        | Browser-backed Rallar provider                 | Yes                      | Opt-in Playwright/Vite provider that loads the browser harness and delegates RTC behavior to the existing browser `rallar` facade. |
| `rallar-remote-browser` | Control-server-backed browser provider         | Yes                      | Runs the same generic RTC recipe through `rallar-bb-test` and maps remote browser events into the normal runner report stores.     |

The CLI provider named `rallar-signaling` currently maps to:

```ts
createRallarWebRtcWebSocketSignalingProvider();
```

The legacy provider name `rallar` maps to the same provider for backward compatibility.

The `rallar-browser` provider currently maps to:

```ts
createRallarBrowserRtcProvider();
```

It is intended for headless browser runs against deployed Rallar REST and signaling services. Provider registration, `rtc.connect`, `rtc.close`, browser event bridging, and realtime target resolution are in place.

Operational runbook:

```text
packages/shared-test/black-box-runner/docs/rallar-browser-rtc-runbook.md
```

Supported RTC test catalog:

```text
packages/shared-test/black-box-runner/docs/black-box-rtc-test-catalog.md
```

Provider-mode examples:

| Example                                                   | Purpose                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `examples/rtc-rallar-browser-connect.json`                | Connect and close two browser-backed Rallar RTC connections.                                      |
| `examples/rtc-rallar-browser-realtime.json`               | Send and wait for browser realtime data-channel messages.                                         |
| `examples/rtc-rallar-browser-messages-rtc.json`           | Send and wait for app-level `rallar.messages.rtc` messages.                                       |
| `examples/rtc-rallar-browser-messages-rtc-multicast.json` | Send one app-level `messages.rtc` payload to a room and assert two peers receive it.              |
| `examples/rtc-rallar-browser-provider-mode-parity.json`   | Parameterize the RTC provider so the same recipe runs locally or through `rallar-remote-browser`. |
| `examples/rtc-rallar-browser-scoped-workspaces.json`      | Pass scoped `roomRef` values through browser RTC and assert same-room-id workspace isolation.     |
| `examples/rtc-rallar-browser-not-yet-in-sync.json`        | Pass `minSnapshotVersion` and assert an observable `not-yet-in-sync` NACK.                        |
| `examples/rtc-rallar-browser-readiness-diagnostics.json`  | Wait for browser-provider readiness diagnostics and health.                                       |
| `examples/rtc-rallar-browser-timeout-diagnostics.json`    | Intentionally fail a diagnostic wait to show timeout diagnostics.                                 |
| `examples/rtc-rallar-memory-delivery-semantics.json`      | Deterministically assert direct and room broadcast delivery metadata.                             |
| `examples/rtc-rallar-memory-routing-failures.json`        | Intentionally record no-recipient, closed-target, and send-after-close failures.                  |

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

Scoped Rallar delivery can be expressed without new runner commands:

```json
{
  "type": "rtc.send",
  "connection": "aliceRtc",
  "request": {
    "roomRef": {
      "applicationId": "black-box-app",
      "workspaceId": "workspace-a",
      "groupId": "bb-group"
    },
    "minSnapshotVersion": 12,
    "send": {
      "payload": {
        "text": "hello scoped room"
      }
    }
  }
}
```

The browser-backed providers pass `applicationId`, `workspaceId`, `scope`,
`roomRef`, and `minSnapshotVersion` through to Rallar and include the resolved
scope in step diagnostics.

Readiness diagnostics can be asserted directly:

```json
{
  "type": "rtc.wait",
  "connection": "aliceRtc",
  "expect": {
    "diagnostic": {
      "topic": "rallar.browser.provider.connected"
    }
  }
}
```

Provider health snapshots can also be polled with `expect.health`. Connect
results include `connectLatencyMs`; send results include `sendLatencyMs`, and
send-and-wait results include `firstPayloadLatencyMs` when a payload is
received.

Provider send responses are preserved as `actual.sendResult` when available.
If a provider throws after observing a meaningful send response, such as
`no-peers`, `closed`, `queued`, `dropped`, or `replaced`, it can attach
`sendResult` or `response` to the error and the runner will copy that value into
the failure report.

For `rallar-remote-browser`, remote `message`, `diagnostic`, and close events
are normalized into `rtcMessages`, `rtcDiagnostics`, and `rtcCloseEvents`.
Remote RTC messages use the same event-shaped payload style as
`rallar-browser`: `matchedMessage.data.kind`, `matchedMessage.data.topic`, and
`matchedMessage.data.data` are available for assertions and output extraction.
