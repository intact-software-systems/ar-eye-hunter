# ALM recovery under loss, part two: the first hop and the repeated gap

The slice the maintainer ordered after the queue-order fix (D673): an ordered stream over `ws` must recover when a
repair frame is lost. A unit reproduction came first, as ruled. It showed two defects, and the maintainer ruled on
both. A builder's read of the first draft against the code then found gaps; two went to the maintainer and the rest
are settled below as stated calls. This document is the design for approval; nothing is built yet beyond the red
tests.

## What was found (2026-11-19)

`packages/tests/shared/alm/outbound-repair-lost-frame.test.ts`, six failing cases on the memory and IndexedDB stores.

- **A. A lost repair frame is never sent again.** Every report of the same gap gets the same attempt identity
  (`toALOutboundRepairGapAttemptIdentity`: requester, track, sequence; D573). A later gap NACK is admitted and its
  repair commits, but it finds the first attempt's send row and writes no frame. The repair budget (`maxRepairs: 1`
  for every at-least-once send) would stop a second attempt as well. The attempt has no timer. The receiver reports a
  gap only when a later frame arrives, never on a timer.
- **B. A receipted room send over `ws` that the server never saw has no timer anywhere.** A WS client's room send
  with a receipt expects no peers at dispatch, so it writes no receipt row and no `ack-timeout` work: "the server's
  receipts own its schedule". The server holds receipts only for what it admitted.
- In the red lane run (D673) both applied: nineteen repeated reports of send 1 wrote nothing (A), and after the last
  report the sender held no work at all (B).
- Still a reading: that the run's sixth dropped frame was send 1's first repair. The fault records a count, not
  which frames it dropped.

## Goals

- **B.** A WS client that sends a receipted message, to a room or to one session, resends it on its own hop until the server answers for it,
  within the send's own receipt timeout and retries. A send the server never answers ends `failed`,
  `receipt-exhausted`, as it does over `rtc`.
- **A.** A receiver that still has a gap asks again, on a timer, and the sender answers a renewed request with a new
  frame. Reports that one burst of arrivals produces still collapse into one attempt (what D573 protects).
- The lane cell `seeded-loss-stream` returns, green on `ws` and on `rtc`, three runs each.
- A second lane cell runs a loss over `ws` with `ack: 'none'`, so A is proven end to end and not only by B.

## Non-goals

- A send with `ack: 'none'` whose only or last frame is lost. Nothing reports it: there is no receipt and no later
  frame to reveal a gap. It is recorded as a stated limit of `ack: 'none'` and pinned by a test.
- Renewal through an `rtc` relay. A relay forwards a child's gap NACK only when it holds a pending row that waits on
  that child, and it never forwards a repair request. Part A holds on direct links: a WS client and its server in
  both directions, and `rtc` peers that send to each other directly. Relayed paths stay as today and are recorded
  with the relay statement rules.
- What a receiver does with a gap that is never filled. It stays as today.
- A receipted `ws` send whose retry policy is `none`. It gets no first-hop resend and no first-hop failure; it waits
  for the server as today.
- The held-send path (D640), the lost stream start over `rtc`, the relay statement rules: their own slices.
- Any change to a receipt once the server has answered: the server's receipts own the schedule from there, as today.
- Gap repair for unicast sends, whose repair policy is `none`: part A does not apply to them. Part B does.

## Anti-goals

- Two owners retrying the same send. The sender's first-hop wait ends at the server's first receipt for the message;
  it never runs beside the server's receipt schedule, and it never becomes the receipt's deadline or attempts.
- A resend per arriving frame. A burst of N later frames must not resend a sequence N times.
- A renewal for a sequence that has only just gone missing. A frame that is merely late must not draw one.
- A timeout, budget, page size or loss rate changed to make a cell green.
- A second wire shape kept beside the first, or any compatibility path for the old one.

## Constraints

- Maintainer, standing: no legacy, no migration code, no duplicated code, no business one-off where a shared library
  in `packages/shared/**` fits; the repository's code standard; authoritative writes follow
  `convergent-service-writing.md`.
