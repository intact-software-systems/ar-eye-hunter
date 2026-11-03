# Room moderation and safe departure

Approved scope: one PR gives room owners/admins remove, ban and unban controls in both games; removed players receive an explanation and can enter another room; remaining players can continue. Server bans must survive local departure. No legacy, migration or duplicate implementation.

## 1. Shared departure and access-loss contract

- Reproduce #303 through the real HTTP workflow and public browser rooms/session leave surfaces: exact member-banned/member-removed 403 on self leave succeeds locally with no fabricated snapshot; other failures propagate.
- Keep successful destination activation when departure from a revoked source returns no snapshot. Cover stale completion/session replacement.
- Reuse existing room state and lifecycle notifications for access loss; never interpret an absent cache snapshot or expired presence alone as a ban.
- Verify authoritative membership exclusion and director/Keeper continuity with regression tests; use existing mutation owners and CAS/replay boundaries if correction is needed.

## 2. Complete moderation journeys

- Add reusable moderation UI under packages/shared-react, consuming existing rooms APIs and authoritative room snapshots. Hide unauthorized controls; server remains authority. Confirm target/action, show outcomes, preserve banned state until explicit unban, prevent stale results changing another room/account.
- Wire into AR Eye and Relic with game-owned departure/participation cleanup.
- Add actual two-player Playwright journeys: ban/remove, affected-player recovery/new room, forbidden re-entry, unban and explicit return, leader continuity and spectator/pending-ready handling.
- Run focused tests, both app builds, shared-web type/public boundary checks as affected, local and hosted browser runs, selected distributed validation and CI. Review whole touched files recursively and publish one reviewable PR referencing #303.

Review focus: delayed requests after account/room switches; cache absence versus explicit revocation; admin hierarchy/self-target protections; removed director/Keeper and stale ready state; unban must not silently restore participation.

Validation evidence and progress belong to the PR. Only these two increments are concrete. Tournaments are deferred.
