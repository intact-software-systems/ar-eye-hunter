# A cancel and a hand-over that survive a reload

Status: design approved by the maintainer on 2026-11-22; being built.

## Intent

When a sender cancels a durable message, or the message hands over to the other carrier, that is a
fact about the message. Today the fact is held only in the page's memory
(`packages/shared/alm/outbound/lane/al-outbound-send-controls.ts`), so a reload forgets it and the
outbound runtime resumes the message from IndexedDB. This slice states the fact where every other
end of a message is already stated: the `ended` marker of the stored message row (D686).

## What the reproduction found

`packages/tests/shared/alm/outbound/al-outbound-ended-across-reload.test.ts` composes the real
runtime over fake-indexeddb. A reload is `dispose()`, then a second runtime over the same database
and namespace. All six tests assert the wanted behaviour and are red today.

| Case                                                  | What happens today after the reload                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Cancelled while its first send was held               | The held copy is sent.                                                           |
| Cancelled after the first frame left, receipt open    | Three retransmissions, then `receipt-exhausted` for a message already cancelled. |
| Cancelled while only its retained admission existed   | The message is admitted, then sent.                                              |
| Handed over while its send was held                   | The held copy is sent once. Nothing else resumes: the receipt rows were deleted. |
| Empty frozen audience, receipt complete at admission  | The stored row has no marker.                                                    |
| A later retransmission of that empty-audience message | Admitted and sent, before and after a reload.                                    |

Three findings differ from the backlog line:

- A cancelled message does more than resume. Its receipt runs its whole retry budget and then
  states a terminal `receipt-exhausted`, which contradicts the `cancelled` the handle already read.
- A cancel can land before any stored row exists. An admission whose first commit conflicts is
  kept only as an `admit-message` work row (`retainPendingDispatch`). The marker has no row to
  mark there.
- The empty-audience gap needs no reload. Any later dispatch of the message that is not an
  admission (a repair, a retransmission) is admitted instead of answered `message-ended`.

One more case follows from the same cause and is not yet reproduced: a tab that does not own the
session's durable work cancels a message, and the owning tab still sends it, because the cancel is
in the first tab's memory only. The fix below covers it, and the build adds its test.

## Goals

- A cancelled durable message sends nothing, retries nothing and states nothing after a reload.
- A handed-over durable message sends nothing and states nothing on the carrier it left after a
  reload.
- The same holds for the tab that owns the session's durable work when another tab cancelled.
- A receipt an empty frozen audience completes at admission marks its message ended in that commit.
- No IndexedDB operation is added to a send. The operation-count pins do not move.

## Non-goals

