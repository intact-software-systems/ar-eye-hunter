# ALM publication QoS Slice 4 design proposal: ordered subscription entry (S4-i, S4-ii)

Slice 4 of the [publication QoS and pub/sub addendum](../../../playground/alm/alm-publication-qos-addendum.md) (§5.4
"Ordered streams and subscription entry"; "Later outcomes", the "Ordered subscription establishment" bullet; §8 row
"Ordered entry and exclusions do not leak or invent history"), after S3-ii (#777). Written from the four read-only
surveys in this folder of `alm-qos-slice-3-ii` at `c673b4997` (contains main `fe0fb3505`), re-checked against the
code. Every decision is **proposed** for the maintainer's ruling, S4-R1–S4-R14, recommended option first. Four correct
the surveys where the code contradicts them (S4-R1, S4-R4, S4-R6, S4-R8). Slice 4 lands as two pull requests (S4-R14).
Decisions are D524–D537 in the roadmap's decision record, entered at each close; this file is deleted with S4-ii's.

## 1. The problem and the scope

§5.4 asks an ordered subscription to establish a start position and generation before release, to distinguish
transport loss from intentional audience exclusion with "explicit, non-payload omission evidence that the ordering
owner can validate", never to repair below what a subscriber was entitled to, never to reset a track for a joiner,
and never to let rejoin or restart reuse a visible position for different content; per-publisher tracks stay
separate. Today every receiver opens a track at sequence 1 and asks for everything below its first copy.

**Scope (candidate 2a, "live entry and omissions").** A session entering a frozen-audience ordered room track starts
at the first sequence its ordering authority sends it, without stalling and without history; a staying subscriber
sees later exclusions as validated omissions, not loss; repair never serves below a recipient's entry; a reconnect
is an exit and re-entry that reads as omission; two publishers are two tracks; the browser outbound allocates the
positions it signs. Over `ws`, `rtc` and `rtc-with-ws-fallback`, for browser and server origins, granted and
`members` topics alike.

**Not in this slice.** A latest-state snapshot with a fenced live cursor and a retained-history replay cursor (2b,
A:430-432: both need retained storage and its lifetime); an explicit historical start position (S4-R3); total
order across publishers; an application-visible omission callback (omissions are protocol-internal and
diagnostic); signed receipts; a hosted manifest (D505); the ordered members-topic joiner cell that leaves and
rejoins a room (its proof is the fixture).

## 2. Where Slice 3 leaves the ordering model (facts)

`AC` = `packages/shared/al-contracts`; `ALM` = `packages/shared/alm`; `MC` = `packages/shared/multicast`;
`QBS` = `packages/shared/services/ws-queue-box-server`; `GS` = `packages/shared-server/rallar-system/group-state`.

- **Track and position.** A track is `${orderingKey}:${senderId}:${epoch ?? 0}`, named by no topic, audience or
  generation (`AC/al-runtime.ts:73-97`); its snapshot is `{ lastContiguousSeq, bufferedSeqs, updatedAtMs }` (`:53-57`).
  A receiver with no snapshot expects `1` (`ALM/compute-al-ordering-observation.ts:33-41`); a sequence more than 256
  past the expected one, or a full buffer, is `resync-required` (`:44-55`, `:86-88`;
  `AC/al-message-resource-limits.ts:19-24`),
  a drop that stops forwarding (`AC/al-policy.ts:538-540`; `ALM/inbound/al-inbound-message-admission.ts:114-115`). A gap
  defers delivery only for a logical recipient and NACKs the immediate hop (`al-policy.ts:572-582`, `:638-645`).
- **Every admitted frame moves the track.** The ordering acceptance is applied whatever the plan delivers
  (`ALM/inbound/al-inbound-planner-snapshot.ts:120-135`) and written whenever it yields a snapshot
  (`ALM/inbound/admission/al-inbound-delivery-mutations.ts:45-51`): a relay, a forward-only peer and a frozen
  recipient with a `pending` token (`MC/publication/compute-rtc-publication-admission.ts:104-122`) all advance it, so
  two
  subscribers of one topic end at different positions under different trees
  (`MC/rtc-room-snapshot-admission.ts:281-283`).
- **Browser positions are the application's.** A browser send passes `input.seq` through
  (`packages/shared-web/browser/messages/browser-rallar-message-sender.ts:496-498`, `:524-527`); a WS send states both
  halves or neither (`browser-message-input-validator.ts:132-152`). Only the WS server mints, for its own publications,
  through `mintsSequence` (`QBS/ws-queue-box-server-outbound-planning.ts:166-173`), a head row read in the admission
  session and written in the fenced commit (`ALM/outbound/admission/al-outbound-admission-reads.ts:433-454`;
  `al-outbound-admission-mutations.ts:236-246`), expiring with the sent row (`:363-371`). "The browser's outbound never
  mints" (`ALM/outbound/README.md:815`). No browser code in `apps/*/src` sets an ALM `orderingKey`; Relic's server sets
  `{ orderingKey, epoch: round, seq: 1 | 2 }`
  (`packages/relic-hunters/server/compute-relic-game-publications.ts:264-278`).
- **Two audience authorities.** RTC: the origin freezes live sessions whose principal holds `subscribe` and signs
  (`MC/publication/rtc-granted-publication-carrier.ts:104-134`; `compute-granted-subscribe-holders.ts:8-21`); a frozen
  recipient without an active token forwards, delivers nothing and answers `not-subscribed` (D518). WS: the server
  intersects live, leased, generation-matched subscriptions per pass
  (`packages/shared-server/rallar-system/websocket/room-publication/compute-room-publication-admission.ts:59-86`),
  captures the audience and generations beside the row (`websocket/router/publish-rallar-server-ws-message.ts:153-165`,
  `:214-235`; `ALM/outbound/admission/al-outbound-admission-validation.ts:37-56`) and only narrows it afterwards
  (`QBS/ws-queue-box-server-dequeue-authority.ts:118-145`; D498). The route and the socket admission read independently
  (`websocket/router/rallar-server-ws-router.ts:197-266`). No version orders "S subscribed" against "the sender froze"
  (a subscribe bumps nothing, D504), and the origin never sees subscription rows (D508).
- **Repair floors that exist.** The WS server serves a gap only to requesters inside the row's `admittedAudience`
  (`QBS/ws-queue-box-server-outbound-planning.ts:249-290`; pinned
  `packages/tests/shared/services/ws-queue-box-server-ordered-repair.test.ts:163-176`:
  the joiner gets nothing and stalls). An RTC responder serves a target only inside the signed frozen audience and
  holding `subscribe` (`MC/publication/compute-rtc-repair-target-admission.ts:31-47`) — a frozen holder whose token was
  `pending` is admitted. A control addressed to a peer other than the stored owner is refused
  (`ALM/outbound/validate-al-outbound-control-admission.ts:32-34`),
  so a downstream gap NACK addressed to a relay is never served; the relay plans a repair whose result is discarded
  (`al-outbound-repair-admission.ts:131-166`). Over WS a client's NACK for a `trusted-server` frame names the message's
  `senderId` (`packages/shared/services/ws-queue-box-client-service.ts:316`).
- **The signed envelope.** `ordering` is signed field by field through an exhaustive class record
  (`AC/publication-proof/al-publication-proof.ts:52-67`, `:97-101`): a new `ALOrdering` key does not compile until
  classified. No plan may change a signed field (`:155-160`); repair resends the stored signed envelope (D519). The
  persisted decoder accepts exactly `orderingKey`, `epoch`, `seq` in `ordering`
  (`AC/al-message-persistence-validation.ts:191-196`).
- **Receipts.** A `not-subscribed` NACK and the `subtree-complete-not-subscribed` completion place the recipient
  outside the audience, never confirmed (`ALM/outbound/transition-al-outbound-pending-ack.ts:139`, `:157-161`;
  `QBS/ws-queue-box-server-receipt-aggregation.ts:640-652`); a session the dequeue re-check drops "stays expected in
  the receipt its admission wrote" (`ws-queue-box-server-dequeue-authority.ts:118-123`).
- **Subscription row.** `{ sessionId, principalId, topicId, connectionGenerationId, leaseExpiresAtEpochMs,
  admittedAtGroupRevision }`, answer `{ outcome }`
  (`packages/shared/api/group-publication/group-topic-subscriptions.ts:14-33`);
  rebuilt on every renewal (`GS/mutation/subscription/compute-group-topic-subscription-mutation.ts:60-86`); the write is
  the row alone (`:149-167`). `admittedAtGroupRevision` has no production reader. A same-session WS reconnect leaves
  room presence closed (D506; `GS/presence/group-session-cleanup.ts:20-35`;
  `packages/shared/api/group-presence/is-live-room-session.ts:4-6`),
  so the reopened session is in neither audience.
- **Harness.** No conformance cell sends an ordered granted publication (`toGrantedSend`,
  `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/topic-subscription-publications.ts:246-263`);
  message events carry no ordering fields
  (`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts:283-291`);
  the inbound diagnostic union has no ordering kind (`ALM/inbound/al-inbound-runtime-diagnostics.ts:103-125`). Cells
  run only in the non-blocking observation job at `smoke` (`.github/workflows/alm-conformance-observation.yml:10-13`,
  `:27-28`); no hosted entry carries four-role cells
  (`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:76-79`, D505).
- **A defect fixed on S3-ii after the surveys.** At `c673b4997` a frozen, not-subscribed recipient that observed a
  gap kept the gap NACK (`rtc-room-snapshot-admission.ts:145-163`) and so sent neither NACK
  (`compute-al-inbound-admission.ts:192-194`); `60992a663` makes it answer `not-subscribed` and end its hop confirming
  nobody. The invariant S4 preserves: a not-subscribed admission never NACKs a gap, buffers nothing, and its hop
  completion confirms nobody.

## 3. Decisions (proposed)

### S4-R1. Who fixes a recipient's start position and its omissions? (corrects the surveys)

- **(a) Recommended: the authority that finalizes a copy's audience, at the moment it sends.** On RTC the origin, at
  the carrier admission that freezes and signs (`signLeg`); on WS the server, at the send commit of each per-recipient
  copy (`toPreparedRecipients`, `QBS/ws-queue-box-server-outbound-planning.ts:226-240`), after D498's narrowing. Each
  authority keeps, per `(track, recipient)`, the last sequence it actually sent that recipient, beside the ordering
  head in the same admission store, read in the admission session and written in the fenced commit — the shape
  `readSequenceMint` and `set-ordering-head` already have. Never the subscribe write: it sees no sequence (§2) and is
  invalidated by narrowing.
- (b) The surveys: the WS record at the route pass. **Corrected:** a session dropped at dequeue (revoke, generation
  change) would be recorded as sent and its next copy would read the drop as loss; recording at the send is truthful,
  and the fence serializes two instances dequeuing one track out of order (S4-R7).
- (c) The subscribe answer returns a start position. Works only for server-minted tracks on WS and splits the
  mechanism by origin; the server never sees an RTC track.
- (d) One contiguous track per audience. Rejected by A:435-437.

**Why (a).** Only the sender of a copy knows what it sent whom; both authorities already run a fenced per-track
commit. **Cost if wrong:** one indexed read and write per frozen recipient per ordered send (≤ 256), on both sides.

### S4-R2. What is the evidence, and where does it ride?

- **(a) Recommended: `ordering.priorSeqByRecipient`**, a record from recipient session id to the last sequence this
  authority previously sent it on the track, `0` for none, listing only recipients whose prior is not `seq − 1`;
  present (possibly empty) on every frozen-audience room multicast, absent on unicast and unfrozen sends. On RTC it
  is signed by the origin (classified `signed`; the exhaustive record forces it) and travels with every repaired copy,
  so a lost entry frame is recovered by the repair that already serves that frame to that recipient. On WS the server
  writes its own record on each per-recipient copy and drops `proof` from that copy: a server copy is the server's
  word, admitted `trusted-server`, never verified (D519). Payload-free; bounded by the audience limit (256).
- (b) A separate omission control message. Can be lost, reordered or forged by a relay unless signed, and needs its
  own retention.
- (c) The server's record in the excluded `forwarding` section. Keeps the proof intact but makes a receiver read two
  fields by source: one mechanism, two homes.
- (d) A payload-free copy of each excluded frame. Cannot be signed under D514.

**Cost if wrong:** an older decoder refuses the new `ordering` key `malformed` (§7); the first frame of a wide
track carries up to 256 entries.

### S4-R3. What is the default start position?

- **(a) Recommended: live from the first sequence the authority sends the session, with no history.** A subscriber
  never receives a sequence admitted before the authority first sent it; A:718 ("no replay to an unauthorized or
  newly joined historical audience") is met by construction, and the application's state read, as Relic's recovery
  owner already does (`apps/relic-hunters-v1/src/game/subscribe-relic-round-transitions.ts:30-42`), supplies the
  past.
- (b) Every subscribe declares `live | snapshot | replay`. Needs 2b's retained storage for two of the three.
- (c) A historical start bounded by the repair window. Reveals frames the session was not subscribed for (row 755).

### S4-R4. How does a receiver open, advance and merge? (corrects the surveys)

- **(a) Recommended.** `computeALOrderingObservation` reads `p = priorSeqByRecipient[self]` (absent means `seq − 1`)
  and the record's presence. With no snapshot: record present → `entered` at `seq` (no window check, nothing below is
  a gap); record absent → today's rule. With snapshot `L`: `p > L` → `gap` whose missing ranges end at `p`, `seq`
  buffered; `p = L` → `omitted` `(L, seq)`, delivered, `L = seq`; `p < L` or `p = 0` → no information, today's rule
  from `L`. `entered` and `omitted` deliver as `in-order`; a buffered release is contiguous when `L` equals the
  slot's `seq − 1` or its own record's `p`. The receiver trusts its own position over an authority behind it, which
  is how `rtc-with-ws-fallback` merges the origin's and the server's records on one track.
- (b) The candidates survey: `p = 0` with a snapshot re-opens the track. **Corrected:** on a fallback leg the server's
  first copy is its first, not the track's; re-opening would discard a lost RTC frame as an omission. A reconnect
  needs no re-open under S4-R1: the server's record for the session says `p = last sent`, which reads as omission.
- (c) Receiver-local fencing at token activation alone. Cannot tell a later exclusion from loss.

**Cost if wrong:** an authority that lost its position rows (a memory-profile restart) says `p = 0` and the receiver
asks for a gap nobody serves until its 60-minute track TTL — today's behaviour for a restarted server track.

### S4-R5. Which admissions observe a track?

- **(a) Recommended.** A delivering or deferred admission observes as today. A frozen recipient that delivers
  nothing (`forward-not-subscribed`) **witnesses**: its position moves to `seq`, nothing is buffered, no gap NACK, and
  its completion confirms nobody — the S3-ii fix's invariant, so the branch at
  `rtc-room-snapshot-admission.ts:150-163` has one input and is deleted. A peer outside the frozen audience and a pure
  relay observe nothing and always forward.
  The WS server keeps observing its clients' tracks as their ordering hop
  (`ws-queue-box-client-own-hop-retry.test.ts:147`);
  the role is a composition input of the inbound runtime, not a per-frame inference.
- (b) No observation for any non-delivering admission. Then a session whose token was `pending` while frames were
  frozen to it has no position at activation and asks for them: the lost-while-pending replay the surveys infer.
- (c) Relays keep observing. They keep dropping an entering session's track `resync-required` and stop forwarding.

**Why (a).** A position depends only on frames addressed to the session, never on the tree, so two subscribers with
one entitlement end at one position. **Cost if wrong:** a frame frozen to a pending session and lost in transit is
repaired after activation (it is inside its frozen audience); the exclusion a session declares is what it witnessed.

### S4-R6. Who allocates a browser track's sequences? (corrects the candidates survey)

- **(a) Recommended: the outbound mints.** A browser room send naming `orderingKey` without `seq` is minted by the
  existing mechanism: the browser planner marks `mintsSequence` for frozen-audience room sends, `readSequenceMint`
  and the head row do the rest. The head and position rows of such a track live in the session's durable outbound
  store for the receiver track TTL (`DEFAULT_AL_REPOSITORY_TTL_MS`), whatever the message's lane, so a reload or a
  quiet hour continues the track (A:442-443). An application `seq` on a room send stays accepted and is guarded
  monotonic against the head (`unsupported` below it), since the harness forces resynchronization with explicit
  sequences (`ordering-resync`). The WS validator's both-or-neither rule becomes "a key alone asks for minting".
- (b) Refuse every application `seq` on room sends. Breaks the resync cells and the workbench presets for no
  correctness gain once the guard exists.
- (c) No minting. The origin cannot compute "previous sent" for positions it did not allocate, and a reload reuses
  positions.

**Correction.** The survey says browser sequences are "client-assigned"; they are caller-supplied and no allocator
exists. **Cost if wrong:** the store split (`browser-al-runtime-stores.ts:138-157`) must host a durable head for a
volatile-lane message; S4-i's first check.

### S4-R7. Repair never below the entry

- **(a) Recommended.** The responders' audience rules are the floor and stay: a sequence a session was not frozen or
  captured into is `outside-frozen-audience` on RTC and filtered on WS. Three additions. A receiver answers a frozen
  frame below its position (`stale` past dedup) with a terminal `before-entry` NACK, which the receipt classes
  outside the audience as `not-subscribed` is. The WS server, finding at a send that the copy's `seq` is at or below
  the recipient's recorded position (a later row of the track committed first on another instance), sends nothing
  and records the recipient outside. A joiner inside the 256 window with no record for itself NACKs from `1` as
  today and is served from its entry, whose frame carries `p = 0`; past the window it is `resync-required` as today.
- (b) A new entry-floor check at the responder. Duplicates what the audience rules already decide.
- (c) Serve below the entry to a now-subscribed session. The replay the slice exists to close.

**Cost if wrong:** one more `ALNackReason`, its codec case and receipt class; a receipted send's repair toward a
reopened session converges only once that session is live again (S4-R8).

### S4-R8. What is the generation, and what does a reconnect mean? (corrects the surveys)

- **(a) Recommended: D503 stands; the position is per `(track, session)`; a reconnect reads as omission.** The
  server's record is keyed by session, not generation, so a session dropped under its old generation and sent again
  under the new one receives `p = last sent`: an exit and re-entry, never loss. On RTC the analogue is presence: a
  session that leaves the frozen audience and returns receives the same record from the origin. **D506 is absorbed
  in S4-ii**: the reopened socket re-asserts the session's room presence under its new generation through the
  existing presence mutation, since without it no reconnect can be witnessed on either carrier
  (`subscription-reconnect.ts:36-69` pins the gap).
- (b) The server survey: key the server's record by connection generation and re-open on `p = 0`. **Corrected:**
  S4-R4 (b).
- (c) A numeric subscription generation on the row. D503 dropped it; the only case it would add is an unsubscribe and
  re-subscribe under one generation inside a row's deadline, which repair treats as one subscription (§8).
- (d) Leave D506 to its own slice. Then row 760 "restart" and row 756 "new generation" have no positive lane witness.

### S4-R9. What does the receipt say about a session the server did not send?

- **(a) Recommended: outside the audience.** A session narrowed out at dequeue (D498) or skipped as below its
  position is recorded in `outsideAudienceRecipientPeerIds`, replacing "stays expected ... unconfirmed"
  (`ws-queue-box-server-dequeue-authority.ts:118-123`; `ws-room-granted-delivery.test.ts:158`): the server knows why it
  sent nothing, and row 757 asks for truthful outcomes. The expected set is unchanged.
- (b) Keep it unconfirmed. A declared exclusion then reads as loss to the publisher.

### S4-R10. Members topics and server tracks

- **(a) Recommended: one mechanism for every frozen-audience ordered room track**, granted and `members`, browser
  and server origin, server-minted or application-sequenced. The record is computed from the frozen or captured
  audience, which exists for `members` multicasts too (`web-rtc-overlay-frozen-audience.ts:41-51`; `admittedAudience`
  is captured for every server-admitted row). A Relic joiner then enters at the first transition after its join and
  is not served the round's `seq 1` inside `RELIC_EVENT_TTL_MS`.
- (b) Granted topics only. Adds a branch to the producer and keeps members joiners stalling into `resync-required`.

**Cost if wrong:** a product behaviour change for Relic joiners; §9 asks whether the join path reads the game state.

### S4-R11. The relay gap-NACK carry

- **(a) Recommended: relays re-originate a downstream gap NACK toward the origin per logical recipient**, as they do
  ACKs and `not-subscribed` (D518), and the origin's repair travels the tree; the refusal at
  `validate-al-outbound-control-admission.ts:32-34` stays. S4-ii.
- (b) A relay serves from its stored forward under the responder rule. Faster, but a relay may serve a copy that
  predates a revoke it has not seen, and the origin's `publish` re-check (D519) is bypassed.
- (c) Leave it: RTC repair behind a relay stays receipt-retry only. An entering recipient behind a relay waits.

### S4-R12. How is it proven?

- **(a) Recommended.** Units for the observation (`entered` past 257, `omitted`, `witnessed`, `p > L`, `p < L`, no
  record), the delivery mutations, the record producers (RTC at `signLeg`, WS at the send), the minting enablement
  and guard, the `before-entry` NACK and receipt class; the relay fixture (`rtc-relay-overlay-fixture.ts`) for a
  holder frozen in before activation, an excluded-then-included subscriber, a lost entry frame, a relay rewriting the
  record (fails the proof) and, in S4-ii, the relay-forwarded gap NACK; the WS server fixture
  (`ws-queue-box-server-ordered-repair.test.ts`) for joiner `c` entering without a stall, a browser-origin track, two
  instances dequeuing one track out of order; `ws-room-granted-delivery.test.ts` for the outside class. Cells, all
  `FULL_TAGS`, local lane: four-role `subscription-ordered-entry` and `subscription-ordered-omission` over `ws`, `rtc`
  and `rtc-with-ws-fallback` (`toGrantedSend` gains `orderingKey`; payload `seq` waits and absences; the new
  `ordering-position` inbound diagnostic read by the existing `wait`; no repair dispatch; count identity); S4-ii adds
  `subscription-ordered-reconnect` (D506, replacing the pinned gap) and three-agent `granted-rtc-ordered-relay` on the
  forced tree, `rtc` only, ordered last. Observation workflow stays `smoke`; units and fixtures are the blocking proof
  (D521). Budget ≈ +15–25 s per cell per carrier on the ~50 s four-role family; the two-agent family is untouched.
- (b) Three-agent for the entry cells. Shares one room at 3.2–3.4 m already.
- (c) Ordering fields on message events. The payload `seq` suffices once the harness supplies both.

### S4-R13. Where does it live?

- **(a) Recommended.** `AC`: the `ALOrdering` key, its decoder, proof class and persisted validation; `ALNackReason`
  and codec. `ALM`: the observation statuses, delivery mutations, the position store beside the head (reads, mutations,
  retention), repair's `before-entry` path. `MC/publication`: the RTC record at `signLeg`. `QBS`: the WS record at
  the send, the outside class, the skip rule. `shared-web`: the planner's `mintsSequence`, the validator, send input
  docs. `GS` presence (D506) and `api` (the deleted row field). Harness: cells, catalogue, pins. Deleted in S4-i:
  `admittedAtGroupRevision` (row, OpenAPI, recipe, decoder; no reader), the expect-1 opening for recorded tracks, the
  gap NACK of a not-subscribed admission and its branch, the relay's track observation, the stall expectation at
  `ws-queue-box-server-ordered-repair.test.ts:163`. Nothing is duplicated per carrier.
- (b) A separate `packages/shared/ordering` package. The vocabulary is ALM's; nothing outside ALM would use it.

### S4-R14. How does it land?

- **(a) Recommended. S4-i**: S4-R1–R7, R9, R10, R13 — the contract, both producers, the receiver rules, minting, the
  repair floor and receipt class, the deletion, units, fixtures, the two four-role cells, the documents. **S4-ii**:
  S4-R8 (D506) and R11, the restart proof (publisher reload continues its minted sequence), the reconnect and relay
  cells, `readUsage` ordering counters (§9), the documents, this file's deletion.
- (b) One pull request. One review across contracts, both outbounds, the WS server, group-state presence and the
  harness.
- (c) S4-i without minting. Then the origin signs positions it did not allocate (S4-R6 (c)).

**Why (a).** S4-i alone makes the shipped promise true for ordered streams on every carrier; S4-ii closes the two
carries whose witnesses need a reopened session and a relay.

## 4. Contracts (S4-i), sketched

```ts
// packages/shared/al-contracts/al-contract.ts
export interface ALOrdering {
    readonly orderingKey?: string;
    readonly epoch?: number;
    readonly seq?: number;
    /**
     * Recipient → the last sequence this authority previously sent it on the track, 0 for none; only recipients
     * whose prior is not seq - 1. Present on every frozen-audience room multicast; absent: no audience was frozen.
     */
    readonly priorSeqByRecipient?: Readonly<Record<string, number>>;
}
// al-publication-proof.ts: ordering.priorSeqByRecipient: 'signed' (the exhaustive record demands it)
// al-message-persistence-validation.ts: the ordering exact-key list gains it; decodeXxx(value: unknown): Either

// packages/shared/al-contracts/al-runtime.ts
export type ALOrderingObservationStatus =
    | 'untracked'
    | 'in-order'
    | 'gap'
    | 'resync-required'
    | 'duplicate'
    | 'stale'
    | 'entered' // first copy on a recorded track: opens at seq, no window check
    | 'omitted' // p === lastContiguousSeq: (p, seq) declared omitted, delivered in order
    | 'witnessed'; // a frozen recipient that delivers nothing: position moves, nothing buffered, no NACK
// ALOrderingObservation gains `priorSeq?: number` for the diagnostic; the plan treats entered/omitted as in-order.

// packages/shared/al-contracts/al-control.ts
export type ALNackReason = /* existing */ 'before-entry'; // terminal; the receipt classes it outside the audience

// packages/shared/alm/outbound/admission (beside set-ordering-head)
// readSentPositions(session, trackKey, recipientPeerIds): Record<string, number>  -- in the admission read session
// mutation { kind: 'set-sent-position', trackKey, recipientPeerId, seq } -- fenced commit, repository TTL
// computeALOrderingPriorSeqs(frozenRecipientPeerIds, positions, seq): Readonly<Record<string, number>>  -- pure
// toALOutboundSentPositionSkip(copy, position): Either<'below-position', copy>  -- WS: skip and record outside

// packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts
// | Readonly<{ kind: 'ordering-position'; trackKey: string; seq: number; priorSeq: number | null;
//              status: 'entered' | 'omitted' | 'witnessed' | 'before-entry'; carrier: ALDeliveryCarrier }> & ALMessageTrace

// packages/shared-web: RallarRtcSendInput / RallarWsSendInput: `orderingKey` without `seq` asks the outbound to mint;
// the planner marks mintsSequence for frozen-audience room sends; an application seq below the head is `unsupported`.
// packages/shared/api/group-publication/group-topic-subscriptions.ts: admittedAtGroupRevision removed (OpenAPI, recipe)
```

## 5. Dataflow and failure vocabulary

1. **Origin (RTC).** Plan freezes the audience → the admission session reads the head and the frozen recipients'
   positions → mints `seq` (key without seq) or guards the application's → computes `priorSeqByRecipient` → signs
   → the commit writes head, positions, sent row. Dequeue, re-plan and repair reuse the stored signed envelope.
2. **Server (WS).** Route captures the audience as today. At each send commit the dequeue session reads the
   recipients' positions, skips a copy at or below a position (recipient outside), stamps each remaining copy's
   record, drops `proof` from server copies, writes positions. Cluster: the fence orders two instances' commits;
   the loser re-reads.
3. **Receiver.** Dedup → room admission → ordering observation per S4-R4/R5 → deliver, defer, witness or refuse.
   `stale` on a frozen frame → `before-entry` NACK. Diagnostics state every `ordering-position`.
4. **Repair.** Requester inside the audience: served from its entry; outside: refused (unchanged). A served entry
   frame carries `p = 0` and opens the track. Relay gap NACKs: S4-ii re-origination.

| Code / status     | Lives in                                | Raised when                                                    |
| ----------------- | --------------------------------------- | -------------------------------------------------------------- |
| `entered`         | `ALOrderingObservationStatus`, delivers | first copy on a recorded track, any sequence                   |
| `omitted`         | the same, delivers                      | `p === lastContiguousSeq` and `seq > p + 1`                    |
| `witnessed`       | the same, no delivery, no NACK          | a frozen recipient without an active token                     |
| `gap` to `p`      | existing, missing ranges end at `p`     | `p > lastContiguousSeq`                                        |
| `before-entry`    | `ALNackReason`, terminal, outside class | a frozen frame at or below the receiver's position, past dedup |
| `below-position`  | WS send skip, recipient outside         | a copy's `seq` ≤ the recipient's recorded position             |
| `unsupported`     | `ALDeliveryRefusalReason` (existing)    | an application `seq` at or below the head                      |
| `resync-required` | existing                                | no record, no snapshot, more than 256 behind                   |

Every expected failure is a value; nothing throws but a programmer invariant (a plan changing a signed field).

## 6. Slicing, deliverables, validation

**S4-i** (S4-R1–R7, R9, R10, R13). Contracts and codecs; proof class; the position store and mutations; RTC record
at `signLeg`; WS record, skip and outside class at the send; receiver statuses, mutations and release rule; minting
enablement, guard and validator; `before-entry`; `admittedAtGroupRevision` deleted with OpenAPI, the
`api-v1-group-topic-subscriptions.json` readback and the black-box memory profile rerun; units, the relay and WS
fixtures, `subscription-ordered-entry` and `-omission` over three carriers; docs: `docs/rallar-api-reference.md`
"Ordering, Repair And Resynchronization", `ALM/inbound/README.md` and `outbound/README.md` ordering sections, the
addendum's Slice 4 "As applied (S4-i)", roadmap D524–D537 with notes, `plans/backlog.md` (the ordered-entry bullet
removed; D506 and the relay carry marked S4-ii). Gates: `test:unit`, `typecheck`, `typecheck:tests`, `deno task check`
and `deno task test` in api-v1, changed style and coupling, `check:browser-bundles` and the headless budget (a crossed
budget raised to the next KiB and recorded), `test:api-v1:black-box:memory`; the medium-scale Postgres gate is not
selected (no group-state mutation changes; the row field deletion is a decoder cutover, run under
`test:integration:postgres`). Local full-scope lane per carrier for the two cells.

