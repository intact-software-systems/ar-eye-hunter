# Browser room ownership

`browser-rallar-rooms.ts` composes the public `rallar.rooms` facade. Its public inputs,
results, and state live in `rallar-room-contracts.ts`. Start at the concrete facade
method, then follow its named workflow below.

`rallar.rooms.selected()` reads a defensive copy of this authenticated session's
explicit room selection. It can remain available while `rooms.current()` has no
active presence snapshot, allowing an application to retain its paused view.
It is intent, not proof of membership, room existence or permission. Explicit
departure and observed membership revocation clear selection; session replacement
cannot inherit it. Rallar's selected-room recovery owns presence restoration.
Applications must keep a bounded unavailable outcome and local exit for a room
that cannot be restored, including a missing or inactive room.

| Capability                                                                 | Owner                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Private link, pending sign-in destination, scoped reload, and cancellation | `entry/rallar-room-entry.ts` and `entry/room-entry-validation.ts`                 |
| Account-scoped recent history and local Forget                             | `recent-rooms/rallar-recent-rooms.ts`; Return uses the entry owner above          |
| Create a room                                                              | `create-and-join-room.ts`                                                         |
| Join, Watch, Quick Join, Move, and clean up the previous room              | `join-room.ts`                                                                    |
| Restore the selected room's presence when its socket reopens               | `entry/selected-room-recovery.ts`                                                 |
| Wait until a presence write is listed in the room's presence summary       | `room-presence.ts`                                                                |
| Adopt admitted snapshots and recover conflicting observations              | `adopt-joined-room.ts`                                                            |
| Leave membership and presence                                              | `leave-room.ts`                                                                   |
| Invite, revoke, rotate codes, and govern members                           | `room-membership.ts`                                                              |
| Read or conditionally extend a durable named room deadline                 | `deadlines/room-deadlines.ts`                                                     |
| Apply a targeted room mutation and accept its snapshot                     | `update-room.ts`                                                                  |
| Resolve scope and fence replaced sessions or aborted operations            | `room-target.ts`, `room-session-fence.ts`                                         |
| Observe current state, presence readiness, and accepted transport targets  | `room-state-store.ts`, `room-presence.ts`, `room-transport-target-observation.ts` |
| Plan and observe formation/layout commands                                 | `formation/`                                                                      |

The group-state workflows own command identity and HTTP retry policy. Creation,
admission, and presence use `room-group-state-workflows.ts`; lifecycle/configuration
uses `room-group-state-mutation-workflows.ts`; membership policy operations use
`room-membership-group-state-workflows.ts`. Their HTTP boundary is
`room-group-state-http-api.ts`, and canonical state-to-room translation is
`room-group-state-translation.ts`.

`read-room-membership-revocation.ts` classifies only explicit membership-denial HTTP errors.
The leave workflow uses it to finish local departure without rewriting a ban; the facade's
single-room refresh uses it to clear matching selection and conditionally evict the observed cache.
`shared-react/room-moderation-panel.tsx` presents confirmation and access-loss outcomes in both games.
It observes room state and performs bounded access reads; entry cancellation remains owned below.

`RallarRoomEntry` coordinates browser intent and persistence. It delegates admission
to the existing join facade; it does not authorize membership or implement another
join algorithm. The server's AppInbox operations remain the mutation authority.
Room admission and an application's activity participation are separate decisions.

Import the entry, recent-room, and directory owners directly from their paths above. They
use `packages/shared/cache/synchronous-notifications.ts` for synchronous listener delivery,
replay, and reentrant state changes. Their domain state and lifecycle decisions remain local.

Watch is an explicit join intent, not a second admission owner. The same membership/presence
workflow forwards `participation`; player promotion uses the same path and current server policy.
Entry persistence records `preserve` after admission so recovery follows the authoritative role.

`adopt-joined-room.ts` resolves conflicting admission observations through the existing
scoped authoritative point read. Explicit destination selection waits for hydration and
the initiating session fence; previous-room cleanup follows successful adoption. Cache
notifications may still restore a room from authoritative session presence, as on reload.

## Guest invitations

A signed-in owner creates an invitation using a fresh secret and sends its verifier in the room update. Share the secret only with invited players. Before signing in, the invited browser can call `redeemRoomGuestInvitation` from the shared-web package with the room reference, invitation secret, its own secret generated by `createRoomGuestSecret`, and a request ID. Keep that browser secret and request ID for retries after a lost response. A successful redemption returns a session scoped to that room. Store the original admission expiry and the exact room reference in the auth session’s `guestRoom` field. When its calibrated clock reaches admission expiry, the browser SDK verifies the room once. A participant in the active guest-play occurrence can finish it until its recorded cutoff or an earlier close. Reloading or reconnecting with the original credential repeats that verification. A transport failure preserves the credential for reconnect. After a reconnect, refresh the room and subscribe to its events. The server enforces seat capacity, expiry and removal.

## Scheduled sessions

Import `sessions/rallar-scheduled-sessions.ts` directly. Its account-bound owner loads personal
sessions and a selected preview, preserves stable IDs across uncertain writes, and fences replaced
accounts and destinations. `sessions/scheduled-session-http-api.ts` owns exact HTTP decoding and
bounded transport attempts. Shared timing and preview contracts live in `shared/api/group-sessions`.
`RallarRoomEntry` persists `preview-session` intent and performs admission only after explicit lobby
entry. The optional React view lives in `shared-react/scheduled-sessions-panel.tsx`.

## Named deadlines

After authentication, call `rallar.rooms.readDeadline(roomRef, name, { signal })` for the durable
deadline or `null` if the room has no deadline with that name. Supply the full application,
workspace, and group reference. To create one, use
`rallar.rooms.setDeadline(roomRef, { name, expectedRevision: 0, atEpochMs }, requestId, { signal })`.
The returned deadline carries its committed revision. An authorized extension supplies that revision
and a later instant before the current deadline expires. Keep one request ID (such as
`crypto.randomUUID()`) per intended write and reuse it when retrying after a lost response.

Call `rallar.rooms.watchDeadline(roomRef, name, listener, { signal })` after connecting
and entering the room. The listener receives `{ status, deadline }`. A current
null means the name is absent. A stale value is the previous observation during
initial load, suspension, disconnection or read failure. Dispose with the returned
function or abort the signal when switching rooms.

The initial durable read is followed by server WebSocket group events. A higher
named revision triggers a durable read. Unchanged deadlines generate no periodic
requests. Reconnect and page resume reread current authority. Transient transport failures retry while the watcher is active, with delays capped at 30 seconds.
Other read failures have three retries per wakeup. An authoritative denial ends the retry cycle. Display countdowns locally using the calibrated
clock and enforce time-sensitive actions at their receiving authority.

An app enabled for temporary games can start a room before account sign-in.
Configure the API client first, then construct `TemporaryRoomCreation` from
`rooms/entry/temporary-room-creation.ts` with the application/workspace scope
and browser storage. Its `start({ capacity, displayName }, signal)` saves the
request ID and private creation proof before sending. Both options may be omitted.
Retry with the same scope and storage after a lost response or a reload. Save
the returned room, room-scoped guest access and invitation secret before calling
`clear()`. Only the invitation secret belongs in the shared link.
`previewRoomGuestInvitation(room, secret, signal)` reads the room name and seat
availability without admitting the visitor. An uncapped room returns null for
both seat counts. The visitor explicitly redeems the invitation to join.
