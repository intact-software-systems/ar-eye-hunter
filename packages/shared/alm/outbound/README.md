# Outbound admission and durable replay

[`ALOutboundMessageRuntime`](./al-outbound-message-runtime.ts) owns public
lifecycle, queue dispatch, transport sends, and the composition of three
explicit owners. [`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)
owns sender serialization, browser locking, and optimistic read/compute/commit.
[`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) owns control,
ACK-timeout, retransmission, and repair policy; it commits through a direct
reference to dispatch admission and never sends or drains effects itself.
[`ALOutboundWorkHandler`](./al-outbound-work-handler.ts) registers outbound work
with the existing [`InboxOutboxEngine`](../../services/InboxOutboxEngine.ts).
QueueBox owns durable reservation, release, expiry, retry, and exhausted-attempt
recovery. A queued native send retains its claimed work until transport settlement;
it does not block available peers or complete merely because the carrier accepted
local queue ownership.

## Construction and registration

WS client, WS server, and RTC multicast composition supply a completed admission
store, queue, clock, engine, worker identity, transport planner, and prepared
message decoder before constructing `ALOutboundMessageRuntime`. The constructor
creates dispatch admission, passes that instance directly to repair admission,
then registers a deferred `runEffect` callback with `ALOutboundWorkHandler`.
Registration does not invoke the callback. `ready()` awaits storage readiness before
the first claim. Disposing the runtime closes dispatch admission, removes its engine
task, and aborts owned RTC queue items. A supplied engine remains available to its
other tasks; a runtime-owned engine stops. An interrupted durable claim remains
recoverable after its lease expires.

The transport decoding owners are
[`decodeALOutboundPreparedMessage`](./al-outbound-effect-validation.ts) for WS
client and RTC envelopes, and
[`decodeWsQueueBoxServerPreparedMessage`](../../services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts)
for the server's recipient/cluster-completion union. Prepared transport values
are reconstructed from a canonical envelope and compact persisted transport
descriptors. Admitted send-action replay does not regenerate its recipients or
policy by rerunning a planner.

## Canonical message storage

[`al-outbound-canonical-message.ts`](./al-outbound-canonical-message.ts) owns the
canonical key, full message reference, identity fact, and their validation.
[`al-outbound-canonical-storage.ts`](./al-outbound-canonical-storage.ts) reads and
compares those observations and writes new facts through the admission transaction.
Each message has one raw envelope. Sent metadata, recipient actions, and repair work
refer to it; [`al-outbound-transport-message.ts`](./al-outbound-transport-message.ts)
captures and reconstructs the permitted transport differences.

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

## Runtime paths

| Entry                                  | Decision and durable result                                                                                                                                                                                                    | After commit                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enqueueIfAbsent` / `dequeue`          | Dispatch admission reads validated state and computes a bundle. Its commit compares sender versions and original supersedence observations, then writes admission state and QueueBox work atomically.                          | Runtime requests the work handler after leaving admission's sender/browser lock.                                                                                                                                                                       |
| `acceptControlMessage`                 | [`ALOutboundAdmissionControlStore`](./al-outbound-admission-control-store.ts) validates identity, control history, and pending receipts, then commits control state and repair work together.                                  | Runtime schedules a not-yet-in-sync retry when required and wakes its engine task.                                                                                                                                                                     |
| ACK timeout / repair hint / NACK retry | Repair admission rereads validated message/receipt snapshots, applies policy, and commits a fresh versioned bundle.                                                                                                            | New work is available to the existing engine; repair does not recursively invoke the work handler.                                                                                                                                                     |
| Startup / scheduled wakeup             | [`ALOutboundAdmissionEffectStore`](./al-outbound-admission-effect-store.ts) reserves through QueueBox and validates each claimed payload. Malformed work becomes `NON_RETRYABLE`; valid claims remain independently available. | The worker invokes `runEffect` once per accepted claim. Immediate outcomes complete or reschedule; retained transport outcomes settle asynchronously. QueueBox compares the exact reservation on release, so an old worker cannot alter a newer claim. |

## Read and failure boundaries

[`al-outbound-admission-validation.ts`](./al-outbound-admission-validation.ts)
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
adaptive success nor adaptive failure. Actual processing failures retain their normal
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
shared store. Its scan cost and other storage/performance goals still require measurement.

An existing incompatible database is rejected without changing its schema or data.
Cutover requires stopping the affected producers and workers before an explicit reset
of incompatible ALM-owned browser storage. Unrelated application storage is preserved.

Inbound and outbound execution use their direct ALM owners with QueueBox and
InboxOutboxEngine. The separate outbound effect scheduler and browser physical
transport queues have been removed. The application-facing delivery handle and
complete logical audience receipts remain roadmap work. Existing paged due-work reads
do not establish that every backend query or cleanup path has met its performance goal.
