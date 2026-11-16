# Grumpy Town Rallar multiplayer implementation plan

> Use `superpowers:executing-plans` for inline implementation and a fresh final
> review. The user requested the plan and implementation together; continue
> without an additional approval stop.

**Goal:** keep the current offline playground and add optional Rallar accounts,
matchmaking, friends/invitations and playable shared matches with an appointed
browser director. Run Rallar locally and provide a phone-accessible trial.

**Architecture:** Rallar Server is the only backend. The app owns town rules and
the browser director simulates every player in one canonical town. Rallar owns
authentication, social consent, matchmaking, room admission and appointment.
Babylon renders accepted state; transport callbacks never invent scores.

**Stack:** existing TypeScript, Babylon, Vite, Rallar browser APIs, Vitest and
Playwright. Use the existing worktree and PR; no separate CCA server.

**Spec:** [architecture](architecture.md), [Grumpy Town](grumpy-town.md), and the
user's request to make multiplayer and social features optional to solo play.

## Global constraints

- Solo opens without authentication or a server dependency; online code loads on demand.
- Retain joystick, dash/drop, zoom, keyboard/mouse and the present town interactions.
- Online scope is `cca-2d` / `default`; preserve complete `GroupRef` identities.
- Initial online boot uses `rallar.setup`; post-login reconnect uses `rallar.start`.
- Use the public matchmaking/friends/room-entry owners, including confirmation,
  cancellation, consent, blocking, errors and lifecycle disposal.
- Two to four players, a ready lobby, three-minute rounds and a 100-point
  qualification target. Several players can qualify. A rematch uses a new match ID.
- Only a server-appointed current director may advance simulation and outcomes.
  Never appoint by writing metadata or trust a host identity claimed in a payload.
- Start with WS-only transport through Rallar room channels: 30 Hz simulation,
  bounded 20 Hz input, 10 Hz state proposals and explicit recovery commitment.
- Input expires after 250 ms; neutral input replaces held controls on pause/blur.
- Recover from a committed checkpoint under a new appointment, or explicitly
  interrupt the round. Never silently restart time or fabricate preserved scores.
- Keep one canonical rule implementation. Do not run the town once per player
  and accidentally multiply cleanup, hazard movement or police timers.
- Every changed file receives full standards closure, including recursively
  changed support files. Independent untouched code remains outside the work.

## Current evidence and ownership

- `apps/cca-2d/src/main.ts` mounts the lazy solo `PracticeApp`.
- `practice-rules.ts` owns player-local movement. `town/rules.ts#computeTownWorld`
  advances one shared town for a human roster; `computeTownTick` is the solo
  projection. A companion exists only when the caller supplies one.
- `practice-scene.ts` owns Babylon resources; online rendering reuses its
  town presentation and renders human actors with peer ice overlays.
- `packages/shared-web/browser/{matchmaking,friends,rooms/entry}` own optional
  authenticated workflows; inspect their focused tests when wiring them.
- `examples/director-relay`, `examples/room-live-channel`, and
  `examples/browser-startup-room` demonstrate transport and entry contracts.
- `packages/shared-web/browser/director` owns appointment and relay validation;
  public code/tests take precedence over historical prose.

## Review focus

1. Room/account switches and logout must fence late social, room and match results.
2. Two accounts must see the same NPCs, damage, scores and remaining match time.
3. Stale or foreign-room input, old directors, repeated dash and oversized input
   must never affect current authoritative state.
4. Host background/close and lost connections must stop unsafe progress, preserve
   committed outcomes and allow only authorized recovery or explicit interruption.
5. Mobile forms and online overlays must remain usable without obscuring gameplay;
   solo must still work when Rallar is unavailable.

## Slice 1 — optional online entry and social lobby

**Owners:** add `apps/cca-2d/src/online/` for session/lobby lifetime and DOM UI;
modify `main.ts`, `practice-app.ts`, Vite/TypeScript configuration and app README.
Tests belong in `packages/tests/cca-game` and `tests/playwright/cca-2d`.

- [x] Add failing visible-flow coverage: solo without server, open online,
      register/login, create/join room, two-account matchmaking confirmation/cancel,
      friend request/accept/block and explicit invitation entry.
- [x] Wire Rallar setup and session restoration behind the optional online entry.
      Render signed-out, connecting, connected and recoverable error states.
- [x] Compose `RallarRoomEntry`, `RallarMatchmaking` and `RallarFriends`;
      expose room creation, joining, account name, roster and invitations.
