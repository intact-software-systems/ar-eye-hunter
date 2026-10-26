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
product code. The current increment delivers automatic directory freshness in both games.

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

Temporary activities and persistent social or collaborative rooms need different retention policies.
Define reconnect grace, hiding from discovery, archival, and permanent deletion separately. Do not
purge every empty room under one platform-wide rule. Existing absolute expiry/purge fields do not
supply an idle-retention policy.

Explore “play again with these people” before a general party system. Reusing a room for another
activity may be sufficient. Moving a party together between rooms requires explicit reservation and
all-or-none admission decisions before it becomes a platform promise.

## Delivery priorities

| Priority    | Outcomes                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------- |
| Current     | Automatic foreground directory freshness in both games (7).                                 |
| Next        | Evaluate freshness and participation evidence before selecting further social capabilities. |
| Conditional | Spectating (3) and keeping groups together, when social or onboarding value justifies them. |
| Later       | Scheduled rooms (8) and a separate tournament capability.                                   |

Relic validation is a constraint throughout, not a dependency postponed to slice 9. Operator
reliability work may ship independently where a concrete operational need warrants it.

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
- Advertised WebSocket host validation remains separately tracked in issue #683.
