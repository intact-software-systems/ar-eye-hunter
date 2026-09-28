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
- `src/game/relic-hunters-runtime.ts` wraps Rallar/auth/room APIs, relic
  commands on the Rallar WS `command` channel (REST before the server id is
  known), WS snapshot fanout with receipts, and RTC snapshot repair. React
  consumes it through `src/game/useRelicHunters.ts`.
- `packages/relic-hunters/src/expedition-blueprint.ts` owns the server-side
  expedition blueprint contract, JSON schema, procedural fallback generator, and
  domain validation for optional maze/castle/reward variation.
- `apps/relic-hunter-server-v1/src/relic-expedition-ai.ts` owns the optional
  server-side RallarAI setup path. It is disabled by default, can use mock or
  Ollama providers, and falls back to validated procedural setup if generation
  fails.
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
npx vitest run packages/tests/relic-hunters/relic-expedition-blueprint.test.ts packages/tests/relic-hunters/relic-expedition-ai.test.ts packages/tests/relic-hunters/relic-server-service.test.ts
npx vitest run packages/tests/relic-hunters/relic-web-app.browser.test.ts packages/tests/shared-web/rallar-ai.test.ts
cd apps/relic-hunter-server-v1 && deno task check
npx playwright test --config apps/relic-hunters-v1/playwright.config.ts tests/playwright/relic-hunters/web.spec.ts --grep "large-screen side menus|core lobby layouts|Rallar browser bootstrap"
RELIC_SCENE_BASELINE_WRITE=1 npx playwright test --config apps/relic-hunters-v1/playwright.config.ts tests/playwright/relic-hunters/web.spec.ts --grep "scene upgrade baselines"
npm run test:playwright:relic
npm run test:playwright:relic:full-stack
```

For this review, `npm --workspace relic-hunters-v1 run test`,
`npm --workspace relic-hunters-v1 run typecheck`,
`npm --workspace relic-hunters-v1 run build`, and
`npx playwright test --config apps/relic-hunters-v1/playwright.config.ts tests/playwright/relic-hunters/web.spec.ts --grep "renders a nonblank Babylon scene"`
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
