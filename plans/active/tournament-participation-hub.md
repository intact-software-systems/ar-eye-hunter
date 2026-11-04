# Tournament discovery and participation hub plan

**Goal:** Players in either game can discover a published tournament, register, find their next match, check in, enter or watch, and revisit its trusted results through one coherent UI.

**Architecture:** Extend the existing generic tournament capability with an explicit discovery policy and bounded collection reads. Reuse the selected-bracket owner and shared React panel; game servers retain all scoring and advancement authority.

**Tech stack:** Existing TypeScript/Deno, RuntimeState, server AppInbox, React and Playwright. No new dependency is planned.

**Specification:** The product decisions below define this planned capability. The maintainer approved explicit publishing and game/workspace scope; remaining initial values are proposed implementation defaults, not separately approved product rulings. The implementation PR is the delivery record. Delete this plan before merging the completed capability.

## Product decisions

- New tournaments are unlisted. Only the organizer can explicitly Publish or Unlist. Public discovery is limited to the current game/application and workspace; there is no cross-game leaderboard or global tournament search.
- Unlisted means absent from discovery, not secret: the existing scoped share link still opens the bracket under existing authentication. Unlisting changes discoverability, not registration, participation, accepted results or room admission.
- Keep collection reads authenticated, matching current bracket reads. A signed-out visitor can retain a shared tournament destination and sign in; no anonymous catalogue is introduced in this slice.
- Offer Discover and My tournaments views. Discover shows listed registration/active tournaments. Completed/cancelled tournaments leave Discover but remain available through their links and in My tournaments for their organizer and registered entrants, including withdrawn entrants.
- Catalogue cards expose title, organizer, tournament status, active entrant count and the next scheduled match time when one exists. Do not fabricate an event-wide start time: the existing model schedules individual matches. Cards contain no session identity, check-in credentials, private attempt data or current-room location.
- My tournaments is private to the authenticated account and covers that account's organizer/entrant relationship across devices. It is not a friend's activity feed. No follow/watch-history subscription is added.
- Preview/select never registers, changes room or abandons gameplay. Register, check-in, Enter match and Watch stay explicit. The existing four-player format, native scores, tie replays, no-show grace, organizer start and room-retention rules remain unchanged.
- Show stale/offline and empty states distinctly. Proposed browser defaults: refresh on foreground return and 30 seconds after a completed visible/online refresh, plus manual Refresh; request timeout 10 seconds. Use server-observed status/time for eligibility, not a client clock grant.
- Within each selected tournament, show the player's next pending bracket match, current attempt/check-in state, and an explicit rescheduled/cancelled state. Do not claim a globally earliest match across unloaded catalogue pages. Refresh canonical bracket state before taking an action. Results come from accepted native result facts, never a catalogue-derived winner.
- In-app navigation and existing copyable links are sufficient. Email, push notifications, automatic reminders, seasons, rankings, teams, larger brackets and new friendship/invitation types are outside this slice.

## Current owners and reuse

| Responsibility                                  | Existing owner                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and canonical decoding                | `packages/shared/api/tournaments/`                                                                                                      |
| Bracket policy                                  | `packages/shared/tournaments/`                                                                                                          |
| Authoritative mutations, attempts and results   | `packages/shared-server/rallar-system/tournaments/tournament-service.ts`, `tournament-repository.ts`, `tournament-result-repository.ts` |
| Bracket projection and HTTP routes              | `packages/shared-server/rallar-system/tournaments/tournament-reader.ts`, `apps/api-v1/src/tournaments/register-tournament-routes.ts`    |
| Composition                                     | `apps/api-v1/src/composition/create-api-v1-tournament-services.ts`                                                                      |
| Selected bracket, exact-request retry and entry | `packages/shared-web/browser/tournaments/rallar-tournament.ts`, `tournament-http-api.ts`, `tournament-link.ts`                          |
| Shared UI                                       | `packages/shared-react/tournament-panel.tsx`                                                                                            |
| Browser collection lifecycle reference          | `packages/shared-web/browser/rooms/directory/rallar-room-directory.ts`; reuse its underlying shared primitives, not its room policy     |
| Bounded persistence reads                       | `RuntimeStateRepositoryLike.findEntriesByPrefixPage` in `packages/shared-server/runtime-state/runtime-state-repository.ts`              |
| API recipe and native journeys                  | `packages/shared-test/black-box-runner/tests/api-v1/api-v1-tournaments.json`, both games' existing tournament Playwright suites         |

