# Outbound admission and durable replay

[`ALOutboundMessageRuntime`](./al-outbound-message-runtime.ts) owns public
lifecycle, queue dispatch, transport sends, and the composition of three
explicit owners. [`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)
owns sender serialization, browser locking, and optimistic read/compute/commit.
[`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) owns control,
ACK-timeout, retransmission, and repair policy; it commits through a direct
reference to dispatch admission and never sends or drains effects itself.
[`ALOutboundEffectDrain`](./al-outbound-effect-drain.ts) owns the independent
durable-worker lifecycle: single-flight draining, claims, leases, scheduling,
completion, and disposal. A queued native send retains its claimed effect until the
transport settles; it does not keep the drain waiting or complete the effect merely
because the carrier accepted local queue ownership.

## Construction and registration

WS client, WS server, and RTC multicast composition supply a completed admission
store, queue, clock, scheduler, worker identity, transport planner, and prepared
message decoder before constructing `ALOutboundMessageRuntime`. The constructor
creates dispatch admission, passes that instance directly to repair admission,
then registers one deferred `runEffect` callback with `ALOutboundEffectDrain`.
The drain constructor never invokes it. `ready()` awaits storage readiness
before the first claim. Disposing the runtime closes dispatch admission and the
worker, cancelling the next scheduled invocation and aborting owned RTC queue items.
An interrupted durable claim remains recoverable after its lease expires.

The transport decoding owners are
[`decodeALOutboundPreparedMessage`](./al-outbound-effect-validation.ts) for WS
client and RTC envelopes, and
[`decodeWsQueueBoxServerPreparedMessage`](../../services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts)
for the server's recipient/cluster-completion union. Prepared transport values
are decoded from the persisted effect; replay never regenerates them by
rerunning a planner.

## Runtime paths

| Entry                                  | Decision and durable result                                                                                                                                                                                                                                                            | After commit                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enqueueIfAbsent` / `dequeue`          | Dispatch admission's `commit` serializes the sender. `readOutgoingMessage` reads validated state; [`computeALOutboundDispatch`](./compute-al-outbound-dispatch.ts) produces the bundle; `commitBundle` compares the revision, writes the bundle, and advances the revision atomically. | The sender/browser lock is released before runtime calls `drainCommitted`.                                                                                                                                                                                                                                                                                                                 |
| `acceptControlMessage`                 | [`ALOutboundAdmissionControlStore`](./al-outbound-admission-control-store.ts) validates stored control history and pending acknowledgements, updates the control state, and writes repair hints in the backend transaction.                                                            | The runtime schedules a not-yet-in-sync retry when needed, then wakes the worker.                                                                                                                                                                                                                                                                                                          |
| ACK timeout / repair hint / NACK retry | Repair admission rereads validated message/acknowledgement snapshots, applies retry/repair limits, and commits a fresh versioned bundle. Optimistic conflicts reenter read/compute.                                                                                                    | The already-running worker consumes new effects; repair never recursively enters the drain.                                                                                                                                                                                                                                                                                                |
| Startup / scheduled wakeup             | [`ALOutboundAdmissionEffectStore`](./al-outbound-admission-effect-store.ts) validates every listed effect, claims ready effects with a bounded lease, and commits the claim.                                                                                                           | The worker invokes `runEffect` once per claimed attempt. Immediate outcomes complete or reschedule the effect. Retained transport outcomes settle asynchronously while other claims continue. Every claim receives an opaque lease owner, so an old completion or retry cannot alter a new claim by the same worker. A process interruption leaves the lease available for later recovery. |

## Read and failure boundaries

[`al-outbound-admission-validation.ts`](./al-outbound-admission-validation.ts)
checks complete snapshot fields and trusted message slots.
[`al-outbound-effect-validation.ts`](./al-outbound-effect-validation.ts) checks
effect identity, metadata, discriminated payloads, prepared transport values,
and embedded queue messages. The backend wraps decoder failures in
`ALAdmissionCorruptionError`; runtime readiness and repair paths preserve that
typed failure instead of treating corruption as absence or retryable transport
failure.

Queue-entry timestamps accept existing Temporal objects and their persisted
string representation through the shared
[`ResourceEntry` codec](../al-admission-resource-entry-validation.ts). Every
effect write, including lease and retry updates, explicitly encodes queue entry
timestamps to the established ISO strings: IndexedDB structured cloning does
not preserve Temporal instances. An old empty-object timestamp remains corrupt.
Supersedence intentionally reuses a predecessor's outbox key, so the queue key is
validated structurally while the embedded AL message must match its effect.

## Transport attempt settlement

Transport adapters return an explicit result; a void return never establishes a send.
RTC registration uses the existing native queue's `onSettled` callback. Its local
attempt expires at the earlier of the message deadline and its durable claim lease.
An attempt lease ending before the message deadline permits another attempt with
the same identity; it does not expire the logical message. Native failure or closure
requests a retry. Expiry, cancellation, and supersedence end that attempt without a
retry. Submission remains separate from receiver acknowledgement and application
completion.

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

The admission backend and browser cleanup currently supply an empty queue mutation
list. They therefore lock only the admission store. Runtime integration must connect
admission to the joint writer and the existing QueueBox engine, including scoped
work cleanup; these storage primitives alone do not consolidate runtime ownership.

An existing incompatible database is rejected without changing its schema or data.
Cutover requires stopping the affected producers and workers before an explicit reset
of incompatible ALM-owned browser storage. Unrelated application storage is preserved.

The present ALM effect scheduler still overlaps QueueBox's work ownership. The
roadmap requires consolidating it into the existing QueueBox/InboxOutboxEngine;
this transport integration does not establish completion of that consolidation or
of the application-facing delivery handle.
