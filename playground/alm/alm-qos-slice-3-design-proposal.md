# ALM publication QoS Slice 3 design proposal: restricted RTC parity (S3-i, S3-ii)

Slice 3 of the [publication QoS and pub/sub addendum](alm-publication-qos-addendum.md) (§7 "Restricted RTC
parity", §5.3), after S2-ii (#750, `5b1c4fcf6`). Written from three read-only surveys of `main` at `5b1c4fcf6` (the
RTC data path; identity and authority; the harness and its proof gaps), re-checked against the code, and from the
controller's ruling sketch. Every decision is **proposed** for the maintainer's ruling, S3-R1–S3-R12, recommended
option first; the maintainer ruled S3-R1–S3-R12 on 2026-11-03, each on its recommended option. Five correct the sketch where the code contradicts it (S3-R2, S3-R3, S3-R4, S3-R6, S3-R8) and two
are added (S3-R6, S3-R7). Slice 3 lands as two pull requests (S3-R12). Decisions are D512–D523 in the roadmap's
decision record, entered at the close; "As applied" notes are added at each close. This file is deleted with
S3-ii's close.

## 1. The problem and the scope

§5.3 asks RTC to authenticate a restricted publication's original publisher across relays with an end-to-end
proof bound to its identity, payload, target intent, ordering/QoS metadata, resource scope, session, topic,
expiry and authority generation, under bounded current authorization; to keep origin, application delivery and
overlay forwarding separate; and to provide confidentiality or declare it outside the promise. Until then a
granted topic is `unsupported` over RTC (D491, D500). Today:

- **Only the immediate hop is authenticated.** Peer id is the auth `sessionId`
  (`websocket/targets/create-ws-server-target-resolver.ts:38`; `browser/rtc/initialise-browser-rtc-runtime.ts:225-226`);
  DTLS fingerprints reach a peer only through the server's authenticated signaling relay
  (`communication/install-rtc-signaling-ws-topic.ts:89-92, 118-131`), whose `token` is the placeholder
  `'NOT_CREATED_YET'` (`initialise-browser-rtc-runtime.ts:227`). Origin must equal the peer only on WS and RTC
  unicast (`alm/inbound/read-al-inbound-message-authorization.ts:42-48`). A relayed copy's `id.senderId` is an
  unsigned claim checked as a live member (`multicast/rtc-room-snapshot-admission.ts:139-159`), and the overlay-edge
  check runs only when `fromPeerId !== senderId` (`:245-246`).
- **The envelope carries no proof.** `ALMessage` v4 (`al-contracts/al-contract.ts:12, 159-176`) has no signature,
  and the one decoder refuses an unknown section `malformed` (`al-contracts/al-message-persistence-validation.ts:31-44, 90`).
- **No peer-verifiable credential exists.** Every MAC has a server-held key (`auth-credential-issuer.ts:7-48`;
  `topology-mutation-authority-proof.ts:5-49`); nothing signs asymmetrically (no `generateKey|ECDSA|Ed25519`).
- **RTC knows no grant.** The carrier has no topic or grant refusal (no `grant|participation` in
  `packages/shared/multicast`); the refusal is the browser dispatch's (`browser-rallar-message-dispatch.ts:318-326`)
  and the typed channel's (`browser-typed-message-channels.ts:163-172`). The granted-topic set is server-side
  (`websocket/room-publication/ws-granted-topic-set.ts:1-15`), so `messages.rtc.send` on a granted `topicId` resolves
  `access: 'members'` and is carried (`browser-rallar-messages-controller.ts:109-110`;
  `to-browser-message-send-defaults.ts:55-60`), and no receiver drops it (`browser-rallar-message-subscriptions.ts:191-218`).
- **Browsers see grants, not subscriptions.** `publicationGrants` rides the snapshot (`api/group-types.ts:296`);
  subscription rows never do (D504, D508; `api/group-state-delta.ts:36-53`).
- **RTC repair keeps no captured audience.** `admittedAudience` and `admittedConnectionGenerationIds` appear nowhere
  in `packages/shared/multicast`; repair re-runs room admission (`multicast/web-rtc-overlay-multicast-manager.ts:1047-1096`).

