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
foundation and PR #697 delivered Quick Join. The maintainer's current request selects slice 2 from
main; its [implementation plan](lobby-latency-ranked-discovery.md) defines the next two increments.

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

Unlisted means absent from discovery, not access restricted. Settle this behavior before implementing
shareable private and unlisted flows. Select a listing design that preserves existing public-room
visibility without migration code. Resolve the design before implementation if the existing canonical
state cannot represent that outcome.

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

| Priority    | Outcomes                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Current     | Slice 2 opt-in latency-ranked discovery, grounded in actual transport evidence from AR Eye and Relic. |
| Next        | Share links/codes (4); visibility choices (5); reconnect/recent-room behavior (6).                    |
| Then        | Automatic directory freshness (7), introducing push when the experience needs it.                     |
| Conditional | Spectating (3) and keeping groups together, when social or onboarding value justifies them.           |
| Later       | Scheduled rooms (8) and a separate tournament capability.                                             |

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

First establish whether peer, director, or authoritative-server latency predicts the application's
experience. Reuse existing RTT evidence only when it measures that path. Cold-start and missing
coordinates remain usable unknowns, never zero latency or automatic exclusion. Ranking is opt-in and
must show participation benefit before it displaces simpler eligibility and occupancy decisions.

## Slice 3: spectating

Offer watching when it helps learning or social participation. Applications define a spectator-safe
view; read-only message permissions alone do not authorize exposing hidden gameplay state. Enforce
permissions at authoritative boundaries, use separate bounded spectator capacity, and decide chat,
moderation, and transition-to-player behavior before shipping. Advertise watching only when the
application actually supports it.

## Slice 4: shareable private rooms

Make code-protected and invitation-based entry usable from a fresh browser, including authentication,
expired/rotated-code feedback, and an enter-code action. Carry the intended destination through the
whole flow. Keep these rooms hidden from discovery and make access and rotation semantics match the
product choices above. Validate invitation-to-participation and reload recovery together.

## Slice 5: unlisted rooms

Allow reference-based entry without directory listing. Separate listing from credentials while
preserving established room visibility without migration code. Directory reads and eventual pushed
updates must remove rooms that become hidden; hiding is not membership revocation. Resolve any
representation gap in the existing canonical state before implementing this slice.

## Slice 6: recovery and room lifetime

Deliver recovery and recent-room navigation first, then separately define temporary versus persistent
room retention. Include interrupted authentication, reload, expired rooms, removed membership, and a
new invitation overriding an old destination. Reconnect grace and deletion must not race each other.
Decide “play again” behavior with each application's activity lifecycle.

Corrupt-row isolation belongs to operator reliability in slice 9, not this recovery feature.

## Slice 7: fresh discovery and social context

Start with deliberate automatic refresh and measured freshness needs. If push is justified, send safe
workspace-scoped directory updates over existing state sync, including removals when visibility
changes, and recover missed updates with conditional pull. Do not hydrate full group snapshots.

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
