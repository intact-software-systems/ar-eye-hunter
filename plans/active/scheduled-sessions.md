# Scheduled sessions in both games

## Goal and approved policy

Deliver one complete scheduling experience in AR Eye Hunter and Relic Hunters:
organize a session, share its link, RSVP, enter its lobby, and play together.
This is one feature PR with two implementation increments, not separate
infrastructure and UI deliverables.

The maintainer selected scheduled sessions and approved:

- One reserved player seat per account.
- Lobby admission opens ten minutes before the scheduled start.
- The host explicitly starts gameplay at or after the scheduled start.
- Unclaimed reservations expire ten minutes after the scheduled start.

No automatic gameplay start, calendar integration, recurring sessions,
notifications outside the games, or tournament system is included.

## User experience

The hosting panel offers **Schedule session** with a name, local date/time,
and player capacity. The UI displays the time zone and the resulting start
instant before submission. The first version creates a new unlisted, open,
temporary room; the link authorizes discovery, while authenticated room
policy still controls admission. Scheduling does not move the organizer out
of their current game. The organizer occupies one player seat as room owner.

The organizer can retrieve their scheduled rooms after a reload. A session
link opens its schedule card before attempting room entry, survives sign-in,
and shows the start, lobby opening, seat availability, and the current
account's RSVP. The shared link contains the scoped room identity, not an
account identity or reservation credential. Preview exposes safe summary
fields and the caller's reservation, never the full reservation roster.

**Reserve a seat** and **Cancel reservation** are explicit actions. Multiple
tabs of the same account share one reservation. A reservation grants neither
membership nor gameplay authority. Full, cancelled, removed, banned, and
expired states are distinguishable. Retry after a lost response uses the
same command identity and reconciles with authoritative state.

At lobby opening, **Enter lobby** uses the existing room-entry workflow.
Successful player admission claims the reserved seat even if the response
is lost. Existing members do not consume a second seat. Spectators use the
existing independent spectator capacity and do not claim player reservations.
The UI distinguishes a seat reservation from present/away membership.

The host's existing start controls remain explicit. Scheduled time is a gate,
not a timer that starts the game. The lobby can remain open while waiting for
the host. A failed gameplay start can be retried without recreating the room
or changing its schedule. Rematches continue through the existing ready and
leader-start flow.

Before the lobby opens, the organizer may reschedule or cancel. Rescheduling
increments the schedule revision and clears reservations; participants must
reconfirm the new time. Private per-account session interest survives rescheduling
and cancellation so guests can recover the changed session after reload. The card
makes this visible. Withdrawing removes an RSVP-only account from its personal
list; an admitted member retains its room interest. Once lobby admission
opens, scheduling edits and session cancellation are refused; ordinary game
leave and room governance remain available. This prevents changing the start
under an admitted cohort or cancelling an already running expedition.

After the no-show deadline, an unclaimed RSVP no longer withholds capacity.
Late entry may use ordinary available seats under current room policy.
No-show release never removes an admitted member or an app-owned game save.
The room remains protected from empty-room archival through the no-show
deadline. Cancellation releases that protection; otherwise the normal empty
reconnect grace starts at the deadline, followed by existing archival and
seven-day deletion. An explicit administrative archive/delete still wins.

## Ownership and contracts

### Authoritative scheduling

A complete server-owned schedule value lives in a reserved group metadata
key. Absence means an unscheduled room, not a legacy format. A present malformed
value fails closed. No schema migration or compatibility reader is introduced.
The public value contains a revision, start instant, and cancellation state.
Account reservations live in one private, bounded runtime-state record keyed
by the scoped group identity; they never enter group snapshots, events, or
broadcast metadata. The private record names its schedule revision. Membership
is read from the existing roster rather than duplicated in the schedule.
A missing private record for a scheduled group fails closed. Scheduling creates
both records atomically; updates guard the group and private record revisions.
A separate private interest row per account and room supports personal discovery.
Pagination scans only that account’s index, never unrelated unlisted rooms.
Confirmed seats are bounded to 64 players; discovery interest does not hold capacity.

The current group mutation service owns schedule creation, reschedule,
cancellation, RSVP, and RSVP withdrawal. It already owns the authoritative
group CAS, AppInbox receipt, immutable command identity, events, and outbox.
Scheduling has a cohesive pure computation module under group-state; it does
not introduce a second transaction/retry service or generic workflow engine.
Creation is atomic with the new group and its initial owner. Generic metadata
updates cannot inject, remove, or alter the reserved scheduling key.

Every command has current authenticated authority and an expected schedule
revision where applicable. An RSVP also validates current admission credentials
and blocked-member state. Creation and changes require bounded, finite
capacity and safe integer timestamps. Time decisions use the attempt clock,
not browser time or the original enqueue timestamp. Requests that waited past
a boundary are evaluated at the actual attempt time.

The transaction path remains read -> compute -> validate -> write. The first
conditional write guards the group revision used for capacity and schedule
decisions. A conflict leaves the attempt for outer QueueBox redelivery; there
is no inner retry loop. Receipt and outbox publication commit atomically with
the accepted state. Replays return the original result, while altered payloads
under the same command identity conflict.

### Admission and retention

