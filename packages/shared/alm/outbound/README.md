# Outbound admission and durable replay

[`ALOutboundMessageRuntime`](./al-outbound-message-runtime.ts) is the public
lifecycle boundary: it enqueues, accepts control messages, claims work, and routes
each claimed durable effect to the owner that runs it. It never sends or mutates
admission state itself. [`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)
owns sender serialization, browser locking, and optimistic read/compute/commit.
[`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) owns control
acceptance, the ACK-timeout schedule, and the not-yet-in-sync retry schedule; it
commits new bundles and never sends.
[`ALOutboundRepairRetransmission`](./al-outbound-repair-retransmission.ts) owns the
repair-by-hint path and commits through dispatch admission.
[`ALOutboundMessageEffects`](./al-outbound-message-effects.ts) runs the three
message-shaped effects — `admit-message`, `dequeue-message`, and `send-prepared`.
[`ALWorkHandler`](../work/al-work-handler.ts) registers outbound work with the
existing [`InboxOutboxEngine`](../../services/InboxOutboxEngine.ts) through
[`ALWorkQueuePort`](../work/al-work-queue-port.ts). QueueBox owns durable
reservation, release, expiry, retry, and exhausted-attempt recovery. A queued native
send retains its claimed work until transport settlement; it does not block available
peers or complete merely because the carrier accepted local queue ownership.

## Construction and registration

WS client, WS server, and RTC multicast composition supply a completed admission
store, queue, clock, engine, worker identity, transport planner, and prepared
message decoder before constructing `ALOutboundMessageRuntime`;
[`createDefaultALOutboundRuntimeResources`](./create-default-al-outbound-message-runtime.ts)
is the named composition root that resolves the optional resources once. The
constructor builds its `ALWorkQueuePort`, asks the admission store for the scope's
[`ALOutboundControlAdmission`](./control/al-outbound-control-admission.ts), then
constructs dispatch admission, repair admission, repair retransmission, the
`ALWorkHandler`, and finally the message-effect owner. Registration does not invoke
any of them. `ready()` awaits storage readiness before the first claim. Disposing the
runtime closes dispatch admission, removes its engine task, and aborts owned RTC queue
items; the same abort signal is what the effect owner reads as "disposed". A supplied
engine remains available to its other tasks; a runtime-owned engine stops. An
interrupted durable claim remains recoverable after its lease expires.

The transport decoding owners are
[`decodeALOutboundPreparedMessage`](./al-outbound-effect-validation.ts) for WS
client and RTC envelopes, and
[`decodeWsQueueBoxServerPreparedMessage`](../../services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts)
for the server's recipient/cluster-completion union. Prepared transport values
are reconstructed from a canonical envelope and compact persisted transport
descriptors. Admitted send-action replay does not regenerate its recipients or
policy by rerunning a planner.

## The admission directory

