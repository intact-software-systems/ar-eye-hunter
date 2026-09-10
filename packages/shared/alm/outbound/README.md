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
the backend aborts without a write or a revision bump, and the store catches it at its
public boundary and returns the typed `'conflict'` result.

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
transport action and does not confirm the logical audience.

## Admission and invocation paths

| Entry                        | Decision and durable result                                                                                                                                                                                                                             | After commit                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueueIfAbsent`            | Dispatch admission reads validated state and computes a bundle. Its commit compares sender versions and original supersedence observations, then writes admission state and QueueBox work atomically.                                                   | The runtime wakes the existing worker after commit, outside admission's sender/browser lock.                                                                                                                      |
| `acceptControlMessage`       | Repair admission checks that this scope owns the control, then `ALOutboundControlAdmission` validates identity, control history, and pending receipts and commits control state and repair work together.                                               | The runtime wakes the existing worker; repair admission schedules a not-yet-in-sync retry when the committed control is a not-yet-in-sync NACK.                                                                   |
| `admit-message` work         | `ALOutboundMessageEffects` reads pending admission authority, rechecks the retained deadline, and commits the retained policy through dispatch admission.                                                                                               | The claim completes. Rejected or expired authority completes without admitting; a not-ready authority reschedules with its own delay.                                                                             |
| `dequeue-message` work       | A foreign queue row this owner admits: `ALOutboundMessageEffects` rereads the message, drops it when superseded, and commits a dispatch plan.                                                                                                           | Circuit-open resilience reschedules; `no-route` retries; expired, superseded and skipped complete; an admitted plan completes and runs the configured `afterDequeueAdmission` port.                               |
| `send-prepared` work         | `ALOutboundMessageEffects` rechecks supersedence, receipt completion, deadline, and abort before calling the transport.                                                                                                                                 | An immediate outcome completes or reschedules; a queued native send is retained until the transport settles it.                                                                                                   |
| `ack-timeout` work           | Repair admission rereads the receipt snapshot. Before the deadline it recommits the next timeout; at it, it charges one attempt and commits the next timeout plus a `repair-hint`, or clears the receipt when the receipt is complete or out of budget. | New work is available to the existing engine; the schedule never sends directly.                                                                                                                                  |
| `repair-hint` / `nack-retry` | Repair retransmission reresolves the cached message (by ordering track when the hint names missing sequences), applies repair policy, and commits a fresh dispatch through dispatch admission.                                                          | New work is available to the existing engine; retransmission does not recursively invoke the work handler.                                                                                                        |
| Startup / scheduled wakeup   | `ALWorkQueuePort.claim` reserves; `ALOutboundAdmissionEffectStore` then decodes and validates the claimed row (`readWorkSnapshot`, `validateObservedWork`). Malformed work becomes `NON_RETRYABLE`; valid claims remain independently available.        | One batch runs at a time and its claims run in order; a commit landing behind a batch earns one follow-up batch. QueueBox compares the exact reservation on release, so an old worker cannot alter a newer claim. |

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
an acknowledgement. Cancellation and supersedence also end the attempt. Submission
remains separate from receiver acknowledgement and application completion.

The RTC Promise executor captures its resolver synchronously before `sendJson`
registers the callback. Native completion invokes it after queue mutation. This is
a language-level event bridge, not a forward dependency between services. No
additional queue, pending-work registry, or timer is introduced by settlement.

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
recomputing them. A stale admission revision, queue revision, or guarded removal
rolls back the whole transaction. A native abort also preserves neither write.
Reopened QueueBox instances can reserve the committed work through the ordinary
queue API.

Message admission supplies its original execution deadline to this write boundary,
including queue-only pending retention. Native IndexedDB request completion and the
last awaited PostgreSQL mutations check it while rollback remains possible. Expiry
preserves neither new admission metadata nor new work. Control retention and terminal
bookkeeping may continue separately without permitting an expired payload to be sent.

A write context that uses only `readWork` and `writeWork` uses QueueBox's existing
atomic observed-row writer. Unrelated admission metadata cannot invalidate that
queue-only ownership decision. Any metadata read, list, set, or removal retains
the metadata revision check, including a metadata-dependent decision that writes
only queue rows. Empty mutation output alone does not establish independence.

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
transport queues have been removed. The application-facing delivery handle and
complete logical audience receipts remain roadmap work.
[`al-storage-snapshot.test.ts`](../../../tests/shared/alm/al-storage-snapshot.test.ts)
records what one standard supersession workload leaves in browser storage; existing
paged due-work reads still do not establish that every backend query or cleanup path
has met its performance goal.
