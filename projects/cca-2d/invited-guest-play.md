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

## Proposed development sequence

1. Deliver the reusable guest admission and lifecycle in a Rallar PR. Verify
   concurrent claims on the last seat, reload with the same identity, exact
   expiry, bounded completion of an active round, removal and invitation
   rotation against the standard server. The cutoff must be enforceable
   after the host disconnects, using a deadline Rallar can verify.
2. Stack a CCA PR for QR/link entry, nickname shuffle, lobby and next-round
   readiness. Test with a signed-in host and guest browsers, then on a phone.
   Exercise host loss and confirm the successor can run the match while only
   the owner can manage guests.

The account-registration prototype would leave a regular account behind.
The chosen design calls for a genuinely expiring identity in Rallar.

The [implementation plan](invited-guest-implementation-plan.md) records the two PRs, development constraints and acceptance tests.
