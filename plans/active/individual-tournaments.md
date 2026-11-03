# Individual tournaments implementation plan

> Execute in this checkout with test-driven development, then one independent whole-branch review. The PR is the delivery record. Delete this completed plan before readiness.

**Goal:** Four account-level competitors can register, play two semifinals and a final in either game, and see a champion established by trusted game results.

**Architecture:** Generic tournament contracts, bracket policy and persistence live in Rallar packages. Each application owns game rules and its trusted result producer. Server AppInbox owns every persisted mutation; conditional writes and immutable result facts provide replay and race safety. Both games consume one shared React tournament panel.

**Tech stack:** Existing TypeScript/Deno, Rallar application AppInbox, RuntimeState/PostgreSQL, React and Playwright. No new third-party dependency.

## Approved product specification

- Each tournament belongs to one application/workspace and one game. Entrants are individual accounts, not parties or teams; a tournament never compares AR Eye scores with Relic scores.
- Exactly four entrants. Registration order seeds semifinal 1 (first versus second) and semifinal 2 (third versus fourth); their winners play the final.
- Native game score decides the winner. Equal scores produce a tie requiring a new match attempt; browser ordering, username, connection time and secondary statistics cannot break it.
- A configurable no-show grace period defaults to ten minutes. One checked-in player advances after its deadline; neither checking in leaves an unresolved match for the organizer to cancel or reschedule.
- Complete scope includes registration, check-in, scheduling, gameplay, trusted results, advancement, withdrawal and cancellation in both games.
- No legacy, migration code, duplicated rule implementation, or React in shared/shared-web/shared-server/shared-test/shared-graph.

## Implementation decisions

- Organizer creation does not silently register the organizer. Register/withdraw are explicit; launching locks four entrants and their seed positions. Share links open a preview without leaving the current room.
- Organizer schedules a ready match, which creates a new immutable attempt identity and start time. Check-in is authenticated and bound to that attempt. The organizer explicitly starts at/after the scheduled time once both entrants are eligible. Rescheduling clears check-ins and invalidates old attempts.
- Explicit withdrawal after launch concedes the entrant's unresolved match. A double withdrawal leaves no winner and requires cancellation; no phantom entrant advances. Disconnect alone is not withdrawal. Forfeits are visibly distinguished from scored results.
- The bracket consumes an immutable server-written result bound to tournament, bracket slot, attempt, scoped room, game instance, rules and both account identities. Browser requests carry intent or a result reference, never authoritative scores, winners or a trust flag. There is no client result-upload or organizer score-override route.
- Results specialize the existing Rallar server-validated match result and native-points standings. Canonical result rows use private RuntimeState storage, not browser-writable AppData. The game owner computes and validates the final result and commits it atomically with the final game state. The game finalizer also compares and updates the exact private attempt revision, so cancellation or rescheduling defeats a stale finalizer and rolls back its game save. Tournament reconciliation reads the result and conditionally advances its own exact predecessor; replay never advances twice.
- Match rooms use existing cohort admission and retention. Only the bound competitors can play; spectators use existing read-only admission. Old attempts, room switches, bans and cancelled tournaments cannot create accepted results. Completed tournament evidence is independent of the room's later seven-day deletion.
- Relic derives its result from the server-owned finished expedition. A fresh tournament game instance prevents ordinary rematch/reset from reusing an attempt's result.
- AR Eye requires a server-authoritative tournament runtime: reuse its pure arena rules from a canonical game-owned package, validate authenticated input and compute score, health, pickups, target hits and end time on the server. Browser pose scores and director snapshots are never tournament authority. Ordinary casual browser-director play remains an explicitly separate supported authority mode using the same rules, not a duplicate predecessor.
- AR Eye's game-specific server composition stays outside generic API-v1/Rallar product code. Server time, bounded input rate and movement/shot policy are authoritative; rendering/prediction remains browser-side. This prevents forged score/result acceptance, not every possible automated-player advantage.
- Existing game settings remain visible and are frozen for a match attempt. Tournament matches must be finite. Match deadlines and no-shows use durable work, not an organizer tab timer.
- Private tournament views expose no session credentials. Account changes cancel pending browser work. Uncertain writes offer explicit retry with the same request identity through AuthenticatedResource.
- Current room departure restrictions remain: opening a tournament or preview never silently abandons an unfinished game. Entry uses RallarRoomEntry and explicit normal participation controls.

## Alternatives considered

- Fixed teams require team scoring, roster and substitution rules; the maintainer chose individual entrants.
- Browser-reported or organizer-confirmed scores do not meet trusted-result acceptance. A signed browser leaderboard would only authenticate the claimant.
- Separate game-specific bracket implementations would duplicate policy. One generic bracket and application-owned result producers preserve ownership.
- A full rewrite of casual AR Eye authority is not needed for tournament admission. Its existing casual mode stays supported; shared pure rules must have one owner.

## Review focus

1. A lost committed response, duplicate game completion or delayed old attempt must not advance twice or alter a newer bracket.
2. A forged score, wrong application/workspace, substituted account or spectator must never produce an accepted game result.
3. Check-in at the no-show boundary, cancel versus result, and withdraw versus start must converge under real conditional writes.
4. Reload, sign-out, room replacement and reconnect must preserve the current tournament without replaying stale browser intent.
5. Neither a tied score nor both players missing may silently pick a winner; the UI must expose the unresolved state and permitted recovery.

