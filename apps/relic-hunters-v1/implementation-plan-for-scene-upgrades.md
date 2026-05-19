# Relic Hunters Scene Upgrade Implementation Plan

Last reviewed: 2026-05-19.

## Goal

Move the Relic Hunters Babylon scene toward a crisp, modern Japanese castle
adventure look inspired by the reference board: a readable castle overview,
distinct room identities, warm interior lantern lighting, cool exterior fill,
strong silhouettes, and responsive player avatars.

The target is not photoreal concept art in the first pass. The practical target
is a stylized tactical diorama that can still run inside the existing SPA,
preserve the current turn-based game state, and remain testable in browser
automation.

## Working Assumptions

- Keep the current gameplay rules and public snapshot model unchanged unless a
  scene feature exposes a real data-flow bug.
- Start with code-native Babylon geometry and materials. Add glTF or generated
  bitmap assets only after the modular scene structure is stable.
- Keep the gameplay action panel authoritative. Scene prompts can prime plans,
  but they should not become a second rules engine.
- Prefer crispness and readability over heavy fog, bloom, blur, depth of field,
  or dark cinematic grading.
- Keep every iteration small enough to validate with unit tests, typecheck, and
  targeted Playwright smoke checks.

## Current Baseline

- `src/game/RelicScene.tsx` still owns Babylon setup, sync, movement, event
  effects, room props, avatars, relics, labels, and camera behavior.
- Rendering now uses high-DPI/native canvas scaling capped at 2x device ratio,
  a 45 fps gameplay cap, lighter fog/bloom/glow/grain/vignette, disabled depth
  of field, sharper shadows, and faster avatar roam/interpolation.
- Round review now keeps the gameplay scene mounted with planning input
  disabled, queues reveal cues sequentially, and stages the final collapse cue
  with escaping winners and losing hunters left in shaken rooms.
- `src/game/scene/networking.ts` owns RTC avatar position send/receive.
- `src/game/scene/rooms.ts` owns most current procedural room construction,
  materials, props, lights, particles, and lobby scenery.
- Browser smoke tests already verify that the opening scene and gameplay scene
  render nonblank.

## Iterations

### Iteration S1: Visual Baseline And Scene Contracts

Establish measurable scene expectations before large visual changes.

Status: first pass complete. Browser coverage now opens the opening, lobby,
planning desktop, planning mobile, waiting/locked, resolved timeline, and
finished states in high-DPI contexts, verifies nonblank visible canvas samples,
and can write baseline screenshots to
`baseline/screenshots/scene-upgrades/` with `RELIC_SCENE_BASELINE_WRITE=1`.
`docs/scene-contracts.md` documents the room, metadata, player target, prompt,
and visual baseline contracts future scene modules must preserve. The baseline
writer passed on 2026-05-18 with:
`RELIC_SCENE_BASELINE_WRITE=1 npx playwright test tests/playwright/relic-hunters/web.spec.ts --grep "scene upgrade baselines"`.

Deliverables:

- Add or extend Playwright coverage for scene screenshots at desktop and mobile
  planning viewports: first pass complete.
- Capture baseline screenshots for opening, lobby, planning, waiting/locked,
  resolved timeline, and finished states: first pass complete when
  `RELIC_SCENE_BASELINE_WRITE=1` is used.
- Add canvas-level checks for high-DPI drawing buffer size, nonblank render, and
  visible gameplay controls: first pass complete.
- Document accepted visual tolerances: readable room silhouettes, no clipped HUD
  controls, no dark/black gameplay rooms, and no soft/blurred avatar edges:
  first pass complete.
- Add a lightweight scene contract doc for room ids, room world positions,
  player targets, prompt metadata, and interactive mesh metadata: first pass
  complete in `docs/scene-contracts.md`.

Tests:

- Extend `tests/playwright/relic-hunters/web.spec.ts` with crispness/readability
  smoke assertions where possible.
- Keep `npm --workspace relic-hunters-v1 run test`, typecheck, and build passing.

Docs:

- Update `docs/current-state.md`, `docs/visual-direction.md`, and this plan with
  captured baseline paths and known visual gaps.

Exit criteria:

- Scene changes can be compared against stored browser screenshots and basic
  render metrics instead of relying only on subjective inspection.

