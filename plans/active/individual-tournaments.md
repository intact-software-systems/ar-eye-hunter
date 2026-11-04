# Individual tournaments implementation plan

> Execute in this checkout with test-driven development, then one independent whole-branch review. The PR is the delivery record. Delete this completed plan before readiness.

**Goal:** Four account-level competitors can register, play two semifinals and a final in either game, and see a champion established by trusted game results.

**Architecture:** Generic tournament contracts, bracket policy and persistence live in Rallar packages. Each application owns game rules and its trusted result producer. Server AppInbox owns every persisted mutation; conditional writes and immutable result facts provide replay and race safety. Both games consume one shared React tournament panel.

**Tech stack:** Existing TypeScript/Deno, Rallar application AppInbox, RuntimeState/PostgreSQL, React and Playwright. Runtime dependencies are unchanged. OpenAPI contract tests declare the already-installed Ajv validator directly instead of relying on its transitive ESLint dependency.

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
- Explicit withdrawal after launch invalidates participation. A remaining checked-in opponent advances only after the scheduled no-show grace deadline. A double withdrawal or an unchecked remaining opponent leaves no winner and requires organizer recovery; no phantom entrant advances. Disconnect alone is not withdrawal. Forfeits are visibly distinguished from scored results.
- The bracket consumes an immutable server-written result bound to tournament, bracket slot, attempt, scoped room, game instance, rules and both account identities. Browser requests carry intent or a result reference, never authoritative scores, winners or a trust flag. There is no client result-upload or organizer score-override route.
- Results specialize the existing Rallar server-validated match result and native-points standings. Canonical result rows use private RuntimeState storage, not browser-writable AppData. The game owner computes and validates the final result and commits it atomically with the final game state. The game finalizer also compares and updates the exact private attempt revision, so cancellation or rescheduling defeats a stale finalizer and rolls back its game save. Tournament reconciliation reads the result and conditionally advances its own exact predecessor; replay never advances twice.
- AppOutbox workers register explicit route topics before claiming work. Reuse the existing queue topic filter so generic API workers cannot consume game-owned timers; restart tests preserve unrelated SQL work.
- Arena checkpoints use existing RoomOwnedAppData with the group authority fence, so room retirement deletes them and stale writes cannot resurrect them. Result evidence remains private and independent of room deletion. SQL timestamps reuse one strict driver decoder for AppData and RuntimeState, preserving milliseconds.
- Match rooms use existing cohort admission and retention with the approved 15-minute reconnect grace; ordinary rooms keep ten minutes. Only the bound competitors can play; spectators use existing read-only admission. Old attempts, room switches, bans and cancelled tournaments cannot create accepted results. Completed tournament evidence is independent of the room's later seven-day deletion.
- Relic keeps 60-second planning deadlines and automatically advances reviews after the approved ten seconds. It derives its result from the server-owned finished expedition. A fresh tournament game instance prevents ordinary rematch/reset from reusing an attempt's result.
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

## Remaining implementation horizon

### 1. Complete browser reliability and affected scene ownership

Keep the complete native tournament experience as the outcome. Preserve the existing trusted result, admission, scope and clock policies. The current evidence calls for targeted corrections in the actual browser path, with semantic regressions at each affected owner and human-clickable proof in both SPAs.

For AR Eye, retain independent queued-fire progression, terminal graphics idling, conditional renderer publication, current-snapshot egress and frame completion before local-pose side effects. Validate both the native full bracket and ordinary Quick Join, reload, readiness cancellation and repeat play. Do not treat a passing unit model as a substitute for the real frame/command integration. Untouched solo previews must present one complete image and idle while their account browses the lobby; meaningful game input resumes solo play, and joined rooms and spectators stay live. Reuse the shared frame scheduler rather than retaining a second scheduling mechanism. Preserve all keyboard, canvas, virtual-stick, touch-action and gyro input paths, ready resize redraw and exact game clocks. Hosted evidence shows four software GPU processes competing during native shots, including two unjoined previews; validate the resulting load and shot responsiveness without treating that correlation as proof of a particular blocking driver call.