Inspect `examples/browser-startup-room/README.md` for the canonical entry boundary. Existing links select one bracket; there is currently no tournament collection route or My tournaments owner to reuse verbatim.

## Approach and persistence boundary

**Recommended:** one catalogue reader and publication policy beside the existing tournament owner, plus one browser collection owner and shared UI. Keep the bracket as canonical truth. A separate app-specific directory would duplicate policy; scanning every tournament into browser memory would make privacy and request cost depend on total history.

Add publication policy as its own complete, scoped record, created only by an explicit publication command. Absence means no publication decision and therefore unlisted for any tournament, including newly created ones. This is domain state, not an old-record decoder fallback. Do not add optional visibility fields to existing bracket records, backfill history, introduce a dual reader, or mutate data during reads.

Publishing/unlisting must use AppInbox read → compute → validate → write with immutable command facts, exact revision guards and outer QueueBox conflict redelivery. Validate current organizer/session and bracket lifecycle. Fence the observed bracket as well as publication state; concurrent cancellation or completion must not make a stale active listing authoritative. Keep computed state, receipt and final outbox writes atomic; no direct mutation route or inner retry loop.

Collection reads use bounded scoped prefix pages and existing batch selectors, validate canonical keys/records, and project public fields server-side. My tournaments filters canonical bracket records by the authenticated principal, so existing entrants remain discoverable without a migration or incomplete newly introduced account index. Proposed bounds: 20 visible results by default, at most 50 requested, at most 200 scanned candidates per request. Return a scoped opaque continuation even for an empty filtered page; do not read until a page fills without a scan bound. No total count or global chronological ordering is promised. Use stable storage-key order and label time information as card data, not a global sort guarantee.

Test high-cardinality sparse personal history. If bounded paging cannot meet a measured usability requirement, pause that design decision and propose an index with explicit completeness semantics; do not hide an incomplete historical index behind a fallback or migration.

## Implementation horizon when selected

### 1. Publish and discover tournaments through both games

- Extend canonical tournament request/response decoding and the existing service registration for publication intents. Add a catalogue contract under `packages/shared/api/tournaments/`, a reader under `packages/shared-server/rallar-system/tournaments/`, and collection routing beside the existing bracket routes. Keep new contracts mandatory and use canonical type names.
- Proposed collection route: `GET /api/tournaments/apps/:applicationId/workspaces/:workspaceId/catalog`, with `view=public|mine`, bounded `limit` and opaque `cursor`. Validate scope/account binding on every cursor; derive the personal principal from authentication, never a caller-supplied account filter.
- First write tests for default-unlisted, organizer-only publish/unlist, replay/conflicting request identity, concurrent publish/cancel, complete/cancelled exclusion, cross-scope references, corrupt records, private field exclusion and sparse pagination. Exercise real conditional persistence, including rollback of receipt/outbox on collision.
- Add `rallar-tournament-catalog.ts` beside the current browser tournament owner and shared catalogue presentation in `packages/shared-react`. Reuse `AuthenticatedResource` where its contract fits, or its existing lifecycle primitives for paged state; do not create a second generic polling framework. Direct imports connect consumers to the real owner.
- Integrate both games through their existing TournamentPanel use. Click Create → confirm unlisted → Publish → discover from another account → Preview → Register. Unlist removes discovery without changing entrants or the selected room. Repeat after reload and account changes.

