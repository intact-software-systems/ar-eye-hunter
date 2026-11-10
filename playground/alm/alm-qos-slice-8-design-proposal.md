# ALM publication QoS Slice 8 design proposal: signed receipts on RTC (1a-ii, with the corrected premise)

Slice 8 of the [publication QoS and pub/sub addendum](alm-publication-qos-addendum.md) (§5.3 "RTC delivery, relaying,
and confidentiality", the publisher proof A:416-429; §7 "Slice 3" A:721 and "Slice 6" A:900-901, Limits A:958,
"receipts are unsigned"; "Later outcomes" A:1156-1158, "ACKs that authenticate their logical recipient across relays";
§8 rows "RTC distinguishes origin, recipient, and relay" and "Revocation and receipts preserve truthful outcomes"),
after S7-ii (#803). Written from the candidates survey and the three read-only surveys in `.superpowers/sdd/slice-8/`
of `alm-qos-slice-8` at `664ed19d5` (main), re-checked against the code, under the maintainer's rulings S8-C0 (Slice 8
= 1a-ii) and **S8-C0b** ("Signed receipts", on the corrected premise of §1). Every ruling below is proposed,
recommended (a) first; the maintainer rules them one at a time. Six resolve a survey against the code or against
another survey (S8-R1 against all three surveys' scope vote; S8-R2 against A's nesting and C's envelope proof; S8-R3
against B's derived fields; S8-R5 against B's handoff seam; S8-R6 against B's "the relay already stores child NACKs";
S8-R10 against C's "no new harness capability"). The slice is Release 15 and lands as two pull requests (S8-R12).
Decisions are D581… in the roadmap's decision record, entered at the close; this file is deleted with it.

**Rulings taken.** The maintainer ruled S8-R1 to S8-R14 one at a time on 2026-11-10, each on its recommended
option (a). The record is `.superpowers/sdd/slice-8/s8-planning-rulings.md`.

## 1. The problem and the scope

**The premise, corrected (S8-C0b).** The candidates survey said the slice replaces "the `fromPeerId` trust", that the
AR Eye games gate proves it, and that it is client-only. The code corrects all three:

- **No game-lane room relays.** The defaults are `topologyKind: 'auto'`, `degreeLimit: 5`, `treeMinSize: 5`,
  `meshMinSize: 16` (`apps/api-v1/resources/configuration/defaults-config.json:79-86`); below 5 active sessions a room
  is a `star` (`topology/planning/topology-kind-hysteresis.ts:26-30`), a complete graph
  (`compute-no-rtt-topology-next-hops.ts:34-43`) in which every recipient ACKs the origin directly. A relay can appear
  at 5–6 sessions and is certain from 7 (Survey A §1). Lane rooms hold 2–4 sessions; AR Eye allows 16
  (`arena-operations.tsx:98`). The games gate therefore runs direct ACKs only.
- **The defect needs no relay.** On `rtc` the envelope binds `senderId` to the data channel (AUTH:58-63) and the
  payload's `fromPeerId` to `senderId` (CTL:365-376), so a direct control's `fromPeerId` is authentic and
  `isALHopCompletionAck` (CTL:140-144) is a hop fact that **stays**. Nothing binds `logicalRecipientPeerId` to
  `fromPeerId`: under `receiver` and `leader` the origin counts `ack.logicalRecipientPeerId` (OPA:157-161) and checks
  only that it is expected, not outside and not yet counted (OCV:103-121). Any room peer with a channel to the origin
  can confirm another recipient, or the director's receipt of a command, and the real ACK is then refused "already
  counted" (OCV:118-120). A relay can drop a copy and forge its ACK, so the origin's timeout and WS fallback never fire.
  A forged outside-audience NACK from any next hop or frozen recipient moves a recipient outside
  (`validate-al-outbound-relayed-nack.ts:16-33`); a forged terminal NACK ends everyone's receipt (OCC:257-259,
  :310-314). WS already refuses a session speaking for another (AUTH:104-112).
- **Not client-only.** The WS server decodes the same ACK and NACK payloads through a closed decoder (CODEC:182-206)
  and authors three of its own (`to-ws-queue-box-server-outside-audience-ack.ts:18-40`;
  `rallar-server-ws-router.ts:547`; `ws-queue-box-server-inbound-authority.ts:458`); four files under
  `apps/api-v1/test` and three black-box recipes carry ACK literals. The server's _behaviour_ does not change.
- **Half a guarantee.** The publisher proof covers granted sends only (CARRIER:145-149), so an ordinary room send's
  origin stays unauthenticated across relays. This slice does not sign ordinary publications (a Limit, S8-R9).

**The ruling and its reason.** The maintainer ruled "Signed receipts". The platform reason: `acknowledged` means one
thing on both carriers. On `ws` the server attests it, and the platform's own Director transport defaults to
`rtc-with-ws-fallback` with receipts (`browser-director-relay-transport.ts:79-81, :155-160`), so every Director app
inherits whatever `rtc` means. And at-least-once over peer relays holds against a misbehaving member, not only
against faults.

**Scope (the slice statement).** A receipt control that speaks for a logical recipient on `rtc` carries that recipient
session's signature, and the origin counts it only after verifying it; a relay forwards the recipient's signed word
and authors only its own. The origin freezes each counted recipient's key at admission and hands a leg it could never
verify to WS before admission. The control ids move to `v3`; the two older-peer wire shims go.

**Not in this slice.** Signing ordinary publications; signatures under `hop` and `subtree`; a signed repair request;
relays verifying; the standing of a terminal NACK; D553; the two unwired cluster proofs (Q-B9); confidentiality
(D520); native keys (D513); server verification of a peer signature (D522); any OpenAPI, AppInbox or hosted change.

## 2. Where Slice 7 leaves receipt controls (facts)

