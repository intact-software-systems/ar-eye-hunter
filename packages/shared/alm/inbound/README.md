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

## Store identity and carrier partition

One inbound admission store exists per browser session, keyed
`browser-session-inbound:<sessionId>` and resolved once, in the browser's
composition root
([`initialiseMiddleware`](../../../shared-web/browser/connection/initialise-browser-middleware.ts)),
by
[`resolveBrowserSessionALInboundRuntimeStores`](../../../shared-web/browser/al-runtime/browser-al-runtime-stores.ts).
That one resolved store is injected as a required dependency into both
carrier services — the WS client's `WsQueueBoxClientService` and RTC's
`WebRtcRxStreamerService` — and neither resolves its own.

Every stored key stays session-logical: dedup, message-owner, ordering,
supersedence, and control rows are shared across carriers, because a given
message and its control history are one identity no matter which carrier
delivered them.

What is partitioned per carrier is which QueueBox work rows a runtime may
claim. [`toALInboundWorkType`](./al-inbound-work-entry.ts) types a work row
`AL_INBOUND:<carrier>:<fnv1a64(namespace)>`, so each inbound runtime — RTC or
WS — reserves only its own carrier's type and re-plans, delivers, sends
control, and forwards only on its own carrier. One data-admission commit
bundle carries one carrier — the arriving message's own — on every ordinary
effect it writes (dispatch, forward, ack, nack, repair). The one exception is
a buffered release: the buffered slot records the carrier the buffered
message itself arrived on, and its `release-buffered` row is written under
that slot's carrier, never the releasing message's, so the buffered
message's own runtime is the one that re-plans and dispatches it. When a
releasable slot has already vanished, its confirmation-only row falls back
to the releasing read's carrier, because there is no slot carrier left to
read and the row dispatches nothing.

The control and ACK row family — `pending`, `acks`, and the owner index — is
carrier-tagged too, and lives in its own file,
[`inbound/control/al-inbound-control-rows.ts`](./control/al-inbound-control-rows.ts):
`pending.carrier` is the data message's own arrival carrier, and each entry
in `acks` carries the carrier that ACK itself arrived on, independent of the
message's carrier.
[`ALInboundControlAdmission.admit(msg, source)`](./control/al-inbound-control-admission.ts)
takes the arrival source, from which its carrier is derived. A message's
pending admission retained concurrently over both carriers is a value
outcome, not a thrown corruption: the retained row keeps the first arrival's
source and carrier.

