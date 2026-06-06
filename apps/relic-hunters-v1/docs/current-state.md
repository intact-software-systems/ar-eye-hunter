# Current State

Last reviewed: 2026-05-19.

## Scope

This document covers the current SPA in `apps/relic-hunters-v1`, the paired
server in `apps/relic-hunter-server-v1`, and the shared game model/rules in
`packages/relic-hunters`.

## Application Shape

- `src/App.tsx` is still the main orchestration point for authentication, room
  selection, lobby state, action drafting, event reveal timing, audio, overlays,
  map panels, victory/defeat panels, and many display helpers.
- `src/game/hud/GameHudLayout.tsx` provides named HUD regions for scene, top,
  side, bottom, floating prompts, and overlays. This reduced free-floating UI
  overlap, but the root app still owns most component state.
- `src/game/game-view-model.ts` centralizes the client-facing gameplay view
  model: current player, current room, legal targets, objective text, warnings,
  turn status, and action blockers.
- `src/game/ai/` owns the browser AI planning companion: redacted context
  building, stable RallarAI request keys, deterministic mock generation,
  proposal validation, WS proposal sharing, and the React hook consumed by the
  side-panel companion UI.
- `src/game/relic-hunters-runtime.ts` wraps Rallar/auth/room APIs, relic REST
  calls, WS snapshot fanout, and RTC snapshot repair. React consumes it through
  `src/game/useRelicHunters.ts`.
- `src/game/RelicScene.tsx` is still a large Babylon scene runtime, but the
  React effect now calls a `createRelicSceneRuntime` boundary for Babylon setup.
  The same file still owns most sync/effect helpers, local movement, prompts,
  labels, and player/relic meshes.
- `src/game/scene/renderLoop.ts` owns the capped render-loop scheduler.
- `src/game/scene/networking.ts` owns cosmetic RTC position send/receive. The
  scene consumes it through a small runtime-state shape instead of importing
  Rallar directly, and outbound avatar positions now target Rallar's ready RTC
  peers as explicit next hops. Accepted public game snapshots are also shared
  over RTC as a repair path so UI/gameplay state does not depend only on avatar
  position packets. Incoming RTC avatar positions are used only while they are
  fresh and still match the player's authoritative snapshot room.
- `src/game/scene/movement.ts` owns the scene-pick-to-move-action bridge. When a
  player clicks a legal adjacent room in planning, the scene primes a move plan
  for that room instead of merely selecting it.
- `src/game/scene/castleKit.ts` owns the first reusable Japanese castle kit
  builders for room shell pieces: stone bases, plaster walls, timber rails,
  roof tiles, doorway frames, lacquer columns, lanterns, banners, torii gates,
  garden rocks, cherry trees, and a bridge builder for later corridor work.
- `src/game/scene/roomIdentity.ts` owns the room-kind-to-visual-role mapping:
  gatehouse, main corridor, armory/storage, main shrine, secret cell, treasury,
  haunted barracks, and garden watchtower.
- `src/game/scene/cameraModes.ts` owns the first scene camera-mode boundary.
  Idle planning now renders from a raised tactical overview, while active roam,
  clue inspection, lobby, review reveal, finale, and event focus remain distinct
  presentation modes.
  Recent avatar movement now keeps the close follow camera briefly before
  easing back to the tactical overview. The scene also exposes camera controls
  for a temporary room flyover, persistent tactical overview, and persistent
  avatar follow.
- `src/game/scene/avatarPresentation.ts` owns the first presentation-only
  avatar state boundary for idle, moving, arriving, locked, escaped, and
  defeated hunters.
- `src/game/scene/lightingPresets.ts` owns the first presentation-only lighting
  preset boundary for day, sunset, night, and lantern room moods.
- `src/game/scene/assetPipeline.ts` records the current procedural-first asset
  pipeline decision and the gate for a future measured hybrid glTF path.
- `src/game/scene/sceneCost.ts` owns the first active-effect-room selector used
  to cap active room lights and particle systems in tactical/full-map scenes.
- Round resolution now enters a shared `review` phase before the next planning
  turn. The server resolves submitted plans, clears locked actions, publishes
  the full event list, and waits for a `continue-review` command before
  advancing to the next round or final scoring.
- `docs/scene-contracts.md` records the scene data contracts for room world
  positions, interactive mesh metadata, avatar targets, prompt behavior, and
  baseline visual tolerances.
- `docs/asset-pipeline-decision.md` records the S7 asset decision, build-size
  output, browser scene metrics, future model folder shape, and follow-up work.