- D573's pin `al-outbound-repair-exhaustion.test.ts`: its case "charges one attempt per gap … write no new row" keeps
  every assertion. Two things in that file change and are named here so they are not a surprise: its hand-built
  request payloads gain the new required field, and the statement that _another requester_ finds the budget spent is
  restated to the per-requester budget the maintainer ruled.
- The reproduction of part one stays byte for byte and green (`outbound-work-readiness-starvation.test.ts`).
- The ALM lane cells that exist today pass unchanged, with one exception by ruling (`repair-exhausted`, below). The jitter cell is among those that must not change: it delays frames by up to 80 ms and
  must not draw a renewal.
- The suite for receipts under a transport hold (`acknowledgement-under-transport-hold-indexeddb.test.ts`) passes
  unedited. It does not exercise a room send's first-hop wait (its `ws` sender is a `hop` unicast), so part B brings
  its own test for a held frame.

## Approaches (ruled by the maintainer, 2026-11-19)

**Scope.** Both defects in this slice, B first. Rejected: B only; A only.

**B: who holds the first-hop timer.**

1. _The sender, until the server answers_ (chosen: "Sender, until admitted"). One more stored row and one timer
   commit per receipted `ws` send; the rule that the server's receipts own the schedule keeps holding from the
   server's first receipt on.
2. The sender, for the whole receipt. Reverses that rule and needs a guard against both sides retrying.
3. The server re-reports gaps on a timer. Cannot cover a lost last frame or a lost single send.

**B: a lost `admitted` receipt.** The server writes `admitted` once and answers a duplicate with nothing, so a lost
`admitted` would end the send `failed` although the server delivered it.

1. _The server answers a duplicate with `admitted` again_ (chosen).
2. Accept and record it.
3. Rethink part B.

**A: what resends a lost repair frame.**

1. _The requester asks again while the gap stands_ (chosen). Only the receiver knows the gap still stands, and it can
   ask after the stream has ended.
2. The sender treats a late report as a new attempt. No wire change, but nothing arrives to trigger it when the
   stream has ended.
3. No change; a stated limit for `ack: 'none'`.

**A: how the repair budget counts.** Today it is per message and shared by every requester.

1. _Per requester_ (chosen). Each requester gets its first attempt and its renewals for a sequence.
2. Per message, as today. Renewals can be exhausted by other requesters' first reports.
3. Per renewal round.

## Design

### Part B: the sender owns the first hop until the server answers

Today a WS client's receipted room send is written to the socket and forgotten until the server's `admitted` receipt
creates the sender's receipt row. The change: at dispatch, the sender records that it is waiting for the server to
answer for this message, with a timer.