[`admission/`](./admission) holds the state this scope persists and the transaction
that writes it. [`ALOutboundAdmissionStore`](./admission/al-outbound-admission-store.ts)
is the public port and owns the commit fence;
[`ALOutboundAdmissionReads`](./admission/al-outbound-admission-reads.ts) assembles
every read DTO; [`ALOutboundAdmissionMutations`](./admission/al-outbound-admission-mutations.ts)
turns each `ALOutboundAdmissionMutation` into the state write it names, checks the
guards that write carries, and applies it inside the transaction;
[`al-outbound-admission-keys.ts`](./admission/al-outbound-admission-keys.ts) owns
every admission key string;
[`ALOutboundAdmissionEffectStore`](./admission/al-outbound-admission-effect-store.ts)
owns durable effect rows; and
[`al-outbound-admission-validation.ts`](./admission/al-outbound-admission-validation.ts)
decodes the persisted snapshots. Every fence — the sender version, the pending-admission
row, an observed effect row, and a moved supersedence observation — resolves a conflict
the same way: the guard throws `ALAdmissionBackendConflictError` inside the transaction so
the backend aborts without writing, leaving every row at the revision and write token it
already had, and the store catches it at its public boundary and returns the typed
`'conflict'` result. Only a write conflicts. A read chain's expiry eviction that finds its row
moved by another writer leaves the row to that writer and answers from its snapshot (the inbound
README's decision-surface section), so `ALOutboundControlAdmission.admit` never loses an
acknowledgement to a throw out of `readControlAdmission` or its effect read.

## Canonical message storage

[`al-outbound-canonical-message.ts`](./al-outbound-canonical-message.ts) owns the
canonical key, full message reference, identity fact, and their validation.
[`al-outbound-canonical-storage.ts`](./al-outbound-canonical-storage.ts) reads and
compares those observations and writes new facts through the admission transaction.
Each message has one raw envelope. Sent metadata, recipient actions, and repair work
refer to it; [`al-outbound-transport-message.ts`](./al-outbound-transport-message.ts)
captures and reconstructs the permitted transport differences.

Every stored key is `topicId/resourceId/contextId`. Outbound work is
`AL_OUTBOUND/<namespace>/<effectId>`; the canonical envelope is
`AL_OUTBOUND_MESSAGE/scope-<hash>/message-<hash>` and its immutable identity fact
mirrors that locator under `AL_OUTBOUND_IDENTITY`. The owner leads the key so one
browser session's rows are a bounded key-range delete rather than a scan.

Browser RTC and WS for the same local session share the canonical scope and queue,
with separate admission/action namespaces. The bounded hashed physical key is a
locator; the retained full-identity fact and exact content establish valid reuse.
Different sessions cannot share authority through a matching locator.

Canonical payload and identity retention ends at the original delivery deadline.
Their `COMPLETED` queue status denotes a retained fact, not a receiver receipt.
Compact receipt/control state can remain useful after the payload expires, but
payload-dependent sends and repair stop at the deadline. Live missing or mismatched
references are corruption. Superseding messages retain separate canonical payloads;
they do not overwrite a predecessor's envelope.

An initial admission conflict can retain a validated message and compact
`admit-message` work through
[`retainALOutboundPendingAdmission`](./al-outbound-pending-admission.ts).
The worker rereads current admission facts for one new attempt. The retained policy,
original deadline, and authorized transport provenance remain unchanged; the stored
candidate contains no prior mutable write context. A terminal pending descriptor
cannot be revived or reported as a retryable owner merely because its content matches.

The server's independently produced `WS_OUTBOX` rows remain active canonical
sources. Cluster notifications carry bounded key/type/deadline claims, which the
[`QueueBoxPubSubBridge`](../../../shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts)
checks against the retained message and identity before delivery. Publication is a
transport action and does not confirm the logical audience; a server receipt does (below).

## Admission and invocation paths

| Entry                        | Decision and durable result                                                                                                                                                                                                                             | After commit                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueueIfAbsent`            | Dispatch admission reads validated state and computes a bundle. Its commit compares sender versions and original supersedence observations, then writes admission state and QueueBox work atomically.                                                   | The runtime wakes the existing worker after commit, outside admission's sender/browser lock.                                                                                                                      |
| `enqueueAllIfAbsent`         | One sender's messages read, computed and validated as `enqueueIfAbsent` does, then one `commitBundles` write under one version fence (see Grouped control sends below).                                                                                 | The runtime wakes the existing worker once for the group; each message still reports its own `commit-phases` event.                                                                                               |
| `acceptControlMessage`       | Repair admission checks that this scope owns the control, then `ALOutboundControlAdmission` validates identity, control history, and pending receipts and commits control state and repair work together.                                               | The runtime wakes the existing worker; repair admission schedules a not-yet-in-sync retry when the committed control is a not-yet-in-sync NACK.                                                                   |
| `admit-message` work         | `ALOutboundMessageEffects` reads pending admission authority, rechecks the retained deadline, and commits the retained policy through dispatch admission.                                                                                               | The claim completes. Rejected or expired authority completes without admitting; a not-ready authority reschedules with its own delay.                                                                             |
| `dequeue-message` work       | A foreign queue row this owner admits: `ALOutboundMessageEffects` rereads the message, drops it when superseded, and commits a dispatch plan.                                                                                                           | Circuit-open resilience reschedules; `no-route` retries; expired, superseded and skipped complete; an admitted plan completes and runs the configured `afterDequeueAdmission` port.                               |
| `send-prepared` work         | `ALOutboundMessageEffects` rechecks supersedence, receipt completion, deadline, and abort before calling the transport.                                                                                                                                 | An immediate outcome completes or reschedules; a queued native send is retained until the transport settles it.                                                                                                   |
| `ack-timeout` work           | Repair admission rereads the receipt snapshot. Before the deadline it recommits the next timeout; at it, it charges one attempt and commits the next timeout plus a `repair-hint`, clears a complete receipt, and out of budget schedules nothing more. | New work is available to the existing engine; the schedule never sends directly.                                                                                                                                  |
| `repair-hint` / `nack-retry` | Repair retransmission reresolves the cached message (by ordering track when the hint names missing sequences), applies repair policy, and commits a fresh dispatch through dispatch admission.                                                          | New work is available to the existing engine; retransmission does not recursively invoke the work handler.                                                                                                        |
| Startup / scheduled wakeup   | `ALWorkQueuePort.claim` reserves; `ALOutboundAdmissionEffectStore` then decodes and validates the claimed row (`readWorkSnapshot`, `validateObservedWork`). Malformed work becomes `NON_RETRYABLE`; valid claims remain independently available.        | One batch runs at a time and its claims run in order; a commit landing behind a batch earns one follow-up batch. QueueBox compares the exact reservation on release, so an old worker cannot alter a newer claim. |

The receipt an acknowledgement completes against is an obligation that expires exactly at the
message's deadline, however early or late its retry schedule ends. The `ack-timeout` rows expire
when the schedule ends or at the deadline, whichever comes first, and spending the budget stops
retransmission without deleting the receipt. So an ACK that arrives after the last retry but inside
the deadline still commits and states its `acknowledgement` settlement, and an ACK at or after the
deadline is refused. The receipt is gone by then, and control admission's validation refuses an
ACK whose deadline has passed even if a receipt is still read. Every carrier discards `acceptControlMessage`'s answer, so repair
admission records it as the `control-admission` outbound diagnostic (outcome, and a rejection's
reasons) for every control it decides. A committed `resync-required` NACK is a relay's refusal of a
retained send (D50): it states a `relay-rejected` settlement naming the relay, which ends the handle
`rejected`, and plans no resend; the receipt row is left as it was.

A receipt row is keyed by its origin and message id
(`toALOutboundPendingAckKey({ namespace, originPeerId, msgId })`), so origins that share one
store namespace never collide on a message id. Its `mode` is the send's resolved ack algorithm
and types its peer lists: next hops under `hop` and `subtree`, logical recipients under
`receiver`. An ACK confirms the peer that mode names -- its `logicalRecipientPeerId` under
`receiver`, its sender under `hop`, and under `subtree` its sender only on that hop's own
completion ACK (a leaf's `delivered`, a relay's terminal `subtree-complete`), never on a
`forwarded` ACK the hop relays for a recipient below it -- so a hop ACK never stands in for a
logical recipient. A control
is a duplicate only when its sender, logical recipient and status all repeat; an ACK for a peer
the receipt already counted is refused with its own reason, so an ACK that moves no receipt costs
no write and no version bump. The `acknowledgement`
settlement carries the `mode`, so `complete` under `receiver` is logical completion. A
`receiver` room send frozen to an empty audience (an origin alone in its room) is admitted and
states a complete `acknowledgement` settlement at its commit, with no receipt row, as the WS
server answers an empty audience.

When an `ack-timeout` retries a `receiver` receipt, the repair request carries the hops whose
subtree the ACK history shows complete (`completedHopPeerIds`). The RTC origin of a frozen
multicast retries only through the next hops that may still lead to a missing recipient: a
missing recipient that is a direct hop, and every hop whose subtree has not completed; a
completed hop never gets a copy (D25). Every other retry re-plans around the failed hops
through an alternate parent. `retransmitAdmittedMessage` sends an admitted message again as a
repair attempt of its own identity; a relay uses it to pass a retried copy on to the child hops
it still waits on.

### Server receipts on WS

A `receiver` room send over WS expects nobody when it is admitted
([`toWsQueueBoxClientAckTrackingPlan`](../../services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts)):
the WS server freezes the audience and answers for it. Each recipient's ACK stays addressed to the
origin (`toPeerId` is the message's `senderId`); the server admits it at ingress as the aggregating
relay hop and counts it in
[`WsQueueBoxServerReceiptAggregation`](../../services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts),
an in-memory map per server instance. No client learns a server id. The server answers the origin with
`al.control.receipt.v1` controls, each written as one durable `WS_OUTBOX` row that reaches the origin's
socket on this instance or, through the cluster publisher, on another: `admitted` at once with the
frozen audience, then `complete` when every expected recipient has acknowledged, or `timed-out` at the
message deadline naming whom it counted. Every receipt row expires at the message deadline plus
`AL_RECEIPT_DEADLINE_GRACE_MS`, however early the server observed it. A receipt row whose origin has no
session on the instance that dequeues it is not settled by its first cluster publication: its send
([`WsQueueBoxServerClusterPublication`](../../services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts))
publishes it again, each wait as long as the receipt has waited and the last one a second before the row
expires, until the origin has a session there or the row expires, so an origin that reconnects on any
instance up to a second before the row expires receives it; one that reconnects in that last second
does not. A `receiver` message addressed
to the server itself keeps the server's own ACK; `receiver` on a WS unicast is refused `unsupported`
(D42) until a slice aggregates unicasts.

In the production outbox fan-out (`forwardsRoomScopedMessages: false`) the server's own outbound owner
sends the room message and keeps a `receiver` pending row for it, keyed by the origin and message id
(D38): the durable receipt. The aggregator is its one settlement authority. The server admits each
terminal receipt it writes through the same receipt admission as the origin, so a `complete` receipt
leaves that row complete and its `ack-timeout` stops retransmitting, on whichever instance claims it.
That row is not the origin's kept final snapshot: once complete, the next `ack-timeout` deletes it,
and nothing reads it after that. The router hands the audience it admitted to the outbox beside the
message, never on the wire, where a room larger than the collection limit would not fit: the plan
carries it as `admittedAudience`, the captured policy keeps it with the sent row, and every later plan of
the message receives it. The server sends to that audience only and a `receiver` row expects exactly it,
never a session that joined after admission (D24, D43); a `hop` or `subtree` row expects the hops this
instance sent to. A multicast frozen by its origin and sent without a router keeps planning against its
own `recipientPeerIds`. Running out of receipt-admission attempts is reported as a warning
naming the message and its origin.

Known limitations:

- An origin whose socket was half-open when its receipt was written to it never gets that receipt; a
  socket write counts as delivery.
- Nothing tells the publishing instance that another one delivered a receipt, so a receipt whose origin
  is connected elsewhere, or whose row another instance claimed first (the WS namespace is shared across
  the cluster), is published until its row expires: 8 publications for a 30 s message, 27 for a 10 min
  one, about 67 at the 30 min aggregate cap, each one an idempotent no-write refusal at the origin.
- On a rolling deploy an older instance cannot decode `cluster-receipt` work and releases it
  non-retryable, so a receipt row it claims stops being published.

The origin admits a receipt through
[`ALOutboundReceiptAdmission`](./control/al-outbound-receipt-admission.ts), not through control
admission: one conditional commit fenced on the origin's version replaces the row's expected set with
the frozen audience and adds the recipients the receipt confirmed. A terminal receipt may overtake its
`admitted` one; every phase leaves its final snapshot as the row until the deadline plus the grace, so a
redelivered receipt finds nothing to move and is refused without a write, and any receipt past that
bound is refused. A receipt writes no work and no `ack-timeout` schedule; the server's receipts own it.
`acceptReceipt` takes the receipt control message itself and records its verdict as the same
`control-admission` diagnostic, under the control's own id with the receipt's message as
`targetMsgId`, whether it commits or is refused.

Every receipt row states its `acknowledgement` settlement through `toALOutboundAcknowledgementFact`:
the row's peers as the hop lists and again as the expected, confirmed and unconfirmed recipient lists.
The origin tracks one peer set, so the two agree in every mode; under `receiver` they are the frozen
logical audience, and the handle reads `acknowledged` only once every expected recipient is confirmed.

An RTT heartbeat is not one of these entries.
[`WsQueueBoxClientService.sendLive`](../../services/ws-queue-box-client-service.ts) writes it
straight to an open socket -- the same bytes `enqueueOutboxIfAbsent` sends today -- with no
admission read, bundle, work row, or retry, and it never takes the sender/browser lock the
table's entries share. A closed socket answers `'socket-closed'` rather than throwing; a lost
heartbeat costs nothing because the next one, latest-value telemetry, simply replaces it.
`sendLive` also bypasses the WS submission-readiness fault port, so a harness `not-ready` hold
never delays an RTT heartbeat; that is acceptable only because the heartbeat is latest-value
telemetry that no conformance scenario holds or asserts on.

### Grouped control sends

`enqueueAllIfAbsent` admits one sender's messages as one group. `ALOutboundDispatchAdmission.commitAll`
takes one sender-queue slot and one browser lock for the group and reads, computes and validates each
member with the single-message decision. `commitBundles` then fences the sender version once, runs every
bundle's own pending, effect, observation and identity fences, writes every bundle and bumps the version
once. The group falls back when a member settles before its write (it fails validation, finds its own
pending admission, or has nothing to commit), when a version moved between the members' reads, when two
bundles write one row, when the store answers anything but `committed`, or when the group attempt throws.
Every member then goes through the single-message commit, one after another, and keeps its own answer:
a planning refusal is that member's `failed` value, as a single send answers it, and a member whose
single commit throws does not stop the members after it; the first such throw is rethrown once every
member ran, and the runtime wakes the owner for the members that landed before it rethrows. The RTC
multicast manager applies its circuit breaker and its rate limiter once per group.

## Read and failure boundaries

[`al-outbound-admission-validation.ts`](./admission/al-outbound-admission-validation.ts)
checks complete snapshot fields and trusted message slots.
[`al-outbound-effect-validation.ts`](./al-outbound-effect-validation.ts) checks
effect identity, metadata, discriminated payloads, prepared transport values,
and embedded queue messages. The backend wraps decoder failures in
`ALAdmissionCorruptionError`. Corrupt admission snapshots and repair dependencies
remain typed failures rather than guessed state or retryable transport failures.

Queued work has a separate terminal boundary: after reservation, a malformed payload,
foreign namespace, wrong queue slot, or inconsistent prepared message is released as
`NON_RETRYABLE`. Its stored content is retained, and valid claims from the same batch
continue. This applies to normal claims, timeout recovery, and exhausted-attempt
finalization. If the terminal write fails, the reservation remains recoverable through
ordinary QueueBox claims. Release uses the existing observed-entry comparison and
expiry conditions; a failed comparison returns a lost-reservation result.

One work batch releases every claim it collected in a single queue write, with a disposition
per entry; `releaseDurationMs` measures exactly that one write, run once at the batch's end
inside a `finally` so a throwing selection or claim cannot strand a reservation. A lost
reservation inside that batch drops the affected entry and retries the rest as one write; a
queue write conflict degrades the batch once to releasing each entry serially. A retained claim
is different: it releases on its own settlement, independently of any batch, one claim at a
time, with no coalescing window or timer.

Readiness reads queue status and timestamps only. It never needs a transport decoder
or reparses terminal payloads. Payload validation occurs on the claimed item before
any message effect is returned for execution.

Queue-entry keys are decoded through the shared
[`ResourceEntry` key codec](../decode-al-admission-resource-entry-key.ts). Every
work payload is encoded through the canonical envelope/entry codec. QueueBox's own
codec preserves reservation and retry timestamps as ISO strings: IndexedDB structured
cloning does not preserve Temporal instances. An old empty-object timestamp remains corrupt.
Each work row validates its full namespace, effect identity, queue slot, and deadline
against its canonical reference.

## Transport attempt settlement

Transport adapters return an explicit result; a void return never establishes a send.
RTC registration uses the existing native queue's `onSettled` callback. Its local
attempt expires at the earlier of the message deadline and its durable claim lease.
An attempt lease ending before the message deadline permits another attempt with
the same identity; it does not expire the logical message. Settlement carries factual
per-message evidence of whether native submission was attempted. Closed or unavailable
channels, backpressure rejection, and untouched queued siblings cleared by a channel
error return readiness. A native send that throws remains an attempted failure with
an uncertain delivery outcome.

Readiness uses the existing `RETRY` and future `nextTs`: release refunds only the
current reservation's attempt, preserving earlier failed attempts. It records neither
adaptive success nor adaptive failure. Real attempt failures retain their normal
retry budget. Readiness rechecks are bounded by the original message deadline, and
settlement at or after that deadline completes physical work without sending or creating
an acknowledgement. Cancellation ends the attempt directly. Submission
remains separate from receiver acknowledgement and application completion.

A replacement's own admission commit states `superseded` for every predecessor it newly
marks replaced -- one `ALDeliverySettlement` per predecessor, from
[`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)'s
`emitSupersededSettlements`, before that commit call returns to its caller. Only the commit
that moves the key's latest-supersedence pointer states it; a later commit of the same
message, or a predecessor the admission observed already replaced, states nothing again. By
the time a superseded predecessor's own queued work next runs, the lifecycle this settlement
named is already terminal, so its own attempt-time and dequeue-time supersedence checks
(`admissionStore.isMessageSuperseded`, read fresh in both `writeAttemptedSend` and
`readDequeuedAdmissionOutcome`) add nothing new: dequeue completes the claim without sending
and without a settlement of its own, and a `send-prepared` attempt still states its own
`attempt-settled` (`outcome: 'superseded'`) but only as late evidence on a lifecycle a terminal
settlement already closed.

