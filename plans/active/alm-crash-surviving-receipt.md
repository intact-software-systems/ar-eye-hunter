# The crash-surviving receipt

A sender's receipt on WebSocket stays exact when the server instance that admitted the send crashes or
restarts. The count of who confirmed a receipted room send moves out of one instance's memory into a
durable record every instance reads and writes.

Status: approved by the maintainer on 2026-11-22; slices 1 to 7 built. Section 13, a completed delivery hands its
track's next message on, is a design that waits for the maintainer's approval (ruling 16); nothing of it is built.

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

## The maintainer's rulings (2026-11-22, 2026-11-25, 2026-11-26 and 2026-11-27)

Rulings 1 to 7, 9 and 10 were each asked alone. Ruling 8 the maintainer wrote unasked, in the same message as
ruling 7. Rulings 11 to 13 were each asked alone and relayed word for word by another session of the maintainer's;
rulings 14 to 16 the maintainer gave in the session that builds this work.

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
7. Where the fix for the five-publisher backlog in the receipts' delivery goes (2026-11-25; asked "Where should
   the five-publisher receipt delivery fix go?", with the recommendation "Separate PR"): **"Fix in #885"**.
8. In the same message (2026-11-25): **"rebase onto main"**.
9. Which fix the receipts' delivery takes (2026-11-25; asked "Which fix should #885 build for the five-publisher
   receipt delivery problem?", with the options "A + B (Recommended)", "A alone" and "All receipts live"):
   **"A + B (Recommended)"**. (The options as the ledger describes them, not the maintainer's words: A, a receipt
   control's commits fence on the receipt's own version row only, not on the server's sender version; B, the
   `admitted` receipt is sent directly on the admitting socket, with the stored outbox row as the fallback when the
   origin has no socket on that instance.) After the controller explained
   where the fence is and why: "Yes I think it is good." After two explanations, where the fence is and how a
   conditional write validates a read: "proceed with A + B".
10. How far fix A reaches (2026-11-25; asked "How far should fix A reach in #885?", with the options "Wide
    (Recommended)" and "Narrow", receipt controls only): **"Wide (Recommended)"**. (What the wide option means, as
    the ledger describes it, not the maintainer's words: every commit that read no shared sender state fences on
    its own message's version only, so receipts, the server's handed-off controls, its unsequenced publications and
    a client's plain broadcast, in the browser too.)
11. Whether #885 is handed over with the ordered-send limit written down, or held until the ordered-send fix is in
    it (2026-11-26): **"hold for the fix"**.
12. Whether the fix of the inbound ordered delivery's completion (section 11) stays in #885 (2026-11-26):
    **"Keep it in 885"**.
13. How `main` is brought into #885 from here on (2026-11-26): **"Merge commits"**.
14. Which option for ordered sends under load is built here (2026-11-26; option 1 was to repair today's ordered mode
    in #885): **"Let's complete 1 here in this session."** (What follows from it, as the ledger describes it, not
    the maintainer's words: today's ordered mode is repaired in #885, and the maintainer's counter idea, ordering
    end to end in Rallar Web, is planned as its own work, in draft pull request #914.)
15. Which scope of that repair #885 builds (2026-11-26; asked with the measured figures of section 12 and three
    options): **"Retry-at-once only (Recommended)"**. (The option as it was put, not the maintainer's words: the
    "look again at once" repair for arriving ordered messages, and the same for replays and for held messages being
    released; about 70 production lines; it moves about 50 existing tests; five ordered senders keep up, measured;
    one sender stays at about 3 ordered messages a second, which is written down as a limit; fast streams are what
    the end-to-end ordering of ruling 14 is for.)
16. Whether the repair of section 13 is built in #885 (2026-11-27; asked with the measured figures of "Why ordered
    tracks fall behind together"; the other options put were to build it at once, or to hand the pull request over
    without it): **"Show me the design first"**.

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
- Decision rows D770 to D779 are this work's.

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
`admitted` receipt, on the admitting socket where it can (section 10). This holds for a send admitted at ingress and for a kept send admitted
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
`admitted` receipt is written at admission (section 10).

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
runtime's inbound and outbound stores are; D770 states it.

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

### 10. The receipts' delivery

Five publishers at +5 ms backlog in the receipts' delivery ("Measured through the WS server"). An investigation
that varied one factor at a time, with prototypes kept out of the tree, isolated the cause; the fix is the two
rules below (ruling 9), with the fence rule at its full reach (ruling 10).

**The cause.** A receipted client send produces two receipt controls, each its own message under the server's
identity: `admitted`, under a fresh control id, and the terminal receipt, under `al-receipt-ended:<hash>`. Each is
a durable `WS_OUTBOX` row with no prepared sends and no ACK tracking, so the origin acknowledges no receipt control
and no control names one. One message to 14 recipients over three instances, traced at each commit on the code
before this section (statements of the write transaction, BEGIN and COMMIT not counted):

| Commit (instance)                                                           | Rows it fences on                                                                                     | Statements                                     | Conflicts with                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `admitted` enqueue (the admitting instance)                                 | `msg-version:[server, <control>]` alone, then `version:server` (the guard; owner and sent rows on it) | 3: version insert, guarded batch, work insert  | every receipt commit of every message on all three instances, on `version:server`     |
| `admitted` replay (any instance's worker, only if the enqueue was retained) | as the enqueue                                                                                        | 3, and the hold                                | as above                                                                              |
| `admitted` dequeue (any instance's worker)                                  | `msg-version:[server, <control>]`, then `version:server`                                              | 4: version update, guarded batch, hold, insert | as above                                                                              |
| send to the origin's socket                                                 | none (the claim's settle)                                                                             | 1 work update per claim step                   | none                                                                                  |
| the record's `end` and its ended work                                       | the head row                                                                                          | 2, and 1 for each losing `end`                 | the message's other `end`s                                                            |
| terminal enqueue (the record worker's ended claim)                          | `msg-version:[server, al-receipt-ended:…]`, then `version:server`                                     | 3                                              | every receipt commit, on `version:server`                                             |
| settle of the server's own row (`acceptServerReceipt`)                      | `msg-version:[<origin>, <room message>]`, the tracked message's version                               | 2: guarded batch, work update                  | only commits of that room message: its dequeue, its `ack-timeout` window, its repairs |
| terminal dequeue                                                            | `msg-version:[server, al-receipt-ended:…]`, then `version:server`                                     | 4                                              | every receipt commit, on `version:server`                                             |

Every receipt control's enqueue, replay and dequeue, of every message on every instance, is fenced on one row, the
server's sender version (`version:server`), so the cluster's receipt delivery is one serialized optimistic queue on
that row. #869 did not create that queue; it made each turn of it dearer, through four changes that each matter
little alone: it removed the in-process sender commit queue, went to three commit attempts instead of one, added a
fence statement, and gave each receipt control its own version row. No receipt
control commit fences on the tracked room message's version; only the settle does. "Measured through the WS
server" read the growing wait in each instance's one outbound worker: the receipt commits that worker runs each
wait their turn on this row, and every enqueue that loses it adds a replay claim.

The commit before the per-message fence already backlogged in the same cell: all 200 messages read `complete` by
the deadline, but `admitted` took 11.4 s over the last ten (p50) against 1.2 s over the first ten, and 108 of 200
arrived past the browser's 8 s first-hop budget. Undoing the four changes together reads 187 of 200, `admitted`
13.9 s over the last ten. Restoring the earlier behaviour is not the fix.

Five publishers at 2 Hz, 40 messages each, +5 ms on every statement, BEGIN and COMMIT, three instances, a 30 s
lifetime. These are prototype figures, not measurements of the built code: medians of two runs each, on a machine
another session loaded (1-minute load 8 to 33), each run directly after its own run of the unchanged code, whose
24 runs the first row pools. Times in seconds; 19.5 receipts a second are offered.

| Variant                                           | `complete` by the deadline, of 200     | `admitted` p50 first / last ten | `complete` p50 first / last ten | Receipts read/s | Enqueues retained; replay / dequeue conflicts |
| ------------------------------------------------- | -------------------------------------- | ------------------------------- | ------------------------------- | --------------- | --------------------------------------------- |
| the unchanged code                                | 57 to 112 by rotation (range 0 to 162) | 1.2-1.7 / 26-30                 | 4.4-7.8 / 25-29                 | 2.5-3.2         | 61 %; 38-40 % / 19-21 %                       |
| the commit before the per-message fence           | 200                                    | 1.2 / 11.4                      | 2.0 / 9.4                       | 8.7             | 78 %; 13 % / 3 %                              |
| the four changes undone                           | 187                                    | 1.2 / 13.9                      | 2.8 / 14.7                      | 6.3             | 76 %; 67 % / 27 %                             |
| receipt controls fenced on their own version only | 200                                    | 0.8 / 1.2                       | 0.7 / 1.2                       | 18.3            | 0 %; 0 / 0                                    |
| `admitted` on the admitting socket only           | 184                                    | 0.2 / 0.3                       | 1.4 / 12.1                      | 12.9            | 44 %; 37 % / 19 %                             |
| both                                              | 200                                    | 0.1 / 0.1                       | 0.5 / 0.5                       | 19.4            | 0 %; 0 / 0                                    |

One publisher at +5 ms shows no regression with the fence alone or with both: 40 of 40 in each run, and every
receipt commit about 15 to 20 ms shorter. Three other levers were measured or weighed and not taken: four claims at once on the outbound worker
(126 of 200; it turns queueing on the row into conflicts on it), every receipt written live when the origin's
socket is local (200 of 200, but a lost live terminal receipt is then redelivered by nothing, since the client
resends no message it holds `admitted` for), and receipts delivered from the record's own work rows, which needs a
cluster notice and an at-least-once rule of its own for the ended work row.

**A dispatch that read no shared sender state fences on its own version.** A dispatch bundle fences on its sender's
version exactly when its decision read a row the sender's other messages share: when its message holds a place on
an ordering track (an ordering key, and a sequence after its read's mint) or its read holds a supersedence key.
Otherwise it fences on its own message's version alone. That is the outbound README's own rule applied to every
dispatch: "A bundle fences on the sender version too, because its decision reads rows other messages of the sender
share: the track head, the sent positions, the room sent floor and the supersedence latest." Every read of a head,
a position or a room floor is made for a message with a track key, so the track key covers them, and covers the
track's index row each tracked dispatch writes; a tracked row dequeued again with its positions recorded, whose
read holds no head and no position, still fences. A tracked message that names no deadline never reaches a bundle:
its plan's validation refuses it. The flag is derived from the read, not from the message's type, so a message that
gains an ordering gains the fence with it.

So every dispatch of a message with neither stops moving its sender's version: a receipt control; a handed-off
control of the server; an unsequenced server publication, such as a RallarAI room result; a client's plain room
broadcast, on the browser's IndexedDB as on the server (ruling 10). The group-state delta carries no ordering (only
a client-state event does), so it is an unsequenced publication and fences on its own version alone. A receipt
control's decision reads none of the shared rows: its message has no ordering and no QoS
(`newALReceiptControlMessage`), and its plan is durable with no prepared message, no tracking and no supersedence
(`toWsQueueBoxServerReceiptDispatchPlan`); its dequeue re-plans through the server's planner and the captured
policy, and a test of each kind of dispatch, a receipt's dequeue among them, pins whether it moves its sender's
version.

A message end, an ACK window, a first-hop commit and the not-yet-in-sync retry schedule keep the sender fence. They
are not dispatch decisions, and the schedule commits on the sender version alone: it is decided on a re-read after
the NACK's commit, so it is fenced against an end only through that row, and only against the ends that move it.
An end made by a control already moves its message's version alone, and under this rule neither does a dispatch
that completes its receipt, at admission or by its own tracking. So one `nack-retry` can be scheduled for a message
that ended in that race; its dispatch answers `message-ended` and writes nothing, and the retry record expires. A
dispatch that ends its message through the message-end bundle (a spent repair budget, a re-plan refused for good)
still moves the sender version, a receipt control's included.

Two commits of one message meet on its own version row, which every commit of the message moves and re-checks. An
ended work claimed twice enqueues one control id from two instances, and a retained enqueue's replay meets the
control's dequeue: the second conflicts on the control's version and reads the first's rows. A bundle without the
sender fence that writes a row the sender's messages share is refused, as before.

The dequeue lane groups a batch's dispatches by sender before any decision exists, and the flag is a fact of the
decision. So the dispatch admission, once it has read the group's decisions, parts them into the bundles that fence
the sender, which must have read one version of it, and those that do not, and commits each part in its own write,
both at once. When the bundles that fence the sender read different versions, they commit alone and the others are
still one write. The part that fences no sender commits as one transaction: one BEGIN and one COMMIT for a page of
receipts, and a conflict on one member's version fails that part, whose members then commit alone. A part that does
not commit falls back to its own members alone, each after its predecessor on its track; a part that committed is
never committed again, unless its write or its settlement threw after the transaction committed, when its members
commit alone a second time, each through a fresh read. A follower, a tracked message dequeued in the same batch as a
predecessor of its track, holds a place on that track, so it is always in the fenced part. The store keeps refusing
a group that mixes fences, which the admission never hands it, and asks a group that fences no sender for no agreed
version.

The decision still reads the sender version. The read is issued before the plan that decides the flag exists, in
the first turn's one batched statement on PostgreSQL, so skipping it saves no round trip and deferring it would
cost every fenced dispatch one. The bundle keeps it as the version its read saw; the write re-reads and moves it
only for a bundle that fences it. The two cleanups that took their sender from that row, of an orphaned first-hop
wait and of an orphaned receipt, take it from the stored message instead, so they run, in the cases they ran in
before, for a sender whose commits never moved its version.

**`admitted` on the admitting socket.** An `admitted` receipt that expects at least one recipient, so that a head
stands behind it, is written to the origin's sockets on the instance that answers it; its outbox row is written only
when no socket there took it. That instance is the one whose ingress admitted the send; at a kept send's replay,
whichever instance's worker claims it; and for a re-sent copy, the instance that answers the copy, whose answer to
an open head is a fresh `admitted` under a new control id, written live when a socket of the origin is there. An
`admitted` that expects nobody has no head, is the send's terminal settlement at the origin, and a re-sent copy of
it is answered nothing: it keeps its row, as a terminal receipt does.

The row promised one socket write: it is durable work until the origin has a session on some instance, and after
that write nothing delivers it again, since no receipt control is acknowledged. The live send is that one write,
without the enqueue, the replay and the dequeue. A lost live `admitted` is recovered where the origin resends: a
send that holds a first-hop wait writes its frame again at each window (2 s and 3 retries by default, about 8 s),
and a re-sent copy is answered from the record (section 6). Nothing recovers it for a send with no first-hop wait,
a send with retry `none` or a kept send whose wait the server's `not-yet-in-sync` NACK ended: such a send reads its
terminal receipt alone, which keeps its durable row. No row is kept for them, since the row never promised more
than the one write, and the server cannot read the origin's plan, only its own normalization of the message's QoS.

Each connection the live send of an `admitted` called records one `receipt-transport` observation, the existing kind:
`transport: 'recipient'`, the `nativeCall` the socket's send evidence states, the `connectionId`,
`publisherCall: 'absent'`, `originIsHere: true`, `outcome` `sent` for a write that returned and `failed` for one
that threw, `submissionAttempted`, and no `retryAfterMs`, with frozen copies of the receipt's arrays. The live
delivery answers, for each connection it called, what the native call did; with no receipt observer attached the
write collects no evidence. A live `admitted` enqueued nothing, so it
records no `receipt-outbox`, which stays the enqueue of an issued receipt. No field is added.

Its stated limits:

- _The sender's version still moves._ A dispatch that ends its message through the message-end bundle, each ACK
  window and each message end still move it, so a server publication's own receipt windows keep competing for
  `version:server`.
- _A stray retry._ A not-yet-in-sync retry can be scheduled for a message that just ended; it answers
  `message-ended` and writes nothing.
- _The terminal receipt stays on the outbound worker._ It keeps its two commits there, the enqueue and the dequeue,
  each now fenced on its own control's version.
- _No first-hop wait._ A send with no first-hop wait whose `admitted` frame is lost reads its terminal receipt
  alone.

### 11. An ordered delivery's completion

The completion of an ordered delivery, which moves its track's delivery progress and deletes the delivered slot after
the application was handed the message, was fenced on every row of the message's observation. The next admission on
the same track rewrites the progress row to extend its expiry with the same position, so the completion conflicted,
its work came back, read the position unmoved and handed the same message to the application a second or third time.
The defect is as old as the expiry refresh; the faster ingress of the live `admitted` only made the next send land
inside the completion's read-to-commit window on every run.

The completion is guarded on its position and its slot alone, in one write whose guard comes first: it commits when
the stored `completedThrough` and the stored slot are the ones it read, keeps the larger of the stored and observed
expiry, places the new position itself from the stored slot and `completedThrough`, and writes nothing otherwise or
when those facts place no completion. A write can still lose: another completion, a gap pass or a witness moved the
position, the slot is gone or was rewritten (it is compared whole, so a retention extension of its message counts), or
on PostgreSQL another commit moved a row version between the write's own read and its conditional statement. Because
the application already has the message, a lost write is not handed back as work: the completion reads the slot and
the progress again as they then are, decides again, as the doctrine has every conflict do, and writes again, three
attempts in all with no wait between them. After a dispatch the completion hands the work back in two cases, every
attempt lost or the shutdown signal aborted it, and the application can then be handed the message again: the same
class as a crash between dispatch and completion. It also hands the work back when its predecessor has not completed
so no completion can be placed yet, which no dispatch precedes: only a dropped plan or a disabled local delivery reach
it, and they hand the application nothing. An attempt ends in a `NonRetryableException` when the slot holds another
message, when the progress row is gone, or when the slot is gone and the position has not moved past the message.

Not changed by this section: an admission's own guard still fences on the whole progress value, so a completion that
commits first makes that admission's write conflict, which has no external effect. As built here that admission is
retained and replayed; section 12 has it look again at once.

### 12. An ordered arrival that loses its write looks again

Ordered, at-least-once is a browser's room send by default, and "Ordered room messages" below measured that five
such publishers do not keep up through the WS server at +5 ms. The stall is older than this work. Its causes were
isolated and each lever prototyped; the maintainer chose the scope (ruling 15). This section is that design.

**What was measured, and how.** The ordered cells were run again at this branch's head, each lever applied as a patch
outside the tree, alone and together, beside the unpatched head: three WS server instances on PostgreSQL, every
statement, BEGIN and COMMIT delayed 5 ms, fifteen sessions in one room, a 30 s message lifetime, the harness
re-sending nothing. Five publishers each send one ordered receipted message every 500 ms on a track of their own,
for 20 s (200 messages, three runs a column unless the table says one) and for 45 s (450, one run). One publisher
alone sends on one track at 2, 5, 10 and 30 a second for 20 s (two runs a column, one at 30). Two unordered cells,
the five publishers and the five with the server's own publications, guard what section 10 fixed. 91 runs, none
probed, each started at a 1-minute load of 1.4 to 6.1. Counted beside the earlier figures: the sends answered
`pending-admission` (parked), the work rows that went back as RETRY and how long a due one waited for its next
claim, and the tracks ended `resync-required`. "Read" is the recipients' read of a message, from its send to its
last ACK offered, p50.

| Cell, +5 ms                      | Head, no lever                                                        | Fresh attempts at ingress, alone                               | Progress row written only when needed, alone | Due retried rows read with the new, alone | One track's arrivals in turn, alone | Fresh attempts with the other levers             |
| -------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| Five ordered, 20 s, 200 messages | 166-182 complete; 22-30 parked; read 5.6-12.4 s; 13.8-14.8 receipts/s | 200 each; none parked; read 0.6 s, at most 1.1 s; 19.4-19.5 /s | 200 each; 2-23 parked; read 0.6-9.5 s        | 200 each; 31-38 parked; read 9.4-11.4 s   | 180 (one run); 31 parked; 6.4 s     | 200 each; none parked; read 0.6 s, at most 1.2 s |
| Five ordered, 45 s, 450 messages | 77 complete; 33 parked; 366 timed-out; 12.9 receipts/s                | 450; none parked; read 0.6 s, at most 1.0 s; 19.8 of 20.0 /s   | 450; 5 parked; read 0.6 s                    | 202; 59 parked; read 9.9 s                | 98; 36 parked                       | 450; none parked; read 0.6 s                     |
| One track, 2 a second, 40        | 40 each                                                               | 40 each                                                        | 40 each                                      | 40 each                                   | not run                             | 40 each                                          |
| One track, 5 a second, 100       | 16-17                                                                 | 33-38; read 25 s                                               | 45-78                                        | 2 in both runs                            | 35-56                               | 28-74; 33-37 with all five                       |
| One track, 10 a second, 200      | 3-5                                                                   | 4-7                                                            | 11-13                                        | 4-10; 5 frames read twice in both runs    | 5 each                              | 3-13; 31-34 with the arrivals in turn            |
| One track, 30 a second, 600      | 1                                                                     | not run                                                        | not run                                      | not run                                   | 5                                   | 2-5; 31-32 with the arrivals in turn             |
| The two unordered cells, 200     | 200 each; read 0.5 s; 19.4-19.5 receipts/s                            | not run                                                        | not run                                      | not run                                   | not run                             | 200 each; read 0.5 s (four levers together)      |

Receipts are read against 20.1 a second offered (20.0 over 45 s). No run of any column handed a message to the
subscriber twice, and in the ordered cells recipients read no frame out of order; the only frames read twice are the
ten the table names. In every one-track run the messages completed are exactly the first of the track.

**The three causes**, from three probed 20 s runs of the five-publisher cell (600 messages):

1. _A lost admission is parked._ An arriving ordered message's admission reads its track and writes about 60 ms
   later. When another commit on the track lands in between, the write is lost and the send answers
   `pending-admission`. Of 135 lost admissions, 71 lost to the predecessor's completion moving `completedThrough`, on
   which the admission's decision depends; 54 to another admission's rewrite of the progress row's expiry alone; 10
   to another row. The parked admission's replay waits for a batch of the lane's worker (send to first replay, p50
   2.0 s, p95 5.2 s). Meanwhile the track's later messages are buffered behind the gap, each with a gap NACK, a
   repair request and a renewal timer.
2. _A lost release is retried._ A buffered message's release loses its commit the same way (three of the four lost
   releases of one probed run to an expiry rewrite alone) and answers `retry`.
3. _A retried row waits for the rotation._ A row that lost once is a RETRY row, and the lane's rotation reads RETRY
   only after paging through every NEW row (`SCAN_STATUSES`, pages of 16, `read-al-inbound-work-selection.ts`). Under
   the room's steady control traffic no retried row was claimed on any instance for 30 s. The retry policy's delays
   of 1 to 16 ms play no part. With a 30 s lifetime the waiting message expires first, the next release finds a gap
   with no predecessor, and the track ends `resync-required`.

The loss itself costs 50 to 100 ms. What costs seconds is that the loser and its whole track leave the fast path.
This fix acts on the first cause where it arises, and on the first and second for a replay and a release. It
removes neither the expiry rewrite nor the rotation's order; it keeps work from reaching them. With fresh attempts
at ingress no send was parked and no row went back as RETRY in any of the four five-publisher runs, so no gap
formed and no release ran; 4 to 9 of about 200 expiry rewrites a run still lost, each won at its next attempt.

**The rule.** An inbound write that is lost is looked at again at once. When the admission store answers
`conflict` to the conditional write of an arriving data message's admission, of a retained admission's replay or of
a buffered message's release, its owner makes a fresh attempt inside the same call. A fresh attempt runs everything
the attempt ran before, and never writes the lost bundle again:

- _An arrival_: the publication-proof check, the plan, the store read, the readmission decision, the plan against
  what was read, the deadline, the bundle, its validation, its signing and the conditional write.
- _A replay_: before all of that, the question to its authority, the deadline, the stored-scope check and the
  message's authorization. A replay that looks again asks its authority again.
- _A release_: the read of the buffered message, its ownership and stored-scope checks, the proof check, the plan,
  the deadline, the predecessor's readiness, the bundle, its validation, its signing and the conditional write.

At most three attempts are made, one after another with no wait: a lost write means the winner has committed, so
the read that follows sees it. When the third loses too, the owner answers what one lost attempt answers today: the
arrival is retained and answers `pending-admission`, and a replay's or a release's work row goes back as `retry`.
So a conflict no fresh read can resolve costs three attempts and then takes the path it takes now.

**Only a lost write is tried again.** Not tried again:

- A readmission that waits for its first delivery (D756). Today it answers the same `conflict` kind as a lost
  write, though it made no write and a second read finds the same queued delivery. It gets an answer kind of its
  own, `waiting`, retained and replayed exactly as now.
- A message past its deadline, a rejection, and an owner being disposed, which makes no further attempt.
- A release whose predecessor has not completed, or whose plan asks for a retry.
- The resynchronization NACK a release or a dispatch commits when its track can no longer be ordered: its lost
  write answers `retry` as now. It ends a track and is not on the measured path.
- A store failure that is not a conflict. It leaves the owner unchanged, from the first attempt or the third.
- The control admission (an ACK, a NACK, a repair), which this does not touch, and the completion, which has the
  rule already (section 11).

**A lost attempt has written nothing.** A bundle commits whole or not at all, in one write, so a lost attempt left
no row, no work and no effect. What follows a commit runs once, after the attempt that committed: the
resynchronization notice, the ordering-position diagnostic, the work announcement, a replay's hand-over to its
owner, and for a release the dispatch and its completion. A fresh attempt of an arrival that finds its own message
admitted meanwhile, by a copy on another carrier or instance, answers `duplicate`, as its replay does today.

**One function, one bound.** The completion's three attempts and these are one mechanism with one reason, so the
completion's private policy becomes the inbound's: one function that runs an attempt again while it answers a lost
write, one bound of three, no wait. It composes the shared retry primitive (`TryWithPolicy`,
`RetryableConflictError`), which is not changed. The conflict the primitive throws to count an attempt never leaves
that function: it answers the last attempt's own answer, and each owner maps a lost one to what it hands back.

**Where the attempts live.**

- _The arrival's_ are made in the store lane, around the admission's `attempt`, where parking is decided; the
  admission stays one conditional admission per call. They run under the source the caller authorized for this call.
  A carrier's own authority (on the WS server, the socket's scope and the frozen room audience) is read above the
  inbound runtime, before the call; the fresh attempts happen inside that one call, at most two read-and-write
  rounds later, and do not ask it again. The planner, which holds the inbound's policy, runs again in each.
