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
- The record makes 2 round trips per ACK (one insert, one read of the head and the confirmations) and one
  more for an ACK that sees the set complete. Three runs of each cell: all 560 confirmations present,
  every head complete, exactly one winner per message, no backlog.
- Neither build lost an ACK.

The fence was designed for one browser counting its own ACKs. On a server many recipients confirm at once
from many sockets on many instances; a confirmation is idempotent and commutative, so it needs no fence.

## Goals

- A receipted WS send's receipt is the same whether or not the instance that admitted it survives: any
  instance counts any ACK, any instance ends the receipt, any instance answers a re-sent copy.
- One implementation of the count, on memory stores and on PostgreSQL.
- The cost on the hot path is bounded and pinned: at most 3 database round trips per ACK.
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
- A statement of `complete` for a recipient that did not confirm, under any interleaving.

## Constraints

- No migration code and no legacy path: the memory count is deleted in the same pull request that adds the
  record. A cluster deploys all instances together, as D722 already requires.
- `packages/shared` stays free of PostgreSQL. The record's port and its memory store live in
  `packages/shared`; the PostgreSQL adapter lives in `packages/shared-server` beside the rows it owns.
- `packages/shared/services/ws-queue-box-server` is at the directory-density limit. Three files leave it
  in this work, which makes room for the record's caller; the record itself is its own feature folder.
- Expected failure is a value (`Either`). The record's writes are conditional and never throw for a
  conflict.
- The files `packages/shared/alm/inbound/**` and `packages/shared/alm/outbound/control/**` are being
  rewritten by open pull requests #869 and #868. This design avoids editing them.
- Decision rows D740 to D749 are reserved for this work.

## Design

### 1. The record

Three kinds of row, in the server's shared AL runtime store, all expiring with the receipt:

- **Head**, one per receipted message, key `receipt:<origin>:<msgId>`: the frozen expected recipients,
  the snapshot version, the trace, the message deadline, and the phase (`open`, `complete`, `timed-out`).
  Written with insert-if-absent.
- **Confirmation**, one per answering recipient, key `receipt-ack:<origin>:<msgId>:<recipient>`: whether
  the recipient confirmed or ended its hop outside the audience. Written with insert-if-absent. A second
  ACK of the same recipient is a conflict and changes nothing.
- **Deadline work**, one per receipted message, a due row in the shared work queue at the message
  deadline, claimed by any instance.

The record's owner is one small class with four operations, each returning a value:

| Operation | Does                                                                                 | Round trips |
| --------- | ------------------------------------------------------------------------------------ | ----------- |
| `open`    | Inserts the head and the deadline work if absent                                     | 1 to 2      |
| `count`   | Inserts the confirmation, then reads the head and all confirmations in one statement | 2           |
| `end`     | Compare-and-set of the head's phase from `open`, on the revision it read             | 1           |
| `read`    | The head and the confirmations, for a re-sent copy                                   | 1           |

`count` reads only after its own insert has committed. Of the last two confirmations, whichever reads
later sees both, so a completion cannot be missed.

### 2. Admission opens the record

Where `writeAdmittedReceipt` records an aggregate today, the server opens the record and writes the
`admitted` receipt as it does now. This holds for a send admitted at ingress and for a kept send admitted
by its replay (D697), with the same expected audience as today. An empty audience is complete as it is
admitted and opens no record, as today.

### 3. Any instance counts an ACK

A recipient's ACK addressed to the origin is counted where it arrives:

1. The checks that need no store stay at ingress: the sender is the authenticated session, speaks for
   itself, and addresses the origin it names.
2. `count` inserts the confirmation and reads the record.
3. The read is validated as the aggregate validates today: the head exists and is `open`, the recipient is
   expected, the deadline has not passed. An ACK that fails is refused with the same typed rejection.
4. When every expected recipient is confirmed or outside and one confirmed, the instance writes the
   `complete` receipt and ends the head.

An ACK that finds no head, because it overtook the admitting instance's `open`, opens the record itself
from the admission row the inbound store already holds, then counts. That closes D696's race.

The server's own ACK for a recipient it sent nothing (`writeServerAck`) becomes a `count` of an `outside`
confirmation on the instance that dropped the recipient. Nothing is handed to another instance.

### 4. Terminal receipts are written once

A terminal receipt's control id is derived from the origin, the message id and the phase, not random. The
receipt is enqueued with the outbound owner's existing enqueue-if-absent, so several instances that see
the set complete write one row between them. The head's phase is then set by compare-and-set; it stops
further attempts and answers later readers. The server's own pending row on an `outbox` topic (D38) is
settled by that receipt exactly as it is today.