**Scope.** S3-i: a per-page key on the presence row and snapshot; a `proof` section; signing at RTC carrier
admission; verification and the grant check at every relay and receiver; the inference that closes the raw-lane
leak; the lift of `unsupported` for granted room multicasts without a receipt. S3-ii: `not-subscribed` and
receipted sends, repair and fallback under role churn, the relay-only and four-role families over `rtc`.

**What this slice does not do.** Confidentiality (declared outside the promise, S3-R9); signed receipts (ACKs stay
unsigned and relay-re-originated, `al-contracts/al-control.ts:46-61`); granted unicast and broadcast over RTC
(they stay `unsupported` and take WS under every strategy but `rtc`); the topic-policy advertisement (D482's
carry); native hosts' keys; D506's reconnect-presence gap; a hosted manifest (D505).

## 2. What exists and is reused (facts)

`GS` = `packages/shared-server/rallar-system/group-state`; `MC` = `packages/shared/multicast`.

- **WebCrypto in both runtimes.** `packages/shared` already calls `crypto.subtle.digest` (`crdt/crdt-hash.ts:44-57`)
  and AES-GCM behind a check that throws without `subtle` (`crdt/crdt-encryption.ts:448-453`). `packages/shared`
  runs in the browser and Deno and must stay DOM-free; `SubtleCrypto` exists only in a secure context.
- **The presence row is the session's public face.** `GroupPresenceSession` (`api/group-types.ts:210-238`) reaches
  members as `GroupSnapshot.activeSessions` (`:288-297`). `connectPresence` requires the socket's
  `connectionGenerationId` (`GS/group-presence-mutation-command.ts:52-67`); a heartbeat that is not a pure lease
  renewal enqueues summary work and so a delta (`GS/mutation/presence/compute-heartbeat-group-presence.ts:75`). The
  session and summary rows are exact-key (`GS/persistence/validate-persisted-group-presence.ts:22-50`). The presence
  generation is written at join and is not the authority (D503); a reconnect leaves room presence closed (D506).
- **A session outlives pages.** The heartbeat runtime mints a `generationId` per page
  (`browser/session/browser-session-heartbeat.ts:118`), but a group heartbeat reuses the snapshot's generation for
  the session (`refresh-state-heartbeat.ts:159-162`); an auth session lasts 30 days (`defaults-config.json:36`).
- **Browser authority freshness.** A delta applies only on an exact predecessor
  (`browser/state-cache/group-state-delta-application.ts:71, 98, 116-138`); the heartbeat runs every 20 s with a 5 s
  retry (`browser-session-heartbeat.ts:27-28`); a snapshot stays readable 60 s without a delta or heartbeat renewing
  it (`browser/state-cache/initialise-browser-cache-repositories.ts:9-10, 22-23`). A grant write bumps only
  `snapshotVersion` (`GS/mutation/publication/compute-group-publication-grant-mutation.ts:112, 126, 130`); the
  resolver is pure (`api/group-publication/group-publication-grants.ts:118-142`).
- **The RTC refresh.** `not-yet-in-sync` triggers one scoped read and one re-admission
  (`rtc-group-snapshot-refresh.ts:27-48`; `services/web-rtc-rx-streamer-service.ts:221-228`); receive admission is
  asynchronous per frame (`:197-229`).
- **The origin planner is synchronous and re-runs.** `planOutgoingMessage` runs at admission, replan, dequeue and
  hand-over (`MC/web-rtc-overlay-multicast-manager.ts:229-230, 301, 614-623, 1103`), freezes an unfrozen room message
  from the snapshot (`MC/web-rtc-overlay-frozen-audience.ts:83-101`), passes a frozen multicast through (`:104-108`),
  and rewrites `qos.expiry` and `constraints.expiresAtMs` each time (`alm/outbound/to-al-outbound-message.ts:7-13`).
- **Relays clone, never re-wrap.** Only `forwarding`, `constraints.ttlHops` and `diagnostics.visitedPeerIds` change
  (`MC/web-rtc-overlay-multicast-service.ts:80-99`). A session outside the frozen audience forwards and never
  delivers (`rtc-room-snapshot-admission.ts:98-100, 205-211`); an `unauthorized` drop sends no NACK (`:112-117`).
  Inbound dedup is `(senderId, msgId)` (`alm/inbound/al-inbound-canonical-message.ts:71-73`).