| Short                           | Path                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CTL** / **CODEC** / **IDS**   | `packages/shared/al-contracts/al-control.ts` (416 lines, 11 runtime exports) / `al-control-value-codec.ts` (370, 10) / `al-control-type-ids.ts` (15)                                       |
| **PROOF** / **SIG**             | `packages/shared/al-contracts/publication-proof/al-publication-proof.ts` (264) / `packages/shared/signature/` (four files, 293 lines)                                                      |
| **VERIFIER** / **CARRIER**      | `packages/shared/multicast/publication/rtc-publication-proof-verifier.ts` (118) / `rtc-granted-publication-carrier.ts` (334)                                                               |
| **MGR** / **FROZEN**            | `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts` (1,289) / `web-rtc-overlay-frozen-audience.ts`                                                                            |
| **PREP** / **INTENT** / **DUP** | `packages/shared/alm/inbound/prepare-al-inbound-commit-bundle.ts` (348) / `al-inbound-effect-intent.ts` (313, 11) / `admission/compute-al-inbound-duplicate-changes.ts` (295)              |
| **UP** / **RCA** / **RPA**      | `packages/shared/alm/inbound/control/to-al-inbound-upward-control-work.ts` (125) / `compute-al-inbound-control-admission.ts` (161) / `../transition-al-pending-ack.ts` (203)               |
| **AUTH**                        | `packages/shared/alm/inbound/read-al-inbound-message-authorization.ts` (123)                                                                                                               |
| **OCA** / **OCC** / **OCV**     | `packages/shared/alm/outbound/control/al-outbound-control-admission.ts` (450) / `../compute-al-outbound-control-admission.ts` (314) / `../validate-al-outbound-control-admission.ts` (203) |
| **OPA** / **POLICY**            | `packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts` (235, 11) / `admission/al-outbound-admission-validation.ts`                                                           |
| **NORM**                        | `packages/shared/al-contracts/normalize-al-qos-policy.ts`                                                                                                                                  |
| **A** / **R** / **B**           | the addendum / the roadmap `alm-improvement-plan.md` / `plans/backlog.md`                                                                                                                  |

- **The shapes.** `ALAckPayload` has eight required fields (CTL:59-74), `ALNackPayload` six and four optional ones,
  and **no `originPeerId`** (CTL:76-88); neither carries a signature. A control is a unicast with volatile, best-effort
  QoS and no `constraints` (CTL:322-339). The version is the type id: `al.control.ack.v2`, `nack.v2`, `repair.v2`,
  `receipt.v1`; any other `al.control.*` id is refused `unsupported` (IDS:1-15). The decoder refuses unknown fields
  and requires the mandatory ones (CODEC:182-206). Two wire shims read an older peer's NACK and an older server's
  receipt (CODEC:97-109).
- **What a receipt counts.** The public `ack` maps only to `none`, `receiver` and `leader` (NORM:457-467). Under
  `receiver` and `leader` the receipt counts the recipient the payload names; under `hop` and `subtree` it counts the
  channel sender (OPA:157-167). `hop` is the default ack of an at-least-once send that states none (NORM:301).
- **Who authors a control today.** A receiver builds its own ACK and NACK in the pure commit-bundle step
  (PREP:182-222), from intents that say `self` or `relayed` (INTENT:22); the control is committed as a durable
  `send-control` effect and sent later by the lane (`al-inbound-store-lane.ts:544-573`). A relay builds every upward
  control itself (UP:92-125): a new envelope, `fromPeerId` the relay, `observedAtEpochMs` now (UP:98-105), a child's
  `delivered` or `accepted` rewritten to `forwarded` (INTENT:254-257; UP:123), one per recipient the first time a
  child names it (RPA:141-143), then its own terminal ACK. It also authors a `not-subscribed` NACK a child's
  hop-end implied (RCA:152-156; RPA:144) and repeats both on a retried copy from peer ids alone (DUP:152-192,
  :251-261). The relay stores child ACKs whole (RCA:49-50) and **no child NACK**, only `outsideAudiencePeerIds`
  (CTL:176-180). Its owner row names the origin and no room (`al-inbound-admission-store.ts:78-88`).
- **The origin.** Three compositions hand a control to the one outbound control admission: the RTC overlay as `'peer'`
  (MGR:665-671; its runtime is built `carrier: 'rtc'`, MGR:268-271), a WS client as `'trusted-server'`
  (`ws-queue-box-client-receipt-tracking.ts:77`), and the WS server for its own rows as `'peer'`
  (`ws-queue-box-server-service.ts:353`). `admit` reads, computes, validates and writes under the owner-version fence
  (OCA:130-160, :367-382); a lost fence retains the control and replays `admit` on a fresh read (OCA:158, :189-195,
  :439-449). The read already loads the sent row with its captured policy (OCA:321). The verdict on a control goes
  only to the `control-admission` diagnostic (`write-al-outbound-control-admission-diagnostic.ts:19-41`).
