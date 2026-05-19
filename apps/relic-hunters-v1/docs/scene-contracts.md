# Scene Contracts

Last reviewed: 2026-05-18.

This document defines the contracts that scene-upgrade work must preserve while
the Babylon castle moves toward a stylized Japanese castle diorama.

## Snapshot Inputs

The scene receives a public relic snapshot. It must treat these fields as the
authoritative gameplay source:

- `snapshot.roomId`: the Rallar/Relic game room, used for RTC routing.
- `snapshot.phase`: lobby, planning, or finished scene mode.
- `snapshot.map`: room graph, room kinds, room coordinates, collapsed state,
  unstable state, and neighbor links.
- `snapshot.players`: player identity, character, room id, health, escaped,
  defeated, score, and carried relic ids.
- `snapshot.relics`: relic visibility and ownership. Hidden relics must not be
  exposed as scene spoilers.
- `snapshot.roomInvestigations`: discovered clue trails and room search results.
- `snapshot.submittedPlayerIds`: locked-plan avatar state.
- `snapshot.events`: recent event effects and timeline focus.

Scene modules may derive presentation state from these fields, but must not
invent authoritative room movement, relic ownership, or action legality.

## Room Coordinates

- Room world positions are derived through `roomWorldPosition(room)`.
- Procedural kit pieces must align to the existing room center and room grid.
- `src/game/scene/castleKit.ts` builders receive the existing room prop adapter,
  so kit pieces inherit the room root transform and remain room-relative.
- Doorway, corridor, bridge, and path meshes should be visual only unless the
  existing interaction code marks them with supported metadata.
- Any alternate camera or overview mode must still frame the current public
  snapshot, not a separate scene-only map.

## Interactive Metadata

Clickable or pickable Babylon meshes must keep metadata compatible with current
scene interaction:

- `{ roomId: string }` selects a room.
- `{ primeAction: 'search', clueHotspotId?: string }` starts clue inspection or
  primes search.
- `{ playerId: string }` identifies avatar meshes for labels, effects, and
  future interaction.

New metadata shapes should be introduced through typed helpers and covered by
tests before they are used broadly.

The S2 structural kit deliberately does not introduce new interactive metadata.
Room selection still comes from the root room mesh, while clue/search props and
scene prompts keep their existing metadata.

The S3 room identity module is also presentation-only. Identity props may carry
the inherited `{ roomId }` metadata from the room prop adapter, but they must not
submit actions, reveal hidden relics, or replace clue hotspot metadata.

## Player And Avatar Targets

- Local player position comes from the authoritative room plus local
  `roamOffset`; the local avatar should remain visually aligned with camera
  movement.
- Remote player room membership comes from public snapshots.
- Remote live coordinates from RTC are cosmetic only. They may improve visual
  interpolation, but they must not change authoritative room ids or action
  options.
- Remote RTC payloads should stay room-relative so clients with equivalent room
  graphs can resolve positions consistently.
- `src/game/scene/avatarPresentation.ts` owns presentation-only avatar states.
  It may derive lobby, idle, moving, arriving, locked, escaped, and defeated
  presentation from public snapshot status and cosmetic movement deltas, but it
  must not change room membership, action submission, escaped state, or defeated
  state.
- Escaped and defeated visibility is a scene presentation choice. The snapshot
  remains the source of truth for whether those hunters can act, score, or send
  live RTC movement.

## Camera Modes

- `src/game/scene/cameraModes.ts` owns presentation-only camera mode derivation.
  It may read the public snapshot, local player id, active roam/inspection
  state, and event focus room, but it must not create authoritative gameplay
  state.
- Idle planning should use the tactical overview. Active roam and clue
  inspection may keep closer camera behavior, and event focus may frame the
  latest event room outside planning.
- Tactical framing must be derived from public room coordinates: current room,
  neighbors, selected room, objective target, and active party room locations.
- The gameplay canvas publishes `data-camera-mode` for browser baselines and
  debugging. Tests should use it as a render contract, not as gameplay state.

## Lighting Presets

- `src/game/scene/lightingPresets.ts` owns presentation-only lighting preset
  selection and numeric preset values.