- _The replay's_ are made in `replay`, around the whole of it, so each asks its authority again.
- _The release's_ are made inside `release`, as the completion's are inside `complete`: the lost write is an answer
  private to the class that writes, and the caller still reads `completed`, `retry` or the delivery.

`release` (63 lines) and `attempt` (94), both older than this work and longer than the standard allows, are split
into their phases, with no change of behaviour, before they change.

**Not built, and why.** Four more levers were prototyped or named. Each is left with its figures.

- _Writing the track's progress row only when it is new, moves, or has less than one lifetime left._ It removes the
  expiry rewrite: no conflict on it, every completion in one attempt. Alone it is not enough (two of three 20 s runs
  still parked 20 to 23 sends and read at 7.5 to 9.5 s), and on top of fresh attempts it changes no figure a
  publisher or a recipient reads. It changes the browser: the delivered-marker cap ranks a track by when its progress
  row's expiry last moved and evicts the head, so a live track's marker, now written about once a lifetime, can be
  evicted under a live ordering snapshot, and the track's next delivery reads `resync-required`. The prototype's
  answer (never evict a marker whose ordering snapshot is live, and move a track behind on every committed ordering
  write) passed a throwaway proof of both caps, a restart included. But its eviction walk never ends when a pass
  finds no marker it may evict: a unit sweep with it applied hung until it was stopped after 1 h 40 min. It also keeps
  an idle track's marker one to two lifetimes instead of one, and takes `browser/rallar.ts` over its budget.
- _Reading due retried rows with every page of new ones._ Alone it shortens a due retried row's wait (at most 7.7 to
  14.2 s, against 17.9 to 20.2 s) and does not end the stall. On one track at 5 a second it delivered 2 of 100 in
  both runs, against 16 to 17 without it, and at 10 a second recipients read 5 frames twice in both runs though the
  subscriber was handed each message once. Neither is explained and neither was probed.
- _Admitting one track's arrivals one after another inside an instance._ Alone it does nothing. With fresh attempts
  and the progress-row lever it removes the contention on one fast track (no send parked at 5 and at 30 a second) and
  brings 10 and 30 a second to what 5 a second delivers, about 33 messages before the lifetime cuts the track off.
  It is an in-memory queue in front of a conditional write that is correct without it, it orders the arrivals of one
  instance only, and it holds a track to one admission at a time. Whether the inbound may serialize in memory what
  the store arbitrates is a question of the write doctrine that this work does not open.
- _Claiming a track's next in-order dispatch in the batch that completed its predecessor_, as the batch already
  promotes the next buffered release (D190). Not prototyped when this section was written. It has been since, after
  a probe showed what it answers ("Why ordered tracks fall behind together"), and section 13 is its design, which
  waits for approval.

**The limit that stays.** Measured on the built code ("Ordered room messages, with the fresh attempts built"), one
ordered track keeps up at 2 messages a second through the WS server at +5 ms (40 of 40 in every run, the last
message read 0.8 s behind), and at 3 a second in three of four runs (60 of 60, no send parked, the last read 0.7 to
0.9 s behind); in the fourth one send was parked and the last message was read 13.2 s behind, though all 60
completed. Without the fresh attempts 3 a second does not keep up in any run (21 to 30 sends parked, the last read
9.8 to 18.8 s behind). At 4 a second no run keeps up on either: the built code completes 42 to 80 of 80, the last
read 21.7 to 29.7 s behind; at 5 a second 11 and 65 of 100, at 10 a second 2 and 5 of 200. In every one-track run
the messages completed are exactly the first of the track. The prototype study had read the limit as a ceiling of
about 3.1 messages a second, by halving the receipts read a second (6.2 to 6.6). Most of those receipts are
`admitted`, so that figure is not a delivery rate, and the option put to the maintainer (ruling 15) carried it as
"about 3 ordered messages a second". What the built runs show: 2 a second keeps up in every run, 3 a second in most
and not reliably, and a track offered 4 a second or more falls behind and loses what passes its lifetime. Why a
track that has fallen behind is slower than one that keeps up was not probed; the study's reading is that each
in-order dispatch waits for its predecessor's completion and then for a later batch of the lane.

A track that falls behind ends as it does today: its waiting message expires, the next release finds a gap with no
predecessor, and the track ends `resync-required`, a NACK to its sender. On the built code that happened in each
5-a-second run, where the code before it had stalled without ending the track. A single retried row is still enough
to hold a track: a dispatch that ran before its predecessor's completion, a release, or an admission that loses
three writes waits for the rotation (cause 3). No such row arose in the counted five-publisher runs of the built
code, where the code before it made 9 to 15 a run; one built run taken beside another session's test suites (load
7.5 rising to 13.1) made 14 such dispatch rows, none claimed again, and completed 108 of 200 with five tracks ended
`resync-required`. And under contention an arrival now costs up to three read-and-write rounds before it is parked,
not one: at 10 a second the progress row's lost writes rose from 433-444 of 597-613 to 813-814 of 981-982. Streams faster than one track carries are what ordering end to end in Rallar Web is for, planned as its
own work in draft pull request #914.

**For a browser receiver.** The same lane runs in the browser, over IndexedDB for the session's durable pair and
over memory for its volatile pair, and for an RTC receiver.

- Nothing stored changes shape, and no message, control or diagnostic gains a field. The delivered-marker cap and its
  eviction are untouched: every admission still writes its track's progress row.
