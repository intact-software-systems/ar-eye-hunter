# Rallar

Rallar is a browser-first realtime platform for room-based applications. A room
is the product surface. Behind it, API-v1 stores authoritative group state,
serves WebSocket topics, and computes WebRTC overlay topology. Browser code
talks to that server through the Rallar facade.

The platform is the substrate. Games and tools built on it keep their own match
rules, rendering, and product policy.

## Planes

- Control: REST authentication, tickets, and room membership.
- Events: WebSocket topics with server validation, authorization, and fanout.
- Realtime: WebRTC data channels for low-latency peer traffic.
- Persistence: browser `rallar.data` for local latest values, and server app
  data for durable application records.

## What belongs where

- Rallar Data is browser-local latest-value state. It is not live match truth.
- Rallar CRDT is collaborative authored documents. It is not competitive match
  authority.
- Rallar Motion smooths presentation. It is not the simulation.
- Rallar Game keeps match truth on the server. Clients send commands and render
  published snapshots.
- RallarAI output is a proposal until domain code validates and accepts it.

`docs/architecture.md` records why these boundaries exist. `examples/README.md`
shows the smallest copyable use of each surface.

## Recovering a room deadline

An active room owner or admin can publish a named UTC deadline through
`rallar.rooms.setDeadline(roomRef, change, requestId)`. Use expected revision
zero to create it. To extend it, supply the last accepted revision and a later
instant before the current deadline expires. Two editors can propose different
extensions from the same revision. One succeeds, and the other receives a
revision conflict. Reusing the same request ID and payload recovers the original
acknowledgement after a lost response.

An appointed room director can extend a published deadline during its live
window. Pass the appointment epoch captured when the director chose to extend.

```ts
await rallar.rooms.setDeadline(roomRef, {
    name: deadline.name,
    expectedRevision: deadline.revision,
    expectedDirectorEpoch: appointment.epoch,
    atEpochMs: deadline.atEpochMs + 60_000
}, requestId);
```

The authenticated principal and session must still hold that appointment in
the room. A leadership change returns HTTP 409 with mutation failure code
`room-director-changed`. Discard the old director intent. A concurrent extension
returns `room-deadline-revision-conflict`; read the winning deadline before
deciding whether to propose a new change. Both codes are available on the
SDK error’s `mutationFailure.code`.

A member can call `rallar.rooms.readDeadline(roomRef, name)` without switching
the selected room. It reads the durable deadline or returns `null` for a name
that has never been published. PostgreSQL deployments retain the instant and
revision across API restarts. Each room supports up to 32 distinct names over
its lifetime. At or after expiry, an owner or admin can reuse the same slot for a new round:
pass `operation: 'start-next-occurrence'`, the last observed `expectedRevision` and a future
`atEpochMs` to `setDeadline`. Competing starts have one winner. Use
`deadline.startedAtRevision ?? 1` as the occurrence identity. It stays constant across extensions
and changes on every new round, even when a participant misses several updates.
Deploy occurrence-aware readers and writers before starting a second occurrence.

Connected room participants can use `rooms.watchDeadline` to observe an extension
while the room is open. The server’s room WebSocket event announces the revision.
The SDK reads durable state on entry, revision changes, reconnect and resume.
An idle deadline requires no polling. The calibrated clock drives the countdown
on each device, and the receiving application decides whether an action arrived in time.

Deploy the deadline-aware API on all writers before publishing the first
deadline. Applications that replace room metadata must omit the reserved
`rallarRoomDeadlines` field. Upgrade browser clients that use
`rooms.updateMetadata` before enabling deadlines in those rooms.

The [two-room poll](../examples/shared-deadline-poll/README.md) uses the closing
instant to decide whether to accept a ballot. Rallar owns the deadline and its
revision. The application owns voting rules and receipts. The deadline causes
no automatic action when it passes.

## Pausing a room clock