- [x] Add a same-origin HTTP/WS proxy and start an isolated local Rallar instance.
      Do not expose credentials or change unrelated app configuration.
- [x] Verify the real flows in independent browser contexts and run CCA build
      and focused typecheck. Publish this coherent slice to the existing draft PR.

## Slice 2 — shared town match and director recovery

**Owners:** add `src/match/` for canonical match state/rules, protocol validation,
Rallar lifecycle and accepted-state presentation. Generalize affected `town/`
rules to a human roster without duplicating their single-player implementation.

- [x] Write failing domain tests for shared-world stepping, separate player
      controls/scores, rescues, timer/qualification, ready/start/rematch and stale input.
- [x] Implement canonical roster/town state and fixed-step match simulation;
      preserve the full existing prank, creature, cleanup and authority behavior.
- [x] Use dedicated Rallar director appointment, current roster/session identity
      and room-scoped channels. Validate protocol/build, scope, match, epoch and sequence.
- [ ] Render each player with a distinct identity; show lobby readiness, director,
      countdown, round timer, individual scores, shared danger and multiple qualifiers.
- [ ] Implement acknowledged checkpoint commitment and bounded recovery with
      current server authority. Clear old controls on a new epoch. Missing agreement
      or eligibility produces an explicit interruption and a fresh ready cycle.
- [ ] Add real two-/three-browser tests for movement, shared interaction, rescue,
      timer/results, rematch, disconnect/reconnect and old-host rejection. Keep solo
      and touch controls covered. Inspect phone/tablet/desktop layouts.
- [ ] Run CCA tests/build/typecheck, applicable shared API tests and structure/style
      review. Obtain fresh independent review and fix substantive findings.
- [ ] Update project/app docs and PR; leave local services running with a verified
      phone URL and explain restart, accounts and remaining physical-device limits.

## Acceptance evidence

`npx vitest run packages/tests/cca-game` must pass domain/runtime regressions.
`npm run build --workspace=cca-2d` must pass the app compiler and bundle.
Visible Playwright coverage must exercise real Rallar services with independent
accounts, not mocked network success or query-string-only gameplay setup.
Record live readiness and preview reachability before handoff. Physical phone
thermal behavior and internet-wide networking require separate device evidence;
emulated browser results must not be represented as those measurements.

## Legacy and boundaries

The older `packages/cca-game` cash/banking model and historical CCA server are
independent of this Grumpy Town entry. Do not wire them into the new match.
The existing local bot remains a deliberate solo feature; remove that assumption
from multiplayer paths. New multiplayer rules must consume the current town rules,
not maintain a parallel version. Any Rallar capability gap that blocks the
requested end state must be fixed and tested at its reusable owner.

## Slice 1 evidence and decisions

The first real-server browser tests pass registration/create-room/return-to-solo
and the two-account friendship, invitation, matchmaking confirmation/entry and
blocking flow. No simulated successful API responses are used. Rallar's strict
room reference decoder requires an exact identity projection when inviting; a
room snapshot must not be serialized as an invitation reference. Matchmaking
entry is asynchronous, so assertions await the new room before comparing peers.

Local API and WebSocket public hosts must agree. The dev client now uses an
explicit API URL rather than pretending a differently configured proxy host is
the advertised API. Local Rallar startup generates ephemeral secrets without
writing them to source or printing them. Secure LAN phone access remains part of
the final serving work, not an already verified property.

Ownership lifecycle is explicit: leaving transfers ownership to another active
member, or archives the temporary town when its last member leaves. Room switches
resolve that departure before entry; sign-out still clears authentication if
departure fails. The lobby excludes departed memberships. Real two-account tests
cover ownership transfer and final-member closure, and returning to solo cancels
an active matchmaking search. Test Rallar uses port 18084 independently of the
user's local server on 8084.

Fault coverage now includes server-committed friend and matchmaking mutations
whose replies are lost, an in-flight search reply held while returning to solo,
and a failed matchmaking read. Explicit retry controls retain request identity.
The session resolves pending search work before cancellation; a missing view is
refreshed and persistent uncertainty is reported. Solo mounts without waiting for
network cleanup, while the next online session waits for that cleanup to finish.

The first match preparation separates `PracticePlayer` and its movement/dash
step from `TownState`. Solo still composes them through the same town rules. A
regression proves two player inputs advance independently without advancing or
copying the shared town. This does not yet implement the multiplayer world step,
director, match lifecycle or recovery protocol.