- An arrival whose write is lost answers after up to two more read-and-write rounds on its store, where before it
  was parked. When one of them commits, the arrival is admitted, acknowledged and handed to its delivery in that
  call, where before it waited for the lane's worker. One that loses all three is parked as now.
- A browser's writes are lost where two arrivals of one track interleave (an admission's read and its write are
  separate turns), where a completion lands between them, and where another tab of the session writes the shared
  durable pair.
- `browser/rallar.ts` carries the inbound runtime and measures 331.964 of its 332.0 KiB budget. What the change adds
  is measured when it is built; a budget it passes is raised to the smallest whole KiB above the measured figure, in
  a commit of its own, under the maintainer's ruling that bundle budgets are adjustable.
- Not measured in a browser: every cell above runs the server's lane on PostgreSQL.

**How it is proven.**

- _The function_, alone: an answer that is no lost write ends the attempts; two lost answers and a third that is not
  answer the third; three lost answers answer the third lost one; an error that is no conflict leaves as the object
  it was thrown as, from the first attempt and from the third.
- _The arrival_, on stored facts and returned answers: an ordered message whose predecessor completes during its
  admission is admitted without being parked, delivered once and in order, with no retained `admit-message` row; an
  admission that loses exactly three writes is parked with its row, and its sibling that loses two is admitted with
  none; a readmission that waits for its first delivery answers `waiting` and is retained; a store failure that is
  no conflict is answered as the lane answers it today. The first of these also on PostgreSQL, where a row version
  decides, and through the WS server, where five sends of one track that each arrive during their predecessor's
  completion are delivered in order with no `pending-admission` answered.
- _The replay_: one whose write is lost admits its message in the same claim and hands it to its owner once; one
  that loses three goes back as `retry`; one whose authority refuses it after the first lost write is answered by
  that refusal.
- _The release_: one whose commit loses to an admission on its track releases its message in the same claim; one
  that loses three goes back as `retry` with its slot as it was; a predecessor that has not completed still answers
  `retry` at once.
- _The tests that pinned one lost write parking a send_ (the prototype moved 52 cases in 10 files): each is
  classified before it is touched and restated to arrange a send that loses every attempt; none is deleted or
  weakened, and a case that shows a change beyond this rule stops the work.
- _The measurement_, on the built code beside the head before it, with the same harness: the five ordered
  publishers for 20 s three times and 45 s once, one track at 2, 5 and 10 a second, and the two unordered cells.
  One track is also run at 3 and at 4 a second, which no run has covered, to place the limit. The five ordered
  publishers must meet the rule the unordered cells met in "Again, with the receipts' fence split and `admitted` on
  the socket"; the one-track cells are recorded as the limit, whatever they read, each with where its track stopped
  and how far behind its last message was read; the unordered cells must read as they did. The replay's and the
  release's fresh attempts were measured only together with the progress-row lever, where they added nothing
  measurable, so this measurement is their first without it. A figure that does not pass is a finding, reported with
  its numbers and not fixed in the measurement.

### 13. A completed delivery hands its track's next message on

**A design that waits for the maintainer's approval (ruling 16). Nothing of it is built.** It rests on a prototype
that was applied as a patch outside the tree and measured ("Why ordered tracks fall behind together"). The prototype
is not the design: where they differ is said below.

Section 12 keeps an ordered track on its fast path as long as one message's dispatch and completion fit inside the gap
to the next send. When they do not, the next message's delivery is found waiting for its predecessor and is set
aside, and nothing brings it back when the predecessor completes: it waits for the lane's rotation, seconds later, by
which time the message after it is waiting too. The track never returns to the fast path while its sender keeps its
rate, and every ordered track that shares the rotation falls behind with it. That needs no fault: a loaded host, a
database slower than +5 ms a statement, one slow completion or one fast sender is enough.

**The rule.** A claim whose delivery answers `completed` for a message on an ordering track states where its track's
delivery progress then stands. The batch that ran the claim, while it holds fewer than a page of claims, reads the
track's slot after that position; when that slot names a delivery row of the batch's own lane that is due, not
expired and reads ready now, the batch reserves the row exactly as it read it and runs it after the claims it already
holds. In every other case it reserves nothing and the row waits for the rotation, as it does today.

This is the rule the batch already has for a buffered track's releases (D190), widened from "a completed release
promotes the next release" to "a completed delivery hands on the next delivery, whichever kind it is". The release
rule becomes a case of it and its own lookup is deleted, so there is one rule and one lookup.

**Who claims.** The work batch of the lane that ran the completing claim: on a WS server, the instance whose worker
completed the predecessor, over the PostgreSQL store every instance shares; in a browser, the tab that owns the
session's work, over IndexedDB or over its memory pair; in a test, the memory stores. It is the same code in each
(`ALWorkHandler`, `ALInboundStoreLane`), as the release promotion is today.

**How the next message is found.** The store keeps one slot for every admitted, undelivered message of a track
(`<ns>:buffered:<track>:<seq>`), deletes it when the delivery completes, and records on it the work row that delivers
it (`delivery.effectId`): a `dispatch-local` row for a message admitted in order, a `release-buffered` row for one
that waited behind a gap. A dispatch row's id is made from the sender and the message id, so it cannot be computed
from a track and a sequence; the slot is the one index from a position to a row, and it exists already. The lookup is
one read of the slot at `completedThrough + 1`:

- _No slot_: the next message is not admitted yet, or the track continues after an omission (see the limits).
  Nothing more is read.
- _A slot that names no delivery row, or one whose carrier is another lane's_: nothing this batch may run. Nothing
  more is read.
