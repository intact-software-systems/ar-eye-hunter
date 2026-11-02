# Party up together implementation plan

**Goal:** Friends in AR Eye and Relic form a party once, find and enter a game without splitting,
play, and start another game or move rooms together. One PR delivers both games. Execution stays
inline with TDD and a fresh whole-branch review. The maintainer merges the completed PR.

**Architecture:** A scoped PartyService owns durable membership, invitations and leadership through
AppInbox. Matchmaking remains the sole search, deadline, confirmation and matched-room owner.
Group state remains the sole all-or-none admission owner. Browser party state is a projection,
not membership or game authority. Shared React lives only in packages/shared-react.

**Tech stack:** Existing TypeScript, React, Vitest, Playwright, Deno, PostgreSQL and Rallar primitives.
No new dependency. No legacy reader, migration, compatibility alias or duplicate admission algorithm.

## Approved outcome and approaches

The maintainer approved a larger party capability in both games, scoped to each application and
workspace. A party persists across rounds and rooms; it does not travel between games. Its roster
is independent of room memberships and game participants. An invitation or party membership never
admits a room, starts gameplay, or exposes somebody's unrelated room location.

Selected: a durable party composing the existing friends, matchmaking, room entry, Move together
and rematch capabilities. Repeated ad-hoc room invitations would not retain the group. A tournament
is a separate outcome requiring results and advancement, and is outside this delivery.

The maintainer approved keeping each party indivisible and filling remaining seats from the public
queue. A full party proceeds directly to everyone's confirmation. Other defaults below are
implementation proposals for the approved outcome, not additional user rulings.

## Behavior and authority

- One current party per account per application/workspace. Creating a party starts with its leader;
  accepting another party requires leaving the current party explicitly. No automatic switching.
- The leader invites existing mutual friends. Recipients accept or decline explicitly; duplicate
  invitation retries do not duplicate membership. Invitations expire after ten minutes by default.
  A blocked or no-longer-mutual contact cannot send or accept an invitation. Never disclose a
  private roster to an outsider merely because they know a party ID. Invitation lookup slots carry
  their exact expiry. Writes reclaim expired slots while old party records may still retain the
  expired invitation; complete decoding precedes expiry filtering and reads never repair storage.
- Membership persists across reload, disconnect and game completion until explicit departure or
  disbanding. The last departure closes the party and cancels outstanding invitations. Party
  records are not room-owned saves and are not deleted when a previous game room is deleted.
- Present/away reflects existing scoped client presence. Accepting a party makes that scoped
  presence visible to its members; it does not enable account-wide friends online sharing or reveal
  a personal room. Multiple tabs count as one member. Creating or accepting a party requires live scoped client
  presence; that durable principal also fences later leadership recovery against concurrent reconnects.
- Leadership can be transferred to a member. Explicit leader departure transfers to the earliest
  joined remaining member, with ordinal account ID as tie-breaker. A temporary disconnect retains
  membership and leadership; a present member can explicitly take leadership only after the
  previous leader's scoped server presence expires. Reconnect does not reclaim leadership.
- Party capacity is bounded by the game's configured matchmaking player capacity (2 by default,
  configured up to 16). The UI states the limit. No member is silently excluded to fit a game.
- The leader requests a group search. The complete roster is captured as one indivisible search
  unit; absent members are shown and block starting that search. Every account still confirms its
  own eventual match. Party membership is not advance consent to admission or gameplay.
- Existing defaults remain two-minute search and thirty-second confirmation, configurable by game.
  A full party proceeds directly to confirmation. Under the recommended filling policy, a smaller
  party can combine with other whole parties and solo searchers; no party is split. FIFO orders
  units; a unit that cannot fit is left waiting rather than partially consumed.
- Cancellation, decline, timeout, revocation, or a changed party roster before admission ends the
  affected pending match for everyone and releases reservations. No automatic requeue. A new
  search is explicit. Stale confirmations cannot authorize a changed roster. Membership changes
  and final match admission contend through exact observed revisions in one transaction.
- Solo search stays available to non-party accounts. Party members use the party search, or leave
  the party to search independently. One account cannot hold a solo and party search simultaneously.
- After accepted admission, everyone has explicit Enter matched room. Party leadership never
  grants director/Keeper authority. Existing game eligibility, explicit Relic Join expedition,
  director/Keeper start, and rematch readiness remain authoritative.
- Subsequent search keeps the party. Same-room Play again keeps existing consent and start controls.
  Choosing another existing room reuses Move together when party members are present in the source
  room. A dispersed or away party sees the missing members and a refusal; it is never silently
  reduced to whoever happens to be present. Existing source memberships remain after moving.
- The UI prevents departure during an active AR Eye match and requires explicit withdrawal from
  an unfinished Relic expedition. Party membership changes do not withdraw a game participant.
- Uncertain mutations retain their exact request/payload for Retry; reload recovers durable current
  state. Account replacement, disposal and newer requests fence late browser responses.

## Ownership and current reuse

- `packages/shared-server/rallar-system/friends/friends-repository.ts` supplies exact consent reads;
  friendship remains account-wide. Guard the observed consent when admitting a party invitation.
- `packages/shared-server/rallar-system/matchmaking/matchmaking-service.ts` registers the existing
  search and deadline AppInbox operations. `compute-matchmaking.ts` owns pure cohort selection;
  `matchmaking-repository.ts` owns pool/account/finished storage and its first CAS.
