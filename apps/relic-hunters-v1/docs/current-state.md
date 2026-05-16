# Current State

Last reviewed: 2026-05-16.

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
- `src/game/relic-hunters-runtime.ts` wraps Rallar/auth/room APIs and relic REST
  calls. React consumes it through `src/game/useRelicHunters.ts`.
- `src/game/RelicScene.tsx` is still a large Babylon scene runtime, but the
  React effect now calls a `createRelicSceneRuntime` boundary for Babylon setup.
  The same file still owns most sync/effect helpers, local movement, prompts,
  labels, and player/relic meshes.
- `src/game/scene/renderLoop.ts` owns the capped render-loop scheduler.
- `src/game/scene/networking.ts` owns cosmetic RTC position send/receive. The
  scene consumes it through a small runtime-state shape instead of importing
  Rallar directly.
- The full Babylon runtime now mounts only for planning and finished expedition
  phases. Auth and lobby use a static scene backdrop so the HUD stays responsive
  while players register, join rooms, and start the expedition.
- The Babylon render path is capped at 30 fps, uses lighter shadows and ambient
  occlusion, and paints an early clear frame before the heavier scene setup so
  the canvas is reliably nonblank under parallel browser load.
- `preserveDrawingBuffer` is disabled. Browser checks now use the canvas
  `data-scene-ready` signal emitted after Babylon renders a frame instead of
  relying on retained WebGL back buffers.
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
cd apps/relic-hunter-server-v1 && deno task check
npm run test:playwright:relic
npm test
```

The Relic-focused app, package, server, build, and Playwright checks pass as of
this review. Root `npm test` still fails in two shared-test suites unrelated to
Relic Hunters because Node's default ESM loader rejects HTTPS imports:
`packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts` and
`packages/tests/shared-test/scenario-black-box-rtc-config.test.ts`.

## Iteration Status

`apps/relic-hunters-v1` currently has `improvement-plan.md`; there is no
`implementation-plan.md` in this app folder.

- Iterations 1 through 6 are marked complete in the plan.
- Iteration 7, visual direction and Babylon cleanup, has a first pass complete.
- Iteration 8, scene architecture, is now in progress.
- Iteration 9, lobby and multiplayer flow, now has a first lobby-policy pass
  complete.
- Iteration 10, turn timeline and feedback, now has a first consolidation pass
  complete.
- Iteration 11, tests and Playwright coverage, now has a first coverage pass
  complete.
- Because the reported failure is that the game is not playable and state is not
  propagating reliably between clients, iteration 7 should be kept narrow and
  paired with data-flow fixes when a concrete propagation bug is found.
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
- Completed iteration-11 coverage fixes so far: turn-summary logic has focused
  unit tests, view-model action legality covers exit and defeated-player cases,
  Rallar runtime fake-dependency tests cover no-session, create/join hydration,
  and reset paths, and Playwright covers register, room creation, expedition
  join, start, submit, and resolved timeline feedback in one browser flow.

## Main Risks

- Multiplayer state still depends on all clients accepting the correct room
  snapshot from a mix of REST command responses and Rallar WS snapshot pushes.
- The runtime has diagnostics and single-browser/server Playwright coverage,
  including a mocked first-turn browser loop, but there is no automated
  two-client browser test for submit/wait/resolve propagation yet.
- `RelicScene.tsx` remains risky to change because scene sync, labels, event
  effects, and player controls are still tightly coupled, though Babylon setup,
  render-loop scheduling, and RTC position sync now have clearer boundaries.
- The app is visually dense. Even after the HUD layout pass, many panels and
  overlays compete for attention during planning and event reveal.
- Server rules serialize writes per game. Current product policy is explicit
  rather than automatic: disconnected/stale joined players remain in the
  expedition and can block turn resolution unless the room is reset.

## Working Agreement

Keep these docs up to date when changing the SPA, gameplay rules, server command
flow, or Babylon scene behavior. If a bug requires changes outside
`apps/relic-hunters-v1`, `apps/relic-hunter-server-v1`, or
`packages/relic-hunters`, document it as a separate iteration or follow-up
before touching that area.