Local validation for this increment: 67 CCA rule tests, the production build,
five real-server online workflow/fault tests and eight phone/desktop control
checks pass. The earlier full browser pass also covers the police cycle and
all three spectacles. Independent review of the online slice found no remaining
substantive findings after the retry/cancellation fixes. This evidence does not
establish shared gameplay or physical-device networking.

## Shared-world preparation

Police targeting, proximity rescue, shopkeeper pursuit and animal attacks now
have canonical roster rules. Solo uses those same rules through its explicit
player/bot projection. Guard warnings retain a target identity through roster
reordering; a departing target cannot redirect a hit to another player. Rescue
progress belongs to one rescuer and target, and simultaneous helpers cannot
duplicate the completion bonus.

Shopkeepers remember the witnessed culprit and apply penalties to that player's
score. Each owner advances once for the whole roster, so adding players cannot
speed up a repair. Animal attacks splash all exposed players once and retain the
provoker's identity for collateral rewards. Departed provokers do not transfer
their reward to another player. Ties use stable identity ordering.

The canonical world tick now composes those rules with all existing prank sources,
personalities, spectacles, pickups and individual scoring. Player interactions
run in stable identity order; debris, residents, animals, firefighters, cleanup
and authorities advance once. Competing players cannot collect the same pickup or
earn the same fresh-source reward twice. Fire witnesses retain the culprit's
identity. Shared bombs and café streams affect every exposed human, respecting
cover and washing immunity. An absent solo companion is neither simulated nor
rendered. Obsolete single-player phase wrappers were removed; the live solo
entry uses the shared-world implementation.

The raid milestone is a cooperative tuning choice: each participant receives +50
once when the shared alarm starts. Ordinary prank rewards and owner penalties
remain individual. Rescue reward eligibility resets at the new raid. The town's
score is the aggregate; match results use each player's score.

## Match rules and remaining integration

`src/match/town-match.ts` owns the pure lifecycle: a one-to-four-member lobby,
session-specific readiness, two-to-four ready players to start, a three-second
countdown, 30 Hz fixed steps for three minutes, a 100-point qualification target,
multiple qualifiers, and a fresh identity/readiness/world on rematch. The default
roster transition interrupts countdown/play explicitly. Recovery now has a separate
transition for at least two original participants: it preserves the confirmed town,
clock and all round scores while rebinding the active controller sessions. Empty
membership interrupts; empty creation and rematch remain invalid.

`src/match/match-input.ts` validates the current member/session, advancing input
sequence and bounded movement/dash values. Input expires 250 ms after the
host's receive time. Callers must keep the sequence watermark after movement
expires and clear volatile inputs when authority changes. Client timestamps must
never extend input lifetime.

Read-first map for this increment:

- `practice-rules.ts#computePracticePlayerTick`: player-local movement and dash.
- `town/rules.ts#computeTownWorld`: ordered pranks, then one world advancement.
- `town/authorities.ts#computeTownAuthorities`: shared raid, police and rescues.
- `match/town-match.ts#computeTownMatchTick`: countdown, fixed step and results.
- `match/match-input.ts#computeTownMatchInput`: validated receive-time controls.

Keep this in the existing draft PR: the world refactor and its solo projection
must be reviewed together, and the match rules consume that same implementation.
The removed phase wrappers have no remaining production consumers. No public
Rallar package contract changed.

The live integration below exposes these rules through the lobby, appointed
director, room channel and shared rendering. Domain checks and solo browser
regressions alone do not prove those integrations or physical phone networking.

Current local evidence: 84 CCA rules tests pass, including a full 5,400-tick round;
the CCA build and all 12 affected gameplay browser tests pass. Independent world
and match review is closed after the empty-roster interruption fix. The new
regression failed before that fix and passes afterward. This does not establish
networked match authority or recovery.

## Checkpoint protocol boundary

The match protocol now has explicit build/version, complete room scope, current
server appointment epoch and authenticated sender checks. A player cannot name a
different controller in a controls message. Proposal, commit, start and rematch
messages require the appointed session; readiness and acknowledgements require a
current player session. The live runtime consumes this app boundary through the
Rallar channel subscription; the boundary's unit tests alone do not prove networking.

Snapshots have an exact bounded schema for every town/player state variant,
fixed-map identity checks, phase/clock consistency and result consistency. SHA-256
binds acknowledgement identities to the exact serialized snapshot bytes. Parsing
restores semantically absent fields without inventing a solo companion. Finished
results survive the last current member departing. Position-only projections at
the cleaner target and spectacle origin prevent local structural subtype fields
from leaking into the wire contract.