- `group-state/mutation/membership/compute-new-group-cohort-admission.ts` and
  `compute-group-cohort-admission.ts` remain canonical new/existing-room admission computations.
- `group-state/move/group-move-service.ts` owns source-presence, destination admission and arrival.
  Party selection must bind the complete party roster, not assume all source-room players are it.
- `packages/shared-web/browser/matchmaking/rallar-matchmaking.ts` owns authenticated search
  recovery, uncertainty and explicit RoomEntry handoff. Reuse rather than clone this lifecycle.
- `packages/shared-web/browser/rooms/move/rallar-room-move.ts` and the existing game adapters own
  safe switching. `RallarRoomEntry` remains the only invitation/matched destination entry owner.
- `packages/shared/cache/synchronous-notifications.ts`, shared `SingleFlight`, `SubscriptionScope`,
  timers and retry classification remain the common mechanisms. No party-local copies.

Party API contracts belong in `packages/shared/api/parties/`; domain, persistence and registration
in `packages/shared-server/rallar-system/parties/`; browser owner in
`packages/shared-web/browser/parties/`; views in `packages/shared-react/party-panel.tsx`.
API-v1 composes and exposes authenticated, rate-limited self-only scoped reads/mutations. All
incoming writes use AppInbox read -> compute -> validate -> write(transaction, computed), one
attempt per delivery, full QueueBox re-entry on conflict. Final state, exact durable result and any
outbox work commit atomically. Clocks/IDs/policy capture bind once at winning ingress.

Use existing RuntimeState storage and strict conditional insert/CAS. Validate complete records,
canonical storage slots, scopes, identities and mirrored lookups before expiry handling. No
read-side repair, unguarded upsert, domain lock or nested retry. Preserve existing matchmaking
record shapes where possible: party membership/search binding is new owned state, not a reason
to retain two matchmaking algorithms or an old-schema decoder.

## Implementation horizon

Only the following two increments are concrete; both belong to the same feature PR.

### 1. Durable party membership and atomic group matchmaking

Create party contracts, pure roster decisions, exact persistence codecs and PartyRepository/PartyService
beside the owners above. Wire API-v1 composition, typed configuration and OpenAPI. Extend the existing
matchmaker to select whole units and fence party membership in the final admission transaction.
Reuse its deadlines, result receipts, account exclusivity and admission writes. Add party-aware
selection to Move together without cloning its admission or arrival implementation.

- [ ] RED: invitation acceptance requires current reciprocal friendship, a live unexpired invitation,
      correct scope, an available account slot and capacity; two concurrent accepts cannot put an
      account in two parties or exceed the last seat.
- [ ] RED: leader departure transfers once, stale roster requests fail, outsider reads reveal no roster,
      expired/corrupt records fail according to their actual contract, and replay preserves exact results.
- [ ] RED: two-person party plus solo players reaches one configured four-player match intact;
      cancellation/roster mutation racing final confirmation admits everybody or nobody. A full party
      does not wait for strangers. Default two-player solo behavior remains unchanged.
- [ ] GREEN: implement each owned operation only after its behavior fails; prove real conditional
      writes and transaction rollback, including final outbox collision, with PostgreSQL integration.
- [ ] Verify affected shared/server tests and typechecks, API Deno checks, focused real API recipe,
      medium-scale and controlled performance comparison. Publish the coherent implementation early.

### 2. Both games' complete party-to-repeat-play experience

Add `RallarParty` and one shared panel, composing matchmaking and entry. Integrate beside Friends,
Matchmaking and Move together in `arena-ui/arena-operations.tsx` and
`game/hud/relic-side-panel.tsx`. Distinguish party leadership from game-start authority. Extend the
existing browser journeys and API black-box recipes rather than replacing them with injected calls.

- [ ] RED: visible create/invite/accept/decline, capacity, leave/transfer, present/away, reload and
      same-request retry; replaced account cannot receive or execute prior party state.
- [ ] RED: both games invite -> accept -> party search -> each confirm -> enter -> explicit game
      participation/start -> finish -> Play again -> second shared game, keeping the party.
- [ ] RED: party moves to an existing room intact after confirmation; outsider room players are not
      silently selected, one denied member preserves everyone, dispersed/away party cannot be split.
- [ ] RED: recover disconnect/leader departure and an ambiguous committed response; exercise real
      search/confirmation expiry plus auth replacement through visible controls.
- [ ] GREEN: integrate the shared owners and game-owned guards; retain test evidence for refused and
      successful paths. Investigate any repeat-play failure affecting this acceptance, including #769.
- [ ] Verify both builds, package typechecks/public API/bundle boundaries, local click journeys,
      hosted release/recipe/browser/scale/performance gates and selected distributed validation. Review
      the complete branch and update PR evidence. No weakening assertions, workloads or thresholds.

## Review focus and closure

Probe invitation revoke/block versus accept, last-seat/two-party races, changed roster versus final
confirmation, stale former-leader command after takeover, and late responses after account or room
replacement. Verify scoped principal/session identity separately from presence and consent. Exercise
multiple sessions for one account without duplicate seats or stolen confirmation.

Review and remediate every changed human-authored file in full. Any support file changed by that
remediation enters closure recursively; independent untouched code stays outside closure. Trace
registration, operation, policy, first guard, exact durable result and after-commit effect. Inspect
all affected legacy and remove unused predecessors; add no migration or compatibility code.

The PR owns delivery evidence. Delete this completed implementation plan in that PR, update product
and architecture docs to the implemented behavior, run delivery readiness once, and wait for merge.