- _A slot naming a delivery of this lane_: the row is read by its key. It is reserved only when it is not expired, is
  due (a new row, or a retried one whose delay has passed; a reserved row is due only at its lease's end), and its
  delivery reads ready now, by the same readiness read the rotation's page makes for it
  (`ALInboundAdmittedDelivery.readReadiness`: the stored message, its plan, the predecessor, a registered consumer).

Counted on PostgreSQL from the code, where every read of a session is its own statement: a completion whose track
has nothing waiting costs **one statement more** than today. One that hands a message on costs the slot read, the
row read, the readiness read (three statements for a dispatch with no supersedence key: the message, its owner row,
the track's progress) and one reservation transaction (a locked read and an update). The readiness read and the
reservation are what the rotation spends on the same row when it reaches it, so the addition a handed-on message
costs is two reads; what it saves is every rotation pass that read the row and set it aside (the probe counted 1 907
to 2 235 `waiting` readiness reads a run against 344 to 404 `ready`). Nothing is written that is not written today:
the only write is the row's reservation. The handed-on claim then reads its own surface at delivery, as a promoted
release does today; carrying the readiness read's surface forward, as a page's claim carries its own, would save two
statements a message and is left to the build to measure. No statement pin exists for any of this yet; the build pins
both shapes.

**Where the position lives.** In the return value, and nowhere else. The prototype kept a map on the delivery object,
from a claim's effect id to the position its completion had committed, read back by the batch and cleared at 1 024
entries: a memory across calls with a cap chosen by nobody. The design threads the position through the calls that
already return:

- `ALInboundOrderedDelivery.complete` answers `'completed' | 'retry'` today. It answers a `Completion`: `retry`, or
  `completed` with a `position` (`{ trackKey, completedThrough }`), which is absent only for a message on no ordering
  track. The position is the one the completion wrote (`completes`, which `completeOnce` computes before its write),
  or the one it read when it found the message already completed. `release` and the readiness's `completed` answer
  carry it the same way, each from the progress it read, so every `completed` of a delivery on a track states it.
- `ALInboundAdmittedDelivery.deliver` returns that same `Completion` (a forward answers `completed` with none).
- `ALInboundStoreLane.runInboundEffect`, which maps the delivery's answer to the work outcome today, maps a completion
  with a position to a result that carries it.
- `ALWorkHandler` passes it on. `ALWorkAttemptResult` gains one variant, a completed claim that names a succession,
  whose type is the owner's (a type parameter that defaults to `never`); the batch releases the row `completed` as
  for any completed claim and, under the same two conditions as now, calls `claimSuccessor(port, succession)` with
  it, where today it passes the completed claim. `ALWorkOutcome`, which the queue port and three owners share, does
  not change, and an owner that hands nothing on (the outbound lane, the receipt record's worker) cannot produce the
  variant and is not edited.
- `claimSuccessor` is the selector's, as now: the lookup and the reservation above, in the file that holds the
  release promotion today, renamed for what it then does. The slot read is one new read of the admission store,
  beside `readOrderedDelivery` in `ALInboundDurableEffectStore`, which already reads slots.

Nothing is remembered between claims, so nothing needs a cap; no object is given a callback or a setter; and a
succession that is never asked for (a full batch, a disposed lane) is dropped with the result that carried it. The
lookup sits behind the handler's existing guard for a successor claim, so a store failure in it is reported as a
batch failure and the completed claim stays completed. Putting the read inside the claim's own run, to hand the
handler a plain row key and spare the type parameter, was considered and rejected for that reason: a failed
best-effort read would turn a committed completion into a retried row.

**What bounds it, and what enforces each bound.**

- _A batch never runs more than a page._ `ALWorkHandler.claimSuccessors` asks for a successor only while the batch's
  claimed count is below `pageSize` (16, `AL_INBOUND_WORK_PAGE_SIZE`), and counts each one it takes. This is the bound
  the cheaper form broke. Pinned today by the 64-message drain and by the handler's own page-bound case.
- _One claim per row._ The row is reserved through `ALWorkQueuePort.claimObserved`, which reserves a row only while
  it is still new or retrying and is the very row that was read (a row version on PostgreSQL, taken with
  `FOR UPDATE SKIP LOCKED`; the stored value in memory and on IndexedDB), and only a row of the lane's own work type.
- _The lease._ The reservation is the ordinary one: 10 s from the moment it is made, which for a handed-on row is
  when its predecessor completed, later than the rest of its batch.
- _The rotation's cursor._ The lookup reads one slot and one row by key. It reads no page, so
  `ALInboundRotationPage`'s position and its owed head read are where they were, and the scan order NEW, RETRY,
  RESERVED is untouched. It never runs the lease-timeout sweep.
- _Readiness is decided twice, from the store._ At the claim, as above; and again at dispatch, where an ordered
  message asks its track once more (`readOrderedDispatchOutcome`), as every dispatch does. Order is never taken from
  the hand-on: a message is dispatched only when the store says its predecessor completed.
- _Within the batch, nothing is overtaken._ A handed-on claim is appended to the batch's queue, so every claim the
  batch already holds runs before it, another track's deliveries, replays and control sends among them. Several
  lagging tracks in one batch are therefore served in turn, one message each per round.

**Fairness, stated plainly.** A handed-on row goes ahead of the rotation: ahead of the rows on pages the rotation
has not reached, the retried rows it reads after every new one, and whatever the next batch would have claimed. A
release successor already does exactly that, and a 255-message buffered track already fills 17 batches in a row. What
is new is that the steady traffic of an ordered track qualifies too, and that it has no natural end: a sender that
keeps offering more than its track carries can keep every batch of the lane at a full page for as long as it sends.
What that sender can do: make each batch take a full page's time, so the rotation's next page, and an arrival that
commits while the batch runs, wait up to 15 more claims than they would have. What it cannot do: run more than a page
in a batch, run ahead of a claim the batch holds, take the rotation's next page (the batch after reads the page the
rotation stood at, not the track), or reserve a row that is not its own track's next. No measured cell mixes an
over-driven track with other traffic; the proof below adds one.

**What happens when the next message is not there to hand on.** Each case reserves nothing and changes no row:

- _Not admitted yet._ No slot. When it is admitted, its predecessor has completed, so its own commit's batch reads
  it ready and claims it at the head of the queue: the fast path, as today.
- _Held by another owner._ The row is reserved (another instance's batch, or this one's), so it is not due.
- _Reserved between the read and the reservation._ The reservation finds the row changed and takes nothing.
- _Not ready._ No consumer is registered for it, its plan asks for a retry, or its predecessor is, after all, not
  the completed one. It waits for the rotation.
- _Behind a gap._ The message at the next position is the missing one, so there is no slot. The copies buffered
  after it have no row until the gap closes; then each has a release row, its slot names it, and the hand-on finds a
  release as it finds a dispatch.
- _Expired._ Not reserved. The track then ends as it does today: the message after it reads a gap with no
  predecessor and the track ends `resync-required`. A hand-on never skips a message.
- _The track ended, or its progress row is gone._ The next message's readiness reads `resync-required`, which a
  claim is allowed to take in order to reject it, by the rotation's page today and by the hand-on alike.
- _The batch is full, or the lane is being disposed._ Not asked.
- _The completion did not commit._ It answered `retry` and stated no position.

**With the four owners of section 12.** An arrival, a replay, a release and a completion each try a lost write again
at once. The hand-on writes nothing but a reservation, so it loses no write and makes none of theirs lose.

- _An arrival that retries while its predecessor's completion hands on._ The two commits are ordered by the store.
  If the arrival's admission commits first, its row exists when the completion's batch reads the slot afterwards, and
  the batch claims it. If the completion commits first, an arrival that had read the old position loses its write,
  and its fresh attempt reads the new one and commits; either way its own commit's batch finds its predecessor
  completed. In the window between, both batches can try for the row; one reservation wins. A lost attempt wrote
  no slot and no row, so the lookup cannot find half an admission.
- _A completion's fresh attempts._ Only the attempt that commits states a position. A completion that loses all
  three states none and its row goes back as work, as today; its successor keeps waiting, since its predecessor has
  not completed.
- _A replay or a release that commits in a later attempt_ announces its work as it does today; a release that
  completes hands on like any delivery.

Can a message be handed to the application twice because of this? No more than today: a row is dispatched by the
one batch that holds its reservation. The three cases that hand a delivered message over again are unchanged: every
completion attempt lost, a shutdown or a crash between dispatch and completion, and a lease that ended while its
batch was still running. The last is the one to watch: batches reach a full page more often, and a claim reserved
with its page still runs up to 15 claims after its reservation, as in any full page today. Out of order? No: the
store decides order at dispatch. Never? The hand-on is an addition, not a replacement: a row it does not take is
found by the rotation exactly as it is now.

**Two server instances.** Arrival `n + 1` is admitted through instance B while `n` is still being delivered by
instance A. B's batch reads the new row, finds its predecessor waiting and sets it aside without reserving it. When
A's completion of `n` commits, A reads the shared slot, finds the row B's admission wrote, and reserves and
dispatches it on A. That is nothing new: any instance's rotation already claims any instance's rows, and A's
readiness read asks A's own dispatch port whether it can deliver. If B's rotation reaches the row at the same
moment, one reservation wins and the other takes nothing. The room fan-out then leaves from A.

**In the browser and on an RTC receiver.** The rule runs there: the lane and the handler are the shared ones, over
IndexedDB for the session's durable pair and over memory for its volatile pair, for the WS client and for an RTC
receiver alike.

- Nothing stored changes shape, and no message, control or diagnostic gains a field. The `effect-drain`
  diagnostic's `promoted` now counts every delivery a batch ran by hand-on, where it counted releases.
- An ordered completion makes one more IndexedDB read (the slot); a hand-on makes that, the row read, the readiness
  reads and one reservation write, each its own short transaction, as the release promotion does today. A browser
  is one thread: the hand-on runs between the completion and the batch's next claim, in the same task chain.
- A relay's forwards are not gated on ordering and are not handed on. Only local delivery is.
- A session's durable work is run by the one tab that owns it; that does not change.
- **The bundle budget will be passed.** `browser/rallar.ts` measures 332.813 of its 333 KiB, 0.187 KiB of headroom.
  The prototype was not bundled, so its size is not known; from its 74 source lines, less the release lookup this
  design deletes, the estimate is 0.2 to 0.5 KiB compressed. The budget is raised to the smallest whole KiB above the
  measured figure, in a commit of its own, as before. The headless bundle (434.203 of 435) may hold.
- Not measured in a browser, on IndexedDB or over RTC: every cell runs the server's lane on PostgreSQL.

**What it does not do.**

- _It does not make one track carry more than its delivery cycle allows._ Measured with the prototype on a quiet
  host: one track keeps up at 3 a second in every run and completes 80 of 80 at 4 a second in both runs, its last
  message read 1.5 and 3.8 s behind (the built code: 41, 80, 43 and 80 of 80); at 5 a second it completed 20 and 69
  of 100, and at 10 a second 4 and 3 of 200. At 10 a second the sends that are parked at admission dominate, which
  this does not touch. The limit of one ordered track stays, a little higher and less sharp.
- _It hands nothing on from a full batch._ A lane whose pages are full of claimable work promotes nothing and behaves
  as built. The measured cell left room (94 to 164 successors found a run, 85 to 164 claimed). More publishers or
  more unordered traffic on one lane were not run.
- _It stops at the page._ A long backlog is drained up to a page at a time; between batches the track waits for the
  rotation again. In the loaded runs the worst lag of a run was 0.8 to 5.1 s and a lagging track caught up again, a
  sawtooth, where the built code's lag climbed to the lifetime.
- _It does not follow an omission._ When the track's next message for this receiver is not the next sequence (the
  sender left this receiver out of one), no slot stands at `completedThrough + 1` and the next copy waits for the
  rotation, as today. Finding it needs a read of the track's slots, which is not proposed.
- _It does not reach across carriers._ A successor that arrived on the other carrier belongs to that carrier's lane.
- _It does not change the rotation's scan order,_ the retry policy, the lease, or what an admission writes.
- _It does not order the room fan-out on the wire._ The measurement's recipients are raw sockets, and they read
  frames of one track out of order when two hand-offs lie close together (14 in one run of the built code, 9 to 42
  with the cheaper form, none with the prototype of this design): the WS server's fan-out to a room writes each
  message on its own and keeps no order between two. A Rallar receiver restores the order from its own buffer.
  Older than this work and a separate question; this design neither fixes nor relies on it.

**The tests it moves.** The prototype turned three cases red in a sweep of 3 754, all in
`al-inbound-release-promotion.test.ts`, each a pinned count that the rule changes by design. No delivery-order
assertion failed and no batch ran more than a page.

- _"delivers a buffered track in sequence order, each release promoted only after its predecessor delivered"_ pins
  that a batch promotes no more releases than it ran behind their own track's previous release. Old reading: 14 of a
  batch's releases follow a release, 14 at most are promoted. New: 15 are, because the dispatch of the message that
  closed the gap hands on the first release. Restated to count a delivery behind its track's previous delivery,
  whichever kind. The delivered order, 1 to 21, is asserted unchanged.
- _"drains a 64-message buffered track in 5 batches, none running more than a page"_ pins the batches' sizes as 1,
  16, 16, 16, 16 and their promotions as 0, 15, 15, 15, 15. New: sizes 16, 16, 16, 16, 1, for the same reason, and
  by that reasoning promotions 15, 15, 15, 15, 0 (the run stopped at the sizes). Five batches, none above a page, 65
  delivered: unchanged.
- _"promotes a release only behind its own track's predecessor, with two tracks draining together"_: the same count
  as the first, 11 where 10 was the bound. Restated the same way; each track's order is asserted unchanged.

Also restated, not shown red by the prototype because it kept the handler's contract: the five cases of the work
handler that pass a `claimSuccessor` (`al-work-handler.test.ts`, `al-work-handler-disposal.test.ts`), whose fake
owners return the new result; what they assert (run order, the page bound, a throwing successor claim is reported
and strands nothing, a successor reserved during disposal is released unrun) stays. The fixtures that pass
`claimSuccessor: undefined`, about fifty, are not edited. A PostgreSQL statement pin or an IndexedDB operation count
of an ordered delivery gains one read; the prototype was not run on those lanes.

**The cases that would pin it**, on stored facts and on the subscriber's received list:

- _A held completion with a waiting successor._ `n` is dispatched and its completion held; `n + 1` is admitted
  meanwhile and its batch sets it aside; the completion is let go. The subscriber then holds `n`, `n + 1`; one batch
  names both rows in order with one promotion; the successor's row is completed after one attempt; no row went back
  as a retry and no rotation pass lay between.
- _The page bound, in order._ 64 messages of one track admitted in order behind a held first dispatch: every batch
  claims at most a page, the subscriber receives 1 to 64 in order, each once. And a batch whose selection already
  filled the page hands nothing on.
- _Other claims first._ A batch that holds another track's delivery and an unordered one runs both before the
  handed-on successor.
- _Two instances._ On shared stores and on PostgreSQL: the arrival admitted through B, the predecessor completed on
  A, the successor delivered once, by A, with one attempt; and with B's rotation racing A's hand-on, exactly one
  hand-over.
- _A successor not yet admitted._ The completion's batch reads one slot and nothing else (the statement pin), and
  the message that arrives afterwards is delivered by its own commit's batch.
- _Each refusal above_: a row reserved elsewhere, not due, expired, not ready, on another carrier, a slot with no
  delivery. Each leaves the row's status, attempts and version as they were.
- _A completion that loses every attempt_ hands nothing on. _An unordered delivery_ makes no read. _A lookup that
  throws_ is reported as a batch failure; the completed claim is released completed and the batch's other claims
  run.
- _Through the WS server_: five sends of one track, each arriving while its predecessor's completion is held, are
  delivered in order, each once, with no retried row.

**How it is proven**, on the built code beside the code before it, with the harness of section 12:

- _The loaded cell that failed._ Five ordered publishers for 20 s at +5 ms, three WS server instances, with eight
  CPU burners (`yes > /dev/null`) started 45 s before the run and stopped after it, which on the measuring machine
  gave a 1-minute load of 6 to 12 at a run's start; the load is recorded with every run. Three runs a column, the
  columns back to back. It passes when every run of the built code completes 200 of 200 by the deadline, makes no
  retried row, ends no track `resync-required`, hands no message to the subscriber twice or out of its track's
  order, and runs no batch longer than its 10 s lease (the largest `effect-drain` duration is recorded). The
  recipients' read, p50 and largest, and each track's lag over the run are recorded.
- _The quiet cells_ must read as they did: five ordered for 20 s and for 45 s, and the two unordered guards.
- _The one-track bracket_, 2, 3, 4, 5 and 10 a second, is recorded as the limit, whatever it reads, with where each
  track stopped.
- _Two cells no run has covered_, recorded whatever they read: the five ordered publishers on a quiet host at
  +10 ms, to test that a slower database alone produces the stall and that the rule answers it; and one track at 5 a
  second beside the five unordered publishers, to read what an over-driven track now costs other traffic.
- A figure that does not pass is a finding, reported with its numbers and not fixed in the measurement.

**Alternatives considered.**

- _Bring the successor's row due and ask for a head read_ (the cheaper form, prototyped). On a committed ordered
  completion the lane named the successor's row to the running batch through `expedite()`. It removed the stall too
  (200 of 200 in three loaded runs). Rejected: an expedited row is claimed before the batch's next claim and outside
  the page count, so one track's backlog drains in a single batch (the 64-message case ran one batch, not five) and
  goes ahead of every claim the batch holds. It also needed the lane to hand the delivery a callback at
  construction. And one track at 4 a second read its last message 14 to 15 s behind, against 1.5 to 3.8 s.
- _Change the rotation's scan order_, reading due retried rows with every page of new ones (section 12, "Not built").
  It does not address this: the waiting row is a new row, not a retried one. Prototyped earlier, it took one track at
  5 a second from 16 to 17 completed to 2 of 100 and showed frames read twice, neither explained.
- _Do nothing and state the limit._ Honest, and what section 12's limit already does for one fast track. But the
  limit to state would be that five publishers at 2 a second each, the cell section 12 measured as keeping up, stop
  keeping up when the host is busy or the database is slower than the measurement's, and that all tracks of a lane
  stop together.

**Its size and its risk.** About 130 production lines changed in nine files of `packages/shared/alm`: the two
delivery classes' return types (about ten return sites) and the readiness's, one store read, the successor claim
rewritten around it, the selector's and the lane's wiring, and the handler's one variant. Three test cases restated,
five handler cases adapted, about a dozen new cases, two of them on PostgreSQL; the inbound README's
release-promotion paragraph, the diagnostic documents and a decision row. Five tasks: the completion states its
position (no behaviour change); the handler passes a succession on; the successor claim; the PostgreSQL and WS server
cases with their statement pins; the measurement, the documents and the budget.

What could make it larger:

- _Files already over the standard._ `dispatchAdmittedMessage` (60 lines) and `reject` (52) are older than this work
  and longer than a function may be, and `al-work-handler.ts` and the lane are large files. A change in them can
  require the split first, as section 12 did for `attempt` and `release`.
- _The conformance lane's observation._ Its artifact sums `promoted` as `promotedReleases`, and four documents
  describe the count as releases. The count stays one number; its name there, the documents and the committed
  snapshot follow.
- _Lanes the prototype was not run on_: the PostgreSQL integration lane, the black-box recipes, the ALM lane.
- _A finding of the mixed cell._ If an over-driven track is shown to slow other traffic, a bound on how many
  messages one track is handed in a batch is a new parameter and a new decision.
- _The sawtooth._ If the wait between two batches matters, asking for a head read when a hand-on stopped at the page
  is the next lever. It is not in this design and was not measured.

Not shown, beside the limits above: the prototype's result rests on three loaded runs, in which the built code
beside it also completed 200, 193 and 200 (with reads of up to 29.6 s), where it completed 109 to 155 in six other
loaded runs; the design's lookup for a release (through the slot, where the prototype kept the release's computed
key and fell back to the slot) is not the prototype's and costs one read more per promoted release; and nothing here
was run in a browser.

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
  it is quoted in the pull request. Met on the built code: with the receipts' fence split and `admitted` on the
  socket no cell backlogs, five publishers at +5 ms included ("Again, with the receipts' fence split and `admitted`
  on the socket"). Before that fix, five publishers at +5 ms backlogged in the receipts' delivery, every receipt
  commit fenced on the server's one sender-version row (section 10), while one publisher at +0 and +5 ms (run 1 at
  the edge, 1.51) and five publishers at +0 ms showed no backlog. Measured by test-only code, not kept
  in the tree: "Measured on the built record" runs the record alone, and "Measured through the WS server" the
  built path.
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
5. Proofs, recipes, documents: the backlog lines this closes removed, decision rows D770 to D779, the
   outbound and WS server READMEs, the product description. Its run through the WS server found that five
   publishers at +5 ms backlog in the receipts' delivery ("Measured through the WS server").
6. The receipts' delivery (section 10): a dispatch whose decision read no row its sender's messages share fences
   on its own message's version only, and the `admitted` receipt is written on the admitting socket, with its
   outbox row as the fallback. Built in this pull request (ruling 7), and the five-publisher cell at +5 ms run
   again on it. With it, the completion of an ordered delivery guarded on its position and its slot (section 11,
   ruling 12).
7. Built. An ordered arrival that loses its write looks again at once, and so do a replay and a release (section 12,
   rulings 11, 14 and 15): the rule, the tests it moved, the measurement on the built code and decision row D784.
8. A completed delivery hands its track's next message on (section 13, ruling 16). Designed; not built unless the
   maintainer approves section 13. Then: the rule, the tests it moves, the measurement on the built code, the
   documents and its decision row, the gates on the final head, and this file's deletion.

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
  five publishers and +5 ms (71 ms from the last ACK, flat); the backlog was in the receipts' delivery, on the
  server's one sender-version row every receipt commit fenced on (section 10), not in the count.
- An ACK's provenance is proven once, in the hook: with no head, the inbound admission row must hold the message
  under that origin with the ACK's sender in its audience (the volatile store's answer, and the durable store's
  when the volatile one has none). The count then answers a missing head with `countAhead` without a second proof.
  The server's own `not-sent` needs no proof.
- The ACK relay class left in slice 2, not slice 3: it read the memory aggregate, and none of those reads has a
  meaning on a record every instance shares. Slice 3 deletes what is then unreferenced.
- The fence rule of section 10 reaches every dispatch whose decision read no row its sender's messages share, not
  receipt controls alone (ruling 10): receipts, the server's handed-off controls, its unsequenced publications and a
  client's plain broadcast, on the browser as on the server. The flag is derived from the decision's read, not from
  the message's type. The investigation measured receipt controls only.
- A message end, an ACK window, a first-hop commit and the not-yet-in-sync retry schedule keep the sender fence:
  they are not dispatch decisions, and the schedule is fenced against an end only through that row. The one stray
  `nack-retry` this leaves, for a message that ended by a commit that no longer moves the row, answers
  `message-ended` and writes nothing. The lever, not built: the same derivation for those commits, with the
  schedule fenced on the message's version.
- Only an `admitted` with a head behind it goes live. One that expects nobody is the send's terminal settlement at
  the origin and has no head to answer a re-sent copy, so it keeps its outbox row, as every terminal receipt does.
- A send with no first-hop wait (retry `none`, or a kept send whose wait the `not-yet-in-sync` NACK ended) gets no
  row kept for its live `admitted`: the row never promised more than one socket write, which the live send is, and
  the server cannot read the origin's plan.
- A live `admitted` records one `receipt-transport` observation per connection it was written to, the existing kind
  with no field added, and no `receipt-outbox`, which stays the enqueue of an issued receipt.
- Section 12's fresh attempts share one function, one bound of three and one policy with the completion's, not a
  bound for each owner: no measurement asks for different bounds, and a bound of its own is a parameter added the
  day one does.
- An arrival's fresh attempts run under the source its caller authorized for that call and do not ask the carrier's
  authority again; a replay's ask its authority again each time. The carrier's authority is read above the inbound
  runtime, and the attempts end inside the call it authorized.
- A readmission that waits for its first delivery answers `waiting`, a kind of its own, where it answered the lost
  write's `conflict`: the smallest change that lets "only a lost write is tried again" be read from the answer.
- The resynchronization NACK's lost write and the control admission's stay as they are: neither is on the measured
  path.
- `attempt` and `release` are split into their phases before they change, with no change of behaviour, because both
  exceed the function length the standard allows.
- Section 13's, a design that is not built: a buffered release and an in-order delivery are handed on by one rule
  and one lookup, and the release's own lookup by its computed key is deleted, at the cost of one more read per
  promoted release.
- Section 13's: the position a completion leaves travels as a return value, through one type parameter of the shared
  work handler, and is kept nowhere. The handler stays ignorant of tracks.
- Section 13's: a handed-on delivery counts against the page and runs after every claim its batch already holds.
  No further bound per track is set until a measurement asks for one.
- Section 13's: a track that continues after an omission, a successor on another carrier and a full batch are left to
  the rotation, as today.

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
  conflict and 314 ms for one that conflicted on the fence (20 of 80 in that run) and waited for its replay.
- **At +0 ms both cells keep up**, ratios 0.79 to 1.05, every message `complete` within 50 ms of its last
  ACK, one enqueue in all retained `pending`.
