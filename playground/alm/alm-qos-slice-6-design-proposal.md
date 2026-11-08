# ALM publication QoS Slice 6 design proposal: granted unicast, list and principal broadcast over RTC (1a-i)

Slice 6 of the [publication QoS and pub/sub addendum](alm-publication-qos-addendum.md) (§5.1 "Admission and recipient
selection", §5.3 "RTC delivery, relaying, and confidentiality"; §7 "Later outcomes" first bullet, "granted unicast,
fixed-list and broadcast over RTC … is not yet carried"; §8 rows "No alternative publication path bypasses grants"
and "RTC distinguishes origin, recipient, and relay"), after S5-i (#793) and the addendum note #792. Written from the
candidates survey and the three read-only surveys in `.superpowers/sdd/slice-6/` of `alm-qos-slice-6` at
`f175bd1a6` (main), re-checked against the code, under the maintainer's ruling S6-C0 (Slice 6 = 1a-i; signed receipts
1a-ii, encryption 1b and native key custody 1c stay out; the postponed S5-i state-write comparison 6a runs as the
slice's first task; the C7 riders ride). Rulings taken 2026-11-08: the maintainer ruled S6-R1, S6-R2, S6-R3, S6-R4 and S6-R6 on (a), S6-R8 on (b), S6-R9 on (b)
(all four riders) and S6-R11 on two pull requests, one at a time; the controller settled S6-R5, S6-R7, S6-R10 and
S6-R12 on (a) as builder calls open to the maintainer's override (`.superpowers/sdd/slice-6/s6-planning-rulings.md`). Two resolve a survey conflict against a survey (S6-R1 against A's Q2.2 (a); S6-R2 against
A's Q2.1 (a) and against B's implementation of Q-B1 (a)). Slice 6 lands as two pull requests (S6-R11 as ruled): S6-i, the RTC shapes with the two outbound riders and the
documents, and S6-ii, the provenance writer and the PGlite statement-count helper. Decisions are
D551… in the roadmap's decision record, entered at the close; this file is deleted at S6-ii's close (§10.5).

## 1. The problem and the scope

Slice 3 made a granted room multicast ride RTC signed by its origin and frozen to the grant-narrowed audience (D512,
D518). Every other granted shape is refused `unsupported` before the freeze by one predicate,
`targets.mode === 'multicast'`, copied into the browser dispatch, and the facade never tries RTC for a granted unicast,
list or principal send under `rtc-with-ws-fallback`. #792 made granted fixed-list over RTC the directed delivery an
actor's application-paced play needs (A:893-896) and one of its two gating ALM dependencies (A:910-911), so the refusal
is now in the way. Beside it sits a pinned pre-existing defect: a granted audience past the 256-entry RTC room limit is
frozen before the limit is judged, the refusal keeps the frozen audience, and the planned message fails its own decode
as `failed`, never handed to WS.

**Scope (1a-i, S6-C0).** A granted publication whose sender names a fixed list, a room principal or one room peer rides
RTC under `rtc` and `rtc-with-ws-fallback`, frozen to the grant-narrowed audience and signed exactly as a granted room
multicast is; the room-limit bound is judged in the granted leg right after the freeze, so a fallback takes over; the
three copies of the shape gate become one predicate in the carrier. Receipts stay unsigned and relay-re-originated.

**Not in this slice.** Signed receipts (1a-ii); an encrypted publication (1b); a non-browser `PublicationKeyStore` (1c,
built with the actor's first outcome); an exclusions-only granted room broadcast on RTC (S6-R1); ordering on a peer
send (S6-R2); cross-instance positions and the fallback windows (2c-ii, 2c-iii); the provenance writer and the PGlite
statement-count helper (S6-R9); any envelope, control, receipt or server change; any hosted manifest (D505, D521).

## 2. Where Slice 3 leaves the granted shapes (facts)

`REF` = `packages/shared/multicast/publication/compute-rtc-granted-publication-refusal.ts`; `CAR` =
`packages/shared/multicast/publication/rtc-granted-publication-carrier.ts`; `ADM` =
`packages/shared/multicast/publication/compute-rtc-publication-admission.ts`; `FA` =
`packages/shared/multicast/web-rtc-overlay-frozen-audience.ts`; `MGR` =
`packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`; `FMA` =
`packages/shared/al-contracts/al-frozen-multicast-audience.ts`; `MSG` = `packages/shared-web/browser/messages`;
`SIG` = `packages/tests/shared/multicast/rtc-publication-signing.test.ts`; `GCH` =
`packages/tests/shared-web/messages/browser-granted-channel.test.ts`; `GR` =
`packages/shared-test/rallar-bb-test/conformance/alm/scenarios/granted-rtc/`; **A** = the addendum, **R** = the
roadmap, **B** = `plans/backlog.md`.

- **Target vocabulary.** `ALTargets` has three modes (`packages/shared/al-contracts/al-contract.ts:38-73`): `unicast`
  (`toPeerId`, optional `groupRef`), `multicast` (`groupRef`, floors, frozen `recipientPeerIds` + `snapshotVersion`
  "both or neither") and `broadcast` (`scope`, `principalRef`, `exceptPeerIds`, a fixed `recipientPeerIds`). The
  browser builds a **list** as a room broadcast carrying `recipientPeerIds` (WS:
  `MSG/browser-rallar-message-sender.ts:470-472`; RTC: `toRoomFallbackMessage` :566-579), capped at 1–256 distinct ids
  (`MSG/browser-message-input-validator.ts:357-366`); a **principal** send as a broadcast with `principalRef`
  (:576-577, :582-593); a **peer** send as a unicast naming its room (`MSG/create-browser-unicast-message.ts:48-80`),
  with no `exceptPeerIds`, `orderingKey` or `seq` (:125-136). The fourth room shape, `exceptPeerIds` and no list, is
  "narrowed" to the facade (`MSG/to-browser-message-send-defaults.ts:82-85`).
- **The gate, three copies.** Facade: `isBrowserWsOnlySend` sends every granted send to WS unless the strategy is `rtc`
  or `rtc-with-ws-fallback` _and_ the send is a plain room multicast (no `peerId`, no `world`/`principal` scope, no
  narrowing; `to-browser-message-send-defaults.ts:63-79`), applied at `browser-rallar-message-sender.ts:270-272` for
  every strategy but `rtc`. Dispatch: `readPublicationRefusal` applies the carrier's predicate to an RTC leg
  (`MSG/browser-rallar-message-dispatch.ts:344-345`). Carrier: `admitLeg` applies it first, before the snapshot read,
  the leader and signing checks and the freeze (`CAR:105-108`, freeze at :126); the plan-time
  `computeRtcGrantedPublicationRefusal` applies it to the sender's `original` at every stage (`REF:59-74`, via
  `CAR:267-278` and `MGR:801`). The predicate is `REF:41-43`, the text `notMulticast` (`REF:9`). `world`/`all`, a
  roomless principal and exclusive sends are refused for every send (`FA:71-84`, `MGR:793-797`). Pinned at
  `GCH:184-195` (peer send under `rtc-with-ws-fallback`/`ws-then-rtc` takes WS), `GCH:197-208` (peer send under `rtc`
  `rejected`), `SIG:215-236`, `SIG:238-259`, the refusal unit `:35-36,48-56,62-63` and the carrier unit `:43-51`.
