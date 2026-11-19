# ALM recovery under loss, part two: the first hop and the repeated gap

The slice the maintainer ordered after the queue-order fix (D673): an ordered stream over `ws` must recover when a
repair frame is lost. A unit reproduction came first, as ruled. It showed two defects, and the maintainer ruled on
both. This document is the design for approval; nothing is built yet beyond the red tests.

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

- **B.** A WS client that sends a receipted room message resends it on its own hop until the server's `admitted`
  receipt arrives, within the send's own receipt timeout and retries. A send the server never admits ends
  `failed`, `receipt-exhausted`, as it does over `rtc`.
- **A.** A receiver that still has a gap asks again, on a timer, and the sender answers a renewed request with a new
  frame. Reports that one burst of arrivals produces still collapse into one attempt (what D573 protects).
- The lane cell `seeded-loss-stream` returns, green on `ws` and on `rtc`, three runs each.
- A second lane cell runs the same loss over `ws` with `ack: 'none'`, so A is proven end to end and not only by B.

## Non-goals

- A send with `ack: 'none'` whose only or last frame is lost. Nothing reports it: there is no receipt and no later
  frame to reveal a gap. It is recorded as a stated limit of `ack: 'none'` and pinned by a test.
- What a receiver does with a gap that is never filled. It stays as today.
- The held-send path (D640), the lost stream start over `rtc`, the relay statement rules: their own slices.
- Any change to a receipt after `admitted`: the server's receipts own the schedule from there, as today.
- Unicast sends, whose repair policy is `none`.

## Anti-goals

- Two owners retrying the same send. The sender's first-hop timer ends at `admitted`; it never runs beside the
  server's receipt schedule.
- A resend per arriving frame. A burst of N later frames must not resend a sequence N times.
- A timeout, budget, page size or loss rate changed to make a cell green.
- A second wire shape kept beside the first, or any compatibility path for the old one.

## Constraints

- Maintainer, standing: no legacy, no migration code, no duplicated code, no business one-off where a shared library
  in `packages/shared/**` fits; the repository's code standard; authoritative writes follow
  `convergent-service-writing.md`.
- D573's pin stays green unedited: `al-outbound-repair-exhaustion.test.ts`, "charges one attempt per gap … write no
  new row".
- The suites for receipts under a transport hold pass unedited
  (`acknowledgement-under-transport-hold*.test.ts`).
- The reproduction of part one stays byte for byte and green
  (`outbound-work-readiness-starvation.test.ts`).
- The ALM lane cells that exist today pass unchanged, the jitter cell among them: it delays frames by up to 80 ms and
  must not draw a renewed request.

## Approaches (ruled by the maintainer, 2026-11-19)

**Scope.** Both defects in this slice, B first. Rejected: B only; A only.

**B: who holds the first-hop timer.**

1. _The sender, until `admitted`_ (chosen). One more stored row and one timer commit per receipted `ws` send; the
   rule that the server's receipts own the schedule keeps holding from `admitted` on.
2. The sender, for the whole receipt. Reverses that rule and needs a guard against both sides retrying.
3. The server re-reports gaps on a timer. Cannot cover a lost last frame or a lost single send.

**A: what resends a lost repair frame.**

1. _The requester asks again while the gap stands_ (chosen). Only the receiver knows the gap still stands, and it can
   ask after the stream has ended. Needs a field on the request, a timer per track with a gap, a larger repair
   budget and a rule for giving up.
2. The sender treats a late report as a new attempt. No wire change, but nothing arrives to trigger it when the
   stream has ended.
3. No change; a stated limit for `ack: 'none'`.

## Design

### Part B: the sender owns the first hop until `admitted`

Today a WS client's receipted room send is written to the socket and forgotten until the server's `admitted` receipt
creates the sender's receipt row. The change: at dispatch, the sender records that it is waiting for `admitted` from
its own hop (the server), with a timer.

