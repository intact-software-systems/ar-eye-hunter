# Move together to another room

## Intent and approved outcome

Deliver one complete feature in AR Eye Hunter and Relic Hunters: people already
playing together can agree on another room and enter it together. The maintainer
approved this larger slice after the renderer work merged. This document makes
the admission, consent and recovery boundaries concrete for design approval.

The delivery is one PR with two implementation increments. No legacy paths,
migration code, duplicated admission rules, permanent party service, cross-game
travel, or unrelated graphics work are part of it. Issue #724 remains separate.

## Approaches

The approved approach is a durable proposal with explicit consent and atomic
admission for the whole cohort. Independent individual joins cannot provide the
approved all-or-none outcome: one member can consume the last place before the
next join is denied. Compensating leaves also cannot undo an observed admission
or safely remove an owner. A permanent party plus reservation service adds a
second long-lived social identity which this outcome does not need.

Use a bounded proposal and one final admission transaction. The proposal itself
does not reserve places. The final transaction checks and allocates all required
places together. The UI states that capacity is checked when the move is
committed; an earlier availability reading is not a reservation.

## User flow and proposed product policies

These concrete policies are proposed here, rather than attributed to the earlier
approval of the overall feature:

1. A present player opens **Move together**, selects a destination in the same
   application/workspace from the existing directory or a room reference, and
   proposes it. This player is the move organizer. Organizing this consensual
   move grants no Keeper, director, owner, or administrator authority. The game
   leader can organize, but leadership is not a prerequisite for proposing.
2. The proposal pins every currently present player session in the source room,
   including the organizer. Spectators are shown as staying; they are not silently
   promoted or moved. Newly arriving players are not silently added. A player
   roster change invalidates the proposal and requires a new proposal.
3. Each listed player, including the organizer, explicitly confirms that exact
   destination and cohort. The panel shows names and waiting/confirmed states.
   Nobody can confirm for another account or session. Confirmation can be
   withdrawn before commit. Decline cancels the proposal for everyone.
4. When everyone is confirmed, the organizer clicks **Move everyone**. There is
   no automatic start on the final confirmation. Destination identity and cohort
   are immutable; changing either creates a new proposal and clears consent.
5. On a successful server decision, each consenting browser activates the
   destination. The panel distinguishes **Admitted; entering room** from
   **Arrived**. It never reports arrival from a membership write alone.
6. If any player cannot be admitted, no destination memberships change, everyone
   keeps the source room, and the panel explains the failed condition. A new
   attempt requires a new proposal after resolving the problem.
7. Proposed source policy: preserve old-room memberships and governance, but
   disconnect each moving browser's source presence when it activates the
   destination. Returning uses ordinary current admission checks. Explicit
   **Leave room** stays a separate action. The maintainer has been asked to
   choose this policy versus removing old memberships; do not implement the
   dependent departure behavior until that choice is resolved.
8. Proposed expiry: a proposal accepts consent and commit for two minutes from
   creation. The server checks time on every attempt. A bounded durable expiry
   command publishes cancellation; a delayed worker cannot extend eligibility.
   Terminal outcomes remain readable for the existing finished-command retention
   window so reloads can resolve a lost response.

### Destination access and roles

Use existing open, unlisted, code and invitation admission rules. A code required
for a player is entered by that player when confirming. A proposal never exposes
another participant's code or authentication evidence. Keep only server-private
credential evidence sufficient to recheck the current destination credential at
commit; never broadcast or put codes into recovery URLs. Invitations remain
per-account: the organizer cannot extend their own invitation to other people.

All moving sessions request player participation. Existing destination membership
and governance are preserved when already compatible; a spectator-to-player change
uses the existing promotion rule and player capacity. Pending manager approval is
not successful group admission: the whole move remains uncommitted and explains
that destination consent is needed. Existing members do not consume another player
place. Multiple sessions of one principal share a membership place but must each
consent, and session capacity is checked separately.

## Atomicity and recovery contract

**Atomic means all destination membership admissions plus the durable move
outcome commit together, or none do.** It cannot mean simultaneous navigation or
simultaneous network connectivity across browsers. Those are separately observed
steps. No membership compensation attempts to reverse a committed move.

