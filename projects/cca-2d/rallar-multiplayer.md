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

The local-trial implementation below is complete. Current normal-clock browser
acceptance covers optional social entry, appointed hosting, shared play and
bounded recovery. The maintainer deferred remaining clock integration to
[issue #836](https://github.com/intact-software-systems/ar-eye-hunter/issues/836).
Physical-phone trust, touch comfort and background hosting remain device
qualification work; browser emulation does not establish those properties.
The PR owns release-gate and review status. Earlier implementation evidence below
records the limits at each stage; it is not a list of current missing features.

## Realtime movement revision

The physical phone trial found the 150 ms interpolation buffer smooth but late;
a 50 ms experiment made movement jittery and was rejected. The 150 ms baseline is
restored. Per the user's direction, live controls and compact host poses now use
`rallar.realtime.room(...)` with per-recipient WS fallback. Default Rallar realtime
lanes are unordered, have no retransmissions and use bounded replace-by-key queues.
The app sends the same frame identity on fallback; sequenced input and pose
admission prevent duplicates or older copies rewinding gameplay/presentation.

`TownMatchTransport` owns carrier policy and subscription disposal.
`TownMatchSession` validates room, authenticated sender, match and fresh director
epoch before passing inputs to its simulation or host poses to `TownMatchLivePoses`.
The latter retains one observation for at most 250 ms and never writes checkpoints.
Authority/recovery changes clear it. Confirmed freezes and terminal phases override
live rendering; scores, world effects, results and recovery retain checkpoint truth.
The host publishes at most 20 compact pose frames/second independently of checkpoint
acknowledgements. Controls retain their existing host-receipt expiry and dash counter.
Wire build is `grumpy-town-v6`; reload all clients together.

The first RTC phone trial found remote movement acceptable but local movement
jittery/jumpy and Dash often unresponsive. Local presentation was still bounded
against slow checkpoints. It now uses validated live movement/dash state, blends
small corrections and retains its last newer base through short pose gaps without
renewing prediction time. Confirmed freezes still override it. Dash visibly waits
for both local and host-observed cooldown. Remote interpolation stays unchanged.

The v6 iPhone retest reported responsive local movement and Dash, "the way a game
should feel like." Keep that tuning. The next observed defect was view-dependent
hoodie colors; both render paths now use the canonical retained participant order,
including the local YOU label. The phone color retest was accepted: "I am playing
now and it looks good." The current two slices are (1) reproduce the separate
observed heartbeat-timeout / round-interruption sequence without changing accepted
movement tuning; (2) reproduce the stale lobby roster. Keep deferred broad clock work in #836. Detailed phone
feedback and validation limits remain in [the trial report](babylon-local-trial.md).

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
- Use Rallar RTC realtime room channels first for bounded 20 Hz controls and
  compact host poses, with WS fallback for unavailable peer channels. Keep 30 Hz
  simulation and acknowledged 10 Hz checkpoint proposals for scores and recovery;
  live pose presentation must not wait for checkpoint agreement.
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
- [x] Render each player with a distinct identity; show lobby readiness, director,
      countdown, round timer, individual scores, shared danger and multiple qualifiers.
- [x] Implement acknowledged checkpoint commitment and bounded recovery with
      current server authority. Clear old controls on a new epoch. Missing agreement
      or eligibility produces an explicit interruption and a fresh ready cycle.
- [x] Add real two-/three-browser tests for movement, shared interaction, rescue,
      timer/results, rematch, disconnect/reconnect and old-host rejection. Keep solo
      and touch controls covered. Inspect phone/tablet/desktop layouts.
- [x] Run CCA tests/build/typecheck, applicable shared API tests and structure/style
      review. Obtain fresh independent review and fix substantive findings.
- [x] Update project/app docs and PR; leave local services running with a verified
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

Movement reaches the edge of a solid prop when a step would enter it. Rejecting
the whole step can leave a dashing player outside the interaction radius,
making an apparently direct hit fail at some starting distances. Solo and the
30 Hz director share the same contact rule, so stalls can spill and reward a
hit without allowing players through their solid footprints.

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
Duplicates cannot reopen committed work; ordinary outstanding proposals cannot be
silently overwritten. A follower catching up after socket loss can supersede a
pending proposal only with a strictly newer proposal from its current director.
Match phases and confirmed time cannot move backward.

On a new appointment or participant set, the current pending agreement is discarded
while committed presentation remains available. At most two compatible verified
proposals are retained as recovery candidates: the newest may still be unfinished
while its predecessor was committed by a survivor. Current surviving sessions
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
`grumpy-town-v4`; all players must refresh together. The current revision adds
the bounded display name to each authenticated Ready message.

Deadlines use the appointed host's epoch clock, preserved in confirmed state;
cross-device clock skew is not yet qualified. The later lifecycle trials below
cover silent loss and old-host return. Physical backgrounding, shared human rescue,
multiple-qualifier browser results and secure phone access remain required before release.

### Same-page recovery and local exit

Additional browser trials close both socket endpoints, wait for the surviving
players to confirm absence, block replacement sockets, and then disable HTTP.
Chromium's offline toggle alone did not close the existing socket; applying it
before socket closure also prevented prompt server close observation. These
trials therefore distinguish an observed disconnect from silent network loss.

The game retains the paused match using `rallar.rooms.selected()`, a read-only
copy of Rallar's existing authenticated selection. Temporary absence from the
presence projection no longer disposes the match. Explicit departure and observed
membership revocation clear that selection; an unrelated authenticated session
cannot inherit it. Selection is not permission or proof that a room still exists.
A missing room therefore reaches a bounded interruption with confirmed points
and a local exit. Rallar's selected-room recovery remains the presence owner;
the game adds no separate rejoin loop.

A newly committed observer seat clears a returning player's local timeout, so
the same page can watch the continuing round after grace expires. Returning
before expiry restores control. Browser assertions compare returned position
with the host's retained absent-player position and retain a pre-disconnect dash
baseline, guarding against replay of input pressed while disconnected.

Socket loss also has a checkpoint lifecycle, even when the returning browser
sees the same appointment and final roster. A follower must release unfinished
agreement while preserving confirmed state and bounded verified recovery candidates.
During resynchronization it may accept a strictly newer current-director proposal
over delayed pending work; equal-sequence conflicts remain invalid. A full commit
ends this resynchronization window and restores normal pending-proposal locking.
Retain at most the two newest compatible verified proposals across interruption:
the latest may be unfinished while its predecessor was committed by a survivor.
Either exact candidate needs a current commit witness; an older witness cannot
rewind an already selected recovery checkpoint.
The current host instead retains and retransmits its exact unfinished proposal:
connected peers may still need that identity to settle their agreement. Host
admission and retention of the outbound proposal must be synchronous. A changed
appointment or roster still enters the existing witnessed recovery protocol.
Every socket close invalidates unfinished asynchronous verification and clears
controls; it cannot manufacture confirmed progress or replay an old action.

During recovery, the top exit becomes Back to solo; interruption results also
offer that local exit. It disposes the match immediately and opens solo while
online cleanup settles separately. It does not claim a server-confirmed departure.
Server Leave match is unavailable when the connection/authority is unavailable.
Normal departure resolves the explicitly selected room and reads its exact
snapshot, even when the active-presence projection has no current room.

Transport retry backoff is independent of the ten-second seat grace. A successful
expired-return trace took about twenty-one seconds after restoring access; the
test permits forty seconds to cover the configured reconnect backoff and request.
This observed-disconnect coverage is separate from the silent-loss and suspended
JavaScript trials below; none establishes physical-phone performance.

### Host suspension and return to a replacement

Two-player browser trials blackhole both host socket directions and HTTP without
closing the socket, or pause the host's JavaScript through the debugger while the
guest continues running. The guest retains its confirmed tick and score, then
interrupts. Restoring the host produces the same authoritative interrupted phase
and permits a fresh ready cycle. The recovery deadline accounts for time since
the last confirmed checkpoint before a resumed commit can refresh that timestamp.
An uninitialized confirmation timestamp is distinct from an old one: a reopened
browser accepts its first current checkpoint without inventing an expired recovery
window. Rejoin acceptance waits for that browser's own playable status and controls,
not just the host's status.
The debugger pause proves stalled event-loop recovery, not Safari background behavior.

A three-player trial disconnects the original host until its seat expires, lets
two survivors continue under a replacement, then restores the original page.
The returning player watches the same match with controls disabled and only one
appointed director. Recovery refresh does not preempt an appointed session still
present in refreshed membership merely because the local heartbeat is stale.

Checkpoint recovery retains the local authenticated session identity. A returning
recipient can catch up to the current director's newer proposal without pretending
to have witnessed historical state. Becoming the appointed director disables that
exception: it must still establish recovery agreement. Current epoch, roster,
forward-state checks, all acknowledgements and the director's commit remain required.
Socket interruption survives an intervening authority change, while the continuing
host keeps its outstanding proposal for exact retransmission.

One remaining lifecycle case is a three-player silent outage or suspension followed
by takeover and return without a delivered socket-close callback. The observed-close
return test does not establish that transition; retain it in reliability qualification.

### Silent host loss and opt-in room presence

CCA now selects a browser group-presence policy with an eight-second lease,
one-second renewal interval, two-second whole-attempt deadline and 500 ms retry delay.
Nested requests inherit the attempt cancellation; they do not each receive an
additional time budget.
The policy is captured at connection setup and shared by create/join, quick join,
room moves, invitation acceptance, selected-room recovery and heartbeat renewal.
General browser defaults and the longer authenticated client-session lease remain
unchanged. Existing long group leases cannot be shortened by renewing them; fresh
room admission is required to exercise the short policy.

Renewal bounds cover socket-generation lookup, cache recovery, client renewal,
parallel group renewal and awaited cache observers. The policy validator reserves
time for completion of the previous attempt, the next attempt and one retry.
Each mutation retry preserves its request identity and body. A reconnect receipt
that arrives after its lease expires must be resolved before a fresh request is
issued; it cannot establish live presence merely because its original write
succeeded. Late callbacks are fenced against cancellation and replacement.

For opted-in connections, a missing selected-room presence observation can trigger
recovery without a socket-close callback. The recovery owner checks current durable
membership and the selected room, authenticated session and socket epoch. It never
creates membership from cached selection. An unresolved request belonging to an
obsolete selection or account cannot block the current owner's recovery.

The match treats local presence expiry as a transport interruption and requires
live local room presence before accepting its own outgoing checkpoints. A returning
former director can accept the replacement director's fully committed checkpoint;
a local timeout from an older appointment does not keep that follower permanently
paused. Current-appointment timeout handling and server appointment authorization
remain in force. The app never declares another session absent or promotes players
to administrators to obtain a successor.

A real three-browser trial has demonstrated silent host loss, successor appointment,
continued play and active-seat return with no socket-close callback. The trial
also waits for the old host to show its local interruption before restoring traffic,
then checks unchanged match identity and score, exactly one director after return,
and independent player movement. Ordinary shared controls, old-host observer return
and a same-appointment rematch followed by a second interruption also pass focused
browser checks. The earlier per-request 500 ms bound produced timing failures; the
whole-attempt bound replaces it. Full regression and device qualification remain
required before considering this policy ready for release.

Remaining acceptance includes repeatable takeover within the existing recovery
window, healthy full rounds, same-appointment interruption/rematch, suspended
JavaScript, both refresh-before-renewal and renewal-before-refresh returns,
clock-skew behavior and physical-phone background/hosting qualification. Preserve
truthful bounded interruption whenever authoritative recovery cannot complete.

The subsequent 23-scenario browser run passed 20 cases, including both full rounds,
but failed the same-page observer return and two host-return rematch cases. The
rematch failures exposed a real presentation bug: overlay CSS overrode the hidden
attribute on the former host's button. An explicit hidden-button rule fixes that;
both focused host-return tests now pass and assert that only the successor can
start the fresh ready cycle. The protocol already rejected the former host.

The observer case failed repeatedly when all three players shared one browser
process. Native traces showed substantial software graphics readback waits, but
neither disabling the preserved drawing buffer nor running visible Chromium
fixed that configuration. The buffer experiment was reverted and
temporary profiling removed. These measurements do not establish graphics as the
root cause or qualify the current recovery implementation for release.

A separate, reproduced starvation bug is corrected: a timed-out authoritative
room refresh previously skipped the entire checkpoint exchange. Repeated slow
reads could therefore prevent live peers from agreeing forever. Recovery now
reports that read failure and reconciles current authority before attempting
exchange; fresh appointment, live own presence, authenticated sender and epoch
guards remain mandatory. A real two-browser regression fails before this fix
and passes afterward: with room GETs still stalled, restored WS delivery resumes
the same match, advances its clock and accepts movement. Both missing/stalled-read
interruption-deadline tests also pass.

Further shared-process diagnostics included three failing native-Metal trials;
disabled follower draw calls and a hidden follower canvas also did not resolve
it. Those diagnostic source changes were removed. A duplicate authorized room read
completed in about 23 ms outside the browser, while public browser fetches became
slow. This narrows investigation toward browser-side response processing or
traffic pressure without establishing the cause. The passing starvation regression
does not close observer recovery or justify increasing its deadlines.

With one browser process per simulated device, the same observer-return scenario
passed three consecutive repetitions, retaining the network faults, sixteen-second
seat-expiry observation and forty-second reconnect bound. The disconnection cases
now use independent processes and inherit the configured browser launch options
and trial origin. This represents independent devices more closely; it does not
establish the cause of the shared-process failure or certify physical phones.
The subsequent full online run passed all 29 scenarios, including both real timed
rounds, shared rescue, multiple qualifiers, rematch and the social/account flows.
The separate solo/control run passed all twelve scenarios. These normal-clock
results do not qualify the clock-skew failures below.

The final browser-resource cleanup change also passed all four disconnection
outcomes. Launch failures and diagnostic failures now still close every browser
process already created. The affected unit suite passed 697 tests; final explicit
test-output contract corrections passed 36 focused tests and the focused test
typecheck. These checks do not replace physical-device qualification.

Fresh review found a Quick Join cancellation gap between publication-key lookup
and the presence write. Every presence attempt now checks the captured session
fence; a regression proves that account replacement at that boundary emits no
stale presence PUT. Admission/renewal timestamps and generated group IDs now come
from explicit composed dependencies. Admission captures its lease after the
membership response, while retries preserve their original identity and payload.

The two-second renewal deadline covers sequential client repair/renewal followed
by group renewal. Successful receipt therefore requires the entire path to fit
inside that deadline; two individually shorter requests may collectively exceed
it. The policy budget allows bounded retries, not arbitrary network latency.
On persistent failure the match must pause and interrupt truthfully rather than
pretend the local presence is current.

### Clock-skew acceptance remains open

The new real-server browser cases set one clock two seconds behind and another
two seconds ahead. They require healthy shared play beyond the eight-second
presence lease, propagated controls, bounded interruption after losing the only
partner, and a three-player host handover with one surviving director. All three
failed before Ready appeared at their last run. The maintainer has deferred this
known limitation to issue #836; it is not a skipped or passing test and the local
trial must not be described as fully clock-skew safe.
Fixed offsets do not cover clock jumps or drift.

A bounded wire probe confirmed fresh, active director status in both browsers.
The clock-behind host sent one hundred observed match frames whose absolute
expiry was already four to eight milliseconds before the test machine observed
them; the peer received no match frames. CCA currently gives agreement messages
a two-second transport lifetime and controls 250 milliseconds, while the message
builder stamps absolute expiry from the sender's wall clock. This evidence
identifies cross-clock expiry as the next investigation boundary. Temporary
instrumentation was removed; runtime deadlines were not widened.

Resolve publication/expiry time across server and browser clocks while retaining
bounded stale-control rejection, authenticated room/session/epoch checks, and
truthful interruption when freshness cannot be established. Then rerun the skew
cases and normal-clock recovery suite. Do not merely increase transport lifetimes
or narrow the skew test to hide the failure. The probe also emitted an RTC RTT
measurement-guard error; its relationship to skew needs separate classification
before claiming that all realtime timing paths are qualified.

### Server clock foundation

The next correction starts at the shared timing boundary. `GET /api/time`
returns the configured Rallar server identity and a freshly captured epoch in
milliseconds, with `Cache-Control: no-store`. It requires no account and changes
no persisted state. The browser reader disables caching, captures request start
and complete body receipt with an injected monotonic clock, validates the expected
server identity, and returns explicit HTTP, invalid-response, cancellation or
network failure. It never substitutes the local wall clock after failure.

`packages/shared/resilience/remote-clock.ts` calculates a conservative current
server-time interval from that observation. The policy explicitly bounds sample
age, request duration, relative clock-rate drift and absolute error per monotonic
reading. The full round trip remains uncertainty; the calculation does not assume
symmetric network latency. Millisecond epoch rounding and both endpoint errors
expand the interval. Invalid, stale or excessively uncertain observations are
refused rather than treated as exact current time.

This foundation is not yet connected to message creation, expiry or presence.
The existing clock-skew browser failures therefore remain open. Integration must
use the same server clock domain throughout publication and expiry validation,
refresh before observations expire, and refuse freshness when no valid bound is
available. Expiry validation needs the conservative latest-time bound; publication
must not grant a longer lifetime by using that upper bound as its creation time.
Suspension and server clock steps require invalidation/recalibration rather than
assuming that the rate bound still holds. Multi-server deployments also need a
verified shared clock-domain assumption; matching configured peer names alone
does not prove synchronized node clocks.

Foundation checks cover asymmetric latency, monotonic progression, timer
quantization, invalid/expired samples, wrong server identity, HTTP/body failures
and cancellation. A streamed-response regression proves body-consumption delay
is included; moving the stamp before body receipt makes it fail. The focused
server-time black-box recipe verifies the live route, identity and no-store
response, and is registered in the normal and externally managed API matrices.

Draft CI also exposed seven type errors in the older solo Grumpy-loop tests after
the town companion became optional for shared matches. Those fixtures now assert
the required companion before use; rescue and route assertions retain their
original meaning. This is a test correction, not a change to the solo or online
companion rules.

Tracing the transport found a second clock boundary: the RTC receiver factory
passed its supplied epoch clock to final delivery, but not to inbound admission.
Both now use that supplied clock. A real data-channel regression runs with the
local clock twenty seconds ahead and behind, proves delivery before the supplied
deadline and rejection at the deadline. This closes the receiver wiring gap;
the browser still needs to supply calibrated time throughout transport. A real
authority-refresh callback also advances time to the deadline and proves rejection
on admission re-entry, replacing a test that mocked the runtime prototype.

The WebSocket client factory likewise accepts an epoch clock for both inbound
and outbound runtimes. Its final inbound consumer check now reads the inbound
clock. Explicit creation clocks and supplied stores must use the same epoch
domain; the factory does not restamp already-created messages. Tests with device
clocks twenty seconds ahead and behind prove valid inbound delivery, valid wire
submission and refusal of both directions at the deadline. This supplies another
required calibration seam without changing transport lifetimes or wire format.

`BrowserServerClock` now owns acquisition and retention of a server-time sample
for one connection identity. Concurrent refreshes share one bounded HTTP request;
invalidation cancels the old generation and prevents late results from replacing
the next acquisition. Closure returns even if the underlying fetch ignores abort.
A failed refresh preserves a sample only while its bounds remain valid. Expiry,
observed monotonic rollback or disjoint server-time intervals latch an explicit
discontinuity until the connection owner stops epoch-dependent work and requests
reacquisition. No local-clock fallback is permitted. This lifecycle is necessary
because a correct interval calculation alone cannot prevent a suspended or
cancelled browser from using an obsolete observation.

The lifecycle has direct tests for acquisition, refresh, cancellation, timeout,
reentrant replacement, shutdown and discontinuity. `BrowserServerClockSession`
composes it with periodic refresh and browser visibility/freeze/pagehide events.
Its abort signal ends the connection's calibration lifetime on suspension or lost
clock validity; a new lifetime must acquire a new sample. Consumer reads also end
the lifetime if they discover expiry between refresh attempts. Shared repeating
and single-flight primitives own scheduling and coalescing. The sampler owns
observations; the session owns their eligibility for an active browser connection.

Browser middleware now acquires calibration before constructing stores and
transports. Configuration and time requests use the acquisition's captured API
target. Its clock signal fences subsequent startup, including the final heartbeat
handoff; rollback closes every acquired owner. The transport owns cancellation
from synchronous setup through active use, so disconnect cancels a pending time
request even when fetch ignores abort. A cancelled setup cannot replace a newer
connection or its cancellation owner.

Clock expiry or page suspension closes the active transport, flushes owned
checkpoints before removing page listeners, and retires the session's lifecycle
participants and selected room. The public session returns to idle and the next
connection acquires a fresh clock. Cancellation during participant startup waits
for that notification to unwind before cleanup, preventing later participants
from attaching after an earlier cleanup. The original caller abort reason is
preserved.

The default policy uses a two-second request deadline, a 500 ms maximum observed
round trip, 30-second sample age, 1,000 ppm relative drift and 2 ms monotonic timer
error, with refresh every five seconds. These are explicit operational assumptions,
not physical-device qualification. New browser connections require the updated
server's `/api/time` endpoint; they do not fall back to device wall time when it
is absent. Calibration and carrier retirement bring the full Rallar entry to about 307.1 KiB
Brotli; its budget is 308 KiB (previously 305 before calibration and 307 before
carrier retirement). The narrower entry budgets remain unchanged.

Browser carrier admission now reads the calibrated latest server-time bound.
The WebSocket client uses it for inbound and outbound admission, final delivery,
and room-presence submission checks. RTC uses it for inbound admission/delivery
and the overlay's outbound admission, routing and publication verification. The
volatile inbound/outbound stores and the session's QoS budget use the same clock,
so a valid admission cannot be delayed or evicted by a device-clock queue. Direct
wire and native-channel regressions exercise clocks twenty seconds ahead and
behind and preserve exact-deadline rejection. An expired calibration refuses
further clock reads instead of falling back to local wall time.

Carrier retirement separates strict authority time from work timing. Admission,
expiry and delivery still require a valid calibrated clock. Work scheduling,
queue release and settlement observations use a second clock that follows the
same latest bound while active, including a tighter refreshed bound, then freezes
at the last valid bound after retirement. The frozen value cannot authorize a
new message. The browser queue engine uses this work epoch for scheduled wakes,
so ahead/behind device clocks neither spin retries nor postpone server deadlines.
A clock read that synchronously retires the engine cannot start another timer or
work pass. This lets an already running consumer or transport attempt finish
and release its claim after calibration ends, without a device-time fallback.

Shared work disposal also releases claims returned by pending selection or
successor reservations, completes already reserved exhaustion finalizations,
and joins group attempts that started before disposal. Unstarted claims return
as not-ready without consuming an attempt. Held inbound/outbound regressions and
pending-selection/group/successor tests cover these shutdown boundaries; final
outbound settlement events remain observable after authority time ends.

RTT reports now use the earliest calibrated bound for creation, while admission
and expiry retain the latest bound. This prevents the expiry margin from
future-dating an RTT fact relative to the server receiving it; measured RTT
duration remains monotonic.

The remaining clock integration is deferred to [issue #836](https://github.com/intact-software-systems/ar-eye-hunter/issues/836)
at the maintainer's request so gameplay iteration resumes after this timing fix.
That follow-up covers message creation, durable/checkpoint timing and expiry
maintenance, page-level delivery/proof composition, remaining presence comparisons
and ICE/signaling clocks. This deferral does not establish skew-safe multiplayer. In particular, checkpoint retirement must
flush dirty state even after the calibrated connection ends: settlement and
cleanup timing must not depend on a clock that correctly refuses new authority.
Passing carrier, startup and lifecycle tests does not qualify complete clock-skew
gameplay or physical phones.

Browser integration must distinguish creation from expiry: construct a new
message from the conservative earliest server bound before publication signing,
and compare its deadline against the latest bound at admission, fallback and
consumer delivery. The delivery registry, RTC proof verifier and room-presence
checks also compare absolute server epochs and must join that clock domain.
Local elapsed-time measurements and game ticks should remain monotonic; a clock
refresh must not rewind them or grant additional message lifetime. Calibration
belongs to connection lifetime, with cancellation and stale-completion fences
when the connection/server identity changes.

### Secure LAN serving

Vite now accepts paired certificate/key paths and a configurable local API proxy
target. Rallar's local launcher permits its advertised public origin in CORS.
The phone-facing HTTPS origin serves the game, API and WSS connection together;
the existing localhost trial can remain running on separate ports. See the
[phone setup](../../apps/cca-2d/README.md#https-phone-trial) for startup commands,
certificate trust and temporary-account behavior.

Certificate-chain verification and the proxied API configuration have passed on
the LAN. Three browser checks through that HTTPS origin pass: independent-player
movement, registration/solo return, and friendship/invitation/matchmaking.
Physical-device certificate trust, touch comfort,
background recovery and sustained phone hosting remain unverified. The short
presence lease's clock-skew behavior also remains an open acceptance item.

### Readable names and shared-round acceptance

Each Ready intent carries the local authenticated session's username as its display
name. The host binds it to the authenticated sender's existing seat and accepts
updates only in the lobby. The participant name then stays with the round through
recovery and results. A lobby roster refresh preserves already submitted names
for the same session; readiness from a replacement session must be submitted again.
Names are presentation data, not authorization or score identity.

Rallar's strict client-state collection intentionally exposes only the caller's
private state. Refreshing people therefore cannot populate every peer's profile.
CCA exchanges the small display label through its existing authenticated room
messages; no server permissions or private-profile reads are widened. Old trial
tabs must reload for the mandatory Ready field in `grumpy-town-v4`.

The new browser acceptance uses two independent accounts and normal controls to
tip the apple stall, credit the initiating player, observe shared fruit and owner
cleanup, complete the real three-minute clock and enter a fresh ready/start cycle.
World assertions select observed snapshots using each page's rendered committed
match identity, phase and tick; a commit message alone is not evidence of acceptance.
The test never injects world state or advances the test clock. The separate rescue
and multiple-qualifier scenario below supplies evidence beyond this fruit/rematch flow.

The [shared fruit-prank capture](visual-concepts/rallar-shared-fruit-phone.png)
and [round results](visual-concepts/rallar-shared-results-phone.png) show actual
phone-sized multiplayer gameplay and named results, including the initiating
player's ten-point reward. This is browser evidence, not physical-device qualification.

The combined 21-scenario match/recovery browser run passes, including the full
three-minute round with committed-state observations and a clean rematch. All
128 CCA domain tests, focused typecheck and production build pass. Review corrected
both premature test observation of commit messages and names lost during recovery;
regressions protect those cases. CCA browser tests are explicitly owned as manual
trials in `tests/manual-suites.json`; test reachability passes. These results do
not by themselves close human-rescue, multiple-qualifier or physical-phone checks.

A further real two-account browser trial now proves human freeze/rescue and two
qualifiers in the same unaccelerated round. One player approaches their friend's
actual position after crossing the fountain's water, rather than assuming a fixed
rendezvous survived environmental movement. The frozen target thaws before its
original six-second deadline while both clients record increased human rescues;
no bot companion exists in the shared town. Players earn points through normal
dash controls, including Big Stink, barbecue and café interactions. Both finish at
tick 5,400 with 110 points and matching rendered winner names and scores. The trial
records seven human rescues; that observed count is not a required gameplay constant.

The [freeze](visual-concepts/rallar-shared-freeze-phone.png),
[human rescue](visual-concepts/rallar-shared-rescue-phone.png) and
[two winners](visual-concepts/rallar-shared-winners-phone.png) are inspected actual
390 × 844 browser captures. The fruit/results/rematch trial and the corrected
rescue/two-winner trial each pass with the revised movement helper. Focused test
typecheck, formatting and changed-file style review pass. Earlier attempts exposed
test-route assumptions: water displaced the rendezvous and a longer low-value
prank route ran out of round time. No production scoring, timer or rescue rule was
changed to satisfy the tests. Physical-device qualification remains separate.

The maintainer has moved the remaining clock work to [issue #836](https://github.com/intact-software-systems/ar-eye-hunter/issues/836).
Do not make that broad platform follow-up a prerequisite for gameplay iteration.
Keep the known cross-clock limitation visible when reporting multiplayer readiness.

The game-facing acceptance outcomes are now verified in browser trials:

1. The town boots, moves, dashes, slips and zooms through floating controls. Actual
   phone-sized captures and phone/tablet/desktop control checks cover playfield
   visibility and responsive layout. Secure LAN game and API endpoints are live.
2. Real accounts complete social entry, Ready/start, mischief, rescue, results and
   rematch. The final normal-clock acceptance passes all 27 social/host/recovery
   scenarios on the published runtime, excluding the deferred AL-builder edits.
   The 133 game-rule tests and production build pass. Separate unaccelerated
   rounds verify shared fruit/cleanup/rematch and human rescue/multiple winners.

Remaining game-facing follow-up is physical-device testing and play-feel feedback.
Keep clock work in #836 and distinguish local-trial acceptance from production
release qualification. The PR must complete its release gate and review process.