**Deliverable:** A complete organizer-to-new-player discovery journey in both games, with server-enforced privacy and existing registration semantics.

### 2. Recover participation and complete the match journey

- Add My tournaments and next-match presentation using the same catalogue reader and selected-bracket owner. Retain organizer/entrant history after withdrawal or completion; never expose another account's private list.
- Reuse `RallarTournament.enter` and `RallarRoomEntry` for player/spectator entry. No new admission or scoring algorithm. A stale card must refresh and either enter the current authorized attempt or explain refusal/rescheduling; it cannot enter an obsolete attempt silently.
- Add controlled browser-owner tests for an account change during a page read, two overlapping refreshes, a failed later page, sign-out, and hidden/offline pause/resume. Preserve a complete prior view as explicitly stale; never mix accounts or scopes.
- Extend the actual native tournament journeys in `tests/playwright/ar-eye-hunter/tournaments.spec.ts` and `tests/playwright/relic-hunters/full-stack-tournaments.spec.ts`: find/register through the hub, recover My tournaments after reload, check in, enter/play both semifinals and final, watch read-only, and reopen the accepted champion/result. Retain separate cancellation, ties and stale-attempt coverage at the appropriate existing boundaries.
- Verify keyboard access, labels and narrow-screen layout in both games. Keep game-specific rules out of Rallar packages and all common React code in shared-react.

## Review focus

1. Unlisted/cancelled records, private check-ins and another account's personal history cannot leak through a page, cursor, count or cached response.
2. Register/withdraw/publish/cancel races converge through existing conditional writes and exact replay semantics.
3. Empty filtered pages advance the cursor, bound work and never imply that later matching records do not exist.
4. Refresh, sign-out and room replacement cannot let stale asynchronous work enter the wrong account/attempt.
5. A finished result remains readable after its temporary match room expires; catalogue rendering cannot recreate that room or rewrite results.

## Validation and exit

Start with semantic tests beside the existing shared, shared-server and shared-web tournament suites, then the API tournament recipe in memory and PostgreSQL. Run the live conditional-write races and unchanged medium-scale gate; a new publication mutation requires the controlled state-write comparative gate. Validate catalogue scan bounds and response privacy at repository and HTTP boundaries.

```sh
npx vitest run packages/tests/shared/tournaments packages/tests/shared-server/rallar-system/tournaments packages/tests/shared-web/tournaments
npm run typecheck:tests
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
DENO_NO_PACKAGE_JSON=1 RALLAR_ARENA_FULL_STACK=1 RALLAR_BROWSER_TIMING=1 npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts tests/playwright/ar-eye-hunter/tournaments.spec.ts --project desktop-delivery --workers=1 --trace=on
DENO_NO_PACKAGE_JSON=1 RELIC_HUNTERS_FULL_STACK=1 RELIC_HUNTERS_BUILT_PREVIEW=1 RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory npx playwright test --config apps/relic-hunters-v1/playwright.full-stack.config.ts tests/playwright/relic-hunters/full-stack-tournaments.spec.ts --project chromium --workers=1 --trace=on
npm run test:api-v1:black-box:postgres:medium-scale
```

Use the testing skill for exact affected package/Deno checks and public API snapshots/browser bundle boundaries. Run altered reusable recipes locally and hosted, including Run GitHub Free Distributed Recipe. Require Branch Release Gate, native hosted journeys and the selected Hetzner distributed validation under the standing authorization. Runtime service scripts and benchmark consumers must still type-check and execute after composition changes.

No legacy, migration code, duplicated bracket/entry policy, or React outside apps/shared-react. Every changed human-authored file is reviewed/remediated in full; support files changed during remediation enter closure recursively; independent untouched code remains outside closure. Completion needs a complete clickable experience in both games, independent review, honest performance evidence and green required CI. Rollback removes the feature deployment without retaining another implementation.