An appointed room director can run a named countdown. For example, a referee starts a ten-minute period with
`rooms.changeClock(roomRef, { name: 'period', operation: 'start', durationMs: 600000, expectedRevision: 0, expectedDirectorEpoch: appointment.epoch }, requestId)`.
Send `pause` or `resume` with the current revision and appointment epoch and omit the duration. Retrying the same command
uses the same request ID. A stale revision returns `room-clock-revision-conflict`; an obsolete director receives
`room-director-changed`. An expired clock can start again at its current revision. Each room supports 32 clock names.

`rooms.readClock` returns the durable record or `null`. `rooms.watchClock` delivers a current or stale observation, rereads
on WebSocket invalidation and recovery, and makes no periodic clock reads. A running record stores its UTC end; clients use
the calibrated clock to display time and derive expiry. A paused record stores the exact remaining milliseconds. Passing time,
room changes, director replacement and server restarts leave a pause intact. Losing the director does not automatically pause a
running clock. The [scoreboard](../examples/room-scoreboard/README.md) demonstrates these controls.
Deploy clock-aware writers before creating clocks and before permitting raw room metadata replacement.

## Director-controlled room timelines

A room owner or admin can enable director succession, designate a deputy, or appoint a specific
present session through `rooms.changeDirector`. An explicitly appointed or designated spectator
can direct the room. `rooms.readDirector` and `rooms.watchDirector` expose the current appointment
and succession state to a room client. The observer recovers over the existing room WebSocket.

By default the director has 30 seconds to reconnect, followed by 30 seconds for the designated
deputy to claim. The organizer can change either duration. Each claim checks server time, current
room presence and the observed appointment epoch. An explicit admin appointment takes precedence.
Handover preserves running and paused programs, and invalidates delayed clock writes from the
former director.

After the reconnect window, a present player can send `claim-player` when the room has no
eligible deputy or the deputy has declined or timed out. The first accepted claim establishes a new
appointment epoch. Waiting and away lobby commitments do not confer director authority. Ordinary
spectators remain ineligible for this fallback. A returning participant recovers the winning
appointment alongside the room program.

Use `rooms.advanceTimeline(roomRef, { name: 'match', phase: 'halftime', durationMs: 180000, expectedRevision, expectedDirectorEpoch }, requestId)`
to start a phase and its countdown in one durable group update. Revision zero starts a new name. An advance can replace a running,
paused or expired phase. Reusing a phase label creates a new occurrence. The director chooses the label and when to advance.
A phase is an application-defined identifier of 1–64 ASCII letters, digits, dots, underscores or hyphens. The application supplies display text.

`rooms.readTimeline` and `rooms.watchTimeline` accept the room and clock name. Each observation combines the phase identifier,
its `startedAtRevision`, the current clock revision and either `endsAtEpochMs` or `remainingMs` from one room snapshot.
A missing timeline returns null. Members can keep room B selected while following a named timeline in A
in the same application and workspace. Retain membership in A when switching rooms.
Private WebSocket notices identify the affected room and program. The SDK reads the phase and clock together
at startup, on matching changes and after reconnect. A change to a different clock leaves the watch idle.
Access loss clears the cached timeline. Use the existing clock pause/resume commands with the same name.
The occurrence stays stable across those changes. At zero a phase with no configured successor remains current.

Use `rooms.extendTimeline(roomRef, { name: 'match', durationMs, expectedRevision, expectedDirectorEpoch }, requestId)`
to add a positive whole number of milliseconds to a running or paused phase. A running phase extends from its existing end.
A paused phase stays paused with a larger balance. Both keep the phase label and starting revision. An expired running phase
requires an explicit advance. Retry the original request unchanged with the same ID to recover its receipt.