For Relic, eliminate ongoing rendering of finished/cancelled native tournament scenes while keeping active games and spectators live. The large existing scene owner enters full standards closure: first consolidate its React presentation, Babylon lifecycle and coherent geometry/synchronization responsibilities, then implement the immediately following terminal-idling behavior through those owners. Reuse the existing timing abstractions and put any missing game-independent frame scheduling mechanism in shared code, with no Babylon or React dependency there. Domain terminal and shader-readiness policy remains in the app. Preserve the reviewed hydration guard and direct imports; remove affected predecessors instead of retaining compatibility paths.

Terminal-page acceptance includes compositor work as well as Babylon draws. A same-page intervention/restoration measured the infinite brand pulse and backdrop blur as recurring GPU costs even with a stable draw counter. Keep the brand static, give decorative cues and victory confetti finite lifetimes, and remove the expensive backdrop blur while preserving readable panel backgrounds, current camera controls and gameplay feedback. The browser regression must observe every draw, current intended-image readiness, actual pixels and settled page animations; a latched last-ready timestamp is insufficient. Relic readiness must sample the current camera’s evaluated visible meshes before drawing and confirm the same frame afterward; it must not require identical membership across consecutive camera frames. A newly visible material that becomes ready only after a skipped draw remains pending until a complete subsequent frame. Relic’s noninteractive opening uses a static image of its existing gate, relic and steps, with no Babylon context or draw loop before gameplay. The user permits appearance changes for performance. Remove the procedural opening owner and its graphics-only hydration deferral instead of retaining a second renderer or migration path. A ready still-rendered opening exposed an intermittent blank resize image, and scheduling its invalidation through the driver did not reliably cure it; do not retain that unsuccessful shared-scheduler experiment. The static asset removes this unnecessary graphics lifetime while active gameplay keeps its existing renderer and frame semantics. Browser acceptance proves a decoded visible image at desktop and resized/mobile bounds, zero opening WebGL allocations, human login and room entry, and subsequent live gameplay graphics. Update real lifecycle tests to count actual gameplay contexts; do not manufacture canvas diagnostics for an image. Full native reload reliability remains a required result with unchanged deadlines, and the exact earlier browser-internal blocking call remains unobserved.

Native completion publication also belongs to this reliability outcome: persisted WebSocket snapshots must expose the same computed tournament participation status and exact binding that commit with the final game/result. Player-driven and clock-driven finalization require durable outbox regressions; do not compensate with client inference or REST polling. Preserve read/compute/validate/write, AppInbox retries and the existing conditional guard.

Direct acceptance uses genuine native completion/cancellation, active Watch, stable terminal rendering, ready resize redraw, retained graphics allocation and next-room rendering. Both games must play the full bracket with existing per-action entry limits. Measure terminal-page CPU and final-entry responsiveness in the same environment; distinguish elapsed script time from process CPU, and do not claim an exact native blocking call without a profile.

Every changed human-authored file is reviewed and remediated in full. Every support file changed by that remediation enters closure recursively. Independent untouched code remains outside closure. App/package typechecks and builds validate the affected boundaries in addition to direct behavioral tests. No legacy, migration, duplicate mechanism, timeout weakening or new unapproved standards exception is planned.

### 2. Complete final review and exact-candidate validation

After the browser correction is coherent, publish it through the existing PR and complete the final local and hosted native brackets, ordinary affected journeys, release gate, API correctness and unchanged medium-scale workload. Run the full controlled state-write comparison and selected distributed validation, including GitHub Free and the authorized Hetzner workflow. Record actual results and remaining uncertainty in the PR; partial benchmark output cannot establish a verdict, and a prior commit's pass cannot replace a required final-candidate check.

Complete independent review of the changed code, ownership and affected legacy. Resolve real conflicts before final validation, but do not rebase merely because the branch is behind while mergeable. Delete this plan only when its outcomes are complete, update the semantic PR description, run delivery readiness once, and leave the merge to the maintainer.

## Validation and completion

Direct proof is the actual four-player bracket played through both SPAs, plus adversarial authoritative-result and concurrency tests. Package/application proof includes both builds, shared package checks and game-server native checks. API/concurrency changes select the unweakened medium-scale and state-write comparison. Distributed-risk classification selects supported Hetzner validation; changed reusable recipes also run locally and hosted, including GitHub Free Distributed Recipe when applicable.

The feature is incomplete until both games can produce accepted results and finish the full bracket. A bracket-only UI, a typed `server-validated` marker, or a successful send is not completion evidence. No legacy or migration boundary is planned. Rollback removes the new feature deployment; it does not retain a second reader or rewrite existing records.
