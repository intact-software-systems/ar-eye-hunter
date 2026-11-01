# Find players and start together

## Goal and accepted policy

Deliver one complete, human-clickable matchmaking experience in AR Eye and Relic.
The user approved two-player cohorts, a two-minute search and a thirty-second confirmation
window, configurable per game. Decline or timeout releases every seat and requires an explicit
new search. A leader starts gameplay explicitly. Searches and admissions are isolated by
application and workspace; an account has at most one active search in that scope.

Existing Quick Join remains immediate admission into an existing suitable room. Waiting for a
new cohort is an explicit action with cancellation and recovery, not a change to Quick Join.
No ratings, tournaments or cross-game parties are included.

## Architecture and global constraints

Use the existing server AppInbox registration, RuntimeState guarded batches, group mutation
computations and browser room-entry lifecycle. Matchmaking owns search and confirmation intent.
Group state owns creation, admission, capacity and retention. Reserve an exclusive destination
identity while confirming; create and admit the whole cohort atomically after all confirmations.
The new room is unlisted and temporary. A failed admission cannot strand a partially admitted cohort.

All authoritative writes follow read, compute, validate, write with prepared SQL, exact identity
validation, optimistic compare-and-set and outer AppInbox retries. Winning ingress captures
immutable facts once. No domain locks, legacy paths, migrations, duplicated admission logic or
React dependencies outside apps and shared-react. Review and remediate each changed file fully;
changed support files enter that review recursively; unrelated untouched code stays out of scope.

## Increment 1: authoritative matchmaking and recovery

- Shared request, policy and private search-view contracts; server-owned FIFO matching per scope.
- Account claims prevent duplicate searches across tabs. Search identities fence delayed cancel,
  confirmation and expiry. Confirmation freezes the cohort; no automatic replacement or requeue.
- Reuse group creation/admission calculations and commit room, memberships, result and AppInbox
  completion atomically. Current authentication is checked and guarded for every participant.
- Durable expiry and read recovery survive API restart; reads never mutate. Terminal outcomes
  remain readable for a bounded retention, with no disclosure of unrelated searchers.
- RED/GREEN tests cover FIFO, duplicate account, scope separation, exact deadline boundaries,
  cancellation, all-party confirmation, stale commands, corrupt persisted identity, competing
  matchers, revoked authority, rollback and idempotent replay. Add a real API black-box recipe.

Expected checks: focused Vitest tests; shared/shared-server typechecks; PGlite and PostgreSQL
recipe; unweakened medium scale; transaction guard checks. Run recipe schema validation early.

## Increment 2: both games through shared play

- Shared browser owner recovers the account search, polls with bounded lifecycle, exposes waiting,
  confirmation, cancellation and terminal states, and retries an ambiguous write with its original ID.
- Shared React controls consume that owner; game adapters own actual room entry and gameplay.
- AR Eye: Find a game, both confirm, both enter, appoint/verify leader and explicitly start a match.
- Relic: Find an expedition, both confirm, both enter and join the expedition, Keeper explicitly starts.
- Visible controls cover reload during search and confirmation, cancel/decline, timeout/retry,
  lost response/reconnect and actual two-player gameplay. No hidden-state seeding of the journey.

Expected checks: app tests/builds, browser API/bundle boundaries, both local clickable journeys,
full hosted release and API formation/scale gates, fresh controlled performance comparison,
and hosted GitHub Free Distributed Recipe/Hetzner validation as required by changed surfaces.

## Review focus and delivery

Review authority provenance, account/scope isolation, expiry races, atomic admission, retry identity,
room lifetime, renderer independence and navigation from entry to result/failure. Use a fresh final
reviewer after implementation. Publish an early draft PR, keep its semantic description and remote
validation evidence current, and finish with green CI and pr:delivery readiness. Delete this plan
in the completing PR; Git history is its archive. Wait for the user's merge.