A director can include `successor: { phase, durationMs }` in `advanceTimeline`, or call
`rooms.setTimelineSuccessor(roomRef, { name, expectedRevision, expectedDirectorEpoch, successor }, requestId)`
to configure, replace or cancel the next phase. Pass `null` to cancel. Authorized observers can read the planned phase
and its duration through `watchTimeline`. Pausing freezes the countdown, extending moves the boundary, and resuming
uses the saved balance. A replacement director inherits the plan. An early manual advance clears the previous plan.

When the countdown expires, the server starts the configured successor at the scheduled boundary, even if processing
resumes later or every browser has left. During a worker outage, reads return the last committed snapshot.
A late command cannot extend the old phase. When processing recovers, the successor uses the original boundary. The successor has its own duration
and no further automatic transition. Reconnecting participants recover the committed occurrence and clock together.

An empty temporary room stays available through the successor’s end. A temporary room with a paused named timeline
uses its `retention.pausedTimelineRetentionMs` window (1 ms to 24 hours, one hour by default), starting when it is both empty and paused.
Entering interrupts cleanup. Watching from another room leaves that deadline unchanged. Explicit room deletion still takes effect.

Timelines share the room's 32 clock slots. An advance can adopt an existing clock at its current revision. Retry a command with
its original request ID. A competing change reports `room-clock-revision-conflict`, and a lost appointment reports
`room-director-changed`. Upgrade group writers and clock readers before enabling timelines.
The server stores phase and starting revision on the named `rallarRoomClocks` record. Clock-only records remain valid.

## Fixed room schedules

An appointed director publishes a named sequence of 1–32 strictly increasing UTC starts in one room revision.
Use `rooms.publishSchedule(room, { name, expectedDirectorEpoch, expectedRevision, phases }, requestId)`,
where each phase contains `phase` and `startsAtEpochMs`. Revision zero creates the schedule; retry the same
publication with its original request ID. A later revision may edit future boundaries. Boundaries already reached
at the server, including those reached at any earlier accepted publication, must match the previous revision, including their labels. A schedule and a manually controlled clock
have separate names and share the room's existing capacity. Upgrade room clock readers and writers before publishing schedules.

A member can follow A’s program while staying in B. Pass A’s full room reference to
`rooms.watchSchedule(roomA, name, listener)` and keep the returned unsubscribe function.
Retain membership in A when switching to B with `rooms.enter(roomB, { preserveCurrentMembership: true })`.
The observer reads A on startup, on a scoped WebSocket notification, and on reconnect. It makes no
periodic HTTP requests. During a disconnect it marks the last schedule stale. When access is
revoked it clears that schedule. `rooms.readSchedule` reads the durable revision directly.
On each local display update call `rallar.schedulePosition(schedule, authority?)`. It uses one calibrated time window.
A current position supplies `current` and `next` with their UTC starts. Before the first start, current is null.
At a start the new phase applies inclusively, and the final phase continues. A window crossing a start returns
`uncertain`; loss of calibration returns `unavailable`. The app displays recovery while a watch is stale.
A boundary crossing requires no server write or network read and triggers no gameplay side effects.

The appointed director can freeze a published program with `rooms.pauseProgram` and restart it with
`rooms.resumeProgram`. Both accept the program name, expected revision, director epoch and request ID.
During a pause, a returning participant can read the frozen phase and milliseconds until the next
start even before clock calibration finishes. Resume shifts future program starts once. Independent
UTC deadlines retain their published times. A director disconnect preserves the program's state.

## Temporary games and pickup events

An app can enable private games for players with temporary identities. Starting a game creates the room and seats its creator in one operation. An invitation preview shows the room name and available seats. Joining takes an explicit action. The room has a fixed expiry, an empty-room return window, and an app-configured capacity that includes the creator. Grumpy Town uses four seats by default. Opening the shared link on a different device creates a separate visit.

Room management belongs to one player at a time. An explicit transfer gives a present player the invitation and moderation rights while the previous manager stays seated. The match director keeps running the current game. A lost connection can trigger game director succession while leaving room management with its current holder.