- **The freeze already covers list and principal.** `toRtcAudienceNarrowing` reads a room principal or listed
  broadcast (`FA:54-65`), `isRtcUnfrozenRoomMessage` selects those, a leader broadcast and an unfrozen multicast
  (`FA:113-117`) — not a unicast, not an exclusions-only broadcast — and `toRtcFrozenRoomMessage` rewrites a broadcast
  to `mode: 'multicast'` with the frozen ids less `exceptPeerIds` and the `snapshotVersion`, dropping scope, list and
  `principalRef` from the wire (`FA:119-146`). `computeFrozenAudience` intersects the authorized sessions less self,
  the narrowing, the leader and `subscribeHolders` when non-null (`FA:41-52`). The granted leg passes
  `computeGrantedSubscribeHolders` as `subscribeHolders` (`CAR:111-113`, `MGR:377-380`); every other plan passes
  `null` (`MGR:762`). A listed session the room does not admit is dropped silently (outbound README :586-588).
- **Everything downstream assumes a frozen multicast.** The receiver's admission requires `mode === 'multicast'` with a
  `snapshotVersion` or refuses `unbound-target` → `unauthorized`, no NACK, no forward (`ADM:75-78`;
  `rtc-room-snapshot-admission.ts:186-190`), and reads the floor from it (`ADM:82-84`, :100); the proof signs the
  carried `targets` verbatim, after the freeze (`al-publication-proof.ts:216`; `CAR:135-148`), so a relay cannot
  widen the signed set (`CAR:252-256`); the signer refuses an unfrozen room message `unfrozen-audience`
  (`sign-rtc-publication.ts:46-51`); `deliversLocally` (`FMA:88-98`; `rtc-room-snapshot-admission.ts:272`), the
  receipt (`FA:220-232`), the empty-audience completion (`FA:246-264`), repair targets (`CAR:196`;
  `compute-rtc-repair-target-admission.ts:41-43`), positions (`to-rtc-sent-position-recording-plan.ts:10-17`) and a
  granted channel's `subscribe(handler)` (`MSG/browser-typed-message-channels.ts:151`) all read the frozen set. An
  RTC unicast travels one hop: its only owned child is `toPeerId` (`resolve-al-owned-child-peer-ids.ts:31-35`), it is
  planned directly (`MGR:832-834`), never forwarded (`MGR:563-565`) and skipped by the carrier-gap hand-over
  (`compute-rtc-outbound-carrier-availability.ts:118-124`).
- **Minting and the freeze order.** `admitLeg` freezes before the enqueue (`MGR:377-380`); the admission plan mints
  after it, on the frozen plan (`MGR:770`), and only a room-audience send naming `ordering.orderingKey` mints
  (`to-al-outbound-minting-plan.ts:8-14`). The enqueued leg is the frozen message, so the outbound's request-to-canonical
  comparisons (`toALFreezeComparableMessage`, `FMA:43-65`; `al-outbound-canonical-message.ts:205`;
  `validate-al-outbound-dispatch.ts:87`) never see a unicast original.
- **Fallback.** A refused leg names the sender's message: `enqueueLegIfAbsent`'s Left and every fallback verdict return
  `message: msg` (`MGR:382-390`), re-admitted on WS (`browser-rallar-message-dispatch.ts:194-203`); after admission
  (D56) the WS leg carries the frozen copy (`admittedCopy`, :258-279). The WS server narrows a frozen set and never
  widens (`FMA:88-98`); its granted audience is authorized room ∩ narrowing ∩ principals holding `subscribe` ∩ a live
  subscription (`compute-room-publication-admission.ts:59-89`), a named non-holder absent; a room unicast outside that
  audience is refused `unauthorized` with a NACK (`to-ws-queue-box-server-addressee-authorization.ts:12-38`).
  `no-route`, `unsupported` and `congested` are fallback triggers (`resolve-al-delivery-fallback-trigger.ts:16,26-27`).
  `ws-then-rtc` keeps granted messages on WS (D519 PL23; `GCH:172-182`).
- **The room-limit defect.** `computeRtcFrozenAudienceRefusal` refuses a frozen set past
  `AL_MESSAGE_RESOURCE_LIMITS.collectionEntries` (256) as `unsupported` (`FA:155-171`), sixth in the origin chain
  (`MGR:814`). A granted leg is frozen in `admitLeg` already, so `toUnfrozenRoomMessage` keeps the oversized audience
  (`FA:199-202`) and the dispatch validator's decode fails → `AL collection exceeds the entry limit` → `failed`
  (`validate-al-outbound-dispatch.ts:24,74-77`); pinned "Pre-existing" at `SIG:276-296` (:289-290), documented at the
  outbound README `:621-630`. A list (≤256 at the validator, frozen ⊆ list) and a unicast cannot reach the bound; a
  room multicast and a principal broadcast can (`web-rtc-overlay-frozen-audience.test.ts:478`).
- **Live stream key.** `toALPublicationStreamKey` includes the sorted list, `toPeerId` and `principalRef`, computed
  before the carrier freezes (`to-al-publication-stream-key.ts:3-8,27-28`), so member lists stay separate streams.
- **Consumers.** No app sends granted or listed messages (git grep over `apps/*/src`: none). The actor names "a group
  and a member list for each live payload"; unnamed members do not receive it, relaying is distinct from delivery
  (`plans/active/rallar-actor.md:338-344,370-372`): session-id lists and `principal` scope serve it; a unicast is the
  list of one.
- **Harness.** Nine `granted-rtc` cells over `rtc` (`GR/granted-rtc-commands.ts:46`), all `FULL_TAGS`, shape pinned at
  `packages/tests/shared-test/alm-conformance-granted-rtc.test.ts:143-158` and
  `alm-conformance-recipe-validation.test.ts:126-151`; hosted entries pass `principalIdsByRole: {}` so no granted cell
  runs hosted (`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:206-218`; two-agent cells withheld
  at `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts:200-208`); the observation job runs
  `smoke` by default (`.github/workflows/alm-conformance-observation.yml:10-13`; `branch-release-gate.yml:188`). A send
  names one listed recipient by lane role (`recipientPeer`, `rallar-black-box-test-contracts.ts:390-395`, one id at
  `black-box-rallar-delivery-ledger.ts:239-248`, `receiver` the leader among several) and one addressee by
  `toPeer: 'server' | 'receiver'` (:413), resolvable only with exactly one other live session
  (`resolve-black-box-rallar-message-peer.ts:34-50`); `toPublishUntilConfirmedCommands` takes no audience
  (`topic-subscription-publications.ts:35-49,91-96`).