The shared outcome is authoritative after an HTTP timeout. Reload, reconnect and
retry read that outcome before taking action. Before commit, an expired/missing
cohort presence or organizer departure prevents the move; the cohort is never
silently shrunk. An explicit decline or cancellation wins against commit through
compare-and-set. If commit wins first, cancellation reports the committed outcome.
After commit, organizer departure cannot erase the decision or strand its readers.

Consent binds application/workspace, source and destination GroupRefs, proposal
identity, principal, issued auth session, and source presence generation. A fresh
login or replacement presence cannot inherit consent. A normal reload must recover
an already committed decision for its authenticated participant; if it replaces
the pre-commit presence generation, a new proposal/confirmation is required.
Account changes never auto-enter a previous account's destination.

One live proposal is allowed per source room. A participant cannot be in two
uncommitted moves at once across rooms. Both constraints must be guarded durably,
not by a process-local map. Terminal state releases the relevant live claims in
the same transaction. Idempotency prevents duplicate proposals and commits; reuse
of a request identity with different logical data is rejected.

After commit, a browser which cannot activate the destination keeps an explicit
recovery panel with the shared outcome and **Retry entry**. A later ban, archive,
expiry, session limit or changed app eligibility is reported as a new condition;
recovery never overrides current authorization. Arrival reports are authenticated
observations, not admission authority. Other players can see incomplete arrivals
and choose whether to wait or return; the system does not silently split them.

Recovery must work from the participant's authenticated server read even if local
storage is unavailable. Local storage may remember a proposal identifier, but
cannot be the only way to discover a pending or recently committed move.

## Game ownership

Rallar owns membership admission and the shared move outcome. It does not own
expedition withdrawal, match completion, game readiness, or game leadership.

- AR Eye exposes moving from the lobby or completed match. It blocks confirmation
  while the local player is in an unfinished match and explains how to finish or
  explicitly leave it. Moving does not transfer director authority or start a
  destination match.
- Relic preserves `changeRelicRoom`'s existing unfinished-participation check and
  explicit **Leave expedition** policy. It never withdraws a hunter or drops relics
  as an implicit side effect. Players finish or explicitly leave before confirming.
  Destination **Join Expedition** remains a separate explicit game action.
- Both apps recheck eligibility before activating the committed destination. If
  activity changed after confirmation, the browser reports that recovery is
  waiting for the existing game to be finished/left. The platform admission
  transaction does not claim to freeze independently owned game state.

## Existing owners and intended implementation

| Responsibility         | Current owner and extension                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admission policy       | `packages/shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts` and `mutation/membership/compute-group-admission-mutation.ts`; reuse for every cohort member.                                                                                                                             |
| Membership computation | `mutation/membership/compute-group-membership-mutation.ts` and `mutation/write/compute-group-membership-write.ts`; consolidate the reusable join decision before adding a multi-member admission. The current member delta lookup knows only actor and target, so it cannot be reused unchanged for an arbitrary cohort. |
| Durable mutation       | A focused group-move service under `packages/shared-server/rallar-system/group-state/`, registered through existing AppInbox composition; no app-specific cases.                                                                                                                                                         |
| Public contract        | A scoped group-move contract under `packages/shared/api/`, with one current schema and typed failures.                                                                                                                                                                                                                   |
| HTTP boundary          | `apps/api-v1/src/group-state/`; authenticated propose, confirm/withdraw, cancel, commit, arrival and read surfaces. Route spelling is left to implementation.                                                                                                                                                            |
| Browser lifecycle      | One shared-web room-move owner using `SynchronousNotifications`, `SubscriptionScope`, existing auth/session fences and room operations. Both apps consume it directly.                                                                                                                                                   |
| Room activation        | `packages/shared-web/browser/rooms/join-room.ts` and the existing entry/runtime owners. Reuse admitted-room adoption and presence operations without duplicating individual admission or silently invoking membership leave.                                                                                             |
| Game participation     | AR Eye runtime and `apps/relic-hunters-v1/src/game/relic-hunters-browser.ts`; app-specific checks remain in their owners.                                                                                                                                                                                                |
| Publication/recovery   | Existing durable state-event/outbox delivery and authenticated reads. Notifications wake refresh; lost notifications cannot lose the outcome.                                                                                                                                                                            |

### Transaction discipline