Operators grant organizer rights per application through `group.eventOrganizerIdsByApplication`. Deployment administrators can also organize events. An authorized organizer can use a private lobby to run several event-owned courts. Players consent to queue as a party, receive an offer for one court, and choose when to enter. A guest keeps their player identity and lobby membership when taking the court grant. The oldest group that fits has priority and individual offers expire after the configured claim window. The organizer or the current court director releases a court by its occurrence. Releasing one court leaves the other matches running. Event removal ends lobby and court access for that player, and optional link rotation stops new arrivals through the old invitation.

## Sharing rooms

AR Eye Hunter and Relic Hunters let hosts create code-protected or invite-only
rooms, share a link, rotate a code, and invite an account or revoke its invitation.
Hosts can also create an open unlisted room or hide an existing open room. Unlisted rooms stay
outside discovery and Quick Join, while anyone with the scoped link can request entry. Owners and
admins can list them again without changing membership. Listing does not bypass capacity, bans,
or lifecycle admission rules. Private rooms stay outside the open directory regardless of listing. A link identifies its application,
workspace, and room; an invite-only link still requires an account invitation.

Owners and admins can confirm Remove, Ban or Unban from Room moderation in both games. Owners
cannot be removed; admins cannot moderate other admins, and nobody can target themselves there.
Remove requires a new invitation to return. Unban permits a fresh admission attempt and never
joins the player automatically. Explicit revocation stops the affected player's room participation,
explains the loss of access and leaves other rooms available. Leaving locally never erases a ban.
Both games use the SDK's `rooms.watchAccess(roomRef, listener)` to observe membership, including in ordinary
rooms. It checks the authorized room snapshot on startup, private access notifications, and recovery.
Idle observation makes no periodic access requests. For a room with a storage expiry time, the SDK
rechecks access when the earliest calibrated server time reaches the cutoff. If storage still reports the same cutoff,
the SDK rechecks with backoff until storage confirms expiry or supplies a new cutoff. A disconnect marks the observation stale.
An authoritative refusal distinguishes a ban, removal or unavailable access. Relic's existing Keeper
takeover and round timeout preserve ongoing play; accepted plans and saved expedition progress remain.

Both games refresh public room discovery automatically while signed in, visible, and online.
They refresh on returning to the foreground and then wait 30 seconds after each completed refresh.
Manual Refresh remains available; a failed refresh labels the last complete list as stale. Discovery
never changes the selected room or joins an activity. Browser suspension, slow requests, and network
failures can delay fresh results.

Guests keep the intended destination through sign-in and tab reload. They can
correct a rejected code, retry, cancel, or open a newer invitation. Successful
entry discards the saved code and associates the return destination with that
account. Active members can return after code rotation or expiry; new entrants
still need valid admission, and banned members and inactive rooms remain denied.

Both games keep up to ten recent rooms on this device for each account and application/workspace.
Return checks current server admission without saving a room code. A fresh invitation still takes
precedence over a restored destination. Forget removes only the local shortcut; it does not leave
the room or change membership. History loading or storage failures are shown separately from entry
failures and can be retried.

New rooms in both games are temporary: empty rooms disappear from discovery, and server maintenance
archives them after observing ten minutes of uninterrupted inactivity. Current members may reconnect
during that grace period under normal admission rules. Activity between observations restarts grace.
Existing rooms and other applications stay persistent unless creation explicitly selects temporary
retention. After seven archived days, maintenance permanently removes the room, memberships,
presence, and its Relic expedition save. Audit and replay evidence retain their existing lifetime.
A deleted room cannot be recreated by returning to it or replaying an old game command.

Room admission is separate from gameplay participation. Relic still requires
Join Expedition; AR Eye keeps its director and match lifecycle. The shared
browser entry owner and a host-sharing example are documented in
`examples/browser-startup-room/README.md`.

## Watching games

