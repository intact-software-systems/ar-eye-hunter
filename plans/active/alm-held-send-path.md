# ALM receipt truth: the held-send path

The slice the maintainer ordered after recovery under loss: part B of receipt truth (D642, the order of 2026-11-18).
A WS server sometimes keeps a room send instead of admitting it at once. This document says what a sender reads
today when that happens, what it will read after the slice, and how that is proven. Two investigations came first,
as ruled for the recovery slice: one ran twelve composed cases, the other read the fault edges. This document is the
design for approval; nothing is built yet.

## What was found (2026-11-20)

The server keeps a receipted room send on two paths (`acceptIncomingMessage`,
`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts`). The runs wired the WS client's
outbound runtime to the real server ingress, inbound lane and receipt aggregation, on memory stores, one instance,
with a hand-built recipient. Scratch tests and their output are kept outside the tree.

- **Kept behind the room view.** The server's room view is behind the sender (`not-yet-in-sync`). The send is kept,
  the sender is answered a `not-yet-in-sync` NACK, and no receipt aggregate starts.
  - Later admitted: delivered, and still no aggregate. The recipient's ACK is refused at ingress ("names no receipt
    this server aggregates") and nothing is stated. The sender receives no receipt.
  - Later refused (the sender was fenced when the view caught up): the replay ends the row and sends nothing. The
    authorizer's reason is lost; the verdict reads `unauthorized`.
  - Never caught up: at its deadline the row is no longer handed out, so nothing runs and nothing is stated.
- **Kept after a lost commit race** (D640). The aggregate starts and `admitted` is written at ingress, before the
  replay has decided.
  - Later admitted: the sender reads `admitted`, then `complete`, as for any send.
  - Later refused: the aggregate lives to its deadline and writes `timed-out`. In one run it counted a recipient's
    ACK and wrote `complete` for a message that was never delivered.
