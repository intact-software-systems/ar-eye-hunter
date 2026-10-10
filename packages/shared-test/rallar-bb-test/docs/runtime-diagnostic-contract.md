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
- `admission` is the transport's verdict: `{ "outcome": "rejected", "verdict",
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
  `commit-phases`, `effect-drain`, `readiness-probe`, `control-admission`,
  `receipt-confirmation`, or `congestion`
- `durationMs`: how long that phase took, on every kind but `commit-phases`,
  `control-admission`, `receipt-confirmation` and `congestion`: `commit-phases` splits its own into the two halves
  below, and `control-admission` is a verdict, not a phase. On
  `readiness-probe` it is not a phase of a commit at all but what that owner's
  storage read cost
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
  `readDurationMs` and `readOperationCount` for the admission read chain.
  `readDurationMs` covers the whole decision read (`readOutgoingMessage` plus
  the pending-admission probe and the decision; for a single send also the
  effect rows and the canonical pair its commit fences, read in the same
  session). `readOperationCount` counts only the admission reads that go
  through `ALOutboundAdmissionReads` (`readValue` and `readQueueItem`); the
  work-store rows the session reads (the effect rows and the canonical pair)
  are timed but not counted. Then come
  `commitDurationMs` and `commitOutcome` for the write transaction —
  `committed`, `conflict`, `expired`, or `not-attempted` when the admission
  settled before opening one