Admission reads the private reservation record for scheduled groups and counts
the union of active player members and live reservations.
The caller's reservation is exchanged for membership, never counted twice.
Every active admission also maintains the private per-account discovery row,
including direct entry and ownership transfer. Removal, banning, invitation
revocation, and explicit departure release an unclaimed reservation atomically.
Expired reservations cease to count from the attempt clock even if no delayed
worker has run. All membership entry paths share this calculation: explicit
join, invite acceptance, manager grant, governance activation, spectator to
player changes, Quick Join, and Move together. Before lobby opening, ordinary
join and presence connection are denied, including owner connection.

Existing member presence, authorization, banned/removed status, and current
room join policy remain authoritative. RSVP does not bypass revoked access.
Schedule changes and membership admissions share the group CAS, preventing
last-seat oversubscription and stale reschedule admissions.

Retention reads the public group schedule value behind its existing group CAS.
It cannot archive an upcoming session or immediately archive at the no-show
deadline based on an idle observation made before the hold. Cancellation,
explicit archival, and group deletion converge with scheduling writes through
the same authority. Existing room-owned save fencing remains in place. Final room deletion also
removes the private reservation record and every account interest for the exact
scoped room under the same guarded deletion.

### Browser and app boundaries

Shared contracts and pure timing/capacity decisions belong in packages/shared.
REST transport and the browser scheduling lifecycle belong in
packages/shared-web/browser/rooms. Reuse SynchronousNotifications,
SubscriptionScope, SingleFlight, request identity/recovery, and the existing
RallarRoomEntry scope/account/session fences. Extend that entry owner to
support schedule preview before explicit admission; do not build a second
saved-destination or authentication restoration implementation.

Common scheduling controls belong in packages/shared-react. AR Eye and Relic
supply room creation defaults, labels, and their existing gameplay entry/start
integration. No React imports or dependencies enter shared, shared-web,
shared-test, shared-server, shared-graph, or any Deno application lock file.

Rallar knows generic sessions, reservations, and room policy. Relic expedition
commands and AR Eye director commands enforce the schedule time gate in their
existing authoritative game paths. App-specific command names and game saves
remain outside reusable Rallar product code. Client button disabling is not
sufficient enforcement.

## Implementation horizon

### 1. Authoritative scheduling and admission

Owners: shared API contracts; group-state command validation, computation,
private reservation storage, read selection and guarded persistence; membership admission policy; retention;
API-v1 routes and OpenAPI; shared-test API recipes.

- Add failing behavioral tests for complete schedule decoding, exact opening
  and expiry instants, account deduplication, reservation capacity, cancellation,
  reschedule revision fences, and malformed values.
- Implement the canonical contract and pure decisions, then wire the existing
  group mutation service and API routes without changing its retry ownership.
- Add database tests for competing last-seat RSVPs/admissions, stale schedule
  attempts, rollback, duplicate delivery, altered-payload replay, expiry while
  queued, and fresh-read convergence after CAS conflict.
- Prove every admission path and retention respect the schedule, including
  Move together all-or-none admission, owner presence, expired reservations,
  and cancellation versus archival.
- Add and run a local API recipe for schedule -> RSVP -> admission and the
  negative timing/capacity paths. Publish the first coherent increment as a
  draft of the single feature PR.

### 2. Shared browser flow and actual play in both games

Owners: shared-web rooms API/scheduling/entry; shared-react scheduling panel;
AR Eye and Relic hosting/start integration; mirrored unit and browser tests.

- Add browser-owner tests for link capture through authentication, account and
  destination changes during in-flight requests, reconfirmation, reload,
  cancellation, lost-response replay, and disposal.
- Implement the common panel and app adapters with concrete pending, denied,
  cancelled, reserved, open, and expired states.
- Add real clickable multi-account journeys in both games: organizer schedules
  and shares, guest follows the link and reserves, early entry is refused,
  both enter at opening, early start is refused, host starts at/after the
  scheduled time, and both observe actual gameplay.
- Exercise RSVP cancellation, competing last seat, reschedule/reconfirmation,
  missed-start recovery, no-show release, and same-account multiple tabs.
- Run affected shared/API/game tests, both game builds/typechecks, public API
  snapshots and bundle-boundary checks, style/structure/navigation review,
  local and hosted recipes including Run GitHub Free Distributed Recipe,
  and required performance and Hetzner distributed gates.

## Review and delivery

The requested outcome remains the complete scheduling-to-play experience.
Review every changed authored file in full; recursively include support files
modified by remediation. Independent untouched files stay outside closure.
Trace canonical entry to result for each mutation, timed retention, browser
recovery, and game start family. Remove affected unsupported legacy; retain no
migration or fallback path. Reuse verified existing library behavior and avoid
forwarding facades or duplicate application implementations.

The highest-risk inputs are a stale browser after reschedule, two accounts
racing for the final seat, one account in two tabs, expiry while a command is
queued, and interrupted admission that committed successfully. Each has direct
regression coverage above. A fresh design check and final code review must
also inspect privacy of preview data and all admission bypass paths.

The PR is the delivery record. Check delivery status before broad final
validation, repair real conflicts/check failures, and run delivery ready once
when acceptance is proved. Do not rebase merely for BEHIND or claim green CI
from local checks. Product/architecture docs replace this working plan before
the feature PR is ready; no post-merge bookkeeping is required.