- **Where the lag is.** Eight further runs at the same shape timed each stage. Five ran after the matrix: one
  each of one publisher at +0 and +5 ms and five publishers at +0 and +5 ms (load 2.5 to 2.4), and five
  publishers at +5 ms once more (load 7.5 to 4.6). Three more ran five publishers at +5 ms with the pool, the
  outbound commits and the outbound worker instrumented (load 0.7 to 1.6). At five publishers and +5 ms, over
  the five runs of that cell:
  - **The count keeps up.** A message's last ACK reached a complete count in 70 to 73 ms, first ten and last
    ten alike, and the `end` and its ended work reached the receipt enqueue 170 to 420 ms later (p50 173 to
    289 ms over the first ten, 285 to 418 ms over the last ten). That stage grew in each run, by 64 to 227 ms,
    small beside the 7.8 to 8.9 s by which the wait from the terminal enqueue to the read grew.
  - **The enqueue attempts did not grow.** Send to the `admitted` enqueue took about 205 ms (p50 189 to 211 ms
    over the first ten, 195 to 207 ms over the last ten).
  - **The growing term lies after the receipt enqueue, where every receipt commit waits on the server
    identity's fence.** From the terminal enqueue to the publisher's read took 1.1
    to 2.5 s over the first ten and 9.1 to 11.3 s over the last ten; the `admitted` receipt, which no ACK
    precedes, grew the same way (0.4 to 0.8 s, then 9.6 to 12.0 s). 75 to 80 % of the receipt enqueues
    conflicted on the fence of the server's outbound version row (74 to 79 % in the matrix above). Those that
    did not conflict also waited: 6.9 to 8.7 s from their enqueue to the read over the last ten (p50, in six
    of seven groups of one to four receipts, the run at load 7.5 to 4.6 giving one; 2.3 s in the seventh, of
    three receipts), and 3.3 to 6.8 s over all 200 messages (p50, in eight groups of 26 to 59 receipts).
    Publishers read 8.1 to 9.8 receipts a second while the sends ran, against 20 offered.
  - **The pool does not account for it.** In the instrumented runs a transaction waited 0.6 ms from its
    `begin` to its callback (the median per instance and second; at most 1.2 ms), a statement took 0.8 ms
    in or out of a transaction (at most 1.3 ms), and at most 8 or 9 of an instance's 10 connections were
    inside a transaction at once, flat across the run. Outstanding autocommit statements on an instance
    peaked at 14 to 17 against its pool of 10.
  - **A replay's own commit does not account for it.** In the instrumented runs a conflicted enqueue's replay
    committed at its first attempt in 85 to 88 % of cases (1.13 to 1.16 attempts each), a replay commit took about 28 ms
    early and late in the run, and the server's commit queue on an instance never waited more than 1 ms.
  - **The wait shows in the drain.** The investigation of section 10 isolated its cause: every receipt commit of
    every instance fenced on the server's one sender-version row, so the receipts formed one serialized queue on
    it. Each instance's one outbound worker runs one batch at a time, and
    within a batch its claims one after another, except that the batch's dequeued rows are admitted together
    (`run-al-outbound-dequeue-claim-group.ts`). In the instrumented runs it was busy throughout: 19 to 24
    batches of 0.79 to 0.96 s each (the mean per instance), back to back over the 18 s of sends, nearly all
    full pages of 16 (17 to 24 of them), at 44 to 56 ms a claimed row, with 13 to 26 % of its claims
    rescheduled. It completed 13 to 17 rows a second while the sends ran and 11 to 17 after they stopped. Its
    own queue wait is not observed (the outbound owner claims without reading a page), so saturation is read
    from that; replay and dequeue are told apart by each receipt's order of commits, not by a field. Across
    the three instances receipt replays committed 9.2 to 10.0 a second and receipt dequeues 13.4 while the
    sends ran, and 12.2 to 12.4 and 13.6 to 13.9 after, until the queue was empty. From the enqueue, or from
    the replay, to the dequeue commit took 0.10 to 0.57 s (p50), over the first ten and the last ten alike,
    in all 12 groups. The wait grew around that step. A conflicted receipt waited for its replay 0.3 to
    0.8 s over the first ten and 6.9 to 7.9 s over the last ten, then 1.9 to 3.3 s from its dequeue commit
    to the read over the last ten. An unconflicted one, which has no replay, waited 0.2 to 0.9 s from its
    dequeue commit to the read over the first ten, and over the last ten 6.8 to 8.0 s in five of six groups
    of two to four receipts (1.9 s in the sixth): longer after the dequeue than a conflicted receipt. The
    fence adds a replay claim to the worker's work for each receipt that conflicted; every receipt waits in
    the worker.
  - **The room messages share the drain, not the identity.** Their commits are under their publishers'
    identities, none under the server's, but each instance's one outbound worker drains them beside the
    receipts. Send to the last ACK offered: p50 0.50 to 0.58 s over the first ten and 0.65 to 1.05 s over the
    last ten, p95 6.2 to 6.9 s and max 8.9 to 15.0 s over all 200, in the four runs that timed it.
- **The numbers point at the receipts' delivery, not the count.** Section 10 found the cause in the one fence
  row and built the fix there; delivering the receipts from the record's own work rows was weighed and not
  taken. The `end` and its ended work (170 to 420 ms) stay in any delivery, so no fix brings the lag to the
  record alone's 60 ms. The count keeps up, so counting at `admitAuthorizedMessage`, a per-instance head cache
  or a single-statement unfenced write would shorten a lag that does not grow.
- At +5 ms the last ACKs of almost every message overlap: 183 to 192 losing `end`s for 200 messages at five
  publishers, 34 to 44 for 40 at one. No losing `end` delivered a second terminal receipt.

### Again, with the receipts' fence split and `admitted` on the socket

