# The crash-surviving receipt

A sender's receipt on WebSocket stays exact when the server instance that admitted the send crashes or
restarts. The count of who confirmed a receipted room send moves out of one instance's memory into a
durable record every instance reads and writes.

Status: approved by the maintainer on 2026-11-22; slices 1 to 4 built.

## Why

On `main`, a receipted room send over WS (`ack: 'receiver'` or `'leader'`) is counted by
`WsQueueBoxServerReceiptAggregation`, in the memory of the instance that admitted it (D37). The receipts
themselves (`admitted`, `complete`, `timed-out`) are durable `WS_OUTBOX` rows, and the audience admission ran
under is in the inbound admission store every instance shares, but the count is not. So:

- When the admitting instance dies, the publisher, reconnected to a survivor, reads neither `complete` nor
  `timed-out` (`api-v1-cluster-publisher-instance-loss`, D700).
- A re-sent copy that reaches an instance with no live aggregate is answered nothing, so a send can end
  `failed` although it was delivered (D678).
- An ACK that lands on another instance is handed over by one best-effort NOTIFY notice; without that
  publisher, or when the notice is lost, the ACK counts nowhere (D106, D696).
- An ACK that arrives on another instance before the admitting one has recorded its aggregate is dropped
  (D696).
- The set is capped at 4 096 aggregates; the oldest is ended `timed-out` at the cap (D191).

Slice 2 removed all five losses: any instance counts an ACK in the record every instance shares, and the
publisher-loss recipe now reads `complete`.

The first hosted campaign's first fault stops one of three replicas for 30 s and passes only when every
receipt settles within 45 s. On `main` that run cannot pass.

## The maintainer's rulings (2026-11-22, each asked alone)

1. What the receipt must read after the admitting server dies: **"Exact receipt"**, over a truthful
   terminal receipt that forgets the ACKs counted before the crash.
2. How to build it, first: "Reuse the durable row", the `receiver` pending row of the server's outbound
   owner.
3. After the measurement below: **"Yes, the record"**, a fence-free record with one row per confirming
   recipient. This replaces ruling 2.
4. Whether the server's own receipted publications count in the record too: **"Yes, include them"**, over
   client sends only.
5. Whether a re-sent copy after the end is answered with the terminal receipt again: **"Yes, answer it"**,
   over staying silent.
6. Whether the record goes through AppInbox: **"One more ALM runtime store"**, written directly at WS
   ingress.

## What the measurement found

Real PostgreSQL, the existing stores, test-only code, a delay added to every database round trip to stand
in for hosted latency (one attributed hosted run recorded about 5 ms per statement). Machine load average
6 to 35 during the runs. Raw results are kept outside the tree until the pull request quotes them.

| Shape                                  | Added latency | Durable row, one fenced commit per ACK | Per-recipient record              |
| -------------------------------------- | ------------- | -------------------------------------- | --------------------------------- |
| 15 recipients at once, three instances | +2 ms         | 633 ms to complete                     | 26 ms                             |
| 15 recipients at once, three instances | +5 ms         | 1 319 ms                               | 24 ms                             |
| 40 messages, 14 ACKs each, 28 ACKs/s   | +0 ms         | not run in this shape                  | complete 3 ms after the last ACK  |
| 40 messages, 14 ACKs each, 28 ACKs/s   | +5 ms         | median 30 s per message (one run)      | complete 20 ms after the last ACK |

- The durable row makes about 15 round trips per ACK and its commits are fenced on the sender's version
  row, so they run one at a time per publisher and share that fence with the publisher's own sends. At
  +2 ms it manages about 24 ACKs per second, at +5 ms about 11. The campaign's first rung offers 28.
- The record was measured on the runtime-state repository directly: 2 autocommit round trips per ACK (one
  insert, one read of the head and the confirmations) and one more for an ACK that sees the set complete.
  Three runs of each cell: all 560 confirmations present, every head complete, exactly one winner per
  message, no backlog.
- Neither build lost an ACK.

The fence was designed for one browser counting its own ACKs. On a server many recipients confirm at once
from many sockets on many instances; a confirmation is idempotent and commutative, so it needs no fence.

The built record was measured again in the same sustained shape; see "Measured on the built record". The
built path was measured through the WS server with one and five publishers; see "Measured through the WS
server".

## Goals

- A receipted WS send's receipt is the same whether or not the instance that admitted it survives: any
  instance counts any ACK, any instance ends the receipt, any instance answers a re-sent copy.
- One implementation of the count, on memory stores and on PostgreSQL, for every receipt the WS server
  answers for: a client's send and the server's own publications.
- Counting an ACK takes no fence and no lock another ACK waits on, and its cost is pinned by a test.
- The memory aggregate, its cap, its deadline index and the cross-instance ACK notice are deleted.

## Non-goals

- A session whose server crashed staying in the room's presence, so that later receipts expect it (D669).
  It is the next piece of this lane, with its own design.
- The `rtc-with-ws-fallback` stall for a recipient the WS leg left out (D525). The piece after that.
- Receipts on RTC, where the origin browser counts its own ACKs.
- A memory-only deployment surviving a restart. It keeps nothing by construction.

## What would make this a failure even if it works

- Two places that count, where a change to one is forgotten in the other.
- A receipt that is exact but arrives only at the deadline in the ordinary, no-crash case.
- Rows that grow without a bound a gate reads.
- A statement of `complete` for a recipient that did not confirm, or two terminal receipts for one
  message, under any interleaving.

## Constraints

- No migration code and no legacy path: the memory count is deleted in the same pull request that adds the
  record. A cluster deploys all instances together, as D722 already requires.
- `packages/shared` stays free of PostgreSQL. The record is written against the port the AL runtime's
  stores already use, `ALAdmissionWorkBackend` (`packages/shared/alm/al-admission-work-backend.ts`): keyed
  rows with expiry, a prefix read, a write transaction with fences, and due work rows any instance claims.
  It has a memory implementation in `packages/shared` and a PostgreSQL one in `packages/shared-server`, so
  no new adapter is needed.
- The write rule of `convergent-service-writing.md` holds: the conditional guard is the first write, the
  state and the work it causes commit in one transaction, and nothing is repaired after a commit.
- `packages/shared/services/ws-queue-box-server` holds 22 production files. Two leave it
  (`ws-queue-box-server-receipt-deadline-index.ts`, `ws-queue-box-server-ack-relay.ts`) and none is added
  beside them: the record is its own feature folder, the aggregation file is rewritten in place, and the
  aggregation's pure translations go into the subfolder `receipt/` (slice 4, seven files).
- Expected failure is a value (`Either`). A lost fence is a typed conflict, never a throw that escapes.
- The files `packages/shared/alm/inbound/**` and `packages/shared/alm/outbound/control/**` are being
  rewritten by open pull requests #869 and #868. Slice 1 touches neither. Slice 2 makes two changes in
  `alm/inbound`: the refusal hook becomes asynchronous (section 3), and `al-inbound-work-entry.ts`, a file
  #868 changes, moves onto the shared `computeALWorkEntry`. It is built on this branch without waiting for
  #869 to merge.
- Decision rows D740 to D749 are reserved for this work.

## Design

### 1. The record

`ALReceiptRecord` (`packages/shared/alm/receipt-record/`) keeps its rows in the namespace
`<store namespace>:receipt:record` of the server's shared AL admission backend:

- **Head**, one per receipted message, key `<namespace>:receipt:<JSON [origin, msgId]>`: the frozen
  expected recipients, the snapshot version, the trace, the message deadline and the phase. While the
  phase is `open` the confirmation rows are the count. When it ends, the head takes the terminal phase
  (`complete` or `timed-out`) together with the confirmed and outside sets as they were read at that
  instant, in expected order and naming each recipient once; from then on the head alone is the receipt.
- **Confirmation**, one per answering recipient, key `<namespace>:receipt-ack:<JSON [origin, msgId]>:<recipient>`:
  whether the recipient confirmed or ended its hop outside the audience. An unfenced write; the first write
  wins, and a second ACK of the same recipient is a typed no-op (`repeated`) that writes nothing, with one
  exception: the owner's `not-sent` replaces a `confirmed` row of a recipient the head's opening
  names never sent, a row only an ACK written ahead of the head can have stored. A row is
  read back only under its exact key; a row under another key fails closed as corruption.
- **Deadline work**, one due row per receipted message in the backend's work queue, at the message
  deadline, written with the head.
- **Ended work**, one row per terminal receipt, due at the end, written by the transaction that ends the
  head.

A cluster's instances must share one server name: the record's namespace derives from it.

Its operations, each returning a value:

| Operation    | Does                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `open`       | One transaction: the head, fenced on its absence, and its deadline work                                                     |
| `count`      | Reads the head and validates; writes the confirmation; reads the confirmations                                              |
| `countAhead` | For an ACK that found no head: writes the confirmation, then reads the record and returns its view when a head has appeared |
| `end`        | One transaction, fenced on the open head: the terminal phase and sets derived from what it reads, and the ended work        |
| `read`       | The head, and the confirmations while it is open                                                                            |

`count` reads the confirmations only after its own write has committed. Of the last two confirmations,
whichever reads later sees both, so a completion cannot be missed. `end` takes no phase: it ends
`complete` when the set it reads is complete, `timed-out` once the deadline has passed, and is `not-due`
otherwise, writing nothing. `end` is fenced on the head it read: of several instances that try to end one
receipt, one commits and the others read a conflict. Within one head's life there is one terminal phase and
one terminal receipt per message, whatever the clocks of the instances say. Heads and confirmations expire on
the clock of the instance that reads them, and a write replaces such a row by its revision on that clock too.
On PostgreSQL, work rows come due and are swept on the database clock, and only a work row is taken as gone on
it: the deadline work row's conditional insert replaces an expired row that no sweep has deleted only once the
database clock (`now()`) has passed its `expire_ts`. A `count` that read an open head can commit after
another instance's `end`; its view may then say `open` for a receipt stored ended. Only `end`'s result is
authoritative.