- `readOperationCount` counts read **operations**, not transactions: several
  keys read from one storage transaction are several operations. It is also an
  upper bound rather than an exact per-call count, because the commit samples a
  store-level counter before and after its own chain and reports the window
  delta — a concurrent commit on the same store (another sender, or the same
  sender's drain) lands in that window and is counted too

- `commit-phases`, `effect-drain` and `readiness-probe` carry `lane`: `durable`
  when the owner runs over the IndexedDB pair, `volatile` when it runs over the
  session's memory pair (a `…/volatile` worker id). The WS server's single-lane
  runtime is always `durable`. The observation's runner regime reads the
  `durable` lane only (R-S3a-15)
- `readiness-probe` carries `workerId`, `cause`, `readyAtMs` and `durationMs`:
  one event for every storage read an owner spends deciding whether it has work,
  which is the read the page's `work-page` counter charges.
  `cause` is why the owner had no remembered answer to give -- `own-commit`,
  `batch` and `retained-release` are this owner's own progress (a commit
  another browser tab of the session announced reaches the owning tab's lane
  as that lane's own commit, so it reads `own-commit` there), `external-wake`
  is the announcement another writer made to every owner on the engine,
  `age-bound` is the memory reaching `AL_WORK_READINESS_MEMORY_MS`, and
  `no-memory` is an owner with no answer that has not probed yet, or whose last
  probe failed after taking the cause it owed; an aged answer survives a failed
  probe, so the probe after it reports `age-bound` again.
  The first of these since the last probe names the next one. A commit sets its
  owner's answer aside, and the batch the commit runs restores it when the
  commit described the rows it wrote (an undescribed commit, such as a control
  admission or an inbound one, never restores); that batch claimed fewer than a
  page, rejected nothing, completed every claim, among them a claim of every row
  the commit wrote; no external wake, retained release or further commit reached
  the owner since the commit, and no claim of the batch could write work rows of
  its own (a send attempt writes none, and a dequeue's dispatch goes through the
  owner's own commit, so a dequeue that writes nothing still restores); the
  answer was neither due nor aged out when the batch started; and every row the
  commit wrote was due by then. A plain send therefore reports no probe after
  its `effect-drain`. `readyAtMs` is the answer: an epoch-ms time work is next
  due, or `none` for no work at all. `durationMs` is what that read cost, and
  this is where it is charged: an owner whose probe answers "due now" holds the
  page for the batch that follows, which reads none of its own. A probe is not a
  batch, so it is outside the empty-batch suppression the drains carry. The
  inbound rotation reports none: its probe reads a page every engine round by
  construction, and relaying one event per round costs more in this harness than
  the answer is worth (see **Inbound Admission Diagnostics** below). The ALM
  observation artifact reads this bullet's `age-bound` probes as the page's
  storage-queue regime (`pageRegime`, `alm-observation-artifact.md`)

- `control-admission` carries `msgId`, `typeId`, `targetMsgId`, `outcome`,
  `reason`, and for a receipt `phase` (below): one event for every inbound
  ACK, NACK, repair or receipt control the outbound owner decides, recorded
  when it decides it. Every carrier discards
  that verdict: the inbound topic's `admission-outcome` for the same control
  reads `not-handled`/`control` whatever the outbound owner answered, so this
  event is the only record of it. `msgId` is the control's own id, the join key
  to that `admission-outcome`, and `targetMsgId` is the sent message it
  answers. `outcome` is `committed`, `pending-control` (a conflict retained as
  `admit-control` work, which the outbound drain replays), `rejected`, or
  `not-handled` (the control's repair authority failed, or a NACK the origin
  leaves to its hop: the WS server's advisory `not-yet-in-sync` NACK on a room
  send, which the server retains and delivers itself once its room meets the
  floor). `reason` is the
  rejection's reasons, or `none` for every other outcome — for an ACK whose
  receipt is gone it reads `AL acknowledgement sender has no pending outbound
  obligation`. A control's replay reports nothing here; its commit is visible
  as the acknowledgement settlement on the send's handle. It is one event per
  control frame the page receives, the same cadence as `admission-outcome`,
  and rides the page's batched diagnostics like every other kind
- A WS server receipt (`al.control.receipt.v1`) is decided by the origin's
  receipt admission, not control admission, and states the same
  `control-admission` event: `msgId` is the receipt control's own id,
  `typeId` is `al.control.receipt.v1`, and `targetMsgId` is the sent message
  the receipt names. `outcome` is `committed` when the receipt moved the
  origin's receipt row, or `rejected` with its reasons — a receipt that moves
  nothing reads `AL receipt moves no receipt of its message`, and one about a
  message the origin never sent reads `AL receipt names no retained outbound
  message of its origin`. It also carries the receipt's `phase` (`admitted`,
  `complete` or `timed-out`) as its last field. No other control has a phase, so
  the field is absent from every other `control-admission` event; it is optional
  only for that reason. Because it comes last, a wait that matches `typeId`,
  `targetMsgId` and `outcome` in their emitted order still matches a receipt,
  and one that appends `"reason":"none","phase":"complete"` matches only the
  committed terminal receipt. Its arrival is also the inbound topic's
  `admission-outcome` with that `typeId`, carrier `ws` and
  `not-handled`/`control`, joined by `msgId`; a committed receipt is also
  the acknowledgement settlement on the send's handle (`messages.receipts`
  reads the logical recipients)