- **Sizes, dispositions, budgets.** `FA` 264 lines, **11** runtime exports (12 is the split review); `REF` 74, 4; `CAR`
  323, 1; `ADM` 130, 1; `MGR` 1,289 with `file.cognitive-load` registered at exactly 119, further growth
  undispositioned (`scripts/repo-style-check/reviewed-browser-dispositions.mjs:234-242`); rider files
  `al-outbound-admission-reads.ts` 65 and `al-outbound-admission-store.ts` 58 (`reviewed-dispositions.mjs:2253-2256,
  61-64`). Budgets: `browser/rallar.ts` 298 KiB (`packages/shared-web/bundle-budgets.json:2`, ≈0.1 KiB headroom),
  headless 394 (`headless-bundle-budget.json:2`, 393.02 recorded); every touched multicast file loads into
  `rallar.ts`. The medium-scale gate runs on any `packages/shared/**` change (`api-v1-medium-scale-gate.yml:6-12`).
- **Riders (C7).** `writeALOutboundTrackIndexEnd` discards the store's answer and logs a throw to the console
  (`write-al-outbound-track-index-end.ts:63-81`, :75, :79); the store answers
  `'deleted' | 'absent' | 'other-message' | 'conflict'` (`al-outbound-admission-store.ts:736-760`) and reads the index
  key through the public generic `reads.readValue` (:739, :746; `al-outbound-admission-reads.ts:704-711`, also used
  at `:380-381`, `:444-445`). The four PGlite statement-count spies sit in tests 1a-i never touches.

## 3. Decisions (proposed)

### S6-R1. Which shapes the granted RTC leg carries (Q1.2, A5, Q-B3; resolves A against B)

- **(a) Recommended: a fixed list, a room principal broadcast and a room unicast — every room shape the origin
  freezes to a grant-narrowed multicast — and nothing else.** List and principal already freeze (`FA:54-65,119-146`);
  the unicast freezes per S6-R2. The exclusions-only room broadcast stays refused: nothing freezes it today
  (`FA:115`), it is pinned refused (`SIG:215-217`), and carrying it means a granted term inside
  `isRtcUnfrozenRoomMessage` or its three callers (`FA:97`, `sign-rtc-publication.ts:46`,
  `compute-rtc-outbound-carrier-availability.ts:94`) for a shape with no consumer; the actor names members, never
  exclusions. `world`/`all`, a roomless principal and an exclusive send stay refused for every send (`FA:71-84`,
  `MGR:793-797`). **Resolved against A's Q2.2 (a)** (freeze it on the granted leg via a `subscribeHolders !== null`
  term): the term changes a general predicate for a shape nobody sends, and the refusal costs the sender one
  `unsupported` the fallback takes over, as the leader refusal does today. B's Q-B3 (a) agrees.
- (b) Also freeze the exclusions-only room broadcast on the granted leg. One more branch in the general freeze, one
  more frozen-audience test, no consumer.
