# ALM R2 design proposal: membership fencing on the roster

Status: decided 2026-10-06 (D143 to D149), the recommended option taken on each under the
maintainer's instruction to plan and execute the next slices from merged `main`; a reversed decision
re-plans its task. Spec: [the roadmap](alm-improvement-plan.md) release map row "5 R2", the
"Releases 4 to 8" outcome row for R2, the consumer-proof row "5 R1, R2", D3, D5, D8, D10, D24, D26,
D34, D35, D43, D49, D50, D56, D96, D142; [the product description](alm-complete-product-description.md)
"Multicast", the envelope paragraph, PC6. Code survey of `main` at `97f6686cf` (R1 merged, #641). The
implementation plan `plans/active/alm-r2-membership-fencing-implementation-plan.md` was executed and
deleted with the close (PR #642).

## 1. The problem

Release 5, R1 is delivered. The release map's next row is R2: "membership fencing consumes
group-state authority: the sender's snapshot supplies `rosterVersion` beside `minSnapshotVersion`; a
receiver delivers only at or beyond that roster with the sender still a member; a receiver merely
behind gets bounded catch-up; the envelope field is renamed to what it fences on and the version
bumps", with the exit evidence "fenced delivery, fenced rejection with typed reason, catch-up then
delivery, both carriers; old envelope versions rejected explicitly". The survey found nine things the
design must settle:

1. **The fence field is a caller-invented number that every receiver refuses.** `ALTargets`'
   multicast shape carries `membershipEpoch?` (`al-contract.ts:42`); the browser accepts it on
   `RallarRtcSendInput` (`rallar-message-contracts.ts:59`), validates it as a non-negative integer and
   passes it to the multicast builder, which writes it onto the targets _and_ into
   `ordering.epoch` (`al-contract.ts:324-334`), so it is also the ordering-track key
   (`al-runtime.ts:73-82`). The inbound validator refuses any message carrying it `unsupported`
   (`validate-al-inbound-message.ts:53-55`), the fallback and peer sends refuse it at validation, and
   no unit test pins the refusal. Nothing can be using it. The WS room send is a `broadcast` target,
   which has no fence field at all (`al-contract.ts:51-60`).
2. **`rosterVersion` exists and nothing reads it.** The server bumps it in one place, always together
   with `snapshotVersion` (`compute-group-membership-write.ts:37-38`), for join, invite, revoke,
   ban/unban/remove/role, transfer, upsert, grant and decline; presence, lifecycle, director and
   layout changes bump `snapshotVersion` only. It restarts at 1 when a group id is recreated while
   `snapshotVersion` continues. It is served over HTTP and in every WS delta, held in the browser's
   `GroupSnapshot` cache, and read by no logic in `packages/shared` or `packages/shared-web`.
3. **The snapshot floor is already stamped on every room send.** `resolveRoomMinSnapshotVersion`
   returns the cached room `snapshotVersion` (`room-state-store.ts:174-186`) and the sender stamps it
   on the RTC multicast and the WS room broadcast alike (`browser-rallar-message-sender.ts:340-417`).
   D26 pins the frozen audience on `snapshotVersion`.
4. **Both receivers already check the sender against their current snapshot.** The RTC receiver
   requires the sender's session active and its member active (`rtc-room-snapshot-admission.ts:80-89`,
   `:182-210`) before the floor (`:93-98`); the WS server's `canSendGroupMessage` requires a live
   session and an active member at admission and again at dispatch
   (`group-message-policy.ts:60-77`, `ws-queue-box-server-inbound-authority.ts:260-281`). The receiving
   WS client trusts the server.
5. **A refused sender learns nothing on RTC and only `unauthorized` on WS.** The RTC receiver's
   `unauthorized` verdict sends no NACK (`rtc-room-snapshot-admission.ts:141`); the WS server's policy
   denial is one reason, `unauthorized`, whatever the cause (`ws-topic-room-authorizer.ts:218-228`),
   which the handle shows as `relay-rejected` (`compute-al-outbound-control-admission.ts:167-185`).
   `ALDeliveryRelayRejection` names `resync-required` and `unauthorized` only.
6. **Catch-up exists and is bounded, but the lane cannot exercise it.** A receiver behind the floor
   refuses `not-yet-in-sync`, NACKs its hop, refreshes the room once with
   `minCausalRevision.groupRevision = floor` and re-admits once (`rtc-group-snapshot-refresh.ts`,
   `initialise-browser-middleware.ts:451-509`); the read returns what the server has, it does not
   wait (`group-state-snapshot-read-through-cache.ts:148-162`). The WS server retains a floored
   admission and retries it every 50 ms; the sender retries a `not-yet-in-sync` NACK 50 ms apart
   up to `maxAttempts`, then `not-yet-in-sync-exhausted` (a fallback trigger); the deadline bounds all
   of it. The lane's `not-yet-in-sync-delivered-after-refresh` variant is a named red and withheld
   from the hosted manifests because no harness step advances the version.
7. **Server-originated publications are not sender-checked.** Relic's snapshot broadcast takes
   `computeServerRoomPublicationAudience` (`ws-topic-room-authorizer.ts:54-69`), which reads the group
   and checks no sender and no floor; the server peer is not a group member.
8. **The envelope version is one literal in four places.** `ALMessageId.v: 2` (`al-contract.ts:10`),
   stamped by the builders and by three server paths; one decoder refuses any other number
   `unsupported` "AL envelope version is unsupported" (`al-message-persistence-validation.ts:78-80`);
   no test asserts it. Persisted multicast targets are strictly field-listed
   (`assert-persisted-al-targets.ts:33-37`), so the rename is a row-shape change.
9. **The consumer proofs name flows that do not exist as named.** AR Eye Hunter has no rounds; its
   match start and end travel as a `notification` over `rtc-with-ws-fallback` through the shared
   director relay (`browser-director-relay-transport.ts:133-155`). Relic announces rounds only as
   server snapshot broadcasts with no `orderingKey` or `seq` (`to-relic-snapshot-message.ts:20-48`),
   and the server's publish path has no ordering support at all.

## 2. The design, per concern

### 2.a Every room send is fenced on the sender's roster (D143)

The sender stamps `targets.rosterVersion` from its cached room snapshot beside
`minSnapshotVersion`, on the RTC multicast and on the WS room broadcast, through the same resolver
that stamps the floor today; both are absent together when no room snapshot is cached, which the
RTC origin already holds `not-ready` (D96) and the WS server authorizes without a floor. There is no
opt-in and no caller-supplied value: the roster is group-state authority, and the product
description's "never on a caller-invented epoch" is the rule. `membershipEpoch` is deleted everywhere
it occurs: the targets contract, the persisted field list, the builder, the inbound validator's
`unsupported` branch, `RallarRtcSendInput` and the typed send options, the input validator, the
fallback and peer-send refusals, the harness's legacy `rtc.send` paths and their tests, and the
coupling registry entry that names it.

Declined: a per-channel or per-send `membershipFence` option (every room send already carries the
snapshot floor; a second switch adds a public surface for a weaker default); a caller-settable
`rosterVersion` (a caller-invented number again).

### 2.b The fence is the roster, beside the snapshot floor (D144)

`rosterVersion` fences membership; `minSnapshotVersion` keeps fencing the snapshot (D26's frozen
audience, S2's floor). Within one group incarnation every roster bump is a snapshot bump, so a
receiver at the snapshot floor is at the roster too and the roster floor costs no extra catch-up; the
field states what the receiver's membership judgement rests on. A recreated group id restarts the
roster at 1 while the snapshot continues: a fenced send from the old incarnation reaches a receiver on
the new one with a passing snapshot floor and a roster behind the stamp for good, so the WS server
holds it `not-yet-in-sync` until its deadline and the RTC receiver NACKs `not-yet-in-sync` until the
sender's retry budget exhausts; nobody can deliver it, and the group it names no longer exists. Declined: fencing on `snapshotVersion` alone (every
director or layout change would read as a membership change); an incarnation identity on the wire
(the sender of the old incarnation is not a member of the new one, which the fence refuses already).

### 2.c Behind, at, beyond: the receiver's verdicts (D145)

Both receivers judge a room send against their current snapshot in this order:

- **Behind the stamp** (`group.rosterVersion < targets.rosterVersion`, or the snapshot floor as
  today): `not-yet-in-sync`, the existing bounded catch-up. The RTC receiver NACKs its hop,
  refreshes once and re-admits once; the sender retries on the NACK schedule, then on its
  acknowledgement-timeout schedule inside the receipt budget, exhausts into the fallback trigger, and
  the deadline ends it. The WS server retains the send at ingress as a pending admission and
  re-authorizes it every 50 ms until the floor is met or the deadline passes, and sends the advisory
  NACK; the sender retries nothing over WS. No new constant and no new wait.
- **At or beyond the stamp with the sender's member absent or not `active`:** the new typed verdict
  `membership-fenced`. The RTC receiver NACKs it to its hop, where `unauthorized` stays silent; the
  WS server sends it as its advisory NACK and refuses the admission with that code, at admission and
  at the dispatch-time re-authorization. The sender's handle settles `relay-rejected` with
  `{ relay: 'trusted-server' | 'peer', reason: 'membership-fenced' }` when it holds no receipt row
  yet, exactly as a trusted-server `unauthorized` does today, and otherwise the hop's refusal lands on
  the receipt (`hop-refused`, `nackReason: 'membership-fenced'`). The RTC drop reason and the inbound
  diagnostic state `membership-fenced`.
- **An absent session with a present member at the stamp** stays `pending` on RTC (presence is not
  the roster); in a roster beyond the stamp an absent session reads as a departure and is fenced, since
  an authoritative snapshot lists live sessions of active members only. The WS server, whose presence
  is its own authority, fences every missing live session. **A session in another scope, an inactive or
  foreign overlay, or a room refusal** stays `unauthorized`, silent on RTC as today.

The verdict is on the roster the receiver holds: a receiver past a later removal refuses while a
receiver at the stamp delivers, which is what "at or beyond that roster" means. Declined: a retained
wait on the RTC receiver (the server already has one; the browser's refresh-and-re-admit is the
bounded form D10 named); a longer sender retry schedule; a new settlement kind (the lifecycle has
`relay-rejected` and `hop-refused`).

### 2.d WS is fenced at the server (D146)

The WS fence is the server's: its cached authority at admission and at dispatch, the roster floor
beside the snapshot floor, `membership-fenced` for the live-session and active-member denials and
`unauthorized` for every other policy code. The receiving WS client keeps trusting the server. A
server-originated room publication (Relic's snapshot) carries no fence: the server is the authority
and its audience read is the roster. Declined: a client-side check of a trusted-server delivery;
fencing the server's own publications.

### 2.e The version bumps once (D147)

`AL_MESSAGE_ENVELOPE_VERSION = 3` is the one constant the builders and the three server stamps read;
`ALMessageId.v` is its type. The decoder refuses any other number `unsupported` "AL envelope version
is unsupported", now pinned, so a `v: 2` peer is refused explicitly in both directions until it
reloads, as the ACK and NACK `v1` ids are. `AL_ADMISSION_SCHEMA_ID` bumps to
`rallar-alm-2026-10-roster-fence` (the persisted targets field list changes) and the browser's
database is recreated as the inbound README's bump policy says; PostgreSQL rows carry no schema id,
and the message deadlines bound the deploy window. `ordering.epoch` is no longer written by the
fence: the track key keeps the field, which no browser API sets after this change (a limit, 2.h).
Declined: a targets-level marker instead of `id.v`; a compatibility window (D3); deleting
`ALOrdering.epoch` (an ordering contract change with readers, not a fence concern).

### 2.f The lane (D148)

A `membership-fence` family in `scenarios/membership-fence/`, three-agent (sender, receiver, and
the existing third role as the roster mover). The roster moves by a self-service leave (the route the
lane's ensure-member already uses): the receiver creates and owns the lane's group (recipient-b starts
after the receiver's connect, so the leaver is never the owner, whose self-leave the server refuses),
only an owner may remove, and a removed member could not rejoin for the next cell.

- `fenced-delivery` (`ws`, `rtc`): a member's room send is delivered and the harness finds the
  room's roster, read over HTTP, on the delivered message's `rosterVersion`.
- `fenced-rejection` (`ws` only): the sender leaves the roster and sends; its handle reads
  `relay-rejected` / `membership-fenced` from the trusted server and neither recipient receives it.
  Over `rtc` the sender re-checks its own room authority on every attempt and no harness step holds a
  page's incoming group-state updates, so a stale fenced frame cannot reach an RTC receiver from the
  lane: the RTC fenced NACK and the peer relay rejection are unit pins.
- `fenced-catch-up` (`ws`, `rtc`): the sender sends with the harness floor `aboveCurrentBy: 1`,
  waits for the refusal's `not-yet-in-sync` NACK (committed over `rtc`; over `ws` its arrival, as
  the sender leaves the server's advisory NACK unhandled), then cues the third role, which leaves;
  the move lifts the floor, and the server's replay of the retained send (`ws`) or a retry inside the
  sender's receipt budget (`rtc`, after the receiver's own refusal) is delivered. The cell proves
  behind, catch-up and delivery on the snapshot floor; the roster floor itself is a unit pin.

`not-yet-in-sync-delivered-after-refresh`, the named red, is deleted: its proof is the catch-up cell.
Hosted manifests 18 and 22 withhold the new family and stay byte-identical; the control-server
fixture models the roster, the fenced refusal and the catch-up. Declined: keeping the red variant
beside the new cell; a new harness command for the fence (the roster moves by the join, leave and
removal steps the lane has or gains in the three-agent family).

### 2.g The consumer proofs (D149)

AR Eye Hunter's match-start notification is fenced by construction: the director relay's
`notification` send carries the director's roster, pinned in the arena director delivery test and
the relay transport test, so a receiver whose roster no longer holds the director refuses it typed.
Relic's "round transitions on an ordering key per round" is a different capability — a server that
assigns sequences per track and serves range repair from its own outbound, which the WS server's
publish path does not have — and lands as its own slice, R2b, planned after R2 from a survey of the
server's outbound. Declined: folding a server-side ordered sender into R2; an app-side opt-in in AR
Eye Hunter (2.a has none).

### 2.h Evidence

- Unit: the `v: 2` refusal; the persisted field lists; the sender stamps the pair from one resolver
  and nothing when no snapshot is cached; the RTC verdicts (behind, at with a removed member, at with
  an absent session, beyond) and the NACK; the WS authorizer and policy mapping, admission and dispatch
  re-authorization; the control admission's `membership-fenced` settlement before and after a
  receipt; the public API snapshot (no new names; `membershipEpoch` gone from the input);
  the AR Eye Hunter pin.
- Lane: the three cells over both carriers, pinned; the fixture; the manifests byte-identical.
- Pins: the ledger, cold, inbound, D55 and checkpoint pins unchanged.

## 3. Decisions (2026-10-06)

1. **Every room send carries `rosterVersion` from the sender's snapshot beside
   `minSnapshotVersion`; `membershipEpoch` is deleted (D143).** Declined: an opt-in option; a
   caller-settable roster.
2. **The fence is `rosterVersion` alone; no incarnation identity (D144).** Declined: `snapshotVersion`
   as the fence; an incarnation id.
3. **Behind the stamp is `not-yet-in-sync` with the existing catch-up; at or beyond it with the
   sender's member absent or inactive is `membership-fenced`, NACKed on both carriers and terminal on
   the handle before a receipt (D145).** Declined: a retained RTC wait; a longer retry schedule; a new
   settlement kind.
4. **WS is fenced at the server; the client trusts it; server publications carry no fence (D146).**
   Declined: a client-side check; fencing the server's own publications.
5. **`v: 3` through one constant, `v: 2` refused and pinned, schema id
   `rallar-alm-2026-10-roster-fence`; the fence no longer writes `ordering.epoch` (D147).** Declined:
   a targets marker; a compatibility window; deleting `ALOrdering.epoch`.
6. **A three-agent `membership-fence` family with three cells over both carriers; the red
   `delivered-after-refresh` variant deleted; hosted manifests byte-identical (D148).** Declined:
   keeping the red variant; a new harness command.
7. **AR Eye Hunter's match-start notification is the consumer proof, by construction and pinned;
   Relic's ordered rounds are slice R2b (D149).** Declined: a server-side ordered sender in R2; an
   app-side opt-in.

## 4. Corrections to the roadmap and the product description

- The product description's "Membership fencing must use an authoritative membership epoch … requests
  requiring membership fencing are explicitly unsupported" becomes the roster fence on every room
  send; PC6's "when requested and supported" becomes "on every room send".
- The API reference's "an RTC send's `membershipEpoch` is the position's epoch" goes with the field;
  the ordering epoch has no browser setter.
- The consumer-proof row "5 R1, R2": the AR Eye Hunter half is the match-start notification (no
  rounds exist); the Relic half moves to R2b.

## 5. Carries: what R2 does not do

- Relic's round transitions on an ordering key per round (R2b: a server-assigned sequence per track
  and server-side range repair).
- A browser API for `ordering.epoch`: no caller can open a new ordering track epoch; a track closes by
  its TTL or the receiver's resynchronization (D142).
- A fence on server-originated publications.
- A receiver-side check of a trusted-server WS delivery.
- A dispatch-time server refusal reaches no handle: as today the server completes the delivery
  without a NACK when the sender left between admission and dispatch.
- A room send the WS server retains behind a floor starts no receipt aggregate (its audience is
  unknown until the replay authorizes it), so its `receiver` receipt never completes.
- A recreated group id: a fenced send from the previous incarnation is never refused with a reason;
  the WS server holds it `not-yet-in-sync` to its deadline and the RTC receiver until the sender's
  retry budget exhausts.
- The lane proves fenced rejection over `ws` and the catch-up on the snapshot floor; the RTC fenced
  NACK, the peer relay rejection and the roster floor are unit pins.
- The lane's roster moves by a member leaving, not by an owner's removal; `removed` and `banned` are
  unit pins.
