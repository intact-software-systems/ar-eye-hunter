# The receipt record

[`ALReceiptRecord`](./al-receipt-record.ts) is the durable count of who confirmed a receipted WS send. The WS server
counts every receipt it answers for in it: a client's `receiver` or `leader` room send and the server's own logically
receipted publications. Every instance of a server reads and writes the same record, so any instance counts any ACK,
ends any receipt and answers any re-sent copy, and a receipt stays exact when the instance that admitted the send
crashes or restarts. A receipt after such a loss is exact: it keeps every ACK counted before the crash.
Two other builds were weighed: the server's durable `receiver` pending row, correct but too slow at hosted latency
(D779), and a checkpointed memory count a survivor adopts, dropped because it needs instance liveness and ownership
transfer and still loses the ACKs inside the checkpoint window.

The record is one more AL runtime store (D770). It is written directly at WS ingress, guard first and in one
transaction, as the AL runtime's inbound and outbound stores are; it does not pass through AppInbox. Its only caller
in production is [`WsQueueBoxServerReceiptAggregation`](../../services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts),
which translates admissions, ACKs and re-sent copies to the record's operations
([WS server README](../../services/ws-queue-box-server/README.md); the protocol is the
[outbound README's](../outbound/README.md#server-receipts-on-ws) "Server receipts on WS").

## Where its rows live

The record is written against the port the AL runtime's stores already use,
[`ALAdmissionWorkBackend`](../al-admission-work-backend.ts): keyed rows with expiry, a prefix read, a write
transaction with fences, and due work rows any instance claims. `packages/shared` stays free of PostgreSQL:
[`createInMemoryALReceiptRecordStores`](./al-receipt-record-stores.ts) builds the memory backend, and
`createPSqlALReceiptRecordStores` (`packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts`)
the PostgreSQL one, over the shared runtime-state repository. A memory-only server uses the same record on the memory
backend and keeps nothing across a restart.

Its namespace is `<store namespace>:receipt:record` ([`toALReceiptRecordNamespace`](./al-receipt-record-keys.ts); on
api-v1 `server-ws-qbox:default-qbox-server:receipt:record`). The namespace derives from the server's name, so every
instance of one cluster must share one server name. It holds four kinds of row:

| Row          | Key or slot                                                                        | Holds                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Head         | `<ns>:receipt:<JSON [origin, msgId]>`, one per receipted message                   | `open` with the opening (expected recipients, never-sent recipients, snapshot version, trace, deadline), or `complete`/`timed-out` with the confirmed and outside sets and the end time |
| Confirmation | `<ns>:receipt-ack:<JSON [origin, msgId]>:<recipient>`, one per answering recipient | `confirmed` or `outside`, and the time it was counted                                                                                                                                   |
| Deadline     | work topic `AL_RECEIPT_DEADLINE`, one per receipted message, due at its deadline   | the message's ref; written with the head                                                                                                                                                |
| Ended        | work topic `AL_RECEIPT_ENDED`, one per terminal receipt, due at the end            | the message's ref; written by the transaction that ends the head                                                                                                                        |

The JSON pair keeps `o` + `m:x` and `o:m` + `x` apart. The work rows share one work type,
`AL_RECEIPT_RECORD:<fnv1a64(ns)>` ([`al-receipt-record-work-entry.ts`](./al-receipt-record-work-entry.ts)). While a
head is `open` its confirmation rows are the count; once it ends, the head alone is the receipt, its sets in expected
order and naming each recipient once. A confirmation is read back only under its exact key, and a row under another
key fails closed as `ALAdmissionCorruptionError`. Every stored identity is one the receipt control accepts
(`decodeALReceiptIdentifier`), so a stored row can always become a receipt.

On PostgreSQL the keyed rows are `runtime_state_store` rows of that namespace, growth surface 90 (`ttl-within-run`,
bound 1 860 000 ms: the window plus two graces; `growth-surfaces.ts`), and the work rows are expiring `resource_inbox`
rows under surface 1.

## Operations

Each operation returns a value; a lost fence is `conflict`. Only `ALAdmissionBackendConflictError` becomes `conflict`;
every other backend error propagates.

| Operation    | Does                                                                                                                                           | Returns                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `open`       | One transaction: the head, fenced on its absence, and its deadline work; then reads the confirmations                                          | the view; `invalid-opening` with every issue; `conflict` when a head exists or another write won          |
| `count`      | Reads the head and the confirmation's key; validates; writes the confirmation; reads the confirmations after its own write has committed       | `counted` or `repeated` with the view; `head-absent`; `invalid-confirmation` with every issue; `conflict` |
| `countAhead` | For an ACK whose caller proved it and that found no head: writes the confirmation, then reads the record                                       | as `count`, or `ahead` when no head has appeared; never `head-absent`                                     |
| `end`        | One transaction, fenced on the open head: derives the terminal phase and sets from what it reads, and writes the ended head and its ended work | the ended head; `head-absent`; `not-due`, writing nothing; `conflict` when the head ended or another won  |
| `read`       | The head, and the confirmations while it is open                                                                                               | the view; `head-absent`                                                                                   |

`open` refuses, all issues at once ([`validateALReceiptRecordOpening`](./validate-al-receipt-record-opening.ts)): an
empty audience (`empty-audience`), which could never complete; more than 256 expected recipients
(`audience-over-limit`, the message collection limit); a receipt already past its grace (`receipt-expired`); a deadline
beyond `now + window` (`deadline-beyond-window`); an opening the stored-head decoder would refuse
(`malformed-opening`). The window is 30 min (`AL_RECEIPT_RECORD_WINDOW_MS`); the caller clamps its deadline to it.

A confirmation is `confirmed`, `outside`, or the owner's `not-sent` (the server sent that recipient nothing), stored as
`outside`. `count` refuses, all issues at once ([`validateALReceiptRecordConfirmation`](./validate-al-receipt-record-confirmation.ts)):
an ended head (`head-ended`), a recipient outside the frozen audience (`outside-frozen-audience`), a passed deadline
(`deadline-expired`), and a recipient the head names never sent, unless the confirmation is the owner's `not-sent`
(`never-sent`). A refused confirmation writes nothing, so a session writes at most one row per message that expects
it. The first write wins: a second confirmation of one recipient is `repeated` and writes nothing, since two instances
can each validate before either writes and a refusal could not be exact. The one exception: the owner's `not-sent`
replaces a `confirmed` row of a recipient the head names never sent, a row only a confirmation written ahead of the
head can have stored.

The tally ([`computeALReceiptRecordTally`](./compute-al-receipt-record-tally.ts)) of an open head counts the expected
recipients once each, ignores a confirmation counted at or after the head's deadline (a row written ahead passed no
validator) and a `confirmed` row of a never-sent recipient, and is complete when every expected recipient is
confirmed or outside and at least one confirmed. A set answered only from outside the audience delivered nothing and
never completes.

`end` takes no phase ([`computeALReceiptRecordEnding`](./compute-al-receipt-record-ending.ts)): it ends `complete`
when the set it reads is complete, `timed-out` once the deadline has passed, and answers `not-due` otherwise, so no
caller can state a phase the record does not hold. Of several instances that end one receipt, one commits and the
others read `conflict`. Within one head's life there is one terminal phase and one terminal receipt per message,
whatever the instances' clocks say.

**Only `end`'s result is authoritative.** `count` reads the confirmations only after its own write has committed, so
of the last two confirmations whichever reads later sees both, and a completion cannot be missed. But a `count` that
read an open head can commit after another instance's `end`; its view may then say `open`, even complete, for a
receipt stored `timed-out`, and its confirmation is ignored, since after the end the head's own sets are the receipt.
A caller acts only on an open head whose tally is complete, by calling `end`, and uses what `end` returns. At high
latency the last two ACKs of most messages both read a complete set and both call `end`; one commits and the other's
`conflict` is routine.

`countAhead` reads after its write: an `open` that committed between the ACK's head read and its write would otherwise
leave a complete set unseen until the deadline. Otherwise the `open` that follows counts the row, since `open` reads
the confirmations once it commits.

## Clocks and expiries

Heads and confirmations expire on the clock of the instance that reads them, and a write replaces such a row by its
revision on that clock. On PostgreSQL, work rows come due and are swept on the database clock, and only a work row is
taken as gone on it: the deadline work row's conditional insert replaces an expired row that no sweep has deleted only
once `now()` has passed its `expire_ts`. The grace is `AL_RECEIPT_DEADLINE_GRACE_MS` (30 s), as on the origin's own
receipt row.

| Row                               | Expires at                |
| --------------------------------- | ------------------------- |
| Open head, and its deadline work  | deadline + 30 s           |
| Confirmation under a head         | deadline + 60 s           |
| Ended head, and its ended work    | max(deadline, end) + 30 s |
| Confirmation written with no head | now + 30 min + 30 s       |

A confirmation under a head outlives the open head by one grace: a deadline pass that runs late reads the head and
the confirmations as two reads, and with equal expiries could read a live head and no confirmation, ending
`timed-out` naming nobody. A confirmation written with no head lives the window plus a grace, enough for a head
opened within one grace of it; while the head is open the rows are the count, so a shorter expiry would end a receipt
`timed-out` naming a recipient that confirmed.

## The worker

[`ALReceiptRecordWorker`](./al-receipt-record-worker.ts) (`<serverPeerId>:receipt-record`) rides the engine the WS
server already runs: lease 10 s, a page of 16 claims run one at a time. The aggregation tells it of each `open` and
`end` it commits (`committed`); a survivor learns of another instance's row at its next readiness read, within 3 s.

- A **deadline** row calls `end`: `timed-out` naming the recipients confirmed so far, or `complete` when the set is
  complete. A head already ended answers `conflict` or `head-absent`, and nothing is written; a `conflict` is read
  again, and a head still open (a fence another write held) retries the row. Those retries are bounded by the work
  queue's attempts (20) and by the row's expiry, one grace past the deadline, after which the head expires open and
  the receipt is lost with it. When the queue calls a
  row due before the record does (the queue may read another clock; PostgreSQL's reads the database's), `end` answers
  `not-due` and the row waits what the instance still lacks, never less than 250 ms, with no attempt spent; a
  `timed-out` receipt can so be up to 250 ms late on an instance whose clock runs behind the queue's.
- An **ended** row reads the ended head and calls the owner's `writeEndedReceipt`. It delivers at least once: a row
  claimed again (its lease ran out during a slow delivery, or a crash fell between the delivery and the release)
  delivers again, so the delivery must be safe to repeat. A delivery that rejects retries the row.

For a client's send the WS server's ended work enqueues the receipt control as a durable `WS_OUTBOX` row for the
origin, then settles the server's own pending row of the message with it (`acceptServerReceipt`, D38). For a server
publication it enqueues nothing: it admits the receipt into the server's pending row, and a row the store could not
reach (`storage-unavailable`) throws, so the work retries.

## Control ids

Every delivery of one ended work carries the same control id, `toWsQueueBoxServerEndedReceiptControlId`
(`al-receipt-ended:<fnv1a64 of the ref token>`), so a work row claimed twice enqueues one receipt and every repeat is
the outbox's duplicate. "Exactly one terminal receipt" means one stored head with one terminal phase: the outbox may
still deliver that receipt more than once, under that one control id, until its origin acknowledges it, which is the
receipt row's republication.

A re-sent copy is answered from `read`, on any instance, to that sender alone and under a fresh control id: `admitted`
with the confirmations so far while the head is open, written to the origin's sockets on the instance that answers
the copy and a row only when none there took it, and the terminal receipt, as a row, from the head's own sets, after the
end too. A copy that finds an open head complete (the count that completed it lost its `end`) also ends it, as an
admission whose `open` finds the set complete does. A client that already holds the terminal receipt refuses the second as it refuses any receipt for an ended
message.

## How the WS server opens it

- **A client's send.** The admission that admits the message, at ingress or at a kept send's replay, opens the head
  for its frozen audience and writes the `admitted` receipt, to the origin's sockets on that instance, and as a
  durable row only when no socket there took it; its deadline is the message's own, else its ACK timeout
  from now, never beyond the window. An empty audience is complete as admitted and opens nothing. After `open`
  commits, the view it returns may already be complete (ACKs counted ahead), and is ended at once.
- **A re-sent copy that finds no head** opens it from the inbound admission row's audience, frozen as a first
  admission freezes it, with the message's own deadline, no never-sent recipient and the copy's snapshot version. It
  covers an admitting instance lost between its admission's commit and its `open`. An `open` that loses to another
  instance's is answered from `read`. The path cannot reopen an ended receipt: `read` comes first, `open` is fenced on
  the head's absence, and an expired head whose deadline was the message's own is refused `receipt-expired`.
- **A server publication** opens at its dequeue, first in the outbound runtime's `afterDequeueAdmission`, from the
  server's pending receipt row that the dequeue commit wrote: the row's expected recipients, snapshot version 0 and
  the message's trace, and no `admitted` receipt, since the server is the origin. Its deadline is the end of the row's
  retransmission budget less half an ACK window, `deadlineAtMs + timeoutMs × (maxAttempts − attempts) −
  floor(timeoutMs / 2)`, never beyond the message's own expiry or the window: a group-state delta's head is due 7 s
  after its first dequeue, its row's budget at about 8 s. A head the dequeue did not open (the store failed, or the
  instance was lost after the dequeue commit) opens at the row's next `ack-timeout` window, which also counts
  `outside` the recipients the row places outside that the record holds no row for, ends a complete open head, and
  narrows the retransmission to the recipients the record has not answered.