Order: enqueue the receipt, then end the head. A crash between the two leaves the receipt written and the
head `open`; the next reader finds the set complete, enqueues nothing new and ends the head.

A crash after the last confirmation and before the receipt is enqueued leaves a complete set with no
receipt. The deadline work finds it and writes `complete`. The receipt is exact and late, by at most the
message's deadline. This is the one stated limit of the design.

### 5. The deadline is durable work

The per-instance deadline index and sweep go. When the deadline work comes due, whichever instance claims
it reads the record: a head still `open` gets `timed-out` naming the recipients confirmed so far, or
`complete` when the set is complete (the crash case above); a head already ended gets nothing.

### 6. A re-sent copy is answered from the record

A copy accepted `duplicate` or `pending-admission` is answered from `read`, on any instance: `admitted`
with the confirmations so far while the head is `open`, and the terminal receipt again once it has ended.
The second half is new: today nothing is answered after the end, which is how a send whose `complete` was
lost ends `failed` although delivered.

### 7. What is deleted

- `ws-queue-box-server-receipt-aggregation.ts`'s memory count, cap and sweep; what remains is the
  translation from an admission or an ACK to the record's operations and the receipt write.
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
2. **A per-recipient record** (chosen). No fence, 2 to 3 round trips per ACK, measured to keep up at
   +5 ms. Costs one row per confirming recipient with five index entries each, and a second durable place
   that knows about a receipt beside the D38 row.
3. **Checkpoint the memory count and let a survivor adopt it.** Dropped: it needs instance liveness and
   ownership transfer and still loses the ACKs inside the checkpoint window.

## Proof

- A contract test of the record on the memory store and on PostgreSQL: concurrent confirmations, exactly
  one terminal winner, a duplicate confirmation changes nothing, an ACK before the head, expiry.
- PostgreSQL integration: a send admitted on one instance and confirmed on two others completes; the
  admitting instance is disposed after `admitted` and the receipt still completes; the deadline work is
  claimed by a survivor and writes `timed-out`.
- A statement pin: at most 3 round trips per ACK, as `ws-outbound-dispatch-statements.test.ts` pins its
  path.
- The cluster recipe `api-v1-cluster-publisher-instance-loss` is restated: the publisher, reconnected to a
  survivor, reads `complete` for the broadcast its lost server admitted.
  `api-v1-cluster-subscriber-instance-loss` keeps its `timed-out`, since the lost subscriber cannot
  confirm.
- The sustained measurement above is repeated on the built path at +0 and +5 ms and quoted in the pull
  request.
- The ALM growth proof classifies the record's rows; `test:api-v1:black-box:postgres:medium-scale` and
  the four ALM lane families over `ws` are green.

## Slices

1. The record: port, memory store, PostgreSQL adapter, contract test.
2. The WS server counts through the record: admission, ACK, terminal receipts, deadline work, re-sent
   copies; the memory count, cap and deadline index deleted.
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

## Calls made here, each the maintainer's to overrule

- The record is its own feature folder under `packages/shared`, with its PostgreSQL adapter under
  `packages/shared-server`; its rows live in the server's existing AL runtime store namespace family and
  are classified in the growth proof.
- Rows expire at the message deadline plus the receipt grace, as the origin's receipt row does.
- Memory-mode servers use the same record on a memory store; there is no separate memory count.
- The crash window in section 4 is closed by the deadline work, not by a nearer check.
- One pull request, unless the plan shows two halves that each stand alone.

## Left to the builder

- The record's port shape and names, within the repository's code standard.
- Whether the head's expected set is cached per instance to save the read on later ACKs.
- The exact key encoding, within the store's key rules.
- Which existing tests are restated and which are deleted, from the list the code map produced.

## Not established

- Whether a terminal receipt reaches a publisher that was disconnected when the receipt row was first
  dequeued and reconnects within its deadline. The receipt row has a republish delay
  (`ws-queue-box-server-receipt-row.ts`); its behaviour for a target connected to no instance was not
  read. The restated publisher recipe depends on it.
- Whether the inbound admission row holds everything an ACK needs to open a head it finds missing (the
  snapshot version and the replay-narrowed audience in particular).
- Where the two round trips per ACK that the existing ingress path already makes come from; they are
  outside the record and were not pinned to a line.
- The hosted statement latency itself: 5 ms is one attributed run.