## Stage 1: Trusted match results

**Owners and interfaces:**

- `packages/shared/api/tournaments/tournament-types.ts`: mandatory scoped tournament, match-attempt, entrant and result contracts. Results bind the exact game instance and account roster.
- `packages/shared-server/rallar-system/tournaments/tournament-result-repository.ts`: exact validated immutable result reads and prepared conditional writes within the game owner's AppInbox transaction.
- `packages/ar-eye-hunter/`: canonical renderer-independent arena rules and server tournament mutation owner, extracted from `apps/ar-eye-hunter-v1/src/game/` without compatibility re-export files.
- `apps/ar-eye-hunter-server-v1/`: application composition using the existing Rallar server bootstrap and public application AppInbox; no game branches in generic API-v1.
- `packages/relic-hunters/server/relic-game-mutation-service.ts`: final-result production at its existing authoritative save boundary.
- Browser game adapters consume authoritative tournament snapshots/command outcomes and preserve current casual room behavior.

- [x] Write result-binding, immutable replay/conflicting result, wrong-slot corruption, cancelled attempt and competing finalization regressions; observe RED and verify the SQL-backed boundary.
- [ ] Extract only the pure AR Eye rule surface required by server authority, update direct browser imports, and prove rules remain identical through existing semantic suites. Remove the old definitions rather than retaining aliases.
- [ ] Add server-owned tournament game commands and canonical result writes. Test forged pose scores, invalid shots/movement, replay, expiry, spectator/ban refusal, exact account identity and server-controlled completion with real conditional storage.
- [ ] Connect Relic finalization to the same result contract without placing Relic rules in Rallar packages. Prove ordinary reset/rematch cannot rewrite a tournament result.
- [ ] Run focused game/result suites, both game builds, reusable package typechecks and both server native checks. Commit a coherent result-authority increment and publish one draft PR.

## Stage 2: Complete four-player tournaments

**Owners and interfaces:**

- `packages/shared/api/tournaments/tournament-request.ts`: decoded user intent and exact durable mutation result; no user-supplied authority.
- `packages/shared/tournaments/compute-tournament.ts`: pure bounded registration, bracket, check-in, scheduling, no-show, tie/replay, result, withdrawal and cancellation decisions.
- `packages/shared-server/rallar-system/tournaments/tournament-service.ts`: AppInbox registration and visible read/compute/validate/write; its repository owns canonical scoped records, corruption checks and CAS.
- `apps/api-v1/src/tournaments/register-tournament-routes.ts`: authenticated reads and request-keyed mutation ingress; app composition/config/OpenAPI bind the existing owners.
- `packages/shared-web/browser/tournaments/rallar-tournaments.ts`: account-fenced API resource, share-link preview and explicit room entry, composing AuthenticatedResource.
- `packages/shared-react/tournament-panel.tsx`: shared visible registration/bracket/match controls; app bindings stay narrow.
- `tests/playwright/tournament-journey.ts`: shared four-account human-clickable workflow used by both game specs; independent game actions remain game-owned.

- [ ] Write pure rule tests for seed order, capacity, semifinals/final, ties, exact deadline boundaries, one/both no-shows, withdrawal and terminal cancellation. Observe RED, implement minimal pure decisions, verify GREEN.
- [ ] Write real persistence tests for two contenders for the fourth seat, duplicate commands, no-show/check-in races, cancel/result races, stale attempts, corrupt scope and all-or-none room admission. Implement through existing AppInbox and conditional batch owners; no inner retry.
- [ ] Add authenticated REST and black-box recipes covering unauthorized access, complete bracket, result forgery refusal and exact replay. Reuse cohort admission, canonical keys and durable deadline work.
- [ ] Add browser resource and shared panel with visible refusal/retry, account fencing, links, check-in, start, tied replay, reschedule and cancellation. Add semantic UI tests before implementation.
- [ ] Play all three matches through visible controls in each built SPA and crown the actual winner. Include reload, account replacement, stale result, tied attempt, no-show recovery and spectator refusal. No test-only scoring endpoint or fabricated completion stands in for real play.
- [ ] Run focused suites and app builds, API black-box/Postgres overlap tests, medium-scale and controlled performance comparison, local and hosted clickable journeys, Branch Release Gate and classified Hetzner validation. Retain failure diagnostics and obtain explicit approval for any real performance exception.
- [ ] Perform one independent whole-branch code/structure/legacy review. Fix findings with RED-to-GREEN regressions. Review every changed human-authored file and recursively changed support file in full; independent untouched code stays outside closure.
- [ ] Update product/architecture docs and PR evidence, delete this completed plan, run delivery readiness once and wait for maintainer merge.

## Validation and completion

Direct proof is the actual four-player bracket played through both SPAs, plus adversarial authoritative-result and concurrency tests. Package/application proof includes both builds, shared package checks and game-server native checks. API/concurrency changes select the unweakened medium-scale and state-write comparison. Distributed-risk classification selects supported Hetzner validation; changed reusable recipes also run locally and hosted, including GitHub Free Distributed Recipe when applicable.

The feature is incomplete until both games can produce accepted results and finish the full bracket. A bracket-only UI, a typed `server-validated` marker, or a successful send is not completion evidence. No legacy or migration boundary is planned. Rollback removes the new feature deployment; it does not retain a second reader or rewrite existing records.