- (c) List and principal only, unicast stays WS (A's Q2.1 (c)). Keeps a shape clause in the facade and `rejected` for
  a granted `send({ peerId })` under `rtc`.

**Cost if wrong:** (a) leaves one refusal text where B hoped for none; an application excluding one session from a
granted room send over RTC names the rest as a list instead.

### S6-R2. Unicast on the wire (Q2.1, Q-B1; resolves A against B)

- **(a) Recommended: frozen in the granted leg as a one-recipient multicast, by translating the room unicast into
  the one-entry listed room broadcast the existing freeze already handles.** A pure
  `toRtcGrantedListedLeg(msg)` in `multicast/publication/` turns `{ mode: 'unicast', toPeerId, groupRef }` into
  `{ mode: 'broadcast', scope: 'room', groupRef, recipientPeerIds: [toPeerId] }` and leaves every other message as it
  is; `admitLeg` applies it before `toAdmittedMessage`, so `toRtcAudienceNarrowing`, `computeFrozenAudience` and
  `toRtcFrozenRoomMessage` freeze it as they freeze a list, to `[toPeerId] ∩ subscribeHolders` at the snapshot's
  version. On the wire it is a frozen, signed multicast of one: relays forward it along the tree (`MGR:555-592`),
  receivers admit it unchanged (`ADM:75-78`), `subscribe(handler)`'s filter holds (`:151`), the receipt expects the
  addressee alone (`FA:220-232`), repair is bounded by it (`CAR:196`) and nothing in `ADM`, the proof or `FMA`
  changes. **Against A's Q2.1 (a)** (a direct signed unicast with a new signed `snapshotVersion` and an `ADM` branch):
  it changes a wire contract and every receiver and relay for one shape, and A's three costs of freezing are smaller
  than they read: (i) relay visibility is what D520 accepts for every granted RTC publication (A:427-433); (ii) no
  sequence is minted — the facade refuses `orderingKey`/`seq` on a peer send
  (`create-browser-unicast-message.ts:125-136`) and minting needs a key (`to-al-outbound-minting-plan.ts:13`); the
  refusal stays (B's Q-B4 (a)), since an ordered unicast would ride the publisher's room track and make every other
  recipient's next copy an omission; (iii) WS receives the sender's unicast at an admission-time fallback
  (`MGR:382-390`) and the frozen one-recipient multicast only after admission (D56, :258-279), exactly as a list is
  handed over today. **Against B's implementation** (an extension to `toALFreezeComparableMessage`, `FMA:43-65`): the
  outbound never sees the unicast original, since the enqueued leg is the frozen message, so no comparison reader
  changes and `FA` keeps its 11 exports. Unrestricted unicasts keep their one-hop path (`MGR:832-834`).
- (b) A direct signed unicast (A's (a)): `targets.snapshotVersion` on room unicasts, an `ADM` unicast branch, a
  repair target of `[toPeerId]`, a widened `subscribe` filter, new proof and verifier cases. (c) Unicast stays WS-only
  this slice (S6-R1 (c)).

**WS parity consequence:** a granted unicast over RTC is relayed, receipted and repaired as a multicast of one; its
non-holder outcome is S6-R3's. **Cost if wrong:** (a) spends tree hops on a message WS and unrestricted RTC send
directly; in return a recipient reachable only through relays becomes reachable, which (b) would not give.

### S6-R3. A named non-holder (Q1.3, Q5.1, Q5.2, Q-B5)

- **(a) Recommended: frozen out silently before signing, for list, principal and unicast alike — one rule, no shape
  branch.** This is what the WS server does for a granted topic (`compute-room-publication-admission.ts:73-88`) and
  what a room multicast's non-holder gets today (`FA:47`; D518: not expected, not outside, silent). An audience frozen
  to `[]` behaves as an origin alone in its room: under `receiver` the receipt of zero recipients completes at once
  (`FA:241-264`), which §5.1 permits — "an empty audience is reported with recipient count zero; a completed receipt
  for zero recipients is not labelled as consumer processing" (A:365-368); under `none` the plan drops `no-route`, a
  fallback trigger, so WS answers a unicast to a non-audience addressee `unauthorized`
  (`to-ws-queue-box-server-addressee-authorization.ts:28-37`) _(inferred from `FA:252-253` and the trigger list)_. The
  stated divergence from WS: a receipted RTC unicast to a non-holder reads `acknowledged` with zero recipients where
  WS reads `rejected`.
- (b) Refuse the whole send when a listed recipient holds no `subscribe`: punishes a list for one stale entry and
  differs from WS, which drops the name silently. (c) Refuse only a unicast frozen to nobody as `unsupported` before
  signing (A's Q5.2 (a)), so the fallback reaches WS's `unauthorized` and `rtc` alone ends `rejected`: WS parity for
  1:1 sends at the price of a shape branch after the freeze and a refusal word that names a carrier limit, not an
  audience.

**Cost if wrong:** (a) lets a `receiver` unicast complete to nobody; an application needing one consumer declares it
(A:368-369), and S6-R8's non-holder cell pins the count.

### S6-R4. The room-limit order fix (Q1.4, A3, Q3.1)

- **(a) Recommended: judge the bound in `admitLeg` right after `toAdmittedMessage`, reusing
  `computeRtcFrozenAudienceRefusal`, and return its reason as the existing Left.** `admitLeg` folds
  `computeRtcFrozenAudienceRefusal(admitted, msg)` to `Either.ofLeft(refusal.dropReason)`, so the sender's leg is
  named (`MGR:382-387`), the verdict is `refused/unsupported` and the fallback takes over; the plan-time check
  (`MGR:814`) stays for unrestricted sends. No new export, no manager change (its 119 is registered exact); the reorder
  sits beside the leader and signing refusals (`CAR:115-127`). It is reached by a granted room multicast and a
  principal broadcast, never by a list or a unicast. The `SIG:276-296` pin is rewritten (S6-R8); the README's exception
  sentence (:627-630) is deleted.
- (b) A new pure `resolveRtcFrozenAudienceLimitRefusal(targets)` in `FA`, shared by both callers: the 12th export and a
  split review of `FA` for one predicate.
- (c) A separate pull request. A second gate run for a change inside the same `admitLeg` the slice rewrites.

**Cost if wrong:** (a) reads a plan-returning function for its reason, which a reader must follow once.

### S6-R5. Which gates are deleted (B1, A1)

- **(a) Recommended: delete the dispatch copy and the facade's shape clause; the carrier keeps the one predicate,
  rewritten.** `readPublicationRefusal` keeps the room and `no-publish-grant` advisories and drops :344-345;
  `isBrowserWsOnlySend` becomes "an exclusive send, or a granted send under `ws-then-rtc`" (`:63-73`),
  `isBrowserRoomMulticastSend` goes, `isRallarRoomNarrowedAudience` stays for `toRoomFallbackMessage`.
  `resolveRtcGrantedPublicationShapeRefusal` (`REF:41-43`) judges S6-R1's shapes in `admitLeg` before the freeze (as
  today) and at plan time on `original` (`REF:63`), where an unfrozen original arrives only through `enqueueIfAbsent`
  (`SIG:238-259` keeps refusing a proof-carrying broadcast). An exclusions-only granted send under
  `rtc-with-ws-fallback` then tries RTC, is refused and reaches WS, as a leader-not-subscribed send does today: one
  owner, the strategy decides.
- (b) Keep the facade routing the exclusions-only shape straight to WS: spares one refused RTC attempt and keeps a
  second shape predicate in `shared-web`. **Cost if wrong:** (a) adds one carrier-refused evidence fact to a shape no
  consumer sends.

### S6-R6. Strategies (Q-B2)

- **(a) Recommended: `rtc` and `rtc-with-ws-fallback` carry the new shapes; `ws-then-rtc` keeps granted messages on
  WS** (D519 PL23; `GCH:172-182`; `MGR` and the sender's `ws-then-rtc` peer refusal :273-280 unchanged). The strategy
  table after the slice: granted peer/list/principal/plain room send start on RTC under `rtc` and
  `rtc-with-ws-fallback`; `world`, exclusive, exclusions-only and `ws-then-rtc` take WS.
- (b) Let `ws-then-rtc`'s RTC fallback carry granted shapes: reopens D519 for no consumer.

### S6-R7. Where the freeze decision lives, owners and exports

- **(a) Recommended: the carrier.** `admitLeg` translates (S6-R2), freezes and judges the bound (S6-R4); pure functions
  in `multicast/publication/`: `to-rtc-granted-listed-leg.ts` (new, ~20 lines, 1 export) and the rewritten `REF`. The
  live stream key, computed before the freeze (`to-al-publication-stream-key.ts:3-8`), keeps member lists apart. `FA`
  stays at 11 exports and `MGR` at its exact 119; `ADM` and `FMA` are untouched. `CAR` grows by about 15 lines
  (323 → ~340, below the 1,200 backstop; its cognitive load is re-measured by the changed-style check).
- (b) The facade decides and freezes. Moves an RTC audience decision out of the carrier and ahead of the stream key.

### S6-R8. How is it proven (C part 1, Q1.a–Q1.c)

- **(a) Recommended. Blocking:** refusal unit — "carries a first admission's unicast, room list and principal
  broadcast in its room unsigned, which its admission signs after the read", "refuses an exclusions-only room
  broadcast, a world broadcast and a roomless principal broadcast as unsupported", "refuses a stored list or unicast
  without a proof as unsigned" (replacing `:35-36,48-56,62-63`); carrier unit — "admits a granted unicast and a
  granted list leg for the shape its sender gave" (replacing `:43-51`), "refuses a granted leg whose frozen audience
  passes the RTC room limit as unsupported after the freeze"; a `to-rtc-granted-listed-leg` unit; `SIG` — "freezes a
  granted list to the listed sessions that hold subscribe, a listed non-holder left out, before it signs", "freezes
  and signs a granted unicast as a one-recipient multicast its receipt expects alone", "admits a granted unicast to a
  non-holder as a complete receipt of zero recipients", "freezes a granted principal broadcast in its room to that
  principal's subscribing sessions", `:276-296` rewritten as "refuses a granted send whose narrowed audience passes the
  RTC room limit as unsupported before it signs, handing over the targets its sender gave" plus "still signs a granted
  send to a narrowed audience of 256"; `:215-236` keeps its exclusions case alone; relay fixture
  (`rtc-relay-not-subscribed.test.ts`, origin describe :434) — "signs a receipted granted list at its origin, a listed
  holder without an election recorded outside, an unlisted subscriber receiving nothing"; browser — `GCH:184-208`
  rewritten as "a peer-addressed send under rtc and rtc-with-ws-fallback is admitted on RTC carrying its origin's
  proof, frozen to the peer", "a listed send under rtc-with-ws-fallback is admitted on RTC, not WS", "a peer-addressed
  send under ws-then-rtc is refused", and `to-browser-message-send-defaults.test.ts` re-pinned to the new table.
  **Observed, local full-scope lane only:** `granted-rtc-unicast-delivered` (two-agent, `toPeer: 'receiver'`,
  `ack: 'receiver'`: RTC copy, expected 1 confirmed 1 outside 0; added to the hosted withheld list),
  `granted-rtc-list-delivered` (three-agent: recipient-b subscribed and elected but unlisted, expected 1, absent) and
  `granted-rtc-list-non-holder` (three-agent: list names receiver and recipient-b, recipient-b `publish` only:
  expected 1, outside 0, absent — frozen out, unlike `-not-subscribed`'s frozen-in holder), before the two relay
  cells. Harness: `TopicPublicationInput` gains an `audience` (`toPeer` | a list by principal role, resolved by the page
  to that principal's live sessions, C's Q1.a (a)) threaded into `toGrantedSend`. The principal broadcast is proven by
  units and the frozen-audience test only (C's Q1.c (a)); the room limit by units only.
- (b) Also a same-principal granted cell and a `recipientPeers` lane-role list through the leader rule, the resolver
  risk C names, for a shape whose mechanism the units already cover. **Ruled (b) by the maintainer, 2026-11-08:** the
  three cells of (a) and these two are all observed evidence on the local full-scope lane.

### S6-R9. Riders (Q7.1, Q5.1, Q7.2; C part 2)

- **(a) Recommended: two riders, one owner each.** (1) A `track-index-end` outbound diagnostic
  `{ msgId, trackKey, seq, outcome: 'deleted' | 'absent' | 'other-message' | 'conflict' | 'failed' }` plus the message
  trace, written through `writeALOutboundRuntimeDiagnostic` for every non-`deleted` answer and a thrown end;
  `writeALOutboundTrackIndexEnd` takes one named input `{ store, msg, cause, diagnostics }`; `conflict` is reported,
  not retried; the two console-spy pins move (`write-al-outbound-track-index-end.test.ts:156-169`,
  `ws-queue-box-server-ordered-repair.test.ts:534-545`); B:238-241 deleted. (2) `readOrderingMessageId(session,
  trackKey, seq)` on the reads class, used at `:380-381`, `:444-445` and the store's `:739,746`; `readValue` private
  again; read count unchanged; reads at ≤65. The PGlite spy waits for a slice touching its tests (C's Q7.2 (a)); the
  provenance writer stays backlog.
- (b) All four hygiene items. The spy's owner tests are untouched here, and the writer is six AppInbox transactions.
  **Ruled (b) by the maintainer, 2026-11-08:** the diagnostic and the rename ride S6-i; the provenance writer and the
  PGlite statement-count helper form S6-ii (S6-R11).
- (c) No riders. Leaves the two carries another slice.

**Cost if wrong:** (a) touches `packages/shared/alm/outbound`, so the medium-scale gate is run by path anyway (§6).

### S6-R10. Gates (§6; 6a)

- **(a) Recommended.** `test:unit`, `typecheck`, `typecheck:tests`, changed style and the coupling registry, test
  reachability, `check:browser-bundles`, `shared-web-public-api-snapshots.test.ts` and
  `shared-web-browser-bundle-boundaries.test.ts` (no export is added; run them), the headless budget, the ALM
  conformance observation (non-blocking; the new cells are full-only); `rallar.ts` 298 → 299 if measured over 298
  (B: +0.1–0.25 KiB against ≈0.1 headroom), headless 394 measured, both figures in the PR body (the standing rule).
  Medium-scale and the games gate run by path only; neither is doctrine-required. **6a:** the comparison already
  dispatched (commit `7b0052fcc` on `claude/s5i-state-write-measurement`, run 42463690911) is reported in the PR body
  as guidance (R:600), with the index row's CTE as the recorded reason if `sql.rowsRead` or
  `sql.serializedResultBytes` moved (C §10); nothing in S6-i depends on it.
- (b) Skip the bundle-boundary and snapshot tests since no export changes. CLAUDE.md asks for them on any shared-web
  public-surface change; the facade's documented behaviour changes.

### S6-R11. How does it land

- **(a) Recommended: one pull request, S6-i.** The translation, the rewritten predicate, the reorder, the two deleted
  gates and the facade clause, the pins, the fixture case, the three cells and their harness audience, the two riders,
  the documents, this file's deletion. The riders are three files and two tests with no behaviour change; they do not
  push the PR to two.
- (b) Two: S6-i the carrier and browser, S6-ii the cells, riders and documents: a second gate run for the smaller half.
  **Ruled two pull requests by the maintainer, 2026-11-08, split by write path:** S6-i is the RTC shapes, the
  room-limit fix, the cells and harness audience, the `track-index-end` diagnostic, `readOrderingMessageId` and the
  documents; S6-ii is one writer for the `ws-outbox-provenance` sidecar and the shared PGlite statement-count helper,
  with the medium-scale gate and a state-write measurement of its own.

### S6-R12. Documents at the close (C §4)

- **(a) Recommended.** Addendum: the status header (A:3-8) names Slice 6 (as S6-i); a "### Slice 6: granted unicast,
  list and principal broadcast over RTC" section between A:886 and "### Later outcomes" (A:888), shaped as Slice 5's,
  with "As applied (S6-i)" written at the close and the limits (exclusions-only refused; receipts unsigned; the
  non-holder unicast's zero-recipient receipt; cells local-lane only); the first "Later outcomes" bullet loses "granted
  unicast, fixed-list and broadcast over RTC" and the "is not yet carried" sentence (A:893-896), the actor bullet
  loses fixed-list (A:910-911); §8 row 944 stays, with a Slice 6 evidence sentence after Slice 5's paragraph. Roadmap:
  R:4 `Revised:`; the release-map prose (R:750-761) and a row `| 13 Restricted RTC II | S6-i Granted unicast, list and
  principal broadcast over RTC | medium | 1, 6, 7 |` after R:794; a "### Release 13, Slice 6 design" section after
  R:1882 shaped as Release 12's; D551–D562; "As applied (S6-i)" notes on D518 (R:545), D519 (R:546), D521 (R:548) and
  D523 (R:550); the "Continuing from a fresh session" paragraphs (R:2162-2181) and one revision-history entry. Outbound
  README: the room-limit paragraph (:621-630) loses its exception, the granted-narrowing paragraph (:592-600) names
  list, principal and unicast, "Addressed sends on RTC" (:988-991) gains the granted sentence. Backlog: delete
  B:158-161 and B:238-241; keep B:142-146, B:147-149, B:150-157, B:162-163, B:253-256.
  `docs/rallar-api-reference.md:1095-1119` and `playground/alm/alm-complete-product-description.md:284-285,361-363`
  stop saying RTC carries granted multicasts only; `schema-and-capabilities.md:573-621` gains three cell bullets; the
  comments at `CAR:264`, `REF:9,53-58`, `to-browser-message-send-defaults.ts:59-62` and
  `browser-rallar-message-sender.ts:259-264` follow the code. This file is deleted.
- (b) Also a granted-shapes section in the WS queue-box server README. The server does not change.

## 4. Contracts (S6-i), sketched

```ts
// packages/shared/multicast/publication/to-rtc-granted-listed-leg.ts (new)
/** A granted room unicast as the one-entry listed room broadcast the origin freezes; any other message unchanged. */
export function toRtcGrantedListedLeg(msg: ALMessage): ALMessage;
//   { mode: 'unicast', toPeerId, groupRef } -> { mode: 'broadcast', scope: 'room', groupRef, recipientPeerIds: [toPeerId] }

// compute-rtc-granted-publication-refusal.ts: notMulticast -> unfrozenAudience ('RTC carries a granted publication
//   only as an audience its origin freezes: a room multicast, a listed or principal room broadcast, or a room unicast.')
export function resolveRtcGrantedPublicationShapeRefusal(msg: ALMessage): string | undefined;
//   undefined for a multicast, a room broadcast with recipientPeerIds or principalRef in its room, a unicast naming its room

// rtc-granted-publication-carrier.ts admitLeg, in order:
//   shape refusal (sender's targets) -> snapshot, subscribeHolders, leader refusal, signing refusal (as today)
//   -> admitted = toAdmittedMessage(toRtcGrantedListedLeg(msg), subscribeHolders)
//   -> computeRtcFrozenAudienceRefusal(admitted, msg).fold(r => Either.ofLeft(r.dropReason), () => Either.ofRight(admitted))

// shared-web: to-browser-message-send-defaults.ts
export function isBrowserWsOnlySend(input): boolean; // exclusive, or granted under 'ws-then-rtc'
// browser-rallar-message-dispatch.ts readPublicationRefusal: room and no-publish-grant advisories only

// Sender targets -> frozen multicast on the wire (groupRef, floors kept; scope, list, principalRef, toPeerId dropped):
//   list      { broadcast, room, groupRef, recipientPeerIds: L }     -> { multicast, groupRef, recipientPeerIds: L ∩ holders ∩ live \ except, snapshotVersion }
//   principal { broadcast, principal, groupRef, principalRef }       -> { multicast, groupRef, recipientPeerIds: P's sessions ∩ holders \ self, snapshotVersion }
//   unicast   { unicast, toPeerId, groupRef }                         -> { multicast, groupRef, recipientPeerIds: [toPeerId] ∩ holders, snapshotVersion }

// harness (packages/shared-test/rallar-bb-test): TopicPublicationInput.audience?: { toPeer: 'receiver' } | { recipientPrincipals: readonly string[] }
// riders: ALOutboundRuntimeDiagnosticsEvent | { kind: 'track-index-end'; msgId; trackKey; seq; outcome; ...trace }
//         writeALOutboundTrackIndexEnd({ store, msg, cause, diagnostics }): Promise<void>
//         ALOutboundAdmissionReads.readOrderingMessageId(session, trackKey, seq): Promise<string | undefined>
```

## 5. Dataflow and failure vocabulary

1. **Facade.** A granted `send` with `peerId`, `recipientPeerIds` or `principalId` under `rtc` or
   `rtc-with-ws-fallback` starts on RTC; `ws-then-rtc`, `world` and exclusive sends go to WS. The live stream key is
   computed here, on the sender's targets.
2. **Dispatch.** The room and `no-publish-grant` advisories; no shape judgement.
3. **Carrier (`admitLeg`).** Shape refusal on the sender's targets → snapshot, holders, leader, signing refusals →
   translate a unicast to a list → freeze to the grant-narrowed audience → room-limit refusal on the frozen count →
   the frozen leg is enqueued; its first admission signs it after the read. Every Left names the sender's leg and is
   `refused/unsupported`, which the fallback takes over and `rtc` alone settles `rejected`.
4. **Relays, receivers, receipt.** As for a granted room multicast (D518): expected = the frozen set, outside =
   `not-subscribed` answers; an empty frozen set under `receiver` completes at once with zero recipients, under `none`
   it drops `no-route` and falls back.
5. **Fallback.** At admission WS receives the sender's message and judges it by its own authority; after admission it
   receives the frozen copy and narrows, never widens.

| Code / status                                  | Lives in                                         | Raised when                                                              |
| ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `unsupported` (`unfrozenAudience`)             | `REF`, `admitLeg` Left and the plan refusal      | an exclusions-only, `world`, `all` or roomless shape on a granted send   |
| `unsupported` (room limit)                     | `FA` reason, returned by `admitLeg` after freeze | the frozen audience exceeds 256; the sender's leg handed to the fallback |
| `unsupported` (`leaderNotSubscribed`, signing) | unchanged                                        | unchanged                                                                |
| zero-recipient complete receipt                | `toRtcEmptyAudienceDispatchPlan`, existing       | a list, principal or unicast frozen to nobody under `receiver`           |
| `no-route`                                     | existing planner drop, a fallback trigger        | the same under `none`                                                    |
| `unauthorized` (WS addressee)                  | WS server, existing                              | the fallen-back unicast names a session outside the WS audience          |
| `track-index-end` (rider)                      | `ALOutboundRuntimeDiagnosticsEvent`              | an index end answers other than `deleted`, or throws                     |

Every expected failure is a value; nothing new throws.

## 6. Slicing, deliverables, validation

**S6-i** (S6-R1–S6-R12 less the provenance writer and the PGlite helper, which are **S6-ii** with the medium-scale
gate and a state-write measurement of its own). Shared multicast: `to-rtc-granted-listed-leg.ts`, the rewritten `REF`, the
`admitLeg` order with the room-limit Left. Shared-web: the facade clause and the dispatch copy deleted, comments and
contract docs. Tests per S6-R8, riders per S6-R9, documents per S6-R12, this file deleted. Gates per S6-R10, each
reported as passed, failed or skipped; 6a's verdict reported. No OpenAPI, recipe or row-shape change, so no black-box
API recipe is added; hosted manifests unchanged (D505).

## 7. Requirement-to-evidence (addendum §8)

| Row                                             | Evidence item                            | Pin / cell                                                                                        |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No alternative publication path bypasses grants | list over RTC, grant-narrowed            | `SIG` list freeze; fixture origin case; cell `granted-rtc-list-delivered`                         |
|                                                 | named non-holder                         | `SIG` non-holder left out; cell `granted-rtc-list-non-holder` (expected 1, outside 0)             |
|                                                 | unicast over RTC                         | `SIG` one-recipient freeze; `GCH` peer send admitted on RTC; cell `granted-rtc-unicast-delivered` |
|                                                 | both fallback directions                 | `GCH` rtc-with-ws-fallback list; `SIG` room limit handed over with the sender's targets           |
| RTC distinguishes origin, recipient, and relay  | relay forwards a list it is not named in | fixture: unlisted subscriber receives nothing; relay proof tests unchanged (wire-identical)       |

## 8. Mixed builds

- **Wire.** Nothing new: a frozen list, principal or unicast is a signed multicast an older receiver already admits;
  the envelope stays version 4, no new control, reason or proof field.
- **Pages and server.** An older page sends a granted list or unicast over WS, a newer one over RTC; an older origin's
  oversized granted send still ends `failed`, a newer one falls back. The server is untouched and narrows a frozen set
  from either generation.

## 9. Risks and open questions

- **The leg's enqueued shape (S6-R2).** That the leg's dedupe and the stored canonical are keyed by `msgId`, so the
  translation changes no identity, is _(inferred)_ from `MGR:373-392`; S6-i's first unit pins a replayed unicast as a
  duplicate.
- **A pending room authority (S6-R2, S6-R4).** When the carrier is `pending`, `admitLeg` freezes nothing; the first
  admission's signer refuses an unfrozen room message (`sign-rtc-publication.ts:46-51`) and the fallback takes the
  sender's leg, so the room-limit check never runs there and the plan-time check (`MGR:814`) keeps today's `failed`
  path for a freeze in the carrier-gap window _(inferred)_; S6-i decides whether to judge the bound there too
  (`compute-rtc-outbound-carrier-availability.ts:87-99`).
- **`CAR`'s cognitive load** after the translation and the reorder is unmeasured; **bundle headroom** is ≈0.1 KiB, so
  the raise to 299 is expected and the headless 394 likely holds.
- **Harness list resolver (S6-R8).** A list by principal role is new `black-box-runner` surface: the decoder
  (`decode-black-box-rallar-message-send-input.ts:59-62`) and the ledger (`:239-248`) both change. **6a's verdict** is
  not yet read; a comparison straddling #794's toolchain change is re-dispatched from a pre-#794 ref (C §11).

## 10. S6-ii design: one writer for the provenance sidecar, the batched outbox loops, the PGlite statement recorder

From survey D (`.superpowers/sdd/slice-6/survey-provenance-and-spy.md`), re-checked at `46cb23c13`. `AOI` =
`packages/shared-server/rallar-system/app-outbox/app-outbox-insert.ts`, `ATI` = `.../app-outbox-track-index.ts`, `PV`
= `.../websocket/outbox/ws-outbox-provenance.ts`.

### 10.1 Rulings (taken 2026-11-08)

- **S6ii-R1 → (a), a second sidecar row on `AppOutboxInsert`, in the one existing CTE.** The index insert is already
  the proof's SQL (`ATI:60-73` against `auth-logout-provenance.ts:77-87`): same columns, conflict clause and revision
  bump, so a proof is one more recordset row, matched on `store_key` (the namespaces differ). The exact-shape check is
  **validate** — pure recomputation and exact comparison, a verdict, never a value — and never inside the write; the
  write's first statement is the operation's own conditional guard, then the one CTE inserts what compute produced.
- **S6ii-R2 → (a), the six raw inserts and the authorised-connect batch effect fold.** The ~10 view-invalidation
  producers stay on their guarded batch (`guarded-view-publication.ts:42-67`), where an unapplied proof is a retried
  `RuntimeStateWriteConflictError` (:58-66); that class (Q-D3) becomes a backlog line, not a behaviour change here.
- **S6ii-R3 → (a), one conflict rule, absent-or-expired.** Relic's `do nothing` (`compute-relic-game-publications.ts:220`,
  #708 beside V1d's #698, _(inferred)_ an accident) makes an expired proof a non-retryable corruption; D541's rule.
- **S6ii-R4 → (b), the CRDT, presence-summary and topology per-row loops batch into one shared insert per commit**
  (`psql-crdt-mutation-repository.ts:150-152`, `group-presence-summary-worker.ts:310-312`,
  `write-rtc-topology-publication-transaction.ts:119-121`), so their 2N statements become 1, not N.
- **S6ii-R5 (controller) → Q-D6 (a), a raw-PGlite `recordPGliteStatements`** beside
  `create-p-sql-admission-test-storage.ts`, replacing the four private copies: it sees autocommit `raw.query`,
  `raw.exec` and BEGIN/COMMIT, which the `PSqlSql` wrappers cannot. The two existing recorders stay for their own
  subjects. It lands as S6-ii's first commit, before the pins move.

### 10.2 Contracts, sketched

```ts
// app-outbox/app-outbox-sidecar.ts (new): AppOutboxTrackIndexRow renamed, no alias; ATI:60-73's SQL moved unchanged
export interface AppOutboxSidecarRow {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expiresAt: string;
}
export function toAppOutboxSidecarInsert(rows: readonly AppOutboxSidecarRow[]): PSqlFragment;
// AOI: both required, null unless the row is ordered / proved; compute encodes the proof (PV:76-94), expiry as a pg timestamp
export interface AppOutboxInsert {
    /* …as today… */ readonly trackIndex: AppOutboxSidecarRow | null;
    readonly provenance: AppOutboxSidecarRow | null;
}
export interface ComputeWsOutboxInsertInput {
    readonly entry: ResourceEntry;
    readonly admissionNamespace: string;
    readonly provenance: WsOutboxProvenanceFacts | null;
}
export interface WsOutboxProvenanceFacts { // PV: ComputeWsOutboxProvenanceRecordInput less `entry`; the producer's authorised target
    readonly message: ALMessage;
    readonly producerKind: WsOutboxProvenance['producerKind'];
    readonly target: WsOutboxProvenance['target'];
    readonly expiresAtMs: number;
}
export function computeWsOutboxInsert(input: ComputeWsOutboxInsertInput): AppOutboxInsert;
// AOI: replaces isExactAppOutboxInsert (AOI:95-135); its one caller (auth-logout-provenance.ts:40) stops checking in compute
export function validateWsOutboxInsert(
    expected: ComputeWsOutboxInsertInput,
    candidate: AppOutboxInsert
): readonly ComputedDataValidationIssue[];
//   every issue: row, index, proof key/value/expiry, proof expiry ≠ row expiry (the reader's PV:197); `expected` re-derived by
//   the producer's validate: Relic (relic-game-mutation-service.ts:362-371, its projection now spans outboxWrites[].provenance),
//   auth (auth-inbox-handler.ts:67), client-state (client-state-inbox-handler.ts:293-352), CRDT (app-crdt-inbox-service.ts:286),
//   presence (group-presence-summary-worker.ts:288-292); topology gains one before runInPSqlTransaction
//   (write-rtc-topology-publication-transaction.ts:59; none there today, inferred none upstream)
// AOI writeAppOutboxInserts(transaction, computed), signature unchanged; one recordset of trackIndex ∪ provenance rows:
//   with outbox as (insert … returning …), sidecars as (toAppOutboxSidecarInsert(rows)) select … union all select … store_key
// Batched loops (S6ii-R4), after each guard, one call per commit: writeAppOutboxInserts(transaction, writes) for CRDT's
//   writeCrdtOutbox, the presence page's downstreamOutboxWrites, the topology computed.outboxWrites. Deleted: the six
//   write*Provenance, toClientSnapshotProvenanceEffect, requireClientSnapshotProvenanceApplied
// packages/tests/shared-server/al-runtime/postgres/record-p-glite-statements.ts (new; caller owns vi.restoreAllMocks())
export interface RecordedPGliteStatement {
    readonly scope: 'autocommit' | 'exec' | 'transaction';
    readonly query: string;
    readonly params: readonly PSqlParameter[];
}
export interface RecordedPGliteStatements {
    statements(): readonly RecordedPGliteStatement[];
    transactions(): number;
}
export function recordPGliteStatements(raw: PGliteSql['raw']): RecordedPGliteStatements;
```

### 10.3 Dataflow and failure vocabulary

`read` → `compute` (proof facts, value, digest, expiry string; `PV:76-94`) → `validate` (recompute, compare; an
issue throws before any transaction, as `auth-inbox-handler.ts:67-69` and `app-crdt-inbox-service.ts:286-289` do) →
transaction: the operation's own guard first (Relic `writeObservedGroupAuthority` :375, the client runtime batch
`write-client-mutation.ts:70-85`, the CRDT mutation, the presence summary CAS :305, the topology mutation :61), then
the one outbox CTE; Relic's proof moves from before its outbox insert (:384-385) into it.

| Case                                     | Outcome                                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| guard refuses                            | the operation's own conflict (`RuntimeStateWriteConflictError`, `GroupPresenceSummaryWriteConflictError`); AppInbox retries with fresh reads, the workers replan                                                  |
| validate issue                           | thrown before the transaction, as today; nothing written                                                                                                                                                          |
| two rows in one batch name one proof key | `ResourceInboxInvariantCorruptionError` 'App outbox batch names one provenance row twice', before any statement                                                                                                   |
| live proof row under the key (collision) | the CTE returns no `store_key` for it → `ResourceInboxInvariantCorruptionError` 'App outbox provenance did not create exactly one row'; the transaction rolls back, not retried (a retry recomputes the same key) |
| expired proof row under the key          | written over, `revision + 1`, Relic included; the reader then admits the new proof (`PV:186-203`)                                                                                                                 |
| view-invalidation proof not applied      | unchanged: a retried `RuntimeStateWriteConflictError` (`guarded-view-publication.ts:58-66`)                                                                                                                       |

**`check:transaction-writes`** (`analyze-transaction-writes.mjs:44-55`). Every stored value is encoded in compute —
the proof's `JSON.stringify` and digest (`PV:91`), its expiry string, the index's `msgId` (`ATI:51`); the recordset
is a plain `.map` of precomputed strings as `::jsonb` (`ATI:61-65`); the duplicate check is a `Set`, no `sort`. The
reader does not change: namespace, key, value bytes and expiry stay as stored today (`PV:186-209`).

### 10.4 Proof and gates

- **RED → GREEN** (survey D §5): (1) `app-outbox-track-index-write.test.ts` gains an unordered WS row with a proof as
  one CTE statement, a live proof rolling everything back, an expired proof written over at revision 1, and a
  duplicate proof key refused before any statement; (2) `validateWsOutboxInsert` reports a proof whose digest, key or
  expiry does not bind its row; (3) `provenance-expired-row-replacement.test.ts:31-40` becomes one shared-writer case
  per producer and **gains Relic** (RED today on `do nothing`); (4) the producer pins move: CRDT atomicity
  (`crdt-app-inbox-atomicity.test.ts:21,137,212`, `crdt-inbox-completion.test.ts:8,201`), topology
  (`pglite-rtc-topology-ws-outbox.test.ts:224,254`), connect (`pglite-authorised-ws-connect-write.test.ts:305`), Relic
  (`relic-game-mutation.test.ts:175,181-183`).
- **The connect pin.** `authorised-ws-connect-statements.test.ts:97` `rowCount` 4 → 4 + the connect proofs, since the
  proofs leave the guarded batch for the tracked insert; the in-transaction bound `≤5` (:92) holds _(inferred)_.
- **The recorder.** The four copies go, assertions unchanged (survey D §6 table); the coupling entries
  `alm-work-release-batch-one-transaction` and `client-snapshot-provenance-single-page-build`
  (`docs/test-structure-coupling-exceptions.md:556-569`, :224-235) are re-checked.
- **Gates.** `test:api-v1:black-box:postgres:medium-scale` is **doctrine-required** (AppInbox mutation paths), never
  weakened; Postgres integration (survey D §4's five suites), `check:transaction-writes`, the games gate (Relic),
  `test:unit` (both roots), `typecheck`, `typecheck:tests`, changed style, coupling, test reachability.
- **State-write measurement of S6-ii's own** (profile-instance, baseline control first): `sql.statements` expected to
  fall by one per client-snapshot proof per commit _(inferred; measured)_; `rowsRead` level; `serializedResultBytes`
  and the `writeMs`/`outboxSqlMs` split may move (`create-instrumented-state-write-sql.ts:162-189`). Any counter
  outside ±5 % carries a recorded reason in the PR body; the effect contract does not move.

### 10.5 Documents at S6-ii's close

- Backlog: delete the provenance line (B:226-230); add one line for the view-invalidation retried-conflict class
  (Q-D3: a live view-proof collision is a replayed `changeId` that retries into the same key). Roadmap: D-rows for
  S6ii-R1–R5 after S6-i's; "As applied (S6-ii)" on D541 (R:568), the proof now its second sidecar row.
- Addendum: "As applied (S6-ii)" in the Slice 6 section S6-i writes (S6-R12). Outbound README (:785): the producer
  proof is written in the producer's own outbox statement, absent-or-expired.
- This proposal is deleted at S6-ii's close (S6-R12's and §6's "this file deleted" move here).