- **Topology ignores grants.** The replan fingerprint covers session ids, display name, leader and config
  (`topology/replay/work/rtc-topology-input-fingerprint.ts:70-93`). Below `treeMinSize` 5 the plan is a star whose
  next hops are all other sessions, so no relay exists (`topology/config/group-topology-config.ts:15-17`;
  `topology/planning/compute-no-rtt-topology-next-hops.ts:18-19, 35-44`). An owner can set `treeMinSize` and
  `degreeLimit` per group (`apps/api-v1/src/routes/graph-topology-routes.ts:199`).
- **Templates.** The exclusive refusal (`MC/compute-rtc-exclusive-refusal.ts:7-26`); the relay fixture
  (`packages/tests/shared/multicast/rtc-relay-overlay-fixture.ts:50-123`).

## 3. Decisions (proposed)

### S3-R1. How is the original publisher proven across relays?

- **(a) Recommended: a per-page ECDSA signature verified against a server-attested key.** The browser generates a
  WebCrypto `SubtleCrypto` ECDSA P-256 key pair with SHA-256, the private key non-extractable and held in page
  memory. The public key, a JWK, is registered on the session's presence row (S3-R2) and reaches every member on
  the snapshot. The sender attaches a detached signature over a canonical byte encoding of named envelope fields
  (S3-R3); every relay and receiver verifies it with the key its snapshot names for `senderId`.
- (b) A per-group symmetric key distributed over WS. Rejected: every member, so every relay, could forge any
  original publisher, which §5.3 forbids.
- (c) Server-mediated RTC. No SFU exists (`METERED_SFU_*` are commented out, `apps/api-v1/.env:12-14`) and the server
  never sees an RTC frame; a server-issued per-message token costs a round trip per publication.
- (d) Granted topics stay WS-only and RTC is declared outside the promise. Not parity.

**Why (a).** Only an asymmetric signature lets a peer verify authorship without the server, and the server
already attests `sessionId → principalId` on the snapshot, so it can attest `sessionId → key` the same way. The
primitives are standard in every target browser and Deno (Ed25519 reached WebCrypto later across browsers); the
only design is the signing input. **Cost if wrong:** one asynchronous sign per publication and one verify per
frame per hop, unmeasured; a page without `subtle` sends its granted RTC legs `unsupported` (→ WS).

### S3-R2. What does a key belong to, where is it registered, when does it stop counting? (corrects the sketch)

- **(a) Recommended: one key per page, registered on the group presence row.** Created once at startup, passed into
  the composition, never stored. `ConnectGroupPresenceSessionRequest` and `HeartbeatGroupPresenceSessionRequest`
  (`api/state-types.ts:214, 223`) carry the public key, so a reloaded page registers its new key at its next room
  entry or heartbeat, and a changed key enqueues summary work and a delta. The key leaves the snapshot with the
  presence session (disconnect, cleanup, leave, removal, ban, expiry). A sender signs only when its own cached
  snapshot names its current key; otherwise its RTC leg is `unsupported`. The server checks only the JWK's shape:
  registering another session's public key gains nothing, because `senderId` is signed.
- (b) The sketch: one key per client-state session, rotation as a new session. **Corrected:** the auth `sessionId`,
  which is the peer id, lasts up to 30 days and survives reloads, while a non-extractable in-memory key dies with
  the page, so a reload would sign with a key no row names; client-state rows never reach `GroupSnapshot` (D508),
  and their generation is the socket's (D503).
- (c) A separate `group-state:publication-keys` namespace, D484's pattern. Leaves the presence decoders alone but
  needs its own delete at disconnect, cleanup, leave and ban, a probed selector and a retirement entry.
- (d) The `CryptoKey` persisted in IndexedDB to survive reloads. A stored key outlives the page for no gain.

**Why (a).** The key lives exactly as long as the presence row, so revocation is structural, and peers already
read that row. **Cost if wrong:** the presence session and summary decoders, the public twin and the delta codec
change; S3-i's plan must confirm that rows written before the deploy lapse, else (c). After a reload the sender
is refused until its next heartbeat lands.

### S3-R3. Which bytes are signed, where, and does the envelope version move? (corrects the sketch)