- The opening and lobby surfaces mount a lightweight Babylon ambient scene. The
  full gameplay `RelicScene` mounts for planning, review, and finished
  expedition phases so authentication, room joining, and Keeper controls remain
  responsive.
- The Babylon render path is capped at 45 fps for gameplay and 30 fps for the
  opening scene, uses lighter shadows and ambient
  occlusion, and paints an early clear frame before the heavier scene setup so
  the canvas is reliably nonblank under parallel browser load.
- The latest visual pass raises the gameplay scene cap to 45 fps, switches the
  Babylon canvases to high-DPI/native scaling, lowers fog/bloom/glow/grain/SSAO
  blur, disables depth of field, sharpens shadows, and increases avatar roam and
  remote interpolation speed so rooms and hunters read more crisply.
- Review snapshots queue each new animation cue for sequential Babylon playback
  instead of spawning every reveal effect at once. The finale cue now highlights
  winners escaping while defeated or losing hunters remain in rooms shaken by
  the collapse.
- `preserveDrawingBuffer` is disabled. Browser checks now use the canvas
  `data-scene-ready` signal emitted after Babylon renders a frame instead of
  relying on retained WebGL back buffers.
- The signed-in side panel has sticky section jumps and uses a wider/two-column
  layout on extra-wide desktop screens. The bottom HUD now stays in the scene
  column on desktop, leaving the right menu full-height so Rooms, Party/Plan,
  Map, and Intel remain reachable. The side region is now a stretched scroll
  container on desktop, and mobile removes side-panel clipping so the page can
  scroll through the full menu.
- The first-load intro cinematic is currently disabled so authentication and
  room entry are immediately reachable while the playable loop is being
  stabilized. If it is re-enabled, it must not block underlying SPA controls.
- The first-round onboarding modal is also disabled for now. The help dialog
  remains available from the top bar, but tutorial overlays should not block the
  room/join/planning loop.

## Validation

Current targeted validation:

```text
npm --workspace relic-hunters-v1 run test
npm --workspace relic-hunters-v1 run typecheck
npm --workspace relic-hunters-v1 run build
npx vitest run packages/tests/relic-hunters/relic-web-app.browser.test.ts packages/tests/shared-web/rallar-ai.test.ts
cd apps/relic-hunter-server-v1 && deno task check
npx playwright test tests/playwright/relic-hunters/web.spec.ts --grep "large-screen side menus|core lobby layouts|Rallar browser bootstrap"
RELIC_SCENE_BASELINE_WRITE=1 npx playwright test tests/playwright/relic-hunters/web.spec.ts --grep "scene upgrade baselines"
npm run test:playwright:relic
npm run test:playwright:relic:full-stack
```

For this review, `npm --workspace relic-hunters-v1 run test`,
`npm --workspace relic-hunters-v1 run typecheck`,
`npm --workspace relic-hunters-v1 run build`, and
`npx playwright test tests/playwright/relic-hunters/web.spec.ts --grep "renders a nonblank Babylon scene"`
pass. The app workspace test script now runs the Relic Hunters Vitest suite under
`apps/relic-hunters-v1/tests`, including the RTC avatar routing, stale-room RTC
avatar rejection, scene movement priming, camera return timing, flyover pose
planning, review summary/objective, review snapshot ordering, and RTC snapshot
repair regressions. The server and broader Playwright commands remain the
targeted validation set from the previous propagation pass. The package-level browser app
test now also covers timed-out round repair from an authoritative force-resolved
snapshot. The scene upgrade baseline writer also passes and writes eight
screenshots under `baseline/screenshots/scene-upgrades/` plus
`baseline/screenshots/scene-upgrades/scene-upgrade-metrics.json`. Planning
baseline scenarios also assert the gameplay canvas
`data-camera-mode="tactical"` contract.
Root `npm test` has historically failed in two shared-test suites unrelated to
Relic Hunters because Node's default ESM loader rejects HTTPS imports:
`packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts` and
`packages/tests/shared-test/scenario-black-box-rtc-config.test.ts`.

## Iteration Status

`apps/relic-hunters-v1` currently has `improvement-plan.md` for the broad app
track and `implementation-plan-for-scene-upgrades.md` for the Japanese castle
scene upgrade track. There is no generic `implementation-plan.md` in this app
folder.

- Iterations 1 through 6 are marked complete in the plan.
- Iteration 7, visual direction and Babylon cleanup, has a first pass complete.
- Iteration 8, scene architecture, is now in progress.
- Iteration 9, lobby and multiplayer flow, now has a first lobby-policy pass
  complete.
