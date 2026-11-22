# The crash-surviving receipt

A sender's receipt on WebSocket stays exact when the server instance that admitted the send crashes or
restarts. The count of who confirmed a receipted room send moves out of one instance's memory into a
durable record every instance reads and writes.

Status: design, awaiting the maintainer's approval. Nothing is built.

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

## Goals

- A receipted WS send's receipt is the same whether or not the instance that admitted it survives: any
  instance counts any ACK, any instance ends the receipt, any instance answers a re-sent copy.
- One implementation of the count, on memory stores and on PostgreSQL.
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
  rewritten by open pull requests #869 and #868. Slice 1 touches neither. Slice 2 changes one hook in
  `alm/inbound` (section 3) and starts from `main` after #869 has merged.
- Decision rows D740 to D749 are reserved for this work.

## Design

### 1. The record

Rows in a namespace of its own on the server's shared AL admission backend:

- **Head**, one per receipted message, key `receipt:<origin>:<msgId>`: the frozen expected recipients,
  the snapshot version, the trace, the message deadline and the phase. While the phase is `open` the
  confirmation rows are the count. When it ends, the head takes the terminal phase (`complete` or
  `timed-out`) together with the confirmed and outside sets as they were read at that instant; from then
  on the head alone is the receipt.
- **Confirmation**, one per answering recipient, key `receipt-ack:<origin>:<msgId>:<recipient>`: whether
  the recipient confirmed or ended its hop outside the audience. An unfenced, idempotent write: a second
  ACK of the same recipient writes the same row.
- **Deadline work**, one due row per receipted message in the backend's work queue, at the message
  deadline.
- **Receipt work**, one row per terminal receipt, written by the transaction that ends the head.

The record's owner is one small class. Its operations, each returning a value:

| Operation | Does                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ |
| `open`    | One transaction: the head, fenced on its absence, and its deadline work                    |
| `count`   | Reads the head, writes the confirmation, reads the confirmations                           |
| `end`     | One transaction: the head's terminal phase and sets, fenced on the open head, receipt work |
| `read`    | The head, and the confirmations while it is open                                           |

`count` reads the confirmations only after its own write has committed. Of the last two confirmations,
whichever reads later sees both, so a completion cannot be missed. `end` is fenced on the head it read:
of several instances that try to end one receipt, one commits and the others read a conflict. There is
one terminal phase and one terminal receipt per message, whatever the clocks of the instances say.

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
4. When every expected recipient is confirmed or outside and one confirmed, the instance calls `end` with
   `complete`.

A confirmation written by an ACK that passed step 2 just before another instance ended the head is
ignored: after the end, the head's own sets are the receipt.

An ACK that finds no head has either overtaken the admitting instance's `open` (D696's race) or names a
message whose receipt has expired. It is checked against the inbound admission row, which every instance
shares: the row must hold the message under the origin the ACK names with the ACK's sender in its frozen
audience (`readIngressAudience`, unchanged). An ACK that passes writes its confirmation and stops; the
`open` that follows counts it. One that fails is refused. An ACK never opens a head.

The refusal today is the synchronous hook `readRelayedAckRejection` in `alm/inbound`, read against the
memory aggregate. With the record it must await a store read, so the hook becomes asynchronous. That is
the one change this work makes in `alm/inbound`.

The server's own ACK for a recipient it sent nothing (`writeServerAck`) becomes a `count` of an `outside`
confirmation on the instance that dropped the recipient. Nothing is handed to another instance.

### 4. Ending a receipt

`end` commits, in one transaction and guard first: the fence on the open head, the head's terminal phase
and sets, and one receipt work row. The work row is claimed by any instance and does what
`writeReceipt` does today: it enqueues the receipt control as a durable `WS_OUTBOX` row for the origin and
settles the server's own pending row on an `outbox` topic (D38) with it. The control's id is derived from
the origin and the message id, so a work row that is claimed twice enqueues one receipt.

A crash after the last confirmation is written and before `end` commits leaves a complete set under an
open head, and no further ACK will come. The deadline work ends it `complete`. The receipt is exact and
late, by at most the message's deadline. This is the one stated limit of the design.

### 5. The deadline is durable work

The per-instance deadline index and sweep go. `open` writes the deadline work with the head, in one
transaction, so no head is without one. When it comes due, whichever instance claims it reads the record
and calls `end`: `timed-out` naming the recipients confirmed so far, or `complete` when the set is
complete (the crash case above). A head already ended reads a conflict and nothing is written.

### 6. A re-sent copy is answered from the record

