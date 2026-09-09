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
[`ALWorkHandler`](../work/al-work-handler.ts). The inbound half of that worker is
[`createALInboundWorkSelector`](./read-al-inbound-work-selection.ts): it owns the rotating
new/retry/reserved page scan that answers the handler's readiness probe and turns one observed
page into claims. The worker registers
with [`InboxOutboxEngine`](../../services/InboxOutboxEngine.ts); registration does
not invoke admission or delivery. Storage readiness precedes the first work scan.
Disposal prevents further local work and unregisters the task. A runtime-owned
engine stops; a supplied shared engine remains available to its other tasks.

## Admission and invocation paths

| Entry                           | Decision and durable result                                                                                                                                                                                                                                                 | Subsequent execution                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data ingress                    | `ALInboundMessageAdmission.attempt` reads observations, computes the admission bundle, validates it, then calls `commitBundle`. The store compares the original message, ordering, supersedence, receipt, and delivery observations before writing state and work together. | The runtime wakes the existing worker after commit.                                                                                                                                                                              |
| Initial data admission conflict | A fully validated message is retained as `admit-message` in the same inbound QueueBox namespace, with its source and original deadline. Retention checks exact content and identity on reuse.                                                                               | The caller receives `pending-admission`; the worker later calls `replay` for one fresh admission attempt. No success receipt is earned by pending storage.                                                                       |
| Control ingress                 | [`ALInboundControlAdmission`](./control/al-inbound-control-admission.ts) reads the tracked message and expected control peer, validates the control, and conditionally commits its state and effects. Unknown controls cannot create a pending data message.                | The runtime wakes the worker and invokes the configured control callback. A commit conflict retains `admit-control` work, answers `pending-admission`, and the worker's replay reports the acceptance through the same callback. |
| Admitted delivery               | `ALInboundAdmittedDelivery` rereads stored message authority/planning observations, checks ordering and expiry, then dispatches locally or forwards through the supplied port.                                                                                              | The worker completes or reschedules the claimed QueueBox entry.                                                                                                                                                                  |
| Buffered release                | [`ALInboundOrderedDelivery`](./al-inbound-ordered-delivery.ts) reads progress and buffered work, computes a permitted release or resynchronization result, and commits the observed transition.                                                                             | Local dispatch occurs only after the required release decision; later work becomes eligible through the same worker.                                                                                                             |

The pure decision owners are
[`computeALInboundAdmission`](./compute-al-inbound-admission.ts) and
[`validateALInboundCommitBundle`](./validate-al-inbound-commit-bundle.ts).
[`ALInboundAdmissionStore`](./al-inbound-admission-store.ts) owns persisted
observations and conditional admission; its private provider-backed implementation
writes through [`ALAdmissionWorkBackend`](../al-admission-work-backend.ts).
[`ALInboundDurableEffectStore`](./al-inbound-durable-effect-store.ts) writes effect
ownership into QueueBox rows inside the admission transaction and reads ordered-delivery
evidence; reservation and release belong to the work port alone.

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
[`readALInboundWorkSelection`](./read-al-inbound-work-selection.ts) skips known
ineligible ordered work before reservation. QueueBox compares the observations
when claiming and owns reservation timeout, retry, exhaustion, and release.

[`decodeALInboundWorkEntry`](./al-inbound-work-entry.ts) checks the stored variant,
namespace, full identity, queue slot, and deadline. Malformed claimed work becomes
`NON_RETRYABLE`; valid work from the same batch continues. Operational failures
return to ordinary QueueBox retry. A failed terminal write does not establish a
successful finalization.

Browser expiry and session cleanup are owned by
[`browser-al-work-cleanup.ts`](../../../shared-web/browser/al-runtime/browser-al-work-cleanup.ts)
in the shared admission database. Session selection preserves unrelated work;
the scan currently visits the AL work range before filtering by session.

Current inbound effects can still contain envelope copies. The outbound canonical
storage cutover does not establish a single inbound payload owner or the roadmap's
zero-IndexedDB volatile path.

Semantic evidence starts with
[`al-inbound-pending-admission.test.ts`](../../../tests/shared/alm/al-inbound-pending-admission.test.ts),
[`ws-rtc-signaling-admission-recovery.test.ts`](../../../tests/shared/webrtc/ws-rtc-signaling-admission-recovery.test.ts),
and [`ws-queue-box-server-ingress.test.ts`](../../../tests/shared/services/ws-queue-box-server-ingress.test.ts).
These entry and persistence tests complement the real browser workflow; passing
them does not by itself prove native RTC connection readiness.