- Iteration 10, turn timeline and feedback, now has a first consolidation pass
  complete.
- Iteration 11, tests and Playwright coverage, now has a first coverage pass
  complete; its remaining propagation and visual-baseline work is now tracked as
  follow-up iterations.
- Iteration 12, two-client propagation and snapshot recovery, is in progress
  with the paired-server full-stack propagation path now validated.
- Iteration 13, stale participant policy and turn blocking, tracks the remaining
  multiplayer product-rule gap from the lobby pass and now has a first policy
  pass complete.
- Iteration 14, visual baselines and scene architecture follow-up, tracks the
  remaining `RelicScene` boundary work. The scene upgrade implementation
  sequence is now split into `implementation-plan-for-scene-upgrades.md`, and
  its S1 baseline/contract pass has browser screenshots and canvas render
  contracts in place. The S2 modular castle kit has a first implementation and
  is now used by gameplay room shells. The S3 room identity pass has a first
  implementation, with the split-party full-map state added to the screenshot
  baseline set. The S4 tactical camera pass now has a first implementation and
  planning baselines assert the tactical camera mode. The S5 avatar readability
  pass now has a first implementation with larger procedural hunters and tested
  presentation states. The S6 lighting preset pass now has a first
  implementation with tested day, lantern, night, and sunset preset selection
  plus baseline assertions for rendered lighting presets. The S7 asset pipeline
  pass now has a procedural-first decision, tested hybrid gate, scene metrics
  export, and documented future GLB conventions. The S8 scene-cost pass now has
  a first implementation that reduces per-room flame emitters, pauses inactive
  room particles/lights, and exports active particle/light metrics. The S9
  static batching pass now merges fully visible non-interactive room meshes by
  material and exports static batch metrics while leaving clue/action meshes
  independent. The S10 event-budget pass now limits simultaneous scene
  animation cues, exports active effect metrics, and resets draw-call metrics
  per rendered frame.
- Iteration 15, performance and production readiness, is the previous
  performance-oriented Iteration 12 moved behind the playable-loop follow-ups.
- Iteration 16, Rallar room fanout and reload recovery, was added as a completed
  follow-up for the Rallar-side recipient-cache race discovered during
  propagation testing.
- Iteration 17, remote avatar RTC routing, was added as a completed app-side
  follow-up for the reported remote player tracking failure.
- Iteration 18, RTC snapshot repair, was added as a completed app-side follow-up
  for the reported UI/game-state divergence after players moved to different
  rooms.
- Iteration 19, timed-out round snapshot repair, was added as a completed
  follow-up for stale UIs that missed the push snapshot after another client
  force-resolved an overdue round.
- Iteration 20, scene movement input and stale RTC room guard, was added as a
  completed follow-up for the reported avatar movement issue. Legal adjacent
  room clicks now prime a move draft, and old-room RTC avatar coordinates no
  longer override snapshot room movement.
- Iteration 21, round review and finale reveal, was added as a completed
  follow-up from the Iteration 10 feedback work. Round resolution now pauses in
  `review`, the SPA exposes a continue-review control, all clients receive the
  same reviewed snapshot through the existing REST/WS/RTC repair paths, and the
  scene queues reveal/finale animation cues for shared playback before the next
  turn or final collapse.
- With the current propagation, avatar-routing, RTC snapshot repair, timed-out
  round repair, review/finale reveal, tactical camera, avatar readability,
  lighting preset, asset pipeline, first active-effects fixes, static room
  batching, and event-cue metrics validated, the next planned scene work is
  per-room picking support for cross-room thin instancing/shared geometry before
  imported assets or broad production performance work.
- Completed iteration-7/playability fixes so far: remove blocking intro and
  onboarding from the default path, normalize local dev API calls through the
  same-origin proxy, make admin detection tolerate legacy snapshots without
  `adminPlayerId`, keep locked plans inspectable, reduce Babylon's HUD impact,
  disable `preserveDrawingBuffer`, separate normal player labels from debug
  detail labels, document the scene asset plan, and make route/clue state durable
  in the shared rules.
- Completed iteration-8 architecture fixes so far: extract
  `createRelicSceneRuntime`, move the capped render-loop scheduler to
  `scene/renderLoop.ts`, and move RTC position sync to `scene/networking.ts`.
- Completed iteration-9 multiplayer fixes so far: the lobby distinguishes online
  room members from joined expedition hunters, shows the Keeper explicitly,
  blocks Keeper start while connected room members have not joined the
  expedition, explains stale/offline joined players in the party-change prompt,
  and enforces start authority in shared game rules.