A copy accepted `duplicate` or `pending-admission` is answered from `read`, on any instance, to that
sender alone and under a fresh control id, as today: `admitted` with the confirmations so far while the
head is `open`, and the terminal receipt, from the head's own sets, once it has ended. The second half is
new: today nothing is answered after the end, which is how a send whose `complete` was lost ends `failed`
although delivered.

### 7. What is deleted

- The memory count, cap and sweep in `ws-queue-box-server-receipt-aggregation.ts`; what remains there is
  the translation from an admission or an ACK to the record's operations.
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
  `ws-outbound-dispatch-statements.test.ts` pins its path. Through the admission backend a write is a
  transaction, so the built path is expected at 4 to 5 round trips, none of them serialized against another
  ACK; the pin states the built figure.
- The sustained measurement above is repeated on the built path at +0 and +5 ms and must show no backlog;
  it is quoted in the pull request.
- The cluster recipe `api-v1-cluster-publisher-instance-loss` is restated: the publisher, reconnected to a
  survivor, reads `complete` for the broadcast its lost server admitted.
  `api-v1-cluster-subscriber-instance-loss` keeps its `timed-out`, since the lost subscriber cannot
  confirm.
- The ALM growth proof classifies the record's namespace; `test:api-v1:black-box:postgres:medium-scale`
  and the four ALM lane families over `ws` are green.

## Slices

1. The record on `ALAdmissionWorkBackend`, with its contract test on both backends. It touches no file an
   open pull request changes.
2. The WS server counts through the record: admission, ACK, the asynchronous refusal hook, terminal
   receipts, deadline work, re-sent copies; the memory count, cap and deadline index deleted. From `main`
   after #869.
3. The ACK relay deleted, with its notice, transport, channel and observation kind.
4. Proofs, recipes, documents: the backlog lines this closes removed, decision rows D740 onward, the
   outbound and WS server READMEs, the product description.

## Open rulings for the maintainer

1. **The server's own receipted publications.** The group-state delta counts its ACKs in the fenced
   pending row today, on the server's one version row. At +5 ms the measurement puts 50 confirmations at
   about four seconds there. Counting them in the record too would leave the server one count. It widens
   this work to the outbound owner's ACK path for server rows.
2. **A re-sent copy after the end** is answered with the terminal receipt again (section 6). It changes
   what a client that lost its `complete` reads, from `failed` to the true outcome.
3. **The record's standing under the mutation doctrine.** A recipient's ACK over WS writes the record
   directly, guard first and in one transaction, as the AL runtime's inbound and outbound stores are
   written at WS ingress today; it does not pass through AppInbox. The design treats the record as one
   more AL runtime store.

## Calls made here, each the maintainer's to overrule

- The record is its own feature folder under `packages/shared`, on the existing admission backend, in a
  namespace of its own that the growth proof classifies.
- The head and the confirmations expire at the message deadline plus the receipt grace, as the origin's
  receipt row does. A confirmation written for a message with no head expires after the receipt grace.
- Memory-mode servers use the same record on the memory backend; there is no separate memory count.
- The crash window in section 4 is closed by the deadline work, not by a nearer check.
- A terminal re-answer uses a fresh control id, as the `admitted` re-answer does; a client that already
  holds the terminal receipt refuses the second as it refuses any receipt for an ended message.
- One pull request, unless the plan shows two halves that each stand alone.

## Left to the builder

- The record's class and operation names, within the repository's code standard.
- Whether the head is cached per instance to save its read on later ACKs (`packages/shared/cache`).
- Whether the admission backend gains a single-statement write for one unfenced row, to bring the ACK's
  cost down to the measured 2 round trips.
- The exact key encoding, within the store's key rules.
- Which existing tests are restated and which are deleted.

## Not established

- Whether a terminal receipt reaches a publisher that was disconnected when the receipt row was first
  dequeued and reconnects within its deadline. The receipt row has a republish delay
  (`ws-queue-box-server-receipt-row.ts`); its behaviour for a target connected to no instance was not
  read. The restated publisher recipe depends on it.
- Whether the server's one outbound identity keeps up with the receipts themselves. Every `admitted` and
  terminal receipt is a fenced enqueue on it today, two per message; with five publishers at 2 Hz that is
  twenty fenced commits a second, and the measurement put a fence of 15 round trips at about 11 a second
  at +5 ms. The receipt enqueue's own round trips were not counted. The sustained proof must run with
  several publishers to show it.
- The cost of the record through the admission backend, as opposed to the runtime-state repository it was
  measured on.
- The hosted statement latency itself: 5 ms is one attributed run.