- **Not about kept sends.** A `timed-out` receipt that confirms nobody new is refused by the WS client ("AL receipt
  moves no receipt of its message"): `hasSameReceipt` compares the peer lists and not the phase
  (`compute-al-outbound-receipt-admission.ts`). A receipted `ws` send that nobody acknowledges never states its end.
- **The replay tells nobody.** Its verdict reaches only diagnostics (`recordReplayedAdmission`,
  `al-inbound-store-lane.ts`). No server dependency learns that a kept send was admitted or refused.
- **Cluster, read and not run.** In api-v1 the kept rows and the work they write are in PostgreSQL under one
  namespace, so any instance can replay a row another instance kept. The receipt aggregate is in one instance's
  memory. A receiver ACK that lands elsewhere is handed to the holder once, through the relay publisher.
- **Fault edges, read and partly inferred.**
  - When the instance that admitted a send dies, a survivor still delivers it (the work is durable), but the
    aggregate is gone: relayed ACKs are dropped and no `complete` or `timed-out` is ever written.
  - The lost session of D669 stayed in presence because the recipe's presence lease defaults to 24 h. A browser's
    lease is 120 s, renewed every 20 s; an expired session leaves new audiences when the audience is read.
  - `repair-exhausted` under `rtc-with-ws-fallback`: `repair-exhausted` is not a fallback trigger. Three `not-ready`
    RTC attempts hand the send over, and the cell holds its `ws` copy too, so nothing charges it. A hypothesis: the
    send stays open to its 30 s deadline, beyond the cell's 10 s window.

## Goals

- A kept send's receipt starts when the server admits it, and not before (D642), on both paths.
  - Kept behind the room view, then admitted: the sender reads `admitted` and then `complete` or `timed-out`, where
    today it reads nothing.
  - Kept after a lost race, then refused: no aggregate exists, so no `admitted`, no `timed-out` and no counted ACK
    for a message nobody received.
- A kept send the server later refuses is answered with the refusal an ingress refusal sends: the same NACK, with
  the authorizer's own reason.
- A `timed-out` receipt always ends its receipt at the sender, whoever it confirms.
- Two proofs of today's behaviour, changing nothing:
  - a cluster recipe that crashes the publisher's instance after `admitted`, and reads what the publisher and the
    subscribers then receive;
  - a unit case that pins what a held send does after its carrier hands over.

## Non-goals

- A receipt that survives a server crash (a stored or cluster-wide aggregate). The recipe pins the limit.
- A hold per recipient (D690's next step). It needs a retry budget and held state per recipient; its own slice.
- Telling the sender that a kept send expired. Ruled 2026-11-20: the handle's own deadline says so.
- An ACK counted before its message was delivered, sent by a room member that never received it. It belongs with
  the relay statement rules (part C).
- The kept row's 50 ms poll of the room authorizer, and the replay not reading the sender's connection again. Both
  are recorded in the backlog.
- Any change to presence leases or to the recipe's 24 h default.

## Anti-goals

- A second path for the receipt. A kept send's receipt starts through the same function a fresh admission's does.
- A server that says `admitted` for a send it has not admitted.
- A resend introduced to get a receipt. D694 stands: the server's `not-yet-in-sync` ends the first-hop wait.
- A timeout, budget, page size or window changed to make a proof green.
- A compatibility path for an older row or wire shape. No wire shape changes in this slice.

## Constraints

- Maintainer, standing: subagents and TDD; no legacy, no migration code, no duplicated code, unused code deleted,
  shared libraries preferred; the repository's code standard; authoritative writes follow
  `convergent-service-writing.md`.
- The ALM lane's cells pass unchanged on their carriers, three runs each with no retries where a cell is touched.
- The medium-scale gate, the black-box profiles and the PostgreSQL integration lane stay green, unweakened.
- Bundle budgets are the one adjustable bound: raised to the next whole KiB, with the measured size reported.

## Approaches

How the server learns that a kept send was admitted:

1. **The replay hands its verdict to its owner (chosen).** The inbound lane already holds the kept row and the
   verdict where it records diagnostics. One new dependency of the inbound runtime carries an admitted replay's
   message and the source it was admitted under; the WS server answers it by starting the receipt. One path, no
   timer, no extra read.
2. The server looks its kept rows up. It would poll or index the admission store for rows it retained. A second
   reader of the same rows, with a timer, on every instance.
3. Start the aggregate when the send is kept, on both paths, and end it on a refusal. The sender would still read
   `admitted` for a send the server has not admitted, which D642 rules out.

How a later refusal reaches the sender:

1. **The authority that refuses answers (chosen).** `readPendingAdmissionAuthority` has the authorizer's refusal in
   hand; it sends the NACK `rejectIncomingMessage` sends at ingress and then answers `rejected`. The lane learns
   nothing new.
2. The lane carries the refusal to the server through the verdict hand-over. It would put a server authorization
   shape into the shared inbound runtime.

## Design

- **Retention starts no receipt.** `writeAdmittedReceipt` starts an aggregate only for an acceptance of kind
  `admitted`. A copy accepted `duplicate` or `pending-admission` is still answered `admitted` again when an
  aggregate is live (D678), and nothing otherwise.
- **An admitted replay starts it.** After a replay whose verdict is `admitted`, the lane calls the new dependency
  with the message and the source the replay ran under (its frozen audience included). The WS server calls
  `writeAdmittedReceipt` with them. A verdict of `duplicate`, `not-admitted` or a rejection starts nothing.
- **Order.** The hand-over runs inside the batch that replayed the row, before that batch returns. The work the
  replay wrote runs in a later batch, so on one instance the aggregate exists before a recipient can ACK, as the
  service's comment requires of a fresh admission.
- **A refusal answers.** When the current authority refuses a kept send for a reason other than `not-yet-in-sync`,
  the server sends the advisory NACK for that reason. A refusal the replay's own plan states (`held-by-other`,
  `resync-required`) already sends its NACK.
- **`timed-out` ends the receipt.** The "moves no receipt" refusal no longer applies to a `timed-out` receipt.
  What the client states for it is what it states today for a `timed-out` that confirms somebody.
- **What a sender reads, after.**

  | The server                             | The sender reads                                                       |
  | -------------------------------------- | ---------------------------------------------------------------------- |
  | keeps behind the view, later admits    | `not-yet-in-sync`, then `admitted`, then `complete` or `timed-out`     |
  | keeps behind the view, later refuses   | `not-yet-in-sync`, then the refusal's NACK; the handle ends `rejected` |
  | keeps behind the view to the deadline  | `not-yet-in-sync`; the handle reads `expired` at its deadline          |
  | keeps after a lost race, later admits  | `admitted`, then `complete` or `timed-out`                             |
  | keeps after a lost race, later refuses | the refusal's NACK only; the handle ends `rejected`                    |

## Calls made here, for the maintainer to overrule

- **The receipt lives on the instance that admits.** In a cluster the replay can run on another instance than the
  one holding the sender's socket. The aggregate is then in that instance's memory; its receipts reach the sender
  through the outbox as today, and ACKs reach it through the relay publisher. Cost if wrong: a deployment without a
  relay publisher loses the ACKs of a send another instance admitted.
- **A sender kept after a lost race hears nothing until the replay decides.** The replay runs in the next batch, so
  the gap is short; the first-hop wait covers a longer one with its resend after 2 s. Cost if wrong: one more frame
  from a sender whose replay took over 2 s.
- **A race that exists today stays.** Another instance can claim a delivery row before the admitting instance has
  recorded the aggregate, for a fresh admission and for a replay alike. An ACK that arrives in that gap is dropped,
  and the receipt ends `timed-out` for that recipient. Recorded, not fixed.
- **A replay that committed and then crashed starts no receipt.** The next replay reads `duplicate`. This is the
  crash limit the publisher recipe pins.
- **The refusal's NACK can be sent twice** when a replay is retried after it sent one. The second names a message
  the sender already ended and is refused there.

## Proofs

- Composed unit cases, each red first: the five rows of the table, a copy that arrives while its original is kept
  (on each path), and an unacknowledged send that ends at `timed-out`. They wire the WS client sender to the real
  server ingress and aggregation, with a recipient that ACKs.
- The D640 characterization (`ws-queue-box-client-relay-rejection.test.ts`) is restated: no `admitted` receipt
  follows the refusal, because none is written.
- D694's pin (`al-outbound-first-hop-retained-send.test.ts`) keeps its frame count and its ended wait; its
  statement that no receipt follows is restated to the receipts the admitting replay now writes.
- One PostgreSQL integration case: a row kept under one instance's runtime and replayed under another's starts the
  aggregate on the replaying instance.
- `api-v1-cluster-publisher-instance-loss` (cluster profile): the publisher's instance is crashed after `admitted`
  and after the subscribers received the message; the subscribers' ACKs then meet no aggregate, and the publisher,
  reconnected to a survivor, receives neither `complete` nor `timed-out` through the deadline and its grace. Shown
  to fail on a stand-in. If the crash point cannot be made deterministic with today's fault steps, the recipe is
  left out and the finding recorded.
- One unit case for the handed-over held send, stating what the run shows and no more.
- The ALM lane families on `ws` and `rtc`, and every gate the last slice ran.

## Left to the builder

- The name and shape of the new dependency, beside `onControlMessage` in the inbound runtime's dependencies.
- How the source's audience becomes the aggregation's room audience, the snapshot version included.
- Whether a lane cell meets a kept send deterministically. If one does, it gains the receipt statement; none is
  added for it otherwise.
- Records: decision rows from D696 (D695 is PR 851's), the backlog lines this slice closes and opens, the two ALM
  READMEs, the API reference and the addendum's horizon.