An ACK is `al.control.ack.v2`
([`al-control.ts`](../../al-contracts/al-control.ts)): beside its hop
sender and receiver it names the acknowledged message's origin
(`originPeerId`, the message's `senderId`) and the recipient it speaks for
(`logicalRecipientPeerId`). A receiver's own ACK speaks for itself; a relay
whose pending receipt completes re-originates one ACK per logical recipient
its subtree confirmed, beside its own when it is a logical recipient that
delivered locally (the pending row's `localRecipient`), and speaks for itself
alone when no confirming ACK is retained. The relay refuses a child's ACK as a
duplicate only when both its sender and its logical recipient repeat, so a child
relay's ACKs for different recipients are each admitted. The origin is never copied from a child: the relay names its own
message-owner row's sender, and both the relay's inbound control admission
and the origin's outbound control admission refuse an ACK whose
`originPeerId` names another origin. An
`al.control.ack.v1` envelope is refused `unsupported` like any unknown
control id. The same file defines `al.control.receipt.v1`, the WS server's
word to an origin, addressed and routed to `originPeerId`.

On the WS server the same inbound admission runs for every client message,
with two receipt rules. A `receiver` room message the server aggregates
withholds the server's own ACK
([`toWsQueueBoxServerInboundPlan`](../../services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts)):
the receipt speaks for the audience, and a relay row would re-originate the
receivers' ACKs under the origin's name. A `receiver` message whose logical
recipient is the server keeps its ACK. A receiver's ACK for a room message
is addressed to the origin, not to the server; the server admits it as the
aggregating relay hop only while its aggregate for `(originPeerId, msgId)`
lives, the ACK speaks for its own sender, and it confirms an uncounted
member of the frozen audience. Every other such ACK is refused at ingress as
a typed value.

The receipt row the ACK completes against is the origin's outbound
pending-ACK row, keyed `(namespace, originPeerId, msgId)`; the group is row
content, not a key segment, because message ids are origin-unique and no
group exists at every key site (R-S2c-i-2, amending D40; see the outbound
README). A relay's inbound `pending` row tracks the child hops it forwarded
to (S2c-ii). Every child ACK it admits is relayed upward at once as a
`forwarded` ACK for the recipient it names, so a far recipient is never lost
behind a relay whose row already completed. A child hop completes only on its
own `delivered` ACK (a leaf) or its `subtree-complete` terminal ACK (a relay).
Once this peer is ready and every child hop completed, the relay sends its
own terminal `subtree-complete` ACK, naming itself, last; the parent reads it
as the end of the subtree. The row stays until it expires, so a child ACK
that arrives after completion is still relayed, and a retried copy of the
message is answered from it: a completed row sends its terminal ACK again, an
incomplete one forwards the copy only to the child hops still owed, and a
peer with no row sends its own `delivered` ACK again. No retried copy is
delivered locally twice.

The schema identity is `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-s2c-ii'`. An
existing browser database at a different schema identity is deleted and
recreated once, as described under
["Selection, failure, and cleanup"](#selection-failure-and-cleanup) below.

**The deploy window.** No row kind this change touches lacks an expiry, so
nothing the WS server's PostgreSQL store holds from before the deploy stays
undecodable or unclaimed forever — but the window is longer than "30
minutes" for two of the four row kinds:

- `pending` and `acks` control rows, and carrier-less `admit-control`
  retained payloads, are undecodable for their control TTL — 30 minutes by
  default (`controlHistoryTtlMs`/`controlPendingTtlMs`) — except that a
  `pending` row whose own message TTL outlives 30 minutes stays undecodable
  for that longer message TTL instead.
- A buffered-slot row written by the old build carries no `carrier` and is
  undecodable for the message's own TTL, or 60 minutes by default
  (`bufferedMessageTtlMs`/`repositoryTtlMs`) when the message has none. Until
  it expires, every later admission on that same ordered track calls
  `readOrderingState`, which lists and decodes every buffered slot of the
  track, so the whole track stalls on `ALAdmissionCorruptionError` — not only
  the one message the slot buffered. Past expiry, the row keeps throwing
  until the runtime-state expiry worker sweeps it, because the PostgreSQL
  prefix read decodes a row before it applies the expiry filter.
- Old-format `AL_INBOUND:<fnv1a64(namespace)>` work rows with no carrier
  segment are simply unclaimed by either runtime until they expire.

An ACK sent by a page still running the old build is refused as
`unsupported` (its type id is `al.control.ack.v1`) until that page reloads —
this is not bounded by the row TTL, since the page itself, not a stored row,
is what is out of date. The refusal is symmetric: an old-build page also
refuses a new-build `al.control.ack.v2`, until it reloads.

## Admission and invocation paths

| Entry                           | Decision and durable result                                                                                                                                                                                                                                                                                                                                                                                                                                | Subsequent execution                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data ingress                    | `ALInboundMessageAdmission.attempt` reads observations, computes the admission bundle, validates it, then calls `commitBundle`. The store compares the original message, ordering, supersedence, receipt, and delivery observations before writing state and work together.                                                                                                                                                                                | A commit that wrote work announces it; one that wrote none leaves that round unannounced — the rotation reads a page every engine round either way.                                                                                                        |
| Initial data admission conflict | A fully validated message is retained as `admit-message` in the same inbound QueueBox namespace, with its source and original deadline. Retention checks exact content and identity on reuse.                                                                                                                                                                                                                                                              | The caller receives `pending-admission`; the worker later calls `replay` for one fresh admission attempt. No success receipt is earned by pending storage.                                                                                                 |
| Control ingress                 | [`ALInboundControlAdmission`](./control/al-inbound-control-admission.ts) reads the tracked message and expected control peer, then [`computeALInboundControlAdmission`](./control/compute-al-inbound-control-admission.ts) and [`validateALInboundControlAdmission`](./control/validate-al-inbound-control-admission.ts) decide the candidate before a conditional commit of its state and effects. Unknown controls cannot create a pending data message. | A commit that wrote work announces it, and the configured control callback receives the acceptance. A commit conflict retains `admit-control` work, answers `pending-admission`, and the worker's replay reports the acceptance through the same callback. |
| Admitted delivery               | `ALInboundAdmittedDelivery` decides on the surface its eligibility read carried, and reads that surface itself — the retained message and its stored planning state, from one session — for a claim that carries none. It then re-checks expiry and ordering before it dispatches locally or forwards through the supplied port.                                                                                                                           | The worker completes or reschedules the claimed QueueBox entry.                                                                                                                                                                                            |
| Buffered release                | [`ALInboundOrderedDelivery`](./al-inbound-ordered-delivery.ts) reads progress and buffered work, computes a permitted release or resynchronization result, and commits the observed transition.                                                                                                                                                                                                                                                            | Local dispatch occurs only after the required release decision; later work becomes eligible through the same worker.                                                                                                                                       |

`validateALInboundControlAdmission` returns every reason an acknowledgement is
inadmissible; the caller joins them into one rejection reason. Only an absent pending
obligation short-circuits, because the remaining checks read that obligation.

A commit announces the work it wrote, and only that. A data or control replay whose own
commit persisted work, and an inline control admission whose commit wrote a row, announce
it through `commitWork()`: the scan restarts and the row reaches the batch the running
batch's end schedules, rather than whichever round the rotation next reaches. A retained
conflict announces for the same reason, and only when retention left a claimable row: a message
already past its deadline is rejected before the write or as a row written already expired, and a
row that is already terminal holds nothing to claim. An admission that wrote no row announces nothing, because
there is nothing for the worker to claim, and a conflict the plan does not retain wrote no
row at all.

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

Every inbound decision surface — `readIncomingMessage`, `readBufferedRelease`,
`readDeliverySurface`, `readOrderedDelivery` and `readControlDecisionSurface` — reads
its whole chain inside one
[`ALAdmissionWorkBackend.readWithin`](../al-admission-work-backend.ts) session, so a
surface costs one store snapshot rather than one read per row it needs. On IndexedDB that
session is a single readonly transaction over the admission store and the work store; the
memory and PostgreSQL backends hold no snapshot to keep open and serve the session from the
backend itself. A read issued after that transaction ended continues on a fresh one, so an
await on anything but a session read splits the surface in two without saying so: a
decision surface awaits the session's own promises and nothing else. The session never
writes, which is why these reads stay outside the write that follows them, and the fence
`requireOriginalObservations` still re-reads the whole observed surface inside the write —
the snapshot makes the read cheap, the fence is what makes the commit conditional.

A row the chain read past its expiry reads as absent. On IndexedDB, once the chain has read
everything, `readWithin` evicts those rows in one readwrite, each removal guarded by the write
token the chain read it at; the direct `read` and `list` evict the same way. If another writer
replaced or removed one of those rows in between, for example a concurrent chain that evicted it
first, the guard rolls the whole eviction back and the row is left to that writer or to the next
chain that reads it expired. The guarded write answers that as not committed, and the eviction
does not turn the answer into an error: the chain already answered from a snapshot in which the
row was absent, and a conflict belongs only to a write that fences on what it read. A read
surface therefore never throws `ALAdmissionBackendConflictError`, so the admission reading it —
the outbound control admission of an ACK included — reaches its own commit and its own typed
conflict.

What makes that commit conditional: the backend records, for every key the write phase read or
wrote, the revision and write token it observed there (or that the key was absent), and for every
prefix it listed, the exact key set that listing returned. Before the transaction commits it
re-reads exactly those rows and prefixes and rolls back as a typed conflict only when one of them
moved; an admission, send, or ACK against a different message's rows and a different listed range
touches none of that and commits alongside it. The three backends are conflict-equivalent under
this fence: the in-memory backend serializes writers on its own write-tail promise, and IndexedDB
and PostgreSQL both compare per row instead.

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

A retained conflict's replay re-reads its decision surface. It does not carry one forward,
and cannot: a conflict means an authority-bearing observation moved, so the surface the
attempt read is exactly the thing that has to be read again. The pre-plan, the deadline and
the decoded message are pure work re-derived from the message and the source
[`retainPending`](./al-inbound-message-admission.ts) already persists; the effect facts are
carried by neither, and are taken fresh instead — `readALInboundEffectFacts` builds
`selfPeerId`, `observedAtEpochMs` and a new `controlIdPrefix` from the replay's own clock
and this owner's effect preparation. So the retained payload carries nothing it did not
carry before and the stored schema identity did not move. The replay runs in the batch the
owner's own commit starts when the worker is idle, or in the follow-up batch
`commitPending` schedules when a batch is already running; it never waits for the rotation
to come round to it.

Pending replay uses the currently configured planner. The WS server additionally
supplies `readPendingAdmissionAuthority`, which calls its existing asynchronous
authority owner before admission. Current authorized recipients intersect the
captured recipients. An admitted room multicast counts the server among its group
members, so the server delivers it locally to the topic router, which owns the
room's fanout; the server never forwards it. Revocation retires pending work
without admission metadata or receipts. Temporary authority catch-up uses the
existing `RETRY`/future `nextTs` path with `reason: 'not-ready'`, preserving the
processing attempt count.

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

The delivery that an eligibility read cleared does not read that surface again. For a
`dispatch-local` or `forward-message` row the read takes the retained message and its
stored planning state, and the selector carries exactly that surface to the claim by effect
id ([`ALInboundDeliveryObservation`](./al-inbound-admitted-delivery.ts)). It is recorded
only for a row the port went on to reserve, and it is dropped when the scan restarts or the
next page replaces it. The delivery then decides again only what cannot be decided as early
as the page: every expiry, against a fresh clock reading, and an ordered message's
predecessor, which can land inside the claim window. A claim that carries no observation
reads the surface for itself.

A batch runs the page's claims in rank order rather than page order:
[`computeALInboundClaimOrder`](./read-al-inbound-work-selection.ts) puts `dispatch-local` and
`release-buffered` first, then admission replays and rows whose kind the page never decoded,
then `send-control` and `forward-message` last. Page order is key order, and an ACK's key can
sort before the dispatch it acknowledges; running deliveries first keeps such an ACK from
committing ahead of the delivery it is only useful after. The sort reads the kind from the map
the eligibility read already filled, so it costs no operation and opens no transaction, and it
is stable within a rank, so page order still decides among equals.

A batch's `send-control` claims share one send. The selection records every `send-control` row
the port reserved, with the envelope its eligibility read decoded
([`getClaimedControlSends`](./read-al-inbound-work-selection.ts)), in a fresh array per
selection. The first of those claims to run hands the whole array to `sendControlMessages`, and
every other claim of that batch awaits the same send. The browser carriers commit that array as one
outbound admission (`enqueueAllIfAbsent`); the WS server sends its messages one after another, in
order. The round is keyed by that array's identity, never by time, so a row retried in a later
batch never joins a finished round. A restarted scan empties the array, and a claim it left out
sends alone. When the round's send throws, each of its claims sends its own message alone, so each
claim settles on its own message. That path serves the WS client, whose grouped admission rethrows
a member's storage throw once every member ran: a message the round already admitted then answers
`duplicate`, and only the claim whose message throws again carries that failure. On RTC the round
does not throw, because the multicast manager's circuit breaker answers a throw as `failed` values,
as it answered a single send's throw before grouping. The WS server makes no admission; a
synchronous throw there would send the messages before it a second time, which receivers drop by
message id.

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
at 10-13 ms/op — 12.6 measured on the full lane, 10.3 on the rtc-only run that isolated
this relay — and `rotation-alive` remains the liveness witness that a scanning rotation is
still running.

What the owner does relay is `effect-drain`, for a batch that touched work, reporting where
that batch spent its time — selection, claim, run and release, which do not sum to its
duration, for the reasons the contract document states — and how long the earliest row it
claimed had been due (`queueWaitMs`); one `claim-settled` for each claim that ran to an
outcome, with that claim's own duration, attempts, outcome and wait — a row that cannot be
decoded and a claim that throws are counted by the drain and named by no event; and
`rotation-alive` once per `AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS` empty rounds, carrying
`longestRoundMs` so one crawling scan is not averaged away by the rest. Each `claim-settled`
also carries `effectId` (the claimed row's own key), `subjectMsgId` (the message the effect
acts on) and the three instants a delivery's wait splits at — `dueAtMs`, when its row became
due; `batchStartedAtMs`, when its batch's run loop started, after that batch's selection and
reservation; and `startedAtMs`, when the claim itself started — so the reservation half
(`batchStartedAtMs − dueAtMs`) and the intra-batch half (`startedAtMs − batchStartedAtMs`, the
serialization behind earlier claims of the run loop alone) are each named rather than left for
a reader to subtract. `effect-drain` carries the matching `startedAtMs` and names the effects it
ran in run order (`claimedEffectIds`, recorded by this owner as it runs them). The due rows a round
saw and did not run ride on the events that already exist, never on one of their own: a
round that ran claims lists them in its `effect-drain.deferred`, and empty rounds fold them
into the next `rotation-alive` (`deferredRoundCount`, `latestDeferred`). No
`readiness-probe` reaches the inbound topic. The field-by-field contract is in
[`runtime-diagnostic-contract.md`](../../../shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md).

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