**S4-ii** (S4-R8, R11). Presence re-asserted on the reopened socket (`GS` presence mutation; medium-scale gate
selected); relay re-origination of gap NACKs; `subscription-ordered-reconnect` replacing `subscription-reconnect`'s
pinned gap; `granted-rtc-ordered-relay`; the reload fixture proving a publisher continues its minted sequence;
`readUsage().ordering` counters (entries, omissions, before-entry) and the `ordering-position` dimensions (§9 of the
addendum); docs and the addendum's "As applied (S4-ii)"; this file deleted. Hosted manifests unchanged (D505).

## 7. Requirement-to-evidence (addendum §8)

| Row                                                        | Evidence item                 | Cell / pin                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ordered entry and exclusions do not leak or invent history | new subscription at nonzero   | `subscription-ordered-entry` ×3 carriers; observation `entered` past 257; WS fixture joiner `c` enters; relay fixture holder activation  |
|                                                            | intentional omission          | `subscription-ordered-omission` ×3; `omitted` unit; fixture excluded-then-included; `ordering-position` diagnostic                       |
|                                                            | snapshot/live race            | deferred to 2b (stated in the addendum)                                                                                                  |
|                                                            | restart                       | S4-ii reload fixture (minted sequence continues); guard unit (`unsupported` below head)                                                  |
|                                                            | multi-publisher tracks        | both cells use `sender` and `publisher-b`: two tracks, independent entries                                                               |
| Revocation and receipts preserve truthful outcomes         | hold repair, revoke, release  | `before-entry` outside class unit; WS outside-on-narrowing (`ws-room-granted-delivery.test.ts:158` replaced); relay fixture repair floor |
| No alternative publication path bypasses grants            | ordered release, repair       | `entered`/`omitted` release units; responder floors unchanged and pinned for a pending-token holder; S4-ii relay NACK path               |
| Cleanup and reconnect do not cancel or revive              | new generation                | S4-ii `subscription-ordered-reconnect` (omission, not loss); server fixture: generation change, same session                             |
| RTC distinguishes origin, recipient, and relay             | valid intermediate forwarding | relay observes nothing, forwards a track it never saw; a relay rewriting the record fails the proof                                      |

