# Current State

Last reviewed: 2026-05-18.

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
  position packets.
- The opening and lobby surfaces mount a lightweight Babylon ambient scene. The
  full gameplay `RelicScene` mounts for planning and finished expedition phases
  so authentication, room joining, and Keeper controls remain responsive.
- The Babylon render path is capped at 30 fps, uses lighter shadows and ambient
  occlusion, and paints an early clear frame before the heavier scene setup so
  the canvas is reliably nonblank under parallel browser load.
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
cd apps/relic-hunter-server-v1 && deno task check
npx playwright test tests/playwright/relic-hunters/web.spec.ts --grep "large-screen side menus|core lobby layouts|Rallar browser bootstrap"
npm run test:playwright:relic
npm run test:playwright:relic:full-stack
```

For this review, `npm --workspace relic-hunters-v1 run test`,
`npm --workspace relic-hunters-v1 run typecheck`, and
`npm --workspace relic-hunters-v1 run build` pass. The app workspace test script
now runs the Relic Hunters Vitest suite under `apps/relic-hunters-v1/tests`,
including the RTC avatar routing and RTC snapshot repair regressions. The server
and Playwright commands remain the broader targeted validation set from the
previous propagation pass. The package-level browser app test now also covers
timed-out round repair from an authoritative force-resolved snapshot.
Root `npm test` has historically failed in two shared-test suites unrelated to
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
  complete; its remaining propagation and visual-baseline work is now tracked as
  follow-up iterations.
- Iteration 12, two-client propagation and snapshot recovery, is in progress
  with the paired-server full-stack propagation path now validated.
- Iteration 13, stale participant policy and turn blocking, tracks the remaining
  multiplayer product-rule gap from the lobby pass and now has a first policy
  pass complete.
- Iteration 14, visual baselines and scene architecture follow-up, tracks the
  unfinished visual screenshot and `RelicScene` boundary work.
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
- With the current propagation, avatar-routing, RTC snapshot repair, and
  timed-out round repair fixes validated, the next planned work should return
  to Iteration 14 visual baselines and scene architecture before spending effort
  on production performance.
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
