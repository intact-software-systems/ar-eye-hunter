# Receipt truth, part C: the relay statement rules

Design for one pull request on `claude/alm-relay-statement-rules`, from `main` at `d70f2f165`. Decision rows
D703–D709, then D725–D734. The maintainer ruled every choice below on 2026-11-21, each asked alone; the evidence is
in the two research reports of the git-ignored workspace `.superpowers/sdd/relay-statement-rules/`.

## Intent

A sender's receipt says who received a message. Part C removes the places where that statement is wrong, or where it
can be bent by a member, a relay or a lost frame:

- a relay refuses a recipient's true ACK;
- a recipient that has not delivered is counted;
- a next hop speaks for another hop;
- a receiver behind a relay, or on an `ack: 'none'` track, stalls on a lost frame.

It also removes a quadratic encode a hostile child can provoke, and it labels honest repeats as `duplicate`.

The maintainer's standing rules apply:

- subagent-driven development and TDD;
- no legacy kept, no migration code, no duplication, a functional style, unused code deleted;
- shared libraries over business one-offs.

Every rule below is a pure function under `packages/shared/**`.

**Goals.**

- Each item has a failing test first.
- Each `Limit:` pin and characterization this design names is flipped to the rule.
- The lane gains `relayed-gap-renewal` over `rtc`, and part C's backlog lines are removed.

**Non-goals.** These are ruled out, not deferred:

- Bounding the WS dequeue re-check's read and dropping its send-time probe (item 6). Its own session does that in
  parallel (D720–D724).
- Any wire or stored-shape change.
- A public API change.

**Anti-goals.**

- A rule that knows its carrier: each rule here is stated once for `ws` and `rtc`.
- A receipt that reads `acknowledged` for a message its recipient holds undelivered.

## The rulings and the design

### 1. D601's permissive fallback ("Forward every control")

`hasALOutsideStatement` (`packages/shared/alm/inbound/control/is-al-same-receipt-statement.ts:45-59`) answers `false`
when the history no longer holds a control that recorded the recipient outside. With no recorder left, the relay
forwards the ACK, the outside NACK, the gap NACK and the implied hop-end, and the origin judges: it already refuses a
confirmation for a recipient it holds outside (`validate-al-outbound-control-admission.ts:125-133`), and a NACK naming
no recipient it still owes.

- **Tests first:**
  - a relay whose outside recorder was evicted by 256 later controls forwards the recipient's true signed ACK, and the
    origin counts it;
  - a recipient the origin does hold outside is still refused there.
- **Pins restated:**
  - `is-al-same-receipt-statement.test.ts:103`;
  - `compute-al-inbound-nack-admission.test.ts:146` (a forward, which the origin refuses).

### 2. One encode per scan ("Encode once per scan")

The statement relation is not transitive, so the encoding is memoized, not re-keyed.

- A prepared subject carries a control's payload and its signed content, encoded lazily at most once.
- Every scan prepares its control once and each prior once. The scans are:
  - `isSameAckIdentity`;
  - `hasALOutsideStatement` and `hasALConfirmedStatement`;
  - `acceptALPendingAckPayload`;
  - `isALOwedByStatement`;
  - `toFirstOfEachStatement`.
- The grouping in `toFirstOfEachStatement` buckets by `logicalRecipientPeerId` before it compares. Every clause needs
  the same recipient, so the result is unchanged and the quadratic becomes per-recipient pairs.
- The grouping moves beside the predicate it groups by.
- The own-word test (`fromPeerId === logicalRecipientPeerId`) is spelled at seven sites. It becomes the one named
  predicate of item 4.
- **Tests first:**
  - a counted-encode assertion: a grouping of n controls under one proof encodes each control once;
  - the existing behaviour pins stay green unchanged.

### 3. The `duplicate` label ("Origin only")

The origin's `control-admission` diagnostic reads outcome `duplicate` when every issue of a refusal is a duplicate
class: "already admitted" (`isDuplicateControl`) or "already counted".

- A mixed refusal, a duplicate with a proof refusal, stays `rejected`, so `toControlProofRefusalWait` and the cells
  `forged-recipient-ack` and `unsigned-ack-refused` hold.
- "Names no recipient the receipt still owes" stays a refusal, because the origin cannot tell a repeat from a
  contradiction there.