Every incoming mutation uses AppInbox and visible read, compute, validate and
write phases. Reads load current proposal, durable live claims, source roster,
relevant presence and auth sessions, and destination membership, capacity,
credentials, lifecycle policy and existence. Decoders validate stored schema and
key/scope bindings; corruption fails closed.

The pure compute derives one complete group admission and its persistence/events,
with progressively counted distinct principals and sessions. It must not call the
individual HTTP join N times or duplicate its policy. Validate the computed result
before opening the write transaction.

Write performs the conditional authority guards first. Every consulted mutable
fact which could change consent, membership eligibility or capacity is fenced by
its actual owning revision; a single aggregate revision does not fence independent
presence or auth rows. Then write the complete destination roster change, proposal
outcome, claim changes, state events and outbox intentions. AppInbox records the
result and finalizes its reservation in that same transaction. On any failed guard,
roll back everything and let QueueBox redeliver for a fresh read. There are no
inner retry loops, domain locks, success-shaped fallbacks or migration readers.

The proposal and participant lookup need explicit feature-owned runtime-state
codecs, scoped keys and expiry. Reuse the existing repository and guarded-batch
primitives. Bound cohort size and request size explicitly in validation and in the
UI, with a documented maximum chosen from existing group limits and measured
transaction cost. Never silently truncate a cohort.

## Two implementation increments in this PR

1. **Authoritative group admission and recovery.** Pin failing semantic tests,
   consolidate shared admission computation, implement the scoped proposal and
   consent state machine, atomic commit, replay/recovery reads, publication and
   REST black-box coverage. This increment must prove all-or-none admission under
   contention and restart before browser wiring depends on it.
2. **Both complete clickable journeys.** Add the shared browser owner and both
   game interfaces, preserve game participation boundaries, exercise real
   multi-player entry/cancel/recovery/arrival, and complete functional, performance,
   distributed and public-surface validation for the entire PR.

## Acceptance and validation

- A real two-player click journey in each SPA proposes, confirms individually,
  commits, enters the same destination, and reaches usable destination gameplay.
  Relic uses the actual Join Expedition control rather than assuming membership
  equals participation.
- A capacity race and an ineligible participant admit nobody; prior destination
  members remain unchanged. Test player and session capacity separately.
- Cover code expiry/change, invitation expiry/revocation, manager approval,
  archived/deleted destination, malformed stored state and cross-scope access.
- Cover duplicate delivery, different command under one request ID, failed guards,
  rollback after partial SQL execution, lost HTTP response, worker restart and
  a fresh node reading the committed result.
- Click tests cover decline, withdrawal, timeout, roster change, organizer leave,
  reload before/after commit, account switching, offline recovery and a visible
  post-commit entry failure. They assert room identity and game state, not only a
  clicked button or successful API response.
- Confirm spectators stay spectators, old governance is not silently changed,
  unfinished Relic participation is not withdrawn and no match starts implicitly.
- Focused Vitest suites run first; both app builds run with
  `npm run build:ar-eye-hunter-v1` and `npm run build:relic-hunters-v1`.
  Use the existing full-stack Playwright configurations for both apps, shared-web
  public API snapshots and browser bundle-boundary checks for added public APIs.
- Run REST black-box recipes, PostgreSQL integration, the unweakened
  `npm run test:api-v1:black-box:postgres:medium-scale`, and the environment-matched
  state-write performance comparison. Measure the new multi-member commit workload
  separately without treating the unchanged single-write benchmark as coverage.
- Run required Hetzner distributed validation under the maintainer's standing
  authorization. No performance exception carries over from earlier PRs.
- Review changed files in full, recursively include changed support files, and
  leave independent untouched code outside closure. Run applicable style and
  structure checks, a fresh whole-branch review, delivery status before broad
  final validation, and delivery readiness once gates pass. Human merge ends the
  PR. Publish behavioral evidence in the PR; do not create a progress ledger.

## Design approval and completion

The source-membership question is pending. The organizer, cohort, expiry and
atomicity policies above are also explicit proposed calls for the design review.
No production implementation is claimed by this document. Once accepted, exact
code tasks and test commands are worked out from these two increments. The PR
that finishes this specification removes it before merge; Git history and the
semantic PR description preserve its decisions, and current product documentation
records the shipped behavior.