- Completed iteration-10 feedback fixes so far: bottom HUD feedback is reduced
  to one current-turn summary and one grouped turn timeline, and timeline events
  are labelled as Reveal, Your Action, Party Action, Castle Reaction, or Result.
  The floating turn feedback panel, post-round digest overlay, side personal
  round card, and compact diff strip are no longer in the normal render path.
  The follow-up review phase now makes the reveal an explicit shared gameplay
  state instead of immediately advancing to the next planning turn.
- Completed iteration-11 coverage fixes so far: turn-summary logic has focused
  unit tests, view-model action legality covers exit and defeated-player cases,
  Rallar runtime fake-dependency tests cover no-session, create/join hydration,
  and reset paths, and Playwright covers register, room creation, expedition
  join, start, submit, and resolved timeline feedback in one mocked browser
  flow.
- Completed iteration-12 propagation fixes so far: equal-timestamp snapshots
  with less complete event/submission/investigation state are rejected, runtime
  diagnostics expose last accepted snapshot metadata plus ignored snapshot
  reasons, development builds expose a compact runtime snapshot hook for browser
  tests, room rows expose stable room ids, and a gated full-stack Playwright spec
  has been run against the paired server and covers two-browser convergence
  through join/start/submit/resolve, reload recovery, reset, and rejoin.
- Completed iteration-16 Rallar follow-up fixes so far: server state sync now
  updates client/group snapshot caches before queuing WS fanout, so immediate
  room-scoped relic snapshots include newly joined room recipients; the SPA also
  remembers the current room id and rejoins it during reload hydration.
- Completed iteration-17 RTC avatar fixes so far: scene position broadcasts
  dedupe `rallar.rtc.readyPeerIds()` into explicit `nextHopPeerIds`, include
  the current game room and avatar room, send both world coordinates and
  room-relative offsets, use one-hop best-effort delivery, and do not advance
  the send throttle while no RTC peer is routable.
- Completed iteration-18 RTC snapshot fixes so far: the runtime subscribes to
  Relic snapshot messages over Rallar RTC, publishes accepted non-RTC public
  snapshots to ready peers immediately, and periodically republishes the current
  snapshot as a repair signal. Incoming RTC snapshots go through the same
  room/timestamp/round/completeness acceptance gate as REST and WS snapshots.
- Completed iteration-19 timeout repair fixes so far: when a planning round has
  passed its deadline and still has waiting active hunters, the runtime polls
  the authoritative room snapshot until the stale timed-out state is replaced by
  the server's resolved snapshot or another accepted update changes the round.
- Completed iteration-13 stale-participant fixes so far: the product policy is
  explicit auto-skip after timeout. Any active hunter can send
  `force-resolve-round` once the timer expires; missing plans are skipped and the
  round resolves with the plans already locked. The timed-out planning UI exposes
  this recovery action, and the party-change prompt now says offline joined
  hunters can hold a round until the timer expires rather than block forever.

## Main Risks

- Multiplayer state still depends on all clients accepting the correct room
  snapshot from a mix of REST command responses and Rallar WS snapshot pushes.
  The real `RELIC_HUNTERS_FULL_STACK=1` propagation run now passes, but lower
  level WS disruption and repair paths are still not separately simulated.
- The runtime has diagnostics, single-browser/server Playwright coverage, and a
  gated two-browser full-stack spec. Default validation only compiles/skips that
  full-stack spec unless the real server/database environment is enabled.
- Remote avatar tracking, RTC snapshot repair, and timed-out round repair now
  have focused coverage, but there is not yet a full browser-level visual
  assertion that two live Babylon scenes interpolate each other's avatars and
  converge after a missed WS update.
- `RelicScene.tsx` remains risky to change because scene sync, labels, event
  effects, and player controls are still tightly coupled, though Babylon setup,
  render-loop scheduling, and RTC position sync now have clearer boundaries.
  This is now tracked by Iteration 14.
- The app is visually dense. The large-screen side menu is easier to navigate,
  but many panels and overlays still compete for attention during planning and
  event reveal.
- Server rules serialize writes per game. Current product policy is explicit
  and timer-based: disconnected/stale joined players remain in the expedition,
  but after the round timer expires an active hunter can force the round to
  resolve and skip missing plans. Reset still rebuilds the expedition roster.

## Working Agreement

Keep these docs up to date when changing the SPA, gameplay rules, server command
flow, or Babylon scene behavior. If a bug requires changes outside
`apps/relic-hunters-v1`, `apps/relic-hunter-server-v1`, or
`packages/relic-hunters`, document it as a separate iteration or follow-up
before touching that area.
