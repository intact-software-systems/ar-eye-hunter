# ALM R1 design proposal: shared-key proof, range repair, the recovery owner

Status: decided 2026-10-03 (D136 to D142), the recommended option taken on each under the
maintainer's instruction to plan and execute the next slices from merged `main`; a reversed decision
re-plans its task. Spec: [the roadmap](alm-improvement-plan.md) release map row "5 R1", the
"Releases 4 to 8" outcome row for R1, D24, D38, D43, D48, D50, D57, D71, D72, D76, D89, D92, D125,
D126, D134; [the product description](alm-complete-product-description.md) "Ordering and gap
recovery", "Deduplication and supersedence", "Repair and resynchronization". Code survey of `main`
at `54adf4d` (I2b merged, #640). The implementation plan is
`plans/active/alm-r1-arbitration-and-range-repair-implementation-plan.md`.

## 1. The problem

Release 4 is delivered. The release map's next row is R1: "cross-backend shared-key arbitration
proved; range and page repair replace individual sequence lists; resynchronization invokes the
topic's declared recovery owner with bounded cursor information", with the exit evidence "an A/B
stale-read then sequential-commit schedule has one winner on memory, IndexedDB and PostgreSQL; a gap
beyond the window yields `resync-required` and the owner is invoked once; exhausted repair
terminates". The survey found eight things the design must settle:

1. **The I2b consumer proof is red for a repair defect.** The Relic reload-mid-command case
   (`tests/playwright/relic-hunters/full-stack-propagation.spec.ts`) restores the held command from
   the checkpoint and its `ack-timeout` fires, but no second frame is ever sent. The retransmitter
   exits at `al-outbound-repair-retransmission.ts:188`: without a `planRepairMessage` a
   room-scoped message is never retried, and since D71 every WS unicast that names its room, the
   server-addressed command included (D57, D76), is room-scoped. D89, D126 and D134 assume the
   client resends and the server deduplicates the repeat. The guard predates S3c-i; it protects a
   room multicast from a widened audience (D24, D43), which a retry of the sender's own hop cannot
   cause. No test covers a room-scoped WS send across an acknowledgement timeout in either
   direction.
2. **Shared-key compare-and-set exists on every backend, but the proof is scattered.** The inbound
   store re-reads its decision surface inside the write (`requireOriginalObservations`,
   `al-inbound-admission-store.ts:627-692`); the outbound store guards the supersedence latest row
   and the sender version (`al-outbound-admission-mutations.ts:143-161`,
   `al-outbound-admission-store.ts:692-729`). `inbound-supersedence-concurrency.test.ts` runs the
   stale-read then sequential-commit schedule over memory, IndexedDB and pglite for the inbound
   store; the outbound supersedence race is proven on memory and IndexedDB only
   (`outbound-supersedence-concurrency.test.ts`), and real two-connection PostgreSQL only in the
   gated integration suite.
3. **The PostgreSQL backend fences written keys only.** `PSqlAdmissionMutationCollector` emits a
   revision guard for every key the write touched and none for a key it only read
   (`p-sql-admission-mutation-collector.ts:127-166`); the store-level re-reads run as autocommit
   reads before `sql.begin`. The inbound README (`:449-456`) claims every read key is compared on
   every backend. Every key the two writers of the exit schedule arbitrate on is one both write
   (the dedup key, the supersedence latest, the ordering track, the sender version, the message
   owner), so the arbitration holds; the claim does not.
4. **Missing sequences are individual lists in six shapes.** `ALOrderingObservation.missingSeqs`,
   the NACK and repair payloads (`al.control.nack.v1`, `al.control.repair.v1`), the buffered slot
   row's persisted plan, the outbound control history, the `repair-hint` work payload, and three
   effect ids that join the list. The codec caps a list at the 256 window
   (`al-control-value-codec.ts:226-227`); a 256-wide gap is a 256-entry list on the wire and in
   three rows.
5. **Retransmission is unbounded per hint.** `retransmitFromRepairHint` loops over every listed
   sequence in one work execution (`al-outbound-repair-retransmission.ts:52-79`), one indexed read
   and one dispatch commit each.
6. **Exhausted repair is a warning.** `repairByMsgId` logs `Repair budget exceeded` and returns
   (`:129-133`); the lifecycle already defines `skipped` with reason `repair-exhausted`
   (`al-delivery-lifecycle.ts:66-70`) but that path never reaches it.
7. **No recovery owner exists.** A receiver that observes `resync-required` NACKs the sender, drops
   the message, states `admission-outcome` `not-handled` and calls no application code
   (`al-inbound-message-admission.ts:218-220`, `al-inbound-message-runtime.ts:244-257`). The typed
   channel definition (`rallar-message-contracts.ts:111-126`) has no recovery field; no cursor
   reaches the application; the track stays where it is until a new epoch closes it or the 5 min
   track TTL expires.
8. **The lane proves `resync-required` only.** `ordering-resync` sends seq 1 then 300 and asserts
   the NACK over `ws` and the `not-handled` outcome over `rtc`. No cell covers an in-window gap
   repaired, exhausted repair, or an owner invocation.

## 2. The design, per concern

### 2.a The sender retries its own hop (D136)

`retryMissingAcknowledgements` and `readRepairPlan` keep refusing a room-scoped retry without a
repair planner, except when every failed peer is one of the captured plan's next hops
(`plan.ackTracking.nextHopPeerIds`). Such a retry replays the same prepared frame to the same hop
and cannot widen the audience; the hop re-checks room authority at ingress. For the server-addressed
command the next hop is the server; for a WS room `hop` or `subtree` send tracked against the server
it is the server too. A `receiver` room multicast or session unicast has no client-tracked hop and
stays the server's to retry (D38, D48). Cost per acknowledgement-timeout window: one frame, at most
`maxAttempts` per message inside its deadline; the server's identity dedup holds deadline plus grace
(D125) and re-acknowledges the repeat (D126), so the application applies the command once.

Declined: giving the WS client a `planRepairMessage` (it would disable both room guards, admit room
gap NACKs through `hasCurrentRepairAuthority`, and replace the captured policy for every message);
leaving the guard and documenting the loss (contradicts D89, D126, D134).

### 2.b The cross-backend proof (D137, D138)

One schedule module, `packages/tests/shared/alm/al-shared-key-arbitration.test.ts`, drives the
stale-read then sequential-commit schedule (A reads, B reads, B commits, A commits: one winner, the
loser `conflict` with no write and no revision bump) over `memory`, `indexeddb` and `pglite` for
both stores and every shared key the stores arbitrate on: the inbound dedup key, the inbound
supersedence latest, the inbound ordering track, the outbound supersedence latest and the outbound
sender version. The schedule names the written key whose guard decides each case, so the proof
states what it rests on. The gated real-PostgreSQL suite gains the outbound supersedence
two-connection case beside the existing inbound ones. The existing scattered cases stay where they
are; the new module is the one place a reader finds the exit evidence.

The PostgreSQL backend keeps fencing written keys only (D138). The inbound README's conflict
equivalence paragraph is corrected to say so and to name the schedule module as the proof that the
arbitration rests on written keys. Declined: fencing read-only keys on PostgreSQL (a `SELECT ... FOR
UPDATE` or a revision read per observed key inside the transaction, for a case no shared key
reaches); `SERIALIZABLE` isolation (retry storms under load, no consumer).

### 2.c Ranges replace lists (D139)

`ALSeqRange { from, to }` (inclusive, `from <= to`) is the repair unit. `ALOrderingObservation`
carries `missingRanges` instead of `missingSeqs`; the NACK and repair payloads carry
`missingRanges`; the repair hint, the planner's NACK plan and the control validation compare
ranges; effect ids join ranges as `from-to`. The receiver computes ranges directly from the
contiguous head and the buffered set (a window of 256 holds at most 128 disjoint ranges), and the
codec caps a payload at 128 ranges. `ALOrderingTrackSnapshot.bufferedSeqs` stays a list: it is the
set of out-of-order messages held, which the gap computation subtracts, and it is bounded by the
256-message ceiling already.

The wire cutover is one step (D3): `al.control.nack.v2` and `al.control.repair.v2`; the `v1` ids
join `al.control.ack.v1` as refused `unsupported`. The buffered slot rows persist the plan with its
ranges, so `AL_ADMISSION_SCHEMA_ID` bumps to `rallar-alm-2026-10-range-repair` and the browser's
database is recreated as the inbound README's bump policy says; PostgreSQL rows carry no schema id,
and the ordering track TTL (5 min) and the message deadlines bound the deploy window, stated in the
README. Declined: ranges beside lists during a window (D3 forbids it); ranges for `bufferedSeqs`
(no reader needs them compact); a page cursor on the wire (2.d bounds the work on the sender).

### 2.d Paged retransmission (D140)

A repair hint is served `AL_REPAIR_PAGE_SIZE = 32` messages per work execution, ascending by
sequence across its ranges; what remains is re-committed as one follow-up `repair-hint` carrying the
remaining ranges, so a wide gap costs a bounded page of indexed reads and dispatch commits per
round and the engine schedules the rest. Declined: an unbounded loop (today); a page cursor the
receiver pages (the receiver's one NACK already names the whole gap inside the window).

### 2.e Exhausted repair terminates typed (D141)

When a message's repair attempts reach `repair.maxAttempts`, the retransmitter settles the message
`skipped` with reason `repair-exhausted` once, through the lane's settlement sink, and writes
nothing else; the warning goes. The handle's lifecycle shows the terminal statement. Declined: a
new settlement kind (the lifecycle has one); keeping the warning (a log line is not a terminal
outcome).

### 2.f The recovery owner (D142)

`RallarTypedMessageChannelDefinition` gains `recovery?: { onResyncRequired(cursor) }`; absence
means today's behaviour (the message is dropped and diagnostics state it), which is the one domain
meaning an optional field may carry. The cursor is
`{ orderingKey, senderId, epoch, lastContiguousSeq, expectedSeq, observedSeq, carrier }`: what the
receiver knows about where its track stands and what it saw. The browser's inbound dispatch invokes
the owner when an admission is accepted `resync-required` or an ordered release is rejected, once
per ordering track per runtime, held in a `LatestRepository` keyed by track key; a new epoch from
the sender closes the track and clears the mark, as it closes the track today. The runtime emits a
`recovery-owner-invoked` diagnostics event with the cursor, which the harness observes. The WS server
has no application owner and keeps NACKing `resync-required` (D49, D50). ALM resets no track: the
owner's catch-up is the application's, and the sender's new epoch is the protocol's.

Declined: a durable once-mark (a reload loses the page's state, so re-invoking after a reload is
right); a sender-side owner (the sender's handle already settles `relay-rejected`, D50); an ALM
track-reset API (a second authority over the sender's epoch).

### 2.g Evidence

- Unit: the own-hop retry over a room-scoped WS unicast to the server (two frames, same msgId) and
  the negative pin (a `receiver` room multicast is not retried by the client); the schedule module
  over three backends; range computation, codec bounds and validation; paging with a follow-up
  hint; the typed exhaustion; the owner's once-per-track invocation and its cursor.
- Lane: `ordering-gap-repair` (the sender holds seq 2's frame with the native hold, sends 1, 2, 3;
  the receiver NACKs the range `2-2`; the sender retransmits; all three deliver in order, over
  every carrier); `ordering-resync` gains the owner (`recovery-owner-invoked` once with
  `expectedSeq: 2`, `observedSeq: 300`); `repair-exhausted` (the native hold on every retry;
  `skipped`/`repair-exhausted` on the handle after `maxRepairs`).
- Consumer: the Relic reload-mid-command case green.
- Pins: the ledger, cold, inbound and D55 pins unchanged; the I2b checkpoint pin unchanged.

## 3. Decisions (2026-10-03)

1. **The sender retries its own hop without a repair planner (D136).** Declined: a WS
   `planRepairMessage`; keeping the guard.
2. **One three-backend schedule module for both stores, plus the gated real-PostgreSQL outbound
   case (D137).** Declined: a backend-level generic test; leaving the proof scattered.
3. **PostgreSQL fences written keys only; the README says so (D138).** Declined: read-only fences;
   `SERIALIZABLE`.
4. **Ranges replace lists, `v2` control ids, schema bump (D139).** Declined: a compatibility window;
   ranges for `bufferedSeqs`; a wire page cursor.
5. **Paged retransmission, 32 per round, follow-up hint (D140).** Declined: the unbounded loop.
6. **Exhausted repair settles `skipped`/`repair-exhausted` (D141).** Declined: a new kind; the
   warning.
7. **An optional channel recovery owner, invoked once per track per runtime with the cursor
   (D142).** Declined: durable once-marks; a sender-side owner; a track-reset API.

## 4. Corrections to the roadmap and the product description

- The product description's "ACK timeout … can request retransmission" was not true for a room-scoped
  WS send without a planner; D136 makes it true for the sender's own hop.
- The inbound README's "every key the write phase read or wrote" is corrected for PostgreSQL (D138).
- The roadmap row "5 R1" stands. Its consumer row ("round transitions use an ordering key per round
  with range repair") is R2's: Relic's rounds gain an ordering key with membership fencing.

## 5. Carries: what R1 does not do

- A lost client-to-server frame of a `receiver` room multicast or session unicast is not retried
  by the client (no client-tracked hop; the server owns those retries).
- Membership fencing (R2).
- Relic's round-start notifications on an ordering key (R2's consumer proof).
- A track reset after the owner's catch-up: the sender's new epoch closes the track.
- The WS server's own resynchronization owner: it NACKs, as today.