The RTC Promise executor captures its resolver synchronously before `sendJson`
registers the callback. Native completion invokes it after queue mutation. This is
a language-level event bridge, not a forward dependency between services. No
additional queue, pending-work registry, or timer is introduced by settlement.

`ALOutboundMessageRuntime.cancel(msgId)` aborts one message's own live transport
signal and states one `cancelled` settlement; disposal aborts every live signal but
states none of its own. Either way, an attempt that already stated `attempt-started`
still terminates with its own `attempt-settled` (`outcome: 'cancelled'`, `willRetry:
false`) -- stated directly when the abort lands before the carrier runs (inside the
admission-store reads `writeAttemptedSend` makes first), or by the carrier's own
settlement when it lands during or after the send. Cancellation is held only for the
owner's lifetime, in memory, never persisted: a row still pending when the owner is
disposed may be drained by the next owner as an ordinary send. A durable cancel fact
-- one that survives disposal or reload -- is a named sink seam left to S3 or I2
(D13), not part of this settlement path.

Every settlement in this section is a per-message `ALOutboundSettlementFact` stated
through this owner's [`ALOutboundSettlementEmitter`](./al-outbound-message-runtime.ts):
the runtime's private `emitSettlement` stamps the fact with its own `carrier` and the
current `atMs` into the `ALDeliverySettlement` the sink receives, and guards that call
so a throwing sink logs and returns rather than changing dispatch, retry, or claim
behaviour. The browser's sink for these settlements is the in-memory delivery registry,
[`BrowserRallarDeliveryRegistry`](../../../shared-web/browser/messages/browser-rallar-delivery-registry.ts)
(`packages/shared-web/browser/messages/`), which reduces each settlement into the
sending handle's lifecycle.