- `receipt-confirmation` is a separate closed observation for each receipt
  admission attempt that reaches a validation decision or actual commit
  return, including rejected, conflicted and expired attempts. Read/commit
  exceptions remain with the existing storage-failure owner and produce no
  new confirmation observation or invented commit disposition. The existing
  `control-admission` bytes and phase-last field order
  are unchanged. It carries the receipt control's `msgId`, `typeId` and
  `controlSenderId`, the decoded `targetMsgId` and `originPeerId`, exact
  `expectedRecipientPeerIds` and `confirmedRecipientPeerIds`, `snapshotVersion`,
  `phase` and `observedAtEpochMs`. The server's `snapshotVersion` is an audience
  revision, separate from `senderVersion`, the already-read local CAS version.
  `admissionAtMs` is the existing local computation clock capture; it is not
  the receipt producer's observation clock. `attempt` is one-based within the
  existing bounded three-attempt retry loop.
  `pendingBefore` is the already-read receipt snapshot, `candidateAfter` is
  the computed write snapshot, and `candidateExpiresAtMs` is its retention
  deadline. The candidate is not independently read persisted-after state.
  Both snapshots carry only `msgId`, `mode`, expected/acked peer lists,
  `timeoutMs`, `maxAttempts`, `attempts` and `deadlineAtMs`.
  `commitOutcome` is the actual `committed`, `conflict` or `expired` return,
  or `not-attempted` on validation rejection. `settlement` is an independent
  snapshot of the exact once-computed logical acknowledgement fact passed to
  the existing emitter on commit, before carrier/lane/time stamping. It
  includes the expected, confirmed and unconfirmed recipients, confirmed and
  unconfirmed hops, mode, subject `msgId` and actual `complete` flag.
  Missing pending, candidate, expiry, sender version or settlement is explicitly
  `null`, preserved in serialized recordings. A noncommitted attempt has no
  settlement; a `complete` phase may still carry incomplete logical
  confirmation. Lists and records are copied and frozen before any mutable
  settlement consumer runs; external diagnostic publication follows the
  existing settlement emission so an observational lifecycle read cannot
  preempt that acknowledgement. Rejected or noncommitted attempts have no
  settlement emission to precede publication.
  No application payload, credentials or arbitrary error prose is retained.
  The existing guarded sink tolerates absence/failure without changing the
  receipt result, store writes, retry/deadline policy or settlement effects.
  The native browser diagnostic port records these fields on the same outbound
  topic. These facts do not establish appointed-leader authority, live registry
  or epoch observation, wait notification, or native delivery acceptance.

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
  owner, so this says which carrier an event came from
- `lane`, on `effect-drain`, `claim-settled` and `rotation-alive`: `durable` for
  the owner over the IndexedDB pair, `volatile` for the one over the session's
  memory pair (worker id `…/volatile`)
- `admission-outcome` carries `msgId`, `typeId`, `carrier`, `outcome` and
  `reason` for every message that reached ingress with a decodable identity —
  one event per `admitIncomingMessage` call. A value that never decoded has no
  identity to report and emits nothing
- `carrier` is the carrier the message arrived on, `rtc` or `ws`, read from its
  ingress source: `rtc-peer` is `rtc`, `ws-client` and `trusted-server` are `ws`
- `outcome` is where the message stopped: `committed` (admitted, or a control
  the runtime handled — the only ending that leaves durable work behind),
  `pending` (held for an asynchronous authority recheck), `unauthorized`
  (ingress authority or the plan refused it), `rejected` (decode, validation,
  expiry, or a plan drop that is not an authority refusal), or `not-handled`
  (duplicate, resync-required, disposed, an unhandled control, or a control
  its store could not persist, whose reason reads `storage-unavailable: <cause>`
  with the cause `toALStorageUnavailable` named)
- `reason` is the plan's drop reason, the rejection's code, or the acceptance
  kind that carries neither. A drop the RTC room-snapshot admission decided
  carries the drop code at the head of that reason and the denial that fired
  after it -- `not-yet-in-sync: Awaiting the required room snapshot version`,
  and likewise for the roster floor (`Awaiting the required room roster
  version`), the missing observation, the missing session, the missing member
  and the missing server relay authority -- so an RTC delivery lost at ingress
  names which of the six room-authority branches held it. A copy whose sender
  is no longer an active member at or beyond the roster it stamped reads
  `rejected` with `membership-fenced: Room sender is not an active member of
  the room roster`, or `membership-fenced: Room sender has no live session in a
  roster beyond its stamp`, and its hop NACKs it `membership-fenced`