AR Eye Hunter and Relic Hunters offer Watch alongside player entry. New rooms allow 16 spectators
in addition to player capacity. Existing rooms enable watching only when their owner configures
spectator capacity. Code protection, invitations, bans, room expiry, and removal apply to watchers.
Directory counts distinguish players and spectators, so a full player room can still be watched.

Watching creates an active spectator membership and live presence, without a gameplay participant.
AR Eye provides a spectator camera and the public arena state; Relic shows its existing public
expedition view. An unfinished expedition participant must explicitly leave before switching to Watch;
watching does not silently abandon their expedition role. Watchers cannot move, attack, submit turns, start AI work, modify room documents,
or become the game director. Relic reads do not initialize an absent expedition.

Join as player is an explicit admission attempt. It checks player capacity and the current game's
entry rules; refusal leaves the watcher in place. Reload and recent-room Return preserve the
server's current role. Membership roles apply to the account across its sessions. An owner or admin
must transfer or relinquish governance before switching to read-only watching. Live spectator
sessions keep temporary rooms active under the normal retention policy.

## Playing again together

After completed results, players in AR Eye and Relic can confirm Play again, cancel that confirmation,
and see who is ready or away. The current director or Keeper starts explicitly after every remaining
present candidate confirms, including the leader. Spectators do not block readiness; newcomers must
opt in. Settings changes clear confirmations. Reload preserves the same session's accepted readiness;
changed membership or a different session requires a fresh confirmation.

The next game stays in the same room and includes only eligible consenting players. Relic retains
their characters and resets expedition progress; AR Eye starts fresh score baselines. Finished results
remain visible until accepted start. Reset and the old start controls cannot bypass this consent flow.

## Individual tournaments

Both games offer four-account tournaments with two registration-order semifinals and a final.
The organizer creates and shares the bracket; each player registers explicitly. The organizer
schedules each match, both competitors check in, and the organizer starts at or after its scheduled
time. Enter match opens the admitted room without removing earlier room memberships. The bracket
and accepted results survive reload and account sessions.

The game server decides native scores: AR Eye runs a one-minute arena match; Relic runs ten rounds.
Relic keeps the 60-second planning timeout and advances each round review after 10 seconds, even
if the Keeper disconnects. Tournament rooms remain recoverable for 15 minutes after everyone
disconnects, then follow the seven-day archived-room deletion policy. Ordinary rooms keep their
10-minute reconnect grace. Only the two bound accounts can play. Spectators remain read-only. A tie requires a new attempt in a
fresh room; secondary statistics never select a tournament winner. Ordinary rematch, reset and
settings controls cannot change an active tournament or rewrite its accepted result.

The no-show grace defaults to ten minutes and is configurable per game. After the deadline, only a
checked-in opponent may advance, including when the other entrant withdrew. Neither checking in
leaves the match unresolved for organizer rescheduling or cancellation. A disconnected player is not
an explicit withdrawal. Cancellation stops unfinished play and keeps completed evidence available.

## Scheduled sessions

AR Eye and Relic let an organizer schedule an unlisted temporary room, copy its session link,
and change or cancel the schedule before its lobby opens. Following the link previews the session
without leaving the current game. Signed-in accounts can reserve one player seat, withdraw that
reservation, and find their sessions again after reload. The organizer occupies one player seat.
Rescheduling releases reservations and asks interested accounts to review and confirm the new time.

Applications can enable guest booking with `group.guestBookingByApplication`. The organizer then
selects **Allow guest reservations** when scheduling. A signed-out visitor with the session link
can reserve a lobby seat weeks ahead, withdraw it, or return in the same browser to review a changed
time. Forwarding the link lets another visitor book an available seat with their own browser.
At lobby opening the guest explicitly claims the reservation to receive room access. Booking
provides no court assignment. Existing sessions continue to accept signed-in reservations only.

