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

## RTC Lifecycle Diagnostics

`rallar.browser.rtc.lifecycle` carries one RTC lifecycle event per emission. Its
`kind` is `snapshot`, `connected`, `disconnected`, `peer-created`,
`peer-established`, `peer-deleted`, `peer-timeout`, `lane-open`, `lane-close`,
`lane-error`, or `signaling-failed`.

`signaling-failed` is the only kind that carries `signaling`, the handshake
signal this browser could not hand to the transport:

- `peerId` and `signalKind` (`offer`, `answer` or `candidate`) name the hop
- `admission` is the transport's verdict: `{ "outcome": "rejected", "status",
  "messageId" }` for a signal admission refused, or
  `{ "outcome": "never-admitted" }` when the hop failed before admission saw it
- `reason` is the failure text the hop carried

A lost offer strands its peer in `have-local-offer`, where
`onnegotiationneeded` cannot fire again, so this event is the evidence that a
handshake stopped rather than timed out.

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

- `kind`: `sender-queue-wait`, `browser-lock-wait`, `browser-lock-hold`,
  `commit-phases`, `effect-drain`, or `readiness-probe`
- `durationMs`: how long that phase took, on every kind but `commit-phases` and
  `readiness-probe`, neither of which carries one here
- `origin`: which call path asked for the commit — `send` for a caller's own
  `enqueueIfAbsent`, `drain` for the work batch's pending-admission and
  dequeue commits, `repair` for retransmission. It is on all four
  commit-scoped kinds, so a hold is charged to the work behind it rather than
  guessed at from a duration
- the phase's own identity fields: `senderId`, `queued` and
  `queuedBehindOrigin` for `sender-queue-wait`; `senderId`, `lockName` and
  `available` for the two `browser-lock-*` phases; `workerId`,
  `claimedCount`, `completedCount`, `rescheduledCount` and `rejectedCount`
  for `effect-drain`
- `queuedBehindOrigin` is the origin of the commit already at the end of that
  sender's queue, or `none` when the queue was empty. A drain's own commits
  re-enter the same per-sender queue, so this says when a send's wait is the
  batch it caused rather than another send
- `commit-phases` also carries `msgId` and `typeId`, so one message -- an RTC
  offer, say -- can be followed from the commit that admitted it to the drain
  that sent it, and a lane's commits can be counted apart from the rest
- `commit-phases` splits what `browser-lock-hold` measures as one number:
  `readDurationMs` and `readOperationCount` for the admission read chain
  (`readOutgoingMessage` plus the pending-admission probe, and the
  admission-store round trips observed while they ran), then
  `commitDurationMs` and `commitOutcome` for the write transaction —
  `committed`, `conflict`, `expired`, or `not-attempted` when the admission
  settled before opening one
- `readOperationCount` counts read **operations**, not transactions: several
  keys read from one storage transaction are several operations. It is also an
  upper bound rather than an exact per-call count, because the commit samples a
  store-level counter before and after its own chain and reports the window
  delta — a concurrent commit on the same store (another sender, or the same
  sender's drain) lands in that window and is counted too

- `readiness-probe` carries `workerId`, `cause` and `readyAtMs`: one event for
  every storage read an owner spends deciding whether it has work, which is the
  read the page's `work-page` and `work-reserve` counters charge. `cause` is why
  the owner had no remembered answer to give -- `own-commit`, `batch` and
  `retained-release` are this owner's own progress, `external-wake` is the
  announcement another writer made to every owner on the engine, `age-bound` is
  the memory reaching `AL_WORK_READINESS_MEMORY_MS`, and `no-memory` is an owner
  that has not probed yet. `readyAtMs` is the answer: an epoch-ms time work is
  next due, or `none` for no work at all. A probe is not a batch, so it is
  outside the empty-batch suppression the drains carry. The inbound rotation
  reports none: its probe reads a page every engine round by construction, and
  relaying one event per round costs more in this harness than the answer is
  worth (see **Inbound Admission Diagnostics** below)

Together they separate a page that reads storage more often because it is less
blocked from one that reads it more often because more wakes reach more owners:
the same probe count is benign under `own-commit` and a fan-out regression under
`external-wake`.

This is the evidence a `deadline-expiry` conformance run uses to attribute a
slow admission (the serialized IndexedDB chain a typed send commits through)
to a phase instead of a single opaque send latency.

## Inbound Admission Diagnostics

`rallar.browser.alm.inbound_diagnostics` carries one AL inbound runtime
diagnostics event per emission, recorded the moment the inbound runtime calls
the sink — the receiving half of the outbound topic above, and, like it,
independent of any connection. The event's `data` is the event itself:

- `kind`: `admission-outcome`, `effect-drain`, `claim-settled` or
  `rotation-alive`. There is no `readiness-probe` on this topic: the inbound
  rotation probes storage on every engine round by construction, and relaying
  one event per round doubled the page's measured per-operation cost in the
  conformance lane (8.2 → 20.9 ms/op) and delayed RTC signaling until the cell
  failed, so the inbound owner does not relay probes and `rotation-alive` below
  is its liveness witness instead
- `workerId`: the inbound work owner (`al-inbound:<uuid>`) the event belongs
  to, on every kind. One page runs a WS inbound owner and an RTC inbound
  owner, so this says which lane an event came from
- `admission-outcome` carries `msgId`, `typeId`, `outcome` and `reason` for
  every message that reached ingress with a decodable identity — one event per
  `admitIncomingMessage` call. A value that never decoded has no identity to
  report and emits nothing
- `outcome` is where the message stopped: `committed` (admitted, or a control
  the runtime handled — the only ending that leaves durable work behind),
  `pending` (held for an asynchronous authority recheck), `unauthorized`
  (ingress authority or the plan refused it), `rejected` (decode, validation,
  expiry, or a plan drop that is not an authority refusal), or `not-handled`
  (duplicate, resync-required, disposed, or an unhandled control)
- `reason` is the plan's drop reason, the rejection's code, or the acceptance
  kind that carries neither. A drop the RTC room-snapshot admission decided
  carries the drop code at the head of that reason and the denial that fired
  after it -- `not-yet-in-sync: Awaiting the required room snapshot version`,
  and likewise for the missing observation, the missing session, the missing
  member and the missing server relay authority -- so an RTC delivery lost at
  ingress names which of the five room-authority branches held it
- `effect-drain` carries `durationMs`, `claimedCount`, `completedCount`,
  `rescheduledCount` and `rejectedCount` for each inbound work batch that
  touched work, the same five fields the outbound topic reports for its own
  drains. A batch that claimed and rejected nothing reports nothing: the
  inbound rotation runs one every engine round, and recording its resting state
  costs the page hundreds of events per session that say only what the probe
  already decided — enough, measured, to move the very races this sink exists
  to explain
- `effect-drain` also splits that `durationMs` into where the batch spent it, so
  a drain that takes seconds names the phase that took them rather than one
  opaque number: `selectionDurationMs` (the page read and every eligibility read
  it made), `claimDurationMs` (the port's reservation of the rows that read
  cleared), `runDurationMs` (every claim's own work, summed) and
  `releaseDurationMs` (every release the batch wrote, summed, the exhaustion
  sweep's included). `queueWaitMs` is the fifth, and it is not a phase: it is how
  long the earliest row the batch claimed had already been **due** when the batch
  started, so a backlog reads apart from a slow drain. It counts every row the
  batch took, including a reservation whose lease start was missing and which the
  page therefore recovered without the queue reserving it
- the four phases do not sum to `durationMs`. The exhaustion sweep's own read is
  outside them, and so is the page read the readiness probe paid for: a probe
  that answers "due now" holds its page for the batch that follows, which reads
  none of its own and reports a `selectionDurationMs` near zero. That page read
  is reported nowhere on this topic — it is the cost the suppressed probe event
  would have carried, and a reader must not mistake its absence for a fast round
- `claim-settled` carries `msgId`, `typeId`, `payloadKind`, `durationMs`,
  `attempts`, `outcome` and `queueWaitMs`: one event for each claim a drain ran,
  so a delivery can be followed from its own `admission-outcome` to the claim
  that ran it, and one slow claim can be told from a batch of many. `payloadKind`
  is which effect the row held — `admit-message`, `admit-control`,
  `dispatch-local`, `forward-message`, `send-control` or `release-buffered`.
  `outcome` is what the claim returned: `completed`, `retry`, `not-ready` or
  `non-retryable`. `attempts` is how many processing attempts the row has spent,
  this claim included
- a `claim-settled` identity is only what its effect retains, and absence is
  `null` rather than any spelled-out name — `payloadKind` is the discriminator
  that says which effect withheld it. A retained admission (`admit-message`,
  `admit-control`) and a forwarded acknowledgement (`send-control`) keep the
  message, so both fields are its own; a delivery effect (`dispatch-local`,
  `forward-message`) keeps a reference, which carries the id and not the type, so
  `typeId` is `null`; a `release-buffered` effect names a track and a sequence
  rather than a message, so both are `null`
- a claim reports nothing when it throws, and when its work row could not be
  decoded at all: the generic work handler classifies those, and the
  `effect-drain` beside them still counts them. So `claimedCount` is a ceiling on
  the `claim-settled` events of one drain, never a guarantee of the count
- `rotation-alive` carries `workerId`, `emptyRoundCount`, `durationMs` and
  `longestRoundMs`: one event per `AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS` rounds
  that claimed and rejected nothing, with the wall time those rounds spanned and
  the slowest single round among them, so one crawling scan is not averaged away
  by the rest. It is the liveness witness the suppression above costs: without it
  a rotation that keeps finding nothing and a rotation that stopped running both
  report nothing at all. An owner whose queue is empty scans nothing and reports
  none

The kinds together discriminate a delivery that never arrives. An
`unauthorized` outcome is the drop that otherwise leaves no trace at all: it
writes nothing, sends no NACK and returns no error. A `committed` outcome that
no `effect-drain` ever follows is the other shape — the row exists and no
consumer is registered for its `typeId`, so the rotation never selects it, and
the `rotation-alive` events beside it are what say the rotation was running
while that happened.

`commit-phases.transportSettleDurationMs` is **never emitted**. No runtime
writes that field, on this topic or the outbound one, so no reader may depend on
it and no analysis may attribute a slow admission to it. The commit's two
measured halves are `readDurationMs` and `commitDurationMs`.

## Storage Reset Diagnostics

`rallar.browser.alm.storage_reset` carries an `ALStorageResetEvent` recorded
the moment `openIndexedDbAdmissionDatabase` deletes and reopens a database
whose stores or schema identity no longer match. This is not one event per
delete-and-recreate cutover: every opener racing the same mismatched database
detects it independently and emits its own event, so a single cutover can
leave behind N events, one per concurrent opener. The event's `data` is the
event itself:

- `dbName`: the IndexedDB database that was reset
- `previousSchemaId`: the schema id read back before the reset, or `undefined`
  either when the store set itself did not match (so no schema id could be
  read) or when the stores matched but the database carried no schema record
  at all (an undecodable or absent schema row is treated as a mismatch, not a
  hard failure)
- `schemaId`: the current `AL_ADMISSION_SCHEMA_ID` the database now carries
- `reason`: `schema-id-mismatch` when the stores matched but the stored
  schema id was missing, undecodable, or differed, or `store-schema-mismatch`
  when the store set, key path, auto-increment, or index set did not match

This is the evidence an incompatible browser cutover (new indexes, new key
layouts, new stored fields) leaves behind: it confirms the old database was
discarded rather than left mismatched underneath a client that assumes the
current shape.

## Compatibility

Adding optional fields to diagnostic payloads is compatible.

Changing `diagnosticSchemaVersion`, `diagnosticTypeId`, severity semantics, or
the known bridged warning topics is a contract change. Update this document,
the iteration plan, and the focused diagnostic tests together.