The store bounds its own rows: `open` refuses a deadline beyond `now + window` and a receipt already past
its grace; the caller clamps.

### 2. Admission opens the record

Where `writeAdmittedReceipt` records an aggregate today, the server opens the record and writes the
`admitted` receipt as it does now. This holds for a send admitted at ingress and for a kept send admitted
by its replay (D697), with the same expected audience as today. An empty audience is complete as it is
admitted and opens no record, as today. After `open` commits, the server reads the confirmations once: an
ACK that overtook it (below) may already have completed the set.

The record refuses an identity a receipt control cannot carry: its stored-row decoders apply the control's own
identity limits, reused through `decodeALReceiptIdentifier`, so such an `open` answers `malformed-opening` and the
server writes no record and no receipt. The server's encode check below refuses such an opening first
(`receipt-not-encodable`); the record's refusal is its own backstop. Admission does not open a receipt whose
largest possible terminal receipt, a `timed-out` naming every expected recipient outside, the control codec could
not encode (refusal `receipt-not-encodable`, one warning, no receipt): with recipient ids of 128 characters, 249
recipients open and 250 do not. The check is one encode and costs under 1 % of an admission. The same check answers
the empty-audience branch, so a message whose id is too long for any receipt is admitted and answered nothing.

A send to more than 256 recipients is admitted and gets no receipt: that is the record's audience limit.

### 3. Any instance counts an ACK

A recipient's ACK addressed to the origin is counted where it arrives:

1. The checks that need no store stay at ingress: the sender is the authenticated session, speaks for
   itself, and addresses the origin it names.
2. `count` reads the head and validates as the aggregate validates today: the head is `open`, the
   recipient is expected, the deadline has not passed. An ACK that fails is refused with the same typed
   rejection and writes nothing, so a session can write at most one row per message that expects it.
3. `count` writes the confirmation and reads the confirmations.
4. When every expected recipient is confirmed or outside and one confirmed, the instance calls `end`.

A confirmation written by an ACK that passed step 2 just before another instance ended the head is
ignored: after the end, the head's own sets are the receipt.

An ACK that finds no head has either overtaken the admitting instance's `open` (D696's race) or names a
message whose receipt has expired. It is checked against the inbound admission row, which every instance
shares: the row must hold the message under the origin the ACK names with the ACK's sender in the raw
audience that admission ran under, not the frozen audience (`readIngressAudience`: the volatile store first, then
the durable one). An ACK that passes writes its confirmation and then reads the
record (`countAhead`): when a head has appeared since its first read, it returns the view, so an `open`
that committed between the two cannot leave a complete set unseen; otherwise the `open` that follows
counts it. One that fails is refused. An ACK never opens a head. Its limit, for every send: a room member outside a
send's frozen audience (a unicast's addressee, a broadcast's except or recipient list) can write one confirmation row
per message, which the tally ignores, since it counts only the expected set, and which expires with the record's
window plus one grace.

The refusal was the synchronous hook `readRelayedAckRejection` in `alm/inbound`, read against the memory
aggregate. With the record it awaits a store read, so the hook is asynchronous; it keeps its name. That is
one of two changes this work makes in `alm/inbound`; the other moves `al-inbound-work-entry.ts`, which open
pull request #868 changes, onto `computeALWorkEntry`.

The server's own ACK for a recipient it sent nothing (`writeServerAck` on `main`, the track order's
`writeOutsideAudience` here) becomes a `count` of an `outside` confirmation on the instance that dropped the
recipient. Nothing is handed to another instance.

The inbound authority no longer keeps a control message for admission while its room view is behind. This is a
change of the authorizer contract; the production authorizer authorizes every control, so no ACK took that path
there.

### 4. Ending a receipt

`end` commits, in one transaction and guard first: the fence on the open head, the head's terminal phase
and sets, and one ended work row. The work row is claimed by any instance and, for a client's send, does what
`writeReceipt` does today: it enqueues the receipt control as a durable `WS_OUTBOX` row for the origin, under a
control id derived from the origin and the message id, so a work row that is claimed twice enqueues one receipt;
then `acceptServerReceipt` settles the server's own pending row on an `outbox` topic (D38) with it. A server
publication's ended work enqueues nothing and admits the receipt into the server's row (section 7). The
`admitted` receipt is enqueued at admission, as today.

"Exactly one terminal receipt" means one stored head with one terminal phase. The outbox may deliver that receipt
more than once, under the same control id, until the origin acknowledges it: the receipt row's republication,
existing outbound behaviour that this work does not change.

A crash after the last confirmation is written and before `end` commits leaves a complete set under an
open head, and no further ACK will come. The deadline work ends it `complete`. The receipt is exact and
late, by at most the message's deadline.

The stated limits of the design:

- The crash between the last confirmation and `end`, above: the receipt is exact, and late.
- A deadline pass that no instance runs within one grace of the deadline ends nothing: the head and its
  deadline work expire together, and the receipt is lost with them.
- The limits of the re-sent-copy path in section 6.

### 5. The deadline is durable work

The per-instance deadline index and sweep go. `open` writes the deadline work with the head, in one
transaction, so no head is without one. When it comes due, whichever instance claims it calls `end`:
`timed-out` naming the recipients confirmed so far, or `complete` when the set is complete (the crash case
above). A head already ended reads a conflict and nothing is written.

The record's worker, `ALReceiptRecordWorker`, rides the engine the WS server already runs: lease 10 s; it
claims a page of 16 and runs the claims one at a time. The aggregation tells it of each `open` and `end` it
commits; a survivor learns of another instance's row at its next readiness read, within 3 s.

- _A deadline row the queue calls due before the record does._ The queue's due check may read another clock than
  the record; PostgreSQL's reads the database's. `end` then answers `not-due`, and the worker releases the row to
  wait what the instance still lacks, never less than 250 ms, with no attempt spent. A `timed-out` receipt can so
  be up to 250 ms late on an instance whose clock runs behind the queue's.
- _Stated limit: a burst of terminal receipts._ At +5 ms one instance delivers about 8 terminal receipts a second,
  and the ended work row of a `timed-out` end lives one grace (30 s). A burst above about 240 terminal receipts on
  one instance within that grace leaves rows that expire undelivered. The row is not extended: the origin accepts
  no terminal receipt past its own deadline plus the grace, so a longer-lived row would deliver nothing useful.

### 6. A re-sent copy is answered from the record

A copy accepted `duplicate` or `pending-admission` is answered from `read`, on any instance, to that
sender alone and under a fresh control id, as today: `admitted` with the confirmations so far while the
head is `open`, and the terminal receipt, from the head's own sets, once it has ended (ruling 5). The
second half is new: today nothing is answered after the end, which is how a send whose `complete` was lost
ends `failed` although delivered.

A re-sent copy that finds no head opens the record from the inbound admission row's audience, frozen as a first
admission freezes it, and is answered `admitted`. It covers the window between the admission commit
and `open`, in which the admitting server can die. Its limits: a message that names no deadline, a message
whose deadline lies beyond the record's window, and an admission row frozen to nobody open nothing on this
path; nor does a copy of a message already as old as the window by its own timestamp.

The opening is built from durable facts and the copy in hand. The expected recipients are the admission row's
audience, frozen as a first admission freezes it; the deadline is the message's own; no recipient is recorded never
sent; the snapshot version is the copy's own, because the version the audience was read at is not stored, so the
receipt may name a later version than its audience was read at. The ACKs that arrived meanwhile were counted ahead,
so this `open` reads them and may complete the set at once. An `open` that loses to another instance's `open` is
answered from `read`. The path cannot reopen an ended receipt: the `read` that comes first finds an ended head,
`open` is fenced on the head's absence, an expired head whose deadline was the message's own is refused by the
opening validator as `receipt-expired`, and a head the window clamped is covered by the limits above. For a kept
send its replay admitted, the row holds the replay's source audience, so the copy expects what the replay's own
`open` would have. When that replay left nobody to expect, the copy opens nothing and is answered nothing; this is
reached only when the replay's instance also died before its `open`. Each of these limits leaves a send whose
admission lost its `open` without a receipt.

The ended work delivers every copy of the terminal receipt under one control id derived from the message
(`toWsQueueBoxServerEndedReceiptControlId`), so every delivery of the ended work is the same control. A re-sent
copy after the end is answered with the same phase and sets under a fresh control id, as above. A re-sent copy
whose receipt could not be encoded (section 2) opens nothing.

### 7. The server's own receipted publications

The server's own receipted publications, of which the group-state delta is the production one, count in
the record too (ruling 4). Before slice 4 their ACKs, addressed to the server, were admitted into the server's
fenced `receiver` pending row, every one a commit on the server's one version row. As built in slice 4:

- **Where the head opens, and from what.** Not when the server enqueues: the delta and Relic's game
  notifications are producer rows that never pass the service at enqueue, and at enqueue an awaited route
  expects nobody. The head opens at the dequeue admission, first in `afterDequeueAdmission`, for a message
  the server sent whose ACK mode is logical, under the server's peer id as origin. It opens from the
  server's pending receipt row (`readPendingAck`), which the dequeue commit writes before any copy is
  sent: the row's expected recipients (the dequeue's judged audience), no recipient recorded never sent,
  snapshot version 0 (a producer's audience carries none), and the message's trace. Not from the policy
  the dequeue hands the hook: a sent message keeps its first dispatch's policy, which for everything sent
  through `enqueueOutboxIfAbsent` expects nobody. The opening writes no `admitted` receipt, since the
  server is the origin. A record failure in the hook propagates after the hook has published this
  attempt's cluster copies; the outbound work then dequeues the row again, which sends every copy again and
  rewrites the pending row with its attempts reset.
- **Its deadline.** The end of the row's retransmission budget less half an ACK window, in the row's own
  terms: `deadlineAtMs + timeoutMs × (maxAttempts − attempts) − floor(timeoutMs / 2)`, never beyond the
  message's own expiry or the record's window. A delta's head so ends 7 s after its first dequeue; its row's
  budget ends at about 8 s. The row keeps a terminator of its own: at the end of its budget it ends the
  message, states `receipt-exhausted` from sets that no longer learn of confirmations, and refuses a terminal
  receipt that arrives afterwards. Half a window is the time the record has to end the receipt and settle the
  row first.
- **The routing of an ACK addressed to the server.** A session's ACK of a server publication reaches no refusal
  hook (the inbound authorization admits a control addressed to its own receiver before the hook) and no inbound
  control-owner read (the origin bypass, which needs the ACK to name the server as its origin). One that names
  another origin goes to the server's outbound owner, as before. The server's
  own `not-sent` is counted, and counted ahead unproven when it finds no head: without a cluster publisher a
  send-time skip can overtake the head. A session's ACK is counted (`count`), and the receipt is ended when
  the view is complete.
- **The proof by the pending row.** A session's ACK that finds no head has overtaken it, or its dequeue did not
  open it: without a cluster publisher the copies leave with the dequeue commit, before the hook runs. It is
  proven by the server's pending row. When that row's opening would open (the record's opening validator and the
  receipt control's encodability check, called on the opening the row gives), the ACK is counted ahead if the row
  expects its sender and refused, writing nothing, if not. With no logically receipted row (a `hop` receipt, a
  live-only send, a row already complete), the ACK goes to the outbound owner as before: a `hop` row counts it
  there, and with no row at all the owner refuses it and writes nothing. A row whose opening would not open (more
  than 256 expected sessions, or a receipt the control cannot carry) keeps the per-ACK fenced count in the row:
  the ACK goes to the outbound owner, which counts it there.
- **The head opened at the next window.** A head the dequeue did not open (the record store failed, or the
  instance was lost between the dequeue commit and the `open`) opens at the row's next `ack-timeout` window.
  The retry hook reads the record at every `ack-timeout` window of a logically receipted row; when it finds no
  head of a server publication it opens one from the pending row, and that `open` tallies what was counted
  ahead. At a window that finds the head, it first counts `outside` every recipient the row places outside that
  the record holds no row for. At every window it then ends an open head whose view is complete and plans
  nothing, and otherwise narrows the retransmission to the recipients the record has not answered. An ended head,
  or one past its deadline, plans no retransmission.
- **A recipient the server sent nothing**, on its own rows as on a client's, is one `outside` confirmation in
  the record, written through the aggregation's count. The fenced `commitOutsideAudience` on the pending row,
  with its three tries and its diagnostic, is gone (section 9). A session's outside-audience NACK that the
  row admits is also one `outside` confirmation, proven by the row naming that recipient outside: a
  `before-entry` NACK has no hop-end ACK behind it, so without it the receipt would wait for its deadline.
- **What the ended work does.** It has no origin to answer. It builds the terminal receipt control under the
  control id every ended work's delivery derives, admits it into the server's pending row
  (`acceptServerReceipt`), enqueues nothing and writes no `receipt-outbox` observation. A row the store could
  not reach (`storage-unavailable`) throws, so the work retries. That admission states the settlement the
  admin read shows.
- **The admin read learns at the end.** It learns of a server publication's receipt when the receipt ends,
  not after each ACK. A publication everyone confirms reads `acknowledgement` within milliseconds of its last
  ACK; one somebody never confirms reads it at its deadline, ended `timed-out` rather than
  `receipt-exhausted`, with `receiptExhausted: false` and the unconfirmed recipients named.

The pending row stays, on `outbox` topics for a client's send (D38) and for the server's own rows, as the
record of what is still to be retransmitted. It no longer learns of a confirmation until the receipt ends,
so the WS server's repair plan leaves out the recipients the record has answered. A retransmission then
reaches the recipients that have not confirmed, as it does today.

Its stated limits:

- _A stall longer than half an ACK window._ When the record's end and its ended work together take longer
  than half a window (a stalled instance; a survivor that learns of the row only at its next readiness read,
  up to 3 s), the row's budget ends first and the process-local admin read says `receipt-exhausted` naming
  nobody confirmed for a publication some recipients confirmed. The record's head stays exact. Both levers
  change `alm/outbound`: the aggregation stating the record's settlement when the row refuses the terminal
  receipt, which duplicates the runtime's settlement stamping, or a pending row that says its receipt is
  counted elsewhere, a stored shape #869 is rewriting.
- _A refused opening._ A publication whose opening the record or the codec refuses keeps the per-ACK count in
  the row. `commitOutsideAudience` is gone, so the server's own `not-sent` for it is counted ahead in a record
  no head reads: a recipient the server skipped stays expected in the row and keeps it open until its budget
  ends, and the publication then reads `receipt-exhausted`.
- _No window._ A publication with no retry (`maxAttempts` 0) has no window, so a head its dequeue failed to
  open is never opened by one; its ACKs are counted ahead and never read, and its row reads
  `receipt-exhausted`. The dequeue's own retry usually opens it. The same holds from the window on which the
  row exhausts, since only a window that still retries reaches the hook.
- _A lost `end` no window reaches_ (after the budget's last hint, or a window that writes no hint) waits for
  the deadline worker. For a client's send the origin still receives the receipt, and the row may then refuse
  it.
- _A failed dequeue attempt re-sends every copy_, bounded by the outbound work's attempts (20).

### 8. The record under the mutation doctrine

A recipient's ACK over WS writes the record directly, guard first and in one transaction. It does not pass
through AppInbox. The record is one more AL runtime store (ruling 6), written at WS ingress as the AL
runtime's inbound and outbound stores are; D740 states it.

### 9. What is deleted

- The memory count, cap and sweep in `ws-queue-box-server-receipt-aggregation.ts`; what remains there is
  the translation from an admission or an ACK to the record's operations.
- The counting of ACKs in the server's own pending row, and `commitOutsideAudience` with its caller in
  `ws-queue-box-server-track-order.ts`. Built in slice 4: a server publication's ACKs count in the record,
  and only one whose opening is refused is still counted per ACK in the row (section 7). The track order
  lost its own-outside commit, its three tries and its diagnostics dependency; then `commitOutsideAudience`
  went with its declaration, implementation and result table in `al-outbound-admission-store.ts`, its
  translation `alm/outbound/control/to-al-outbound-outside-audience-commit.ts`, the `outside-audience-commit`
  outbound diagnostic kind, its test file `al-outbound-outside-audience-commit.test.ts`, the track order's
  cases of the fenced writer, and their six entries in `docs/test-structure-coupling-exceptions.md`.
- `ws-queue-box-server-receipt-deadline-index.ts`.
- `ws-queue-box-server-ack-relay.ts`, `relayed-ack-notice.ts`, `relayed-ack-notice-subscriber.ts`,
  `create-postgres-relayed-ack-notice-transport.ts`, their notice channel, the `ack-relay` observation
  kind and refusal owner, and the count observation's `source` and `relayPublisherId`.
- The tests of the cap, the sweep and the relay; the tests of receipt phases are restated on the record.

## Approaches considered

1. **Reuse the durable `receiver` pending row** (ruled first, then replaced). One owner for every receipt
   and machinery that passed the hosted cohorts. Measured: correct, and too slow at hosted latency, because
   every ACK is a fenced commit of about 15 round trips on the publisher's version row. Making it keep up
   needs batched reads and grouped ACK commits in the shared control admission, which browsers also run
   and #869 is rewriting.
2. **A per-recipient record** (chosen). No fence on the count, measured to keep up at +5 ms. Costs one row
   per confirming recipient with five index entries each, and a second durable place that knows about a
   receipt beside the D38 row.
3. **Checkpoint the memory count and let a survivor adopt it.** Dropped: it needs instance liveness and
   ownership transfer and still loses the ACKs inside the checkpoint window.

## Proof

- A contract test of the record on the memory backend and on PostgreSQL: concurrent confirmations; several
  instances ending one receipt, one commit; a deadline pass racing the last confirmation, one terminal
  phase; a repeated confirmation; an ACK before the head, counted by the `open` that follows; an ACK after
  the end, ignored; an ACK from outside the expected set, nothing written; expiry. Carried by
  `packages/tests/shared/alm/receipt-record/al-receipt-record-contract.ts`, run on memory by
  `packages/tests/shared/alm/receipt-record/al-receipt-record.test.ts` and on PostgreSQL by
  `packages/tests/shared-server/integration/postgres/al-receipt-record.test.ts`.
- PostgreSQL integration: a send admitted on one instance and confirmed on two others completes; the
  admitting instance is disposed after `admitted` and the receipt still completes; the deadline work is
  claimed by a survivor and ends the receipt `timed-out`; a send whose admitting instance is lost between its
  admission's commit and its `open` is opened from a re-sent copy on a survivor, from the admission row's
  audience. Carried by `packages/tests/shared-server/integration/postgres/ws-receipt-record-cluster.test.ts`.
- A statement pin of the ACK that finds its head and does not complete the set, as
  `ws-outbound-dispatch-statements.test.ts` pins its path. The built figure is five round trips: one
  autocommit read of the head and the confirmation key, the insert in one transaction (with BEGIN and
  COMMIT), and one autocommit prefix read of the confirmations, none of them serialized against another
  ACK. Carried by the record's own pin in the PostgreSQL `al-receipt-record.test.ts` (five round trips),
  `ws-receipt-record-cluster.test.ts` (eight, for a client's send through the WS server) and
  `ws-own-publication-receipt.test.ts` (five, for a server publication), all under
  `packages/tests/shared-server/integration/postgres/`.
- The sustained measurement above is repeated on the built path at +0 and +5 ms and must show no backlog;
  it is quoted in the pull request. Not met at five publishers and +5 ms: the receipts backlog in their delivery
  on the server's outbound identity ("Measured through the WS server"); one publisher at +0 and +5 ms (run 1 at
  the edge, 1.51) and five publishers at +0 ms show no backlog. Measured by test-only code, not kept in the tree:
  "Measured on the built record" runs the record alone, and "Measured through the WS server" the built path.
- The cluster recipe `api-v1-cluster-publisher-instance-loss` is restated in slice 2: the publisher,
  reconnected to a survivor, reads `complete` for the broadcast its lost server admitted.
  `api-v1-cluster-subscriber-instance-loss` keeps its `timed-out`, since the lost subscriber cannot
  confirm. Carried by both recipes under `packages/shared-test/black-box-runner/tests/api-v1/`, run in the
  cluster profile of `npm run test:api-v1:black-box:postgres`.
- The group-state delta's receipt: fifty sessions confirming at once complete it with no fenced commit per
  ACK, and a retransmission inside the window reaches only the sessions that have not confirmed. Carried by
  `packages/tests/shared-server/integration/postgres/ws-own-publication-receipt.test.ts`.
- The ALM growth proof classifies the record's namespace, carried by
  `packages/tests/shared-test/alm-growth-proof/growth-surfaces.test.ts`;
  `test:api-v1:black-box:postgres:medium-scale` and the ALM lane families over `ws` are green, carried by
  that command and by `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=ws npm run
  test:rallar:full-stack:memory:alm`.

## Slices

1. Built. The record on `ALAdmissionWorkBackend`, with its contract test on both backends, its statement
   pin, its growth-proof classification and its sustained measurement. It touches no file an open pull
   request changes.
2. Built. The WS server counts through the record: admission, ACK, the asynchronous refusal hook, terminal
   receipts, deadline work, re-sent copies; the memory count, cap and deadline index deleted, and the ACK relay
   class with them; the publisher-loss cluster recipe restated to read `complete`. Built on
   this branch without waiting for #869 to merge; #869's rules for the aggregation and the service are
   carried into the record-based code, so the later merge of `main` is textual.
3. Built. What was left of the ACK relay deleted: its notice, subscriber, transport, channel, observation kind,
   refusal owner and count source. The relay class itself left in slice 2, since it read the memory aggregate. The
   middleware option `keepsVolatileMessageInMemory` replaces the relay option as the switch that keeps a cluster's
   volatile messages in the shared store.
4. Built. The server's own receipted publications count in the record, opened at the dequeue admission
   from the server's pending receipt row; the repair plan reads the record's confirmations and opens a head
   the dequeue did not open; `commitOutsideAudience` deleted.
5. Proofs, recipes, documents: the backlog lines this closes removed, decision rows D740 onward, the
   outbound and WS server READMEs, the product description.

## Calls made here, each the maintainer's to overrule

- The record is its own feature folder under `packages/shared`, on the existing admission backend, in a
  namespace of its own that the growth proof classifies.
- The open head expires at the message deadline plus the receipt grace, as the origin's receipt row does,
  and a confirmation under it one grace later, so a deadline pass that reads a live head also reads its
  confirmations; an ended head expires one grace after the later of the deadline and the end.
- A confirmation written ahead, for a message with no head, lives `now + window + grace`. That is enough
  for a head opened within one grace of the ACK; a re-sent copy, which can open the head (section 6),
  arrives within the sender's first-hop budget of about 8 s. While the head is open the rows are the
  count, and a shorter expiry would end a receipt `timed-out` naming a recipient that confirmed.
- The tally of an open head ignores a confirmation counted at or after the head's deadline: a row written
  ahead passed no validator, and `count` would have refused it.
- Memory-mode servers use the same record on the memory backend; there is no separate memory count.
- The crash window in section 4 is closed by the deadline work, not by a nearer check.
- A terminal re-answer uses a fresh control id, as the `admitted` re-answer does; a client that already
  holds the terminal receipt refuses the second as it refuses any receipt for an ended message.
- One pull request, unless the plan shows two halves that each stand alone.
- An ACK meets the record in the refusal hook, which became asynchronous and takes a stage. At ingress it checks
  only what needs no store, that the ACK addresses the origin it names; in the inbound runtime it reads the record
  once and refuses with the record's own validator. The count stays in the control callback,
  `acceptControlMessage`, and validates again inside its write. An ACK costs about 8 round trips, none serialized
  against another ACK. Counting at `admitAuthorizedMessage`, so that the count's refusal is the answer and the hook
  is store-free again, stays only as the lever for the ACK's own cost: through the WS server the count kept up at
  five publishers and +5 ms (71 ms from the last ACK, flat); the backlog is in the receipts' delivery on the
  server's outbound identity, not in the count.
- An ACK's provenance is proven once, in the hook: with no head, the inbound admission row must hold the message
  under that origin with the ACK's sender in its audience (the volatile store's answer, and the durable store's
  when the volatile one has none). The count then answers a missing head with `countAhead` without a second proof.
  The server's own `not-sent` needs no proof.
- The ACK relay class left in slice 2, not slice 3: it read the memory aggregate, and none of those reads has a
  meaning on a record every instance shares. Slice 3 deletes what is then unreferenced.

## Left to the builder

- Whether the head is cached per instance to save its read on later ACKs (`packages/shared/cache`). Not
  needed in slice 1: the uncached ACK is five round trips and keeps up at +5 ms.
- Whether the admission backend gains a single-statement write for one unfenced row. Not needed in slice 1,
  for the same reason.
- Which existing tests are restated and which are deleted.

## Measured on the built record

`ALReceiptRecord` through `PSqlAdmissionWorkBackend` on real PostgreSQL: three instances on three clients
with pools of 10, each client delaying every statement and the BEGIN and COMMIT of every transaction by the
added latency. 40 messages opened at 2 a second, 14 recipients each, ACKs offered at 28 a second spread over
100 ms after each `open`, each ACK on the next instance in turn. Each ACK runs `count` and, when its view is
complete, `end`. Lag is from the moment a message's last ACK was offered to the moment its winning `end`
returned `complete`, in milliseconds as p50 / p95 / max; over ten messages, p95 is the maximum. Load is the
machine's 1-minute load average at the end of the run. Test-only code, not kept in the tree.

| Added latency | Run | Confirmations of 560 | Heads complete of 40 | `end` winners per message | Losing `end`s | Lag, all 40        | Lag, first 10      | Lag, last 10       | Load |
| ------------- | --- | -------------------- | -------------------- | ------------------------- | ------------- | ------------------ | ------------------ | ------------------ | ---- |
| +0 ms         | 1   | 560                  | 40                   | 1                         | 0             | 9.0 / 21.6 / 38.1  | 11.4 / 38.1 / 38.1 | 6.2 / 8.4 / 8.4    | 14.7 |
| +0 ms         | 2   | 560                  | 40                   | 1                         | 0             | 6.0 / 10.0 / 12.6  | 8.3 / 12.6 / 12.6  | 5.4 / 7.4 / 7.4    | 11.8 |
| +0 ms         | 3   | 560                  | 40                   | 1                         | 0             | 5.6 / 8.5 / 18.2   | 5.7 / 18.2 / 18.2  | 5.6 / 6.1 / 6.1    | 9.3  |
| +5 ms         | 1   | 560                  | 40                   | 1                         | 39            | 60.5 / 65.1 / 82.3 | 58.2 / 82.3 / 82.3 | 61.2 / 61.8 / 61.8 | 7.6  |
| +5 ms         | 2   | 560                  | 40                   | 1                         | 34            | 62.8 / 72.0 / 80.3 | 64.0 / 72.3 / 72.3 | 59.9 / 71.6 / 71.6 | 6.3  |
| +5 ms         | 3   | 560                  | 40                   | 1                         | 37            | 61.8 / 68.3 / 72.0 | 62.0 / 68.9 / 68.9 | 60.5 / 72.0 / 72.0 | 6.5  |

- No backlog: at +5 ms the last ten messages complete as fast as the first ten, and no message completes
  later than 83 ms after its last ACK. No ACK was refused and none conflicted.
- At +5 ms the lag is the last ACK's `count` (five round trips) followed by its `end` (one transaction).
- At +5 ms the last two ACKs of most messages overlap: both read a complete set and both call `end`; one
  commits, and the other reads a conflict and writes nothing. At +0 ms they do not overlap.

## Measured through the WS server

Three WS server instances over one PostgreSQL database, built as `ws-receipt-record-cluster.test.ts`
builds them, each on its own client of pool 10 whose every statement, BEGIN and COMMIT is delayed by the
added latency. Fifteen sessions in one room, five on each instance; each publisher is one of them, a client
session. One publisher sends at 2 Hz for 20 s (40 messages, 14 ACKs each: 28 ACKs and 4 receipt enqueues a
second); five publishers, on instances a, b, c, a and b, send at 2 Hz each (200 messages: 140 ACKs and 20
receipt enqueues a second). A message lives 30 s. Each recipient offers its ACK on its own instance, spread
over 100 ms after its session reads the message. Lags are in milliseconds as p50 / p95 / max: from a
publisher's send to its `admitted` read, and from a message's last ACK offered to its `complete` read on the
publisher's socket; over ten messages, p95 is the maximum. The ratio is the last ten messages' `complete`
p50 over the first ten's. Load is the machine's 1-minute load average at the start and end of the run.
Test-only code, not kept in the tree. The shape departs from production in two ways, both understating
contention: the added delay holds no connection outside a transaction (an autocommit statement's and a BEGIN's
delay run before the connection is taken, a COMMIT's after it is released), and the bus between the instances is
in memory and not delayed.

| Cell            | Added latency | Run | Complete / timed-out / unanswered | Send to `admitted`, all  | first 10              | last 10                  | Last ACK to `complete`, all | first 10              | last 10                  | Ratio | Load      |
| --------------- | ------------- | --- | --------------------------------- | ------------------------ | --------------------- | ------------------------ | --------------------------- | --------------------- | ------------------------ | ----- | --------- |
| One publisher   | +0 ms         | 1   | 40 / 0 / 0                        | 54.5 / 67.5 / 96.1       | 58.2 / 96.1 / 96.1    | 51.5 / 58.5 / 58.5       | 31.6 / 41.0 / 44.0          | 34.5 / 44.0 / 44.0    | 27.1 / 35.3 / 35.3       | 0.79  | 1.8 / 1.6 |
| One publisher   | +0 ms         | 2   | 40 / 0 / 0                        | 53.5 / 62.4 / 69.0       | 53.9 / 69.0 / 69.0    | 48.6 / 62.4 / 62.4       | 31.1 / 39.7 / 49.6          | 31.5 / 36.2 / 36.2    | 30.8 / 39.7 / 39.7       | 0.98  | 1.6 / 1.6 |
| One publisher   | +0 ms         | 3   | 40 / 0 / 0                        | 51.3 / 57.9 / 58.6       | 51.3 / 57.1 / 57.1    | 50.5 / 58.6 / 58.6       | 31.8 / 38.4 / 38.8          | 31.8 / 38.7 / 38.7    | 30.9 / 38.4 / 38.4       | 0.97  | 1.6 / 2.1 |
| One publisher   | +5 ms         | 1   | 40 / 0 / 0                        | 458.8 / 613.0 / 739.8    | 465.8 / 613.0 / 613.0 | 420.0 / 597.0 / 597.0    | 449.7 / 625.1 / 676.7       | 347.0 / 625.1 / 625.1 | 524.6 / 676.7 / 676.7    | 1.51  | 2.1 / 1.9 |
| One publisher   | +5 ms         | 2   | 40 / 0 / 0                        | 444.7 / 637.0 / 743.5    | 444.7 / 722.7 / 722.7 | 372.0 / 497.9 / 497.9    | 469.2 / 699.4 / 991.8       | 460.3 / 789.6 / 789.6 | 397.4 / 642.5 / 642.5    | 0.86  | 1.9 / 1.6 |
| One publisher   | +5 ms         | 3   | 40 / 0 / 0                        | 430.4 / 590.3 / 708.1    | 448.1 / 590.3 / 590.3 | 370.0 / 503.8 / 503.8    | 424.8 / 629.1 / 745.5       | 453.1 / 745.5 / 745.5 | 424.8 / 579.5 / 579.5    | 0.94  | 1.6 / 1.9 |
| Five publishers | +0 ms         | 1   | 200 / 0 / 0                       | 31.7 / 40.8 / 58.9       | 35.4 / 58.9 / 58.9    | 29.6 / 41.4 / 41.4       | 23.0 / 30.2 / 37.3          | 22.6 / 34.9 / 34.9    | 22.1 / 29.3 / 29.3       | 0.98  | 1.9 / 2.5 |
| Five publishers | +0 ms         | 2   | 200 / 0 / 0                       | 29.8 / 37.6 / 52.9       | 34.3 / 52.9 / 52.9    | 29.4 / 31.1 / 31.1       | 22.5 / 30.2 / 45.6          | 21.6 / 30.1 / 30.1    | 22.7 / 30.2 / 30.2       | 1.05  | 2.5 / 1.8 |
| Five publishers | +0 ms         | 3   | 200 / 0 / 0                       | 30.0 / 39.3 / 55.9       | 34.1 / 55.9 / 55.9    | 29.6 / 40.2 / 40.2       | 22.9 / 30.5 / 41.3          | 21.5 / 33.0 / 33.0    | 22.6 / 24.3 / 24.3       | 1.05  | 1.8 / 1.6 |
| Five publishers | +5 ms         | 1   | 200 / 0 / 0                       | 7 892 / 15 572 / 18 271  | 999.3 / 2 242 / 2 242 | 10 884 / 11 341 / 11 341 | 9 236 / 17 337 / 22 871     | 1 699 / 7 225 / 7 225 | 10 650 / 11 518 / 11 518 | 6.27  | 1.6 / 1.7 |
| Five publishers | +5 ms         | 2   | 200 / 0 / 0                       | 10 520 / 17 439 / 24 052 | 682.9 / 1 916 / 1 916 | 11 211 / 11 720 / 11 720 | 10 208 / 17 196 / 23 765    | 1 795 / 5 588 / 5 588 | 10 442 / 11 241 / 11 241 | 5.82  | 1.7 / 1.9 |
| Five publishers | +5 ms         | 3   | 200 / 0 / 0                       | 7 989 / 16 258 / 19 977  | 1 028 / 2 360 / 2 360 | 10 884 / 11 306 / 11 306 | 8 807 / 16 660 / 20 695     | 1 785 / 3 448 / 3 448 | 7 168 / 10 756 / 10 756  | 4.02  | 1.9 / 3.9 |

Receipt enqueues a second are the receipt outbox admissions attempted while the sends ran, and over the
whole run to the last attempt. `pending` is an enqueue that conflicted on the fence of the server's outbound
version row and was retained for its owner to replay. Undelivered is the number of messages whose terminal
receipt the publisher had not read when the sends stopped.

| Cell            | Added latency | Run | Receipt enqueues/s, sends / run | Enqueues `pending` | Undelivered at stop | Losing `end`s | Refusals | Load      |
| --------------- | ------------- | --- | ------------------------------- | ------------------ | ------------------- | ------------- | -------- | --------- |
| One publisher   | +0 ms         | 1   | 4.0 / 4.1                       | 0 of 80            | 1                   | 0             | 0        | 1.8 / 1.6 |
| One publisher   | +0 ms         | 2   | 4.0 / 4.1                       | 0 of 80            | 1                   | 0             | 0        | 1.6 / 1.6 |
| One publisher   | +0 ms         | 3   | 4.0 / 4.1                       | 0 of 80            | 1                   | 0             | 0        | 1.6 / 2.1 |
| One publisher   | +5 ms         | 1   | 3.9 / 3.9                       | 23 of 80           | 3                   | 37            | 0        | 2.1 / 1.9 |
| One publisher   | +5 ms         | 2   | 3.9 / 4.0                       | 27 of 80           | 3                   | 44            | 0        | 1.9 / 1.6 |
| One publisher   | +5 ms         | 3   | 3.9 / 3.9                       | 24 of 80           | 3                   | 34            | 0        | 1.6 / 1.9 |
| Five publishers | +0 ms         | 1   | 19.9 / 20.0                     | 0 of 400           | 2                   | 0             | 0        | 1.9 / 2.5 |
| Five publishers | +0 ms         | 2   | 19.9 / 20.0                     | 1 of 400           | 2                   | 0             | 0        | 2.5 / 1.8 |
| Five publishers | +0 ms         | 3   | 19.9 / 20.0                     | 0 of 400           | 2                   | 0             | 0        | 1.8 / 1.6 |
| Five publishers | +5 ms         | 1   | 18.4 / 14.1                     | 306 of 400         | 116                 | 191           | 0        | 1.6 / 1.7 |
| Five publishers | +5 ms         | 2   | 19.0 / 14.2                     | 298 of 400         | 117                 | 192           | 0        | 1.7 / 1.9 |
| Five publishers | +5 ms         | 3   | 18.5 / 14.2                     | 316 of 400         | 118                 | 183           | 0        | 1.9 / 3.9 |

- **Five publishers at +5 ms do not keep up.** The last ten messages read `complete` 4.0 to 6.3 times later
  than the first ten (p50 7 168 to 10 650 ms against 1 699 to 1 795 ms), their `admitted` 10.6 to 16.4
  times later, and 116 to 118 of 200 terminal receipts were still unread when the sends stopped. Every
  message still read `complete` before its deadline, the slowest 23 765 ms after its last ACK against a
  30 s lifetime; derived, not run: sends kept up for longer would end messages `timed-out`. No ACK was
  refused: each run counted all 2 800 ACKs offered, and each message reached its publisher as one terminal
  receipt.
- **One publisher at +5 ms keeps up in two runs of three.** Runs 2 and 3 meet the rule (0.86 and 0.94);
  run 1 misses it by 0.01 (1.51: last ten 524.6 against first ten 347.0) and shows no trend: the median of its
  first half is 442 ms against 464 ms for its second, its medians by quarter are 372, 495, 351 and 529 ms, and
  lag against message order correlates at r = 0.24. The series is bimodal, about 320 ms and 500 to 600 ms, and
  its first ten are the fastest ten of the cell's six (347.0 against 397.4 to 524.6). The receipts kept pace
  (3.9 enqueues a second of 4.1 offered) and 3 terminal receipts were unread at the stop. The lag is about
  450 ms where the record alone took 60 ms ("Measured on the built record"). One stage-timed run splits it:
  about 74 ms from the last ACK to a complete count, 170 ms for the `end` and its ended work to reach the
  receipt enqueue, and 227 ms from that enqueue to the publisher's read, 116 ms for an enqueue that did not
  conflict and 314 ms for one that conflicted on the fence (23 to 27 of 80 did) and waited for its replay.
- **At +0 ms both cells keep up**, ratios 0.79 to 1.05, every message `complete` within 50 ms of its last
  ACK, one enqueue in all retained `pending`.
- **Where the lag is.** Eight further runs at the same shape timed each stage. Five ran after the matrix: one
  each of one publisher at +0 and +5 ms and five publishers at +0 and +5 ms (load 2.2 to 2.5), and five
  publishers at +5 ms once more (load 7.5 to 4.6). Three more ran five publishers at +5 ms with the pool, the
  outbound commits and the outbound worker instrumented (load 0.7 to 1.6). At five publishers and +5 ms, over
  the five runs of that cell:
  - **The count keeps up.** A message's last ACK reached a complete count in 70 to 73 ms, first ten and last
    ten alike, and the `end` and its ended work reached the receipt enqueue 170 to 420 ms later (p50 173 to
    289 ms over the first ten, 285 to 418 ms over the last ten).
  - **The enqueue attempts did not grow.** Send to the `admitted` enqueue took about 205 ms (p50 189 to 211 ms
    over the first ten, 195 to 207 ms over the last ten).
  - **The growing term lies after the receipt enqueue, on the server's one outbound identity.** From the
    terminal enqueue to the publisher's read took 1.1 to 2.5 s over the first ten and 9.1 to 11.3 s over the
    last ten; the `admitted` receipt, which no ACK precedes, grew the same way (0.4 to 0.8 s, then 9.6 to
    12.0 s). 75 to 80 % of the receipt enqueues conflicted on the fence of the server's outbound version row
    (74 to 79 % in the matrix above). Those that did not conflict also waited: 6.9 to 8.7 s from their
    enqueue to the read over the last ten (p50, in six of seven groups; 2.3 s in the seventh, of three
    receipts). Publishers read 8.1 to 9.8 receipts a second while the sends ran, against 20 offered.
  - **The pool does not account for it.** In the instrumented runs a transaction waited 0.6 ms from its
    `begin` to its callback (the median per instance and second; at most 1.2 ms), an autocommit statement
    took 0.8 ms (at most 1.3 ms), and at most 8 or 9 of an instance's 10 connections were inside a
    transaction at once, flat across the run.
  - **The fence does not account for it.** In the instrumented runs a conflicted enqueue's replay committed at
    its first attempt in 85 to 88 % of cases (1.13 to 1.16 attempts each), a replay commit took about 28 ms
    early and late in the run, and the server's commit queue on an instance never waited more than 1 ms.
  - **The drain's serial throughput does.** In the instrumented runs each instance's one outbound worker ran
    its claims one at a time, a page of 16 per batch at 44 to 56 ms a claim, and 13 to 26 % of its claims
    were rescheduled. It found a full page in 17 to 24 of its 19 to 24 batches while the sends ran, and
    completed 13 to 17 rows a second while they ran and 11 to 17 after they stopped. Across the three
    instances receipt replays committed 9.2 to 10.0 a second and receipt dequeues 13.4 while the sends ran,
    and 12.2 to 12.4 and 13.6 to 13.9 after, until the queue was empty. A conflicted receipt waited for its
    replay 0.3 to 0.8 s over the first ten and 6.9 to 7.9 s over the last ten, then 1.9 to 3.3 s from its
    dequeue commit to the read. An unconflicted one, which has no replay, waited 0.2 to 0.9 s from its dequeue
    commit to the read over the first ten, and over the last ten 6.8 to 8.0 s in five of six groups of two to
    four receipts (1.9 s in the sixth). The fence adds a replay to the drain's work for each receipt that
    conflicted; every receipt waits in the drain.
  - **The room messages share the drain, not the identity.** Their commits are under their publishers'
    identities, none under the server's, but each instance's one outbound worker drains them beside the
    receipts. Send to the last ACK offered: p50 0.50 to 0.58 s over the first ten and 0.65 to 1.05 s over the
    last ten, p95 6.2 to 6.9 s and max 8.9 to 15.0 s over all 200, in the four runs that timed it.
- **The lever the numbers point at is the receipts' delivery, not the count:** take the receipts off the
  server's one outbound identity, its fence and its serial drain, for example by delivering them from the
  record's own work rows, so that a receipt no longer takes a fenced enqueue, a replay, a dequeue and a send,
  each a claim on the instance's one outbound worker. What that path itself sustains is not measured, and it
  would not bring the lag to the record alone's 60 ms: the `end` and its ended work (170 to 420 ms) stay. The
  count keeps up, so counting at `admitAuthorizedMessage`, a per-instance head cache or a single-statement
  unfenced write would shorten a lag that does not grow.
- At +5 ms the last ACKs of almost every message overlap: 183 to 192 losing `end`s for 200 messages at five
  publishers, 34 to 44 for 40 at one. No losing `end` delivered a second terminal receipt.

## Established in slice 1

- **Unfenced rows neither conflict nor wait.** Through `PSqlAdmissionWorkBackend`, 30 concurrent writes to
  distinct keys of one namespace from three backends committed with no conflict, and a write committed
  in 63 ms while another key's write was held uncommitted. No backend keeps a store-wide revision
  (`al-admission-unfenced-row-writes.test.ts`).
- **The cost of the record through the admission backend.** An ACK that finds its head and does not
  complete the set is five round trips, pinned; fifty confirmations of one message from three backends
  committed with no conflict, and of three instances ending it together one commit won
  (`al-receipt-record.test.ts`).
- **The record keeps up.** The sustained shape above shows no backlog at +0 and +5 ms ("Measured on the
  built record").
- **The namespace is bounded.** Growth surface 85, `ttl-within-run`, bound window plus two graces
  (1 860 000 ms) (`growth-surfaces.ts`, `growth-surfaces.test.ts`).
- **A terminal receipt reaches a reconnecting publisher.** The receipt row answers `not-ready` for a
  target connected nowhere, spends no attempt, and republishes on a wait doubling from 1 s to 30 s with a
  last publication 1 s before its expiry, so a publisher that reconnects within the deadline reads it
  (`findings/terminal-receipt-to-reconnecting-publisher.md`).
- **The receipt enqueue's cost.** It is 9 sequential round trips on the one version row
  `default-qbox-server` that every instance and every receipt shares; `acceptServerReceipt` fences on the
  origin's row, up to 13 round trips a try (`findings/server-receipt-enqueue-cost.md`).
- **Where the repair plan takes its recipients.** A retry resends to the unconfirmed recipients of the
  re-read pending row; the WS hook `planRepairMessage` can remove the record's confirmations from
  `request.failedPeerIds` (`findings/repair-plan-unconfirmed-recipients.md`).
- **The server's own receipted publications.** Three paths ask `receiver` (the group-state delta, Relic
  game notifications, the RallarAI room result publisher); the dequeue hooks of `createOutboundRuntime`
  are the one common place where the audience is known (`findings/server-receipted-publications.md`).
- **The refusal hook.** `readRelayedAckRejection` is declared once and called once, inside an already
  asynchronous read; its implementers are WS-server only (`findings/relayed-ack-rejection-hook.md`).

## Established in slice 2

- **The server's ACK costs 8 round trips.** An ACK that finds its head open and does not complete the set is
  pinned through the WS server: the hook's head and prefix reads (2), the inbound runtime's control-owner read
  (1), then the record's count (5) (`ws-receipt-record-cluster.test.ts`).
- **Any instance counts, ends and answers.** On PostgreSQL, three instances over one database: a receipt admitted
  on one and confirmed on two others completes; one whose admitting instance is disposed after `admitted`
  completes; the deadline work a survivor claims ends it `timed-out`; a re-sent copy after the end is answered
  with the terminal receipt; a send lost between its admission and its `open` is opened from a re-sent copy; a
  group-leader ACK on another instance completes; a count that commits after the deadline end leaves the end as
  it is; the last two ACKs counted at once on two instances deliver one `complete` and record no failure
  (`ws-receipt-record-cluster.test.ts`).
- **The publisher reads `complete` after its server is lost.** The cluster recipe
  `api-v1-cluster-publisher-instance-loss` kills the admitting server's process; the publisher, reconnected to a
  survivor, reads `complete` within 41 s.
- **Every composition counts in a shared record.** The middleware option `receiptRecordStores` is required;
  api-v1 passes the PostgreSQL stores (`create-p-sql-al-receipt-record-stores.ts`), and
  `create-api-v1-runtime.test.ts` fails if the runtime stops counting in the shared repository's record.

## Established in slice 4

- **The server's version row moves once per publication from the settled dequeue to the end.** On PostgreSQL,
  three instances and fifty sessions spread over them: ten sessions moved it once and fifty once, the terminal
  receipt's admission into the server's row; with the dequeue's own commit it moves twice. Before slice 4,
  derived from the code and not measured, it moved 51 times for a delta to 50 sessions, the dequeue's commit
  included: once per ACK, and once more per recipient the server sent nothing. Fifty sessions confirming at once
  complete the head, all fifty confirmed, one head row, the row ended (`ws-own-publication-receipt.test.ts`).
- **A server publication's ACK costs 5 round trips, none fenced.** An ACK that finds its head open and does not
  complete the set is `select`, `insert` in one transaction, `select`, against about 15 fenced round trips
  before (derived from the code, not measured). It is fewer than a client's ACK (8): a session's ACK of a server
  publication reaches no relayed-ACK hook and no control-owner read (the origin bypass). An instance's first
  inbound message also runs the inbound work handler's one bootstrap batch (a finalization sweep in its own
  transaction and a page read), which is not a per-ACK cost (`ws-own-publication-receipt.test.ts`).
- **A server publication's dequeue adds 11 round trips for its receipt, none on the server's version row.** The
  hook reads the server's pending receipt row once, on the outbound store's client (1 round trip; it reads no
  sent row). On the record's client the `open` reads the head and its deadline work row, writes both in one
  transaction and reads the view's confirmations (7 round trips with BEGIN and COMMIT), and the record worker's
  batch makes one claim in its own transaction (3), which finds the deadline row not yet due and reserves
  nothing. The record worker's first batch of each 10 s lease adds its two lease sweeps, a finalization sweep and
  a timeout sweep, each in its own transaction (6 round trips); the case pins the worker's first batch, so 17
  round trips in all, 16 of them on the record's client in four transactions and three autocommit reads, and
  the limit of one sweep of each kind per lease is pinned with a controlled clock (`al-work-queue-port.test.ts`).
  The hook's read follows the dispatch commit on the same client with no pause between them, so the case takes
  it while the `open` waits at its commit (`ws-own-publication-receipt.test.ts`).
- **A survivor's window opens a head its lost instance never opened.** An instance lost between the dequeue
  commit and the head's `open` (PostgreSQL rolled the `open` back; no copy left it): a survivor charged the row's
  window, opened the head from the pending row, retransmitted to its sessions, and the receipt completed on
  their confirmations. A retransmission inside the window reaches only the session that has not confirmed, and
  an instance disposed after its dequeue opened the head leaves the survivors to count and end it.
- **A failed dequeue hook is retried.** A throw in `afterDequeueAdmission` is retried by the outbound work port's
  backoff (up to 20 attempts), and each attempt dispatches the row again: new send effects, a second copy to every
  session without a cluster publisher, a pending row rewritten with its attempts at 0. So a record failure at the
  dequeue is usually healed by the next dequeue; the window heals it when the window comes first
  (`ws-queue-box-server-own-receipt.test.ts`).
- **A `before-entry` NACK comes alone.** A recipient below a frozen copy's position answers with the
  outside-audience NACK and no ACK, so the record counts it `outside` from the server's row; a `not-subscribed`
  recipient also ends its hop with the ACK `subtree-complete-not-subscribed`, which the record counts `outside`
  by itself.

## Not established

- The hosted statement latency itself: the latency at which five publishers stop keeping up lies between +0 and
  +5 ms and is not measured; hosted latency, from one attributed run, is about 5 ms ("Measured through the WS
  server").
- Where the room messages' fan-out tail comes from (p95 6.2 to 6.9 s at five publishers and +5 ms): they share
  each instance's one outbound worker with the receipts, not the server's identity, and no run timed their own
  claims in that worker's queue.
- More than five publishers in a room: not run, so whether the receipts keep up with ten publishers even at
  +0 ms is not shown.
- The sustained cost of an ACK that finds no head: the measurement through the WS server offers each ACK only
  after its recipient reads the message, and does not count how many found no head.
- Leader resolution in a cluster: the group-leader case pins the cross-instance count, not how the leader is
  resolved.
- A survivor taking over a work row whose lease a lost instance held: "lost" in the PostgreSQL cluster cases is a
  disposed instance, not a killed process. The black-box cluster recipe kills a process.
- The stall of section 7: no test holds an instance between a server publication's record end and its
  ended work for longer than half an ACK window, so the admin read's `receipt-exhausted` after such a stall is
  derived from the code, not shown.
- Slice 4's cost under sustained load. The state-write bench runs no slice-4 code: it drives AppInbox services
  directly, with no WS dequeue, no ACK and no record. In both of slice 4's candidate runs its uncontended
  transaction time sat 13 to 16 % above a baseline taken in another session, on code slice 4 did not change on
  its path. The dequeue's and the ACK's statements are pinned above; their latency under load is not measured.

## Decision rows drafted

Appended to `playground/alm/alm-improvement-plan.md` in slice 5.

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D740 | **The receipt record is one more ALM runtime store (the maintainer's ruling 6 of 2026-11-22).** A receipted WS send's count lives in `ALReceiptRecord`, its own feature folder `packages/shared/alm/receipt-record/`, on the shared AL admission backend (`ALAdmissionWorkBackend`) in the namespace `<store namespace>:receipt:record` (`toALReceiptRecordNamespace`; on api-v1 `server-ws-qbox:default-qbox-server:receipt:record`). A recipient's ACK writes it directly at WS ingress, guard first and in one transaction, as the AL runtime's inbound and outbound stores are written; it does not pass through AppInbox. The deadline and the end are work rows on the backend's own work queue, which any instance claims. No new adapter: the memory and PostgreSQL backends already implement the port. One shared file is added beside it, `packages/shared/alm/work/compute-al-work-entry.ts`, the work-entry envelope; the outbound and inbound builders move onto it in slice 2. Cost if wrong: the record would move behind AppInbox, one mutation command per ACK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D741 | **Unfenced rows on the admission backend: their cost and isolation, and which backends keep a revision (probe of slice 1).** Through `PSqlAdmissionWorkBackend`, 30 concurrent unfenced writes to distinct keys of one namespace, from three backends on three clients, committed with 0 conflicts; a write to another key committed in 63 ms while a first write's transaction was held open (`committed`, not `blocked`). One unfenced write is `[null, 1]`: the key read in autocommit and the conditional insert in one transaction, 4 round trips with BEGIN and COMMIT. No backend keeps a store-wide revision: IndexedDB observes the written key's own row (`indexed-db-admission-backend.ts`), memory serializes every write of one state and conflicts only on an observed work batch (`al-admission-backend.ts`), PostgreSQL keeps a revision per row. Two comments still say IndexedDB keeps a store-wide revision (`ALAdmissionBackendConflictError.ts`, `al-outbound-admission-fences.test.ts`); they are corrected when slice 2 touches the area. Pinned in `al-admission-unfenced-row-writes.test.ts`. Cost if wrong: the record's count would need a fence per ACK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D742 | **The receipt record's contract.** A head per receipted message at `<ns>:receipt:<JSON [origin, msgId]>` (`{ phase: 'open', opening }`, or `complete`/`timed-out` with `confirmedRecipientPeerIds` and `outsideAudienceRecipientPeerIds` in expected order, each recipient named once, and `endedAtEpochMs`), and a confirmation per answering recipient at `<ns>:receipt-ack:<JSON [origin, msgId]>:<recipient>` (`{ recipientPeerId, kind: 'confirmed' \| 'outside', countedAtEpochMs }`), read back only under its exact key; a row under another key fails closed as `ALAdmissionCorruptionError`. `open` stores the opening's named fields only. Expiry: the open head and the deadline work at `deadlineAtMs + 30 s`; a confirmation under a head at `deadlineAtMs + 60 s`, one grace after its head, so an `end` that reads a live head reads its confirmations; the ended head and the ended work at `max(deadlineAtMs, endedAtEpochMs) + 30 s`; a confirmation written with no head at `now + 30 min + 30 s`. The tally of an open head counts only the confirmations whose `countedAtEpochMs` lies before `deadlineAtMs`. Work rows of type `AL_RECEIPT_RECORD:<fnv1a64(ns)>`, topics `AL_RECEIPT_DEADLINE` (due at the deadline, written with the head) and `AL_RECEIPT_ENDED` (due at the end, written with the terminal head). Results are values: `open` returns the view, `invalid-opening` (every issue of `empty-audience`, `audience-over-limit`, `receipt-expired`, `deadline-beyond-window` and `malformed-opening`) or `conflict`; `count` returns `counted` or `repeated` with the view, `head-absent`, `invalid-confirmation` or `conflict`; `countAhead` as `count`, or `ahead` when no head is visible after its write; `end` the ended head, `head-absent`, `not-due` (nothing written) or `conflict`; `read` the view or `head-absent`. Only `ALAdmissionBackendConflictError` becomes `conflict`; every other backend error propagates. A `count` that read an open head can commit after another instance's `end`; its view may then say `open`, even `complete: true`, for a receipt stored `timed-out`. Only `end`'s result is authoritative, and slice 2's caller treats it so. A contract of 27 cases (`describeALReceiptRecordContract`) runs on memory and on PostgreSQL. Cost if wrong: a contract change restates the cases on both backends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D743 | **The receipt record's decisions.** (1) A confirmation written with no head expires at `now + window + grace`, not after the 30 s grace the design first stated: while the head is open the rows are the count, so a shorter expiry would time out a receipt naming a recipient that confirmed (a controller decision of the build, of which the maintainer was told). (2) `countAhead` reads after its write: an `open` that commits between that ACK's head read and its write would otherwise leave a complete set unseen until the deadline. (3) A repeated confirmation is a typed no-op (`repeated`, first write wins), not a refusal: two instances can each validate before either writes, so a refusal could not be exact. (4) `end` takes no phase: it ends `complete` when the set it reads is complete, `timed-out` once the deadline has passed, and is `not-due` otherwise, so no caller can state a phase the record does not hold. (5) The store bounds its rows: `open` refuses a deadline beyond `now + window` (`deadline-beyond-window`) and a receipt already past its grace (`receipt-expired`), and the caller clamps; it also refuses an empty audience (`empty-audience`), which could never complete, an audience above the message collection limit (`audience-over-limit`), and an opening the stored-head decoder would refuse (`malformed-opening`), which would commit a head no read could use. (6) A confirmation under a head expires one grace after its head: a deadline pass that runs late reads the head and the confirmations as two reads, and with equal expiries could read a live head and no confirmation, ending `timed-out` naming nobody. (7) The tally of an open head ignores a confirmation counted at or after the head's deadline: a row written ahead passes no validator, and a head opened afterwards would otherwise count an ACK `count` refuses. Also: a terminal set names a recipient once; the open-head tally passes the expected recipients without repeats, first occurrence kept. Cost if wrong: (1) changes two contract cases and adds an adoption write; (4) a caller-stated phase; (6) 30 s less life per confirmation row; (7) one filter in one pure function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D744 | **The pinned cost of a non-completing ACK, and three backends without a conflict.** On PostgreSQL an ACK that finds its head open and does not complete the set is three statements and one transaction, `[null, 1, null]` with leading verbs `select`, `insert`, `select`: one autocommit read that batches the head and the confirmation key, the confirmation insert in transaction 1, one autocommit prefix read of the confirmations for the tally; five round trips with BEGIN and COMMIT. Fifty confirmations of one message from three backends with pools of 10 committed with no conflict, each `counted`; a second count committed while another instance's count was held uncommitted (`finished`, not `blocked`); of three backends ending the receipt together, one commit won with all 50 confirmed and the other two read `conflict`. No head cache and no single-statement unfenced write were needed. Sustained, 40 messages of 14 ACKs at 28 a second on three instances: no backlog at +0 or +5 ms; at +5 ms the lag from a message's last ACK to its `complete`, p50 / p95 / max per run, was 60.5 / 65.1 / 82.3, 62.8 / 72.0 / 80.3 and 61.8 / 68.3 / 72.0 ms, and the last ten messages' p50 (59.9 to 61.2 ms) was no slower than the first ten's (58.2 to 64.0 ms); 560 of 560 confirmations, 40 of 40 heads complete, one `end` winner per message, in three runs of each. Pinned in `al-receipt-record.test.ts`. Cost if wrong: the levers are a per-instance head cache and a single-statement unfenced write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D745 | **The receipt record's namespace in the growth proof.** The `runtime_state_store` namespace `<store>:receipt:record` (sampled as `server-ws-qbox:*:receipt:record`) is growth surface 85, class `ttl-within-run`, ttl `AL_RECEIPT_RECORD_WINDOW_MS + 2 × AL_RECEIPT_DEADLINE_GRACE_MS` = 1 860 000 ms, sweep 60 000 ms. The longest-lived rows are a confirmation under a head, which expires two graces after its head's deadline, and an ended head, which expires one grace after an end that comes at most one grace after the deadline; that deadline is at most one window after opening. Open heads and confirmations written with no head live at most window plus one grace. The record's work rows are expiring `resource_inbox` rows under surface 1. In `growth-surfaces.ts`, tied to `toALReceiptRecordNamespace` by `growth-surfaces.test.ts`. Cost if wrong: the growth gate reads a bound the rows can exceed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D746 | **The WS server counts in the record.** Deleted: the memory aggregate, its cap, window constant and sweep, `ws-queue-box-server-receipt-deadline-index.ts`, the ACK relay class `ws-queue-box-server-ack-relay.ts`, `createRelayedAckPublisher`, `publishRelayedAck` and `acceptRelayedAck`; the relayed-ACK notice, its subscriber, transport and channel leave in slice 3. `WsQueueBoxServerReceiptAggregation` now translates admissions, ACKs and re-sent copies to `ALReceiptRecord`: an admission opens the head (its deadline clamped to the window) and answers `admitted`; `acceptControlMessage` counts a receiver ACK (`count`, or `countAhead` when the head is absent, without a second proof) and calls `end` when the view is complete; only `end`'s result is authoritative, and a losing `end` does nothing. `ALReceiptRecordWorker` (`${serverPeerId}:receipt-record`, on the service's engine, lease 10 s, page 16) ends receipts at their deadline and delivers each terminal receipt at least once under `al-receipt-ended:${fnv1a64(ref token)}`, then settles the server's pending row. The refusal hook `readRelayedAckRejection` in `alm/inbound` is asynchronous and keeps its name: at ingress it checks only that the ACK addresses the origin it names; in the inbound runtime it reads the head once and refuses with the record's validator, or, with no head, proves the sender against the raw admitted audience of the inbound admission row (volatile store first, then the durable one), not the frozen audience. Refusals, all `unauthorized`: a misaddressed ACK; the unproven sender ("names no message its origin admitted to this sender"); the ended receipt ("names no receipt this server aggregates"); the record's own issues joined. Admission opens no receipt whose largest possible terminal receipt the control codec could not encode (`receipt-not-encodable`, one warning: 249 recipients of 128 characters open, 250 do not; the check costs under 1 % of an admission), the same check answers the empty-audience branch for an over-long message id, and the record refuses an identity a receipt control cannot carry (`decodeALReceiptIdentifier`, `malformed-opening`). Copies accepted `duplicate` or `pending-admission`: an open head is answered `admitted` with its confirmations and an ended head with its terminal phase and sets, under a fresh control id; a copy that finds no head opens the record from the admission row's audience, the message's own deadline, no never-sent recipient and the copy's snapshot version, and is answered `admitted`, except for a copy with no admission row (one still kept for admission, the commonest case), a message with no deadline, a deadline beyond the window, an age of the window by its own stamp, a row that freezes to nobody, or a receipt that could not be encoded. The middleware option `receiptRecordStores` is required (api-v1 passes `create-p-sql-al-receipt-record-stores.ts`), and `create-api-v1-runtime.test.ts` fails if the runtime stops counting in the shared repository's record. The inbound authority no longer keeps a control message for admission while its room view is behind, a change of the authorizer contract (the production authorizer authorizes every control). The cluster recipe `api-v1-cluster-publisher-instance-loss` now reads `complete` for the broadcast its lost server admitted. Absorbed from #869 (D708): the `never-sent` guard and refusal, `neverSentRecipientPeerIds` on the admitted message, `isALOwnWord` for the sender rule, the safe projection's guard list, and the kept-send restatement. Measured: a non-completing ACK is 8 round trips through the server (hook 2, the inbound control-owner read 1, the count 5), pinned in `ws-receipt-record-cluster.test.ts`. Limits: a room member outside a send's frozen audience (a unicast's addressee, a broadcast's except or recipient list) can write one confirmation row per message, which the tally ignores, since it counts only the expected set, and which expires with the record's window plus one grace; a send to more than 256 recipients is admitted and gets no receipt; a cluster's instances must share one server name, since the record's namespace derives from it; the outbox may deliver one terminal receipt more than once under the same control id until the origin acknowledges it; the receipts' own enqueue stays fenced on the server's outbound version row and their delivery waits in each instance's one outbound worker, measured in slice 5: publishers read 8.1 to 9.8 receipts a second against 20 offered. Cost if wrong: the lever for the ACK's cost is to count at `admitAuthorizedMessage`, which makes the count's refusal the answer and the hook store-free again. |
| D747 | **The ACK relay deleted (slice 3).** Deleted: the relayed-ACK notice, its subscriber, api-v1's PostgreSQL transport and its `ws-relayed-ack` channel, the middleware option `relayedAckNotices`, the `ack-relay` observation kind and refusal owner, the count's `source` and `relayPublisherId`, and their safe projection, which now refuses a record of that kind or owner. The relay's per-publisher budgets left with the relay class in slice 2: they bounded NOTIFY publications, and none is published now. An ACK that finds no head costs two reads and writes a row only when its sender is in the audience its admission ran under, reads as a refused repair request already costs; growth surface 38 stays, restated as empty. `keepsVolatileMessageInMemory` replaces the relay option as the explicit volatile-store switch: absent, a WS server keeps every volatile message in its memory pair; on a cluster only an instance-local one, since another instance proves an ACK and reads an oversized live notice's message from the shared store. api-v1 passes `isInstanceLocalRtcSignal` on PostgreSQL pub/sub, guarded by the black-box recipe `api-v1-websocket-live-only-cluster`. The hook `readRelayedAckRejection` keeps its name: it names the server's relay of the origin's message. Prose naming the deleted relay remains in files open pull requests own, rewritten in slice 5: `alm/outbound/README.md`, `alm/inbound/README.md`, `runtime-diagnostic-contract.md`, `plans/backlog.md`, `playground/alm/`. Cost if wrong: a relay restored would be a second count path beside the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D748 | **The WS server's own receipted publications count in the record (slice 4; the maintainer's "Yes, include them" of 2026-11-22).** The head opens first in `afterDequeueAdmission`, from the server's pending receipt row (`readPendingAck`), not from the hook's committed policy (it expects nobody); no `admitted` receipt. Its deadline is the row's retransmission budget less half an ACK window (7 s for a delta against the row's 8 s). A session's ACK of a server publication is counted (`count`); one that finds no head is proven by the pending row (counted ahead if the row expects the sender, refused if not), and the server's own `not-sent` is counted ahead unproven; with no logical row an ACK goes to the outbound owner (a `hop` row counts it), and a refused opening (over 256 sessions, an unencodable receipt) keeps the per-ACK fenced count in the row. An outside-audience NACK the row admits is one `outside` confirmation. The retry window opens a head the dequeue did not open, counts the row's unrecorded outside recipients, ends a complete open head and narrows retransmission to the unanswered. The ended work admits the terminal receipt into the server's row and enqueues nothing; a partly confirmed one ends `timed-out`. Deleted: `commitOutsideAudience`, its control and its diagnostic kind. Measured on PostgreSQL: the server's version row moves once from the settled dequeue to the end (twice with the dequeue's commit) for 10 sessions and for 50, against 51 with that commit for 50 before slice 4 (derived: once per ACK, once per recipient sent nothing); a non-completing ACK is 5 round trips, none fenced (about 15 fenced before, derived); the dequeue's record work is 11 round trips, none on the version row (pending-row read 1 on the outbound client; on the record's, `open` 7 and one claim 3, which finds the deadline row not yet due and reserves nothing), and the worker's first batch of each 10 s lease adds two lease sweeps (6), pinned at the first batch; a survivor's window opened the head a lost dequeuing instance never opened. Pinned in `ws-own-publication-receipt.test.ts` and `ws-queue-box-server-own-receipt.test.ts`. The state-write bench runs no slice-4 code (uncontended transaction time 13-16 % above another session's baseline, on an unchanged path). Limits: a stall over half a window lets the row's budget end first (the admin read says `receipt-exhausted`, the head stays exact); a publication with no retry has no window to heal an unopened head; a refused opening's skipped recipient keeps its row open until its budget ends; a lost `end` no window reaches waits for the deadline worker; a failed dequeue attempt re-sends every copy. Cost if wrong: the ACKs go back to the row's fenced count; the stall's levers (both in `alm/outbound`): a settlement from the record's view or a pending row marked counted elsewhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
