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

## Formation Diagnostics

A connection that resolves a room ref installs the room formation stream beside
the RTC lifecycle stream, and tears it down with it. A connection that names a
bare room id resolves no ref and installs nothing.

- `rallar.browser.formation.changed` carries the room formation summary on
  every change the shipped handle publishes
- `rallar.browser.formation.layout` carries `kind`, `role` and `identity` for
  each planned, accepted or removed layout event
- `rallar.browser.formation.room-status` carries the room transport block and
  the group revision it was read at, on every RTC status change
- `rallar.browser.formation.ready` carries the readiness diagnostic captured in
  the tick `formation.readiness` resolved

The summary is a projection, not a pass-through. It drops the peers array, the
lane id, the reason and the read-time clock the room status carries, so a pin
never asserts on a value that changes with every read.

## Outbound Admission Diagnostics

`rallar.browser.alm.outbound_diagnostics` carries one AL outbound runtime
diagnostics event per emission, recorded the moment the outbound runtime calls
the sink — independent of any connection, so it observes admission work for
every session the page opens. The event's `data` is the event itself:

- `kind`: `sender-queue-wait`, `browser-lock-wait`, `browser-lock-hold`, or
  `effect-drain`
- `durationMs`: how long that phase took
- the phase's own identity fields: `senderId` and `queued` for
  `sender-queue-wait`; `senderId`, `lockName` and `available` for the two
  `browser-lock-*` phases; `workerId`, `claimedCount`, `completedCount`,
  `rescheduledCount` and `rejectedCount` for `effect-drain`

This is the evidence a `deadline-expiry` conformance run uses to attribute a
slow admission (the serialized IndexedDB chain a typed send commits through)
to a phase instead of a single opaque send latency.

## Storage Reset Diagnostics

`rallar.browser.alm.storage_reset` carries one `ALStorageResetEvent` per
delete-and-recreate reset of the browser ALM IndexedDB database, recorded the
moment `openIndexedDbAdmissionDatabase` deletes and reopens a database whose
stores or schema identity no longer match. The event's `data` is the event
itself:

- `dbName`: the IndexedDB database that was reset
- `previousSchemaId`: the schema id read back before the reset, or `undefined`
  when the store set itself did not match (so no schema id could be read)
- `schemaId`: the current `AL_ADMISSION_SCHEMA_ID` the database now carries
- `reason`: `schema-id-mismatch` when the stores matched but the stored
  schema id differed, or `store-schema-mismatch` when the store set, key
  path, auto-increment, or index set did not match

This is the evidence an incompatible browser cutover (new indexes, new key
layouts, new stored fields) leaves behind: it confirms the old database was
discarded rather than left mismatched underneath a client that assumes the
current shape.

## Compatibility

Adding optional fields to diagnostic payloads is compatible.

Changing `diagnosticSchemaVersion`, `diagnosticTypeId`, severity semantics, or
the known bridged warning topics is a contract change. Update this document,
the iteration plan, and the focused diagnostic tests together.