Same shape as above, at the branch's head (built) and at the commit before the fence split and the live `admitted`
(control). Every built run ran directly after a control run of the same cell and latency, on one machine whose
1-minute load stayed between 1.0 and 3.7 throughout, far below the 8 to 33 of the investigation's runs. A third cell,
five publishers with the server's own: the five publishers as they are, and instance a publishing a receipted room
publication of the server's own every 500 ms (40 in the 20 s), each on one track (`ordering: { orderingKey, epoch:
0, seq }`, ACK `receiver`), every one of the 15 sessions acknowledging it on its own instance. That publication fences
on the server's version, so the outbound worker's batches mix it with receipt controls that do not.

`admitted` is timed from the send to its read on the publisher's socket, whether it came there from the socket write
on the admitting instance or from an outbox row; `complete` from the message's last ACK offered to its read. Seconds,
p50 / p95; the ratio is the last ten's p50 over the first ten's. Read/s counts the receipts the publishers read while
the sends ran, against the receipts offered in that window. Conflicts are the receipt controls' replay and dequeue
commits that ended `conflict`, of all such commits. Ranges are over the runs of a row.

| Cell, latency, sends                    | Tree    | Runs | Complete by deadline | `admitted` first / last 10 | Ratio     | `complete` first / last 10 | Ratio     | `admitted` > 8 s | Read/s of offered | Statements a message | Enqueues retained | Replay / dequeue conflicts |
| --------------------------------------- | ------- | ---- | -------------------- | -------------------------- | --------- | -------------------------- | --------- | ---------------- | ----------------- | -------------------- | ----------------- | -------------------------- |
| One, +0 ms, 20 s                        | control | 3    | 40 of 40 each        | 0.08 / 0.07                | 0.85-0.94 | 0.04-0.05 / 0.04           | 0.84-0.92 | 0                | 4.0 of 4.1        | 376-417              | 0 of 80           | 0 / 0                      |
|                                         | built   | 3    | 40 of 40 each        | 0.02 / 0.01-0.02           | 0.68-0.80 | 0.05 / 0.04                | 0.82-0.87 | 0                | 4.0 of 4.1        | 326-354              | 0 of 40           | 0 / 0                      |
| One, +5 ms, 20 s                        | control | 3    | 40 of 40 each        | 0.41-0.48 / 0.41-0.48      | 0.95-1.01 | 0.43-0.47 / 0.36-0.42      | 0.84-0.88 | 0                | 3.9 of 4.1        | 375-382              | 0 of 80           | 0 / 0                      |
|                                         | built   | 3    | 40 of 40 each        | 0.15 / 0.14-0.15           | 0.97-0.99 | 0.38-0.44 / 0.43-0.44      | 0.97-1.15 | 0                | 3.9 of 4.1        | 287-311              | 0 of 40           | 0 / 0                      |
| Five, +0 ms, 20 s                       | control | 3    | 200 of 200 each      | 0.04-0.08 / 0.03           | 0.41-0.87 | 0.02-0.06 / 0.02-0.03      | 0.41-0.97 | 0                | 19.9-20.0 of 20.1 | 347-354              | 0 of 400          | 0 / 0-1                    |
|                                         | built   | 3    | 200 of 200 each      | 0.01 / 0.01                | 0.70-0.95 | 0.02-0.04 / 0.02           | 0.61-0.91 | 0                | 19.9-20.0 of 20.1 | 310-314              | 0 of 200          | 0 / 0                      |
| Five, +5 ms, 20 s                       | control | 3    | 111-124 of 200       | 0.98-1.44 / 18.4-18.9      | 12.9-18.7 | 3.7-4.7 / 18.4-19.6        | 3.9-5.3   | 166-173          | 3.6-3.7 of 20.1   | 343-351              | 225-231 of 400    | 39-40 % / 19-21 %          |
|                                         | built   | 3    | 200 of 200 each      | 0.15-0.17 / 0.13-0.14      | 0.82-0.88 | 0.51-0.56 / 0.42-0.47      | 0.79-0.92 | 0                | 19.5 of 20.1      | 223-225              | 0 of 200          | 0 / 0                      |
| Five, +5 ms, 45 s                       | control | 1    | 66 of 450            | 1.36 / 36.8                | 27.1      | 6.8 / 36.4                 | 5.3       | 416              | 3.6 of 20.0       | 321                  | 536 of 900        | 45 % / 19 %                |
|                                         | built   | 1    | 450 of 450           | 0.17 / 0.13                | 0.78      | 0.54 / 0.45                | 0.84      | 0                | 19.8 of 20.0      | 226                  | 0 of 450          | 0 / 0                      |
| Five with the server's own, +5 ms, 20 s | control | 3    | 80-99 of 200         | 1.33-1.85 / 19.3-28.2      | 13.8-15.3 | 4.0-7.7 / 20.0-27.0        | 3.5-5.1   | 175-179          | 2.7-3.1 of 20.1   | 414-416              | 224-243 of 400    | 34-36 % / 16-18 %          |
|                                         | built   | 3    | 200 of 200 each      | 0.16-0.17 / 0.13-0.14      | 0.77-0.87 | 0.54-0.61 / 0.46-0.57      | 0.84-1.01 | 0                | 19.4-19.5 of 20.1 | 243-245              | 0 of 200          | 0 / 0                      |

No run of either tree ended a publisher's room message `timed-out` or read a second terminal receipt for one;
the control's runs ended 3 of the server's own 120 publications `timed-out` (below). The built tree's
enqueues are the terminal receipts alone: every `admitted` in every built run (40, 200 or 450 a run) was written to
the publisher's socket on the admitting instance and none became an outbox row.

The server's own publications:

| Tree    | Run       | Receipts `complete`                                          | Enqueues retained  | Dequeue commits `conflict`     | Dequeue batches written as two groups                                                      |
| ------- | --------- | ------------------------------------------------------------ | ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------ |
| control | 1 / 2 / 3 | 0 / 2 / 0 of 40 (2 and 1 `timed-out`, the rest never opened) | 33 / 36 / 35 of 40 | 53 of 72 / 46 of 77 / 37 of 63 | none (no dispatch fences only its message)                                                 |
| built   | 1 / 2 / 3 | 40 / 40 / 40 of 40                                           | 0 of 40 each       | 0 of 40 each                   | 25 / 22 / 28, each its publication's group beside receipt controls; no group's write threw |

- **The built tree keeps up in every cell measured.** All 16 built runs meet the rule: the last ten's p50 within 1.5
  times the first ten's for `admitted` (ratios 0.68 to 0.99) and for `complete` (0.61 to 1.15), every `admitted`
  read within 8 s (the slowest 0.38 s), every message `complete` before its deadline, and the receipts read at 95 to
  99 % of the offered rate (one publisher 3.9 of 4.1, the closest to the line). The ratios are of small figures: at +0 ms the p50s are 10 to 50 ms, so one scheduling
  pause moves them, and the largest built ratio (1.15, one publisher at +5 ms) is 0.44 s over 0.38 s.
- **The control backlogs as before**, on this quiet machine too: five publishers at +5 ms read `admitted` 18 to 19 s
  late over the last ten and 111 to 124 of 200 messages `complete` by their deadline; over 45 s only 66 of 450, the
  last ten 37 s late. The built tree ran the same 45 s at its 20 s figures (`admitted` 0.13 s, `complete` 0.45 s over
  the last ten), so the deadline rows that come due in a longer run cost it nothing visible.
- **The split is exercised and holds.** With the server's own sequenced publications in the cell, 22 to 28 of about
  306 dequeue batches a run held both kinds and were written as two groups, the publication's on the server's version
  and the receipt controls' on their own; none of those writes threw, and no publication's dequeue conflicted. Under
  the control the same publications lost their fence in 59 to 74 % of their dequeue commits and at most 2 of 40
  receipts completed. The added publications cost the built five-publisher figures nothing beyond about 20
  statements a message.
- **What a receipt now costs**: 223 to 226 statements a message at five publishers and +5 ms, against 343 to 351
  for the control and 234 for the investigation's prototype of the fence alone, with no receipt enqueue retained and
  no receipt commit conflicting.
- The harness also counted, on the built tree, the messages the server's in-process subscriber was handed more than
  once (none of 40 to 450 a run) and the inbound ordered completions; no message arriving in these cells carries an
  ordering (the publishers' room messages have none, and the server's own publications go out, not in), so no
  ordered delivery or completion took place and the cell says nothing about the completion's retries.

### Ordered room messages

The same shape, with every room message ordered (`ordering: { orderingKey, epoch: 0, seq }`, one track per
publisher) and receipted, so each arriving message goes through the inbound ordered delivery and its completion. Built:
the branch's head; control: the commit before the completion's narrowed guard, its fresh attempts and the live
`admitted` (one attempt, fenced on the whole observation). Each built run ran directly after a control run of the same
cell; the 1-minute load stayed between 1.5 and 6.0 (6.0 only at the end of the built 45 s run). Counted at the WS
server's in-process subscriber (the router subscriber the harness registers, on whichever instance claimed the work):
the messages it was handed more than once; at every `complete` call, its completion writes and answer; and at each lost
write, whether an admission's expiry refresh of the same track's progress row committed inside its window. Recipients
read frames on their sockets. Five publishers send one message every 500 ms each; the fast track is one publisher at
30.3 to 30.4 a second (the harness offers it steadily: sends at most 82 ms late).

| Cell, latency, sends                | Tree    | Runs | Handed to the subscriber | Handed more than once        | Completions in 1 / 2 / 3 attempts, handed back | Complete by deadline | `admitted` > 8 s or never | Recipients' read, send to last ACK offered, p50 | Recipients out of order |
| ----------------------------------- | ------- | ---- | ------------------------ | ---------------------------- | ---------------------------------------------- | -------------------- | ------------------------- | ----------------------------------------------- | ----------------------- |
| Five, +5 ms, 20 s                   | control | 3    | 75-93 of 200             | 3-11 (3.3-14.7 %), up to 3 × | 74-93 / 0 / 0, 4-12 handed back                | 26-34 of 200         | 148-159                   | 6.3-26.0 s                                      | 70-252                  |
|                                     | built   | 3    | 200 of 200 each          | 0                            | 197-198 / 2-3 / 0, none handed back            | 200 of 200 each      | 5-6                       | 12.9-16.7 s                                     | 0                       |
| Five, +5 ms, 45 s                   | control | 1    | 40 of 450                | 4 (10 %), up to 3 ×          | 37 / 0 / 0, 8 handed back                      | 29 of 450            | 394                       | 3.1 s                                           | 28                      |
|                                     | built   | 1    | 93 of 450                | 0                            | 89 / 4 / 0, none handed back                   | 93 of 450            | 5                         | 1.8 s (of the 93)                               | 0                       |
| One track, 30 a second, +5 ms, 20 s | control | 3    | 2-4 of 600               | 0                            | 1-4 / 0 / 0, 0-1 handed back                   | 0-3 of 600           | 545-549                   | -                                               | 0                       |
|                                     | built   | 3    | 2-3 of 600               | 0                            | 1-3 / 0-1 / 0, none handed back                | 0-3 of 600           | 532-544                   | -                                               | 0                       |
| One track, 30 a second, +0 ms, 20 s | control | 3    | 4-10 of 600              | 0-2                          | 4-10 / 0 / 0, 0-2 handed back                  | 4-10 of 600          | 549-553                   | -                                               | 0-14                    |
|                                     | built   | 3    | 8-31 of 600              | 0                            | 7-27 / 1-4 / 0, none handed back               | 8-31 of 600          | 460-472                   | -                                               | 0                       |

A short bracket of one track at +5 ms, one pair each (not in the table above): at 2 a second both trees deliver 40 of
40 once each and the built run meets every rule; at 5 a second the control hands 18 of 100 (3 of them more than once,
one 5 times) and the built tree 58 of 100, each once; at 10 a second both hand 1 to 4 of 200.

- **The built tree hands no ordered message to the application twice.** Over 13 built runs, none of the messages
  handed (1 to 200 a run) was handed more than once; no completion took a third attempt and none handed the work
  back; 22 writes lost and every one was won at the next attempt. The control hands 3.3 to 14.7 % of what it delivers at five
  publishers more than once (10 % over 45 s, up to three times), and 37 of its 43 hand-backs over all its runs were
  followed by a second hand-off.
- **The lost writes lose to the expiry refresh.** All 22 lost built writes and 41 of the control's 43 had an
  admission's refresh of the same track's progress row, writing the same `completedThrough`, commit inside the lost
  write's window, and every such refresh moved the expiry by less than a tenth of the track's 1 h lifetime (by 35 ms to
  1 s; over all refreshes at most 15.7 s). None had a position moved in its window.
- **Neither tree drops or reorders a track at the subscriber**: every handed track's first hand-offs ran in sequence
  with no gap below the highest. The control's recipients read 14 to 252 room frames a run out of their track's order,
  and 10 twice in one run; the built tree's recipients read none twice and none out of order.
- **The receipts' result of the unordered cells does not hold for ordered sends.** At five publishers over 20 s the
  built tree completes all 200 in time, but its recipients read a message 12.9 to 16.7 s after its send (p50; at most
  28.5 s against a 30 s lifetime), 5 or 6 `admitted` a run arrive 10.5 to 26.4 s late, and the receipts are read at
  12.7 to 13.9 of 20.1 a second. Over 45 s only 93 of 450 are delivered and 352 end `timed-out`. One track at 5 a
  second or faster stalls on both trees, at +0 ms as at +5 ms over 20 s (a 5 s run at 30 a second and +0 ms delivered
  150 of 150).
- **What the stall points at: an admission that loses to the progress row waits for its replay, and its track waits
  with it.** The admission still fences on the whole progress value, and 13 to 18 % of the built tree's five-publisher
  refreshes lost (71 to 79 % on the fast track); the send answers `pending-admission`, and its successors on the track
  are not handed until its replay admits it. In the built 45 s run three of the five tracks stopped at such a send,
  whose `admitted` was never read by the end of the run; the other two stopped at an admitted message that was never
  handed. The harness re-sends no copy, so whether a sender's resend unblocks a track is not shown.
- **Both stops were explained afterwards, and the repair is section 12.** The replay is late because its row waits
  for a batch of the lane and, once it loses again, for the rotation to reach RETRY rows. The two tracks that stopped
  at an admitted message held waiting work, not lost work: a buffered message's release had lost its commit to an
  expiry rewrite, gone back as RETRY, and was not claimed again before its message expired.

### Ordered room messages, with the fresh attempts built

The cells of section 12 again, with its harness and shape (three WS server instances on PostgreSQL, every statement,
BEGIN and COMMIT delayed 5 ms, fifteen sessions in one room, a 30 s lifetime, no copy re-sent), on three columns:
the built code; the same code with only the arrival's fresh attempts (the replay's and the release's undone); and the
code before any of them, the completion's three attempts kept. Each column is the built tree with a patch undone for
the run and restored after it, and within a cell every run iterates its columns back to back, so load drift falls on
each alike. No run started above a 1-minute load of 8; the runs taken beside another session's test suites that ended
above 8 were repeated on a quiet machine with their whole iteration, and the counted runs started and ended at loads
of 1.4 to 6.9; one track at 3 and at 4 a second was also run twice more on the quiet machine.

| Cell, +5 ms                       | Before the fresh attempts                                             | The arrival's attempts only                                        | Built                                                                  |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Five ordered, 20 s, 200, 3 runs   | 154-174 complete; 26-32 parked; read 7.1-21.0 s; 12.8-14.0 receipts/s | 200 each; none parked; read 0.6-0.7 s, at most 1.1 s; 19.3-19.4 /s | 200 each; none parked; read 0.6-0.7 s, at most 1.2 s; 19.3-19.4 /s     |
| Five ordered, 45 s, 450, 1 run    | 131 complete; 39 parked; 308 timed-out; read 12.4 s; 13.3 /s          | 450; none parked; read 0.7 s, at most 20.7 s; 18.2 of 20.0 /s      | 450; none parked; read 0.6 s, at most 0.9 s; 19.7 of 20.0 /s           |
| One track, 2 a second, 40, 2 runs | 40 each; last read 0.8 s behind                                       | not run                                                            | 40 each; last read 0.8 s behind                                        |
| One track, 3 a second, 60, 4 runs | 60 each; 21-30 parked; last read 9.8-18.8 s behind                    | not run                                                            | 60 each; none parked in three, last read 0.7-0.9 s; one parked, 13.2 s |
| One track, 4 a second, 80, 4 runs | 1, 37, 72, 66; last read up to 30.1 s behind                          | not run                                                            | 42, 47, 80, 45; last read 21.7-29.7 s behind                           |
| One track, 5 a second, 100        | 51, 3                                                                 | 3, 8                                                               | 65, 11; the track ended `resync-required` in both                      |
| One track, 10 a second, 200       | 3, 3, 1                                                               | not run                                                            | 5, 2                                                                   |
| The two unordered cells, 200      | 200 each; read 0.5 s, at most 0.8 and 1.4 s; 19.4-19.5 receipts/s     | not run                                                            | 200 each; read 0.5 s, at most 0.6 and 0.8 s; 19.4-19.5 receipts/s      |

"Read" is the recipients' read of a message, from its send to its last ACK offered: p50, and its largest; for one
track, how far behind its send the last completed message was read. Receipts are read against 20.1 a second offered
(20.0 over 45 s).

- **The five ordered publishers keep up on the built code**, in every counted run: every message complete by its
  deadline, no send parked, no `admitted` later than 8 s, the last ten's p50 no slower than the first ten's
  (`admitted` 173 to 181 ms against 192 to 210 ms over 20 s, 172 against 274 ms over 45 s; `complete` 484 to 576 ms
  against 489 to 597 ms, and 459 against 513 ms), receipts read at 96.0 to 98.5 % of the offered rate, no RETRY row,
  no message handed to the subscriber twice, no frame read twice or out of order, and no track ended
  `resync-required`. Completions took a second attempt 0 to 8 times a run, never a third, and none handed back.
- **One built run did not keep up**, taken beside another session's suites (its load rose from 7.5 to 13.1): 108 of
  200 complete, recipients reading 5.4 s behind at p50 and 27.5 s at most, 13.8 receipts read a second, 14 RETRY rows,
  each a local dispatch that ran before its predecessor's completion and was never claimed again, and five tracks
  ended `resync-required`. Its repeat on the quiet machine kept up. It shows the hold that stays: one retried row
  waits for the rotation and its track waits with it.
- **The arrival's attempts carry the five publishers; with the replay's and the release's they differ only over
  45 s.** Over 20 s the two columns read alike, but over 45 s with the arrival's attempts alone one message was read 20.7 s behind its
  send and receipts were read at 18.2 a second, where the built code read every message within 0.9 s and receipts at
  19.7 a second (one run each, not attributed).
- **What one track carries: 2 a second**, the highest rate at which every run kept up (all complete, the last read
  within a second). 3 a second is the first that did not: three of four runs kept up and one read its last message
  13.2 s after its send, held by one parked send. From 4 a second the track falls behind on
  every column, and at 5 a second the built code ends the track `resync-required` where the code before it stalled
  without ending it. In every one-track run the messages completed are exactly the first of the track and none was handed twice. At
  10 a second the progress row's lost writes rose from 433-444 of 597-613 writes a run to 813-814 of 981-982, the cost
  of three read-and-write rounds before a send is parked, and sends admitted more than 8 s late or never rose from 84
  to 92 a run to 104 to 107, with as many parked (146 to 163). Recipients read 10 room frames twice in one run of the
  code before the attempts and 15 in a run of the built code taken beside the other suites, though the subscriber was
  handed each message once; neither was probed.
- **The unordered cells read as before**: 200 of 200 in each, the read's p50 0.5 s on both columns.

### Why ordered tracks fall behind together

One run of the built code above did not keep up, and its five tracks stopped at the same send. It was
probed: the five ordered publishers for 20 s at +5 ms on the built code, under deliberate CPU load (8 to 12 burners,
a 1-minute load of 8.7 to 27.7 at the start), reading the lane's `dispatch-decision` dispositions, every readiness
read and every completion. This replaces the reading given for that run above and in section 12 ("a local dispatch
that ran before its predecessor's completion"), which the probe does not bear out.

- **Reproduced in three runs of three.** 109, 116 and 127 of 200 completed; 3, 5 and 5 tracks ended
  `resync-required`; every track of a run stopped at the same send. A run on the quiet machine after them
  completed 200 of 200.
- **The cause is not a race.** When a message's dispatch-to-completion takes longer than the gap to the next send
  (here by load: completions 1.0 to 1.6 s after the successor's send, with 500 ms between sends), the successor's
  delivery reads its predecessor `waiting` and is set aside before it is reserved; its row stays new. Nothing claims
  it when the predecessor completes: only a buffered release's successor is promoted (`claimPromotedRelease`). It
  waits for the rotation, which read its readiness again every 3 to 4 s; of about 2 400 to 2 700 readiness reads a
  run, 1 907 to 2 235 answered `waiting`. By then the next arrival has also found its predecessor unfinished, so the
  track never returns to the fast path while the sender keeps its rate; the wait from due to claim grew from 5.6 to
  26.3 s.
- **All tracks share the rotation**, so they fall behind at the same rate and reach the 30 s lifetime at the same
  send. The expired message's successor then reads `resync-required` and its track ends. The 8, 10 and 11 dispatch
  rows a run that answered `retry` and were never claimed again are those later successors' rejections
  (`ordering-retry`), each expired within milliseconds. No dispatch answered `port-retry`, `consumer-unavailable` or
  `plan-retry`.
- **It needs no host load as such.** A database slower than +5 ms a statement, one slow completion (a stall, a pause,
  a lock wait) or one track sent faster than the cycle leads to the same state, and it does not recover while the
  offered rate holds. It is older than section 12: the dispatch path, the deferral, the rotation and the promotion
  are unchanged by it. Section 12's fresh attempts removed the stalls that used to come first, so this is now the
  first limit ordered publishers meet.

Two repairs were then prototyped as patches outside the tree and measured on the same head, each run directly after
a run of the built code (73 runs; raw results kept outside the tree). _The hand-on_ is section 13's rule: the batch
that completed a delivery claims the track's next admitted delivery, found by one read of the track's next slot, only
when the row is due and reads ready, as it read it, while the batch holds fewer than a page. _The cheaper form_
brings the successor's row forward through `expedite()` instead.

| Cell, +5 ms                                 | Built                                                                                                                          | The hand-on                                                                              | The cheaper form                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Five ordered, 20 s, 200, loaded (8 burners) | beside the hand-on: 200, 193, 200, read at most 5.4, 29.6, 27.9 s; beside the cheaper form: 151, 155, 134, 4 to 5 tracks ended | 200 each of three; read p50 0.9-2.7 s, at most 1.3-5.4 s; no retried row; no track ended | 200 each of three; read p50 0.8-1.0 s, at most 1.8-2.3 s |
| Five ordered, 20 s and 45 s, quiet          | 200 each of four; 450 each of two; read 0.6 s                                                                                  | 200 each of two; 450; read 0.6 s                                                         | 200 each of two; 450; read 0.6 s                         |
| The two unordered cells, 200                | 200 each; read 0.5 s                                                                                                           | 200 each; read 0.5 s                                                                     | 200 each; read 0.5 s                                     |
| One track, 2 and 3 a second                 | 40 each; 60 each                                                                                                               | 40 each; 60 each                                                                         | 40 each; 60 each                                         |
| One track, 4 a second, 80                   | 41, 80, 43, 80                                                                                                                 | 80, 80; read at most 3.8 and 1.5 s                                                       | 80, 80; read at most 14.3 and 15.3 s                     |
| One track, 5 a second, 100                  | 29, 22, 17, 24                                                                                                                 | 20, 69                                                                                   | 100, 23                                                  |
| One track, 10 a second, 200                 | 4, 1, 4, 3                                                                                                                     | 4, 3                                                                                     | 7, 6                                                     |
| The unit sweep, 3 754 cases                 | all pass                                                                                                                       | 3 red, each a pinned promotion count or batch shape                                      | 1 red: a 64-message track drains in one batch, not five  |

- **The hand-on removes the loaded stall**: in its three loaded runs (loads of 8.8 and 10.2 at the start, and one
  that began at 45.8 with other work on the machine beside it) every message completed, no row went back as a retry,
  no track ended, recipients read no frame out of order, 94 to 164 successors were found a run and 85 to 164 claimed,
  and a lagging track caught up again (the worst lag of a run 0.8 to 5.1 s) where the built code's lag only climbs.
  The built code beside it completed 200, 193 and 200, two of those runs reading a message 27.9 and 29.6 s behind,
  against a 30 s lifetime; beside the cheaper form, and in the probe, it completed 109 to 155.
- **The quiet figures do not move**, on either repair.
- **One track**: 3 a second keeps up in every run of every column; at 4 a second the hand-on completed all 80 in
  both runs where the built code completed all 80 in two runs of four; 5 and 10 a second keep up on none. At 10 a
  second the parked arrivals dominate.
- **The cheaper form breaks the page bound.** An expedited claim is taken before the batch's next claim and is not
  counted against the page, so one track's backlog drains in a single batch, ahead of every other claim.
- **Seen beside it, older than both repairs:** recipients, which are raw sockets here, read frames of one track out
  of order when two hand-offs lie close together (14 in one run of the built code, 9 to 42 in the cheaper form's
  loaded runs, none in the hand-on's), though the subscriber was handed every track in order. The WS server's fan-out
  to a room keeps no order between two messages written close together; a Rallar receiver's ordered delivery
  restores it from its buffer.

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
- What the investigation of the receipts' delivery answered, and on what (section 10). The growing wait is the
  receipts' commits serializing on the server's sender version: with receipt controls fenced on their own version
  only, the prototype retained no enqueue, so no replay claim existed, nothing conflicted, and the worker kept up at
  its present throughput (18.3 of 19.5 receipts read a second; 19.4 with `admitted` on the socket too). Four claims
  at once on the worker made the row's conflicts worse (126 of 200). The worker's claim order and the room messages'
  fan-out tail were not timed again, and delivering receipts from the record's own work rows is neither built nor
  measured.
- Every prototype figure of section 10 rests on two runs on a machine another session loaded (load 8 to 33, three
  to six times the earlier runs'), which made the unchanged code's figures worse and noisier (57 to 112 of 200,
  medians by rotation). The fence alone, both fixes together, every receipt live and the commit before the
  per-message fence lie far outside that spread; the single factors undone one at a time and the four concurrent
  claims within or near it.
- The remainder between undoing the four changes of #869 together (187 of 200) and the commit before them (200) is
  not attributed.
- Higher latencies (+10 ms or more) and the hosted cell were not run with either fix; +0 ms and one 45 s run at
  +5 ms were, with both ("Measured through the WS server").
- That a receipt dispatch reads no row its sender's messages share is read from the code; no test pinned it when it
  was measured. A dequeue batch that mixes receipts and sequenced server publications was exercised only on the
  built split (22 to 28 such batches a run, "Measured through the WS server"), not on the prototype.
- The recovery of a lost live `admitted` by the first-hop resend is pinned with one origin and one server
  (`ws-kept-send-receipt.test.ts`), with the frame lost on the wire; it was not run under load or across instances.
- `main` was not run in that cell; its code delivers every receipt the same way, through the outbox on the server's
  one sender version.
- The server's own receipted publications entered the cell only as one sequenced publication every 500 ms from one
  instance; group-state deltas themselves, which carry no ordering, and a higher publication rate were not run.
- More than five publishers in a room: not run, so whether the receipts keep up with ten publishers even at
  +0 ms is not shown.
- The hosted statement latency is still read from one attributed run, about 5 ms; the measurement with the fence split
  and `admitted` on the socket ran at +0 and +5 ms locally, not on the hosted database.
- More than five publishers were not run with the fence split and `admitted` on the socket either, so the rate at
  which the built receipts stop keeping up is not known.
- Latencies above +5 ms were not run with the fence split and `admitted` on the socket, so whether the built tree's
  sub-second last ten holds at +10 ms is not shown.
- `main` was not run in the five-publisher cell with or without the server's own publications, so its figures
  beside the built tree's are not shown.
- The ordered completion's retries are measured through the WS server at +0 and +5 ms ("Ordered room messages"): the
  built tree handed no ordered message twice and never needed a third attempt. Not shown: whether that holds where
  the tracks keep up for longer than 20 s, since at five publishers over 45 s and on one track at 5 a second or more
  the ordered tracks stall on both trees behind admissions left `pending-admission`; and whether a sender's resend
  unblocks a track. Why such a replay lands late, and why two tracks stopped at an admitted message, is answered in
  section 12.
- Of section 12: why one track at 3 a second kept up in three runs of four and not in the fourth, and why a track
  that has fallen behind delivers about one message a second, were not probed; nor why recipients read room frames
  twice on one track at 10 a second (with the fresh attempts and without them) and when reading due retried rows with
  the new ones, nor why that lever delivered 2 of 100 on one track. What separates the arrival's attempts alone from
  all of them over 45 s rests on one run each. No cell ran in a browser, on IndexedDB or over RTC.
- Of section 13, which is a design and not built: its figures are a prototype's, three loaded runs a column, and the
  built code beside the hand-on completed 200, 193 and 200 where it completed 109 to 155 in six other loaded runs.
  Not run: an over-driven track beside other traffic, a lane whose pages are full, more than five publishers, a
  database slower than +5 ms on a quiet host, the PostgreSQL integration lane, the black-box recipes and the ALM lane
  with the prototype, and any browser, IndexedDB or RTC cell. The design's lookup for a release differs from the
  prototype's and is not measured. Why the WS server's room fan-out writes two close hand-offs of one track out of
  order was not probed.
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

Appended to `playground/alm/alm-improvement-plan.md` as D770 to D784. D784 is restated in both, here and in the
roadmap, to what was decided on 2026-11-26, built and measured; D783 names the function its fresh attempts now share.

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D770 | **The receipt record is one more ALM runtime store (decided 2026-11-22, D779).** A receipted WS send's count lives in `ALReceiptRecord`, its own feature folder `packages/shared/alm/receipt-record/`, on the shared AL admission backend (`ALAdmissionWorkBackend`) in the namespace `<store namespace>:receipt:record` (`toALReceiptRecordNamespace`; on api-v1 `server-ws-qbox:default-qbox-server:receipt:record`), and so does the count of the server's own receipted publications (D778). A recipient's ACK writes it directly at WS ingress, guard first and in one transaction, as the AL runtime's inbound and outbound stores are written; it does not pass through AppInbox. The deadline and the end are work rows on the backend's own work queue, which any instance claims. No new adapter: the memory and PostgreSQL backends already implement the port. One shared file is added beside it, `packages/shared/alm/work/compute-al-work-entry.ts`, the work-entry envelope, which the outbound and inbound work-entry builders now use too. Cost if wrong: the record would move behind AppInbox, one mutation command per ACK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D771 | **Unfenced rows on the admission backend: their cost and isolation, and which backends keep a revision (a probe before the record was built).** Through `PSqlAdmissionWorkBackend`, 30 concurrent unfenced writes to distinct keys of one namespace, from three backends on three clients, committed with 0 conflicts; a write to another key committed while a first write's transaction was held open (`finished`, not `blocked`; 63 ms, measured once, not pinned). One unfenced write is `[null, 1]`: the key read in autocommit and the conditional insert in one transaction, 4 round trips with BEGIN and COMMIT. No backend keeps a store-wide revision: IndexedDB observes the written key's own row (`indexed-db-admission-backend.ts`), memory serializes every write of one state and conflicts only on an observed work batch (`al-admission-backend.ts`), PostgreSQL keeps a revision per row. Two comments that said otherwise are corrected, in `ALAdmissionBackendConflictError.ts` and `al-outbound-admission-fences.test.ts`. Pinned in `al-admission-unfenced-row-writes.test.ts`. Cost if wrong: the record's count would need a fence per ACK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D772 | **The receipt record's contract.** A head per receipted message at `<ns>:receipt:<JSON [origin, msgId]>` (`{ phase: 'open', opening }`, the opening naming the expected and never-sent recipients, the snapshot version, the trace and the deadline; or `complete`/`timed-out` with the opening, `confirmedRecipientPeerIds` and `outsideAudienceRecipientPeerIds` in expected order, each recipient named once, and `endedAtEpochMs`), and a confirmation per answering recipient at `<ns>:receipt-ack:<JSON [origin, msgId]>:<recipient>` (`{ recipientPeerId, kind: 'confirmed' \| 'outside', countedAtEpochMs }`; the owner's `not-sent` is stored `outside`), read back only under its exact key; a row under another key fails closed as `ALAdmissionCorruptionError`. Every stored identity is one a receipt control accepts (`decodeALReceiptIdentifier`). Expiry: the open head and the deadline work at `deadlineAtMs + 30 s`; a confirmation under a head at `deadlineAtMs + 60 s`, one grace after its head, so an `end` that reads a live head reads its confirmations; the ended head and the ended work at `max(deadlineAtMs, endedAtEpochMs) + 30 s`; a confirmation written with no head at `now + 30 min + 30 s`. The tally of an open head counts only the confirmations whose `countedAtEpochMs` lies before `deadlineAtMs`. Work rows of type `AL_RECEIPT_RECORD:<fnv1a64(ns)>`, topics `AL_RECEIPT_DEADLINE` (due at the deadline, written with the head) and `AL_RECEIPT_ENDED` (due at the end, written with the terminal head). Results are values: `open` returns the view, `invalid-opening` (every issue of `empty-audience`, `audience-over-limit`, `receipt-expired`, `deadline-beyond-window` and `malformed-opening`) or `conflict`; `count` returns `counted` or `repeated` with the view, `head-absent`, `invalid-confirmation` (every issue of `head-ended`, `outside-frozen-audience`, `deadline-expired` and `never-sent`) or `conflict`; `countAhead` as `count`, or `ahead` when no head is visible after its write; `end` the ended head, `head-absent`, `not-due` (nothing written) or `conflict`; `read` the view or `head-absent`. Only `ALAdmissionBackendConflictError` becomes `conflict`; every other backend error propagates. A `count` that read an open head can commit after another instance's `end`; its view may then say `open`, even `complete: true`, for a receipt stored `timed-out`. Only `end`'s result is authoritative, and the WS server treats it so. A contract of 32 cases (`describeALReceiptRecordContract`) runs on memory and on PostgreSQL. Cost if wrong: a contract change restates the cases on both backends.                                                                                                                                                                                                                                                                     |
| D773 | **The receipt record's decisions.** (1) A confirmation written with no head expires at `now + window + grace`, not after the 30 s grace first proposed: while the head is open the rows are the count, so a shorter expiry would time out a receipt naming a recipient that confirmed. (2) `countAhead` reads after its write: an `open` that commits between that ACK's head read and its write would otherwise leave a complete set unseen until the deadline. (3) A repeated confirmation is a typed no-op (`repeated`, first write wins), not a refusal: two instances can each validate before either writes, so a refusal could not be exact. The one exception: the owner's `not-sent` replaces a `confirmed` row of a recipient the head names never sent, a row only a confirmation written ahead can have stored, and the tally ignores such a `confirmed` row. (4) `end` takes no phase: it ends `complete` when the set it reads is complete, `timed-out` once the deadline has passed, and is `not-due` otherwise, so no caller can state a phase the record does not hold. (5) The store bounds its rows: `open` refuses a deadline beyond `now + window` (`deadline-beyond-window`) and a receipt already past its grace (`receipt-expired`), and the caller clamps; it also refuses an empty audience (`empty-audience`), which could never complete, an audience above the message collection limit (`audience-over-limit`), and an opening the stored-head decoder would refuse (`malformed-opening`), which would commit a head no read could use. (6) A confirmation under a head expires one grace after its head: a deadline pass that runs late reads the head and the confirmations as two reads, and with equal expiries could read a live head and no confirmation, ending `timed-out` naming nobody. (7) The tally of an open head ignores a confirmation counted at or after the head's deadline: a row written ahead passes no validator, and a head opened afterwards would otherwise count an ACK `count` refuses. Also: a terminal set names a recipient once; the open-head tally passes the expected recipients without repeats, first occurrence kept. Cost if wrong: (1) changes two contract cases and adds an adoption write; (4) a caller-stated phase; (6) 30 s less life per confirmation row; (7) one filter in one pure function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D774 | **The pinned cost of a non-completing ACK, and three backends without a conflict.** On PostgreSQL an ACK that finds its head open and does not complete the set is three statements and one transaction, `[null, 1, null]` with leading verbs `select`, `insert`, `select`: one autocommit read that batches the head and the confirmation key, the confirmation insert in transaction 1, one autocommit prefix read of the confirmations for the tally; five round trips with BEGIN and COMMIT. Fifty confirmations of one message from three backends with pools of 10 committed with no conflict, each `counted`; a second count committed while another instance's count was held uncommitted (`finished`, not `blocked`); of three backends ending the receipt together, one commit won with all 50 confirmed and the other two read `conflict`. No head cache and no single-statement unfenced write were needed. Sustained, 40 messages of 14 ACKs at 28 a second on three instances: no backlog at +0 or +5 ms; at +5 ms the lag from a message's last ACK to its `complete`, p50 / p95 / max per run, was 60.5 / 65.1 / 82.3, 62.8 / 72.0 / 80.3 and 61.8 / 68.3 / 72.0 ms, and the last ten messages' p50 (59.9 to 61.2 ms) was no slower than the first ten's (58.2 to 64.0 ms); 560 of 560 confirmations, 40 of 40 heads complete, one `end` winner per message, in three runs of each. The statement shape, the fifty confirmations, the held count and the three-way end are pinned in `packages/tests/shared-server/integration/postgres/al-receipt-record.test.ts`; the sustained run is not kept. Cost if wrong: the levers are a per-instance head cache and a single-statement unfenced write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D775 | **The receipt record's namespace in the growth proof.** The `runtime_state_store` namespace `<store>:receipt:record` (sampled as `server-ws-qbox:*:receipt:record`) is growth surface 85, class `ttl-within-run`, ttl `AL_RECEIPT_RECORD_WINDOW_MS + 2 × AL_RECEIPT_DEADLINE_GRACE_MS` = 1 860 000 ms, sweep 60 000 ms. The longest-lived rows are a confirmation under a head, which expires two graces after its head's deadline, and an ended head, which expires one grace after an end that comes at most one grace after the deadline; that deadline is at most one window after opening. Open heads and confirmations written with no head live at most window plus one grace. The record's work rows are expiring `resource_inbox` rows under surface 1. In `growth-surfaces.ts`, tied to `toALReceiptRecordNamespace` by `growth-surfaces.test.ts`. Cost if wrong: the growth gate reads a bound the rows can exceed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D776 | **The WS server counts in the record.** Deleted: the memory aggregate, its cap, window constant and sweep, `ws-queue-box-server-receipt-deadline-index.ts`, and the ACK relay class `ws-queue-box-server-ack-relay.ts` with `createRelayedAckPublisher`, `publishRelayedAck` and `acceptRelayedAck`, since it read the memory aggregate (the rest of the relay: D777). `WsQueueBoxServerReceiptAggregation` now translates admissions, ACKs and re-sent copies to `ALReceiptRecord`: an admission opens the head (its deadline clamped to the window) and answers `admitted`; `acceptControlMessage` counts a receiver ACK (`count`, or `countAhead` when the head is absent, without a second proof) and calls `end` when the view is complete; only `end`'s result is authoritative, and a losing `end` does nothing. `ALReceiptRecordWorker` (`<serverPeerId>:receipt-record`, on the service's engine, lease 10 s, page 16) ends receipts at their deadline and delivers each terminal receipt at least once under one control id per ended work (`toWsQueueBoxServerEndedReceiptControlId`), then settles the server's pending row. The refusal hook `readRelayedAckRejection` in `alm/inbound` is asynchronous and keeps its name: at ingress it checks only that the ACK addresses the origin it names; in the inbound runtime it reads the head once and refuses with the record's validator, or, with no head, proves the sender against the audience admission ran under in the inbound admission row (volatile store first, then the durable one). Every refusal is `unauthorized`. Admission opens no receipt the control codec could not encode (`receipt-not-encodable`: 249 recipients of 128 characters open, 250 do not). A re-sent copy is answered from the record under a fresh control id, `admitted` while open and the terminal receipt after the end; one that finds no head opens it from the admission row's audience. The middleware option `receiptRecordStores` is required (api-v1 passes `create-p-sql-al-receipt-record-stores.ts`; `create-api-v1-runtime.test.ts` fails if the runtime stops counting in the shared record). The inbound authority no longer keeps a control for admission while its room view is behind. `api-v1-cluster-publisher-instance-loss` now reads `complete` for the broadcast its lost server admitted. A non-completing ACK is 8 round trips through the server (hook 2, control-owner read 1, count 5), pinned in `ws-receipt-record-cluster.test.ts`. The copies that open nothing, stray confirmation rows, the 256-recipient bound and one server name per cluster are stated in `packages/shared/alm/receipt-record/README.md` ("Stated limits"), a terminal receipt delivered more than once in its "Control ids". Cost if wrong: the lever for the ACK's cost is to count at `admitAuthorizedMessage`, which makes the count's refusal the answer and the hook store-free again.         |
| D777 | **The ACK relay deleted.** Deleted: the relayed-ACK notice, its subscriber, api-v1's PostgreSQL transport and its `ws-relayed-ack` channel, the middleware option `relayedAckNotices`, the `ack-relay` observation kind and refusal owner, the count's `source` and `relayPublisherId`, and their safe projection, which now refuses a record of that kind or owner. The relay's per-publisher budgets left with the relay class (D776): they bounded NOTIFY publications, and none is published now. An ACK that finds no head costs two reads and writes a row only when its sender is in the audience its admission ran under, reads as a refused repair request already costs; growth surface 38 stays, restated as empty. `keepsVolatileMessageInMemory` replaces the relay option as the explicit volatile-store switch: absent, a WS server keeps every volatile message in its memory pair; on a cluster only an instance-local one, since another instance proves an ACK and reads an oversized live notice's message from the shared store. api-v1 passes `isInstanceLocalRtcSignal` on PostgreSQL pub/sub, guarded by the black-box recipe `api-v1-websocket-live-only-cluster`. The hook `readRelayedAckRejection` keeps its name: it names the server's relay of the origin's message. The prose that described the relay is rewritten: the outbound and inbound READMEs, `runtime-diagnostic-contract.md`, `plans/backlog.md`, the product description and the publication addendum. Cost if wrong: a relay restored would be a second count path beside the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D778 | **The WS server's own receipted publications count in the record (decided 2026-11-22, D779).** The head opens first in `afterDequeueAdmission`, from the server's pending receipt row (`readPendingAck`), not from the hook's committed policy (it expects nobody); no `admitted` receipt. Its deadline is the row's retransmission budget less half an ACK window (7 s for a delta against the row's 8 s). A session's ACK of a server publication is counted (`count`); one that finds no head is proven by the pending row (counted ahead if the row expects the sender, refused if not), and the server's own `not-sent` is proven by that row (a first dequeue's drop comes first and writes nothing); with no logical row an ACK goes to the outbound owner (a `hop` row counts it), and a refused opening (over 256 sessions, an unencodable receipt) keeps the per-ACK fenced count in the row. An outside-audience NACK the row admits is one `outside` confirmation. The retry window opens a head the dequeue did not open, counts the row's unrecorded outside recipients, ends a complete open head and narrows retransmission to the unanswered. The ended work admits the terminal receipt into the server's row and enqueues nothing; a partly confirmed one ends `timed-out`. Deleted: `commitOutsideAudience`, its control and its diagnostic kind. Measured on PostgreSQL: the publication's version row moves once from the settled dequeue to the end for 10 sessions and for 50, against 50 under the per-ACK row count (derived: once per ACK, once more per recipient sent nothing); before the per-message fence each of those was a commit on the server's one sender version; a non-completing ACK is 5 round trips, none fenced (about 15 fenced before that fence, derived); the dequeue's record work is 11 round trips, none on the version row (pending-row read 1 on the outbound client; on the record's, `open` 7 and one claim 3, which finds the deadline row not yet due and reserves nothing), and the worker's first batch of each 10 s lease adds two lease sweeps (6), pinned at the first batch; a survivor's window opened the head a lost dequeuing instance never opened. Pinned in `ws-own-publication-receipt.test.ts` and `ws-queue-box-server-own-receipt.test.ts`. The state-write bench runs none of this code. Limits: a stall over half a window lets the row's budget end first (the admin read says `receipt-exhausted`, the head stays exact); a publication with no retry has no window to heal an unopened head; a refused opening's skipped recipient keeps its row open until its budget ends; a lost `end` no window reaches waits for the deadline worker; a failed dequeue attempt re-sends every copy. Cost if wrong: the ACKs go back to the row's fenced count; the stall's levers (both in `alm/outbound`): a settlement from the record's view or a pending row marked counted elsewhere. |
| D779 | **The decisions of 2026-11-22 on the crash-surviving receipt, and its runs (D770 to D778).** Each of (1) to (5) was asked of the maintainer alone. (1) A receipt read after the server that admitted the send dies is exact, not a truthful terminal receipt that forgets the ACKs counted before the crash. (2) The count is a per-recipient record, one fence-free row per confirming recipient. It replaces the first choice, the durable `receiver` pending row of the server's outbound owner, which measured correct but too slow: about 15 fenced round trips per ACK on the publisher's version row, about 11 ACKs a second at +5 ms against the 28 the first hosted campaign's first rung offers. (3) The server's own receipted publications count in the record too, not client sends only (D778). (4) A re-sent copy after the end is answered with the terminal receipt again, not met with silence (D776). (5) The record is one more ALM runtime store, written at WS ingress outside AppInbox (D770). The maintainer approved the build as D770 to D778 state it. Gates on the head that merged `main` in (`3257802dc`): the PostgreSQL integration lane 695 tests in 110 files; black-box recipes on PostgreSQL 76 of 76 and the cluster profile 18 of 18 (`api-v1-cluster-publisher-instance-loss` reads `complete`; the subscriber-loss one keeps `timed-out`, as its lost subscriber cannot confirm), on memory 75 of 76 (`api-v1-tournaments` fails the same way on `main`); the medium-scale gate 2 842 passed, 0 failed; `test:unit:main` 26 124 passed; `test:rallar` 64 and `test:full-stack:memory` 36 passed; the ALM smoke lane 3 passed on each of `ws`, `rtc` and `rtc-with-ws-fallback`, and its full scope over `ws` 7 of 7. The fixes after that head ran their focused suites and the branch gate. Through the WS server, three instances on PostgreSQL, every statement, BEGIN and COMMIT delayed: before D780 and D781 one publisher kept up, and five kept up at +0 ms, but at five publishers and +5 ms the receipts backlogged on the server's one sender-version row (D780): 111 to 124 of 200 `complete` by the 30 s deadline, `admitted` 18 to 19 s late over the last ten, 3.6 to 3.7 receipts read a second of 20.1. With D780 and D781 every cell keeps up, five publishers at +5 ms at 200 of 200 and 450 of 450 over 45 s (D782). The count keeps up (69 to 72 ms from the last ACK); no unordered message read `timed-out` or two terminal receipts. Ordered sends: D783, D784. The limits that stay are in `packages/shared/alm/receipt-record/README.md` ("Stated limits").                                                                                                                                                                                                                                                                                                                                  |
| D780 | **A dispatch fences its sender only when its decision read a row the sender's messages share (decided 2026-11-25, D782).** The cause of D779's five-publisher backlog: every receipt control's enqueue, replay and dequeue, of every message on every instance, was fenced on the server's one sender-version row (`version:server`), so the cluster's receipts formed one serialized queue on it, older than the per-message fence, which made each turn of it dearer. The rule (`hasALOutboundSenderSharedRead`): a dispatch bundle fences its sender exactly when its message holds a place on an ordering track or its read holds a supersedence key, since only those decisions read the track head, a sent position, the room sent floor or the supersedence latest; otherwise it fences on its own message's version alone, where any two commits of one message meet. The flag is derived from the read, not from the message's type, and a bundle without the sender fence that writes a shared row is refused (`assertALOutboundBundleRows`). Its reach: receipt controls, handed-off controls, the server's unsequenced publications (the group-state delta carries no ordering, so the server's receipted delta is one; a client-state event is the sequenced kind and still fences) and a client's plain room broadcast, in the browser too. Still fenced on the sender: a message end through the message-end bundle, each ACK window, a first-hop wait's own commits, a repair hint's follow-up and the not-yet-in-sync retry schedule. The schedule is fenced against sender-fenced ends only, so one `nack-retry` can be scheduled for a message that an unfenced commit just ended; its dispatch answers `message-ended` and writes nothing, and the retry record expires (accepted). The split: a dequeue batch is one write per fence group (`toALOutboundFenceGroups`, `lane/`), the bundles that fence the sender, which must have read one version of it, and the rest, at once; when only the sender-fenced members disagree on a version they commit alone and the unfenced members stay one write; a group that committed is never committed again unless it threw after committing. Pins: the PostgreSQL statement pins of a receipt control's enqueue (`with`, `insert`) and dequeue (`with`, `select`, `insert`), none naming the server's version row (`ws-receipt-record-cluster.test.ts`); a sequenced publication's dequeue moves the server's version once, an unsequenced one never (`ws-own-publication-receipt.test.ts`); the sender-fence table of every kind of dispatch (`al-outbound-dispatch-sender-fence.test.ts`). The orphaned first-hop wait's and receipt's cleanups take their sender from the stored message. Cost if wrong: the commits that still fence the sender keep competing for `version:server`; the lever is the same derivation for them, with the schedule fenced on the message's version.       |
| D781 | **`admitted` on the admitting socket (decided 2026-11-25, D782).** An `admitted` receipt with a head behind it, one that expects somebody (`isWsQueueBoxServerHeadBackedAdmittedReceipt`), is written to the origin's sockets on the instance that answers it: the admitting one at ingress, the one whose worker runs a kept send's replay, or the one answering a re-sent copy, under a fresh control id. Its outbox row is enqueued only when no socket there took it: a connection whose socket filter refuses the frame (`acceptsOutbound`) is not called, and a write that threw is recorded `failed`; either way the receipt is a row. An `admitted` that expects nobody has no head and is the send's terminal settlement at the origin, so it keeps its row, as every terminal receipt does. An `admitted`'s row never settles the server's own pending row: only the ended work's terminal receipt does. What the row promised: one socket write once the origin has a session somewhere, never repeated, since no receipt control is acknowledged. The live send is that one write without the enqueue, the replay and the dequeue, made only after the admission and the head's `open` committed. A lost live frame is recovered where the origin resends: a send holding a first-hop wait writes its frame again at each window (2 s, three retries by default), and the copy is answered from the record. Nothing recovers it for a send with no first-hop wait (retry `none`, or a kept send whose wait the `not-yet-in-sync` NACK ended): a sender that resends nothing reads only its terminal receipt, which keeps its durable row. Observed: one `receipt-transport` per connection written (`transport: 'recipient'`, `nativeCall` from the socket's send evidence, `publisherCall: 'absent'`, `originIsHere: true`, `outcome` `sent` or `failed`) and no `receipt-outbox`, which stays the enqueue of an issued receipt; no field is added. Pinned in `ws-kept-send-receipt.test.ts` (a lost frame answered again at the first-hop window; retry `none`; the NACK-ended wait), `ws-queue-box-server-receipt-observation.test.ts` (the transport; a refused frame keeps its row) and `ws-queue-box-server-receipt-retransmission.test.ts` (an `admitted` row leaves the server's pending row unsettled). Cost if wrong: a lost live `admitted` of a send with no first-hop wait is recovered by nothing; keeping its row needs the origin's retry plan, which the server cannot read.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D782 | **The maintainer's rulings of 2026-11-25 on the receipts' delivery, and its measurement (D779 to D781).** Asked where the fix for the five-publisher backlog goes, the maintainer answered "Fix in #885", and in the same message "rebase onto main" (`main` came in by one merge commit instead: a rebase needs a force-push the session's permission check refused). Asked which fix to build, with the options "A + B (Recommended)", "A alone" and "All receipts live" (A: a receipt control's commits fence on its own version, not the server's sender version; B: `admitted` on the admitting socket, its row the fallback), the maintainer chose "A + B (Recommended)", and after two explanations, of where the fence is and of how a conditional write validates a read, "proceed with A + B". Asked how far A reaches, with the options "Wide (Recommended)" (every commit that read no shared sender state, D780) and "Narrow" (receipt controls only): "Wide (Recommended)". The options' descriptions are the questions', not the maintainer's words. Measured locally, three WS server instances on PostgreSQL, every statement, BEGIN and COMMIT delayed, unordered receipted room sends from one or five publishers at 2 a second each, each built run after a control run of the tree before D780 and D781, load 1.0 to 3.7: all 16 built runs keep up. Five publishers at +5 ms, 20 s, three runs each: 200 of 200 `complete` by the deadline (control 111 to 124); `admitted` p50 over the last ten 0.13 to 0.14 s (control 18.4 to 18.9 s) and `complete` 0.42 to 0.47 s (control 18.4 to 19.6 s); 19.5 of 20.1 receipts read a second (control 3.6 to 3.7); no receipt enqueue retained (control 225 to 231 of 400) and no receipt commit conflicted (control 39 to 40 % of replays, 19 to 21 % of dequeues); 223 to 225 statements a message (control 343 to 351). Over 45 s 450 of 450 (control 66). With the server's own sequenced publication every 500 ms: 200 of 200 and its 40 of 40 complete in each run (control 80 to 99, and of the 120 publications 2 complete and 3 `timed-out`), 22 to 28 batches a run written as two fence groups, none threw. One publisher, and five at +0 ms, keep up on both trees. Not shown: the hosted latency (about 5 ms from one run), latencies above +5 ms, more than five publishers, `main` in the cell, group-state deltas themselves; ordered sends are D784. The limits that stay are in `packages/shared/alm/receipt-record/README.md`. Cost if wrong: the receipts return to one serialized queue on `version:server`.                                                                                                                                                                                                                                                                                                                                                               |
| D783 | **An ordered delivery's completion is guarded on its position and its slot, with fresh attempts (decided on the maintainer's behalf while they were away).** Cause: the completion commit made after the application was handed an ordered message was fenced on the whole message observation; the next admission on the track rewrites its delivery-progress row to extend the expiry with the same `completedThrough`, so the completion lost, answered `retry`, and its work dispatched the message again. Older than this work and reachable in production, inside one PostgreSQL round trip; the faster ingress of D781 made it reachable on every run. The guard (`commitDeliveryCompletion`, `computeALInboundDeliveryCompletionMutations`): one write that commits when the stored `completedThrough` and the stored slot, compared whole, are the ones read; it places the new position itself from them, keeps the larger expiry, and writes nothing otherwise. A write that still loses (a moved position or slot; on PostgreSQL a row version moved inside the write's own round trip) starts a fresh attempt, a full read and decision, three in all with no wait (`retryALInboundLostWrite`). What can still hand a delivered message to the application again: every attempt lost; a shutdown between dispatch and completion; two instances holding the same work after a lease expiry, the class of a crash between dispatch and completion. What cannot: the completion that cannot be placed, its predecessor not completed, never follows a dispatch. Measured with ordered receipted sends through the WS server (D784), built beside the tree before this guard: in 13 built runs none of the 1 to 200 messages a run was handed twice and no completion needed a third attempt; 22 first attempts lost, each to an expiry refresh, and each won at the next; the control handed 3.3 to 14.7 % of what it delivered at five publishers more than once, up to three times. With D784's fresh attempts five publishers' tracks keep up over 45 s, and no completion took a third attempt. The lever if it matters: refresh the progress expiry only when it moves materially. Pinned in `al-inbound-delivery-completion.test.ts` (memory and PostgreSQL), `al-inbound-ordered-delivery.test.ts` and `ws-queue-box-server-ingress.test.ts` (sends back to back, each handed once). Decided on the maintainer's behalf because this work made a latent defect reachable every run. Cost if wrong: one commit in the shared inbound runtime every carrier uses (the WS server, the WS client, an RTC receiver) that could have been its own pull request.                                                                                                                                                                                                                                                                                    |
| D784 | **Ordered room sends under load: an inbound write that is lost is looked at again at once (decided by the maintainer on 2026-11-26: "hold for the fix"; "Let's complete 1 here in this session." (repair the ordered mode here); "Retry-at-once only (Recommended)"; the design "Approve (Recommended)").** A browser's room send is ordered by default. Five publishers of ordered receipted sends at +5 ms, one track each, on three WS servers on PostgreSQL, did not keep up before: 154-174 of 200 complete over 20 s, 26-32 parked `pending-admission`, recipients 7.1-21.0 s behind; 131 of 450 over 45 s. Causes: an admission whose read and write straddle another commit on its track (a completion, or another admission's rewrite of the progress row's expiry) lost its write and was parked; a buffered release lost the same way and answered `retry`; the work rotation reads RETRY rows only after every NEW row. Built: an arrival, a retained admission's replay (asking its authority again each time) and a buffered release that lose their conditional write make a fresh attempt in the same call, each a full read, decision and write, at most three with no wait, through `retryALInboundLostWrite`, which the completion of D783 uses too; only a lost write is tried again (a readmission waiting for its first delivery answers `waiting`); three lost writes park or retry it as before. Measured: 200 of 200 in three 20 s runs and 450 of 450, none parked, recipients 0.6-0.7 s behind (at most 1.2 s), receipts read at 19.3-19.7 /s of 20.0-20.1. One track keeps up at 2 a second in every run, at 3 in three runs of four (before: none), at 4, 5 and 10 in none. Found: at 10 a second the progress row loses more writes (813-814 of 981-982; before 433-444 of 597-613), completions no worse; at 5 a second the track ends `resync-required` in both runs (before: neither); frames read twice at 10 a second on both trees, not probed; one five-publisher run on a loaded host (load 7.5 to 13.1) completed 108 of 200, 14 retried dispatch rows never claimed again; repeated, it passed. Not built: writing the progress row only when needed (the browser's marker cap would evict a live track's marker; the prototype's guard needs a visit-once walk); reading due retried rows with the new ones (2 of 100 on one track, frames read twice); admitting a track's arrivals in turn (an in-memory queue before a conditional write); claiming a track's next dispatch in the batch that completed its predecessor (not prototyped). The limit that stays: one track at 3 a second or more, and a single retried row still holds its track; faster streams are for ordering end to end in Rallar Web, planned separately (`plans/backlog.md`, "The limit of one ordered track"). Cost if wrong: an arrival under contention costs up to three read-and-write rounds before it is parked.                      |