## Atomic IndexedDB work storage

[`openIndexedDbAdmissionDatabase`](../open-indexed-db-admission-database.ts) creates
the fixed admission and `alm-work` stores together. The work store uses the canonical
[`IndexedDbQueueBox` schema](../../queuebox/indexed-db-queue-box-store.ts). A QueueBox
can use the same `IndexedDbConnection` as admission; opening that connection remains
an explicit storage effect.

[`writeIndexedDbAdmissionMutations`](../write-indexed-db-admission-mutations.ts)
accepts already computed admission and QueueBox mutations. The pure QueueBox
validator returns an `Either` before transaction entry. The joint transaction uses
QueueBox's existing revision-guarded writer and applies the supplied values without
recomputing them. Admission rows carry a per-row revision, so a moved row the write
phase observed, a moved key set behind a prefix it listed, a stale queue revision, or a
guarded removal rolls back the whole transaction. A native abort also preserves neither
write.
Reopened QueueBox instances can reserve the committed work through the ordinary
queue API.

Message admission supplies its original execution deadline to this write boundary,
including queue-only pending retention. Native IndexedDB request completion and the
last awaited PostgreSQL mutations check it while rollback remains possible. Expiry
preserves neither new admission metadata nor new work. Control retention and terminal
bookkeeping may continue separately without permitting an expired payload to be sent.