### Iteration S2: Modular Japanese Castle Kit

Replace one-off procedural room shells with reusable castle kit pieces.

Status: first pass complete. `src/game/scene/castleKit.ts` now provides
reusable Babylon builders and a pure wall-segment planner. Gameplay room shells
use the kit for stone bases, plaster wall segments, timber rails, roof tile
caps, lacquer columns, door frames, lanterns, banners, torii gates, garden
rocks, and exit cherry trees while preserving the existing room root metadata
and clue/action prop metadata.

Deliverables:

- Create `src/game/scene/castleKit.ts` for reusable Babylon builders:
  stone bases, plaster walls, timber beams, tiled roof caps, doorway frames,
  lantern posts, banners, bridges, garden rocks, and cherry trees: first pass
  complete.
- Keep mesh metadata compatible with current room selection and prompt logic:
  first pass complete; kit meshes are added through the existing room prop
  adapter, and interactive clue/action props still own their metadata.
- Introduce shared materials for stone, wood, plaster, roof tile, lantern glow,
  foliage, water, and accent banners: first pass complete.
- Use instancing or shared material reuse where practical to keep draw calls
  controlled: material reuse complete; S9 adds room-level static batching, with
  cross-room thin instances still left for a later pass.

Tests:

- Add focused Vitest coverage for pure layout helpers if the kit introduces
  coordinate or metadata helper functions: complete in
  `tests/castle-kit.test.ts`.
- Keep existing scene Playwright smoke checks nonblank: covered by the scene
  upgrade baseline writer.

Docs:

- Update `docs/visual-direction.md` with the modular kit inventory and material
  palette: complete.

Exit criteria:

- The scene reads as a Japanese castle complex even before each room receives
  bespoke props.

### Iteration S3: Room Identity Pass

Give each gameplay room kind a distinct, readable visual identity.

Status: first pass complete. `src/game/scene/roomIdentity.ts` now owns the
room-kind-to-visual-role mapping, and gameplay rooms use that mapping to add
larger identity silhouettes on top of the reusable S2 kit. The baseline writer
now also captures a split-party full-map state so Shrine, Monster, Treasure,
Exit, and remote-party room divergence are visible in the screenshot set.

Room mapping:

- `entrance` -> gatehouse / front gate
- `hallway` -> main corridor
- `storage` -> armory / storage room
- `shrine` -> main hall / shrine
- `trap` -> secret passage / jail-cell trap room
- `treasure` -> treasury
- `monster` -> haunted barracks / damaged keep
- `exit` -> watch tower / garden gate

Deliverables:

- Move room-kind prop selection behind a dedicated module such as
  `src/game/scene/roomIdentity.ts`: complete.
- Add strong silhouettes and props for every room kind: first pass complete.
- Keep collapsed/unstable state visible without obscuring prompts: preserved
  through existing crack/rubble/danger layers plus the new identity props.
- Keep hidden relics hidden; use objective hints and scene props, not spoilers:
  covered by the identity mapping test and by avoiding relic-specific landmarks.

Tests:

- Add unit coverage for room-kind-to-identity mapping: complete in
  `tests/room-identity.test.ts`.
- Add Playwright screenshot coverage for at least planning and split-party room
  states: complete through `split-party-identities-desktop`.

Docs:

- Update `docs/ui-gameplay.md` and `docs/visual-direction.md` with the room
  identity mapping: complete.

Exit criteria:

- A player can identify the room category from the scene before reading the HUD
  pill.

### Iteration S4: Tactical Camera And Castle Overview

Move planning toward a readable tactical castle overview while preserving
optional close inspection.

Status: first pass complete. `src/game/scene/cameraModes.ts` now owns the
presentation camera mode decision and tactical framing math. Idle planning uses
a raised castle overview that frames the local room, neighbors, selected room,
objective target, and occupied party rooms. Active roam and clue inspection
still use the closer camera paths, and ordinary tactical clicks no longer start
pointer lock. Recent avatar movement now holds the close follow camera briefly
and then eases back to tactical overview over several seconds. The scene now
also exposes convenience camera controls for room flyover, tactical overview,
and avatar follow. The gameplay canvas exposes `data-camera-mode` and
`data-camera-control` so Playwright can assert camera presentation state.

