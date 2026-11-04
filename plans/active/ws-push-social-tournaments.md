# WS push for social, sharing and tournaments

## Goal and approved design

Replace repeated view polling in AR Eye and Relic with server-authored WS updates,
using the existing authenticated connection, AppInbox, transactional outbox and
cluster delivery. Deliver the work in this PR, in the order below. The merged
participation-hub PR is the base, not another delivery target.

Small coordination views use invalidation followed by an authorized canonical
read. AR Eye tournament gameplay uses bounded-rate authoritative snapshots,
because invalidation followed by a GET for every simulation update defeats the
purpose. Keep commands on their existing idempotent AppInbox path. No new broker,
transport connection, external dependency, legacy implementation or migration code.

This document records the approved analysis and implementation decisions. The PR
is the delivery record; this is not a progress ledger. Delete this plan in the PR
once its outcomes are implemented and verified; Git history retains the writeup.

## Evidence and ownership

- Both games configure party and matchmaking at one second, friends and tournament
  catalog at thirty seconds, selected brackets at one second, and scheduled
  sessions at five seconds. These are nominal timers, not measured CPU/SQL costs.
- `packages/shared-web/browser/api/authenticated-resource.ts` owns account-bound
  reads, commands, activity and retry. Its current single-flight refresh can join
  an older read without scheduling a read that covers a later invalidation.
- `packages/shared-web/browser/tournaments/rallar-tournament-catalog.ts` owns
  paginated range replacement. Keep pagination and selection there.
- `packages/shared-web/browser/rooms/sessions/rallar-scheduled-sessions.ts` owns
  session pages and selected previews. Deadlines affect these views without clicks.
- `packages/shared-web/browser/rooms/move/rallar-room-move.ts` already consumes
  `groupMoveChanged`, but also repeats reads every fifteen seconds.
- `packages/shared-server/rallar-system/group-state/move/group-move-outbox.ts`
  demonstrates computed WS outbox messages plus provenance. Extend existing
  publication mechanisms; do not introduce a second delivery system.
- The friends, parties, matchmaking and tournaments owners under
  `packages/shared-server/rallar-system` decide affected views and audiences.
  `apps/api-v1/src/composition` assembles them.
- `packages/shared-server/rallar-system/websocket` owns authenticated targeting and
  delivery. Existing principal state-sync targeting includes co-group members;
  private social notifications must use explicit own-account session audiences.
- `apps/ar-eye-hunter-v1/src/game/tournament/arena-tournament-client.ts` polls at
  200 ms. `packages/ar-eye-hunter/server/arena-tournament-deadline.ts` already owns
  the independent durable game clock. Relic already has a server snapshot WS path.

## Constraints and closure

Use existing `SubscriptionScope`, `SynchronousNotifications`, `ThrottledFlush`,
request cancellation and account-generation guards. Reuse their semantics rather
than copying notification collections, timers, retry loops or coalescing state.
Keep cross-runtime contracts in shared, browser lifecycle in shared-web, server
publication in shared-server, and React in shared-react or the apps. No React in
shared, shared-web, shared-server, shared-graph or shared-test.

Review and remediate every changed human-authored file in full. Every support
file changed by that remediation enters the same closure recursively. Independent
untouched code remains outside closure. Remove superseded polling configuration,
branches and tests when each consumer is converted; no dual-mode compatibility
API, migration adapter or retained polling fallback ships. During implementation,
not-yet-converted owners are unfinished work, not an approved legacy boundary.

No feature may claim WS delivery merely because an outbox row completed. No public
scope-wide notification may disclose private resource identities. Do not broaden
friendship visibility, room admission, tournament publication or game authority.

## Stage 1: Reliable push updates for coordination views

### First implementation increment: refresh coverage

Modify `packages/shared-web/browser/api/authenticated-resource.ts` and its mirrored
`packages/tests/shared-web/api/authenticated-resource.test.ts` first. Preserve
`refresh(): Promise<void>`, exact command retry identity and account fencing.
Reuse `ThrottledFlush` to ensure a mark after a read starts is covered by a later
read. Coalesce concurrent later marks, avoid overlapping reads for the same
current generation, and settle callers only once their covering read finishes.
Cancellation, logout and replacement-account reads must not wait for an obsolete
request or start queued work with obsolete credentials.

Write the regression before implementation: hold one API read, change the
canonical view, call refresh again, resolve the old read, then assert the latest
view after the second refresh resolves. Also cover several invalidations merging
into one trailing read, stop/logout with queued work, account replacement and an
uncertain command retaining its exact retry identity.

Run `npx vitest run packages/tests/shared-web/api/authenticated-resource.test.ts`
and `npx tsc -p packages/shared-web/tsconfig.json --noEmit`. Then run the existing
friends, party, matchmaking and tournament browser-owner suites before publishing
this prerequisite. Passing these tests does not complete WS integration.

### Transactional notifications and browser integration

1. Define a small validated change contract beside existing shared API contracts:
   resource kind, authoritative scope, resource identity where permitted, and
   owner revision or durable change identity. Browser refresh counters and
   observation timestamps are not authoritative source revisions.
2. Compute audience and final notification/provenance records in the existing
   domain mutation's compute phase. Validate them and write atomically with the
   state and durable result. A conflict returns to outer QueueBox redelivery;
   replay does not create another business change. No post-commit-only publication.