## 8. Mixed builds

- **Envelope.** An older page or server decoder refuses `ordering.priorSeqByRecipient` as `malformed`
  (`al-message-persistence-validation.ts:191-196`), as it refused `proof` (D514): during a deploy, recorded frames
  from new senders do not reach old receivers; unrecorded frames from old senders open at `1` on new receivers
  (S4-R4, record absent). The envelope version stays 4.
- **Controls.** An older receipt or NACK decoder meets `before-entry` as an unknown reason; the wire codec gives it a
  boundary default (`al-control-value-codec.ts:97-109` pattern) and `toNackReason` stays exhaustive.
- **Rows.** A newer api-v1 reading a subscription row that still carries `admittedAtGroupRevision` throws corruption
  (exact keys, `group-topic-subscription-codec.ts:23-42`); rows expire within the 120 s lease, so the deploy follows a
  two-minute quiet period or a drain. The memory profile keeps no rows. An older server refuses a newer subscribe
  body only if the body changes; it does not.
- **Stores.** Position rows are new keys in existing admission stores; an older node ignores them. The captured
  policy does not change. A sender upgraded before its receivers resumes minting from its head; a receiver upgraded
  before its sender treats unrecorded frames as today.
- **Peers.** An old RTC relay forwards a recorded frame unchanged (it never decodes `ordering` beyond the envelope
  check — if its decoder refuses the key, it drops the frame `malformed`, as for `proof`); an old receiver on a tree
  path still forwards nothing it refuses, so a recorded track crosses only upgraded relays during the deploy.

