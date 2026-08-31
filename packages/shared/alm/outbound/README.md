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
completion, and disposal.

## Construction and registration

WS client, WS server, and RTC multicast composition supply a completed admission
store, queue, clock, scheduler, worker identity, transport planner, and prepared
message decoder before constructing `ALOutboundMessageRuntime`. The constructor
creates dispatch admission, passes that instance directly to repair admission,
then registers one deferred `runEffect` callback with `ALOutboundEffectDrain`.
The drain constructor never invokes it. `ready()` awaits storage readiness
before the first claim. Disposing the runtime closes dispatch admission and the
worker, cancelling the next scheduled invocation.

The transport decoding owners are
[`decodeALOutboundPreparedMessage`](./al-outbound-effect-validation.ts) for WS
client and RTC envelopes, and
[`decodeWsQueueBoxServerPreparedMessage`](../../services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts)
for the server's recipient/cluster-completion union. Prepared transport values
are decoded from the persisted effect; replay never regenerates them by
rerunning a planner.

## Runtime paths

| Entry                                  | Decision and durable result                                                                                                                                                                                                                                                            | After commit                                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueueIfAbsent` / `dequeue`          | Dispatch admission's `commit` serializes the sender. `readOutgoingMessage` reads validated state; [`computeALOutboundDispatch`](./compute-al-outbound-dispatch.ts) produces the bundle; `commitBundle` compares the revision, writes the bundle, and advances the revision atomically. | The sender/browser lock is released before runtime calls `drainCommitted`.                                                                                                               |
| `acceptControlMessage`                 | [`ALOutboundAdmissionControlStore`](./al-outbound-admission-control-store.ts) validates stored control history and pending acknowledgements, updates the control state, and writes repair hints in the backend transaction.                                                            | The runtime schedules a not-yet-in-sync retry when needed, then wakes the worker.                                                                                                        |
| ACK timeout / repair hint / NACK retry | Repair admission rereads validated message/acknowledgement snapshots, applies retry/repair limits, and commits a fresh versioned bundle. Optimistic conflicts reenter read/compute.                                                                                                    | The already-running worker consumes new effects; repair never recursively enters the drain.                                                                                              |
| Startup / scheduled wakeup             | [`ALOutboundAdmissionEffectStore`](./al-outbound-admission-effect-store.ts) validates every listed effect, claims ready effects with a bounded lease, and commits the claim.                                                                                                           | The worker invokes `runEffect` once per claimed attempt, completes successful effects, or persists the next retry. A process interruption leaves the lease available for later recovery. |

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
