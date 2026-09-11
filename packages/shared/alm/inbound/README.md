# Inbound admission and queued delivery

[`ALInboundMessageRuntime`](./al-inbound-message-runtime.ts) is the incoming
message boundary. It decodes the envelope, validates the authenticated source,
separates controls from data, and returns an `Either` with rejection or admission
information. Admission is protocol acceptance; application completion requires
separate application evidence.

## Construction and registration

[`createDefaultALInboundRuntimeResources`](./create-default-al-inbound-message-runtime.ts)
assembles the store, clock, entry construction port, worker identity, and existing
QueueBox engine. The WS client and server construct the runtime in
[`WsQueueBoxClientService`](../../services/ws-queue-box-client-service.ts) and
[`WsQueueBoxServerService`](../../services/ws-queue-box-server/ws-queue-box-server-service.ts).
RTC ingress is wired by
[`WebRtcRxStreamerService`](../../services/web-rtc-rx-streamer-service.ts).
These composition owners supply the planner, delivery, forwarding, and control ports.

The runtime constructs its [`ALWorkQueuePort`](../work/al-work-queue-port.ts),
[`ALInboundMessageAdmission`](./al-inbound-message-admission.ts) and
[`ALInboundAdmittedDelivery`](./al-inbound-admitted-delivery.ts) before passing them to
[`ALWorkHandler`](../work/al-work-handler.ts) — the same worker the outbound runtime
uses, with `maxConcurrency` fixed at one task. The inbound half of that worker is
[`createALInboundWorkSelector`](./read-al-inbound-work-selection.ts): it owns the rotating
new/retry/reserved page scan that answers the handler's readiness probe and turns one observed
page into claims. The worker registers
with [`InboxOutboxEngine`](../../services/InboxOutboxEngine.ts); registration does
not invoke admission or delivery. Storage readiness precedes the first work scan.
Disposal prevents further local work and unregisters the task. A runtime-owned
engine stops; a supplied shared engine remains available to its other tasks.

## Admission and invocation paths

| Entry                           | Decision and durable result                                                                                                                                                                                                                                                                                                                                                                                                                                | Subsequent execution                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data ingress                    | `ALInboundMessageAdmission.attempt` reads observations, computes the admission bundle, validates it, then calls `commitBundle`. The store compares the original message, ordering, supersedence, receipt, and delivery observations before writing state and work together.                                                                                                                                                                                | The runtime wakes the existing worker after commit.                                                                                                                                                                              |
| Initial data admission conflict | A fully validated message is retained as `admit-message` in the same inbound QueueBox namespace, with its source and original deadline. Retention checks exact content and identity on reuse.                                                                                                                                                                                                                                                              | The caller receives `pending-admission`; the worker later calls `replay` for one fresh admission attempt. No success receipt is earned by pending storage.                                                                       |
| Control ingress                 | [`ALInboundControlAdmission`](./control/al-inbound-control-admission.ts) reads the tracked message and expected control peer, then [`computeALInboundControlAdmission`](./control/compute-al-inbound-control-admission.ts) and [`validateALInboundControlAdmission`](./control/validate-al-inbound-control-admission.ts) decide the candidate before a conditional commit of its state and effects. Unknown controls cannot create a pending data message. | The runtime wakes the worker and invokes the configured control callback. A commit conflict retains `admit-control` work, answers `pending-admission`, and the worker's replay reports the acceptance through the same callback. |
| Admitted delivery               | `ALInboundAdmittedDelivery` rereads stored message authority/planning observations, checks ordering and expiry, then dispatches locally or forwards through the supplied port.                                                                                                                                                                                                                                                                             | The worker completes or reschedules the claimed QueueBox entry.                                                                                                                                                                  |
| Buffered release                | [`ALInboundOrderedDelivery`](./al-inbound-ordered-delivery.ts) reads progress and buffered work, computes a permitted release or resynchronization result, and commits the observed transition.                                                                                                                                                                                                                                                            | Local dispatch occurs only after the required release decision; later work becomes eligible through the same worker.                                                                                                             |

`validateALInboundControlAdmission` returns every reason an acknowledgement is
inadmissible; the caller joins them into one rejection reason. Only an absent pending
obligation short-circuits, because the remaining checks read that obligation.

## The admission directory

[`admission/`](./admission) holds the pure inbound admission decision.
[`computeALInboundAdmission`](./admission/compute-al-inbound-admission.ts) turns one
read plus its handling plan into the mutations and effect intents an admitted message
owns, delegating the dedup/ordering half to
[`al-inbound-delivery-mutations.ts`](./admission/al-inbound-delivery-mutations.ts).
[`validateALInboundCommitBundle`](./admission/validate-al-inbound-commit-bundle.ts)
checks the bundle as a whole — its limits, effect writes, provenance lifetimes and
canonical messages — and
[`validateALInboundAdmissionMutation`](./admission/validate-al-inbound-admission-mutation.ts)
reports every reason one mutation may not be committed, including whether it writes
outside the original observations the read captured.

[`ALInboundAdmissionStore`](./al-inbound-admission-store.ts) owns persisted
observations and conditional admission; its private provider-backed implementation
writes through [`ALAdmissionWorkBackend`](../al-admission-work-backend.ts).
[`ALInboundDurableEffectStore`](./al-inbound-durable-effect-store.ts) writes effect
ownership into QueueBox rows inside the admission transaction and reads ordered-delivery
evidence; reservation and release belong to the work port alone.