- Item 4's new refusal is not a duplicate.
- `ALMessageRejection.code` is not widened: validators return an issue class beside the message.
- `runtime-diagnostic-contract.md` changes with the code.

### 4. One own-word rule ("One own-word rule, NACK and gap")

One shared predicate, "own word under a non-logical receipt", lives in `packages/shared/alm/delivery/`, beside
`is-al-implied-not-subscribed-nack.ts`. `alm/outbound/control/` is at its density limit, so it cannot live there. The
predicate is used by:

- the hop-end rule (`is-al-outbound-implied-not-subscribed-ack.ts:16`);
- the outside-audience NACK (`validate-al-outbound-outside-audience-nack.ts`);
- the relayed gap NACK (`is-al-outbound-relayed-gap-nack.ts`).

Under `hop`/`subtree`, a next hop's unsigned NACK naming another hop moves nobody outside. The `Limit:` pin
`rtc-receipt-forgery.test.ts:297` becomes the refusal, and a case shows that `c`'s own NACK under `hop` still moves
`c` outside. Relayed gap recovery under `hop`/`subtree` stays closed: D582 keeps those modes on channel trust, and a
D-row states it.

### 5. A count from a member never sent the frame ("Narrow guard for D701"; the remainder "Close it as inherent")

- **The guard.** A replay that expects the audience captured at ingress because its own audience is empty
  (`resolveReplayedRecipientPeerIds`) marks those recipients as never sent in the aggregate. Their ACK is refused
  with a new `AckGuard`, `never-sent`.
- **What stays.** The `admitted` and `timed-out` receipts and the handle's `expired` stay as D701 ruled.
- **Where.** In `ws-queue-box-server-receipt-aggregation.ts`; the directory takes no new file.
- **Test.** The characterization `ws-kept-send-receipt.test.ts:230` becomes the rule: the ACK is refused, and the
  handle reads `expired`, not `acknowledged`.
- **The remainder.** A member that ACKs before delivery, on WS or RTC, speaks only for itself and could ACK and drop
  anyway. A D-row records this as inherent, and the backlog line is removed.

### 6. Gap renewal across relays ("Truthful answer + kept row"; "One rule, both carriers"; the `ack: 'none'` and reshape fixes)

The cause is a receipt-truth defect, not a missing forward. The origin's retry of the message that revealed a gap
reaches a leaf that holds it buffered. The leaf answers `delivered` (`compute-al-inbound-duplicate-changes.ts:67-68`,
`:273-285`, through `isALInboundDeliveringPlan` counting a deferred plan). From then on:

- the relay refuses every renewal as an already-confirmed statement;
- the origin no longer owes that recipient;
- the sender reads `acknowledged` for a message never delivered.

**6a. A buffered message draws no answer.** Any copy of a message the leaf holds buffered (its sequence is in
`orderingSnapshot.bufferedSeqs`), on any carrier, draws no ACK. The leaf's `delivered` goes out on release, as for the
first copy.

- Pin C1 (`compute-al-inbound-duplicate-changes.test.ts:351-364`) is restated: a WS copy while the RTC copy is
  buffered draws nothing; the "after release" case still answers `delivered`.
- New pin: a same-carrier retried copy of a buffered message draws nothing.

**6b. An `rtc` terminal end keeps the receipt row.** The end keeps the open receipt row as a final snapshot, and
still deletes the repair-attempt row and the first-hop wait (`message-end/to-al-outbound-message-end-bundle.ts:30-44`).

- A gap request naming a revealing message whose receipt ended is then still admitted, directly and relayed. It
  serves only sequences that have not ended (D686, which already defines a kept incomplete row).
- Without 6b, 6a alone would refuse renewal 4 on direct links whenever the stretch is above about 1.14.
- `al-outbound-message-end.test.ts`'s row-deleted expectations become row-kept.

**6c. `ack: 'none'` over `rtc` is repaired.** Today the origin refuses every gap request for a retained
`ack: 'none'` send, "no retained outbound obligation", even on a direct link. After 6c:

- `isALOutboundExpectedRepairPeer` admits a requester that is a recipient of the message's frozen audience
  (`resolveALFrozenMulticastAudience`), or, with none frozen, a ready room neighbour;
