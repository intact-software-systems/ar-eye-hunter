# Black-box RTC provider guide

This document describes RTC support in the black-box runner.

## Current provider status

| Provider | Purpose | Real transport? | Notes |
| --- | --- | --- | --- |
| `rallar-stub` | Simple fake RTC provider | No | Useful for parser/runner smoke tests. |
| `rallar-memory` | Deterministic multi-peer in-memory RTC runtime | No | Useful for direct, broadcast, close, reconnect, and routing tests. |
| `rallar` | Default Rallar provider | WebSocket signaling only | Opens WebSocket signaling and waits for open by default. Does not create `RTCPeerConnection` or `RTCDataChannel` yet. |

The default CLI provider named `rallar` currently maps to:

```ts
createRallarWebRtcWebSocketSignalingProvider()