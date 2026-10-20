# Lobby and matchmaking follow-ups

Follow-up to the open-arenas lobby (`GET …/group-directory`, `rallar.rooms.directory()`, the AR Eye
Hunter "Open arenas" section). That change lets a non-member discover and join an open arena. This
plan covers what the same primitives can serve next. Each slice is independently shippable and ships
as its own pull request.

## Starting point

- `joinMode` is `invite-only | code | open`; only `open` groups are directory-visible
  (`readGroupVisibility` → `directory`). The directory returns safe summaries and never enters the
  browser's authoritative group cache.
- Member roles and the `pending` member status already exist (admission approval), as do
  `expiresAtEpochMs` / `purgeAfterEpochMs`, join codes (`rotateJoinCode`), `rallar.people`, and the
  Vivaldi RTT / topology helpers in `packages/shared-graph`.
- The directory is pull-based. It loads on login and on Refresh, and has no push updates.

## Slice 0: directory hardening (prerequisite)

Owned by the directory pull requests, listed here because later slices assume them.

- Server-side `kind` and `q` filters, a stable sort (online count, then id) with a keyset cursor, and
  a `limit`. Rooms with no online member are hidden unless `includeEmpty=true`.
- A dedicated directory entry type with `maxMembers`, `lifecycleState` and a derived full flag,
  replacing the reused `SpaStatisticsSafeGroupSummary`.
- `ETag` plus `Cache-Control: no-cache` so repeated polls revalidate cheaply.
- The app reports a directory failure instead of showing an empty lobby.
- The Relic server installs the shared `installApiHttpMiddleware` instead of a hand-copied CORS
  config.
- Not in scope here: purging stale empty groups. `purgeAfterEpochMs` is an absolute client-supplied
  time and no policy sets it. That needs its own decision (slice 6).

## Slice 1: quick match

`POST …/groups/quick-join` picks the best open room and joins it in one server step, removing the
client-side race where two players take the last slot.

- Selection is pure `computeXxx` over the directory read: open, active, not full, most online
  members first, ties by lowest estimated RTT once slice 2 exists.
- It is a group mutation, so it follows the AppInbox doctrine in `convergent-service-writing.md`:
  read the decision surface outside the transaction, compute and validate purely, then
  `write(transaction, computed)` with the conditional guard first. A full or vanished room is a
  typed conflict that restarts the attempt with a fresh read, never an exception.
- Add the command across the group-mutation registries (see the group mutation command registry
  census), one registrar and one translator with literal paths, the OpenAPI entry, and black-box
  recipes. Two clients racing for one slot must both resolve, with exactly one admitted to the full
  room and the other placed in another room or told none is available.
- Browser: `rallar.rooms.quickJoin()`; app: a "Quick match" button beside "New Arena".
- Validation: unit tests for the pure selector, AppInbox convergence tests, the Postgres
  `test:api-v1:black-box:postgres:medium-scale` gate because this is a mutation path.

## Slice 2: latency-ranked lobby

Rank directory entries by estimated RTT from the caller to the room's members.

- Reuse the Vivaldi coordinates already maintained for topology. Do not add a second RTT source.
- The server returns an optional `estimatedRttMs` per entry only when both sides have coordinates;
  absence means unknown, not zero. Ranking by RTT is a sort option, not the default.
- Open question: whether the caller's coordinate is known before the first RTC contact. If not, the
  ranking is only available after the first connect, which limits its use in a cold lobby.

## Slice 3: spectate

Open rooms offer a "watch" join with a read-only role.

- Use the existing member roles; add or reuse a role that can read state and presence but cannot
  send gameplay messages. Enforcement belongs in the room send authorization, not the UI.
- The directory entry advertises whether spectating is allowed. Spectators do not count against
  `maxMembers`, or count separately; decide before implementation.
- Recipe: a spectator joins, receives presence and state, and is denied a gameplay send.

## Slice 4: private games with shareable codes

Keep invite-only rooms and make the existing `code` join mode usable.

- App: create a private arena, show a share code and a link of the form `#/join/<code>`; opening the
  link joins directly without the lobby.
- Codes expire and rotate through the existing rotate-join-code command. The link carries the code
  only, never a session or ticket.
- `code` rooms stay out of the directory. Whether a "enter a code" row belongs in the lobby is a
  product choice and is deliberately not decided here.

## Slice 5: unlisted but joinable

Split "open to join" from "listed in the directory".

- Add a required `listed` flag on the group, defaulting to `true` for `open` rooms, so a room can be
  joinable by link and hidden from the lobby.
- This changes the stored group shape, so it needs a data migration. The strict reader rejects rows
  missing a key (the stale-row 400 seen on the Relic deploy), and the repo forbids tolerant readers.
  Write a Prisma data migration and cover it with a migration test.
- `readDirectoryVisibility` and the directory filter both honour the flag.

## Slice 6: resume, rejoin and cleanup

- "My recent arenas": the caller's own groups, ordered by last activity, with auto-rejoin after a
  reload. No new permissions are needed.
- Decide a stale-room policy: a server-side rule that sets `purgeAfterEpochMs` once a room has been
  empty for a configured time, so abandoned arenas leave storage and not just the lobby.
- Isolate one corrupt row from list reads instead of failing the whole request (a partial result
  with a reported row id). This must be reconciled with the no-tolerant-readers rule, so it needs an
  explicit decision before work starts.

## Slice 7: live lobby

Replace Refresh with a pushed directory.

- A workspace-level directory topic over the existing state-sync WebSocket carries create, join,
  leave and close deltas as safe entries only, never full group snapshots.
- Friends' presence comes from `rallar.people`, shown beside entries.
- Delivery must stay best-effort and recoverable: a client that misses a delta recovers from the
  ETag-validated pull.

## Slice 8: scheduled and tournament rooms

Groups with a start time, expiry and approval-based admission.

- A start time on the group, `pending` admission for sign-up, and the existing admission approval
  commands for the organizer.
- Fits the lifecycle policy work; confirm the lifecycle owner before adding any new group field.

## Slice 9: other apps and operators

- Relic Hunters: list co-op expeditions through the same endpoint with `kind` and metadata filters.
  This is the check that the filter design is general; if Relic needs a filter the AR app does not,
  revisit slice 0.
- Ops view: an admin-authorized directory of every group, including unlisted and invite-only, with a
  per-row validity status so a corrupt row is visible instead of poisoning the list.

## Cross-cutting rules

- REST changes add or adjust black-box recipes in the same change.
- shared-web public surface changes include the public API snapshots and bundle-boundary checks; the
  `browser/rallar.ts` Brotli budget is adjustable and is raised and reported when crossed.
- Any group mutation or stored-shape change goes through the convergent-writing and migration rules
  above, with the Postgres medium-scale gate for mutation paths.
- Related, tracked separately: advertised WebSocket host validation (GitHub issue 683).