- A handle that survives a reload (D13 stands: the old handle reads `unobservable`).
- A fallback that resumes after a reload (D64 stands: only the page's live handles hand over).
- The frame that can follow an end landing between `readSendGuards` and the carrier's write
  (its own backlog line).
- Any change to the inbound side, the wire, or the public delivery vocabulary.

## Approaches

**A. The cancel and the hand-over end the message in a commit of their own.** The lane that holds
the message reads it and commits `toALOutboundMessageEndBundle`, the bundle every terminal end
already writes: the `ended` marker, the receipt and repair-count deletes, the first-hop wait's
delete and the completion of both timers. The memory controls stay as the page's immediate guard:
they abort the live attempt and cover the time until the commit lands. Everything after the commit
is existing behaviour: a queued copy meets the marker at `readSendGuards`, a dispatch answers
`message-ended`, a receipt and a NACK are refused, a timer writes nothing.
Cost: per cancel, one read in the lane that holds the message and one commit when it holds a row.
No new row kind, no new persisted vocabulary, no read on the send path.
Trade-off: the commit is fenced on the sender version, so it can conflict with a control or timer
commit, and a cancel has no queue delivery to redeliver it.

**B. A durable end fact as work.** The cancel writes an `end-message` work row, unfenced. The work
handler runs it: read, commit the same bundle, and a conflict is redelivered by the queue.
Cost: a new persisted effect kind (the work payload, its validation, both lane switches), a new
unfenced write on the admission store, and a rule for a row that finds no stored message.
Trade-off: the most faithful to "a conflict exits to redelivery", and the largest. After a reload
a copy claimed in the same batch as the end row can still leave before the marker lands.

**C. A cancel row of its own, read at every claim.** A row keyed by message id that
`readSettledBeforeEffect` reads. It covers a message with no stored row.
Trade-off: one more IndexedDB read on every claimed effect of every durable send, and a second
place that says a message has ended. D686 rejected a row of its own for that reason.

## Pick: A

A reuses the one end the code already has, adds nothing to a send, and touches the fewest files.
Its one weakness, the conflict, is closed without a retry loop: the memory controls remember that
the durable end is still owed, and the next effect of that message this page claims commits the end
before it completes. That claim is a queue delivery, so a conflict there is redelivered as every
other work conflict is.

The shape:

- `ALOutboundMessageRuntime.cancel` and `handOver` keep their signatures and their memory step.
  Both then ask the lane that holds the message (`readLaneForMessage`) to end it. `handOver`
  already awaits its commit; `cancel` stays synchronous and starts the commit without awaiting it,
  and `dispose` joins it.
- The lane's end replaces `ALOutboundRepairAdmission.endReceipt`. It reads the message as
  `endReceipt` does and commits `toALOutboundReadMessageEndBundle`. A message with no stored row in
  that lane writes nothing.
- A hand-over therefore marks the message ended on the carrier it left. It still states no
  settlement. The other carrier's stores have their own namespace, so the WS leg is not touched.
- `computeALOutboundDispatch` writes `ended: true` on the `set-sent-message` of an admission whose
  frozen audience is empty and whose receipt is `receiver`. The acknowledgement is still stated
  once, by `toALOutboundEmptyAudienceReceipt`.
- The memory lanes take the same path, so a checkpointed message is saved with its marker at the
  next checkpoint.

What stays true and is said plainly in the README: a cancel is durable once its commit lands. A
page that dies in the few milliseconds between `cancel()` returning and that commit loses it, as
any storage write would be lost.

## Rulings (2026-11-22)

1. The approach is A: a cancel and a hand-over end the message in a commit of their own.
2. A cancel that finds no stored row deletes the retained `admit-message` row. The durable lane
   remembers, in memory, the admissions this page retained; only the page that enqueued a message
   can cancel it, so that memory is complete. A replay already running on the row conflicts on its
   own guard and admits nothing.
3. The design is approved with both changes to what D686 listed as not terminal: a hand-over marks
   the message ended on the carrier it left, and an empty-audience admission writes the marker.

## Lane proof

`delivery-reload` carries it; no new scenario file. Under the cell's existing hold the sender sends
a second durable message and cancels it before the reload. After the reload and the recovery waits
the receiver has the original and never the cancelled one, asserted with an absence wait as
`delivery-lifecycle` asserts `absent-cancelled`. The cell runs over `ws` and `rtc`.

On `rtc-with-ws-fallback` the cell's hold already hands the original to WS before the reload. The
receiver takes it once over WS, and the unit test pins that the overlay store sends nothing after
the reload. If the lane has a command that reads the overlay store's attempts, the cell asserts
that too.

## Tests

Unit, red first: the six reproductions above; the two-tab cancel; a conflict on the cancel's commit
that the next claimed effect repairs; a hand-over's marker; that a cancel of a message the owner
never admitted writes nothing. Existing pins to restate: the hand-over's conflict test (C6) and the
`ended`-marker pins of D686 that list a hand-over and the empty audience as not terminal.

## Documents in the same pull request

`plans/backlog.md` loses the line. `playground/alm/alm-improvement-plan.md` gains D750 onward.
`packages/shared/alm/outbound/README.md` ("Receipt ends and the hand-over") and
`playground/alm/alm-complete-product-description.md` are corrected where they say a cancel and a
hand-over are held in memory. This file is deleted before the pull request is marked ready.