- **The publisher proof, the template.** A private classified-slot encoder (PROOF:141-170, :226-252) builds the
  signing input over a field table that `satisfies` the envelope's keys (PROOF:57-136); the proof is `{ alg: 'ES256',
  keyId, signature }` (PROOF:23-27; 28 sites in 9 files). The origin signs once, after its admission read and before
  its commit, and the stored row carries the proof (`al-outbound-dispatch-admission.ts:467-499`). A keyless origin is
  refused `unsupported` before admission (`sign-rtc-publication.ts:62-64`; CARRIER:124-132). The verifier caches
  imported keys by key id and verdicts by key id, signature and digest (VERIFIER:39-42, :59-76, :100-117). The
  envelope proof requires `constraints.expiresAtMs` (`al-message-persistence-validation.ts:236-250`).
- **Keys.** One pair per auth session (`session-publication-crypto.ts:26-37`), its public half on the presence row,
  `null` on a page without SubtleCrypto (`group-types.ts:212-215, :227-228`); `resolvePublicationKey` answers `null`
  for a session that is not live (`resolve-publication-key.ts:5-12`), and a control triggers no snapshot refresh
  (`rtc-group-snapshot-refresh.ts:37-41`). Every peer that receives a receipted RTC send is a browser page (B §5).
- **The captured policy.** The sent row keeps its first dispatch's policy, with per-recipient facts beside it
  (`admittedConnectionGenerationIds`, POLICY:65-70, :77-99); a retry replaces only the next hops (POLICY:106-117).
  Every origin plan passes one refusal chain (MGR:758-773, :789-820), where the room-limit refusal is `unsupported`
  and names the message with its sender's targets, so the fallback keeps them (FROZEN:155-171).
- **Sizes and gates.** MGR has a disposition pinned at its exact cognitive-load score
  (`reviewed-browser-dispositions.mjs:234-243`), so it gains delegating lines only. CTL, INTENT and OPA are at 11
  runtime exports, one below the split review. Stored control histories decode through the payload decoders
  (`al-admission-value-validation.ts:72-89`); the browser store's schema id is at
  `open-indexed-db-admission-database.ts:21`. `browser/rallar.ts` is 299 KiB (measured 298.0), the headless agent 395
  (394.516). 86 files under `packages/tests` and 4 under `apps/api-v1/test` build an ACK literally, with no shared
  builder (C §1, re-counted). Medium-scale runs by path on `packages/shared/**` (`api-v1-medium-scale-gate.yml:5-14`),
  the games gate unless the diff is exclusively platform (`branch-release-gate.yml:115-123`), and ALM cells only in
  the non-blocking observation (`alm-conformance-observation.yml:30`).

## 3. Decisions (proposed)

### S8-R1. The rule and its scope (Q-A5, Q-A6, Q-A10, Q-B1, Q-C9; resolves all three surveys' (a))

- **(a) Recommended: the signature follows the claim a receipt counts.** Under `receiver` and `leader` every ACK and
  every NACK that a **counted recipient** authors about the message on `rtc` carries that session's signature: its
  `delivered`, its `accepted`, its terminal `subtree-complete` or `subtree-complete-not-subscribed`, and every NACK
  (`not-subscribed`, `before-entry`, `gap`, the terminal reasons). A counted recipient is a session the frozen
  audience names or the unicast addresses, the test DUP:199-208 already makes. The origin verifies every peer control
  it admits for such a receipt, direct or relayed, always: one path, no topology dependence. Everything else is a hop
  fact the channel authenticates and carries `proof: null`: every control under `hop` and `subtree`, and the own
  hop-end of a relay outside the frozen audience, which the origin refuses today ("confirms no peer", OCV:109-117)
  and no relay passes upward (RPA:120-122). Repair requests stay unsigned and `al.control.repair.v2` stays: they
  speak for nobody (CTL:90-99), gate no receipt, and D530's floor bounds what a forged one spends. On `ws` nothing
  changes: the server's ingress and receipt stay the authority (D522; AUTH:104-112;
  `ws-queue-box-server-receipt-aggregation.ts:574-617`).
- (b) Every ACK and NACK on `rtc`, whatever the mode or author (the surveys' vote): `hop` is the default at-least-once
  ack (NORM:301), so every such frame would pay a sign and a verify per hop for an identity the channel already
  binds; the origin would freeze its next hops' keys, which a retry replaces (POLICY:106-117); and a keyless relay
  outside the audience could no longer end its hop, stalling its parent's row. (c) Sign only a control whose
  `logicalRecipientPeerId` differs from its channel sender: star rooms pay no crypto, but one control is then
  authenticated two ways by where its author sits in a tree the origin does not see, and the keyless rule (S8-R4)
  turns topology-dependent. (d) **Declined by S8-C0b:** the unsigned sender check alone (A's Q-A10 (b)), which closes
  the direct forge and not a lying relay. **Cost if wrong:** (a) leaves `hop` and `subtree` receipts on channel
  trust, which is what they count; widening to (b) later needs no wire change, since every control has the slot.

### S8-R2. The shape (resolves A's Q-A3, B's Q-B6 and C's Q-C1)

- **(a) Recommended: one flat payload for both carriers with a required nullable `proof`; B's shape, which meets A's
  requirement; the code refuses C's.** `ALAckPayload` and `ALNackPayload` gain `proof: SignatureProof | null`, and the
  NACK gains a required `originPeerId` (S8-R3). `null` has one meaning: _no recipient signature; the carrier's
  admission authenticates this control's sender_. That is every `ws` control (a session's own, socket-bound and
  speaking only for itself, AUTH:58-63, :104-112; the server's own) and every hop fact on `rtc` (S8-R1). The WS
  server decodes the slot through the closed decoder and never reads it: no verify, no new refusal (D522). A relayed
  control keeps the recipient's `status` and `observedAtEpochMs`; the relay rewrites only `fromPeerId`, `toPeerId` and
  an ACK's `carrier`, in a new envelope. `forwarded` keeps one meaning, a hop's own word under `hop` that it took the
  copy and passes it on (`compute-al-inbound-admission.ts:310-315`); it no longer marks a relayed ACK.
  **Against C:** the envelope proof needs `constraints.expiresAtMs`, which a control lacks; a relay must mint a new
  envelope, since unicast ingress binds `senderId` to the channel and the payload's hop fields to the envelope; and
  the publication's field table signs exactly those (`id`, `route`, `targets`, `payload.resource`). **Against A's
  nesting:** the same signed bytes, with every reader of `ack.logicalRecipientPeerId` and `ack.status` rewritten.
- (b) A signed statement nested in a hop control (A). (c) The envelope `proof` on RTC controls only (C). (d) Signed on
  `ws` too: the server's outside-audience ACK speaks for a session it sent nothing, so `null` would exist anyway.
  **Cost if wrong:** the flat slot flips every ACK and NACK literal: 86 + 4 test files, 3 recipes, the raw-control
  builder and the ordering proof's socket (`ordering-proof-socket.mts:25`).

### S8-R3. Bound fields and one signing-input mechanism (Q-B7, Q-B8; resolves B's derived fields)

- **(a) Recommended: everything a recipient states is signed, only the hop fields are not, and nothing is derived.**
  ACK: `ackedMsgId`, `originPeerId`, `logicalRecipientPeerId`, `status`, `observedAtEpochMs` signed; `fromPeerId`,
  `toPeerId`, `carrier`, `proof` excluded. NACK: `msgId`, `originPeerId` (new on the wire, checked against the owner
  row at a relay and at the origin as an ACK's is, OCV:58-63), `logicalRecipientPeerId`, `reason`,
  `observedAtEpochMs`, `orderingKey`, `expectedSeq`, `missingRanges`, `serverSnapshotVersion` signed, an absent one as
  `null`; `fromPeerId`, `toPeerId`, `proof` excluded. Two domain tags, `rallar-alm-ack-proof-v1` and
  `rallar-alm-nack-proof-v1`, so an ACK's signature never verifies as a NACK. **One mechanism:** PROOF's private slot
  encoder becomes `toClassifiedSigningInput(domainTag, sections)` in `packages/shared/signature/`, with
  `SignedFieldClass`; the publication proof and the receipt proof both call it, and
  `al-publication-proof.test.ts:243-262` pins that the publication's bytes do not move. Each receipt table
  `satisfies Record<keyof ALAckPayload, SignedFieldClass>` (and the NACK's), so an added key fails the build
  unclassified. `ALPublicationProof` is renamed `SignatureProof`, in `signature/`, with no alias.
  **Against B's derived `groupRef` and frozen `snapshotVersion`:** the signed origin and subject id name one message
  of one origin, the origin keeps one owner row per message id (OCA:307-311) and admits only controls addressed to it
  (OCV:36-38), so a statement cannot be replayed to another message, origin or room; and a relay's own terminal ACK
  is built from an owner row that holds neither the room nor the version, so deriving costs a read at every relay.
- (b) B's table with the derived room and version. (c) Keep the NACK's origin derived: the signing input stops being
  a function of the payload and the table cannot classify it. (d) A second encoder: duplication (D8).
  **Cost if wrong:** a field added later is a new domain tag, a stated proof version, never a silent change.

### S8-R4. Which key verifies, and the keyless session (Q-B4, Q-B5, Q-A7)

- **(a) Recommended: the origin freezes each counted recipient's key at admission, and refuses the leg when one is
  missing.** For a `receiver` or `leader` plan the RTC planner states `receiptProofKeys`, each counted recipient's
  `{ keyId, publicJwk }` from the admitting snapshot the freeze already walks (FROZEN:41-52); the sent row captures it
  with its first dispatch's policy, as it captures `admittedConnectionGenerationIds`, and control admission reads it
  with the row it already loads. It survives a leave, a reconnect and every later snapshot. **Keyless:** a pure
  `computeRtcReceiptKeyRefusal` joins the origin's refusal chain after the room-limit refusal and is shaped as it: a
  logically receipted leg that counts a session with `publicationKey: null`, or whose origin page cannot verify, is
  `unsupported` before admission, naming the message with its sender's targets. `rtc-with-ws-fallback` hands it to WS
  at once; `rtc` alone refuses it. That mirrors the keyless origin of a granted send. Ordinary sends pass this chain
  on every plan, so the check needs no detour through the granted carrier. **Cost:** about 0.25 KiB per counted
  recipient on the sent row, 3.5 KiB at 15 and 60 KiB at the room limit of 256 _(computed from the shapes)_.
- (b) Freeze key ids only and read the JWK from the current snapshot: a third of the size, and an ACK in flight when
  its recipient leaves is refused, which today counts. (c) The current snapshot with no freeze: a control has no
  refresh path. (d) Admit and let the keyless recipient time out: about 8 s before the fallback for a recipient known
  unconfirmable at admission. **Cost if wrong:** the row size; a page outside a secure context loses receipted RTC,
  which the fallback covers.

### S8-R5. Where signing and verification run (Q-A8, Q-A11, Q-B3, Q-B10; resolves B's handoff seam)

- **(a) Recommended: sign before the commit that writes the control; verify in the origin's read phase; relays
  verify nothing.** **Sign:** the publication's rule applied to controls. PREP and UP stay pure and build
  `proof: null`; one async `signALInboundReceiptControls(bundle, receiptProofs)` runs at the four inbound
  `commitBundle` call sites (`al-inbound-message-admission.ts:139`; `al-inbound-ordered-delivery.ts:108, :168`;
  `al-inbound-control-admission.ts:205`), after validation and outside the write, and fills the proof of each
  `send-control` effect its compute marked a counted recipient's own. The bundle then commits as the one conditional
  commit it is today, and every later send resends the stored signed control. A conflict replays the admission, which
  builds and signs a new control; the origin's duplicate key is the control's identity, not its bytes (OCV:132-141).
  A sign failure is a value: the control is left out, a diagnostic names it, the data rows commit. **Against B's
  handoff seam** (MGR:357-365): the stored effect would hold an unsigned control, every send retry would re-sign, and
  `null` would mean two things. **Verify:** in `admit`, after `readControlAdmission` and before the pure compute
  (OCA:136-137), only where the composition says `signature` and the receipt is logical. The verdict joins the read
  as a fact and the pure validator turns a refusal into an issue. A retained control's replay runs `admit` again and
  so re-verifies; a verdict cache keyed as VERIFIER's makes that a lookup, and no verdict is stored in a work row.
  **The ordering hazard:** the channel dispatches each frame without awaiting the previous one
  (`qrtc-data-channel.ts:551, :700-717`), so an ACK and a later terminal NACK already race at the store read, and
  verification widens that window by one verify. The owner-version fence serialises it (OCV:29-35; OCA:367-382): the
  loser is retained and replayed on a fresh read. Commit order decides, as today; no new queue.
- (b) Sign at the RTC handoff (B). (c) Relays verify too: depth × N verifies for bookkeeping that rests on the
  channel. (d) Store the verdict with the retained control: a trust decision kept in a work row. **Cost if wrong:**
  (a) adds one await to every inbound admission that emits a counted recipient's control.

### S8-R6. The relay (Q-B9, Q-B11; Survey A §4; resolves B §3.3's "history already keeps child payloads whole")

- **(a) Recommended: the relay forwards what its child signed and authors only its own word.** An admitted child
  control for a recipient the origin counts goes upward as stored, readdressed (the envelope and hop fields of
  UP:98-105), the first confirming control per recipient, once, as today. The implied `not-subscribed` is no longer
  authored: the relay forwards the child's signed `subtree-complete-not-subscribed` hop-end itself, and
  `isALImpliedNotSubscribedNack` (the relay's row, RPA:144; the origin, OCC:246-248) reads it by status and owed
  recipient without requiring that its sender is its recipient. A gap NACK is forwarded signed and writes no row, as
  today. A retried copy re-forwards stored controls: ACKs from the history the relay keeps, and outside-audience
  NACKs from a **new** relay row, an inbound `set-control-nacks` history beside `set-control-acks`, bounded by
  `collectionEntries` (**against B:** only the ACK half exists today). The repeat then carries the child's own
  reason, which ends D530's flattening to `not-subscribed`. The relay still authors its `accepted`, its terminal ACK
  and NACKs about itself: signed when it is a counted recipient, `proof: null` when not. `isALRelayedNackReason` keeps
  its job, naming the child NACKs a relay admits and forwards; `isALHopCompletionAck` stays.
  **Deleted:** the child branches of UP:106-124 and the `nack` variants of `ALInboundUpwardControl` (UP:48-51), about
  25 lines; the relayed half of INTENT:251-261 and the `relayed` member of `ALInboundAckRecipient`, about 10;
  `toALInboundRelayedOutsideAudienceEffect` (INTENT:181-209), 29; the peer-id repeats (DUP:157-168, :251-261), 23; the
  relay-authored implied NACK (RCA:152-156), 5: about 90 lines, beside the 13 of S8-R8.
- (b) The relay forwards NACKs only and the child signs one for the implied case: the lost-NACK case the implication
  exists for returns. (c) The relay re-originates under its own signature: a relay's word for a recipient, the defect.
  **Cost if wrong:** (a) adds one stored row per receipted message at a relay with an outside recipient.

### S8-R7. The failure vocabulary at the origin

- **(a) Recommended: a typed `ALReceiptProofRefusal`** of `missing-proof`, `unknown-key`, `key-mismatch` or
  `invalid-signature` (§5). Each becomes an `unauthorized` issue of the pure validator and a `rejected` admission;
  the existing `control-admission` diagnostic gains, present exactly when a proof was refused, `proofRefusal`,
  `claimedRecipientPeerId` and `channelPeerId` (the payload's `fromPeerId`, which the envelope binds to the channel).
  Nothing is counted or written and nothing is answered: no carrier answers a control. The receipt proceeds to its
  timeout, retry and fallback. `Either` throughout; nothing throws.
- (b) NACK the sender: an answer to a forger, and an amplifier. (c) End the receipt: a forger's denial of service.
  **Cost if wrong:** under (a) a refusal is visible only in the diagnostic and as a slower receipt.

### S8-R8. The cutover (Q-A4, Q-B12, Q-C2, Q-C6)

- **(a) Recommended: `al.control.ack.v3` and `al.control.nack.v3` on both carriers; `v2` is refused `unsupported`**
  by the existing id check, the path the `unknown-ack-version` cell proves, whose retired id becomes `v2`.
  `decodeALNackWirePayload` and `decodeALReceiptWirePayload` are deleted with their pins
  (`al-control-value-codec.test.ts:61, :93`) (D8). `repair.v2` and `receipt.v1` keep their ids. No migration code and
  no version window (R:2099-2100); §8 states what a page of the previous build experiences.
- (b) Keep `v2` beside `v3` for one release: a legacy path through which the forge stays open. (c) Bump on `rtc`
  only: two shapes for one control. **Cost if wrong:** (a) is the mixed window of §8, on both carriers.

### S8-R9. Standing questions kept out (Q-A9, Q-C7, Q-C8)

- **(a) Recommended: sign, and change no standing.** A signed terminal NACK from one counted recipient still ends
  everyone's receipt: the slice proves who said it, not that one recipient may speak for all (a Limit, and a backlog
  line). D553 stays: a zero-recipient receipt has no control to sign. Q-B9 stays out: both proofs are server-side and
  belong to a Postgres-lane PR. An ordinary publication's origin stays unsigned (a Limit, and a backlog line). A
  relay that drops a control is a liveness fault the timeout and fallback already cover. The stored-row default at
  CODEC:163-169 is not a wire shim and stays.
- (b) Narrow a terminal NACK to its sender in this slice: a receipt-semantics change with its own pins.
  **Cost if wrong:** (a) leaves one counted recipient able to end a receipt for all, now under its own signature.

### S8-R10. Proof and measurement (Q-A2, Q-C3, Q-C4; resolves C §2's "no new harness capability")

- **(a) Recommended.** **Blocking (Vitest `unit`):** codec round trips and refusals; the field tables' build pin; the
  shared encoder; inbound signing; the pure outbound validator with the verdict as a read fact; and the relay chain
  fixture, whose sessions already hold registered keys (`rtc-relay-chain-test-support.ts:23-32`), for a forwarded
  `delivered`, `accepted`, `not-subscribed`, `before-entry` and `gap`. Each forge is a named RED-first test: a direct
  peer names another recipient; a relay forges a child's ACK; a forged outside-audience NACK; a forged terminal NACK;
  a true ACK replayed to another message or origin. **Observation (local full scope, `rtc` carriers):**
  `unsigned-ack-refused` and `forged-recipient-ack` through `messages.control`, which today builds an ACK only for
  the page's own session (`submit-black-box-raw-control.ts:53-72`): it passes `proof: null` and gains one input
  field, `logicalRecipientPeerId`. **Against C:** the `strip-proof` and `forgeSender` rewrites act on the envelope
  proof (`transport-fault-port.ts:192-202`) and do not reach a payload proof. A third cell sends a non-granted
  receipted send through the forced tree `granted-rtc-path.ts:15` already uses. The smoke cells' `rtc` legs observe
  a direct signed ACK in the workflow observation. **6f:** a unit count on the relay chain fixture, wrapping the
  `subtle` port: N signs plus one per recipient that is also a relay, at most as many verifies, none at a relay; 1
  and 1 under `leader`. A timed measure is not worth a task while receipted traffic is low-rate; it joins B:150-157.
- (b) Also assert in an AR Eye lane that a director command reaches `acknowledged`: a 2-session room proves only the
  direct case, the fallback would mask a broken RTC leg, and the lane already carries known starvation reds.
  (c) Promote a three-agent cell to a workflow: a required lane on the slowest, flakiest family. **Cost if wrong:**
  under (a) no browser lane blocks on a signed receipt; a regression there shows as an 8 s fallback, not a red.

### S8-R11. Budgets (Q-C5)

- **(a) Recommended: measure at the final head; raise each crossed budget to the next KiB and report both figures.**
  `rallar.ts` has about 1.0 KiB of headroom and the headless agent about 0.5; both probably cross _(inferred)_.
- (b) Pre-raise both in the design: a figure before a measurement. **Cost if wrong:** none; both are reported.

### S8-R12. How it lands

- **(a) Recommended: two pull requests, S7's shape.** **S8-i** is the protocol and is atomic: a relay that still
  re-originates under a verifying origin breaks every room of 5 or more, and the type change fails the tests'
  typecheck until every literal moves. **S8-ii** is the riders: the three cells, the harness field and the 6f count.
  Each PR runs the platform gate, the games gate and medium-scale by path, so two PRs cost two gate rounds.
- (b) One PR: one round, and the observation cells delay a protocol review. (c) Shape and signing first, verification
  second: a `main` that carries proofs nobody checks, and two wire-affecting PRs. **Cost if wrong:** a gate round.

### S8-R13. Documents at the close (Q-A12, Q-C10; Survey C §7)

- **(a) Recommended.** **Addendum:** the status header (A:3-10); §5.3 (A:416-429) names the recipient beside the
  publisher; a "### Slice 8: signed receipts on RTC" section before "### Later outcomes" (A:1154) with "As applied"
  and Limits (ordinary publications unsigned; `hop` and `subtree` on channel trust; the terminal NACK's standing; a
  keyless page loses receipted RTC; the cells on the local lane only); A:721, A:900-901 and A:958 stay as history;
  "Later outcomes" (A:1157-1158) drops the ACK clause; §8 gains a "Slice 8 adds evidence to two rows." paragraph
  after A:1258. **Roadmap:** `Revised:` (R:4); the release-map sentence and two `15 Signed receipts` rows after R:833;
  a "### Release 15, Slice 8 design" section before R:2024; D581…; "As applied (S8-i)" notes on D519 (R:546,
  "Receipts stay unsigned"), D530 (R:557, the flattened repeat) and D534 (R:561, forwarded as signed), wording
  corrected, not rewritten; R:2340-2342; one revision-history entry. The standing direction (R:611-612) stays true of
  ordinary sends. **Backlog:** B:147-149 deleted; B:150-157 gains the receipt cost; B:163-167 reworded; new lines
  for S8-R9's Limits. **Reference and maps:** `docs/rallar-api-reference.md` :1220-1221, :1992-1995, :2015-2016;
  `alm-complete-product-description.md:364`; the inbound README (:225, :244, :272, :300-305, :313, :348) and the
  outbound README (:513-519, :1399); `schema-and-capabilities.md` (:266, :341, :645-647, :1040-1046) and
  `runtime-diagnostic-contract.md:302`. This file is deleted.
- (b) The addendum only: the READMEs would claim behaviour the code lacks (R:2118-2119). **Cost if wrong:** none.

### S8-R14. Gates (Survey C §8)

- **(a) Recommended, each reported passed, failed or skipped.** `npm run test:unit` (the codec, signature, inbound
  control, outbound control and relay suites first); `npm run typecheck` with `typecheck:tests`; changed style and
  `check:test-structure-coupling`; `check:browser-bundles` and the headless bundle test; the shared-web public API
  snapshots if an export moves; `cd apps/api-v1 && deno task check && deno task test` with the task's own
  permissions, since the server decodes the shared codec; the black-box recipes on Postgres, since three carry ACK
  literals, and the ordering cluster proof, whose socket builds one; the games gate by path with
  `npm run test:deno:games`. **Medium-scale runs by path, not by doctrine:** no AppInbox or database mutation path is
  touched; the changed rows are ALM runtime-store rows. The ALM observation runs locally at full scope for the new
  cells (`test:rallar:full-stack:postgres:alm`). The state-write measurement is not run.
- (b) Skip the Deno task: the only gate that types the server's use of the shared payload. **Cost if wrong:** minutes.

## 4. Contracts, sketched

```ts
// packages/shared/signature/: signature-proof.ts (ALPublicationProof renamed, no alias) and the one encoder
export interface SignatureProof { readonly alg: 'ES256'; readonly keyId: string; readonly signature: string; }
export type SignedFieldClass = 'signed' | 'signed-when-present' | 'excluded';
export function toClassifiedSigningInput(domainTag: string, sections: readonly ClassifiedSigningSection[]): string;
//   ClassifiedSigningSection: { name; fields: Record<string, CanonicalJsonInput> | undefined; classes }
// al-control.ts, v3. null: no recipient signature; the carrier's admission authenticates this control's sender.
export interface ALAckPayload { /* the eight fields of v2 */ readonly proof: SignatureProof | null; }
export interface ALNackPayload { /* v2 */ readonly originPeerId: string; readonly proof: SignatureProof | null; }
// packages/shared/al-contracts/receipt-proof/al-receipt-proof.ts (pure; a sibling of publication-proof/)
export type ALReceiptControl = Exclude<ALPeerControlMessage, Readonly<{ type: 'repair'; }>>;
export const AL_RECEIPT_PROOF_FIELD_CLASSES = { ack: { /* S8-R3 */ }, nack: { /* S8-R3 */ } } as const;
export function toALReceiptProofSigningInput(control: ALReceiptControl): string;
export function signALReceiptProof(input): Promise<Either<ALReceiptProofFailure, SignatureProof>>; // subtle, keyPair
export function verifyALReceiptProof(input): Promise<Either<ALReceiptProofFailure, true>>; // subtle, publicKey
export interface ALReceiptProofRefusal {
    readonly kind: 'missing-proof' | 'unknown-key' | 'key-mismatch' | 'invalid-signature';
    readonly claimedRecipientPeerId: string;
    readonly channelPeerId: string;
}
// The two ports ALM names, so its dependencies point inward; the RTC carrier implements both.
export interface ALReceiptProofSignerPort {
    signReceiptProof(control: ALReceiptControl): Promise<Either<ALReceiptProofFailure, SignatureProof>>;
}
export interface ALReceiptProofVerifierPort {
    verifyReceiptProof(control: ALReceiptControl, frozenKey: GroupPresencePublicationKey | undefined):
        Promise<Either<ALReceiptProofRefusal, true>>;
}
// packages/shared/multicast/receipt-proof/ (the RTC carrier's collaborators; MGR gains delegating lines only)
export function computeRtcReceiptKeyRefusal(input: ComputeRtcReceiptKeyRefusalInput):
    Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>; // 'unsupported', the sender's targets kept
