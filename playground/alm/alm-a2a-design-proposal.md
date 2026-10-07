# ALM A2a design proposal: the leader ACK and the per-player private event

Release 6, slice A2a of [alm-improvement-plan.md](alm-improvement-plan.md). Written from a code survey of
`main` at `d5db1569d` (A1 merged, #644). The roadmap's A2 row names two mechanisms that share nothing but a
release: a `group-leader` ACK and an exclusive-ownership claim. This proposal takes the first, together with
the per-player private event A1 carried; the claim is A2b, designed after this lands. Completion criterion 7
asks for one documented semantic per ACK mode, proven by the conformance lane over both carriers and
exercised by a game.

## 1. The problem

- `group-leader` is on the wire but means `subtree` (D41): a WS room send asking for it completes on the
  server's own hop ACK, and the RTC origin tests use it as a synonym for `subtree`. No carrier declares a
  leader algorithm, no receipt expects a leader, and nothing refuses a send when the room has no leader.
- The leader exists: the appointed director session lives in group metadata (`rallarDirector`:
  `sessionId`, `principalId`, `epoch`) and both admission points read the full snapshot that carries it —
  the RTC origin's room admission and the WS server's room authorizer. Neither resolves it.
- AR Eye Hunter resolves the director by hand: the relay unicasts intents and sync requests to the
  `appointment.sessionId` it has cached, refuses `no-director`/`stale-director` client-side, and the
  receipt is the director's ordinary ACK. A stale cache or a succession between the read and the send
  addresses the wrong session; the authority never checks.
- A1 carried the Relic per-player private event: the server has no principal publish path and the only
  principal sender is the browser's AI proposal. A hunter's recorded action and a refused command's rule
  text (D72's lost text) reach no client.

What exists and is reused: A1's narrowed room audiences (`RtcAudienceNarrowing`, `isALAudienceSession`,
the room authorizer's `toAuthorizedRoomAudience`, the frozen expected set, roster fence and repair), the
`receiver` receipt aggregate, the ACK and receipt control frames, `readRallarGroupDirectorFromSnapshot`
and `isRallarGroupDirectorSessionActive`, `newALPrincipalBroadcastMessage`, the director relay's typed
statuses, the lane's role and family machinery with `director.appoint`.

## 2. The design, per concern

### 2.a The leader is the room's appointed director, resolved at admission (D164)

A room send with `ack: 'group-leader'` addresses the room's leader: the audience is narrowed to the one
session the group metadata appoints as director and that is present in the room's active sessions at
admission. The narrowing is A1's: `RtcAudienceNarrowing` gains `{ kind: 'leader' }`, one shared resolver
(`resolveALLeaderSession(snapshot)`) reads the appointment and the presence from the snapshot both
carriers already hold, and the audience is frozen with the roster exactly as a principal or list audience
is (D159). The receipt expects that session alone; the leader confirms with its ordinary ALM ACK; the
handle reads `acknowledged`. Succession after admission does not move the frozen leader: the receipt
times out, and a resend re-admits against the current appointment. The epoch is not stamped on the wire;
the appointment at admission is the authority (PD 471: "the authoritative leader for the admitted epoch
confirms").

### 2.b `no-leader` is a typed refusal on both carriers (D165)

When the room has no active director at admission — no appointment, or an appointed session that is not
present — the send is refused `no-leader`: a new `ALDeliveryRefusalReason` arm and a new `ALNackReason`.
The WS server refuses at ingress with the NACK; the RTC origin refuses at its own admission from its
snapshot; both end the handle `rejected` with that refusal. A sender that is itself the director is
refused `no-leader` too: the origin is never in its own expected set, so nobody could confirm. The
refusal is not a fallback trigger (D42 class: the other carrier reads the same snapshot).

### 2.c Carrier parity and the supported shapes (D166)

A fourth receipt algorithm, `leader`, is declared by all three carriers beside `receiver`; `group-leader`
normalizes to it and stops mapping to `subtree`. Supported targets are the room-bounded ones — room
multicast and broadcast, principal and list — and the leader must be inside the audience the sender names
(a list that leaves the director out is `no-leader`). A unicast, `world` or `all` with `group-leader` is
refused `unsupported` (D42). Delivery and confirmation are the same set, so no wire field splits them.

### 2.d The AR Eye consumer: the relay addresses the leader by role (D167)

The director relay's intents and sync requests ride the room channel with `ack: 'group-leader'` instead of
a `{ peerId: appointment.sessionId }` unicast: the authority resolves the director, the receipt is the
director's ACK as today, and `no-leader` maps to the relay's typed `no-director`. The relay keeps its
client-side `stale-director` heartbeat check before sending and its `not-director` check. The director's
own outputs (match started, match ended, pickup accepted) are director-sent and keep
`all-logical-recipients`; the roadmap's "leader ACK on match-critical notifications" is corrected to the
sends a non-director makes to the leader, which are the intents and sync requests.

### 2.e The Relic per-player private event (D168)

The Relic server publishes `relic.hunter.v1` on `room.relic.hunter` to the acting hunter's principal
audience in the room (`newALPrincipalBroadcastMessage` with the room's `groupRef`, `ack: 'receiver'`,
`fanout: 'outbox'`, a 15 s TTL as the snapshot's): after an applied command, the hunter's recorded action
for the round (`{ kind: 'action-recorded', round, action }`); after a refused command, the rule's text
(`{ kind: 'command-refused', command, text }`). The browser reads it through a typed `messages.room`
channel and shows the refusal text where the command's error shows today; the other device shows the
recorded action. This closes D72's lost rule text for the acting hunter's own sessions without a
correlated reply (I1 keeps correlation).

### 2.f The proof (D169)

A lane family `leader-ack` beside `audiences`: `leader-confirms` (the receiver is appointed director with
`director.appoint`; the sender's `group-leader` room send is confirmed by the receiver alone and the
third session receives nothing; `ws`, `rtc`, `rtc-with-ws-fallback`), `no-leader-refused` (after
`director.resign`, the same send ends `rejected` with refusal `no-leader` on `ws` and `rtc`),
`leader-outside-list` (a list that omits the director is refused `no-leader`). The AR Eye relay's unit
tests pin the role-addressed send and the `no-director` mapping; the Relic Deno suite pins both event
kinds; the Relic browser test pins the rendering. Manifests 18 and 22 stay byte-identical (the family
withheld, D148). The server-originated cell is still absent (D153).

### 2.g Carries (D170)

- Exclusive ownership (`ownership: 'exclusive'` as a ResourceInbox-backed claim with `claimed`,
  `held-by-other`, `expired`) is A2b; the roadmap's A2 row splits.
- The leader epoch is not on the wire; a succession between admission and the ACK times the receipt out.
- Heartbeat freshness stays a client-side concern; the authority knows presence only.
- A leader send over RTC still relays through non-recipient room peers (R-A1-26).

## 3. Decisions (2026-10-07)

- **D164** A room send with `ack: 'group-leader'` addresses the room's appointed director session present
  at admission, narrowed and frozen as A1's audiences are; the receipt expects that session alone; the
  leader's ordinary ACK confirms; succession after admission does not move the frozen leader.
- **D165** `no-leader` is a refusal reason and a NACK reason; both carriers end the send `rejected` with it
  when the room has no active director at admission or the sender is the director; not a fallback trigger.
- **D166** A `leader` receipt algorithm declared by every carrier; `group-leader` no longer maps to
  `subtree`; room-bounded targets only, the leader inside the named audience; unicast, world and all are
  `unsupported`.
- **D167** The AR Eye director relay addresses intents and sync requests by role with `group-leader`;
  `no-leader` maps to `no-director`; the director's outputs keep `all-logical-recipients`.
- **D168** The Relic server publishes `relic.hunter.v1` to the acting hunter's principal audience in the
  room: the recorded action after an applied command, the rule text after a refused one.
- **D169** The `leader-ack` lane family over the three carriers with `director.appoint`/`resign`; game
  pins; manifests unchanged.
- **D170** Carried: exclusive ownership to A2b; no epoch on the wire; heartbeat freshness client-side;
  RTC relay through non-recipients.

## 4. Corrections to the roadmap and the product description

- The A2 row splits into A2a (leader ACK and the Relic private event) and A2b (exclusive ownership).
- The consumer row's AR Eye text becomes "the director is the group leader: intents and sync requests are
  leader-acked; the director's own outputs stay all-recipient"; the Relic column gains the private event.
- The product description's `group-leader` paragraph becomes CURRENT with this meaning; the ownership
  paragraph stays PLANNED for A2b.

## 5. Carries: what A2a does not do

Exclusive ownership (A2b); reply correlation (I1); a leader epoch on the wire; any change to the director
appointment command or heartbeat runtime; a server-originated conformance cell.
