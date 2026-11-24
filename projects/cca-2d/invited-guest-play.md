# Invited guest play

A signed-in player opens a four-player town and shows one QR code to the group.
A friend scans it or opens the same link, shuffles a game-generated nickname,
and joins the lobby immediately. The owner can see who arrived and remove a
guest. Guest play has no signup prompt. After access expires, the owner can
invite that friend again. Saving friendships across visits is deferred.

## Invitations and seats

The invitation accepts arrivals for 15 minutes. Replacing it invalidates the
previous link. Rallar admits guests up to the town's four seats, including
the owner. If two guests claim the last seat together, one gets the seat and
the other sees **Town is full**.

A newcomer arriving during play reserves an available seat and may tap
**Ready** for the next round. The current round keeps its roster and scores.
A returning participant can reconnect to their existing round under its seat
recovery rules. The guest keeps the chosen nickname across reloads and rematches.

## Lifetime and authority

Guests may start rounds for four hours from admission. If that deadline falls
during a round the guest is already playing, they can finish it and see the
results. Their remaining access is limited to that round and ends when it
finishes or reaches the scheduled end in force at expiry, whichever comes
first. Pauses, host changes and later time extensions cannot move that cutoff.
A guest in the lobby at expiry, or one who wants to play another round after
expiry, needs a fresh invitation. Reloading and replacing the invitation
preserve the original deadline. Closing the town
ends guest access. Removing a guest revokes their access and the outstanding
invitation together. Other guests retain their seats and access.

The standard Rallar Server owns the room-scoped guest identity, admission,
expiry and revocation. The app supplies names and presentation. If the owner's
browser disconnects, an eligible guest can take over the simulation and host
rematches. Invitations and removal remain with the signed-in owner.

## Verification before release

The standard server has passed a three-process PostgreSQL race for the final seat and tests for invitation replay, removal, fixed expiry and the current-round cutoff. Browser trials covered guest entry, a delayed countdown, remote movement over RTC and WebSockets, a completed three-minute round with matching scores, and a guest hosting a rematch after the owner left.

The iPhone guest reached gameplay on the second trial. Its WebSocket closed during the round and the match stopped at tick 673. The [phone trial notes](babylon-local-trial.md) distinguish this from the earlier countdown failure.

A Chromium host and mobile WebKit guest subsequently completed the three-minute round. The guest reloaded at tick 910, resumed the same match and dashed. Both screens reached tick 5400 with scores of 10 and 0. This pair used WebSocket fallback. A separate Chromium trial exercised RTC and then forced WebSocket fallback.

1. Complete the physical iPhone round with a desktop host. Compare final scores and verify that the guest can reload and rematch.
2. Exercise host handoff and WebSocket fallback on the device. If it stops, record the last confirmed tick, WebSocket close code and visibility state shown by the local diagnostics.

The account-registration prototype would leave a regular account behind.
The chosen design calls for a genuinely expiring identity in Rallar.

The [implementation plan](invited-guest-implementation-plan.md) records the two PRs, development constraints and acceptance tests.