- **Which sends.** A room send from a composition that has an own hop (`hopPeerIds`, the WS client's server), with a
  logical audience and a receipt mode other than `none`. Over `rtc` nothing changes: the sender already tracks its
  peers.
- **The timer.** The send's own receipt policy: its timeout (2 s by default) and its retries (3 by default). No new
  setting.
- **When it fires.** The sender writes the same message again on its own hop, through the path an own-hop
  acknowledgement timeout already takes (`retryPendingAck`, an `ack-timeout` repair hint with a new identity per
  attempt), and waits again.
- **When `admitted` arrives.** The wait ends and its timer work is removed in the same commit that today creates the
  receipt row. From here the server's receipts own the schedule; the sender writes no `ack-timeout` work, as today.
- **When the retries are spent.** The handle ends `failed`, `receipt-exhausted`.
- **A resend that crosses a slow first frame.** The server already admits a message once by its id; the second copy
  is a duplicate. The builder confirms this with a test before relying on it.
- **Under a transport hold.** The timer follows whatever rule the `rtc` receipt timer follows when a frame cannot be
  written; no second rule.

### Part A: the requester asks again

Three changes, in the shared inbound and outbound code, so they hold for the WS server, for `rtc` peers and for a WS
client that orders a server track.

1. **The request carries a number.** A gap NACK (and the repair request sent with it) carries which request this is
   for the gap it names: 1 for every report an arrival causes, and one more each time the receiver's timer renews
   it. The field is required. The control's version changes as the repository changes a control contract; no reader
   accepts the old shape.
2. **The receiver renews a standing gap.** When a track gets a gap, the receiver arms one timer for that track. When
   the timer runs and the track's contiguous head has not passed the missing range, the receiver sends the request
   again with the next number and arms the timer once more. When the gap has closed, or the last renewal has gone
   out, the timer ends. One timer per track with a gap, not per message; it lives in the inbound lane's durable work,
   so it survives a reload and is claimed like other work.
3. **The sender treats a new number as a new attempt.** The attempt identity becomes requester, track, sequence and
   request number. Reports with the same number find the same attempt and write nothing more, exactly as D573 pins.
   A higher number is a new attempt: it is charged against the repair budget and writes a frame.

Values, proposed (my call; change them if you see it differently):

- The receiver renews after 1 s, then 2 s, then 4 s: three renewals, the last 7 s after the gap appeared.
- The repair budget (`maxRepairs`) for an at-least-once multicast send goes from 1 to 4: the first attempt and three
  renewals. A request past the budget ends `repair-exhausted`, as today.
- 1 s is twelve times the jitter cell's largest delay, so a delayed frame closes its gap long before a renewal.

### The reproduction's cases, restated

The six red cases were written before the rulings. Under the ruled design:

- The two cases of B stay as written and turn green with part B.
- The two `ack: 'receiver'` cases of A stay as written and turn green with part B (work is pending: the first-hop
  timer).
- The two `ack: 'none'` cases of A ask that a repeated report _caused by an arrival_ rewrites the frame or leaves
  work. The ruling keeps such a report collapsed. They are replaced by three statements, each red first: a sender
  given a request with the next number writes the sequence again; a receiver with a standing gap sends the request
  again when its timer runs, and stops when the gap closes; a sender and a receiver wired through a link that drops
  the first repair frame deliver the whole stream.

### The cells

- `seeded-loss-stream` returns as it was (25 % loss, seed 7, every send `ack: 'receiver'`), from the kept patch.
- A new cell, the same loss over `ws` with `ack: 'none'`: all twenty arrive in order. It proves the renewal.
- Both are withheld from the hosted manifests, as the other fault cells are.
- If either cell is not green on its carriers, three runs each, the work stops with a report of what remains.

## Validation

- Unit: the restated reproduction, the receiver's timer, the sender's new identity, D573's pin unedited, the
  under-hold suites unedited.
- A PostgreSQL integration test for the server's inbound timer row (written, claimed, ended).
- Lane, full scope: each cell alone three times per carrier, then the two-agent family once per carrier.
- The api-v1 black-box profiles (standard and cluster) and the medium-scale gate: the server's inbound lane and a
  control contract change.
- The unit, tooling and governance lanes; style, coupling, reachability, bundles; the tests typecheck.

## Left to the builder

- The name and place of the request number, and how the control's version is changed, following the repository's
  last control contract change.
- Whether the first-hop wait reuses the pending-acknowledgement row with the own hop as its expected peer, or needs a
  row of its own; the choice must not let the sender's timer outlive `admitted`.
- The inbound work row for the gap timer: its key (one per track) and what it reads to decide the gap still stands.
- Where the renewal intervals live (ALM's resource limits or the repair policy).

## Calls made in this document

- The first-hop timer uses the send's receipt timeout and retries; no new setting.
- A lost only or last frame under `ack: 'none'` is a stated limit, not fixed.
- The renewal intervals and the budget of 4.
- A second lane cell for `ack: 'none'`.
- One pull request (#847) for both parts, B's commits first.

## Decisions (maintainer, 2026-11-19)

| Question                            | Ruling                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| What follows the queue-order fix    | The lost repair frame, ahead of the alternating-runs baseline. |
| Which defects this slice fixes      | Both, B first.                                                 |
| B: who holds the first-hop timer    | The sender, until the server's `admitted` receipt.             |
| A: what resends a lost repair frame | The requester asks again while the gap stands.                 |
