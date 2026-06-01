# Runtime Diagnostic Contract

`packages/shared-test/rallar-bb-test/diagnostics.ts` defines the normalized
diagnostic payload used by browser-agent runtime evidence.

Diagnostics remain ordinary `RallarBlackBoxTestEvent` objects with
`kind: "diagnostic"`. The normalized contract lives in `event.payload`, so
existing `wait` and `assert` commands can match it through normal event fields
and payload paths.

## Payload Shape

Normalized diagnostic payloads include:

- `diagnosticSchemaVersion`: currently `1`
- `diagnosticTypeId`: stable diagnostic type, normally the event topic
- `topic`: same topic as the event
- `severity`: `debug`, `info`, `warning`, or `error`
- `message`: human-readable summary
- `transport`: `realtime`, `messages.rtc`, `ws`, or `http` when known
- `commandId`, `connection`, `actor`, `roomId`, `groupId`, `laneId`
- `peerId`, `remotePeerId`, `senderId`
- `typeId`, `topicId`, `contextId`, `resourceId`
- `data`: structured diagnostic details
- `error`: structured error details when available
- `source`: producer such as `browser-adapter` or `browser-rallar-runtime`

Producers may keep additional top-level fields for compatibility, but UI and
automation should prefer the normalized fields above.

RTC send diagnostics may include a `sendObservation` field when the adapter can
measure it. The observation can contain send duration, queued/enqueued status,
backpressure status, dropped/replaced payload counts, and an error code. Loop
load summaries aggregate these observations into `loop.value.sends`.

## Matching

Use ordinary `wait` commands:

```json
{
  "kind": "wait",
  "commandId": "wait-ws-warning",
  "match": {
    "kind": "diagnostic",
    "topic": "rallar.browser.ws.unhandled_message",
    "transport": "ws",
    "severity": "warning",
    "payloadPath": "diagnosticTypeId",
    "equals": "rallar.browser.ws.unhandled_message"
  }
}
```

Use ordinary `assert` commands against `recentDiagnostics`, `diagnostics`, or
`events`:

```json
{
  "kind": "assert",
  "commandId": "assert-ws-warning-type",
  "source": "recentDiagnostics.0.payload.data.typeId",
  "operator": "equals",
  "expected": "room.unknown"
}
```

## Producers

The browser adapter normalizes:

- browser Rallar runtime diagnostic bridge events
- RTC connect and send diagnostics
- RTC send failure diagnostics such as `no-peers`, `no-route`, or closed data
  channels
- WebSocket header warnings and socket errors

The browser Rallar runtime also bridges known live console warnings into
diagnostics while the runtime is active:

- `Unhandled WS message: ...` becomes
  `rallar.browser.ws.unhandled_message`
- `No callback for typeId ...` becomes
  `rallar.browser.ws.unhandled_message`
- RTC data-channel or peer-routing warnings become
  `rallar.browser.rtc.data_channel_warning`

This bridge is intentionally scoped to known WS/RTC warning patterns so the
runtime does not turn arbitrary console output into test evidence.

## Compatibility

Adding optional fields to diagnostic payloads is compatible.

Changing `diagnosticSchemaVersion`, `diagnosticTypeId`, severity semantics, or
the known bridged warning topics is a contract change. Update this document,
the iteration plan, and the focused diagnostic tests together.