The lobby opens ten minutes before the scheduled start. Entry claims the account's reserved seat;
accounts without reservations can enter only if an unreserved seat is available. The current host
starts gameplay explicitly at or after the scheduled time. Passing the start time never starts a
game automatically. Unclaimed reservations expire ten minutes after start, releasing their seats.
Spectators use the separate spectator capacity. Reservation identities are private to each account;
shared room events carry only an anonymous change notification.

A future session survives an empty room until the reservation deadline, then receives the usual
reconnect grace. Live presence keeps the room active. Normal temporary-room archival and seven-day
deletion apply afterward, including private session records and room-owned game saves.

## Keep a seat while visiting another room

For a finite-capacity player lobby, set `roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 }`
at creation or use the lobby owner's `configure(roomRef, policy)`. Ordinary room entry is the default.
An account can hold one lobby commitment per application and workspace. Its seat survives a room switch
or disconnect. When the last player arrives, absent holders get a return deadline. When the roster drops
below capacity their countdowns stop. A new fill gives them a fresh window. An accepted arrival in the
original room secures the seat before its deadline. The room directory counts occupied player seats, including
provisional arrivals, and reports how many seat holders are online. Quick Join uses the same ordering
and checks live capacity when admitting a player. Seat holder identities stay private.

Use `RallarRoomLobby` from `@shared-web/browser/rooms/lobby/rallar-room-lobby.ts`. Create
`new RallarRoomLobby(rallar, scope)` at application scope and call `start()`. Subscribe with
`onChange(listener)` or inspect `getState().view`. Its private seat identifies the room, arrival or
presence status, and current deadline. Scoped account WebSocket changes and returning to the foreground
wake a durable read. Use `release(roomRef)` for an explicit release, `retry()` for an uncertain command,
and `stop()` when the application ends observation. Stopping observation preserves the commitment.

Use `wait(roomRef)` to request the next available place without entering the room. For a room with
a join code, supply `{ joinCode }` as the second argument. A waiting player can visit another room,
disconnect, or cancel with `release(roomRef)`. When a place opens, the server offers it to the oldest
eligible waiter and protects the place until the offer expires. The private seat changes from
`waiting` to `offered` and includes the deadline. Enter the room through normal room admission
to claim it. A decline, expired offer, or loss of access frees the place for the next eligible waiter.
Scheduled reservations keep their places until withdrawal or the no-show deadline.

An organizer can set a UTC cutoff with `setRegistrationCutoff(roomRef, { expectedRevision, atEpochMs })`.
Read the current revision and status with `RallarRoomLobby.registration(snapshot.group.metadata, rallar)`.
Before the cutoff, pass a new time to reschedule or null to cancel. At the cutoff the server stops
new registrations and offers. Settling closure clears the waiting list and releases its scoped commitments.
If the timer worker is recovering, a waiting player can claim another managed room once settlement commits.
An offer issued before closure remains claimable
until its displayed deadline. The SDK reports `uncertain` while the calibrated time window crosses
the cutoff and `unavailable` when a scheduled cutoff cannot be compared with server time.

To close registration when play begins, use `lobby.setRegistrationBoundary(roomRef,
{ expectedRevision, expectedProgramRevision, program: 'match', phase: 'play' })`.
Use the registration revision from the current room snapshot. Re-enabling a lobby starts a new revision, so a delayed command from its previous activation is rejected.
The organizer chooses a phase that occurs exactly once in the published program. The cutoff
moves with revisions to that phase. Pausing before it suspends the cutoff; resuming sets its
new UTC instant. The registration view exposes the binding and its effective `atEpochMs`,
which is null while the future boundary is paused. A running worker closes registration even
when the room is empty. Seat offers issued before closure keep their original claim deadlines.
To remove or rename a bound phase, clear or replace the cutoff while registration is open.

## Find players and start together