- Preset selection may read the public snapshot phase and current room kind,
  but it must not affect movement, action legality, relic visibility, room
  membership, scoring, or server state.
- `day`, `lantern`, `night`, and `sunset` presets should keep exposure, fog,
  vignette, and shadow darkness within readable bounds. Darker mood should come
  from color contrast and local lanterns, not black crush.
- The gameplay and opening canvases publish `data-lighting-preset` for browser
  baselines and debugging. Tests should use it as a render contract only.

## Asset Pipeline

- The active gameplay scene is procedural-first. `src/game/scene/assetPipeline.ts`
  records the current decision and future hybrid gate.
- Imported assets must be optional until a dedicated loader boundary exists.
  A failed asset load must fall back to procedural room, avatar, relic, or
  effect geometry.
- Imported assets must never own authoritative gameplay state. Room ids,
  movement legality, relic visibility, submissions, and scores remain public
  snapshot/shared-rule data.
- Scene baseline tests may read `data-asset-pipeline`, mesh counts, material
  counts, particle counts, draw-call counters, and ready timing as render
  metrics. These metrics are diagnostics, not gameplay state.
- Static room batching is presentation-only. Batched meshes must keep
  `{ roomId: string }` metadata and must not absorb clue hotspots,
  resolved-only markers, action-prime meshes, avatars, relics, or player labels.
- Cross-room thin instances or global static batches need an explicit
  per-instance room-picking contract before replacing room-local batches.

## Scene Cost

- `src/game/scene/sceneCost.ts` owns presentation-only active-effect-room
  selection.
- Full tactical room geometry may remain visible, but room point lights and
  particle systems should run only in the capped active effect-room set unless a
  future rule explicitly broadens that budget.
- Active-effect selection may read public snapshot phase, local room, selected
  room, objective/focus room, active party room positions, and graph neighbors,
  but it must not affect action legality or authoritative room visibility.
- Baseline metrics should distinguish total particle systems from active
  particle systems and active room lights.
- Baseline metrics should also expose static batch count and batched source mesh
  count so future asset or instancing work can be compared against the S9 room
  batching baseline.

## Event Effects

- `src/game/scene/sceneEventBudget.ts` owns presentation-only animation cue
  budgeting for scene effects.
- Event cue budgeting must not hide, drop, or reorder authoritative
  `snapshot.events`; it only limits how many Babylon effects are spawned from a
  burst of new events.
- Browser baselines expose active effect and effect mesh counts. Draw-call
  counters are reset per rendered frame before being written to canvas metrics.

## Prompt Contract

- Scene prompts can prime `move`, `search`, or `escape` actions.
- The side action panel remains the source of truth for committed turn plans.
- Scene prompts must not submit actions directly.
- Prompt text and buttons must stay reachable with the HUD at desktop and mobile
  viewports.

## Visual Baseline Tolerances

Scene-upgrade tests should guard these minimums:

- The opening and gameplay canvases render nonblank.
- High-DPI contexts render at native/high-DPI drawing buffer size, not a
  deliberately downscaled canvas.
- Gameplay rooms are not crushed into black; sampled pixels should show visible
  luma in multiple screen regions.
- Core HUD controls remain visible and reachable over the scene.
- Large player labels, prompts, minimap, and bottom HUD must not overlap in a
  way that blocks planning.

## Current Baseline Screenshots

Iteration S1 captures scene-upgrade baselines under
`baseline/screenshots/scene-upgrades/` when Playwright is run with
`RELIC_SCENE_BASELINE_WRITE=1`.

Current scene-upgrade screenshots:

- `opening-desktop.png`
- `lobby-desktop.png`
- `planning-desktop.png`
- `planning-mobile.png`
- `waiting-locked-desktop.png`
- `split-party-identities-desktop.png`
- `resolved-timeline-desktop.png`
- `finished-desktop.png`

Current scene-upgrade metric artifact:

- `scene-upgrade-metrics.json`

Validation command:

```text
RELIC_SCENE_BASELINE_WRITE=1 npx playwright test tests/playwright/relic-hunters/web.spec.ts --grep "scene upgrade baselines"
```