export function toRtcReceiptProofKeys(frozen: ALFrozenMulticastAudience, snapshot: GroupSnapshot): ALReceiptProofKeys;
export class RtcReceiptProofSigner implements ALReceiptProofSignerPort { /* the session's PublicationCrypto */ }
export class RtcReceiptProofVerifier implements ALReceiptProofVerifierPort { /* key and verdict caches, as VERIFIER */ }
// ALOutboundDispatchPlan and ALOutboundCapturedPolicy: stated only by the RTC planner, for a receiver or leader plan
readonly receiptProofKeys?: ALReceiptProofKeys; // Readonly<Record<sessionId, GroupPresencePublicationKey>>
// CreateALOutboundControlAdmissionInput (required: the WS client and server say 'carrier', the RTC overlay 'signature')
readonly recipientAuthentication: { kind: 'carrier' } | { kind: 'signature'; verifier: ALReceiptProofVerifierPort };
readonly recipientProof: 'carrier-authenticated' | 'verified' | ALReceiptProofRefusal; // on ALControlAdmissionRead
// ALInboundMessageRuntime.Dependencies (required, stated by each of the three compositions)
readonly receiptProofs: { kind: 'carrier-authenticated' } | { kind: 'signed'; signer: ALReceiptProofSignerPort };
// packages/shared/alm/inbound/sign-al-inbound-receipt-controls.ts: after validation, before commitBundle
export function signALInboundReceiptControls(bundle, receiptProofs): Promise<ALInboundCommitBundle>;
// A relay's upward control: its own (built, signed when it is counted) or a child's stored one, readdressed
export type ALInboundUpwardControl =
    | { kind: 'own-ack'; status: ALAckStatus }
    | { kind: 'forwarded'; control: ALReceiptControl };