AR Eye's Find a game and Relic's Find an expedition form a new group in the current game and
workspace. Each account has one active search in that scope. Defaults are two players, two minutes
to find a group and thirty seconds for everyone to confirm; operators can configure these per game.
Nobody enters until all players confirm and the server admits the whole group to one unlisted,
temporary room. Each player then chooses Enter matched room and uses the normal game lobby;
the director or Keeper starts gameplay explicitly.

A player can switch rooms while searching and confirm from the room they are visiting. Confirmation
leaves that room selected. The SDK listens for private WebSocket updates scoped to the account,
application and workspace. It reads the current search on notification, reconnect or foreground
return, including restoration from the browser's back/forward cache. Idle searches require no HTTP polling.

Cancel, decline and timeout end the whole pending group. They never automatically requeue players.
A new search is always an explicit choice, including after a successful match. Reload recovers the
account's current search or result. An uncertain write offers Retry with the same request identity.
Signing out clears the browser view; server deadlines continue without an open browser. Quick Join
continues to offer immediate admission to an existing suitable room.

## Parties that stay together

AR Eye and Relic let mutual friends create a party, invite each other and explicitly accept or
decline. Parties belong to one game and workspace; each account can belong to one party in that
scope. The roster distinguishes Present from Away. Invitations expire after ten minutes by default;
party capacity follows the game's configured match size.

The party leader searches for everyone while all members are present. A party stays indivisible;
other searching parties or solo players fill remaining seats. A full party proceeds directly to
confirmation. Every member confirms separately. A roster change cancels a pending search or
confirmation, and nobody enters unless the whole matched group can be admitted.

Party membership survives reload, gameplay, Play again and Move together. The leader can transfer
leadership or disband; leaving transfers leadership to the earliest remaining member. When the
leader's server presence expires, a present member can explicitly take leadership. Reconnecting
does not reclaim it. Party leadership grants no director or Keeper authority. Leaving the party
keeps existing room memberships and game participation.

## Friends and invitations

AR Eye and Relic share an account-wide friend list. Enter an exact username to send a request;
the recipient explicitly accepts or declines. Sending a reciprocal request never accepts it.
Either person can remove the friendship. Blocking removes requests, friendship and pending
invitations in both directions; unblocking does not restore consent. These actions do not remove
independent room memberships.

Online sharing is off by default and can be turned off again. Mutual friends see only whether a
sharing account is online in the current game and workspace, never its current room or sessions.
The panel refreshes while foreground and online, every thirty seconds, and on explicit Refresh.
Room location is disclosed only by an explicit invitation. Invitations expire after seven days by
default. Opening one rechecks consent and uses the normal room admission or scheduled-session
preview and RSVP flow; it grants no seat, membership, join code, or gameplay authority by itself.
Reload restores the private list. An uncertain write offers Retry with the same request identity;
signing out clears the view and pending browser work.

## Moving together

AR Eye and Relic let present players propose another room in the same application and workspace.
When in a party, only its leader proposes and every party member must be present in the source
room; unrelated room members stay. Without a party, the proposal includes the room's present players.
Every selected player session confirms, then the organizer explicitly chooses Move everyone.
Spectators stay. Capacity and current access rules are checked for the whole group at commit;
if one player cannot enter, no destination membership changes.

Admission and arrival are separate: each browser connects to the destination before disconnecting
its source presence. Old-room memberships and governance remain. The roster labels members
Present or Away; Away members retain access subject to current bans, room lifecycle and entry
rules. Membership alone neither keeps a temporary room live nor makes somebody a gameplay player.
Explicit Leave room remains available separately.

A two-minute proposal can be withdrawn, declined or cancelled before commit. Reload and retries
recover the server decision. A failed browser entry shows an explicit retry while retaining its
admitted membership. AR Eye blocks departure during an active match. Relic requires unfinished
hunters to finish or explicitly Leave expedition, and destination Join Expedition stays explicit.

## Fit