- the per-recipient repair budget (D681, D692) applies as for receipted sends;
- a relay forwards a child's gap NACK for such a send without a receipt row, under the same statement rules: it
  forwards each numbered request once and refuses a child outside the frozen audience;
- the pin `rtc-relay-gap-repair.test.ts:206` (the `ack: 'none'` limit) becomes the rule.

**6d. A renewal goes to the current upstream peer.** Each renewal resolves its target when it fires: the leaf's
current upstream peer for that track (its parent, or the origin when it is linked directly), not the peer fixed when
the gap was first seen (`compute-al-inbound-gap-renewal.ts:94`).

- Test first: after a reshape, a renewal reaches the new parent and is served.

**6e. Words and observability.**

- The backlog and README phrase "never forwards a repair request" becomes "the gap NACK carries the repair; a repair
  request needs no forward". The origin builds one hint from the gap NACK alone.
- The `control-admission` diagnostic gains:
  - the gap request number (`nackGapRequestNumber`);
  - the NACK's sender (`nackFromPeerId`);
  - the NACK's logical recipient (`nackLogicalRecipientPeerId`).

  This closes D683's "not observable: the request number". It changes the runtime diagnostic contract, not a public
  API.

**Red-first reproduction**, in `packages/tests/shared/multicast/rtc-relay-gap-repair.test.ts` (`GapChain`), with
origin `a`, relay `r` and leaf `c`:

1. Seq 2 is lost below the relay.
2. Request 1 crosses.
3. At 2 s the origin's retry of seq 3 reaches `c`.
4. Request 3 must reach the origin and be committed. Today the relay forwards nothing numbered 3.

## Lane proof

A new cell, `relayed-gap-renewal`, in `scenarios/relay-path/`:

- **Shape.** Over `rtc` alone, in the three-agent family, path topology. Two origins each send an ordered
  `ack: 'receiver'` track of three.
- **Holds.** Each origin holds its own seq 2 until its diagnostics show a committed gap NACK numbered 3 from each
  receiver.
- **Assertions.** Every receiver gets 1, 2 and 3 in order. An assessment fails the cell unless at least one admitted
  request 3 came through a relay.
- **Red and green.** Red on `main`, green after 6.

Runs:

- the cell alone, three times on `rtc`, with no retries;
- then the four ALM families over `ws` and `rtc`;
- reruns of `seeded-loss-stream` and `repair-exhausted`, since 6a changes when a revealing receipt completes.

An `ack: 'none'` lane statement follows 6c's unit proof, if a cell can hold a frame of an unreceipted `rtc` track.
The plan decides it from the cell harness.

## Validation

- unit main and tooling;
- typechecks;
- changed style, coupling, reachability, dprint on touched files;
- browser bundle budgets;
- api-v1 `bun test` (item 5 changes WS server behaviour);
- the api-v1 black-box standard and cluster profiles;
- the lane cells above;
- `npm run test:repo-governance`, if the skill or README files change.

The browser budgets have 0.7 KiB (`rallar.ts`) and 0.23 KiB (headless) left. A crossing is raised to the next whole
KiB on the measured figure, recorded and reported.

## Risks

- **6a changes what applications read under persistent loss.** A revealing message's handle ends
  `receipt-exhausted`, not `acknowledged`. That is the truthful reading. Retries also wait for release instead of
  being confirmed early.
- **6b keeps ended receipt rows to their TTL.** The store is larger while they live.
- **6c widens who may request a repair of an `ack: 'none'` send.** The per-recipient budget bounds it.
- **Size.** The PR touches the relay's inbound rules, the origin's control admission, the gap renewal and the WS
  aggregation. The plan orders the tasks so that each lands green.
- **Density.** No new file goes into `ws-queue-box-server/`, `alm/inbound/`, `alm/outbound/`,
  `alm/outbound/control/` or `al-contracts/`. New code goes into existing files or folders with room (`alm/delivery`,
  `alm/inbound/control`, `alm/inbound/admission`, `al-contracts/receipt-proof`).

## Left to the builder

- The names of the prepared subject and the issue class.
- The task order.
- The exact form of the `never-sent` guard's field.
- Whether 6c's relay forward reuses the pending-row path or a row-less branch, provided the statement rules are not
  duplicated.