`TownMatchCheckpoints` retains one pending proposal and one committed checkpoint.
The current participant sessions are the frozen acknowledgement set. Every session
must acknowledge the same digest and sequence, and the director must publish a
commit. A commit arriving before the final acknowledgement remains provisional.
Duplicates cannot reopen committed work; an outstanding proposal cannot be
silently overwritten. Match phases and confirmed time cannot move backward.

On a new appointment or participant set, the current pending agreement is discarded
while committed presentation remains available. One verified old-director proposal
is retained separately as a bounded recovery candidate. Current surviving sessions
must agree on the selected recovery identity before new countdown, gameplay or winner confirmation.
Without agreement, an explicit interrupted outcome remains possible. The runtime
must bound recovery/retransmission, preserve authenticated source identities,
recheck authority after asynchronous hashing, and retain input/message sequence
watermarks. The agreement owner alone does not implement those network effects.

Requiring all selected session acknowledgements is an initial conservative
choice: a slow peer can delay confirmation. Retained round participants/results
are separate from connected transport members and active controller seats.
An observer remains a checkpoint recipient and backup but cannot send controls
or participate in town interactions. The host-close trial proves one continued
three-client recovery path; the separate seat-grace trial below covers reopening.

The live integration below now supplies appointed-director/channel wiring and
shared gameplay UI. Remaining outcomes are loss/reordering/recovery with real
browsers and secure phone serving. Do not broaden into another content expansion.

Validation for this boundary covers complete-round snapshot round trips including
fire, bomb, vomit and police, malformed snapshots, scope/session/epoch rejection,
digest changes, delayed/duplicate commitment, terminal departure and recovery
agreement. No multiplayer browser claim follows from these domain tests.

Current boundary evidence: 100 CCA domain tests pass serially; the app build,
focused test typecheck at the app's ES2024 target, and the real touch fire-response
browser test pass. Review regressions cover empty finished membership, invalid
phase clocks, premature successor winner confirmation and a fresh committed lobby
starting after authority changes. The parallel police-cycle timeout passed in
isolation and serially. The local API and preview are reachable; secure physical
phone multiplayer remains unverified.


## First live shared-match integration

The optional lobby now creates a room-owned `TownMatchSession`. **Host match** uses
Rallar's dedicated appointment endpoint; **Ready** and **Start round** drive the
canonical lobby and countdown. The Babylon scene renders a ready first frame in
the lobby before enabling Ready, and remains mounted through the round/rematch.
This keeps scene loading off the countdown/checkpoint critical path. The unchanged
countdown scene redraws only for preparation, a new match or zoom changes; live
play renders normally. In the same profiled software-WebGL test, this reduced
start-to-playing from 9.684 seconds to 3.465 seconds without changing the eight-second
acceptance limit. This is a local test-host comparison, not a phone frame-rate claim. `TownMatchSimulation` owns the director's fixed-step
clock and expiring input. `TownMatchGame` renders committed town snapshots and human
peers through the existing Babylon scene, including visible peer ice and a terminal
screen with an exit for every player. Solo remains independent.

The WS channel uses the `app.cca.match` topic with complete room scope and authenticated
session identity. An authority relay provides heartbeats. Proposal hashing is fenced
after asynchronous work; repeated known proposals avoid redundant hashing. Pending
and committed checkpoints are retained for retransmission. Ready/start/rematch intents
retry until committed state confirms them. Input sequences survive expiry, and blur
or visibility loss clears the runtime's input directly rather than waiting for another
render frame. Speculative simulation stops two seconds beyond confirmed progress.

A same-director newcomer produces an explicit interruption from committed state,
never speculative scores. Current roster adoption discards the outstanding
proposal into the bounded recovery candidate; it does not wait for peers that
may already have adopted the new roster. Surviving prior holders reconcile the
selected checkpoint, then the new roster acknowledges the interruption.
Scene preparation is invalidated by match/participant changes and resizing.
Gameplay input listeners exist only while the game is visible, so the lobby remains
typeable. Graphics-context loss revokes readiness and offers a leave/rejoin path.
A late joiner sees the interruption and can leave;
the director can create a new lobby. Host-succession evidence is recorded below.

Real browser evidence now covers separate accounts, create/join, server appointment,
ready/start, a wall-time countdown, shared movement, dash, neutral input on blur, a
third player's late join, terminal exits and a new ready cycle. Two final repeats
pass with host-first scene preparation and actual typing in the lobby. A real WebGL
context-loss test verifies readiness revocation, room exit and return to solo. The phone-size
[capture](visual-concepts/rallar-match-phone.png) is actual gameplay. Focused simulation
regressions cover fractional clock accumulation, bounded unconfirmed progress, input
expiry under replay and foreign-session/old-round refusal. These checks do not prove
physical-phone performance or three-minute results.

