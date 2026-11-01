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

## Sharing rooms

AR Eye Hunter and Relic Hunters let hosts create code-protected or invite-only
rooms, share a link, rotate a code, and invite an account or revoke its invitation.
Hosts can also create an open unlisted room or hide an existing open room. Unlisted rooms stay
outside discovery and Quick Join, while anyone with the scoped link can request entry. Owners and
admins can list them again without changing membership. Listing does not bypass capacity, bans,
or lifecycle admission rules. Private rooms stay outside the open directory regardless of listing. A link identifies its application,
workspace, and room; an invite-only link still requires an account invitation.

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

## Scheduled sessions

AR Eye and Relic let an organizer schedule an unlisted temporary room, copy its session link,
and change or cancel the schedule before its lobby opens. Following the link previews the session
without leaving the current game. Signed-in accounts can reserve one player seat, withdraw that
reservation, and find their sessions again after reload. The organizer occupies one player seat.
Rescheduling releases reservations and asks interested accounts to review and confirm the new time.

The lobby opens ten minutes before the scheduled start. Entry claims the account's reserved seat;
accounts without reservations can enter only if an unreserved seat is available. The current host
starts gameplay explicitly at or after the scheduled time. Passing the start time never starts a
game automatically. Unclaimed reservations expire ten minutes after start, releasing their seats.
Spectators use the separate spectator capacity. Reservation identities are private to each account;
shared room events carry only an anonymous change notification.

A future session survives an empty room until the reservation deadline, then receives the usual
reconnect grace. Live presence keeps the room active. Normal temporary-room archival and seven-day
deletion apply afterward, including private session records and room-owned game saves.

## Moving together

AR Eye and Relic let present players propose another room in the same application and workspace.
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
- `apps/api-v1` is the generic Rallar server shell (Deno, Hono, Postgres). It
  is not a game server. See `apps/api-v1/README.md`.
- `apps/ar-eye-hunter-v1` is the broad browser game: rooms, RTC, game
  authority, Motion, and a RallarAI director.
- `apps/relic-hunters-v1` is the browser game with a narrow runtime adapter.
  Its notes live in `apps/relic-hunters-v1/docs/README.md`.
- `apps/relic-hunter-server-v1` composes the Rallar server with Relic rules and
  server-side RallarAI.
- `apps/rallar-black-box` is the operator console for recipes, diagnostics, and
  distributed runs. See `apps/rallar-black-box/docs/README.md`.
- `apps/rallar-black-box-control-server` and `apps/rallar-black-box-headless`
  run and host those distributed browser agents.
- ALM is the message protocol. Its delivery roadmap (Releases 1 to 8,
  `playground/alm/alm-improvement-plan.md`) is complete; the design that
  continues is the publication QoS and pub/sub addendum,
  `playground/alm/alm-publication-qos-addendum.md`. The product contract is
  `playground/alm/alm-complete-product-description.md`. The code maps are
  `packages/shared/alm/inbound/README.md` and
  `packages/shared/alm/outbound/README.md`.

## Where to go next

- Build something small: `docs/rallar-quickstart-and-recipes.md` and
  `examples/README.md`.
- Smooth presentation, or keep match truth on the server:
  `docs/rallar-motion-guide.md` and `docs/rallar-game-guide.md`.
- Operate a deployment: `docs/production-deployment.md`,
  `docs/environment-variables.md`, and
  `docs/rallar-troubleshooting-checklist.md`.
- Change the repo: `AGENTS.md` and the skill for the surface you are touching.
