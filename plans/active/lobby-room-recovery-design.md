# Room recovery and recent navigation

Status: slice 6 implementation design, following merged #701 (`ea3240c7`).
Authority: the ongoing lobby goal and `lobby-and-matchmaking.md`; current repo
standards govern implementation. No legacy, duplication, or migration code.

## Outcome

Both AR Eye Hunter and Relic Hunters offer a recent-room list for the signed-in
account and current application/workspace. A player can return to a room or
forget its local history. Reload and interrupted authentication continue through
the existing pending-entry owner. A fresh incoming invitation wins over an old
saved destination; hydrating history never navigates automatically.

The list contains the ten most recently entered distinct scoped room references,
newest first. Record a full `GroupRef` and visit timestamp only; display the room
reference, not a stale claim about its current name, availability, or activity.
Revisiting updates recency. Successful create, Quick Join, direct join, share
entry, and recovery all pass through the existing entry owner's observation of
the current room. Pending, denied, and partial admission do not count as visits.
Forget removes local history only; it does not leave, delete, or revoke a room.

## Ownership and authorization

`RallarRoomEntry` remains the sole owner of admission, pending destination,
tab restoration, retry/cancel, and account/session fences. Add an explicit
account-bound `returnTo(roomRef, principalId)` operation: it validates scope and
current principal before replacing the destination, persists a code-free pending
destination bound to that principal, and then relies on existing `resume()`.
Passing a stale account or selecting without authentication cannot replace a
new account's destination or issue admission. A later account change is rejected
by existing resume checks. A new explicit invitation can replace this intent.

Every return calls ordinary server-authorized admission afresh. Existing policy
rejects removed/banned members, expired/archived/deleted rooms, missing private
credentials, and capacity denial. An otherwise eligible former member of an
open room may be readmitted through that policy. No client cache grants access.
History does not supply codes or bypass current policy. Denials stay visible with
retry/cancel and history-forget options. Recovery never starts or resets game
participation: Relic's Join Expedition remains separate.

## Local persistence and lifecycle

Add one shared browser lifecycle owner, `RallarRecentRooms`, next to room entry.
It consumes the entry owner, auth, Rallar Data, scope, and an injected clock.
Applications compose one instance beside their entry owner and start/stop them
together. Both UIs subscribe to the same shared behavior; each retains its own
presentation markup. No second app-specific history or storage algorithm.

Use existing Rallar Data write-through persistence. The store name includes
application/workspace; its scope is the captured principal. Store one bounded
latest-value history document, validated on read; serialize local edits and store
ownership in the history owner, with explicit read/compute/validate/set through
the repository. History is a local convenience, not a
cross-tab activity log or CRDT. Concurrent tabs follow Rallar Data latest-value
semantics and may lose a simultaneous history update; that cannot change room
authority. Do not modify IndexedDB schemas, data-core algorithms, or server writes.

Auth replacement/logout hides the old list immediately. Async open, hydration,
write completion, and events are fenced by owner generation and principal so
old results cannot populate the next account's list or cause navigation. A write
already submitted may finish only in its captured account store. Stop releases
subscriptions and store ownership without destroying persisted history. Restart
rehydrates it. Use existing concurrency primitives where serialization is needed.

Unavailable or invalid history storage is shown as a separate retryable history
error. It never turns a successful room admission into a failure. Retry reloads
the store and can record the still-current successful entry. No silent clearing
of invalid data and no migration/fallback storage. Clearing history errors does
not retry admission; admission errors use the existing entry retry control.

## UI

Both shared-entry panels show Recent rooms, loading/empty/signed-out/error
states, and Return/Forget controls identified by room reference. Return queues
the account-bound destination and resumes only through each app's existing
connected-entry lifecycle. Show the selected destination and existing admission
result; prevent repeat selection while a join is in flight. No credential or
token appears in recent-history values or labels.

## Boundaries

This increment covers recovery/navigation. Temporary/persistent retention,
reconnect grace, archival/purge, play-again policy, and automatic directory
freshness remain separate roadmap slices. No retention timers or new database
operation is added, so there is no new AppInbox or server performance exception.

## Acceptance

- Real Rallar Data/IndexedDB reload, bounded ordering and deduplication, forget,
  application/workspace/account isolation, and absence of credentials.
- Account replacement while opening/writing/returning, stopped-owner late
  results, duplicate successful-entry notifications, storage failure/retry.
- Existing entry tests plus bound-return account/session fencing, expired or
  removed-room denial, and a new invitation superseding delayed restoration.
- Both games' runtime/lifecycle tests and builds; public surface and browser
  bundle checks for the new shared export.
- Browser controls prove visit, reload, return, forget, and denied recovery;
  Relic membership recovery does not automatically Join Expedition.
- Fresh design builder check, fresh final branch review, and normal PR CI.

Legacy baseline: existing pending-entry, admission and Rallar Data paths are the
canonical owners. This slice adds no replacement authority or compatibility path.
Exit review must find one implementation per capability and no retained affected legacy.

Implementation details such as state union names and helper layout are left to
the builder under the repo's human-understandability standard.
