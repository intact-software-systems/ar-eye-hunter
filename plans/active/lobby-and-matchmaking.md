# Lobby and matchmaking product plan

Rallar should make it easy to enter a shared browser experience and keep the same people together:
share a room, enter it, participate, reconnect, and return. This plan develops that promise from the
existing open-room directory. Rallar owns discovery, admission, membership, and recovery; applications
own activity eligibility, readiness, match rules, and what participants or spectators may see.

The chosen direction is invitation first, followed by drop-in discovery and automatic room selection.
An invitation can serve two people who already know each other. Public matching additionally depends
on enough compatible people being available at the same time. This is a product direction to validate
with adoption and participation evidence, not a claim that current usage has proved it.

Current product and architecture authority remains in [product](../../docs/product.md) and
[architecture](../../docs/architecture.md). Slice numbers below preserve existing references; their
numeric order is not the delivery order. Each implementation PR delivers an independently testable
outcome. Only the next two useful implementation increments are made concrete when a slice begins; later
work stays outcome-shaped until its prerequisites and product evidence are available.

Across these slices, add no legacy path, duplicated implementation, or migration code. Prefer
existing repository patterns and keep code, tests, documentation, and plans consistent. Each slice
uses test-driven development and one current PR; wait for the maintainer to merge it before starting
the next slice unless the maintainer explicitly requests a stack. PR #696 delivered the slice 0
foundation, PR #697 delivered Quick Join, and
[PR #699](https://github.com/intact-software-systems/ar-eye-hunter/pull/699) delivered slice 2 using
the maintainer's selected existing-measurement scope.
[PR #700](https://github.com/intact-software-systems/ar-eye-hunter/pull/700) delivered shareable
private-room entry in both games and is merged.
[PR #701](https://github.com/intact-software-systems/ar-eye-hunter/pull/701) delivered slice 5
through the existing create/update and room-entry owners and is merged as `ea3240c7`.
Recovery and recent-room navigation were delivered in
[PR #705](https://github.com/intact-software-systems/ar-eye-hunter/pull/705), merged as `eceabcc7d`.
[PR #706](https://github.com/intact-software-systems/ar-eye-hunter/pull/706) delivered temporary-room
retention and guarded archival. Production Quick Join verification exposed a deployment mismatch
and database latency, repaired in merged [PR #707](https://github.com/intact-software-systems/ar-eye-hunter/pull/707).
Seven-day deletion, including Relic expedition saves, and the match/feedback repairs are present in
main. The reusable server AppInbox now owns registered application mutations without game-specific
product code. Both games now have automatic directory freshness and account replacement through shared
auth notification delivery and visible logout/sign-in workflows. Queued cache delivery now preserves
awaited observer completion and entry/refresh quiescence through the shared notifier. The
renderer repair prevents asynchronous work from outliving Relic logout while keeping replacement
account rendering and scene controls usable. Advertised WebSocket host validation now diagnoses #683
at server startup and before browser connection, with visible login and recovery controls in both
games. Delayed heartbeat recovery now restores authorized joined-room targets after browser snapshot
expiry while the server presence lease remains live. Merged
[PR #721](https://github.com/intact-software-systems/ar-eye-hunter/pull/721) repairs a reproduced
Relic code-room sharing failure from #712: preserve the committed creation result when leaving the
previous room fails while the browser cache is expired. The maintainer-selected repeatable browser
measurements of entry, recovery and repeat play are present through merged
[PR #722](https://github.com/intact-software-systems/ar-eye-hunter/pull/722). The repeat-play baseline
exposed a stale Escape selection after Relic Reset, repaired in merged PR #723. PR #725
retains the AR Eye WebGL engine across room changes; residual timing investigation belongs to #724.
Spectating and Relic expedition continuity are delivered. The next selected outcome is coordinated
repeat play with the same people.

## Current delivery design: play again together

The maintainer selected a same-room Play again together flow in both games and explicit
Keeper/director start after every remaining present player confirms. Spectating and Relic
expedition continuity are available; this slice makes the transition from completed results to
another shared game a visible, coordinated workflow. Existing Reset and repeated match-start
journeys demonstrate restart mechanics, not coordinated consent.

### Intent and acceptance

Players who finish together can see who is staying, choose another game, and begin it without
resharing a room or silently enrolling someone else. One PR delivers both applications through real
clickable journeys. No party movement, matchmaking queue, scheduled session, ranking system,
friendship model, or change of game authority belongs to this slice.

The visible flow is completed results -> player confirmations -> leader start -> a new game in the
same room. Results remain available during preparation. Each eligible player has Play again and a
way to withdraw that confirmation before start. The roster distinguishes ready, waiting, disconnected,
and watching. A refusal or uncertain request remains visible; clicking does not optimistically claim
an authoritative ready state or successful start.

Existing spectators keep their role and do not block readiness. A player may use the existing
Watch admission where eligible; an owner/admin remains subject to the existing governance restriction
and is shown why a role change cannot proceed. A refused role change leaves current participation and
readiness intact. Watching remains an account-wide membership role, while rematch confirmation belongs
to the exact participating session. Leaving uses the existing explicit expedition/room departure
semantics and does not withdraw another session's hunter.

### Approaches and selected policy

- **Selected: explicit leader start after readiness.** The current Keeper/director starts only after
  all remaining present participants confirm. This preserves visible start authority and gives the
  group a final opportunity to adjust settings or withdraw a confirmation.
- **Not selected: automatic start when the final player confirms.** This saves one click but couples
  a player's confirmation to immediate group-wide start and complicates last-moment coordination.
- **Deferred: cross-room parties.** Moving a group needs reservation and all-or-none admission policy.
  Existing room reuse is sufficient for this outcome.

The next-game candidates are the completed game's participants, plus eligible players who explicitly
opt into its next game. Being a room member alone is not Relic expedition participation. Newcomers may
opt in through the same visible flow and then become part of readiness. This cohort avoids making an unrelated room visitor block the existing group's next game.

The leader must also opt in. Start requires at least one ready participant and every candidate who
still has valid player membership and live server presence to be ready. A disconnected candidate stays
visible but cannot authorize start while offline. Their missing confirmation blocks only until server
presence expires. A reconnect before start restores the same candidate and readiness for that exact
session and completed-game identity; changed membership and expired/replaced authentication are
revalidated. A new session does not inherit another session's confirmation.

A departure or successful Watch change removes that session from the eligible player cohort. A later
return is re-evaluated and never silently enrolls in a game already started. Existing game-specific
late-entry policy continues to govern an explicitly requested entry during play.

The current leader remains the start authority. If that leader leaves or expires, use the existing
Keeper/director succession and appointment controls. A replacement leader must see recovered
preparation and confirm their own participation; no client may start merely because it displayed a
ready count. Existing membership/role restrictions remain authoritative.

### Authority and dataflow

Keep application policy with the current owners:

- Relic uses `packages/relic-hunters/src` rules and the existing
  `packages/relic-hunters/server/relic-game-mutation-service.ts` AppInbox service. The browser runtime
  and HUD send commands and render accepted snapshots. Reuse the existing captured initial-expedition
  proposal, player construction, start rules, save CAS and committed publication when starting the next
  expedition; do not copy Reset into a parallel mutation implementation.
- AR Eye uses its appointed Rallar Game director, accepted intent path and authoritative arena
  snapshots. Reuse `startArenaMatch` and the current match-start publication. Do not introduce a second
  browser-local readiness authority or change AR Eye into a different game-hosting architecture.
- Put genuinely common pure preparation/confirmation policy in the existing shared Rallar Game
  package, with direct imports and distinct app translations. Share semantics that are identical;
  retain Relic character/expedition rules and AR Eye match duration/scoring in their current owners.
  Transport readiness is a separate fact and is never reused as player consent.

Preparation carries a complete, bounded roster and the identity of the completed game. Commands
carry that identity and the actor session; sender identity and role come from authenticated authority,
not a caller-supplied player ID. Within an existing game state, absence of preparation means no rematch
has been prepared. A present preparation must validate completely. This is a domain absence, not a
legacy reader or a migration fallback. Existing game generation identities are reused; no independent
room-history or membership registry is added.

Readiness updates are idempotent assignments. A matching repeated start returns the accepted outcome;
conflicting reuse of an idempotency key is refused. A delayed ready/cancel/start command from an older
game cannot modify the new game. Two leader start requests must create only one next game. A settings
change invalidates confirmations when it changes what the players agreed to; current duration/setup
controls must not bypass the completed-game rematch guard.

Relic retains visible read -> compute -> validate -> write(transaction, computed), one attempt per
AppInbox delivery, optimistic save revision and outer QueueBox retry. Start reads fresh issued-session,
membership, leader and candidate presence authority; its first conditional guard must fence the bounded
presence and issued-authentication observations that determined which candidates were eligible, including expired/absent
observations and recreation. A conflicting reconnect, departure, confirmation or authority change
forces a complete reread/recompute rather than a stale start. No domain lock or handler retry loop.

AR Eye binds readiness and start messages to the room, completed match and current director authority.
Snapshots carry accepted preparation so guests, reloads and a replacement director recover the same
state. A missing or stale authority snapshot produces resynchronization/waiting, never a start from
local cached votes. Preserve the current authority-generation checks and test stale former-director
messages. This slice does not promise durable recovery after every arena authority and replica has
been lost; it preserves the current arena persistence contract.

The real reload journey exposed a shared browser sender-sequence collision. Browser game envelopes
now require the current admitted presence generation; receivers check it before sequence admission
and include it in their sequence key. One facade-owned counter survives match-handle recreation.
Explicit room entry on reload admits the new browser heartbeat generation; heartbeat recovery alone
does not rotate it. Delayed former-generation packets cannot advance the current sequence window.

Standards closure keeps arena match, targets, player movement, weapons, events and math in direct
owners, with `arena-contracts.ts` as the app contract boundary. Relic admission, search, rematch,
command draft/delivery and feedback have explicit owners; simulation and runtime retain their own
state-transition lifecycles. No old-path re-export, old snapshot defaulting or migration is retained.

The accepted next-game transition consumes preparation and creates the new activity once, with only
the eligible consenting participants. Relic preserves their selected characters through canonical
player construction while resetting game progress; AR Eye uses fresh score baselines for its new match.
Room identity, invitations, listing and spectator memberships remain intact. Completed results are not
mutated by confirmation changes. New activity data replaces old activity data only through the
existing accepted authority transition.

### UI and failure behavior

Expose the coordinated controls in both results surfaces, including a clear ready roster and disabled
start explanation. Keep departure and Watch discoverable. Do not hide a failed operation by dismissing
results. Explicitly distinguish request pending, accepted readiness, start pending, refusal, and
connection recovery. Session/room replacement fences late responses and unsubscribes old observers.

The game-owned runtime owns pending operations and recovery, composing existing shared concurrency,
notification and transport primitives. Rallar Data may retain an uncertain command identity when
needed for safe replay; it never supplies accepted preparation or match truth. App-local duplicate
queues, timers, notification registries or retry mechanisms are prohibited.

The implementation owns ordinary wording, layout within the current HUD, exact command names and
cohesive internal file boundaries. It must preserve the agreed policy and explain any evidence-driven
change before replacing it.

### Implementation horizon and validation

Only two implementation increments are concrete, both inside the same PR. The design above is approved.
Execution is inline with test-driven development and a fresh whole-branch review before handoff.

**Goal:** coordinated results-to-second-game participation in both existing rooms.
**Architecture:** share pure readiness decisions; retain the Relic AppInbox and AR Eye director as
stateful authorities. UI consumes accepted snapshots and sends generation-bound commands.
**Tech stack:** existing TypeScript, React, Vitest, Playwright, Deno and PostgreSQL; no new dependency.
**Spec:** the current delivery design immediately above.

**Global constraints:** no legacy path, migration code, duplicate algorithm or external dependency.
Keep session identity distinct from membership; results remain visible until accepted start.

**Review focus:** test the following at the owning boundary: a stale confirmation after settings
change; a recreated presence row between read and commit; two simultaneous leader starts; a withdrawn
or watching participant reconnecting; and an old response arriving after room/account replacement.

#### Task 1: accepted preparation and one authoritative next game

**Files and ownership:**

- Add `packages/shared/rallar-game/rematch.ts` and mirrored
  `packages/tests/shared/rallar-game-rematch.test.ts` for pure preparation, confirmation and start
  eligibility. Direct imports keep the policy owner visible.
- Integrate Relic contracts/rules in `packages/relic-hunters/src/model.ts` and `rules.ts`, durable
  decoding in `server/relic-game-move.ts` and `server/decode-relic-game-state-app-data.ts`, and fresh
  presence observations plus conditional guards in `server/relic-game-mutation-service.ts`.
  Extend `packages/tests/relic-hunters/relic-game-mutation.test.ts` and add semantic rematch rule
  coverage beside the existing continuity tests. Reuse initial proposal capture and player admission.
- Integrate AR Eye accepted match state in `apps/ar-eye-hunter-v1/src/game/arena-contracts.ts`,
  `simulation.ts`, the existing match intent handler and state acceptance runtime. Extend
  `packages/tests/ar-eye-hunter-v1/simulation.test.ts` and the current match/runtime tests.

**Interfaces:** `RallarGameRematch` holds `completedGameId`, `settingsKey`, and a bounded ordered
roster of unconfirmed sessions or `{ sessionId, ready: true, participationKey }` confirmations. The captured membership identity changes after role/leave/rejoin, while transport reconnects preserve consent. `createRallarGameRematch` creates unconfirmed candidates;
`setRallarGameRematchReady` validates the game/settings identity, eligible actor and capacity before
an idempotent assignment. `changeRallarGameRematchSettings` clears confirmations on an actual settings
change. `evaluateRallarGameRematchStart` consumes current eligible session IDs, the authenticated actor
and current leader, and returns a typed refusal or the consenting session IDs. `isRallarGameRematch`
validates the whole replicated shape. App-owned translations supply all authority observations.

- [x] Write and run failing shared policy tests: the leader cannot start while Bob waits; cancellation
      blocks again; an expired/non-player candidate is excluded; a same-session reconnect restores its
      consent; a new session has none; visitors do not silently join; stale identities/settings are refused.
- [x] Implement the pure shared decisions and run
      `npx vitest run packages/tests/shared/rallar-game-rematch.test.ts`; expect all tests passing.
- [x] Write failing Relic tests through `applyRelicCommand` and the real AppInbox/save boundary:
      finished results remain unchanged while preparing, settings invalidate readiness, only Keeper starts,
      a fresh expedition retains only consenting hunters and their characters, duplicate start creates one
      game, stale requests cannot reset it, and concurrent presence replacement forces reread/recompute.
- [x] Extend the current Relic command path and canonical player construction. Preserve
      read -> compute -> validate -> write, outer retry, fresh authorization and insert-only outbox.
      Run `npx vitest run packages/tests/relic-hunters`; expect all tests passing, then the affected live
      PostgreSQL race/replay cases against an isolated migrated database.
- [x] Write failing AR Eye authority tests: current director plus all eligible confirmations required,
      old director/game/settings rejected, second match has a fresh scoring baseline for consenting players,
      and replacement director uses accepted preparation. Integrate through existing match intents/snapshots.
- [x] Run focused AR Eye/shared game tests and package typechecks; expect zero failures. Commit the
      coherent authoritative paths with their tests. Record any changed interface here before its UI use.

#### Task 2: both clickable results-to-repeat-play journeys

**Files and ownership:** AR Eye results controls belong in
`apps/ar-eye-hunter-v1/src/arena-ui/match-winner-overlay.tsx`, connected through the existing arena
runtime and `app.tsx`. Relic results controls belong in `src/game/hud/relic-score.tsx`, connected
through `relic-hunters-runtime.ts` and its view model. Existing start/reset controls must use the
completed-game guard. Extend `tests/playwright/ar-eye-hunter/quick-join.spec.ts` and
`tests/playwright/relic-hunters/full-stack-private-room-entry.spec.ts` rather than duplicating journeys.

**Interfaces:** consume accepted `RallarGameRematch` in snapshots; send readiness/settings/start
commands bound to the completed game through each existing authority runtime. Pending, refusal and
uncertain requests remain runtime state and never become accepted votes in browser storage.

- [x] Write failing browser/runtime tests through visible Play again, withdraw and leader Start
      controls. Verify waiting, cancellation, spectators, a refused early start, reconnect and leader
      succession, then accepted second-game actions by both players in the original room.
- [x] Add controls and runtime actions using the current HUD and notification/concurrency primitives.
      Fence old room/account responses; leave results and errors visible until authority accepts start.
- [x] Run both app test commands and
      `npm --workspace ar-eye-hunter-v1 run build` plus
      `npm --workspace relic-hunters-v1 run build`; expect zero test/build failures. Run both existing
      game-room Playwright configurations for the affected journeys; expect actual second-game play.
- [ ] Run the required mutation/load/performance and delivery gates below, review changed files and
      whole-branch behavior, publish the complete feature and evidence in the same PR, then wait for merge.

Run focused shared/game/runtime tests, affected package typechecks, both app builds and native Relic
server checks. Extend game-owned HTTP/OpenAPI and black-box contracts if command behavior changes.
Run the real PostgreSQL mutation/race tests and the required medium-scale and comparative performance
checks for changed authoritative mutation paths. Validate affected public API/bundle boundaries if
exports change. Run the required release CI, including both games' clickable lanes; do not replace
those journeys with injected runtime calls or lower their existing assertions.

Review every changed human-authored file in full; every remediation support file enters closure
recursively, and independent untouched code remains outside closure. Remove affected obsolete
implementations instead of preserving parallel old/new flows. Add no legacy path, migration code,
duplicate algorithm or external dependency. The PR owns review and validation evidence; the maintainer
merges before the next capability begins.

## Current foundation

- `GET …/group-directory` and `rallar.rooms.directory()` discover safe summaries of open rooms the
  caller cannot already read in full. They do not hydrate authoritative browser group caches.
- The original directory hardening is already present in the tree, introduced by PR #685: `kind`
  and `q` filters, limits, keyset pagination, `GroupDirectoryEntry`, effective member capacity,
  lifecycle state, ETag revalidation, AR Eye directory-error state, and shared Relic HTTP middleware.
  The completed slice 0 contract adds caller-specific private revalidation, cross-origin validators,
  and request/session ownership for explicit directory loading, error, recovery, and empty states.
- `joinMode` supplies the admission credential: `open`, `code`, or `invite-only`. Lifecycle admission
  policy can still close entry or require approval. Business status, formation state, connectivity,
  room membership, and participation in an application activity are separate facts.
- Relic explicitly separates online room members from expedition hunters. Use it alongside AR Eye
  while designing directory and admission behavior, rather than validating generality at the end.
- Codes, rotation, pending admission, roles, expiry fields, people presence, and topology RTT helpers
  already exist. Their existence does not establish complete invitation, friendship, retention,
  spectating, or matchmaking products.

## Product choices

### Entry and participation

Quick Join promises immediate admission to a suitable existing room or an explicit unavailable
result. It does not silently submit an approval request, promise a seat in a running activity, or
create a matchmaking ticket. Applications decide whether room admission is enough to participate.

Selection first respects scope, credentials, admission windows, effective capacity, and application
eligibility. It must not treat `lifecycleState: active` as a universal eligibility filter: the match
preset admits while forming and closes afterward. Rank eligible rooms by useful participation, with
online-member count as an initial proxy where appropriate; spectators and multiple sessions must not
be described as additional players.

When no room is suitable, the initial app experience offers starting a room and sharing it. Automatic
creation is an explicit app choice. Waiting for a newly formed match is a later capability with its
own cancellation, timeout, reservation, and group-formation semantics. Pending admission is consent
awaiting approval, not a matchmaking queue.

### Visibility and access

Discovery and permission to enter are independent. Use these initial product choices:

| Choice         | Directory | Admission credential                               |
| -------------- | --------- | -------------------------------------------------- |
| Public         | Listed    | Open, subject to admission policy                  |
| Unlisted       | Hidden    | Room reference, subject to admission policy        |
| Code protected | Hidden    | Valid code, subject to admission policy            |
| Invite only    | Hidden    | Authorized invitation, subject to admission policy |

Unlisted means absent from discovery, not access restricted. The existing group metadata owns
`rallarDirectoryListing`; absence means listed, and an invalid present value is hidden. The sparse
create/update intent changes that policy through the existing AppInbox path. Generic metadata
replacement preserves it. This represents the current feature without migration code.

Invitation destinations survive authentication. Links identify the intended application/workspace
and room, or use a deliberately scoped code resolver; a code alone must not be assumed globally
unique or already resolvable. Never put an auth session or ticket in a link. Code expiry and rotation
prevent future entry with that code; they do not remove existing members. Revocation of membership is
a separate owner action. Provide an enter-code path for people receiving a code without a link.

### Return, lifetime, and keeping people together

Reconnect to the current activity and return to a recent room are different experiences. A fresh
invitation takes precedence over restoring an old room. Recovery rechecks current authorization and
activity state; it must not resurrect an expired, deleted, or no-longer-authorized session.

Auth observers share the synchronous latest-state notifier used by room lifecycles. A replacement
login supersedes obsolete signed-out publication, including login during delayed cleanup. Session
expiry, transport teardown, and cleanup failures remain owned by the auth lifecycle. Registration
renewal and callback failures cannot remove a newer subscription or fail a completed transition.
Both games verify Logout, replacement authentication, room creation, and reload through visible controls.
Relic also checks browser errors across that journey and starts the replacement expedition to exercise
its scene controls. Both games use the same Babylon release containing the upstream disposed-scene
RGBD fix; renderer lifecycle repair remains outside shared auth and room policy.

Observable caches share a queued notifier separately from synchronous room/auth state publication.
Each event captures its audience, awaits observers and reporting, and precedes the next event. The
cache owner keeps refresh and entry lifetime policy: idle includes observer-started work and committed
deletions; removed loaned entries cannot publish stale refreshes into a replacement. No compatibility
aliases, migration paths, or application-specific cache behavior are retained.

Temporary activities and persistent social or collaborative rooms need different retention policies.
Define reconnect grace, hiding from discovery, archival, and permanent deletion separately. Do not
purge every empty room under one platform-wide rule. Existing absolute expiry/purge fields do not
supply an idle-retention policy.

Explore “play again with these people” before a general party system. Reusing a room for another
activity may be sufficient. Moving a party together between rooms requires explicit reservation and
all-or-none admission decisions before it becomes a platform promise.

## Delivery priorities

| Priority    | Outcomes                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Current     | Play again together in both games: explicit readiness, leader start and recovery in the same room. |
| Conditional | Moving groups between rooms, when demand justifies reservations and group admission.               |
| Later       | Scheduled rooms (8) and a separate tournament capability.                                          |

Relic validation is a constraint throughout, not a dependency postponed to slice 9. Operator
reliability work may ship independently where a concrete operational need warrants it. Freshness and
participation evidence still govern the choice of further social capabilities; notification reuse
does not establish product demand for them.

## Slice 0: finish directory hardening

The directory baseline, completed in [PR #696](https://github.com/intact-software-systems/ar-eye-hunter/pull/696),
has these continuing acceptance requirements:

- Preserve server-side `kind`, trimmed case-insensitive `q`, default limit 50, maximum 200,
  `includeEmpty=false`, and online-count-descending/group-id-ascending keyset ordering. Pagination is
  a best-effort view of changing presence, not a frozen snapshot; consumers deduplicate results.
- Keep the dedicated safe entry contract and effective capacity. `isFull` describes the membership
  cap, not whether admission or gameplay is available. Forming rooms remain discoverable when their
  visibility allows it. Document this distinction instead of describing every entry as joinable.
- Keep ETag revalidation and make the documented conditional request usable across allowed browser
  origins. Revalidate authorization before a conditional result; preserve typed query/auth failures.
  A 304 saves response-body transfer, not necessarily snapshot reads or server computation.
- Distinguish initial loading, a successfully empty directory, and a failed refresh. A failure must
  not also show empty-lobby guidance. Retained entries after failure are visibly stale; Refresh
  recovers them. Older requests and signed-out or replaced sessions cannot publish directory state.
- Preserve separation from authoritative membership caches and retain the shared HTTP middleware
  already installed in Relic. Verify the same directory contract with AR Eye and Relic-shaped names.

No Quick Join command, listing migration, spectator role, retention job, push directory, metadata
query language, or corruption-tolerant reader belongs to this slice. The completed implementation
plan is removed with its delivery; the PR owns validation and review evidence.

## Slice 1: Quick Join

Available through [PR #697](https://github.com/intact-software-systems/ar-eye-hunter/pull/697).
`rallar.rooms.quickJoin()` admits the caller to a suitable existing
room through one authoritative AppInbox operation. Its REST endpoint is
`POST …/groups/quick-join/requests/:requestId`; selection accepts `kind`, `q`, and `includeEmpty` with
the directory's defaults. Candidates are open rooms in the exact scope, excluding existing active
memberships, ranked by distinct online members descending and group ID ascending.

Selection uses canonical admission windows, effective capacity, and membership policy. Conflict
retries restart from fresh state. Two callers racing for the last place cannot both receive it; the
other caller finds another room or receives `{ status: 'unavailable' }`. A successful admission
returns `{ status: 'joined', snapshot }`. Matching request replay preserves either durable result;
reusing the request ID with different selection semantics fails with a conflict. Global snapshot
isolation across candidate rooms is not promised.

The browser connects presence and switches only after admission. Unavailable preserves the current
room; a partial switch failure exposes the admitted room. Session replacement cannot publish an old
operation's room state. AR Eye offers pending, unavailable, joined, and failure feedback and retains
New Arena. The shared facade is validated with Relic-shaped rooms, while expedition participation
remains a separate application action.

Quick Join creates no room, approval request, or activity-seat reservation. Applications supply their
room-selection criteria and handle unavailable through the start-and-share experience above. The PR
owns concurrency, browser, performance, and review evidence.

## Slice 2: latency-ranked discovery

[PR #699](https://github.com/intact-software-systems/ar-eye-hunter/pull/699) adds
`rallar.rooms.directory({ order: 'peer-rtt' })`. Occupancy remains first; known peer RTT then sorts
ascending, unknown follows known, and group ID breaks remaining ties. Default ordering and Quick
Join selection remain occupancy then group ID. The default directory read performs no RTT lookup.

The mandatory `peerRttMs: number | null` is the slowest existing direct RTT from the authenticated
session to every live room session. Complete coverage is required, with samples less than 60 seconds
old and not future-dated. Missing or partial coverage, expiry, a new caller session, or no live peers
produces unknown. Existing reporting admission and degree bounds remain in force. No pre-join probes,
coordinate inference, migration, or new authoritative write is introduced. A storage outage or corrupt
measurement fails the opted-in read with an uncached server error rather than accepted unknown data.

AR Eye exposes an explicit preference and labels measured and unknown rooms. Changing order starts
new pagination; old requests and replaced sessions cannot publish results. Unknown rooms remain
available through the ordinary admission action. The shared API and black-box directory recipe also
cover Relic-shaped rooms; each game retains its own activity participation rules.

Peer RTT describes RTC peer traffic. AR Eye's director can fall back to WebSocket; Relic's
authoritative commands use WebSocket. This signal does not measure either game's command completion.
Seeded measurement and browser tests establish ordering, coverage, freshness, and recovery behavior,
not network prediction quality or participation improvement. Such evidence is still required before
latency displaces simpler eligibility and occupancy decisions. The PR owns detailed validation and
review evidence; the completed implementation plan is removed with this delivery.

## Slice 3: spectating

Offer watching when it helps learning or social participation. Applications define a spectator-safe
view; read-only message permissions alone do not authorize exposing hidden gameplay state. Enforce
permissions at authoritative boundaries, use separate bounded spectator capacity, and decide chat,
moderation, and transition-to-player behavior before shipping. Advertise watching only when the
application actually supports it.

## Slice 4: shareable private rooms

[PR #700](https://github.com/intact-software-systems/ar-eye-hunter/pull/700) provides code-protected
and invite-only creation, share links, manual scoped reference/code entry, code rotation, and account
invitation/revocation in AR Eye and Relic. The shared `RallarRoomEntry` owner captures the destination
before startup, retains it through sign-in and tab reload, and offers correction, retry, and cancel.
A fresh link replaces a saved room. Successful entry discards the code and binds the saved reference
to the principal; late account, destination, or cancelled operations cannot adopt it.

Active members can return after code rotation or expiry. A new account still needs a valid code or
invitation, and banned members and inactive rooms remain denied. These rooms stay absent from public
discovery. Codes are never treated as globally resolvable room references, and no persisted schema
or migration is added. Invitation presence retries preserve both request ID and payload.

Room admission remains separate from joining an expedition or participating in a match. Relic now
uses one connection/runtime owner and removes the affected bare-ID restoration and duplicate hook.
Both games have browser evidence for sharing through authentication, actual participation, rotation,
reload, rejected credentials, and a replacement invitation. The PR owns current validation and
review evidence. The completed implementation plan is removed with this delivery; the next slice
begins only after its maintainer merge.

## Slice 5: unlisted rooms

[PR #701](https://github.com/intact-software-systems/ar-eye-hunter/pull/701) adds optional
`directoryListing: 'listed' | 'unlisted'` to existing create/update requests and the browser room
facade. Pure computation preserves unrelated fresh metadata; the group revision guard rejects stale
writes and stale Quick Join candidates. Matching AppInbox replay returns the stored result, changed
request-ID reuse conflicts, and an unchanged setting creates no second state change. No new mutation
operation, storage schema, migration, or alternate entry path is introduced.

Directory and Quick Join use one listing interpretation. An old directory ETag observes removal on
the next read; code-protected and invite-only rooms remain hidden regardless of listing. Direct entry
to an open unlisted room still enforces scope, authorization, capacity, and lifecycle policy. Hiding
preserves existing memberships, presence, and application participation.

Both games provide unlisted creation, scoped links, and owner/admin List/Unlist controls with failure
and retry states. Both consume scoped safe directory summaries for public discovery; Relic keeps
these separate from member snapshots, paginates and deduplicates them, and fences refreshes by
request and session. Loading, failed refresh, retained results, and empty success have distinct
states. Outsider room lists hide unlisted and credential-protected rooms; active members retain
their rooms. Hosting responses belong to their operation, session, and room, so an older code
response cannot replace a newer one after switching rooms. Visible browser journeys cover shared
play through listing changes. Automatic freshness remains slice 7. The PR owns detailed validation
and review evidence; its completed implementation plan and design are removed with this delivery.

## Slice 6: recovery and room lifetime

[PR #705](https://github.com/intact-software-systems/ar-eye-hunter/pull/705) implements the recovery
increment. A shared `RallarRecentRooms` owner stores ten distinct scoped references and visit timestamps
through Rallar Data per principal and application/workspace. It saves no credentials or availability
claims. Both games expose Return and Forget, with independent storage loading/failure/retry states.
History hydration does not navigate; a new invitation keeps precedence over a restored destination.

Return captures the displayed account and uses the existing entry/admission path. Current scope,
membership, capacity, bans, and room lifecycle remain authoritative; leaving a code room can require
a fresh code to return. Forget removes only the local shortcut. Relic admission never automatically
joins or resets an expedition. Account replacement, delayed storage operations, reentrant lifecycle
notifications, and malformed persisted records have focused coverage. Both games' browser journeys
cover reload, fresh-link precedence, denied return/retry, and durable Forget. Simultaneous tabs remain
latest-value history and may overwrite a local edit.

[PR #706](https://github.com/intact-software-systems/ar-eye-hunter/pull/706) delivers the retention
increment: explicit temporary creation with a default ten-minute reconnect grace, empty-room hiding,
and archival after guarded inactivity observations.
Existing rooms and omitted creation intent stay persistent. The maintainer selected this temporary
default for both games and seven days of archived retention before deletion. Archival preserves
records. Maintenance now deletes temporary rooms once seven archived days have elapsed, including
platform memberships, presence, room-owned lifecycle records, and the exact Relic expedition save.
Audit and idempotency/replay evidence keep their existing retention. Persistent rooms and unrelated
application data remain outside this policy. Fence every Relic save writer and room recreation
against deletion through the canonical AppInbox and optimistic revision guard; a stale command or
completed-result replay must not recreate a deleted room or save. Reconnect grace and deletion must
not race each other. Decide “play again” behavior with each application's activity lifecycle.

Delayed heartbeat recovery uses the existing authenticated scoped group collection, then renews only
the current principal/session's presence through existing heartbeat mutations. Cache expiry is not a
leave or permission to rejoin. Stop/account replacement fences late reads; causal snapshot adoption
preserves newer explicit leaves. Removed or expired server presence remains absent. There is no
second membership registry. Synthetic delayed-callback tests prove this timer failure class, not
actual operating-system suspension.

Relic room creation recovers the exact validated `joinedRoom` snapshot from a create-and-switch
partial failure. A refused previous-room leave must not replace the already committed creation result
with an empty cache or a different current room. The browser adapter supplies the explicit Relic
application/workspace scope to presence waiting; resolving a bare room ID from an expired cache would
otherwise report the admitted room as missing. The existing presence wait and session/current-room
checks still govern completion before the hosting UI rotates and displays the code. Admission does
not join the expedition automatically. A controlled browser workflow reproduces a blank share link
when cleanup refusal arrives during cache expiry, then verifies sharing and explicit participation
after recovery. This establishes a current failure class for
[#712](https://github.com/intact-software-systems/ar-eye-hunter/issues/712); the older untraced
intermittent occurrence may have a different cause. Revisit that occurrence only with new failure
evidence, and choose further social capability from the product evidence described below.

Corrupt-row isolation belongs to operator reliability in slice 9, not this recovery feature.

## Slice 7: fresh discovery and social context

Both games now consume one shared browser directory lifecycle. An authenticated foreground/online
observer refreshes immediately and 30 seconds after a completed refresh. Manual Refresh coalesces
with pending work and resets the interval. Hidden/offline observers pause, then refresh on return.
Complete paginated results replace the list atomically; failures retain visibly stale entries.
Account/query replacement and disposal cancel and fence old work. These reads never adopt a room,
hydrate membership snapshots, or change application participation.

The pull interval is an operational default, not a production freshness guarantee. Measure request
cost, visibility transitions, discovery-to-participation time, and user needs before adding push.
If justified, send safe workspace-scoped directory updates over existing state sync, including
visibility removals, and recover missed updates with conditional pull.

`rallar.people` provides known people and presence. Define friendship, consent, and room-location
visibility before showing “friends here”; presence alone does not establish a friend relationship.

## Slice 8: scheduled rooms

Support scheduled sessions for organized games, workshops, or classrooms when demand warrants it.
Define organizer ownership, sign-up, cancellation, no-shows, and admission around the start window.
Confirm the lifecycle owner before introducing stored fields. A tournament is a separate product
requiring rounds, results, and advancement; a scheduled room does not imply that support.

## Slice 9: consumer validation and operator reliability

Use AR Eye and Relic from slice 0 onward to verify the same safe discovery contract while keeping
activity rules in the apps. Add metadata filters only for a concrete consumer requirement with safe,
bounded semantics; do not generalize `kind` into a game-specific query language.

An administrator directory can show all rooms and per-row validity under operator authorization.
Decide strict-row rejection versus explicitly reported partial collection results before isolating
corruption. Invalid rows must never become accepted authoritative values, and ordinary callers must
not receive hidden room identifiers through diagnostics.

## Success evidence and delivery rules

Measure invitation/discovery-to-participation time, join failures by reason, empty-directory
outcomes, reconnect success, repeat participation with the same people, and the application glue
required to implement those flows. Baseline these before choosing numeric targets. HTTP admission
success alone does not prove successful participation.

The browser baseline uses native Playwright phase durations from the existing private
entry, reload and completed-activity journeys. Repeat play proceeds into another activity with the
same accounts and room. One shared reporter retains failures, retries, skips and unreached phases;
invalid evidence or failed artifact delivery fails the run. The [browser guide](../../tests/playwright/README.md#room-journey-measurements)
defines exact boundaries, reproducible commands and environment limitations. CI publishes the JSON
before later tests clear the output directory. Three serial local repetitions establish descriptive
observations, not a latency SLO or production adoption evidence. Discovery failures, empty-directory
rates, real OS suspension and user demand remain unmeasured by this baseline. Use the results to
select the next justified improvement; do not infer demand for a party or spectator system from
successful automated play.

Relic repeat play starts with the existing Search default after an accepted Reset, including for
the peer who did not click Reset. Local selected targets, primed actions and old locked-action
feedback clear with the new expedition identity. Ordinary snapshots and refused Reset preserve
the draft. Automatic submission distinguishes expeditions even when the room, session and round
number repeat. The real two-player journey reaches round two again in the same room without
manual Search selection; controlled browser tests cover preservation and timer boundaries.

- REST behavior changes update OpenAPI and black-box recipes in the same change.
- Shared browser public-surface changes include API snapshots and bundle-boundary checks. Report any
  bundle-budget change rather than silently exceeding it.
- Authoritative mutations use AppInbox and the current convergent-service standard; stored-shape
  changes require an explicit design decision consistent with the no-migration constraint. Select the
  current testing skill's gates for the actual scope.
- Review every changed human-authored file in full; remediation support files enter the same closure,
  while independent untouched code stays outside it. Remove affected legacy without verified consumers;
  retaining a real compatibility boundary requires the repository's explicit approval and registry.
- GitHub PRs own delivery state. Do not mirror it in a plan catalog or completion ledger. Delete an
  implementation plan in the PR that completes its outcomes, not in this planning PR.
- Advertised WebSocket host validation addresses the operator reliability defect in issue #683.
  Hardened server configuration rejects mismatched public authorities; other profiles warn at startup.
  The browser compares the captured API request authority with the resolved WebSocket destination,
  rather than the SPA origin, and reports the mismatch before requesting a ticket or opening a socket.
  No endpoint rewriting, alternate transport, legacy path, or migration is introduced.