Deliverables:

- Add a camera mode boundary, for example `scene/cameraModes.ts`: complete.
- Support a default isometric/tactical planning camera that frames the current
  room and nearby graph: first pass complete.
- Preserve current close/inspection behavior for clue hotspots: preserved.
- Keep mouse/touch controls predictable and avoid pointer-lock surprises for
  menu-driven play: first pass complete for tactical planning clicks.
- Keep the avatar visible after active movement before returning to overview:
  complete with a follow-hold and slow zoom-out state.
- Add convenience camera controls for flyover, tactical overview, and avatar
  follow: complete.
- Expose a debug or development toggle only if useful for comparing camera
  modes: deferred; the `data-camera-mode` canvas attribute covers automated
  verification for now.

Tests:

- Add Playwright checks that planning controls, minimap, labels, prompts, and
  canvas remain reachable at desktop/mobile viewports: extended by asserting
  tactical camera mode in the existing scene baseline scenarios.
- Keep pointer-look tolerance test until the old roam mode is removed or fully
  demoted: still applicable because roam and inspection modes remain available.
- Add focused unit coverage for camera mode derivation, tactical framing, and
  avatar-follow return timing:
  complete in `tests/camera-modes.test.ts`.
- Add browser coverage that camera controls are reachable and update canvas
  camera-control state: complete in `tests/playwright/relic-hunters/web.spec.ts`.

Docs:

- Update `docs/ui-gameplay.md` with the final camera interaction model:
  complete for the first tactical-overview pass.

Exit criteria:

- Planning is readable without walking the avatar around a dark room, while
  scene interaction can still prime move/search actions: first pass complete.

### Iteration S5: Avatar Readability And Motion

Modernize hunters so they read at the default camera distance.

Status: first pass complete. `src/game/scene/avatarPresentation.ts` now owns
presentation-only avatar state derivation for lobby, idle, moving, arriving,
locked, escaped, and defeated hunters. The Babylon rig uses larger low-poly
helmet, torso, shoulder, weapon, floor-marker, and back-banner shapes so the
hunters read from the S4 tactical camera. The scene applies walk lean, idle
breathing, arrival settle, locked glow, escaped shimmer, and defeated/downed
poses while keeping room membership and live RTC coordinates presentation-only.

Deliverables:

- Simplify avatar geometry into larger, clearer helmet/torso/weapon shapes:
  first pass complete.
- Add one strong character accent color plus restrained material variation:
  first pass complete through larger accent markers, floor marks, and emissive
  role tuning.
- Add basic motion states: idle, walk lean, arrival settle, submitted/locked
  glow, defeated/escaped visibility: first pass complete.
- Keep remote avatar interpolation responsive and room-relative: preserved; the
  presentation state does not override snapshot room ids or RTC offsets.

Tests:

- Keep `scene-networking.test.ts` coverage for room-relative RTC coordinates.
- Add pure helper tests for any avatar state derivation: complete in
  `tests/avatar-presentation.test.ts`.
- Add browser visual smoke for local and remote/split-party avatar visibility if
  fixtures allow it: covered by the split-party scene baseline scenario.

Docs:

- Update `docs/visual-direction.md` with avatar shape language and motion
  states: complete for the first pass.

Exit criteria:

- Hunters are crisp, readable, and responsive without relying on name labels:
  first pass complete, pending future asset/animation polish.

### Iteration S6: Lighting, Materials, And Time-Of-Day Presets

Add a modern lighting art pass without reintroducing blur.

Status: first pass complete. `src/game/scene/lightingPresets.ts` now defines
day, sunset, night, and lantern presets for sky/fog/ambient fill, sun color,
hemispheric fill, shadow darkness, room-light multiplier, and post-process
targets. The opening scene and gameplay scene expose `data-lighting-preset`
for browser baselines. Entrance/lobby/opening use day, interior rooms use
lantern, monster rooms use readable night, and finished/exit presentation uses
sunset. The presets keep fog, vignette, and shadow darkness bounded so the
castle stays readable.

Deliverables:

- Define lighting presets for day, sunset, night, and interior lantern mood:
  complete.
- Use cool sky fill plus warm lantern/key lights: first pass complete through
  preset-driven sun, hemispheric fill, and point-light multipliers.