A write context that uses only `readWork` and `writeWork` uses QueueBox's existing
atomic observed-row writer. Unrelated admission metadata cannot invalidate that
queue-only ownership decision. Any metadata read, list, set, or removal is fenced on
exactly what it observed -- the keys it read or wrote, and the keys every prefix it
listed returned -- including a metadata-dependent decision that writes only queue rows.
Empty mutation output alone does not establish independence.

[`ALAdmissionWorkBackend`](../al-admission-work-backend.ts) connects admission to its
QueueBox. Memory, IndexedDB, and PostgreSQL implementations commit the work and its
admission decision together. Browser composition supplies its existing engine to the
outbound runtime. Due-work inspection uses the bounded QueueBox `readWorkPage` port;
the existing browser cleanup owner removes expired and session-owned work from the
shared store through those bounded key ranges.

A browser database whose stores or recorded schema identity do not match is deleted
and recreated once, and the reset is reported through the required `onStorageReset`
port with the previous and current schema ids. An undecodable schema row is treated
as "no schema record yet" and resets the same way. A mismatch that survives that
single reset is a storage invariant failure and throws; a delete that stays blocked by
another open connection throws `ALStorageResetBlockedError`. Unrelated application
storage is preserved, and only ALM-owned databases are reset.

Inbound and outbound execution use their direct ALM owners with QueueBox and
InboxOutboxEngine. The separate outbound effect scheduler and browser physical
transport queues have been removed. The application-facing delivery handle
(`packages/shared-web/browser/messages/`) observes these settlements directly. Logical
audience receipts exist on WS room sends through the server's receipts, and on RTC room sends
through the frozen audience and the retry to the missing recipients through the tree (S2c-ii).
[`al-storage-snapshot.test.ts`](../../../tests/shared/alm/al-storage-snapshot.test.ts)
records what one standard supersession workload leaves in browser storage; existing
paged due-work reads still do not establish that every backend query or cleanup path
has met its performance goal.
