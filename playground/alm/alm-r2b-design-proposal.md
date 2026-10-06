# ALM R2b design proposal: server-sequenced tracks and Relic's round transitions

Status: decided 2026-10-06 (D150 to D155), the recommended option taken on each under the
maintainer's instruction to plan and execute the next slices from merged `main`; a reversed decision
re-plans its task. Spec: [the roadmap](alm-improvement-plan.md) D149 and the consumer-proof row
"5 R1, R2" (Relic column), D24, D43, D49, D50, D72, D77, D79, D136, D139, D140, D141, D142, D146;
[the product description](alm-complete-product-description.md) "Ordering and gap recovery" and
"Repair and resynchronization". Code survey of `main` at `e366f60eb` (R2 merged, #642). The
implementation plan is `plans/active/alm-r2b-server-sequenced-tracks-implementation-plan.md`.

## 1. The problem

R2 delivered membership fencing and carried the Relic half of the Release 5 consumer row: "round
transitions use an ordering key per round with range repair". D149 named the capability it needs, "a
server-assigned sequence per track and server-side range repair, which the server's publish path
lacks". The survey found that the gap is narrower than D149 feared, and shaped differently:

1. **Nothing in ALM assigns a sequence.** A browser caller passes `orderingKey` and `seq` itself
   (`browser-rallar-message-sender.ts:370-372`); no per-track counter exists anywhere; D24 made WS
   sequences client-assigned. The server's publish path passes the envelope through untouched and no
   server publication sets `ordering` except the state-sync group events, whose `seq` is the group
   `snapshotVersion` with the comment that nothing promises contiguity
   (`state-sync-entry-computation.ts:189-194`).
2. **The WS server already has a sender's repair machinery.** It runs a full outbound runtime with a
   sent cache, the ordering index, a repair planner that serves a requester inside the admitted
   audience (`ws-queue-box-server-outbound-planning.ts:229-269`) and control admission for a client's
   NACK or repair request addressed to the server (`ws-queue-box-server-receipt-aggregation.ts:204-214`);
   repair by `msgId` is pinned (`ws-server-qos-policy.test.ts:510-563`). What is missing is only the
   sequence: with no `seq` the sent row's ordering index is null, so a ranged NACK is refused
   (`validate-al-outbound-control-admission.ts:136-139`) and there is nothing to page from.
3. **The WS client already orders server tracks.** A server publication with `orderingKey` and `seq`
   is tracked as `${orderingKey}:default-qbox-server:${epoch}`, gaps are NACKed to the server peer id
   (`al-inbound-admission-store.ts:858`), and the recovery owner of R1 is found through a typed
   channel's `recovery` (`browser-channel-recovery-owners.ts:23-27`).
4. **Every server publication shares one sender.** The server peer id is the cluster-wide constant
   `default-qbox-server`, so every server track shares one `senderId` and every server outbound
   commit is fenced on the one sender-version row of the shared store
   (`al-outbound-admission-store.ts:663-700`). A sequence minted under that fence is contiguous
   across instances and survives a restart; one minted at a call site is neither.
5. **Relic's snapshots are latest-wins, not ordered.** Every applied command publishes the whole
   snapshot (`relic-game-service.ts:116-143`); the client accepts the newest by an app comparator
   (`relic-snapshot-ordering.ts:45-93`), repairs over RTC every 2 s and polls REST after a round's
   deadline. Putting snapshots on an ordered track would buffer every newer snapshot behind an
   unrepairable gap for the track's TTL: the wrong QoS for a state snapshot. Round transitions are
   events (`round_started` and the resolve and review transitions in `rules.ts`), the UI's round cues
   are derived from the snapshot's event list (`App.tsx:276-314`, `RelicSceneNext.tsx:2309`), and the
   `room.relic.event` topic and `relic.event.v1` type exist unused (`protocol.ts:3-15`).
6. **A late joiner's track is unrepairable by design.** A receiver with no track expects `seq` 1; the
   server repairs only requesters of a message's admitted audience (D43), so a joiner's gap is never
   served and the joiner buffers until the 5 min track TTL or `resync-required`. R1 carried this.
7. **No harness step makes the API server publish a typed room message**, and the Relic Playwright
   suite is a manual lane. A lane-only publish route on the server would be test-only wiring in
   production code.

## 2. The design, per concern

### 2.a The server mints the sequence at admission (D150)

A server publication that names `ordering.orderingKey` (and an `epoch`) without a `seq` asks the WS
server's outbound to sequence it. The outbound admission store gains one ordering-head row per
track, keyed beside the sender-version row (`toALOutboundOrderingHeadKey(namespace, trackKey)`): the
decision read loads the head, compute assigns `head + 1` to the message, and the same fenced commit
that stores the admitted message advances the head, so two instances cannot mint the same sequence
and a restart continues where the store stands. A repeated admission of the same `msgId` finds its
row and mints nothing (write-if-absent, as today). The sequenced message is what the sent row, the
ordering index, the cluster fan-out and the wire carry. Browser senders are unchanged: a browser
send still states `orderingKey` and `seq` together or not at all. D24 is narrowed: a browser's
sequence is client-assigned; a server publication's is minted by the server.

Declined: minting at the Relic call site (its per-game chain is process-local and restarts at 1);
minting in the Relic game-state row (app-local, plain `get`/`set` without compare-and-set); a
separate sequence service.

### 2.b Relic's round transitions ride a track per round (D151)

The Relic server publishes a round-transition event on `room.relic.event` / `relic.event.v1` beside
its snapshot whenever a command's rules emit a round transition: the round starting (`round_started`),
the round resolving into review, and the review continuing into the next round or the finish. The
event carries the game id, the round, the phase entered and the transition's text, with
`ordering: { orderingKey: <gameId>, epoch: <round> }` and no `seq`, `reliability: 'at-least-once'`,
`ack: 'receiver'` and `RELIC_EVENT_TTL_MS = 60_000` (the default round time limit): one track per
round, keyed by the game, sequenced by the server. A new round is a new epoch, which closes the
previous track at every receiver (D142) and lets a joiner start clean at the next round boundary.
The snapshot publication is unchanged and stays latest-wins.

Declined: ordering the snapshots (2.a's 5th finding); one epoch for the whole game (a joiner would
stay behind for the rest of the game); a key per round with epoch 0 (the epoch is the round's name
in the recovery cursor).

### 2.c The Relic client consumes the stream through a typed channel (D152)

The browser subscribes to `room.relic.event` through a typed room channel (purpose `notification`)
whose `recovery.onResyncRequired` re-hydrates the game over the existing REST read
(`GET /api/relic/games/:gameId`) and whose messages drive the UI's live round cues in order; the
snapshot stays the truth for the game state and its event list stays the history the scene reads.
A joiner mid-round sees no cue for that round's remaining transitions (its track starts at the next
epoch) while the snapshot still shows the state, a stated limit. The 2 s RTC snapshot repair and the
REST deadline polling are independent app paths and stay.

