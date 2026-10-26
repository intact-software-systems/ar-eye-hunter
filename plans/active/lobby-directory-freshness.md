# Automatic lobby directory freshness

## Goal and constraints

Complete the automatic pull-refresh increment of slice 7 from the lobby roadmap.
A signed-in person looking at either game's lobby sees newly available rooms and removals
without repeatedly pressing Refresh. Directory observations never adopt a room, change admission,
or hydrate authoritative membership snapshots.

Use test-driven development, existing repository patterns, and one new PR from main. No legacy,
no migration code, no duplicate implementation. Preserve scope, pagination, occupancy/RTT ordering,
current room, invitation precedence, and application-owned activity participation. Wait for the
maintainer's merge before another slice. Current main includes seven-day deletion and the generic
server application AppInbox; this slice does not change their mutation paths.

## Design

Use deliberate foreground polling through the existing directory facade and HTTP endpoint.
A shared browser directory lifecycle owns refresh scheduling, pagination, deduplication, request
ownership and safe publication. Both games consume it instead of retaining separate directory
algorithms. Keep each game's explicit full room refresh as an app action; automatic reads invoke
only `rooms.directory`.

Implementation choices delegated to the builder by the ongoing goal:

- Refresh immediately when an authenticated observer starts, then 30 seconds after the preceding
  refresh settles. Use the existing `startRepeating`, `SingleFlight` and injectable `Timers` owners.
- Pause automatic work while the page is hidden or offline; refresh on becoming visible/online.
  Stop timers, listeners and abortable requests on disposal. Logout clears results; replacement
  accounts and changed filters cannot receive old results or pagination continuations.
- Coalesce overlapping refreshes for the same session/query. A query or session replacement cancels
  and fences its predecessor. A stale callback cannot overwrite a new loop's cancellation owner.
- Read all pages sequentially, deduplicate by scoped room identity, and publish a complete result.
  Preserve the last complete result on failure. A failed refresh is visibly stale, never an empty
  success. Detect a repeated continuation cursor as a failed read rather than an endless loop.
- Manual Refresh remains available. Hidden/offline automatic triggers do nothing; an explicit
  manual request may still run and report its ordinary error. Automatic failures wait the normal
  interval; no tight retry loop is added. Use bounded existing operation timeout/retry options.
- Use existing HTTP caching behavior: the server already sends private/no-cache, ETag, and
  authorization-vary headers. Do not add a second app-owned ETag cache or change the REST contract.
  Verify browser conditional revalidation separately if claiming transfer savings; automatic
  freshness does not depend on a 304 saving database work.

Alternatives considered: app-local polling would duplicate lifecycle rules; push requires a new
workspace directory subscription/removal protocol without current evidence that pull is inadequate.
The existing roadmap explicitly selects automatic refresh first. Push and friendship remain
outcome-shaped future work; no friend-location inference is added.

## Current owners and intended interfaces

- `packages/shared-web/browser/rooms/browser-rallar-rooms.ts` owns `rooms.directory(request, options)`.
  It connects under authentication, reads safe `GroupDirectoryPage` values and does not accept full
  snapshots. Existing operation options support cancellation, timeout and retry limits.
- `packages/shared-web/browser/state-read/state-snapshot-http-api.ts` owns the HTTP page request.
  `apps/api-v1/src/group-state/register-group-state-read-routes.ts` owns private revalidation.
- `packages/shared/resilience/start-repeating.ts`, `single-flight.ts`, and `timers.ts` supply mechanisms.
- New `packages/shared-web/browser/rooms/directory/rallar-room-directory.ts` owns the browser lifecycle.
  Publish intentionally through new `packages/shared-web/browser/rallar-room-directory.ts`.
  Follow `RallarRoomEntry`/`RallarRecentRooms` construction and subscription conventions.
- Public class `RallarRoomDirectory`: `createBrowser(browser, config)`, constructor with explicit
  dependencies/config, `start(): Promise<void>`, `stop(): void`, `refresh(): Promise<void>`,
  `setRequest(request): Promise<void>`, `getState()`, `onChange(listener)`.
  Config owns immutable scope, complete directory query, refresh interval and operation bounds.
  State contains complete entries, `idle | loading | ready | error` status, and an explicit failure
  value. Any additional freshness timestamp must have a direct UI use rather than speculative data.
  Dependencies own auth, page reads, timers and page activity; browser construction resolves globals.