- Keep contact shadows sharp and avoid heavy global darkness: complete through
  bounded preset values and tests.
- Add a small material palette table for stone, wood, plaster, roof tile,
  metal, paper, foliage, water, and relic glow: complete in
  `docs/visual-direction.md`.
- Consider time-of-day as a visual setting, not a gameplay rule, unless the
  product direction changes: complete; preset selection is presentation-only.

Tests:

- Add render smoke coverage for at least one bright exterior/opening scene and
  one interior gameplay scene: complete through scene baseline assertions for
  `day`, `lantern`, and `sunset`.
- Verify nonblank canvas and visible UI controls after preset transitions:
  complete through the scene baseline Playwright pass.
- Add pure coverage for preset selection and readability bounds: complete in
  `tests/lighting-presets.test.ts`.

Docs:

- Update `docs/visual-direction.md` with lighting presets and material palette:
  complete.

Exit criteria:

- The castle is readable in every room kind and no longer depends on dark fog
  for mood: first pass complete.

### Iteration S7: Asset Pipeline Decision

Decide whether to stay procedural or introduce imported assets.

Status: first pass complete. The active scene stays procedural-first. S7 added
`src/game/scene/assetPipeline.ts`, focused decision tests, canvas-exported
scene metrics, and `docs/asset-pipeline-decision.md`. The scene baseline writer
now records `scene-upgrade-metrics.json` beside the screenshots and asserts the
active asset pipeline remains `procedural`. The old unused lobby GLB auto-loader
path was removed from `rooms.ts`; `public/models/README.md` now documents the
future hybrid conventions instead of implying automatic gameplay loading.

Deliverables:

- Measure draw calls, bundle size, load timing, and frame timing after the kit
  and room identity passes: first pass complete through build output and
  `baseline/screenshots/scene-upgrades/scene-upgrade-metrics.json`.
- Decide between continued procedural geometry, glTF modular assets, generated
  image backdrops, or a hybrid: complete; current decision is procedural-first,
  with a future measured hybrid glTF gate.
- If glTF assets are chosen, define asset folder structure, naming, scale,
  origins, material conventions, and compression approach: documented as a
  future hybrid gate in `docs/asset-pipeline-decision.md` and
  `public/models/README.md`.
- Keep fallback tactical rendering for weak devices or failed WebGL: preserved;
  no imported gameplay asset is required.

Tests:

- Add build-size and browser-load notes to validation docs: complete.
- Keep Playwright scene smoke checks passing with asset loading enabled:
  complete for the active procedural pipeline; imported asset loading remains
  deferred.
- Add pure coverage for the asset decision gate: complete in
  `tests/asset-pipeline.test.ts`.

Docs:

- Update `docs/current-state.md`, `docs/visual-direction.md`, and this plan with
  the asset decision: complete.

Exit criteria:

- There is a clear, tested path for either shipping the procedural style or
  safely adopting real assets: complete.

### Iteration S8: Scene Cost And Active Effects Budget

Reduce avoidable scene work before introducing imported assets or broader
production performance changes.

Status: first pass complete. `src/game/scene/sceneCost.ts` now selects a capped
set of high-priority rooms for active room effects. The gameplay scene keeps
room geometry visible, but only runs room point lights and particle systems in
the current/selected/objective/focus/party-near rooms. Repeated torch particle
systems were reduced from six per room to three per room with lower emitter
rates. Canvas metrics now include active particle-system and active room-light
counts, and the scene baseline writer records those values in
`scene-upgrade-metrics.json`.

Deliverables:

- Add a pure active-effect-room selector for current room, selected room,
  objective/focus room, party rooms, and nearby graph: complete.
- Stop or pause particles and room lights outside the active effect-room set
  while preserving full tactical room visibility: complete.
- Reduce per-room flame emitter count and rates without removing room identity
  props or action prompts: first pass complete.
- Keep S7 metrics alive and extend them with active particle/light counts:
  complete.
- Leave mesh instancing/shared-geometry work as a follow-up because it needs a
  wider pass through the castle kit builders.

Tests:

- Add pure coverage for active effect-room selection and caps: complete in
  `tests/scene-cost.test.ts`.