Declined: deriving cues from both sources (two owners of one cue); a Relic-specific resync fetch
outside the typed channel's owner.

### 2.d Server-side range repair, proven at the server (D153)

With the sequence minted, the sent row carries the track and sequence, a client's ranged NACK passes
the ordering-hint validation, the repair hint pages 32 messages from the ordering index along the
requester (D140), exhaustion settles `repair-exhausted` (D141), and the requester must be a peer the
pending receipt expects or the message's admitted audience holds (D43). The proof is written where
the behaviour lives: the WS server fixture (an ordered publication minted 1, 2, 3; a client's gap
NACK for `2-2` retransmitted to that requester alone; a follow-up hint past 32; a request past the
deadline serves nothing; a joiner outside the audience is refused; a `resync-required` NACK ends the
receipt), the shared-key schedule gains the ordering head over memory, IndexedDB and pglite with the
gated real-PostgreSQL two-connection case, and the api-v1 Deno end-to-end test publishes an ordered
message through the real router.

Declined: a lane cell (no harness trigger exists for a server-originated typed send, and a lane-only
server route is test-only wiring; a harness capability for server-originated sends is a carried
follow-up); widening the server's repair to joiners outside the audience (D43).

### 2.e The consumer proof (D154)

The Relic Deno tests pin the event publication (the minted-free envelope: key, epoch, no sequence,
TTL, receipt) per transition; the Relic full-stack Playwright case (manual suite) gains the ordered
cues: two browsers see start, resolve, continue and the next round's start in order, and a browser
reloaded mid-game picks the cues up at the next round. Hosted manifests 18 and 22 are byte-identical.

### 2.f Carries (D155)

- A late joiner within a round buffers that round's remaining transitions until the next epoch; no
  track-start hint exists in the protocol.
- Repair is bounded by the event's 60 s deadline; the ordering index dies with it.
- The state-sync group events carry a non-contiguous `seq` (`snapshotVersion`); whether a client's
  window NACKs the server for their gaps is a pre-existing question the slice records, not changes.
- Server tracks carry no membership fence (D146).
- Relic's per-game serialization is process-local (D72); the minted sequence is contiguous whichever
  instance publishes, and concurrent command application across instances stays Relic's own hazard.
- A server-originated send has no conformance cell.

## 3. Decisions (2026-10-06)

1. **A server publication naming a key without a sequence is sequenced at the server's outbound
   admission from a per-track ordering-head row under the sender-version fence; D24 narrowed (D150).**
   Declined: call-site or game-state minting; a sequence service.
2. **Relic publishes a `relic.event.v1` round-transition event on a track per round (`orderingKey`
   the game id, `epoch` the round), 60 s TTL, receipted; snapshots stay latest-wins (D151).** Declined:
   ordered snapshots; one epoch per game.
3. **The Relic client reads the stream through a typed channel with a REST-hydrating recovery owner,
   and the UI's live round cues come from it (D152).** Declined: two cue owners.
4. **Server-side range repair is proven at the server fixture, the three-backend schedule and the
   api-v1 end-to-end test; no lane cell (D153).** Declined: a lane-only publish route.
5. **The consumer proof is the Relic Deno pins and the manual Playwright case; hosted manifests
   unchanged (D154).**
6. **The carries above are recorded as limits (D155).**

## 4. Corrections to the roadmap and the product description

- D149's "which the server's publish path lacks": the publish path lacks the sequence only; the
  server's repair machinery exists. The roadmap's consumer row (Relic) is delivered by this slice.
- The product description has no Relic paragraph; this slice adds one under the consumer section and
  states server-sequenced tracks under "Ordering and gap recovery".
- The API reference's "Ordering, Repair And Resynchronization" gains the server-sequenced track and
  the server's repair of its own publications.

## 5. Carries: what R2b does not do

- A harness capability for server-originated typed sends (and so a conformance cell).
- A track-start hint for late joiners.
- Ordering of the Relic snapshot itself.
- A fence on server tracks.
- Relic's cluster-safe command serialization.