- **Which sends.** Any send, to a room or to one session, from a composition that has an own hop (`hopPeerIds`, the
  WS client's server), with a receipt mode other than `none` and a retry policy that allows at least one retry. One
  rule by hop, not by the send's shape. A `hop` send already has its own timer and is left alone. Over `rtc` nothing
  changes: the sender already tracks its peers.
- **The timer.** The send's own receipt policy: its timeout (2 s by default) and its retries (3 by default). No new
  setting.
- **When it fires.** The sender writes the same message again on its own hop, with a new identity per attempt so a
  frame is written, and waits again.
- **What ends the wait.** Any receipt from the server for the message: `admitted`, `complete` or `timed-out`. Each
  proves the server has it, and a terminal receipt can arrive before `admitted`. The wait and its timer work are
  removed in the commit that admits that receipt. A terminal refusal from the server (for example `unauthorized`)
  ends the wait too, so a refused send does not keep resending. A timer already claimed by a running batch finds
  the wait ended and does nothing.
- **A receipt that arrives after a first-hop deadline** is admitted like any other. The first-hop wait's deadline and
  attempts never become the receipt's: today a receipt row keeps its current deadline and attempts and refuses an
  `admitted` that arrives after that deadline, so the wait cannot simply be the receipt row with the server as its
  expected peer unless that admission resets it. The builder chooses the row; these are the requirements.
- **When the retries are spent.** The handle ends `failed`, `receipt-exhausted`.
- **A duplicate at the server.** The server admits a message once by its id. Today a second copy gets no `admitted`.
  The change: the server answers a duplicate of a message it has admitted with the `admitted` receipt again, to that
  sender only. Where the server instance no longer holds the receipt (another cluster instance, a restart), nothing
  is answered and the send can still end `failed` although delivered. That is recorded as a limit and pinned by a
  test.
- **Under a transport hold.** A frame that could not be written charges no attempt: a client that is offline does
  not spend a send's retries. The first draft said "as for the `rtc` receipt timer"; that timer has no such rule
  (it charges at every deadline), so the first hop gets this rule on its own and the receipt timer is left to the
  held-send slice (D640). Part B's own test states it.

### Part A: the requester asks again

Changes in the shared inbound and outbound code. They hold on direct links: a WS client and its server in both
directions, and `rtc` peers that send to each other directly.

1. **A request carries a number, per missing sequence.** A gap NACK, and the repair request sent with it, carry for
   the sequences they name which request this is: 1 for every report an arrival causes, and one more each time the
   receiver's timer renews it. Both controls carry the same number, because over a direct `ws` link both reach the
   sender and fold into one repair. The field is required on a gap request; other NACK reasons do not carry it. The
   control's version and its proof tag change as the repository changes a control contract; no reader accepts the old
   shape.
2. **The number is part of the request's identity wherever a request is deduplicated.** A renewal after the stream has
   ended has no new arriving frame to name, so it names the same message as the last report. Four places would
   otherwise drop it as already seen: the receiver's own work id for the NACK and the repair request; the sender's
   control admission history; the sender's repair-hint id; and the attempt identity. The number enters all four.
3. **The receiver renews a sequence that has stayed missing.** When a track gets a gap, the receiver arms a timer
   for the newly missing range.
   When it runs, it renews only the sequences that have been missing for the whole interval since their last
   request, names only those, and gives each its own next number. A sequence that went missing since the last run
   already had its arrival report and waits its own interval. When no sequence is left to renew, the timer ends. A
   later gap on the same track arms it again. The timer lives in the inbound lane's work: it needs a row that is due
   in the future, which inbound work does not have today, and a key that a later gap on the same track can arm
   again. On a durable lane it survives a reload; on a volatile lane it does not.
4. **The sender treats a new number as a new attempt.** The attempt identity becomes requester, track, sequence and
   request number. Requests with the same number find the same attempt and write nothing more, exactly as D573 pins.
   A higher number is a new attempt: it is charged against the budget and writes a frame.
5. **The budget counts per requester.** Each requester may spend `maxRepairs` attempts on a sequence. A request past
   it ends `repair-exhausted` for that requester. The frames one message can cost are bounded by its requesters
   times the budget, and a resend still goes to the requester alone.

Values, proposed (my call; change them if you see it differently):

- A sequence is renewed after it has been missing 1 s, then 2 s more, then 4 s more: three renewals, the last 7 s
  after it went missing. Each interval is stretched by a random factor between 1 and 1.5, drawn per receiver, so
  receivers behind the same gap do not all ask at once.
- `maxRepairs` for an at-least-once multicast send goes from 1 to 4, in both places it is set (the request and the
  default policy): the first attempt and three renewals, per requester.
- 1 s is twelve times the jitter cell's largest delay, so a late frame closes its gap long before a renewal.

### Part C: a terminal settlement is final

Added on 2026-11-19 after the restated `repair-exhausted` cell showed it, and a unit reproduction on this branch and
on `main` established it: a sender keeps working for a message after it has told the handle the message is over.

- After `repair-exhausted`, the message's receipt timer retries on (three frames, two seconds apart). The repair
  budget does not govern those retries.
- When the receipt then gives up, its end deletes the repair budget's count. A gap request that arrives later is
  charged from zero and served, and its dispatch opens a new receipt with a new timer. The handle is told
  `receipt-exhausted` a second time.
- All of this predates the slice. Renewals make it routine: a receiver's last renewal lands at the receipt's end.
  With a budget of one it happens every time; at the default budget it sits on the boundary (11 frames for one
  receiver and one lost sequence where 8 are expected).

The maintainer ruled "Full fix here": a terminal settlement ends all work for the message.

**The rule.** When a sender states a terminal settlement for a message, that commit also ends everything the sender
holds for the message, and from then on the sender writes no frame and starts no timer for it.

- **What is terminal.** A settlement that ends the sender's obligation: the receipt completed (acknowledged), the
  receipt ended without completing (`receipt-exhausted`, a `timed-out` receipt), the first hop gave up, the repair
  budget of a requester ran out (`repair-exhausted`), a refusal settled for good, the message's deadline passed. A
  send with `ack: 'none'` that has merely been written is not settled: its obligation to repair runs to its deadline,
  which part A depends on.
- **A durable marker.** The commit that states the terminal settlement marks the message's stored row as ended. Every
  later path already reads that row, so the marker adds no read and no second row; it lives as long as the row (past
  the deadline, after which every path answers `expired` anyway). It replaces the in-memory "stated once" guard,
  which a reload loses. The settlement is stated once per message, across reloads. The deadline itself writes no
  marker: time is the marker.
- **What that commit ends.** The open receipt and its timer, the first-hop wait and its timer, the repair budget's
  count. A receipt row that is complete (acknowledged, or a server's final snapshot) is kept: a gap request is
  admitted by reading the receipt row of the message whose arrival revealed the gap, so deleting acknowledged rows
  would refuse the renewals part A needs. `repair-exhausted` therefore ends the open receipt at once: the other
  receivers lose its remaining retries. The maintainer was told and chose this.
- **What is refused afterwards.** A gap request names the message whose arrival revealed the gap, not the missing
  one, so the request itself is admitted as today; the repair of an ended sequence writes no frame, charges nothing,
  opens no receipt and states nothing. A receipt retry, a first-hop resend, a queued repair hint or a queued send for
  an ended message ends the same way. A receipt that arrives late, and a terminal or `not-yet-in-sync` NACK for an
  ended message, is rejected: no row is rebuilt and no second terminal fact is stated.
- **What does not change.** What a receiver does with a gap that is never filled (a non-goal above); the receiver
  goes on renewing until its own schedule ends, and nothing answers it.
- **What it costs.** Every commit that ends a message rewrites its stored row once: one more row write per
  acknowledged receipted send, in the browser stores and on PostgreSQL, inside the commit that completes the receipt.
  If a gate measures that as a regression it goes to the maintainer with the number; the alternative is to let the
  kept complete receipt row stand as the marker for the acknowledged case (no write, two places to read).

Of the two residuals recorded while building part B, the first closes with this rule: a late server receipt after
the first hop gave up no longer rebuilds a receipt row. The second closes only in part: no frame follows a terminal
settlement, but an `admitted` receipt (which is not terminal) that lands between a first-hop resend's two commits
still lets that one frame out. Closing it means making the resend conditional on its wait, a separate change.

Outside this part, left as they are and recorded in the backlog: cancel and hand-over end later work from memory
only, so a reload forgets them; over `rtc` a gap request whose revealing message ended unacknowledged is refused at
admission.

### Part D: a receipt waits for its frame

Added on 2026-11-20. The lane's two-agent family over `rtc`, green before part C, went red in two existing cells
(`delivery-reload`, `checkpoint-recovery`), three runs of three each alone. A unit reproduction established the
cause, the same in every run:

- Both cells hold the carrier, send one receipted message on a lane that survives a reload, reload the sender about
  17 s later and expect the receiver to get the message.
- The receipt's clock runs from the commit, not from a submission. Its budget (2 s, three retries) runs out at 8 s
  while the first transmission has never left, and each retry stacks another held copy.
- Before part C the handle read `receipt-exhausted` and the message was then delivered, four times. With part C the
  end marks the message, every held copy meets the marker and completes without a frame, and the message is never
  sent.

Part C did what it says ("a queued send for an ended message ends the same way"); what it did not consider is that
the queued send can be the first transmission. The maintainer ruled "Receipt waits for first send": while no copy
of the message has been handed to the carrier, the receipt charges no attempt and queues no retry copy.

**The rule.** At a receipt deadline, while the receipt has charged nothing and no copy of its first transmission has
been handed to the carrier, the deadline is not charged and no retry copy is queued: the receipt waits one more
timeout for the copies that are already queued. It is the rule part B built for the first-hop wait ("a frame that
could not be written charges no attempt"), decided by one shared function and read the same way, from the attempt's
own send rows.

- **Only the first transmission.** A retry whose copy is held is charged as today. A frozen suite depends on it
  (`acknowledgement-under-transport-hold-indexeddb.test.ts`: a `ws` submission that left, then every retry held,
  must end `failed` after 3 of 3), and a retry is not one attempt the row could name: its copies are planned at each
  deadline for whoever is still unconfirmed. This is the ruling's own wording.
- **Held means every copy.** A first transmission with several copies waits only while none of them has been handed
  over. If one next hop took its copy and another is held, the deadline is charged as today, and part C still drops
  the held copies when the receipt runs out.
- **Read against the plan at the deadline.** The rule looks at the copies the message is planned with when the
  deadline fires. If the plan changed while the frame was held (a route lost, an overlay change), the receipt is
  charged as today.
- **What the wait ends on.** A copy is handed to the carrier (the next deadline is then the first charge, so the
  budget ends up to one timeout later than "after it left"); the message's deadline passes (`expired`, as today:
  every message has one, which bounds the wait); another terminal settlement ends the message.
- **What it changes for a caller.** A send whose carrier submits nothing no longer fails after the receipt budget
  (about 8 s at the defaults): its handle stays pending until the frame leaves or the message's deadline passes. The
  receipt no longer stacks copies of a held first transmission; gap repairs and held retries still can.
- **What does not change.** The budget once a frame has left; what a server-owned receipt does; part C: a terminal
  settlement still ends every queued copy, the first one included, when it is stated for another reason.
- **What it costs.** The receipt row names its first attempt (one optional field, present while the receipt waits on
  it); one work-row read per receipt deadline while the receipt has charged nothing; one timer commit per timeout
  while held, until the message's deadline.

This is one piece of the held-send path (D640) pulled forward. The rest of that slice stays where it is: what a
relay's refusal of a held send means, and the handle's states while held.

After part D the two red cells run again alone (three runs each over `rtc`), then every cell of this slice and the
three lane families, under the same stop rule.

### The reproduction's cases, restated

The six red cases were written before the rulings. Under the ruled design:

- The two cases of B stay as written and turn green with part B.
- The two `ack: 'receiver'` cases of A stay as written and turn green with part B (work is pending: the first-hop
  wait).
- The two `ack: 'none'` cases of A ask that a repeated report _caused by an arrival_ rewrites the frame or leaves
  work. The ruling keeps such a report collapsed. They are replaced by three statements, each red first: a sender
  given a request with the next number writes the sequence again; a receiver with a sequence that stays missing
  sends the request again when its timer runs, and stops when the gap closes; a sender and a receiver wired through
  a link that drops the first repair frame deliver the whole stream.

### The cells

- `seeded-loss-stream` returns as it was (25 % loss, seed 7, every send `ack: 'receiver'`), from the kept patch.
- A new cell over `ws` with `ack: 'none'`: the same loss is held while sends 1 to 19 are admitted and released
  before send 20, so a later frame always reveals a gap and the cell does not depend on whether the seed spares the
  last frame. All twenty arrive in order. The lost last frame is the stated limit, pinned at unit level.
- Both are withheld from the hosted manifests, as the other fault cells are.
- The existing cell `repair-exhausted` is restated by ruling. It proved exhaustion through a second requester
  finding a shared budget spent, which the per-requester budget removes. The harness's send command gains
  `maxRepairs`; the cell states a budget of one, and its requester's own first renewal is answered
  `repair-exhausted`. `rallar-black-box-test-contracts.ts` is at its line backstop, so the field comes with a split of
  that file by owned feature.
- If either cell is not green on its carriers, three runs each, the work stops with a report of what remains.
- After part C every cell of this slice runs again (the two loss cells and `repair-exhausted`, three runs per carrier)
  and the lane families once each, under the same stop rule.

## Validation

- Unit: the restated reproduction; the first-hop wait (ended by each receipt phase, a late receipt admitted, a held
  frame charging nothing, retries spent, retry `none` unchanged); the server's repeated `admitted`; the receiver's
  timer (renews only what stayed missing, stops when closed, arms again); the sender's identity and the
  per-requester budget; D573's pin as constrained above.
- A PostgreSQL integration test for the server's inbound timer row (written, due later, claimed, ended).
- Lane, full scope: each cell alone three times per carrier, then the two-agent family once per carrier.
- The api-v1 black-box profiles (standard and cluster) and the medium-scale gate: the server's inbound lane, its
  receipts and a control contract change.
- The unit, tooling and governance lanes; style, coupling, reachability, bundles; the tests typecheck.

## Left to the builder

- The name and place of the request number, and how the control's version and proof tag are changed, following the
  repository's last control contract change.
- The row that holds the first-hop wait, within the requirements above.
- The inbound timer's row: how inbound work gets a future due time, its key, and what it stores about each missing
  sequence (when it went missing, its number).
- Where the renewal intervals and the random stretch live (ALM's resource limits or the repair policy), and how a
  test fixes the draw.
- How the budget's count is keyed per requester in the repair-attempt row.

## Calls made in this document

- The first-hop wait uses the send's receipt timeout and retries; no new setting. A send with retry `none` is left
  as today.
- Any receipt phase from the server ends the first-hop wait, not `admitted` alone.
- A lost only or last frame under `ack: 'none'` is a stated limit, not fixed.
- Renewal holds on direct links; relayed `rtc` paths are left as today.
- The request number is per missing sequence, and a sequence is renewed only after it stayed missing a whole
  interval.
- The renewal intervals, their random stretch, and the budget of 4.
- A second lane cell for `ack: 'none'`, which releases its loss before the last send.
- D573's pin file changes in the two named ways, and in a third found while planning: its helper that reads the
  attempt row's count follows the row's per-requester shape. No assertion changes.
- One timer row per newly missing range, in place of one per track; the behaviour is the per-sequence rule above.
- One pull request (#847) for both parts, B's commits first.
- Part C: what counts as terminal (a written `ack: 'none'` send does not); the marker's lifetime (the message's
  deadline); a late receipt after a terminal settlement is absorbed; a queued timer or hint ends without writing.

## Decisions (maintainer, 2026-11-19)

| Question                                  | Ruling                                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| What follows the queue-order fix          | The lost repair frame, ahead of the alternating-runs baseline. |
| Which defects this slice fixes            | Both, B first.                                                 |
| B: who holds the first-hop timer          | The sender, until the server's `admitted` receipt.             |
| B: a lost `admitted` receipt              | The server answers a duplicate with `admitted` again.          |
| A: what resends a lost repair frame       | The requester asks again while the gap stands.                 |
| A: how the repair budget counts           | Per requester.                                                 |
| B: which sends wait                       | Every receipted `ws` send, room or unicast.                    |
| The `repair-exhausted` cell               | Restated with a budget of one.                                 |
| Work after a terminal settlement          | "Full fix here": a terminal settlement ends all work.          |
| A send still held at its receipt deadline | "Receipt waits for first send" (2026-11-20).                   |