- Keep Playwright scene baselines and metrics writer passing: complete.

Docs:

- Update `docs/asset-pipeline-decision.md`, `docs/current-state.md`, and this
  plan with the scene-cost first pass: complete.

Exit criteria:

- Full-map scenes have a measured active-effect budget, and imported assets are
  still deferred until the repeated mesh/geometry cost is reduced further.

### Iteration S9: Static Room Mesh Batching

Reduce repeated room mesh and draw-call cost without changing gameplay state,
room ids, or interactive clue meshes.

Status: first pass complete. `src/game/scene/sceneBatching.ts` now owns the
pure static-batching rules. `createRoomProps` keeps newly built room meshes in
local room space, merges fully visible non-interactive meshes by material, then
parents the resulting batches back under the room root. Clue hotspots,
resolved-only markers, action-priming meshes, and partially visible meshes stay
separate so prompt highlighting and inspection behavior remain intact. Canvas
metrics now include static batch count and the number of source meshes folded
into those batches.

Measured result from the baseline writer:

- Planning desktop mesh count dropped from 855 to 352.
- Split-party identities desktop mesh count dropped from 1,666 to 665.
- Resolved timeline desktop mesh count dropped from 855 to 352, but draw calls
  remain higher than ordinary planning because event effects/post-process work
  still dominate that scenario.

Deliverables:

- Add pure batching rules for static room mesh eligibility: complete.
- Batch static room props by material while preserving local room transforms,
  room metadata, and parent room visibility toggles: complete.
- Keep interactive clue/search/resolved/action meshes unbatched: complete.
- Add canvas metrics for static batch count and batched source mesh count:
  complete.
- Refresh browser scene baselines and metrics JSON: complete.

Tests:

- Add pure coverage for batching eligibility and summaries: complete in
  `tests/scene-batching.test.ts`.
- Keep Playwright scene baselines and metrics writer passing: complete.

Docs:

- Update `docs/asset-pipeline-decision.md`, `docs/current-state.md`,
  `docs/scene-contracts.md`, `docs/visual-direction.md`, `docs/ui-gameplay.md`,
  and this plan with the static batching pass: complete.

Exit criteria:

- Full-map scenes have materially fewer room meshes without losing clickable
  room metadata or inspection-highlight behavior.

### Iteration S10: Event Cue Budget And Draw-Call Metrics

Reduce scene effect bursts from command snapshots and make the browser metrics
describe the current rendered frame instead of elapsed scenario work.

Status: first pass complete. `src/game/scene/sceneEventBudget.ts` now selects a
capped set of renderable animation cues from a snapshot burst. All events still
enter the timeline and shared game state; only simultaneous Babylon scene
effects are throttled. `RelicScene` now resets Babylon's private draw-call
counter before each render and exports active effect/effect-mesh counts. The
refreshed baseline showed the previous resolved-timeline draw-call spike was a
cumulative metric artifact: active effects and effect meshes are zero at
capture time, and the corrected resolved timeline steady-frame cost is 392 draw
calls.

Measured result from the baseline writer:

- Planning desktop draw calls: 181 current-frame draw calls.
- Split-party identities desktop draw calls: 803 current-frame draw calls.
- Resolved timeline desktop draw calls: 392 current-frame draw calls, with
  zero active effect meshes at capture time.

Deliverables:

- Add pure scene event-cue budget selection: complete.
- Apply cue budgeting to new scene events without changing timeline/state:
  complete.
- Reset draw-call metrics per rendered frame: complete.
- Add active scene effect and effect mesh metrics to browser baselines:
  complete.
- Inspect cross-room thin instancing viability after S9: complete; deferred to
  S12 because cross-room batching must preserve per-room picking.

Tests:

- Add pure coverage for cue budget priority and limits: complete in
  `tests/scene-event-budget.test.ts`.
- Keep Playwright scene baselines and metrics writer passing: complete.

Docs:

- Update `docs/asset-pipeline-decision.md`, `docs/current-state.md`,
  `docs/scene-contracts.md`, `docs/visual-direction.md`, `docs/ui-gameplay.md`,
  and this plan with the event budget and metric correction: complete.

Exit criteria:

- Resolved timeline metrics no longer overstate draw-call cost because of
  scenario duration, and simultaneous scene effects are budgeted independently
  from authoritative event history.