3. Bind notifications to the existing authenticated WS lifecycle. Subscribe before
   the initial read; refresh after reconnect, foreground restoration and account
   change. Coalesce bursts, fence old responses and reject wrong-scope or untrusted
   sender messages. Keep manual refresh and fresh action-time authorization.
4. Establish recovery for server-side subscriber restart or loss even when the
   browser socket stays open. Reuse existing replay/resync facilities where their
   contract fits; prove gap detection and snapshot recovery before removing timers.
   Do not reuse topology replay authority for unrelated private views.
5. Convert party and matchmaking first, then friends, scheduled sessions/sharing,
   tournament catalog and brackets, and Move together. Remove their periodic
   refresh APIs and configuration as each path becomes complete.
6. Publish semantic presence changes, not every heartbeat. Cover session expiry,
   invite/search/confirmation deadlines and reservation windows using existing
   server deadline owners. Local timers display countdowns; they never authorize
   admission or substitute for a server transition.

Audience requirements:

| Surface | Required audience and invalidation |
| --- | --- |
| Friends/invitations | Affected account sessions across games; consent-scoped online status; revoke stale views after block/removal. |
| Party | Existing and removed members, affected invitees; leadership and semantic presence changes. |
| Matchmaking | Affected account/party cohort through confirmation, cancellation, expiry and admission. |
| Sessions/sharing | Authorized organizers, reservation holders and preview watchers; public discovery only in its scope. |
| Tournament catalog | Public subscribers in the game/workspace; private My tournaments updates to the account; no unlisted ID leakage. |
| Bracket | Authorized watchers including share-link visitors who are not entrants; organizer and entrants as appropriate. |
| Move together | Existing participant-targeted notices plus verified recovery and expiry. |

## Stage 2: AR Eye tournament snapshot streaming

Start after coordination updates and their recovery are verified. Replace the
200 ms tournament snapshot GET loop with room-bound server snapshots over the
existing WS lane. Reuse the snapshot decoder, scoped room message contracts,
server live publication and reconnect lifecycle. Keep the native game owner and
durable simulation clock authoritative; browser input remains a proposal.

Choose the publication cadence from measured freshness, payload size and fan-out.
Coalesce superseded snapshots and bound queued work; do not persist a new durable
notification for every simulation tick. Initial/reconnect authorized snapshots
repair the live stream. Reject stale attempts, old room/account generations and
wrong-room snapshots. Remove the replaced GET timer without changing casual play.

## Acceptance and validation

Extend existing journeys in `tests/playwright/party-journey.ts`,
`matchmaking-journey.ts`, `scheduled-session-journey.ts`, `move-together-journey.ts`
and `tournament-journey.ts`, plus native tournament play coverage. Reuse the AR Eye
and Relic full-stack browser fixtures. Do not duplicate whole journeys by game.

Required clickable regressions in both games:

- Invite/accept/remove a friend and invite/accept/leave/disband a party. The other
  browser updates without Refresh or reload, including after loss of membership.
- Find players, confirm/decline, expire and enter shared play through visible
  controls. No idle one-second reads or deadline-only stale screens.
- RSVP/cancel, open a scheduled lobby, publish/unlist/register/withdraw a
  tournament, and update its bracket with both public and private views open.
- Disconnect/reconnect one browser, restore a background tab and replace its
  account. Canonical state recovers without cross-account or cross-scope leakage.
- AR Eye native tournament play continues receiving authoritative position/score
  updates without periodic snapshot GETs; Relic gameplay still works.

At owned network ports, assert idle read suppression after initial settling and
bounded refreshes during a notification burst. Network assertions supplement
visible state assertions; they are not substitutes for clicking the workflow.

Server/package regressions must prove state/outbox atomic rollback, conditional
conflict retry, exact replay, audience isolation, forged messages, cross-process
routing, expiry, notification-during-read, and missed-event recovery. Include
mutation on API A, receiver on B and meaningful node C recovery in cluster tests.
Update reusable black-box recipes in `packages/shared-test/black-box-runner`.

Run focused Vitest suites and package typechecks; both game builds; API and Relic
server Deno checks; browser public-surface/bundle checks if those surfaces change;
repo style, structure and navigation checks; local and hosted clickable runs;
PostgreSQL black-box and fixed medium-scale gates; fresh controlled state-write
performance comparison; and Branch Release Gate. Distributed routing/recovery
selects hosted Hetzner validation and the relevant GitHub Free Distributed Recipe.
Use `npm run pr:delivery -- status` before broad final validation and `ready` once
all required work and gates are complete.

Measure idle and active requests/bytes, database work, WS fan-out, queue pressure,
update freshness and mutation p95/p99 against the merged baseline. Report measured
results separately from timer arithmetic. Do not exchange reduced HTTP traffic
for unbounded notifications or an unapproved performance regression.

## Review focus and rollback

The critical review cases are removal from an audience, time-derived expiry,
a notification during a read, cross-process subscriber loss without a browser
reconnect, and replaced-account/room generations. Each has explicit coverage above.

Rollback reverts the feature deployment as a coherent change; there is no shipped
legacy mode or migration path. Follow-up issues are only for independent work;
missing recovery, clickable coverage or performance evidence blocks completion.