A focused impaired-network trial now drops one peer's outgoing match messages
while leaving its Rallar connection and authority traffic alive. After 1.5 seconds
without a new committed checkpoint, both clients show a confirmation pause and
the director pauses speculative time. Checkpoint retransmission continues; restoring
the missing acknowledgements resumes the same round. Device input during the pause
is discarded, held keys require release and a fresh press, and published dash
identities do not rewind during a temporary pause. An authority generation change
instead rebases the dash counter to the restored checkpoint, discarding unconfirmed
pre-loss actions. `TownMatchControls` owns that translation independently of rendering.

Static inspection also found that the browser's default room-presence lease is
120 seconds. The appointment policy refuses fallback while an owner/admin session
remains active. A socket-close cleanup may remove that presence sooner; a suspended
page with a live socket is a different failure. Do not substitute the four-second
director heartbeat timeout for server authorization, shorten leases through an
app-local heartbeat loop, or claim background-host recovery from the temporary
message-loss test. The socket-close path is now verified below; the live-socket
background path still needs a real lifecycle trial.

## Host succession and bounded interruption

`TownMatchRoom` owns exact room refresh, the authority relay and eligible appointment.
It uses Rallar's existing server eligibility policy and bounded operation options;
it never appoints by local election alone or grants room-admin privileges. A room
read has a one-second timeout so a hung request cannot indefinitely hold the local
ten-second recovery deadline.

The match snapshot now retains original participants separately from currently
active controller sessions. Departed players stop moving and interacting while
their confirmed score and result identity remain. This changes the trial wire build
to `grumpy-town-v2`; older trial clients must reload. Rallar's public contracts do
not change.

Unscheduled host closure can leave one survivor with checkpoint S committed and
another with S verified but still pending. Recovery reports therefore distinguish
committed checkpoints from supported candidates. A current peer's commit witness
can select only an exact locally verified retained proposal (epoch, sequence and
digest); arbitrary newer states are refused. All current controllers must then
support that source, with at least one commit witness, before a new-epoch proposal
can resume play. Presentation does not promote the candidate until the new director
and all current controllers complete ordinary checkpoint commitment. This is an
authenticated crash-recovery protocol for the unranked game, not protection against
colluding players or a dishonest appointed host.

Selecting a newer candidate invalidates an incompatible pending interruption.
Timeout results derive from the selected source rather than rewinding its clock or
score. A second appointment retains a newer verified proposal only when it advances
valid state; an older terminal proposal cannot replace the better candidate. Exact retained rematch identities can reconcile
across the old terminal/new-lobby boundary. An old round's local deadline cannot
interrupt the next lobby. Authority mismatch immediately keeps the UI paused, and
asynchronous proposal work is retained for retransmission only if it actually
became the pending checkpoint.

Real three-browser coverage closes the original host, verifies one surviving
appointed director and backup, and continues the same match identity with shared
movement and advancing time. Earlier repeated trials exposed divergent checkpoints
and motivated the witnessed-candidate protocol above. The strengthened test now
deliberately drops one survivor's commit and holds the next host digest, verifies
that the survivors display different confirmed ticks, then closes the host. Both
survivors agree and continue; this passes with the final candidate-selection rules.
Two-player coverage separately loses the host and
the only backup: both cases pause, then show an interrupted round with unchanged
confirmed score/time and a working exit. A prolonged message outage followed by
restored traffic permits an explicit rematch, never automatic resumption of the
interrupted round. Another test holds the authoritative room GET and verifies that
the local deadline still expires.

All eight match browser scenarios passed before the final repeated-appointment
selection refinement. The strengthened host-loss case and newcomer race pass after
that refinement. Focused checkpoint regressions verify late witnesses, invalidation
of old interruption proposals, repeated appointments in both progression directions,
rematch agreement and preservation of committed presentation until new agreement.
CPU-contended timing failures were inspected separately; a passing retry alone was
not treated as resolution of the earlier checkpoint divergence.

Final focused validation for this increment: 112 CCA rules and 28 shared Rallar
appointment/relay checks pass, along with the production build, changed-test
typecheck and scoped structure/style review. A rules timeout during competing
browser work passed when the suites were run without that contention. These
results qualify this recovery increment, not the remaining release requirements.