- **(a) Recommended.** `proof = { alg: 'ES256', keyId, signature }`. The signing input is the UTF-8 bytes of a
  positional JSON array of primitives led by the domain tag `rallar-alm-publication-proof-v1`: `id.v`, `msgId`,
  `ts`, `senderId`, `sessionId` (identity, session); `route.topicId`, `resourceId`, `contextId` (topic, scope); the
  targets' `mode`, `GroupRef`, `recipientPeerIds`, `snapshotVersion`, `minSnapshotVersion`, `rosterVersion`,
  `exceptPeerIds`, `principalRef` (target intent; the frozen `snapshotVersion` is the authority generation);
  `constraints.expiresAtMs` (expiry); `ordering`, `delivery`, `actions` and `qos` field by field in a pinned order;
  `payload.typeId`, `contentType` and the SHA-256 of `payload.resource`'s UTF-8 bytes. Absent values are `null`.
  Excluded: the relay-mutable `forwarding`, `constraints.ttlHops`, `diagnostics`; `id.traceId`, `audit`, `proof`.
  A type classifying every `ALMessage` key stops compiling when a field is added. RTC carrier admission signs once,
  after its first synchronous plan froze and normalized the envelope, before storing it; later stages must leave
  signed fields byte-identical (pinned). `proof` is an optional v4 section; absent means a members frame.
- (b) Sign the whole JSON text. Rejected: relays rewrite three fields, and re-serialized JSON is not canonical.
- (c) Bump to v5, the D147/D447 precedent (`packages/shared/alm/inbound/README.md:391-396`). Every envelope would be
  incompatible across builds during a deploy; without a bump only proof-carrying frames are, since an older decoder
  already refuses the unknown section `malformed`, the right answer for a build that cannot verify.
- (d) Separate `authorityGeneration` and `expiresAt` fields in the proof. They duplicate signed envelope fields.

**Correction.** The sketch places the proof on the frame before the carrier; relays do pass frames unchanged, but
the origin's own planner rewrites `qos.expiry` and `constraints.expiresAtMs` at every stage and is synchronous
(§2), so the signature is made inside carrier admission. **Cost if wrong:** a re-plan that changes a signed field
makes every copy fail verification; the idempotent-planning pin is the guard.

### S3-R4. Against which authority, and how fresh, does a receiver admit? (corrects the sketch)

- **(a) Recommended: the receiver's current snapshot, at least as new as the frame.** Admit a granted frame only
  if the signature verifies under the key the receiver's snapshot names for `senderId`; that snapshot grants the
  sender effective `publish` on the topic; it is readable (renewed by a delta or heartbeat within 60 s); and its
  `snapshotVersion` is at least the frame's signed `targets.snapshotVersion`. A snapshot behind the frame, or an
  unknown `keyId`, answers `not-yet-in-sync` and takes the existing one-shot refresh, then drops. A snapshot ahead
  of the frame decides, since newer authority wins; no snapshot fails closed.
- (b) The sketch: the proof's generation must be ≥ the receiver's `snapshotVersion` minus the heartbeat window.
  **Corrected:** that subtracts a 20 s time window from a version counter; no such bound can be computed.
- (c) Evaluate the grant at the proof's generation. Needs grant history; none exists.
- (d) A server read per frame. Defeats RTC.

**Why (a).** It reuses the refresh path and states the bound RTC can prove (§5.3). **Cost if wrong:** that window
is far wider than WS's one in-flight send; an app that needs WS's bound keeps the topic on `ws`.

### S3-R5. What may a relay do that its application may not?

- **(a) Recommended.** Relaying needs what it needs today, active membership and the server overlay edge, and no
  grant or subscription (§5.3: a subscriber-only or publisher-only peer relays). A relay verifies the signature and
  the sender's `publish` before forwarding and drops a failure `unauthorized` without a NACK. It delivers to its own
  application only with its own effective `subscribe` and an active token.
- (b) Relays forward unverified and only recipients verify. Cheaper per hop, but a forgery spreads and lands in
  relay stores when the copy is durable (`al-contracts/al-policy.ts:412-420`).
- (c) A relay must hold `subscribe`. Contradicts §5.3 and would make the layout depend on grants, which the
  fingerprint excludes.

**Why (a).** Forgeries die at the first honest hop and never reach a relay's store. **Cost if wrong:** one verify
of latency per hop on every granted frame.

### S3-R6. How does an RTC peer know a topic is granted? (added; corrects the sketch)

The sketch has the sender refuse a raw-lane send on a granted topic; no peer knows the server-side set (§1).