### Iteration S11: Round Review And Finale Presentation

Make the reveal of simultaneous turns a first-class scene beat that all clients
can watch before the next planning turn.

Status: first pass complete. Shared gameplay rules now publish `phase: review`
after resolving submitted or timed-out plans, and the SPA keeps `RelicScene`
mounted during review while disabling scene planning input. `RelicScene` queues
new event animation cues and focuses each cue room/player in sequence instead of
spawning the entire reveal burst at once. The `heart_relic_victory` finale cue
now creates a larger scene collapse: winners get escape streaks and glow from
their final rooms, while losing or defeated hunters remain in shaken rooms as
the castle falls.

Deliverables:

- Keep the gameplay scene visible during review without allowing move/search
  action priming: complete.
- Queue event cue playback during review so moves, searches, steals, damage,
  relic finds, collapse pressure, and round-result cues can be watched in
  order: first pass complete.
- Focus cue playback around the relevant room or player when an event carries
  animation metadata: first pass complete.
- Add a larger final collapse presentation that distinguishes escaping winners
  from hunters left behind: first pass complete.
- Keep event playback presentation-only; the public snapshot remains the source
  for room membership, scoring, winner ids, escaped state, and defeated state:
  complete.

Tests:

- Add shared-rule coverage for review transitions and finale continuation:
  complete in `packages/tests/relic-hunters/relic-game.test.ts`.
- Add app coverage for review objective/summary and snapshot phase ordering:
  complete in `apps/relic-hunters-v1/tests`.
- Keep typecheck, build, and targeted scene smoke checks passing.

Docs:

- Update `docs/current-state.md`, `docs/ui-gameplay.md`,
  `docs/runtime-data-flow.md`, `docs/scene-contracts.md`,
  `docs/visual-direction.md`, and this plan with the review/finale behavior:
  complete.

Exit criteria:

- A resolved round becomes a shared watched reveal instead of an immediate
  planning jump, and finale presentation clearly separates escaping winners
  from hunters left inside the collapse.

### Iteration S12: Per-Room Picking For Cross-Room Instancing

Prepare cross-room thin instances/shared geometry without regressing room
selection or clue inspection.

Status: planned follow-up from S10/S11. S9's room-level static batches preserve
`roomId` metadata because each batch belongs to one room. Cross-room thin
instances or global material batches would need an explicit per-instance picking
map before repeated kit pieces can be folded across rooms.

Deliverables:

- Define how room ids are recovered from thin-instance or global-batch picks.
- Prototype one low-risk repeated kit family, such as lantern slabs/posts or
  column caps, behind a feature boundary.
- Keep clue hotspots, resolved markers, action prompts, avatars, relics, and
  labels out of cross-room render batches.
- Compare mesh/draw-call metrics against S10 baselines.

Tests:

- Add pure coverage for per-instance room-pick lookup.
- Add browser smoke coverage that clicking or selecting rooms still works after
  any cross-room instance prototype.

Docs:

- Update scene contracts before enabling cross-room instancing in gameplay.

Exit criteria:

- At least one repeated kit family can be shared across rooms without losing
  room selection, prompt, or inspection behavior.

## Validation Checklist Per Iteration

Run the smallest useful set for the touched surface:

```text
npm --workspace relic-hunters-v1 run test
npm --workspace relic-hunters-v1 run typecheck
npm --workspace relic-hunters-v1 run build
npx playwright test tests/playwright/relic-hunters/web.spec.ts --grep "renders a Babylon opening scene|renders a nonblank Babylon scene"
git diff --check
```

Broaden to `npm run test:playwright:relic` when camera, HUD layout, scene
prompting, or visual screenshot coverage changes.

## Input Needed Later

No extra input was needed to complete Iterations S1 through S11 using the
reference board and review/finale direction already provided. Input will help
before a later imported-asset prototype:

- confirm whether the product should eventually use imported 3D assets
- decide how close the art should stay to Japanese castle realism versus
  stylized board-game readability

## Completion Notes

Each completed iteration should update this file with status, changed files,
tests run, known residual risks, and follow-up work. The final conclusion for
the scene upgrade track should summarize resolved visual/gameplay issues and
remaining future work.