// inbound store mutation: { kind: 'set-control-nacks'; msgId; senderId; value: { kind: 'nacks'; values }; … }
```

`receiptProofKeys` is optional because its absence has a meaning: this carrier counts no signed recipient. Every
refusal is a value. No new server mutation kind, key family or OpenAPI field.

## 5. Dataflow and failure vocabulary

1. **Admission (origin).** The plan freezes the audience, then `computeRtcReceiptKeyRefusal`: a counted session with
   no key, or an origin that cannot verify, refuses the leg `unsupported` and the fallback takes it. Otherwise the
   plan states `receiptProofKeys` and the sent row captures them.
2. **Receipt (a counted recipient).** The pure compute builds its ACK or NACK with `proof: null` and marks it;
   `signALInboundReceiptControls` signs it; one commit writes the rows and the signed `send-control` effect.
3. **Relay.** Admits the child's control on its channel checks, without verifying; stores it; forwards it readdressed
   for a recipient the origin counts; ends its own hop with its own control.
4. **Origin.** Read (the owner, the sent row with its keys, the receipt, the histories), verify the named recipient's
   proof against its frozen key, compute, validate, write under the fence. A refusal writes nothing; a lost fence
   retains the control, and its replay verifies again from the cache.
5. **`ws`.** Unchanged: every control carries `proof: null` and the server's receipt is the origin's evidence.

| Code / status                 | Lives in                                       | Raised when                                                                                                     |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `unsupported` (the leg)       | `computeRtcReceiptKeyRefusal`, in MGR:789-820  | a `receiver` or `leader` RTC leg counts a session with `publicationKey: null`, or its origin page cannot verify |
| `missing-proof`               | `ALReceiptProofRefusal`, the origin read phase | a peer control for a logical receipt carries `proof: null`                                                      |
| `unknown-key`                 | same                                           | no key is frozen for the named recipient: the send does not count it                                            |
| `key-mismatch`                | same                                           | `proof.keyId` is not the key frozen for the named recipient                                                     |
| `invalid-signature`           | same                                           | the signature does not verify over the signed fields: forged, altered, or replayed to another message or origin |
| `unsupported` (a control)     | `isALControlTypeId` (IDS:10-15)                | an `al.control.ack.v2` or `nack.v2` control, from a page of the previous build                                  |
| `receipt-sign` diagnostic     | the recipient, before its commit               | WebCrypto refused the sign; the control is not written and the data rows commit                                 |
| `receipt-exhausted`, fallback | the origin, as today                           | the retries ran out with a recipient unconfirmed, a refused control included                                    |

Nothing new throws; a refused control is a bounded waiting condition for its receipt, not a failure of the send.

## 6. Slicing, deliverables, validation

**S8-i** (S8-R1–S8-R9, S8-R11, S8-R13, S8-R14): the shared encoder and the proof rename; the v3 payloads, codec and
ids, the shims deleted; the receipt proof and its tables; inbound signing at the four commit sites; the relay's
forward, its NACK history and the deletions; the frozen keys, the keyless refusal and the origin's verification; the
three compositions stating their authentication; the server's three constructors and the harness builders stating
`proof: null`; every literal fixture and the shared test builder; the three recipes; the blocking units and the five
forge tests; both bundle figures; the documents; this file deleted. **S8-ii** (S8-R10's observation half): the
`messages.control` field, the three cells and their recipe pins, the 6f count, the harness documents, "As applied
(S8-ii)" notes. No OpenAPI change, so no API recipe is added; hosted manifests unchanged (D505).

## 7. Requirement-to-evidence (addendum §8)

| Row                                                         | Evidence item                                                                                                    | Pin / proof                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| RTC distinguishes origin, recipient, and relay (A:1209)     | a counted recipient's ACK and NACK verify at the origin, direct and through a relay that forwards them as signed | relay chain fixture with real keys: forwarded `delivered`, `accepted`, `not-subscribed`, `before-entry`, `gap`; relay and codec units |
|                                                             | no peer confirms, excludes or ends a receipt for another recipient                                               | five RED-first forge units (S8-R10); cells `unsigned-ack-refused` and `forged-recipient-ack` (observation)                            |
| Revocation and receipts preserve truthful outcomes (A:1207) | a refused control counts nobody and the true ACK still completes the receipt                                     | OCV and OCA units; the origin fixture: forged ACK refused, real ACK counted                                                           |
|                                                             | a keyless counted recipient hands the leg to WS before admission, never to a timeout                             | `computeRtcReceiptKeyRefusal` unit; fallback unit on the origin fixture                                                               |

The row's "explicit confidentiality mode" stays open (D520). The origin half of A:1209 stays granted-only.

## 8. Mixed builds

- **Wire.** `al.control.ack.v3` and `nack.v3` replace `v2` on both carriers; the envelope version, `repair.v2` and
  `receipt.v1` are unchanged, so data frames, repair requests and the server's receipt cross builds as before. The
  closed decoder makes any payload change incompatible both ways; the id bump makes the refusal the typed `unsupported`.
- **A page of the previous build, until it reloads.** Web and API deploy together from `main` (R:2086-2088), and no
  code reloads an open tab. Its ACKs and NACKs are refused `unsupported` by a new page on `rtc` and by the server on
  `ws`, so **as a recipient it confirms nothing on either carrier**: a receipted send that counts it delivers, stays
  unconfirmed for it and ends `receipt-exhausted` or `timed-out` at its deadline. **As an origin** it refuses new
  recipients' `v3` controls on `rtc`; under `rtc-with-ws-fallback` its send completes over `ws` through the server's
  `receipt.v1` after the RTC receipt budget, about 8 s (`receipt-exhausted-fallback.ts:28-31`); under `rtc` alone it
  fails at its deadline; and a server NACK reads to it as a timeout. A Director command to an old-build director
  reads `failed` though delivered. No migration code.
- **Stored rows.** A control history written by the previous build holds `v2` payloads the `v3` decoder refuses
  (`al-admission-value-validation.ts:72-89`), in a browser's durable lane and in the server's store. Under the
  cutover rule the PR body lists that pending work as discarded; §9 names the lookup.
- **Rolling deploy.** An instance of the previous build refuses `v3` and a new one refuses `v2`, so a receipt whose
  origin and recipient sit on instances of different builds times out for the length of the roll _(inferred)_.

## 9. Risks and open questions

- **The mixed window (S8-R8, §8)** is the largest user-visible cost: while old tabs stay open, receipts that count
  them time out on both carriers. The PR body states it, and the deploy is best taken when rooms are quiet.
- **Stored `v2` histories (§8).** S8-i's first lookup: what a stored `v2` history does under the `v3` decoder in the
  browser's durable lane and in Postgres, and whether the answer is a new `AL_ADMISSION_SCHEMA_ID` and the rows'
  expiry (`controlHistoryTtlMs`) or a typed discard. No tolerant decode is added (D8).
- **The fixture flip (S8-R2, S8-R10)** is the bulk of S8-i: about 90 files, most with file-local builders. Every
  fixture that drives a real origin must register its recipients' keys, or its receipted RTC sends turn
  `unsupported`; pure compute and validate units take the verdict as a literal read fact.
- **Byte stability of the publication proof (S8-R3).** Moving the encoder must not move one byte of a granted frame's
  signing input, or stored signed rows stop verifying; the pin guards it and the move is its own commit.
- **Verification as a cost a peer can impose (S8-R5).** A room peer can make the origin spend one verify per forged
  control that names an owed recipient; the channel's inbound bounds apply _(inferred)_, and whether refusals are
  cached beside the positive verdicts is a plan question.
- **A sign failure (S8-R5).** Leaving a control out must keep the validated bundle valid; whether the hop-end of a
  counted recipient that cannot sign goes unsigned, so its parent's row still completes, is _(inferred)_ and is
  pinned by a unit before the production change.
- **Two pins for the plan.** `isALImpliedNotSubscribedNack` loses its hop conjunct at two owners while the relay
  row's hop bookkeeping keeps `isALHopCompletionAck` (S8-R6); and the frozen keys are the first dispatch's, since a
  `receiver` or `leader` audience never changes after it (FROZEN:220-232; S8-R4).