- **(a) Recommended.** A topic is granted at a peer when its own typed channel declares `access: 'granted'` (D500)
  or its cached room snapshot's `publicationGrants` names the topic for any principal. A sender's dispatch, lane
  sends included, then requires its own `publish` and a proof; a relay and a receiver require a verified proof.
- (b) The channel declaration alone. The lane leak stays.
- (c) The topic-policy advertisement. Exact, but a new server surface; it stays D482's carry.

**Why (a).** No new surface, and it only widens refusal. **Cost if wrong:** a granted topic no grant row names
and no channel declares is `members` on RTC, where no principal can publish or subscribe; only a raw listener sees it.

### S3-R7. Whom does an RTC publication expect, and what does its receipt say? (added)

The sender sees grants but not subscriptions, so it cannot freeze WS's intersection (D508).

- **(a) Recommended.** The sender freezes the grant-narrowed audience: live active-member sessions whose principal
  holds effective `subscribe` in its snapshot. A frozen recipient without an active token forwards, does not
  deliver, and answers a terminal `not-subscribed` NACK that the receipt records as outside the audience, neither
  confirmed nor unconfirmed, so the receipt converges on WS's audience, later.
- (b) Granted RTC sends ask no receipt (`ack: 'none'`); others are `unsupported` (→ WS).
- (c) Subscriptions on the snapshot. Rejected by D504 and D508: churn would move revisions and deltas.
- (d) A server read of the audience before each send. A round trip per publication.

**Why (a).** Otherwise every receipted send times out on a granted-but-unsubscribed member, and
`rtc-with-ws-fallback` hands the leg to WS (`browser-message-fallback-controller.ts:35-98`). **Cost if wrong:** a
new NACK reason and receipt class; whether relays carry a downstream NACK to the origin is unverified and is
S3-ii's first check. A dishonest client can only remove itself. S3-i ships (b) as the interim (S3-R12).

### S3-R8. How do fallback and repair stay authorized under role churn? (corrects the sketch)

- **(a) Recommended.** A WS leg in either direction is re-admitted by the server as today (D487, D498). An RTC leg
  is signed at RTC admission; one that cannot be signed is `unsupported` before admission, so the fallback hands it
  to WS at once (`alm/delivery/resolve-al-delivery-fallback-trigger.ts:14-51`). Repair retransmits the stored
  signed envelope and never re-signs; the origin first re-checks its own `publish`, and a responder the requester's
  `subscribe`, in their current snapshots, never widening the frozen audience; every repaired copy is verified as a
  first copy, and an expired one is not sent. Receipts stay unsigned, documented as no authorized-receipt proof.
