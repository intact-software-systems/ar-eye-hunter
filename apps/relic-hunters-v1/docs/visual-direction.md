# Visual Direction

Last reviewed: 2026-05-16.

## Targets

- Rooms: readable room type at a glance, with clear floor silhouettes and
  restrained atmospheric effects. Current room state remains mirrored in the
  HUD strip for accessibility.
- Exits: green route/escape language in both scene and objective panel. Exit
  markers should read as safe and directional, not as another relic hotspot.
- Relics: warm gold/cyan highlights, visible only when found or when an event
  reveal calls attention to them. Hidden relics should be implied by objectives,
  not displayed as spoilers.
- Players: name labels only in the normal scene. Health, relic count, score,
  and role details live in the HUD where they are easier to scan.
- Danger: red/orange vignette and room-state pills for unstable, trap, monster,
  and collapse pressure. Danger effects should not obscure movement prompts.
- Current objective: one primary objective panel plus one optional scene prompt.
  The action panel remains the source of truth for committed turn plans.

## Current Babylon Baseline

- Opening, auth, and lobby surfaces use a lightweight Babylon ambient scene.
- Planning and finished phases mount the full gameplay Babylon scene.
- The render loop is capped at 30 fps.
- Hardware scaling is set to `1.25` for performance headroom.
- `preserveDrawingBuffer` is disabled. The canvas exposes
  `data-scene-ready="true"` after Babylon renders a frame so browser checks do
  not depend on retained WebGL back buffers.
- Bloom, SSAO, shadows, and grain are intentionally modest. The scene should
  read as crisp before adding heavier mood effects.
- Player labels default to names-only. Detail labels can be reintroduced as an
  explicit debug/development mode if needed.

## Asset Plan

Use procedural geometry until the gameplay loop is stable. When replacing it
with real assets, add them in this order:

1. Room kit: reusable wall, floor, doorway, and stair pieces with consistent
   dimensions matching the existing room grid.
2. Readability props: distinct silhouettes for storage, shrine, trap, treasure,
   monster, and exit rooms.
3. Player avatars: one low-poly shared rig with material/color variants before
   bespoke character models.
4. Relic set: small inspectable objects with consistent highlight materials.
5. Danger set: collapse rubble, trap plates, monster traces, and exit light
   markers.

Asset requirements:

- Low draw-call budget and reusable materials.
- Clear silhouettes at the default camera distance.
- No baked text in textures; all player-facing text stays in UI.
- Stable origin/pivot conventions so room sync remains data-driven.