- **An outside recipient.** A recipient the server sent nothing, on its own rows as on a client's, is one `outside`
  confirmation counted as an ACK, on the instance that dropped it; nothing is handed to another instance. A
  session's outside-audience NACK of a server publication that the server's row admits is also one `outside`
  confirmation.

An ACK that finds no head is proven before it is counted ahead: a client send's against the inbound admission row
(the message under that origin, with the ACK's sender in the audience admission ran under), an ACK of a server
publication against the server's pending row, which an ended message's kept row does not prove. The server's own
`not-sent` of a client's send needs no proof; of its own publication it is proven by that row as a session's ACK is,
so a drop at the first dequeue, which precedes the row, writes nothing.

An admission does not open a receipt whose largest terminal receipt (a `timed-out` naming every expected recipient
outside) the receipt control could not encode: `receipt-not-encodable`, a warning, no record and no receipt. With
recipient ids of 128 characters, 249 recipients open and 250 do not. The check is one encode, under 1 % of an
admission. The record's own `malformed-opening` is the backstop.

## What it costs

Every figure but the 11 is pinned by the test the table names, so a change that adds a statement or a transaction
shows there; the 11 is that 17 less the worker's two lease sweeps. Round trips count BEGIN and COMMIT; none of the
ACK's statements is serialized against another ACK.

| Path                                                                    | Round trips | Pinned in                                                                     |
| ----------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| An ACK that finds its head and does not complete the set, on the record | 5           | `packages/tests/shared-server/integration/postgres/al-receipt-record.test.ts` |
| A client's such ACK through the WS server                               | 8           | `.../postgres/ws-receipt-record-cluster.test.ts`                              |
| A session's such ACK of a server publication                            | 5           | `.../postgres/ws-own-publication-receipt.test.ts`                             |
| A receipted server publication's dequeue, its receipt's share           | 11, 17      | `.../postgres/ws-own-publication-receipt.test.ts`                             |
| A receipt control's enqueue, and its dequeue: the write transaction     | 4, 5        | `.../postgres/ws-receipt-record-cluster.test.ts`                              |

- The record's ACK is one autocommit read of the head and the confirmation key, the insert in one transaction, and
  one autocommit prefix read of the confirmations.
- A client's ACK through the server adds the refusal hook's head and prefix reads (2) and the inbound runtime's
  control-owner read (1). A session's ACK of a server publication reaches neither: the inbound authorization admits a
  control addressed to its own receiver before the hook, and the origin bypass skips the control-owner read.
- A server publication's dequeue adds 11 round trips in the steady state, none on the server's version row: the
  pending-row read on the outbound store's client (1); on the record's client the `open` (7: the head and its deadline
  work row read, both written in one transaction, the view's confirmations read) and the worker's one claim (3). The
  worker's first batch of each 10 s lease adds its two lease sweeps, each in its own transaction (6); the test pins
  that first batch, 17 in all, and `al-work-queue-port.test.ts` pins one sweep of each kind per lease.
- The publication's own version row moves once from the settled dequeue to the end, for 10 sessions and for 50: the
  terminal receipt's admission into the server's row. The server's sender version does not move.
- A receipt control's enqueue writes in one transaction the guarded batch on the control's own version row and its
  work row; its dequeue writes the guarded batch, the hold of the claimed row and the work row. Neither names the
  server's version row: a receipt control's message has no ordering and its plan no supersedence, so its commits
  fence on its own version alone. Its decision still reads the server's version, in the autocommit statement of its
  first turn, which reads its own version row in the same statement.
- `acceptServerReceipt`, the settle of the server's own pending row, fences on the room message's own version row
  alone: only an `admitted` receipt of a tracked message on a pair that shares an ordering head, a browser's, fences
  its sender, and the server's pairs share none.
- A completed receipt's deadline row stays: `end` writes the ended work and leaves the deadline row, so the worker
  claims it at the deadline for one `end` that answers `conflict`, and one head read that finds the head ended.

## Measured

Real PostgreSQL, three instances, each client delaying every statement, BEGIN and COMMIT by the added latency
(one attributed hosted run recorded about 5 ms per statement). Lag is p50 from a message's last ACK to its
`complete`. Test-only code, not kept in the tree. Every cell but the last two bullets' sends unordered receipted
messages, as a browser's room send is unless it states an `orderingKey` or a `seq`; the sends of those two bullets
each state one, so they take the ordered inbound path.

- **The record alone keeps up.** 40 messages at 2 a second, 14 recipients each, 28 ACKs a second: at +0 ms a p50 of
  5.6 to 9.0 ms, at +5 ms 60.5 to 62.8 ms, the last ten messages no slower than the first ten; 560 of 560
  confirmations, every head complete, one `end` winner per message, in three runs of each.
- **Through the WS server, one publisher keeps up**: the same 40 messages from one client session among 15 on three
  instances, in the first measurement about 31 ms at +0 ms and about 450 ms at +5 ms, with no trend across the run.
  **Five publishers keep up at +0 ms** (200 messages, 140 ACKs a second; about 23 ms in the first measurement).
- **Five publishers of unordered sends keep up at +5 ms.** Five client sessions, on instances a, b, c, a and b, each
  send at 2 Hz for 20 s (200 messages, 140 ACKs a second). In each of three runs all 200 read `complete` before their
  deadline; over the last ten messages `admitted` reached its publisher 0.13 to 0.14 s after the send and `complete`
  0.42 to 0.47 s after the last ACK (p50), no slower than over the first ten; the publishers read 19.5 receipts a second
  of the 20.1 offered; no receipt enqueue was retained, no receipt commit conflicted, and a message cost 223 to 225
  statements. Sends kept up for 45 s read 450 of 450 at the same figures (0.13 s and 0.45 s over the last ten). With the
  server also publishing a receipted, sequenced room publication of its own every 500 ms on one instance, three runs
  read 200 of 200, and all 40 of the server's publications `complete` in each. One publisher at +0 and +5 ms and five at
  +0 ms keep up too: across every cell the last ten's p50 is 0.61 to 1.15 times the first ten's. The machine's 1-minute
  load was 1.0 to 3.7.
- **Before**, with every receipt commit fenced on the server's one sender-version row and `admitted` a durable row,
  the same five publishers on the same machine read 111 to 124 of 200 `complete` by the deadline and the last ten's
  `admitted` 18 to 19 s after the send, so a publisher saw a send end `failed` when no receipt arrived inside its
  first-hop budget of about 8 s, and else `expired` at its deadline, for a message every recipient confirmed.
- **The record stays exact.** No publisher's unordered room message, before or after, read `timed-out` or two
  terminal receipts. Of the server's own publications, the runs before ended 3 of 120 `timed-out`, 2 `complete` and
  never opened the rest; the runs after completed all 120.
- **Five publishers of ordered sends keep up at +5 ms when a message completes before its sender's next one.** The
  same five publishers, each message ordered on its publisher's own track and receipted. On a quiet machine, in three
  20 s runs all 200 complete by their deadline, and over 45 s all 450, with no send answered `pending-admission`, no
  message handed to the application twice and no frame read twice or out of order at recipients; recipients read a
  message 0.6 to 0.7 s after its send (p50, at most 1.2 s), and receipts are read at 19.3 to 19.4 of 20.1 a second
  (19.7 of 20.0 over 45 s). Before the server's inbound runtime looked again at once at an admission, a replay or a
  release whose write was lost, the same cell completed 154 to 174 of 200, with 26 to 32 sends parked
  `pending-admission` and recipients 7.1 to 21.0 s behind, and 131 of 450 over 45 s. Under load, with eight CPU
  burners beside the run (a 1-minute load of 6.6 to 10.2 at a run's start), all 200 complete in each of three runs,
  with no track ended, nothing handed twice and every track's hand-offs in order, at a read of 0.9 to 1.9 s (p50; the
  slowest 1.7 to 8.0 s), since the batch that completes a delivery now hands its track's next one on; the code before
  that completed 141, 145 and 200 and ended four tracks in each of the two runs that failed, its slowest read 24.0 to
  30.1 s. At +10 ms on a quiet machine all 200 complete in both runs at a read of 7.2 and 8.1 s (p50), against 75 and 70
  before. The stall was in the inbound ordered delivery on the server, not in the record; what remains of it is in
  `plans/backlog.md` ("What stays of the limit of one ordered track", D784, D785).
- **The ordered-send cell on the record.** The API's ordered-send measurement cell was run once with its instances
  counting in the record (one run); its README states that reading
  (`apps/api-v1/scripts/perf/alm-ordered-send/README.md`, "What a publisher hears of its own send").

## Stated limits

- **One ordered track.** This binds a send that asks for hop order, by stating an `orderingKey` or a `seq`. A
  browser's room send is unordered unless it states one, and a room channel declared `order: 'edge'` sends unordered
  messages that the receiving page puts back in its sender's order (`packages/shared-web/browser/README.md`, "Edge
  order"): neither enters the ordered inbound path. One ordered track through the WS server at +5 ms keeps up at 3
  messages a second in both runs. At 4 a second every message still completes (80 of 80 in both runs) but the track
  runs seconds behind, its last message read 5.8 and 6.4 s after its send. Only the first messages of a track that
  falls further behind complete, the rest passing their 30 s lifetime and ending `timed-out`. At 5 a second the track
  ends `resync-required`, a NACK to its sender, on the code with the hand-on and on the code before it: the hand-on
  completed 20 to 69 of 100 over four runs, the code before it 11 to 72 over eight. At 10 a second the sends parked at
  admission dominate: 4 and 0 of 200 completed, the track not ended. A track whose sender keeps its rate is handed on
  at most a page of 16 a batch, and its lag climbs while the rate holds (under load the worst of each of three runs
  was 1.3, 5.1 and 7.7 s); a lane whose batches are already full of other claimable work hands nothing on and behaves
  as before, a case no run covered. A stream faster than one track carries can use `order: 'edge'` instead, for the
  sends that option takes (whole-room, receipted, at-least-once, volatile).
- **A batch past its lease.** A claim's work row stays reserved until its batch ends, so a batch that runs longer than
  its 10 s lease lets another instance claim the rows it completed early: an ordered one reads `completed` and is not
  dispatched again, an unordered one is handed to the application a second time. At +10 ms a statement most batches
  ran at the page (21 of the 33 inbound drains of the two runs held 16 claims; the five longest of each run took 7.3
  to 8.0 s); none was seen to pass its lease. Nothing bounds the age of a batch that hands on.
- **What an over-driven ordered track costs unordered publishers.** One track at 5 a second beside five unordered
  publishers on the same server left the unordered publishers complete (200 of 200 in both runs, receipts at 19.3 to
  19.4 a second) but read a message at 0.715 and 0.862 s (p50) against 0.454 s without the track, at most 1.63 and
  2.83 s against 1.06 s: the track's batches ran at the page (16 claims) for 6.0 and 6.1 s, and a message arriving on
  that lane waits for the batch.
- **The sender's version still moves.** A message end through the message-end bundle (a spent repair budget, a
  re-plan refused for good, a receipt control's included) and each ACK window fence the sender, so a server
  publication's own receipt windows keep competing for the server's version row.
- **The terminal receipt stays on the outbound worker.** It keeps its two commits there, its enqueue and its dequeue,
  each fenced on its own control's version.
- **No first-hop wait.** A send with no first-hop wait (retry `none`, or a kept send whose wait the server's
  `not-yet-in-sync` NACK ended) whose `admitted` frame is lost on the wire reads its terminal receipt alone.
- **A stall longer than half an ACK window, for a server publication.** When the record's end and its ended work
  together take longer than half a window (a stalled instance; a survivor that learns of the row only at its next
  readiness read, up to 3 s), the row's budget ends first and the process-local admin read says `receipt-exhausted`
  naming nobody confirmed for a publication some recipients confirmed. The record's head stays exact. Both levers
  change `alm/outbound`: stating the record's settlement when the row refuses the terminal receipt, or a pending row
  that says its receipt is counted elsewhere. Derived from the code; no test holds such a stall.
- **More than 256 recipients.** A send to more than 256 recipients is admitted and gets no receipt. A server
  publication whose opening the record or the codec refuses keeps the per-ACK fenced count in its row; the server's
  own `not-sent` for it writes nothing, so a recipient the server skipped stays expected in the row and keeps it open
  until its budget ends, and the publication reads `receipt-exhausted`. Its "was not opened" warning is written at
  the dequeue and again at each of the row's windows, since each tries the opening anew.
- **A receipt the control cannot carry** opens nothing (`receipt-not-encodable`, above), and a re-sent copy of it opens
  nothing either.
- **Stray confirmation rows.** A room member outside a send's frozen audience (a unicast's addressee, a broadcast's
  except or recipient list) can write one confirmation row per message, since an ACK that finds no head is proven
  against the raw audience admission ran under. An ACK that arrives after its head expired is proven by the admission
  row while that row lives, and writes one row no head reads. Neither is tallied: the tally counts only an open
  head's expected set. Each expires with the window plus one grace.
- **One server name per cluster**, since the namespace derives from it.
- **A burst of terminal receipts.** The ended work row of a `timed-out` end lives one grace (30 s): a burst of
  terminal receipts that one instance cannot deliver within that grace leaves rows that expire undelivered. At +5 ms
  three instances delivered five publishers' 10 terminal receipts a second with none retained; the rate at which an
  instance falls that far behind is not measured. The row is not extended: the origin accepts no terminal receipt past
  its own deadline plus the grace.
- **A crash between the last confirmation and `end`** leaves a complete set under an open head, and no further ACK
  comes. The deadline work ends it `complete`: exact, and late by at most the message's deadline.
- **A deadline pass that no instance runs within one grace** of the deadline ends nothing: the head and its deadline
  work expire together, and the receipt is lost with them.
- **A server publication with no retry window** (`maxAttempts` 0) whose dequeue did not open its head is never opened
  by a window: its ACKs are counted ahead and never read, and its row reads `receipt-exhausted`. The dequeue's own
  retry usually opens it. The same holds from the window on which the row exhausts, since only a window that still
  retries reaches the hook. A lost `end` that no window reaches waits for the deadline worker, and a failed dequeue
  attempt re-sends every copy, bounded by the outbound work's 20 attempts. Such a publication also has only half its
  ACK timeout to be confirmed: with `maxAttempts` 0 its head's deadline is `deadlineAtMs - floor(timeoutMs / 2)`. No
  production publisher of the server asks for no retry.
- **A re-sent copy** opens nothing for a message that names no deadline, one whose deadline lies beyond the window,
  one as old as the window by its own stamp, an admission row frozen to nobody, or a copy with no admission row. For a
  kept send whose replay left nobody to expect, the copy opens nothing and is answered nothing; this is reached only
  when the replay's instance also died before its `open`. Each leaves a send whose admission lost its `open` without
  a receipt. A copy's opening names its own snapshot version, since the version its audience was read at is not
  stored.

Not shown: the hosted statement latency itself (the runs were local, at +0, +5 and, for ordered sends, +10 ms);
latencies above +5 ms for unordered sends and above +10 ms for ordered ones; more than five publishers in a room, so the
rate at which the receipts stop keeping up; `main` in the five-publisher cell; group-state deltas themselves, which the
measurement stood in for with one sequenced publication every 500 ms, and a higher server publication rate; for ordered
sends, a lane whose pages are full of other claimable work, more than one over-driven track, an over-driven track on a
loaded host, and whether a batch at the page stays inside its 10 s lease beyond the 8.0 s measured at +10 ms; why one
ordered track at 3 a second kept up in three runs of four before the hand-on was built (it kept up in both runs since);
why one ordered track at 4 a second parks 6 to 13 sends at admission; why the WS server's room fan-out writes two
closely spaced hand-offs of one track out of order at a raw socket (14 frames in one loaded run; a Rallar receiver's
ordered delivery restores the order); across two server instances, the room fan-out leaving from the instance that
completed the predecessor, that instance's readiness read asking its own dispatch port, and an arrival's commit against
a completion's commit; a release handed on reading its slot a second time, on PostgreSQL; why recipients read room
frames twice on one track at 10 a second, with the inbound's fresh attempts and without them, though the subscriber was
handed each message once; any ordered cell in a browser, on IndexedDB or over RTC; whether a sender's resend unblocks
a stalled track (the harness resends nothing); the recovery of a lost live `admitted` by the
first-hop resend under load or across instances (it is pinned with one origin and one server); the sustained cost of an
ACK that finds no head; how a cluster resolves a group leader (the group-leader case pins the cross-instance count); a
survivor taking over a work row whose lease a killed process held (a "lost" instance in the PostgreSQL cluster cases is
a disposed one; the black-box cluster recipe kills a process); the dequeue's and the ACK's latency under sustained load.

## Navigation probes

1. **An ACK counted.** `count` → `writeConfirmation`, one `backend.write`: the head and the confirmation key read
   together, `validateALReceiptRecordConfirmation`, then `isReplacedByConfirmation` and the confirmation `set` (no
   fence) → after the commit `readView` → `computeALReceiptRecordTally`. A lost write re-reads the key: a stored row is
   `repeated`. `countAhead` takes the same write with no head required, then `read`. The caller ends a complete open
   view with `end`.
2. **A receipt ended.** `end`, one `backend.write`: the head and the confirmations read together, `head-absent`, or a
   `conflict` thrown for an ended head, `computeALReceiptRecordTally`, `computeALReceiptRecordEnding` (`not-due`
   writes nothing) → `writeHead`: the head's `setFence`, then the ended work row (`computeALReceiptRecordWorkEntry`,
   due at the end). The deadline path enters at the worker's `runClaim` → `endAtDeadline` → `end`; the ended work at
   `runClaim` → `writeEnded` → `read` → the owner's `writeEndedReceipt`.