- (b) The sketch: the RTC plan and repair honour `admittedAudience` and `admittedConnectionGenerationIds`.
  **Corrected:** those come from the WS server's admission (`alm/outbound/al-outbound-message-runtime.ts:139-157,
  200-210`); nothing sets them for an RTC origin. The RTC analogue is the frozen grant-narrowed audience.
- (c) No repair on granted RTC topics. Loses parity for `at-least-once`.

**Cost if wrong:** a relay may serve a repair to a peer whose `subscribe` was revoked after the relay's last
renewal; the receiver's own grant and token check is the backstop.

### S3-R9. Is the payload confidential from relays?

- **(a) Recommended: outside this mode's promise, documented and pinned.** Relays decode the payload
  (`web-rtc-overlay-multicast-manager.ts:226`) and keep a durable forwarded copy, the full message, in their session
  IndexedDB (`al-policy.ts:412-420`; `al-inbound-canonical-message.ts:15-21`). Pins: a forward-only copy never
  reaches the relay's application, and no diagnostic carries `payload.resource`
  (`alm/inbound/al-inbound-runtime-diagnostics.ts:51-63`). An app needing subscriber-only bytes keeps the topic on
  `ws`, where the trusted server enforces the audience.
- (b) Encrypted publication now, from the CRDT AES-GCM keyring (`crdt/crdt-encryption.ts:21-51, 85-127`). It has no
  distribution or membership binding; rotation and revocation are a design of their own.
- (c) Forward-only copies of granted topics stay volatile. Weakens relay repair; a possible later knob.

**Why (a).** §5.3 allows either; (b) is a product of its own. **Cost if wrong:** an app that assumed RTC privacy
leaks bytes to relays; the documents and the `ws` advice are the guard.

### S3-R10. How is it proven?

- **(a) Recommended.** Units for the primitive and the pure admission (forged sender, altered payload, unknown key,
  stale generation, revoked publisher, relay-only peer); the relay fixture for multi-hop cases; `rtc` cells; a
  forged-sender cell through a new sender-side `fault.inject` rewrite action at the data-channel send site
  (`webrtc/qrtc-data-channel.ts:411`), the only lane point that can make a forged frame (fault matchers read only
  `typeId`, `msgId` and control type, `transport-fault-port.ts:34-40`); a relay-only cell whose owner lowers
  `treeMinSize` and `degreeLimit` for its room through the per-group config route; no hosted manifest (D505).
- (b) A five-agent family to reach a tree at the default `treeMinSize`. One more agent per cell for a layout the
  per-group knob already gives.
- (c) The fixture alone for forgery. Leaves the browser receive path unproven.

**Why (a), and what gates.** ALM cells run only in the non-blocking `alm-conformance-observation.yml` at `smoke`;
four-role cells need `full`, which no workflow sets (`package.json:78`): units and the fixture are the blocking
proof, the cells local-lane evidence. **Cost if wrong:** a test-only rewrite action in the harness.

### S3-R11. Where does it live?

- **(a) Recommended.** A generic ECDSA P-256 detached-signature primitive in a new `packages/shared/signature/`
  (WebCrypto only, DOM-free), composed by the ALM proof in `packages/shared/al-contracts/publication-proof/`, the
  pure RTC admission in `MC/`, the browser session (the key) and composition (signer and verifier ports), and
  group-state (the key on the presence row). The server verifies no RTC frame and keeps WS admission as it is. The
  verifier keeps imported keys in a `packages/shared/cache` repository keyed by `keyId`.
- (b) The primitive inside `al-contracts`. It is not ALM-specific, and a reusable mechanism lives in
  `packages/shared` under its own name. **Cost if (a) is wrong:** one more folder in `packages/shared`.

### S3-R12. How does it land?

- **(a) Recommended.** **S3-i**: S3-R1–R6, R9, R11 and S3-R7's interim (b), so the refusal lifts only for granted
  room multicasts with `ack: 'none'`; units, fixture and two-agent `rtc` cells. **S3-ii**: S3-R7 (a), S3-R8, the
  relay-only and four-role families over `rtc`, the documents, and this file's deletion.
- (b) One pull request: one large review across group-state, ALM, the carrier and the harness.
- (c) S3-i dark, without the lift: its lane cells would have nothing to observe.

**Why (a).** Authorship lands on a proven key path before receipts depend on it. **Cost if wrong:** between the
two, a receipted granted send takes WS.

## 4. Contracts (S3-i), sketched

```ts
// packages/shared/signature/ecdsa-p256-signature.ts (generic; WebCrypto ECDSA P-256 with SHA-256; DOM-free)
export interface EcdsaP256PublicJwk {
    readonly kty: 'EC';
    readonly crv: 'P-256';
    readonly x: string; // base64url
    readonly y: string;
}
export interface SigningKeyPair {
    readonly privateKey: CryptoKey; // generated with extractable: false
    readonly publicJwk: EcdsaP256PublicJwk;
    readonly keyId: string; // RFC 7638 JWK thumbprint, SHA-256, base64url
}
// createSigningKeyPair(): Promise<Either<SigningUnavailable, SigningKeyPair>>, Left { code: 'subtle-unavailable' }
// signDetached(privateKey, bytes): Promise<string>, base64url IEEE P1363 r‖s (64 bytes)
// verifyDetached(publicKey, bytes, signature): Promise<boolean>
// decodeEcdsaP256PublicJwk(value: unknown): Either<readonly RallarValidationIssue[], EcdsaP256PublicJwk>

// packages/shared/al-contracts/publication-proof/al-publication-proof.ts
export interface ALPublicationProof {
    readonly alg: 'ES256';
    readonly keyId: string;
    readonly signature: string;
}
// ALMessage gains `proof?: ALPublicationProof` (absent: a members frame); MESSAGE_SECTIONS gains 'proof'; v stays 4
export type ALPublicationProofCheck =
    | 'valid'
    | 'invalid-signature'
    | 'unknown-key'
    | 'missing-proof';
