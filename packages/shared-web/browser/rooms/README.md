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
`rooms/entry/temporary-room-creation.ts` with the application/workspace scope. Its `start({ capacity, displayName }, signal)` saves the
request ID and private creation proof before sending. Both options may be omitted.
Retry with the same scope on this device after a lost response or a reload. The SDK keeps the private proof in its encrypted browser credential store. Save
the returned room, room-scoped guest access and invitation secret before awaiting
`clear()`. Only the invitation secret belongs in the shared link.
`previewRoomGuestInvitation(room, secret, signal)` reads the room name and seat
availability without admitting the visitor. An uncapped room returns null for
both seat counts. The visitor explicitly redeems the invitation to join.

`RallarRoomEvent` from `rooms/events/rallar-room-event.ts` follows a specific
event lobby. Construct it with the browser facade and lobby reference. Call
`start()` on mount, subscribe with `onChange`, and call `stop()` on unmount.
The initial read, a private WebSocket notice, reconnect or foreground return
recovers the player's current event view. Before an organizer creates the event,
an authorized lobby member sees an empty view. An idle watcher sends no timer reads.

Send organizer and queue commands with `act(command)`. A proposed party enters
the queue once every invited player consents. Pass the displayed proposal's
`proposalRevision` when accepting and the offer's `offerRevision` when declining. `enterCourt()` claims the current
offer and enters the matching court. Its saved request recovers a committed
claim after transport loss or reload. `returnToLobby()` reselects the event
lobby without surrendering its membership. A temporary player uses distinct
room credentials for those two connections under the same player identity.
Start a guest visit with `auth.activateGuest({room, access, username})` using
the admission Rallar returned for that room. After a page reload, restore the same player
by passing their previously saved room admission to `activateGuest` again. A signed-out event
watcher waits for authentication. With an active court visit, the watcher retrieves the
same player's lobby grant from the protected credential store before reading the event.

A signed-in event organizer can mount `event.organizerView()` independently of the player view.
Call `start()`, subscribe with `onChange`, and call `stop()` when the roster closes.
Its snapshot contains event-local player names, parties in queue order, court occurrences,
and seats. A seat's numeric deadline is its claim cutoff; a null deadline identifies a
claimed seat. Private changes, foreground return and reconnect refresh the roster.
Watching another court preserves room selection. A denied read clears the roster.

To hand over an event, the current organizer sends `offer-handover` with a
`recipientId`. The recipient must be an app-authorized organizer with a live
session in the lobby or their claimed court. The sender and recipient see the
pending offer on their private event view. Pass its `offerId` to
`cancel-handover` or `accept-handover`. Acceptance rechecks presence,
authorization and server time. The former organizer then loses event management
and roster access; occupied courts keep their existing clock and allocation.


### Scheduled guest reservations

For a scheduled room in an enabled application, pass `guestBooking: true` to
`RallarScheduledSessions.create`. A signed-out client opens the usual session link and creates a
`GuestSessionBooking` for its scoped room. Call `preview()` to read current timing, availability
and that browser’s participation. Pass the displayed revision to `change('reserve', revision)`
or `change('withdraw', revision)`. At arrival, `claim(revision)` returns the scoped guest
admission used by `auth.activateGuest`. The SDK stores the browser proof separately from the link
and can retry interrupted writes. A second browser needs its own available seat.

### Court-ready notifications

For optional device alerts, import `readCourtAlertPublicKey`, `enableCourtReadyNotifications`
and `disableCourtReadyNotifications` from `events/court-ready-notifications.ts`.
Read the public key while mounting the event. A null value means delivery is disabled.
From the player's tap handler, call
`enableCourtReadyNotifications(event, registration.pushManager, publicKey)`.
The same operations apply to an admitted guest and a signed-in player. Disabling alerts
withdraws consent for that device and event. Enabling alerts checks the browser subscription’s
application server key before storing consent. On a key mismatch, an organizer can restore
the previous VAPID identity or enroll under a separate service-worker registration.

In the service worker, use `courtReadyNotification` to display the generic alert and
`openCourtAlertClick` to remember the tapped offer before focusing or opening the app.
On startup, foreground return or the `COURT_ALERT_OPENED` worker message, read
`readCourtAlertClick` for this exact event and refresh the player's private view.
Use `courtAlertStatus` to compare the clicked offer against current authority. The player's
private `view.lastExpiredOffer` also reports an unclaimed deadline after a bare app launch,
even when the OS supplies no notification data. Rallar clears the missed offer on
requeue or reassignment. Call `clearCourtAlertClick` after their successful action.
The installable [pickup example](../../../../examples/pickup-event/README.md) shows the
full journey.