The WS server's own probes, from socket ingress to the outbox, are its README's "Navigation probes".

## Proof

- The record's contract on the memory backend and on PostgreSQL: concurrent confirmations; several instances ending
  one receipt, one commit; a deadline pass racing the last confirmation, one terminal phase; a repeated confirmation;
  an ACK before the head, counted by the `open` that follows; an ACK after the end, ignored; an ACK from outside the
  expected set, nothing written; expiry. `packages/tests/shared/alm/receipt-record/al-receipt-record-contract.ts`, run
  by `packages/tests/shared/alm/receipt-record/al-receipt-record.test.ts` and
  `packages/tests/shared-server/integration/postgres/al-receipt-record.test.ts`.
- Three instances over one PostgreSQL database: a send admitted on one and confirmed on two others completes; one
  whose admitting instance is disposed after `admitted` completes; the deadline work a survivor claims ends it
  `timed-out`; a re-sent copy after the end is answered with the terminal receipt; a send lost between its
  admission's commit and its `open` is opened from a re-sent copy; a group-leader ACK on another instance completes;
  a count that commits after the deadline end leaves the end as it is; the last two ACKs counted at once on two
  instances deliver one `complete`. `packages/tests/shared-server/integration/postgres/ws-receipt-record-cluster.test.ts`.
- A server publication: fifty sessions confirming at once complete the head, a retransmission inside the window
  reaches only the sessions that have not confirmed, and a survivor's window opens a head its lost instance never
  opened. `packages/tests/shared-server/integration/postgres/ws-own-publication-receipt.test.ts`; a failed dequeue
  hook retried, `packages/tests/shared/services/ws-queue-box-server-own-receipt.test.ts`.
- The cluster recipe `api-v1-cluster-publisher-instance-loss` kills the admitting server's process, and the
  publisher, reconnected to a survivor, reads `complete`; `api-v1-cluster-subscriber-instance-loss` keeps its
  `timed-out`, since the lost subscriber cannot confirm. Both under `packages/shared-test/black-box-runner/tests/api-v1/`,
  run in the cluster profile of `npm run test:api-v1:black-box:postgres`.
- The namespace's growth bound: `packages/tests/shared-test/alm-growth-proof/growth-surfaces.test.ts`.
- `apps/api-v1/test/composition/create-api-v1-runtime.test.ts` fails if the runtime stops counting in the shared repository's record; the
  middleware option `receiptRecordStores` is required.