// toALPublicationProofSigningInput(message, payloadDigest): Uint8Array, pure, S3-R3's field list
// signALPublicationProof(message, keyPair): Promise<ALMessage>
// verifyALPublicationProof(message, snapshot): Promise<ALPublicationProofCheck>

// packages/shared/api/group-types.ts
export interface GroupPresencePublicationKey {
    readonly keyId: string;
    readonly publicJwk: EcdsaP256PublicJwk;
}
// GroupPresenceSessionBase gains `publicationKey: GroupPresencePublicationKey | null` (null: none registered)
// api/state-types.ts: ConnectGroupPresenceSessionRequest and HeartbeatGroupPresenceSessionRequest gain
// `publicationKey?: GroupPresencePublicationKey` (sparse: absent on connect → null; absent on heartbeat → unchanged)

// packages/shared/multicast/compute-rtc-publication-admission.ts (pure; relays and receivers)
export namespace RtcPublicationAdmission {
    export interface Input {
        readonly message: ALMessage;
        readonly snapshot: GroupSnapshot | undefined;
        readonly self: Readonly<{ sessionId: string; principalId: string; }>;
        readonly grantedTopic: boolean; // S3-R6, resolved by the caller
        readonly proofCheck: ALPublicationProofCheck;
        readonly ownTokenActive: boolean; // this session's subscription token for (GroupRef, topicId)
        readonly nowEpochMs: number;
    }
    export type RefusalCode =
        | 'missing-proof'
        | 'invalid-signature'
        | 'unknown-key'
        | 'authority-ahead'
        | 'no-publish-grant'
        | 'expired';
    export type Refusal = Readonly<{ code: RefusalCode; logMessage: string; }>;
    export type Admitted = Readonly<{ delivery: 'deliver' | 'forward-only'; }>; // deliver needs own subscribe + token
}
export function computeRtcPublicationAdmission(
    input: RtcPublicationAdmission.Input
): Either<RtcPublicationAdmission.Refusal, RtcPublicationAdmission.Admitted>;