Every stored key is `topicId/resourceId/contextId`, and inbound work is
`AL_INBOUND/<namespace>/<effectId>` so one session's rows are a bounded key range.
An admitted message writes two provenance rows: the message owner row, keyed by
namespace, message id and sender id, which retains the validated ingress source and
supersedence key ([`al-inbound-source-validation.ts`](./al-inbound-source-validation.ts)),
and the canonical inbound message row
([`al-inbound-canonical-message.ts`](./al-inbound-canonical-message.ts)), which retains the
envelope until the `retainUntilMs` its own row states — the latest deadline of the effects
and slots that bundle owns, so a bundle owning neither writes no canonical row. Both must
outlive the owned work the same bundle writes; a bundle whose provenance expires first is
rejected.

## Replay authority and deadlines

Pending replay uses the currently configured planner. The WS server additionally
supplies `readPendingAdmissionAuthority`, which calls its existing asynchronous
authority owner before admission. Current authorized recipients intersect the
captured recipients. Revocation retires pending work without admission metadata or
receipts. Temporary authority catch-up uses the existing `RETRY`/future `nextTs`
path with `reason: 'not-ready'`, preserving the processing attempt count.

The deadline is captured before pending retention and checked again after awaited
authority reads. Changed policy, restart, and retry cannot extend it. Conditional
write conflicts consume ordinary processing attempts; QueueBox owns their bounded
retry policy. A pure computation does not make sending atomic with completing work:
crash replay can repeat an external effect, so protocol identity and deduplication
remain necessary.

Message admission also passes that deadline to the existing backend write boundary.
IndexedDB checks native request completion while the transaction can still abort;
PostgreSQL checks after its awaited mutations before leaving the transaction.
Expiry rolls back admission metadata and work together. Later control retention and
terminal bookkeeping can omit an execution deadline without authorizing another send.

## Selection, failure, and cleanup

The worker holds one 16-entry observation page. It reads through QueueBox's
`readWorkPage` port and
[`createALInboundWorkSelector`](./read-al-inbound-work-selection.ts) skips known
ineligible ordered work before reservation. QueueBox compares the observations
when claiming and owns reservation timeout, retry, exhaustion, and release.

The rotation reads a page on every engine round, and that read is what advances its
scan position, so the worker is constructed with `AL_WORK_PROBE_EVERY_ROUND` rather
than the remembered readiness the outbound owners use: a remembered answer would skip
the read and leave the scan where it stood. Measured over a hundred engine passes of an
idle owner — `al-indexeddb-operation-counts.test.ts`, both an empty queue and one holding
a row no consumer claims — the probe reaches storage on more than half of them (97 of
100 as measured, the rest being rounds spent inside the batch the round before started),
against the 4 of 100 the outbound owner spends answering from memory. The measurement
agrees with the construction, so the rotation keeps the per-round probe.

The runtime relays no `readiness-probe` for it. One event per engine round is cheap in
storage and expensive in the conformance lane, where every relayed diagnostic is a round
trip out of the page: it roughly doubled the page's event traffic and its measured
per-operation cost, 8.2 to 20.9 ms/op, which delayed RTC signaling far enough that the
delivery baseline received nothing and the cell failed. Suppressed, the same cell passes
at 10.3 ms/op, and `rotation-alive` remains the liveness witness that a scanning rotation
is still running.

[`decodeALInboundWorkEntry`](./al-inbound-work-entry.ts) checks the stored variant,
namespace, full identity, queue slot, and deadline. Malformed claimed work becomes
`NON_RETRYABLE`; valid work from the same batch continues. Operational failures
return to ordinary QueueBox retry. A failed terminal write does not establish a
successful finalization.

Browser expiry and session cleanup are owned by
[`browser-al-work-cleanup.ts`](../../../shared-web/browser/al-runtime/browser-al-work-cleanup.ts)
in the shared admission database. Because every AL-owned key leads with its owner,
cleanup deletes one bounded key range per owned `AL_INBOUND`/`AL_OUTBOUND` namespace
and per owned canonical scope, and each range ends its `resourceId` with the `/`
delimiter so a neighbouring owner whose id is a string prefix is never pulled in.
Unrelated work is preserved.

A browser database whose stores or recorded schema identity do not match is deleted
and recreated once and the reset is reported through the required `onStorageReset`
port; the details are in the
[outbound navigation map](../outbound/README.md#atomic-indexeddb-work-storage).
The outbound canonical storage cutover does not establish the roadmap's
zero-IndexedDB volatile path for inbound work.

Semantic evidence starts with
[`al-inbound-pending-admission.test.ts`](../../../tests/shared/alm/al-inbound-pending-admission.test.ts),
[`ws-rtc-signaling-admission-recovery.test.ts`](../../../tests/shared/webrtc/ws-rtc-signaling-admission-recovery.test.ts),
and [`ws-queue-box-server-ingress.test.ts`](../../../tests/shared/services/ws-queue-box-server-ingress.test.ts).
These entry and persistence tests complement the real browser workflow; passing
them does not by itself prove native RTC connection readiness.
