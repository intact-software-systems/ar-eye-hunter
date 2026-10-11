# WS queue server ownership and navigation

Start with [`WsQueueBoxServerService`](./ws-queue-box-server-service.ts). Its
`createDefaultWsQueueBoxServerService` factory builds the existing inbound and
outbound ALM resources. The constructor creates live delivery, outbound planning
and dequeue authority, then the outbound runtime, receipt aggregation and ACK
relay, control delivery, inbound authority and delivery, and the inbound runtime.
Socket ingress registration is last; every captured dependency exists first.
`dispose` unregisters ingress and the receipt deadline task and disposes both ALM
runtimes. A supplied engine retains its other tasks.

| Entry and family                            | Decision owner                                                                                                                                                                                                                                     | Effect and result owner                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptIncomingMessage`                     | [inbound authority](./ws-queue-box-server-inbound-authority.ts): live connection, peer, scope, protocol, application authorization, then current-connection/scope recheck                                                                          | Existing inbound ALM runtime admits or retains; service returns the existing rejection/acceptance. [Inbound delivery](./ws-queue-box-server-inbound-delivery.ts) runs queued recipient effects later.                                                                                                         |
| `enqueueOutboxIfAbsent` and outbound worker | [outbound planning](./ws-queue-box-server-outbound-planning.ts), [dequeue authority](./ws-queue-box-server-dequeue-authority.ts) and [prepared-message decoder](./decode-ws-queue-box-server-prepared-message.ts)                                  | Existing outbound ALM runtime owns admission, work and settlement. Service sends the prepared recipient or [cluster publication](./ws-queue-box-server-cluster-publication.ts) publishes the owned row.                                                                                                       |
| Receiver ACK and receipt                    | [ACK relay](./ws-queue-box-server-ack-relay.ts) owns shared ingress-audience proof, relay budget and actual publication; [receipt aggregation](./ws-queue-box-server-receipt-aggregation.ts) owns the one frozen audience/count/deadline lifecycle | Aggregation creates admitted/complete/timed-out receipts and enqueues through the existing outbound owner; terminal receipts then settle the server's pending row. Enqueue is separate from later publication or sender acknowledgement.                                                                      |
| Direct/live/control send                    | [target resolution](./ws-queue-box-server-target-resolution.ts) and [recipient selection](./ws-queue-box-server-recipient-selection.ts)                                                                                                            | [Live delivery](./ws-queue-box-server-live-delivery.ts) checks the current recipient and sends; [control delivery](./ws-queue-box-server-control-delivery.ts) uses the live target or owned cluster outbox. [Delivery reporting](./ws-queue-box-server-delivery-reporting.ts) exposes existing outcome ports. |

Supporting translations remain beside their owner: [inbound planning](./ws-queue-box-server-inbound-plan.ts),
[inbound recipient projection](./ws-queue-box-server-inbound-recipients.ts),
[addressee authorization](./to-ws-queue-box-server-addressee-authorization.ts),
[receipt deadline index](./ws-queue-box-server-receipt-deadline-index.ts), and
[receipt row recognition/republish delay](./ws-queue-box-server-receipt-row.ts).
[Contracts](./ws-queue-box-server-contracts.ts) declare the external authority,
target, scope and delivery ports. The `scope/` translations prove producer and
recipient scope at their current admission/send boundaries; they add no second
scope authority or lifecycle.

## Private receipt evidence

[`WsQueueBoxServerReceiptObservation`](./ws-queue-box-server-receipt-observation.ts)
is the private typed union for socket decision, count, relay publication, receipt
outbox, receipt work, transport and publication results. The authority carries its already-read peer/scope/clock facts; the
service reports its final actual socket result. Relayed counts carry the actual
notice publisher, without claiming authentication by a receiving socket.

The count engine constructs its existing result and immutable before/after
observation together. `recordAck` reports after constructing that result;
`acceptControlMessage` reports in `finally` after receipt enqueue/settlement.
A thrown enqueue exposes no enqueue verdict; an actual returned enqueue verdict
is captured before the settlement consumer and remains observable if settlement
throws. Sink failures are guarded. Diagnostics have no authority over delivery.

`createOutboundRuntime` installs the [AL receipt/work owner's](../../alm/outbound/lane/al-outbound-receipt-observation.ts)
optional `Capture` only when `receiptObserver` exists. Its concrete evidence factory
reads the decoded claim once, and its observer adds this server's identity. It also
installs the concrete [batch observation resource](../../alm/work/al-work-batch-observations.ts)
constructor; the handler invokes its guarded `tryCreate` and drains the result at
the mandatory batch boundary. The
shared lane holds only a type dependency on that owner; browser composition does
not install or bundle receipt projection. Per-claim construction failure loses optional work
evidence without changing the claim or its transport's post-release deferral.
Receipt claims add `receipt-work` through this capability.
`receipt-transport` comes from the prepared recipient or cluster receipt owner.
The [JSON socket owner](../../websocket/json-web-socket-server.ts) updates a private
caller-owned buffer immediately before and after actual `socket.send`; it invokes
no sink and reads no clock. `nativeCall` distinguishes `not-called`, `invoked` and
`returned`, independently of the wrapper's `outcome`. Native return establishes
submission, not arrival; a later failure can coexist with `returned`. A carrier
throw's generic settlement `submissionAttempted: false` does not contradict an
observed native invocation.

The registered [pubsub publisher](../../../shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts)
reports `receipt-publication`: actual publish call, direct call and direct returned
status/counts. Publisher return may accompany cluster-wrapper `not-ready` when
this instance has no origin session. A direct failed-count result may make the
publisher throw after publication returned. These facts remain separate.

Work, transport and publication facts are frozen at their actual owners. Their
sink calls share the current AL work batch's private deferral boundary and run
after its mandatory release, clocks and end logic. Deferral is not evidence that
release succeeded. No observer is constructed by disabled composition, and no
receipt copies, native buffer or diagnostic batch collection are then created. If
an enabled batch resource fails to construct, its canonical inert `discard` deferral suppresses all
optional work/native/cluster records for that batch while business effects continue.
This is diagnostic loss, not delayed publication or a negative transport result.

The API default composition gates this observer with existing `timingLogs` and
[`createApiV1WsReceiptObserver`](../../../../apps/api-v1/src/composition/create-api-v1-ws-receipt-observer.ts).
The existing console timing transport carries a private property through the
[API child wrapper](../../../../apps/rallar-black-box/scripts/run-full-stack-api-with-timing.ts).
Its [safe receipt projection](../../../../apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts)
retains closed identities, enums, finite clocks and exact safe audience arrays.
Its [scalar projection](../../../../apps/rallar-black-box/scripts/to-safe-api-timing-record.ts)
is the sole scalar timing allowlist. The wrapper owns exclusive private files,
65,536-byte lines, child exit/signal/reaping and explicit loss summaries. Missing
records do not prove missing ACKs, and capture does not verify durable request
completion or native cross-instance behavior.

## Navigation probes and failure boundaries

Follow these production paths directly when reviewing a change:

1. Socket ACK: service `acceptIncomingMessage` → authority `readSocketAdmission`
   and `resolveAuthorizedSocketAdmission` → service `admitAuthorizedMessage` →
   existing inbound runtime control callback → aggregation `acceptControlMessage`.
   Refusal returns the same typed rejection; an operational exception propagates.
2. Count/completion: aggregation `countAck` → existing aggregate read/validation,
   memory update/delete → generated receipt → existing outbound enqueue → server
   receipt settlement → guarded outbox/count observations. The deadline index,
   cap and sweep keep their current bounded lifecycle.
3. Relay: service → relay `relayUnownedAck` → actual shared audience proof and
   budget → publisher result. Failed publication remains distinct from the
   existing `Right(true)` handoff return. A relayed subscriber calls
   `acceptRelayedAck` once; the receiving instance does not relay it again.
4. Queued send: outbound runtime → service `sendPreparedMessage` → dequeue
   authority and cluster publication or actual recipient scope/identity check →
   socket send/owned settled result. Receipt-row retries are separate from enqueue.
5. Evidence: each owner → private union → API adapter → stdout → safe JSONL and
   summary. Unsafe exact sets and oversized lines are rejected, never truncated
   into a claimed complete set. Default-off skips diagnostic copies and clocks.

Semantic coverage lives in `packages/tests/shared/services/ws-queue-box-server-*`,
`packages/tests/shared-server/rallar-system/{middleware,websocket,queue-pubsub}`,
`packages/tests/rallar-black-box/full-stack-api-*-capture.test.ts`, and the API
composition tests. Transport/store/clock/sink fixtures replace external ports;
the production authority, count and settlement owners remain under test.