// S3-ii: ALNackReason gains 'not-subscribed' (codec, receipt classification, harness decoder).
// shared-web: a granted channel's subscribe also registers an RTC handler that sees only admitted frames; onRtc and
// sendRtc stay refused; the RTC carrier is constructed with a signer port.
```

## 5. Dataflow, failure vocabulary and freshness

### 5.1 Per path

1. **Registration.** Startup creates the key pair (a Left leaves the page keyless). Room entry and each group
   heartbeat send the public key; group-state decodes it and writes it in the presence write; a change enqueues
   summary work, and members adopt it from the delta.
2. **Sender.** The dispatch resolves the topic (S3-R6), checks its own `publish` and its own key in the cached
   snapshot, and refuses `unsupported` a granted unicast or broadcast and, in S3-i, a receipted send. The RTC
   carrier's admission freezes the grant-narrowed audience (S3-R7), normalizes, signs once and stores; dequeue,
   re-plan and hand-over reuse the stored signed envelope.
3. **Relay.** Decode → room admission → `verifyALPublicationProof` → the pure admission. A Left drops
   (`unauthorized`, no NACK; `not-yet-in-sync` refreshes first); a Right forwards unchanged, delivering on `deliver`.
4. **Receiver.** The same; `deliver` dispatches to the channel's RTC handler, deduplicated with a WS copy on
   `(senderId, msgId)`; `forward-only` delivers nothing (in S3-ii a frozen recipient answers `not-subscribed`).
5. **Fallback and repair.** A refusal before admission, or the post-admission trigger, hands the envelope to WS,
   whose server admits it under D487 and D498 and never trusts `proof`; repair as S3-R8.

### 5.2 Failure vocabulary

Every expected failure is a value: an `Either` Left, an admission plan's drop or NACK, or a handle settlement.
Nothing throws except a programmer invariant (a re-plan that changed a signed field).

| Code                | Lives in                                               | Raised when                                                           |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `missing-proof`     | `RtcPublicationAdmission.Refusal`, drop `unauthorized` | a granted-topic frame on RTC has no `proof`                           |
| `invalid-signature` | the same                                               | the signature fails under the sender session's registered key         |
| `unknown-key`       | the same, after one `not-yet-in-sync` refresh          | `keyId` is not the key the receiver's snapshot names for `senderId`   |
| `authority-ahead`   | the same, after one `not-yet-in-sync` refresh          | the snapshot is older than the signed `targets.snapshotVersion`       |
| `no-publish-grant`  | the same (the existing reason)                         | the snapshot gives the sender's principal no effective `publish`      |
| `expired`           | the existing drop                                      | `now > constraints.expiresAtMs`                                       |
| `not-subscribed`    | `ALNackReason`, terminal per recipient (S3-ii)         | a frozen recipient holds no active token                              |
| `unsupported`       | `ALDeliveryRefusalReason` (existing)                   | no key or no `subtle`; unicast or broadcast; a receipted send in S3-i |

### 5.3 Freshness contract

A relay or receiver decides a granted RTC frame against its own cached room snapshot, which must be readable and
at least as new as the frame's signed `targets.snapshotVersion`; when it is not, one scoped read at that version
runs before the frame is dropped. A revocation, leave, removal or ban is honoured by a peer from the delta or
heartbeat snapshot that carries it: nominally within one 20 s heartbeat, at worst when the snapshot becomes
unreadable 60 s after its last renewal, after which nothing granted is delivered. A receiver's own unsubscribe
takes effect at once; a revoke of its `subscribe` arrives with its snapshot, as above. A sender's view bounds only
liveness: a session granted after the sender's snapshot is missing from that publication's audience. Neither
carrier claims instantaneous revocation, and the RTC bound is wider than WS's.

## 6. Proof, owners and carries

### 6.1 Proof

- **Primitive and proof**: round trip; a flipped byte, another key, a malformed JWK fail; a missing `subtle` is a
  Left; the signing-input golden bytes; each signed field changed fails, each excluded one passes; relay cloning
  and every planning stage keep the signature valid; v4 frames without `proof` decode unchanged.
- **Admission** (`packages/tests/shared/multicast/compute-rtc-publication-admission.test.ts`): every refusal in §5.2;
  an unsubscribed relay forwards only; a publisher-only relay forwards; a snapshot ahead of the frame decides.
- **Fixture**: a forged `senderId` dies at the first honest hop; a pre-revoke signed frame is dropped after
  `acceptSnapshot` of the post-revoke snapshot; repaired copies verify.
- **Group-state and browser**: the key's decode, writes, summary work, removal and delta; an unchanged topology
  fingerprint; the lane leak refused; the receipted and keyless refusals; the public API snapshots.
- **Cells over `rtc`**. S3-i, two-agent: a granted publish delivered with a verified proof; a forged sender dropped;
  a raw-lane send on a granted topic refused. S3-ii: the four-role family over `rtc`; the relay-only cell with
  `publisher-b` as a publisher-only relay; revoke-then-publish; fallback parity; `not-subscribed` receipts.
- **Gates**: `test:unit`, `typecheck`, `typecheck:tests`, `deno task check` and `deno task test` (task permissions),
  changed style and coupling, the medium-scale Postgres gate (presence writes change), `check:browser-bundles` and
  the headless bundle test. Budgets today: `browser/rallar.ts` 283, `rallar-core.ts` 100, `rallar-realtime.ts` 100
  brotli KiB (`packages/shared-web/bundle-budgets.json:1-14`), headless 377 KiB (`headless-bundle-budget.json:2`); a
  crossed budget is raised to the next whole KiB above the measurement and recorded.

### 6.2 Owners touched

In `packages/shared`: `signature/` (new), `al-contracts/`, `multicast/`, `services/web-rtc-rx-streamer-service.ts`,
`alm/outbound/` and `alm/delivery/` (S3-ii), `api/` (presence types, requests, delta, public twin). Group-state's
presence commands, compute, decoders and summary; api-v1's presence validation and OpenAPI; shared-web's messages,
session, composition and RTC runtime; the harness's typed channels, fault port and cells; the documents.

### 6.3 Carries to later outcomes

- **Confidentiality**: an encrypted publication with key distribution, rotation and revocation (S3-R9).
- **Signed receipts**: ACKs that authenticate their logical recipient across relays.
- **The measured envelope**: sign and verify cost per frame and hop, relay depth, mixed WS/RTC under role churn.
- **Granted unicast and broadcast over RTC**; native hosts' keys; a hosted four-agent manifest (D505).
- **The topic-policy advertisement** (D482), replacing S3-R6's inference; **D506's reconnect-presence gap**.