- a raw control a recipe submits through `messages.control` is decided by its
  addressee's ingress like any control, so its addressee states this event
  under the recipe's authored `msgId`: a retired `al.control.ack.v1` reads
  carrier `rtc`, `rejected`/`unsupported`. The `messages.control` result is the
  submitting page's own carrier verdict (`admitted` when that carrier took the
  frame), never the addressee's
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
  `releaseDurationMs` (the one release flush that ended the batch, the exhaustion
  sweep's finalizations included in it; a retained claim settles serially after the
  batch and is released outside this flush, so it adds nothing to the figure).
  `queueWaitMs` is the fifth, and it is not a phase: it is how
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
- `effect-drain` also carries `startedAtMs`, the instant the batch's run loop
  started — after its exhaustion sweep, its selection and its reservation, before
  its first claim ran — which every claim of the batch receives as its
  `batchStartedAtMs`. It is not the start `durationMs` and `queueWaitMs` are
  measured from: those run from the batch's own earlier start. `claimedEffectIds`
  is the batch's run order: the effect id of every claim the batch ran, in the
  order it ran them, recorded by the inbound owner as it starts each claim. Every
  id in it also appears as a `claim-settled.effectId`, unless that claim threw
  before it settled; a claim whose row could not be decoded has no id and appears
  in neither. `deferred` lists the due rows the batch's page saw and did not
  run, as `{ effectId, dueAtMs }`, oldest first — held back by their eligibility
  read, or cleared by it and left unreserved by the port. A row a live lease
  holds is not due, so a batch's own rows never read as deferred. `promoted`
  counts the buffered releases the batch ran because the same track's previous
  release completed earlier in that batch (D190): each is also counted in
  `claimedCount` and named in `claimedEffectIds`, and none is listed in
  `deferred`
- `claim-settled` carries `msgId`, `typeId`, `payloadKind`, `durationMs`,
  `attempts`, `outcome` and `queueWaitMs`: one event for each claim a drain ran,
  so a delivery can be followed from its own `admission-outcome` to the claim
  that ran it, and one slow claim can be told from a batch of many. `payloadKind`
  is which effect the row held — `admit-message`, `admit-control`,
  `dispatch-local`, `forward-message`, `send-control` or `release-buffered`.
  `outcome` is what the claim returned: `completed`, `retry`, `not-ready` or
  `non-retryable`. `attempts` is how many processing attempts the row has spent,
  this claim included