## 9. Risks and open questions

- **Durable head for volatile-lane messages (S4-R6).** The browser outbound store split chooses durability per lane;
  the head and position rows must outlive a volatile message. If the split cannot host it, ordered room sends are
  admitted on the durable lane; S4-i's first task decides.
- **Relic joiners (S4-R10).** Not verified from the code: whether `apps/relic-hunters-v1`'s join path reads the game
  state so that a joiner entering at `seq 2` of a round needs no `seq 1`. If it relies on the repaired transition,
  the join path reads the snapshot first.
- **Same-generation re-subscribe (S4-R8 (c)).** An unsubscribe and re-subscribe under one connection generation
  inside a row's deadline is one subscription for repair (`filter-granted-ws-recipient-session-ids.ts:39-59` keeps the
  session); a per-row subscription identity would close it. Proposed as accepted and documented.
- **WS browser-origin repair.** Whether the server's outbound serves a WS client's gap NACK on a relayed browser
  track (the NACK names the origin, the stored row's owner) is unpinned; S4-i pins it first, since S4-R7's "served
  from its entry" on `ws` rests on it.
- **Sender-side cost.** One read and write per frozen recipient per ordered send at both authorities, unmeasured;
  bounded by 256; §9 counters land in S4-ii, the measured envelope stays the fifth later outcome.
- **Receipt semantics (S4-R9)** changes D498's "stays expected ... unconfirmed" note; the maintainer confirms.
- **Lane time.** Three carriers at full scope already exceed the observation job's 30 minutes locally; the new cells
  add ≈ 1–1.5 min per carrier to the four-role family and nothing hosted.
