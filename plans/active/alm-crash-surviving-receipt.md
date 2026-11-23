# The crash-surviving receipt

A sender's receipt on WebSocket stays exact when the server instance that admitted the send crashes or
restarts. The count of who confirmed a receipted room send moves out of one instance's memory into a
durable record every instance reads and writes.

Status: approved by the maintainer on 2026-11-22; slice 1 built.

## Why

A receipted room send over WS (`ack: 'receiver'` or `'leader'`) is counted by
`WsQueueBoxServerReceiptAggregation`, in the memory of the instance that admitted it (D37). The receipts
themselves (`admitted`, `complete`, `timed-out`) are durable `WS_OUTBOX` rows, and the frozen audience is
in the inbound admission store every instance shares, but the count is not. So:

- When the admitting instance dies, the publisher, reconnected to a survivor, reads neither `complete` nor
  `timed-out` (`api-v1-cluster-publisher-instance-loss`, D700).
- A re-sent copy that reaches an instance with no live aggregate is answered nothing, so a send can end
  `failed` although it was delivered (D678).
- An ACK that lands on another instance is handed over by one best-effort NOTIFY notice; without that
  publisher, or when the notice is lost, the ACK counts nowhere (D106, D696).
- An ACK that arrives on another instance before the admitting one has recorded its aggregate is dropped
  (D696).
- The set is capped at 4 096 aggregates; the oldest is ended `timed-out` at the cap (D191).

The first hosted campaign's first fault stops one of three replicas for 30 s and passes only when every
receipt settles within 45 s. Today that run cannot pass.

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

The built record was measured again in the same sustained shape; see "Measured on the built record".

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
  (`ws-queue-box-server-receipt-deadline-index.ts`, `ws-queue-box-server-ack-relay.ts`) and none is added:
  the record is its own feature folder, and the aggregation file is rewritten in place.
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
  wins, and a second ACK of the same recipient is a typed no-op (`repeated`) that writes nothing. A row is
  read back only under its exact key; a row under another key fails closed as corruption.
- **Deadline work**, one due row per receipted message in the backend's work queue, at the message
  deadline, written with the head.
- **Ended work**, one row per terminal receipt, due at the end, written by the transaction that ends the
  head.

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
the clock of the instance that reads them. On PostgreSQL, work rows come due and are swept on the database
clock, and a fenced write takes an expired row that no sweep has deleted as gone only once the database clock
has passed its expiry. A `count` that read an open head can commit after
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
shares: the row must hold the message under the origin the ACK names with the ACK's sender in its frozen
audience (`readIngressAudience`, unchanged). An ACK that passes writes its confirmation and then reads the
record (`countAhead`): when a head has appeared since its first read, it returns the view, so an `open`
that committed between the two cannot leave a complete set unseen; otherwise the `open` that follows
counts it. One that fails is refused. An ACK never opens a head.

The refusal today is the synchronous hook `readRelayedAckRejection` in `alm/inbound`, read against the
memory aggregate. With the record it must await a store read, so the hook becomes asynchronous. That is
one of two changes this work makes in `alm/inbound`; the other moves `al-inbound-work-entry.ts`, which open
pull request #868 changes, onto `computeALWorkEntry`.

The server's own ACK for a recipient it sent nothing (`writeServerAck`) becomes a `count` of an `outside`
confirmation on the instance that dropped the recipient. Nothing is handed to another instance.

### 4. Ending a receipt

`end` commits, in one transaction and guard first: the fence on the open head, the head's terminal phase
and sets, and one ended work row. The work row is claimed by any instance and does what `writeReceipt`
does today: it enqueues the receipt control as a durable `WS_OUTBOX` row for the origin, under a control
id derived from the origin and the message id, so a work row that is claimed twice enqueues one receipt;
then `acceptServerReceipt` settles the server's own pending row on an `outbox` topic (D38) with it. The
`admitted` receipt is enqueued at admission, as today.

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

### 6. A re-sent copy is answered from the record

A copy accepted `duplicate` or `pending-admission` is answered from `read`, on any instance, to that
sender alone and under a fresh control id, as today: `admitted` with the confirmations so far while the
head is `open`, and the terminal receipt, from the head's own sets, once it has ended (ruling 5). The
second half is new: today nothing is answered after the end, which is how a send whose `complete` was lost
ends `failed` although delivered.

