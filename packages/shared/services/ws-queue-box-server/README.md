# WS queue server ownership and navigation

Start with [`WsQueueBoxServerService`](./ws-queue-box-server-service.ts). Its
`createDefaultWsQueueBoxServerService` factory builds the existing inbound and
outbound ALM resources. The constructor creates live delivery, outbound planning
and dequeue authority, then the outbound runtime, receipt aggregation, control
delivery, track order, inbound authority and delivery, and the inbound runtime.
It builds no ACK relay: every instance counts in the receipt record they share.
Socket ingress registration is last; every captured dependency exists first.
`dispose` unregisters ingress, stops the receipt record's worker and disposes both
ALM runtimes. A supplied engine retains its other tasks.

| Entry and family                            | Decision owner                                                                                                                                                                                                                                                                                                                          | Effect and result owner                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptIncomingMessage`                     | [inbound authority](./ws-queue-box-server-inbound-authority.ts): live connection, peer, scope, protocol, application authorization, then current-connection/scope recheck                                                                                                                                                               | Existing inbound ALM runtime admits or retains; service returns the existing rejection/acceptance. [Inbound delivery](./ws-queue-box-server-inbound-delivery.ts) runs queued recipient effects later.                                                                                                                                                                                                                        |
| `enqueueOutboxIfAbsent` and outbound worker | [outbound planning](./ws-queue-box-server-outbound-planning.ts), [dequeue authority](./ws-queue-box-server-dequeue-authority.ts) and [prepared-message decoder](./decode-ws-queue-box-server-prepared-message.ts)                                                                                                                       | Existing outbound ALM runtime owns admission, work and settlement. Service sends the prepared recipient or [cluster publication](./ws-queue-box-server-cluster-publication.ts) publishes the owned row.                                                                                                                                                                                                                      |
| Tracked outbound row order                  | [track order](./ws-queue-box-server-track-order.ts): a dequeued tracked row waits for the pending lower sequences of its track that its batch did not claim                                                                                                                                                                             | Track order reads the positions every copy takes its entry from, judges a captured session from durable presence at the dequeue and records a dropped one outside, and records a skipped or dropped recipient outside the origin's receipt: the server's own receipt through a fenced commit, a relayed origin's through an outside-audience ACK. The outbound README is the account of positions.                           |
| Receiver ACK and receipt                    | [receipt aggregation](./ws-queue-box-server-receipt-aggregation.ts) translates admissions, ACKs and re-sent copies to the [receipt record](../../alm/receipt-record/al-receipt-record.ts) every instance shares, and proves an ACK that finds no head against the ingress audience; the record owns the count, the deadline and the end | Aggregation enqueues admitted receipts and answers to copies through the existing outbound owner; the record's [worker](../../alm/receipt-record/al-receipt-record-worker.ts) claims the deadline work on any instance and delivers every terminal receipt through the aggregation's `writeEndedReceipt`, which then settles the server's pending row. Enqueue is separate from later publication or sender acknowledgement. |
| Direct/live/control send                    | [target resolution](./ws-queue-box-server-target-resolution.ts) and [recipient selection](./ws-queue-box-server-recipient-selection.ts)                                                                                                                                                                                                 | [Live delivery](./ws-queue-box-server-live-delivery.ts) checks the current recipient and sends; [control delivery](./ws-queue-box-server-control-delivery.ts) uses the live target or owned cluster outbox. [Delivery reporting](./ws-queue-box-server-delivery-reporting.ts) exposes existing outcome ports.                                                                                                                |

Account-wide view notices have a distinct `accountView` authority decoded by
[`ALAccountViewAuthority`](../../alm/outbound/admission/al-outbound-scope-authority.ts).
Their exact reserved envelope is unicast to the account, with `scope: null` in the
notice. The committed producer proof and captured AL policy contain no session
list or recipient scope. Cluster key delivery and the standalone `account-view`
prepared effect both enter live delivery, where recipient selection reads only
this node's current authenticated sockets. Final submission rechecks account,
auth expiry, message expiry and the selected socket generation. Repair retains
the same account authority and resolves the local sockets again. Scoped notices
continue to use their exact scoped principal authority.

Supporting translations remain beside their owner: [inbound planning](./ws-queue-box-server-inbound-plan.ts),
[inbound recipient projection](./ws-queue-box-server-inbound-recipients.ts),
[addressee authorization](./to-ws-queue-box-server-addressee-authorization.ts), and
[receipt row recognition/republish delay](./ws-queue-box-server-receipt-row.ts).
[Contracts](./ws-queue-box-server-contracts.ts) declare the external authority,
target, scope and delivery ports. The `scope/` translations prove producer and
recipient scope at their current admission/send boundaries; they add no second
scope authority or lifecycle.

## Captured-audience re-check

[`readWsQueueBoxServerEligibleAudience`](./scope/read-ws-queue-box-server-eligible-audience.ts)
is the one re-check of a captured audience. It answers within
`WS_CAPTURED_AUDIENCE_READ_DEADLINE_MS` (half the outbound work lease) or rejects,
as a failed read does, so the row retries and a held send releases the session's
next held row. Its three filters (`WsCapturedRecipientEligibilityFilters`):
`durable` judges at the dequeue and the repair, `socket` narrows a send its
dequeue already judged by this instance's open sockets and reads nothing, and
`local` re-checks a send that carries no judgement (a held send, a cluster notice
without one) afresh. The dequeue's judgement reaches the cluster publisher's send
as `Handoff.judgedDrops` and every other instance's send as the notice's
`droppedSessionIds`, so a granted cluster row reads its snapshot once per attempt.
A dequeue that passed the captured audience through (no filters wired, a session
invalidation, a row admitted to no audience) hands no judgement: the authority's
`audienceJudged` carries that one decision from `readCurrentAudience`.

## Private receipt evidence

[`WsQueueBoxServerReceiptObservation`](./ws-queue-box-server-receipt-observation.ts)
is the private typed union for socket decision, count, receipt outbox, receipt
work, transport and publication results. The authority carries its already-read peer/scope/clock facts; the
service reports its final actual socket result.

`acceptControlMessage`, the one count path, reports what its count read (the
outcome, and the view a counted ACK returned) in `finally` after any `end`; a
count the store failed reports nothing. The ended work's terminal receipt reports
its outbox observation in `finally` after the settlement.
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
   inbound runtime `admitIncomingMessage` → the receipt hook
   (`readRelayedAckRejection`, asynchronous: aggregation `readRecordRefusal` reads
   the head and applies `validateALReceiptRecordConfirmation`, or proves a sender
   that finds no head against the ingress audience) → inbound runtime control
   callback → aggregation `acceptControlMessage`. Refusal returns the same typed
   rejection; an operational exception propagates.
2. Count/completion: aggregation `acceptControlMessage` → `ALReceiptRecord.count`,
   or `countAhead` for an ACK the hook proved and that finds no head (the record's
   `writeConfirmation`: guard, then the confirmation `set`) → the `Counted` view →
   `end` when the view is complete → worker `committed` → the worker's ended work
   → aggregation `writeEndedReceipt` → existing outbound enqueue → server receipt
   settlement → guarded outbox/count observations. A losing `end` does nothing;
   only `end`'s result is authoritative.
3. Deadline: the record's worker task on the engine → worker `runClaim` on
   whichever instance claims the deadline work → record `end`
   (`computeALReceiptRecordEnding`, the head's `setFence`) → the ended head and
   its ended work → `writeEndedReceipt` as in probe 2. A store failure in any of
   these reads or writes propagates; a refused or conflicting count is a typed
   outcome. No relay path remains: an ACK counts on the instance it reaches.
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