- AR Eye: replace paginated discovery in
  `apps/ar-eye-hunter-v1/src/game/arena-runtime/actions/use-arena-directory-actions.ts`.
  Integrate lifecycle with its existing authenticated React runtime. Remove superseded directory
  generation state; keep the distinct full room-refresh ownership guard where still required.
- Relic: replace directory paging in `apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts`;
  compose the shared owner in `relic-hunters-browser.ts`. Keep expedition and current-room state
  independent from directory publications. UI remains in `game/hud/relic-lobby.tsx`.

## Next two implementation increments

### 1. Shared lifecycle with semantic tests

1. Add behavior tests at
   `packages/tests/shared-web/rooms/directory/rallar-room-directory.test.ts` using real shared
   scheduling/concurrency primitives and controlled auth, page-read and activity ports.
2. Watch the tests fail for absent automatic behavior before implementation. Assert public state
   and owned page-read requests, not private method topology.
3. Implement the shared owner with required explicit dependencies. No app identities belong here.
4. Prove initial and interval refresh, appearance/removal, pagination/deduplication, repeated cursor
   failure, complete-result retention on partial failure, automatic recovery, manual coalescing,
   query replacement, account replacement, logout, hidden/offline pause/resume, stop/restart and
   reentrant listener safety. Old in-flight completions must never publish or schedule fresh work.
5. Run focused Vitest, shared-web TypeScript and public API/browser bundle checks. Review every
   changed file and every support file recursively; independent untouched files stay outside closure.

### 2. Both consumer workflows and release evidence

1. Add failing app tests for automatic initial/periodic discovery without `rooms.refresh`, preserved
   current room and activity, account transitions, and manual full refresh. Adapt tests that protect
   superseded private paging topology to the same observable behavior; retain distinct failure risks.
2. Replace each app's directory algorithm with the shared owner and remove its predecessor state.
3. Add human-click Playwright journeys: sign in through visible controls; observe a room appear and
   disappear without clicking Refresh; exercise manual retry after a retained stale result; verify
   the current room and participation remain intact. Include both AR Eye and Relic. Timer control
   may accelerate elapsed time but must not call private application methods to simulate the flow.
4. Run affected app/package tests, both game builds, browser API/bundle checks, browser journeys,
   formatting, repository style/structure, and hosted Branch Release Gate. The existing game-room
   lanes remain required. No server mutation or concurrency-domain change is planned; if one becomes
   necessary, load the mutation guidance and require its full correctness/performance gates.
5. Update the lobby roadmap and current product documentation for the delivered behavior. Delete
   this implementation plan in the completing PR. Keep the live PR description current, publish
   reviewed commits, and wait for the maintainer merge.

## Validation commands and evidence

- `npx vitest run packages/tests/shared-web/rooms/directory/rallar-room-directory.test.ts`
- `npx vitest run packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts`
- `npm --workspace relic-hunters-v1 run test -- tests/relic-hunters-runtime.test.ts`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
- `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- `npm --workspace ar-eye-hunter-v1 run build`
- `npm --workspace relic-hunters-v1 run build`
- Select each game's existing Playwright configuration after inspecting its current fixtures and
  services; run the new journey through that canonical configuration and retain failure artifacts.
- `npm run pr:delivery -- status` before broad final checks; resolve real conflicts first.
- `npm run check:repo-style`, `npm run check:repo-structure`, applicable documentation governance,
  and exact-head hosted CI. Use scoped reruns for capped style output.

## Review focus and exit criteria

Hidden-tab work, rapid account/query replacement, slow pagination across a timer boundary,
stop/restart during an unresolved request, and refresh failure during active gameplay receive
explicit semantic coverage in their owning increment. Trace construction/registration separately
from runtime callbacks and cleanup. Every callback must capture completed dependencies.

Legacy baseline: two consumer directory pagination/publication algorithms and their request counters.
Exit: one canonical shared directory algorithm, no compatibility wrapper or duplicate polling loop,
and no stale request/session state in either consumer. The app's owned-room refresh is a distinct
capability and remains only where an explicit action needs it.

Do not claim a production freshness SLO: foreground success is bounded by interval plus request
and pagination duration; browser suspension, network failures and authorization still apply.
No production rollout is included. Public output and current-room behavior must remain correct
before any performance or simplicity claim is accepted.