A re-sent copy that finds no head opens the record from the frozen audience of the inbound admission row
and is answered `admitted` (the controller's ruling R11). It covers the window between the admission commit
and `open`, in which the admitting server can die. Its limits: a message that names no deadline, a message
whose deadline lies beyond the record's window, and an admission row frozen to nobody open nothing on this
path; nor does a copy of a message already as old as the window by its own timestamp.

### 7. The server's own receipted publications

The server's own receipted publications, of which the group-state delta is the production one, count in
the record too (ruling 4). Today their ACKs, addressed to the server, are admitted into the server's
fenced `receiver` pending row, every one a commit on the server's one version row.

- The record is opened when the server enqueues a receipted publication of its own, under the server's
  peer id as origin, with the audience the publication was admitted for.
- An ACK addressed to the server is counted in the record when its message opened one; any other control
  addressed to the server goes to the server's outbound owner as today.
- A recipient the server sent nothing, on its own rows as on a client's, is one `outside` confirmation in
  the record. The fenced `commitOutsideAudience` on the pending row, with its three tries and its
  diagnostic, goes.
- Ending writes the ended work as for a client's send. The work has no origin to answer; it settles the
  server's pending row with the terminal receipt and states the settlement the admin read shows.

The pending row stays, on `outbox` topics for a client's send (D38) and for the server's own rows, as the
record of what is still to be retransmitted. It no longer learns of a confirmation until the receipt ends,
so the WS server's repair plan leaves out the recipients the record has confirmed. A retransmission then
reaches the recipients that have not confirmed, as it does today.

### 8. The record under the mutation doctrine

A recipient's ACK over WS writes the record directly, guard first and in one transaction. It does not pass
through AppInbox. The record is one more AL runtime store (ruling 6), written at WS ingress as the AL
runtime's inbound and outbound stores are; D740 states it.

### 9. What is deleted

- The memory count, cap and sweep in `ws-queue-box-server-receipt-aggregation.ts`; what remains there is
  the translation from an admission or an ACK to the record's operations.
- The counting of ACKs in the server's own pending row, and `commitOutsideAudience` with its caller in
  `ws-queue-box-server-track-order.ts`.
- `ws-queue-box-server-receipt-deadline-index.ts`.
- `ws-queue-box-server-ack-relay.ts`, `relayed-ack-notice.ts`, `relayed-ack-notice-subscriber.ts`,
  `create-postgres-relayed-ack-notice-transport.ts`, their notice channel, and the `ack-relay` observation
  kind.
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
  the end, ignored; an ACK from outside the expected set, nothing written; expiry.
- PostgreSQL integration: a send admitted on one instance and confirmed on two others completes; the
  admitting instance is disposed after `admitted` and the receipt still completes; the deadline work is
  claimed by a survivor and ends the receipt `timed-out`.
- A statement pin of the ACK that finds its head and does not complete the set, as
  `ws-outbound-dispatch-statements.test.ts` pins its path. The built figure is five round trips: one
  autocommit read of the head and the confirmation key, the insert in one transaction (with BEGIN and
  COMMIT), and one autocommit prefix read of the confirmations, none of them serialized against another
  ACK.
- The sustained measurement above is repeated on the built path at +0 and +5 ms and must show no backlog;
  it is quoted in the pull request.
- The cluster recipe `api-v1-cluster-publisher-instance-loss` is restated: the publisher, reconnected to a
  survivor, reads `complete` for the broadcast its lost server admitted.
  `api-v1-cluster-subscriber-instance-loss` keeps its `timed-out`, since the lost subscriber cannot
  confirm.
- The group-state delta's receipt: fifty sessions confirming at once complete it with no fenced commit per
  ACK, and a retransmission inside the window reaches only the sessions that have not confirmed.
- The ALM growth proof classifies the record's namespace; `test:api-v1:black-box:postgres:medium-scale`
  and the four ALM lane families over `ws` are green.

## Slices

1. Built. The record on `ALAdmissionWorkBackend`, with its contract test on both backends, its statement
   pin, its growth-proof classification and its sustained measurement. It touches no file an open pull
   request changes.
2. The WS server counts through the record: admission, ACK, the asynchronous refusal hook, terminal
   receipts, deadline work, re-sent copies; the memory count, cap and deadline index deleted. Built on
   this branch without waiting for #869 to merge; #869's rules for the aggregation and the service are
   carried into the record-based code, so the later merge of `main` is textual.
3. The ACK relay deleted, with its notice, transport, channel and observation kind.
4. The server's own receipted publications count in the record; the repair plan reads the record's
   confirmations; `commitOutsideAudience` deleted.
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

## Not established

- The hosted statement latency itself: 5 ms is one attributed run.
- Whether the server's one outbound identity keeps up with the receipts themselves. Every `admitted` and
  terminal receipt is a fenced enqueue on it, two per message. From the counted round trips the estimate
  is about 110, 37 and 18 enqueues a second at +0, +2 and +5 ms; one publisher at 2 Hz offers 4 a second,
  five offer 20. The sustained proof of slice 5 runs with several publishers to show it.
- The record's cost and lag inside the WS server: the measurement above runs the record alone, with one
  origin, on one machine with a delay standing in for the network. The ingress checks, the inbound
  admission read of an ACK that finds no head, and the receipt enqueue are not in it.

## Decision rows drafted

Appended to `playground/alm/alm-improvement-plan.md` in slice 5.

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D740 | **The receipt record is one more ALM runtime store (the maintainer's ruling 6 of 2026-11-22).** A receipted WS send's count lives in `ALReceiptRecord`, its own feature folder `packages/shared/alm/receipt-record/`, on the shared AL admission backend (`ALAdmissionWorkBackend`) in the namespace `<store namespace>:receipt:record` (`toALReceiptRecordNamespace`; on api-v1 `server-ws-qbox:default-qbox-server:receipt:record`). A recipient's ACK writes it directly at WS ingress, guard first and in one transaction, as the AL runtime's inbound and outbound stores are written; it does not pass through AppInbox. The deadline and the end are work rows on the backend's own work queue, which any instance claims. No new adapter: the memory and PostgreSQL backends already implement the port. One shared file is added beside it, `packages/shared/alm/work/compute-al-work-entry.ts`, the work-entry envelope; the outbound and inbound builders move onto it in slice 2. Cost if wrong: the record would move behind AppInbox, one mutation command per ACK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D741 | **Unfenced rows on the admission backend: their cost and isolation, and which backends keep a revision (probe of slice 1).** Through `PSqlAdmissionWorkBackend`, 30 concurrent unfenced writes to distinct keys of one namespace, from three backends on three clients, committed with 0 conflicts; a write to another key committed in 63 ms while a first write's transaction was held open (`committed`, not `blocked`). One unfenced write is `[null, 1]`: the key read in autocommit and the conditional insert in one transaction, 4 round trips with BEGIN and COMMIT. No backend keeps a store-wide revision: IndexedDB observes the written key's own row (`indexed-db-admission-backend.ts`), memory serializes every write of one state and conflicts only on an observed work batch (`al-admission-backend.ts`), PostgreSQL keeps a revision per row. Two comments still say IndexedDB keeps a store-wide revision (`ALAdmissionBackendConflictError.ts`, `al-outbound-admission-fences.test.ts`); they are corrected when slice 2 touches the area. Pinned in `al-admission-unfenced-row-writes.test.ts`. Cost if wrong: the record's count would need a fence per ACK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D742 | **The receipt record's contract.** A head per receipted message at `<ns>:receipt:<JSON [origin, msgId]>` (`{ phase: 'open', opening }`, or `complete`/`timed-out` with `confirmedRecipientPeerIds` and `outsideAudienceRecipientPeerIds` in expected order, each recipient named once, and `endedAtEpochMs`), and a confirmation per answering recipient at `<ns>:receipt-ack:<JSON [origin, msgId]>:<recipient>` (`{ recipientPeerId, kind: 'confirmed' \| 'outside', countedAtEpochMs }`), read back only under its exact key; a row under another key fails closed as `ALAdmissionCorruptionError`. `open` stores the opening's named fields only. Expiry: the open head and the deadline work at `deadlineAtMs + 30 s`; a confirmation under a head at `deadlineAtMs + 60 s`, one grace after its head, so an `end` that reads a live head reads its confirmations; the ended head and the ended work at `max(deadlineAtMs, endedAtEpochMs) + 30 s`; a confirmation written with no head at `now + 30 min + 30 s`. The tally of an open head counts only the confirmations whose `countedAtEpochMs` lies before `deadlineAtMs`. Work rows of type `AL_RECEIPT_RECORD:<fnv1a64(ns)>`, topics `AL_RECEIPT_DEADLINE` (due at the deadline, written with the head) and `AL_RECEIPT_ENDED` (due at the end, written with the terminal head). Results are values: `open` returns the view, `invalid-opening` (every issue of `empty-audience`, `audience-over-limit`, `receipt-expired`, `deadline-beyond-window` and `malformed-opening`) or `conflict`; `count` returns `counted` or `repeated` with the view, `head-absent`, `invalid-confirmation` or `conflict`; `countAhead` as `count`, or `ahead` when no head is visible after its write; `end` the ended head, `head-absent`, `not-due` (nothing written) or `conflict`; `read` the view or `head-absent`. Only `ALAdmissionBackendConflictError` becomes `conflict`; every other backend error propagates. A `count` that read an open head can commit after another instance's `end`; its view may then say `open`, even `complete: true`, for a receipt stored `timed-out`. Only `end`'s result is authoritative, and slice 2's caller treats it so. A contract of 27 cases (`describeALReceiptRecordContract`) runs on memory and on PostgreSQL. Cost if wrong: a contract change restates the cases on both backends. |
| D743 | **The receipt record's decisions.** (1) A confirmation written with no head expires at `now + window + grace`, not after the 30 s grace the design first stated: while the head is open the rows are the count, so a shorter expiry would time out a receipt naming a recipient that confirmed (the controller's ruling R2, the maintainer told). (2) `countAhead` reads after its write: an `open` that commits between that ACK's head read and its write would otherwise leave a complete set unseen until the deadline. (3) A repeated confirmation is a typed no-op (`repeated`, first write wins), not a refusal: two instances can each validate before either writes, so a refusal could not be exact. (4) `end` takes no phase: it ends `complete` when the set it reads is complete, `timed-out` once the deadline has passed, and is `not-due` otherwise, so no caller can state a phase the record does not hold. (5) The store bounds its rows: `open` refuses a deadline beyond `now + window` (`deadline-beyond-window`) and a receipt already past its grace (`receipt-expired`), and the caller clamps; it also refuses an empty audience (`empty-audience`), which could never complete, an audience above the message collection limit (`audience-over-limit`), and an opening the stored-head decoder would refuse (`malformed-opening`), which would commit a head no read could use. (6) A confirmation under a head expires one grace after its head (ruling R13): a deadline pass that runs late reads the head and the confirmations as two reads, and with equal expiries could read a live head and no confirmation, ending `timed-out` naming nobody. (7) The tally of an open head ignores a confirmation counted at or after the head's deadline (ruling R14): a row written ahead passes no validator, and a head opened afterwards would otherwise count an ACK `count` refuses. Also: a terminal set names a recipient once; the open-head tally passes the expected recipients without repeats, first occurrence kept (ruling R7). Cost if wrong: (1) changes two contract cases and adds an adoption write; (4) a caller-stated phase; (6) 30 s less life per confirmation row; (7) one filter in one pure function.                                                                                                                            |
| D744 | **The pinned cost of a non-completing ACK, and three backends without a conflict.** On PostgreSQL an ACK that finds its head open and does not complete the set is three statements and one transaction, `[null, 1, null]` with leading verbs `select`, `insert`, `select`: one autocommit read that batches the head and the confirmation key, the confirmation insert in transaction 1, one autocommit prefix read of the confirmations for the tally; five round trips with BEGIN and COMMIT. Fifty confirmations of one message from three backends with pools of 10 committed with no conflict, each `counted`; a second count committed while another instance's count was held uncommitted (`finished`, not `blocked`); of three backends ending the receipt together, one commit won with all 50 confirmed and the other two read `conflict`. No head cache and no single-statement unfenced write were needed. Sustained, 40 messages of 14 ACKs at 28 a second on three instances: no backlog at +0 or +5 ms; at +5 ms the lag from a message's last ACK to its `complete`, p50 / p95 / max per run, was 60.5 / 65.1 / 82.3, 62.8 / 72.0 / 80.3 and 61.8 / 68.3 / 72.0 ms, and the last ten messages' p50 (59.9 to 61.2 ms) was no slower than the first ten's (58.2 to 64.0 ms); 560 of 560 confirmations, 40 of 40 heads complete, one `end` winner per message, in three runs of each. Pinned in `al-receipt-record.test.ts`. Cost if wrong: the levers are a per-instance head cache and a single-statement unfenced write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D745 | **The receipt record's namespace in the growth proof.** The `runtime_state_store` namespace `<store>:receipt:record` (sampled as `server-ws-qbox:*:receipt:record`) is growth surface 85, class `ttl-within-run`, ttl `AL_RECEIPT_RECORD_WINDOW_MS + 2 × AL_RECEIPT_DEADLINE_GRACE_MS` = 1 860 000 ms, sweep 60 000 ms. The longest-lived rows are a confirmation under a head, which expires two graces after its head's deadline, and an ended head, which expires one grace after an end that comes at most one grace after the deadline; that deadline is at most one window after opening. Open heads and confirmations written with no head live at most window plus one grace. The record's work rows are expiring `resource_inbox` rows under surface 1. In `growth-surfaces.ts`, tied to `toALReceiptRecordNamespace` by `growth-surfaces.test.ts`. Cost if wrong: the growth gate reads a bound the rows can exceed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