| Kind of product                              | Fit                         | What to use                                                                                      |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| Turn-based or async multiplayer              | Strong                      | Rooms, durable group state, validated commands, reconnect, event fanout                          |
| Social or collaborative rooms                | Strong                      | Presence, group state, WebSocket events, local data, server app data                             |
| Casual realtime rooms                        | Good                        | WebRTC realtime lanes for cursors, avatars, and lightweight shared state                         |
| Authoritative matches                        | The game layer              | Server match truth, client commands, Motion only for presentation                                |
| Competitive twitch games or MMO-scale worlds | Outside the current product | Needs interest management, sharding, and game-specific infrastructure this repo does not provide |

## Subproducts

Shared packages are the reusable surface. Apps are consumers.

- `packages/shared` holds runtime-agnostic contracts.
- `packages/shared-web` is the browser facade. Start at
  `packages/shared-web/browser/README.md` and `docs/rallar-api-reference.md`.
- `packages/shared-server` is the server domain. Start at
  `packages/shared-server/README.md`.
- `packages/shared-graph` owns topology generation.
- `packages/shared-test` owns black-box recipes, the control protocol, and
  artifact analysis.
- `apps/api-v1` is the generic Rallar server shell (Bun, Hono, Postgres). It
  is not a game server. See `apps/api-v1/README.md`.
- `apps/ar-eye-hunter-v1` is the broad browser game: rooms, RTC, game
  authority, Motion, and a RallarAI director.
- `packages/ar-eye-hunter` owns renderer-independent arena rules and the native tournament authority.
- `apps/ar-eye-hunter-server-v1` composes that authority with Rallar for tournament matches.
- `apps/relic-hunters-v1` is the browser game with a narrow runtime adapter.
  Its notes live in `apps/relic-hunters-v1/docs/README.md`.
- `apps/relic-hunter-server-v1` composes the Rallar server with Relic rules and
  server-side RallarAI.
- `apps/rallar-black-box` is the operator console for recipes, diagnostics, and
  distributed runs. See `apps/rallar-black-box/docs/README.md`.
- `apps/rallar-black-box-control-server` and `apps/rallar-black-box-headless`
  run and host those distributed browser agents.
- ALM is the message protocol. Its delivery roadmap (Releases 1 to 11,
  `playground/alm/alm-improvement-plan.md`) is complete; the design that
  continues is the publication QoS and pub/sub addendum,
  `playground/alm/alm-publication-qos-addendum.md`. The product contract is
  `playground/alm/alm-complete-product-description.md`. The code maps are
  `packages/shared/alm/inbound/README.md` and
  `packages/shared/alm/outbound/README.md`.

## Operating and recovering rooms

The Black Box Recipe Console's Advanced view provides **Room operations and recovery** for
API administrators. Find rooms within one application/workspace, inspect membership versus live
presence and admission/retention facts, then request a topology recompute and observe its exact
retained work outcome. Private and archived rooms are visible to operators without changing
ordinary discovery or player admission. Invalid diagnostic rows are redacted and cannot be selected;
unavailable evidence, including gameplay participation, remains unknown.

A queued receipt is acceptance, not completion. The console rereads room evidence after observing
work completion and does not claim that gameplay or connectivity recovered. An uncertain command
can be retried with the same request identity. Global expired-record maintenance is separately
labelled, requires preview followed by explicit execution, and affects all applications/workspaces
for the selected stores. API authentication is independent of control-server tokens. Logout, lost
authority, account replacement and room/scope changes discard the previous private view and work.

## Where to go next

- Build something small: `docs/rallar-quickstart-and-recipes.md` and
  `examples/README.md`.
- Smooth presentation, or keep match truth on the server:
  `docs/rallar-motion-guide.md` and `docs/rallar-game-guide.md`.
- Operate a deployment: `docs/production-deployment.md`,
  `docs/environment-variables.md`, and
  `docs/rallar-troubleshooting-checklist.md`.
- Change the repo: `AGENTS.md` and the skill for the surface you are touching.