- `claim-settled` also carries `effectId`, `subjectMsgId`, `dueAtMs`,
  `batchStartedAtMs` and `startedAtMs`. `effectId` is the claimed row's own
  effect id, the join key to the `effect-drain.claimedEffectIds` of its batch.
  A `release-buffered` row's is `release:<track key>:<seq>`, the track key
  `<ordering key>:<sender peer id>:<epoch>` URI-encoded, so it is the only
  field that names the track and the sequence the release handed over.
  `dueAtMs` is when the row became due, `batchStartedAtMs` when its batch's run
  loop started (after the batch's selection and reservation) and `startedAtMs`
  when this claim's own work began, so a delivery's wait splits into
  `batchStartedAtMs − dueAtMs` — everything from due to the run loop: waiting for
  a round to take the row, plus that batch's own selection and reservation, which
  its `effect-drain` reports as `selectionDurationMs` and `claimDurationMs` for a
  reader to subtract — and `startedAtMs − batchStartedAtMs`, the serialization
  behind earlier claims in the same run loop and nothing else. `queueWaitMs` is
  now exactly `batchStartedAtMs − dueAtMs` of the same event, floored at zero, so
  the two can never disagree; it therefore exceeds the `effect-drain`'s own
  `queueWaitMs`, which stops at the batch's earlier start, by that batch's sweep,
  selection and reservation
- `subjectMsgId` is the message the effect acts on: a control's acknowledged,
  nacked or repaired message (`ackedMsgId` or `msgId` of its payload), a retained
  or delivered message's own id, and `null` for `release-buffered`. It is the
  join key from an ACK to the delivery it acknowledges: a `send-control` claim's
  `msgId` is the control envelope's own id, and its `effectId` is suffixed with
  that envelope id, so neither names the delivery
- a `claim-settled` `queueWaitMs` is computed from the reserved entry, and a
  reservation clears the row's retry stamp: a row that had already been retried
  answers from when it was written, so its claim overstates the wait. The
  `effect-drain` beside it is exact: its own wait is read from the observed page,
  before any reservation replaced that stamp. So a backlog is measured from the
  batch, and a claim's own wait is read as an upper bound
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
- `rotation-alive` also carries `deferredRoundCount`, how many of those rounds
  saw a due row they did not run, and `latestDeferred`, the `{ effectId, dueAtMs }`
  rows the latest such round did not run, oldest first. A round that finds a due
  row it cannot run is exactly the idle round that must relay nothing, so the
  witness rides on this event, which already stands for its rounds, rather than
  on one of its own

The kinds together discriminate a delivery that never arrives. An
`unauthorized` outcome is the drop that otherwise leaves no trace at all: it
writes nothing, sends no NACK and returns no error. A `committed` outcome that
no `effect-drain` ever follows is the other shape — the row exists and no
consumer is registered for its `typeId`, so the rotation never selects it, and
the `rotation-alive` events beside it are what say the rotation was running
while that happened.

After a submission's `admission-outcome`, the receiver's events say where its
delivery waited:

| What the receiver's snapshot shows after the submission's `admission-outcome`                        | Meaning                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A `claim-settled` naming the dispatch effect, with `batchStartedAtMs` after the admission            | A round reserved it; the two wait halves are on that event                |
| The dispatch effect id in an `effect-drain.deferred` or `rotation-alive.latestDeferred`              | Rounds ran and held it back (eligibility), or the port left it unreserved |
| `claim-settled` events of another effect with a `batchStartedAtMs` after the admission, and no drain | A batch started and was still running at teardown (the in-flight batch)   |
| None of the three, and no `rotation-alive` after the admission                                       | No round ran at all — the rotation was blocked or stopped                 |

`commit-phases.transportSettleDurationMs` is **never emitted**. No runtime
writes that field, on this topic or the outbound one, so no reader may depend on
it and no analysis may attribute a slow admission to it. The commit's two
measured halves are `readDurationMs` and `commitDurationMs`.

## Storage Reset Diagnostics

The browser's `RallarDiagnosticsPorts.storage` port receives every
`ALStorageEvent` of the browser ALM stores. The harness publishes its `reset`
arm here and every other arm on `rallar.browser.alm.storage` (below).

`rallar.browser.alm.storage_reset` carries an `ALStorageResetEvent` recorded
the moment `openIndexedDbAdmissionDatabase` deletes and reopens a database
whose stores or schema identity no longer match. This is not one event per
delete-and-recreate cutover: every opener racing the same mismatched database
detects it independently and emits its own event, so a single cutover can
leave behind N events, one per concurrent opener. The event's `data` is the
event itself:

- `dbName`: the IndexedDB database that was reset; for the browser runtime, the
  scope's database `rallar-al-runtime:<applicationId>:<workspaceId>`
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

## Storage Diagnostics

`rallar.browser.alm.storage` carries every `ALStorageEvent` but a reset; the
event's `data` is the event itself, with `kind` and, except for `persist`, the
`storeId` of the store it describes (`browser-session-inbound:<sessionId>`,
`browser-ws-client:<sessionId>` or `browser-rtc-overlay:<sessionId>`, and the
`local-checkpoint` lanes' checkpoint stores `browser-ws-client-checkpoint:<sessionId>`
and `browser-rtc-overlay-checkpoint:<sessionId>`). The
session inbound store is shared by the WS and RTC lanes, so its `recovery`
names the lane after the store id (`browser-session-inbound:<sessionId>/ws`,
`browser-session-inbound:<sessionId>/rtc`). A checkpoint store is the tier's
saved copy of a memory lane; it is unrelated to the harness's reload
checkpoints (`AlmReloadCheckpoint`, the `almReloadCheckpoints` metadata), which
are the sync points of a paired `agent.reload`.

- `health`: `status` (`healthy`, `delayed` or `failing`), `lastFailure` (an
  `ALStorageUnavailable`: `cause` and `detail`), `lastRecoveryPointAtMs`
  (the store's last recovery point, or `undefined` before its first) and
  `oldestUnsavedAgeMs` (a checkpoint store's oldest unsaved change). A store
  starts `healthy` without an event and states only a change of status, never
  one event per send: `failing` at its first storage failure, `healthy` at the
  first recovery point after it. Every emitted event carries the failure that
  made it `failing`, and the `healthy` that ends it keeps that failure. A later
  failure while the store is already `failing` replaces `lastFailure` without
  an event.

  A durable lane records a storage failure of its open, of a send's commit, of a
  control, receipt or inbound admission, and of a work batch. A committed send,
  an inbound admission that wrote work and a flushed batch are recovery points;
  a committed control or receipt is none, so a failure a control recorded stays
  `failing` until a send or a batch commits.
  A send whose channel chose `onStorageUnavailable: 'volatile'` and that its
  carrier then admits without storage is no recovery point.

  A purge of an ended session's rows (logout, a login over a session, a session
  switch) that fails states `failing` once for each of that session's three
  store ids, straight on the port, since those stores are gone. Its
  `lastFailure` is absent when the purge failed for a reason other than
  storage; the browser logs that error instead.

  A checkpoint store states `delayed` once a checkpoint write failed or its
  oldest unsaved change is two checkpoint intervals old (2 s by default; a
  timer a few milliseconds late states nothing) and `failing` with
  `lastFailure.cause: 'checkpoint-lag'` once it is older than the recovery-lag
  bound (10 s by default); a completed checkpoint reads `healthy` again. While
  it is `failing`, for that lag or any other cause, a new `local-checkpoint`
  admission follows its channel's `onStorageUnavailable`. `checkpoint-lag`
  holds the `quota` storage fault on the sender's page, admits one send from
  memory, waits for its checkpoint store's `delayed` and then `failing` with
  that cause, proves the next send refused `storage-unavailable` with cause
  `checkpoint-lag`, releases the fault, waits for the store's `healthy`, and
  then proves the next send admitted and delivered.

- `recovery-owner-invoked`: the browser handed a typed channel's recovery owner
  the cursor of an ordering track it can no longer order, once per track
  (ordering key, sender, epoch) while it goes on resynchronizing (a track forgotten
  after 5 minutes without a resynchronization is invoked again), after the sender
  was NACKed `resync-required`. The event is the cursor with its `kind` first:
  `orderingKey`, `senderId`, `epoch`, `lastContiguousSeq`, `expectedSeq`,
  `observedSeq` and `carrier`, in that order. It has no `storeId`. It is stated
  even when the owner throws; without an owner nothing is stated and the
  message is dropped as before. The harness's recording owner, installed by the
  lane-only `rtc.connect.rallar.recoveryOwner: 'record'`, states the same cursor
  as a `rallar.browser.messages.recovery_owner_invoked` diagnostic.

- `ordering-tracks`: `storeId` and `tracks`, the number of ordering snapshots an
  inbound store holds right after the eviction a newly opened track runs (D191):
  at most 256 unless a removal found its snapshot changed or conflicted, which leaves it to the next new track.
  Only the browser's stores are capped and state it; a pass that fails states nothing.
  The session's IndexedDB store states it under its store id, its memory pair as
  `<store id>/volatile`; a known track's next message states nothing. The harness
  keeps each store's latest count and reads their sum as `stats.rallar.alm.orderingTracks`.

- `persist`: `outcome` (`granted`, `denied` or `unsupported`), once per connect
  after its first durable admission: `granted` when the origin already
  persisted or the browser granted the request, `denied` when it refused or the
  request failed, `unsupported` without `navigator.storage.persist`. It has no
  `storeId`.

- `recovery`: one event per durable store, and per lane of the shared session
  inbound store, per connect, `outcome` being what the store found when its
  lane started. A durable store reports its outcome when its lane's first work
  batch runs, which for an outbound store without work can be long after the
  connect; a store whose lane runs no batch before the document ends reports
  nothing, and a store whose open failed never starts its work and reads as a
  `failing` `health` event instead. The three stores of a session share one
  per-scope database, and a creation, reset or eviction one of them found is a
  fact of their connect: each store of that connect reports it once, whichever
  store's open found it. A later connect, of another session or of the same
  one, reads the database as it is. `outcome` is:
  - `storage-created`: the database was created, the first time this document
    opened it
  - `storage-reset` with `reason`: the database was reset because it did not
    match (`schema-id-mismatch`, `store-schema-mismatch`), or created again
    after another context's `versionchange` closed this document's connection
    (`other-context`); a reset wins over the creation it caused
  - `restored` with `claimed` and `expired`: the database existed; `claimed` is
    what the lane's first batch claimed, `expired` the expired rows of the
    lane's own work type its reservations deleted up to that batch
  - `expired-at-recovery` with `expired`: the first batch claimed nothing and
    those reservations deleted expired rows

  A creation of a database this document had opened, without a `versionchange`
  first, is an eviction: the store's health records it as a failure, so it
  reads as a `health` event with `status: 'failing'` and
  `lastFailure.cause: 'evicted'` instead of a recovery. `delivery-reload` waits
  after the reload for a `restored` recovery of the session inbound store's WS
  lane, which runs on every carrier, and of the outbound store that holds the
  original: the RTC overlay store on `rtc`, the WS client store on `ws` and on
  `rtc-with-ws-fallback`, whose hold hands the original to WS before the
  reload.

  Where the browser has the Locks API, only the tab that holds the session's
  durable-owner lock runs its durable lanes' batches, so the outcomes are the
  session's and come from that tab alone; another tab of the session reports
  no `recovery` while it waits. When the owner's connect ends, the next tab's
  lock is granted, and its first batch, the takeover's, reports `restored` with
  the rows it claimed: a row the previous owner still held under its lease is
  claimed by a later batch, at its lease end plus at most 19.1 s. Without the
  Locks API every tab drains, and reports, as before. `durable-takeover` closes
  the owner page with one durable original held, waits out one lease before the
  successor page connects, then waits for the successor's `restored` recovery
  of the store that held the original (chosen as `delivery-reload` chooses it)
  and asserts its `claimed` above 0. Over `rtc-with-ws-fallback` the owner page
  closes only once its receipt records the hand-over to WS and a WS attempt (a
  `loop` until the first success over `messages.receipts`, asserting that
  `carrierFallback.to` is `ws` and that `attemptCarriers` contains `ws`): the
  hand-over is recorded before the WS row commits, and a WS attempt exists only
  once it has, so the held row is in the WS client store the successor reads.

  A checkpoint store reports `restored` when its lane's first batch runs over
  the rows the owner's restore loaded from the last checkpoint; a non-owner tab
  restores nothing. `checkpoint-recovery` reads one checkpoint write after the
  interval, reloads, waits out one lease and reads the held original's
  checkpoint store (`browser-rtc-overlay-checkpoint` over `rtc`,
  `browser-ws-client-checkpoint` otherwise) `restored` with `claimed` above 0;
  `flush-on-hide` reads the same on the successor page after the lane fired the
  owner page's `freeze` event and crashed it.

## Compatibility

Adding optional fields to diagnostic payloads is compatible.

Changing `diagnosticSchemaVersion`, `diagnosticTypeId`, severity semantics, or
the known bridged warning topics is a contract change. Update this document,
the iteration plan, and the focused diagnostic tests together.