A missed-commit/newcomer regression holds the next browser digest, drops one
checkpoint commit, joins a third player, then restores traffic. All players must
agree on the roster interruption and enter a new ready cycle. Removing periodic
same-epoch committed-identity retransmission makes that regression fail. Resending
the identity lets a lagging peer settle its pending checkpoint even after the host
has changed roster and discarded the old proposal bytes.

### Confirmed seat grace and browser reopening

Round state now carries mandatory seats alongside retained participants and
connected members. A missing controller becomes away with an absolute ten-second
deadline; repeated observations and handovers retain that deadline. Returning
before it expires rebinds the authenticated session and retains points. Expiry,
or an observed voluntary departure, makes the seat an observer until rematch.
Absent and observer characters do not move, collect, rescue or attract NPCs.
Their confirmed scores remain available for results. A fresh round resets seats.

Recovery agreement comes from at least two current sessions that belonged to the
selected checkpoint, including the appointed director. A returning browser cannot
claim to have held state from its absence. It receives the new proposal and must
acknowledge it alongside the surviving sessions before that state is committed.
Observers still acknowledge checkpoints; application availability independent of
room presence remains necessary for backgrounded or silently disconnected tabs.

The full reconnect run exposed an obsolete roster-adoption delay: a host could
wait for an old-roster proposal while a peer had already adopted the new roster
and rejected it. Immediate roster adoption now uses retained-candidate recovery.
The same recovery rule handles genuine newcomers from the selected checkpoint,
so a newer recovery source cannot leave an older interruption waiting to publish.
Both the browser deadlock and selected-source rule have regression coverage.

Three real-browser scenarios now cover close/reopen/rejoin within grace, return
after expiry, and immediate return after the visible Leave town action. They
verify the same round continues, active movement returns only within grace, and
observers see the live clock with controls hidden and their position unchanged.
Phone-sized active and observer screenshots were inspected. Rule and snapshot
tests cover retained nonzero scores, stale-session input rejection, exact deadline
expiry, rematch reset and invalid seat records. The trial wire build is now
`grumpy-town-v3`; all players must refresh together.

Deadlines use the appointed host's epoch clock, preserved in confirmed state;
cross-device clock skew is not yet qualified. These tests establish fresh-page
reopening, not same-page transport recovery. Same/new-session network reconnect,
stale host return, physical backgrounding, shared rescue/full-round browser results
and secure phone access remain required before release.

### Same-page recovery investigation

Additional browser trials close both socket endpoints, wait for the surviving
players to confirm absence, block replacement sockets, and then disable HTTP.
Chromium's offline toggle alone did not close the existing socket; applying it
before socket closure also prevented prompt server close observation. These
trials therefore distinguish an observed disconnect from silent network loss.

Individual active and observer returns succeeded, but repeated runs exposed a
lifecycle gap: `OnlineMatch.reconcile` disposes the match when presence temporarily
removes `currentRoomRef`, losing the paused screen and its confirmed points.
Simply retaining that session is insufficient: its local interruption marker can
keep an accepted observer paused, and Leave town currently relies on the missing
current room. Missing snapshots can also represent authoritative revocation, so
they cannot automatically count as temporary outages. The first retention change
was withdrawn after this review; same-page recovery is not qualified yet.

The next repair must keep confirmed results accessible, distinguish recoverable
selection from departure/revocation, make explicit leave work for the retained
room, and reconcile local interruption with newly committed observer state.
Rallar's selected-room recovery remains the presence owner; do not add a parallel
app rejoin loop. Browser assertions compare returned position with the host's
retained absent-player position and retain a pre-disconnect dash baseline.

Transport retry backoff is independent of the ten-second seat grace. A successful
expired-return trace took about twenty-one seconds after restoring access; the
test permits forty seconds to cover the configured reconnect backoff and request.
Neither those individual passes nor emulation establish reliable repeated
recovery, silent-loss behavior or physical-phone performance.

The next two useful outcomes remain concrete:

1. Complete match reliability: delayed/dropped checkpoint traffic across rematch,
   shared prank/freeze/rescue and full results, stale authority, two-player interruption,
   and three-player host succession with a surviving committed backup. Preserve the
   original acceptance criteria above; retained participants and active controllers
   must be separated when continuing after a departure.
2. Deliver and qualify the phone trial: secure LAN access with matching Rallar public
   origins, responsive phone/tablet/desktop controls, lifecycle cleanup and an actual
   phone hosting check. Keep the PR draft until release evidence supports readiness.
