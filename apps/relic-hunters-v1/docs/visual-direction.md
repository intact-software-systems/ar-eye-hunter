# Visual Direction

Last reviewed: 2026-05-18.

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
- The full gameplay render loop is capped at 45 fps. The opening scene is
  capped at 30 fps.
- The Babylon engine now uses high-DPI/native canvas scaling capped at 2x device
  ratio instead of deliberately downscaling the canvas. This is the primary
  crispness path for room and avatar edges.
- `preserveDrawingBuffer` is disabled. The canvas exposes
  `data-scene-ready="true"` after Babylon renders a frame so browser checks do
  not depend on retained WebGL back buffers.
- Bloom, SSAO, glow, fog, vignette, and grain are intentionally modest. Depth of
  field is disabled for now. The scene should read as crisp before adding
  heavier mood effects.
- The latest readability adjustment raises ambient/key light, exposure, and
  environment intensity while keeping fog and vignette light enough that rooms
  stay visible.
- Avatar roam speed, remote RTC broadcast cadence, and interpolation have been
  increased so hunters feel more responsive in the scene.
- Planning now defaults to a tactical castle overview derived by
  `src/game/scene/cameraModes.ts`. The camera frames the local room, nearby
  graph, selected/objective rooms, and occupied party rooms before falling back
  to close roam or inspection modes when the player actively uses them.
- The gameplay canvas exposes `data-camera-mode` for browser baselines; current
  planning baselines are expected to render in `tactical` mode.
- Player labels default to names-only. Detail labels can be reintroduced as an
  explicit debug/development mode if needed.
- Scene upgrade baselines now cover opening, lobby, planning desktop, planning
  mobile, waiting/locked, resolved timeline, and finished desktop states in
  `baseline/screenshots/scene-upgrades/`.
- Gameplay room shells now go through `src/game/scene/castleKit.ts` for their
  Japanese castle base pieces instead of embedding all wall, roof, column, and
  lantern geometry directly in `rooms.ts`.
- Room-kind identity is now data-driven by `src/game/scene/roomIdentity.ts`.
  The gameplay scene adds larger silhouettes for every room kind before the
  smaller room props and clue hotspots are layered on.
- Avatar presentation is now data-driven by
  `src/game/scene/avatarPresentation.ts`. Hunter meshes use larger low-poly
  body, shoulder, helmet, weapon, back-banner, and floor-marker shapes for
  tactical camera readability. Presentation states cover idle breathing, walk
  lean, arrival settle, submitted/locked glow, escaped shimmer, and
  defeated/downed poses without changing authoritative room state.
- Lighting is now preset-driven by `src/game/scene/lightingPresets.ts`.
  Opening/lobby/Entrance use `day`, interior rooms use `lantern`, Monster uses
  readable `night`, and finished/Exit presentation uses `sunset`. The canvas
  exposes `data-lighting-preset` for browser baselines.

## Modular Kit Inventory

The S2 kit is code-native Babylon geometry. It currently includes:

- Structural pieces: stone base slabs, plaster wall segments, timber wall rails,
  dark roof-tile ceiling/eaves, doorway posts/lintels, and lacquer columns.
- Exterior/castle motifs: torii gates, banners, stone lantern posts, garden
  rocks, cherry trees, and a bridge builder reserved for corridor/overview work.
- Shared material roles: stone, plaster, wood, roof tile, lacquer, metal, gold,
  shoji paper, foliage, water, lantern glow, blue/coral banners, cracks, rubble,
  and portal light.
- A pure wall-segment planner that keeps doorway splits deterministic and
  covered by Vitest before mesh construction.

## Lighting Presets And Material Palette

S6 keeps time of day as presentation, not gameplay. The current preset mapping
is:

- `day`: opening, lobby, and Entrance. Bright cool sky fill, warm sun, low fog,
  reduced bloom, and light vignette.
- `lantern`: Hallway, Storage, Shrine, Trap, and Treasure. Cool ambient fill
  plus warmer local lantern/key lights, modest bloom, and bounded vignette.
- `night`: Monster. Cooler blue fill and stronger lantern multiplier while
  keeping exposure high enough that the room is not crushed into black.
- `sunset`: Exit and finished presentation. Warm side light, cool sky fill, and
  slightly stronger route/escape glow.

Material palette:

- Stone: cool grey foundation and rubble, rough and non-glossy.
- Plaster: warm off-white wall fields so rooms read brighter.
- Wood/lacquer: dark timber plus restrained red lacquer on rails, posts, gates,
  and important trim.
- Roof tile: dark blue-grey surfaces that provide the Japanese castle roof
  silhouette without darkening the whole scene.
- Metal: cool iron with fine normal texture and controlled reflectivity.
- Gold/relic glow: warm gold with sharper clear coat; relics and treasure
  highlights carry the brightest warm values.
- Shoji/lanterns: warm paper glow for readable interior points of interest.
- Foliage/water: reserved accent materials for garden/overview scenes and exit
  room readability.

## Room Identity Mapping

The S3 identity pass maps each gameplay room to one strong castle role:

- `entrance`: gatehouse / front gate, with a roofed gate and portcullis bars.
- `hallway`: main corridor, with a long runner, guide rails, and repeated
  lanterns.
- `storage`: armory / storage room, with crate towers, shelves, and weapon
  racks.
- `shrine`: main hall / shrine, with a raised altar, shoji screen, torii, and
  glowing ring.
- `trap`: secret passage / jail-cell trap room, with cell bars, warning grid,
  and spikes.
- `treasure`: treasury, with a vault ring, central plinth, and coin stacks.
- `monster`: haunted barracks / damaged keep, with broken beams, claw marks,
  rubble, and torn banners.
- `exit`: watch tower / garden gate, with stepping stones, cherry trees, and an
  escape beacon.

Identity props are visual only. They do not reveal hidden relics or replace
the action panel, room objective, or minimap as gameplay sources of truth.

## Avatar Shape Language

The S5 avatar pass keeps hunters procedural but pushes them toward board-game
readability:

- Silhouette: large torso wedge, broad shoulder boards, oversized helmet crest,
  clear weapon/tool silhouette, and a small floor marker in the character
  accent color.
- Materials: dark primary cloth/armor, restrained secondary armor color, one
  strong accent color, and a low-gloss blade/tool material.
- Motion: active hunters lean and bob while moving, settle briefly on arrival,
  breathe subtly while idle, glow blue when locked, shimmer green after escape,
  and appear downed/dimmed when defeated.
- Data contract: avatar presentation may read public snapshot status and
  cosmetic movement deltas, but room membership, submissions, escaped state, and
  defeated state remain authoritative snapshot data.

## Modernization Direction

The fastest visual upgrade is not more post-processing; it is stronger shape
language and cleaner materials.

The detailed sequence for this work lives in
[`../implementation-plan-for-scene-upgrades.md`](../implementation-plan-for-scene-upgrades.md).
Scene data and interaction contracts live in
[`scene-contracts.md`](scene-contracts.md).

1. Treat the scene as a stylized tactical diorama rather than a soft cinematic
   ruin. Keep the camera readable, reduce atmospheric haze, and let room
   silhouettes carry the mood.
2. Replace the current procedural room shells with a small modular kit: floor
   slabs, wall chunks, doorway frames, stairs, torii/gate pieces, columns, and
   rubble. Reusing a kit will look more intentional than many one-off props.
3. Give every room kind one clear silhouette: shrine arch, trap pressure plate,
   treasure plinth, monster claw marks, storage crates, exit light column. This
   helps players read the scene before reading UI text.
4. Move avatars toward a modern low-poly rig: fewer tiny attached parts, larger
   readable helmet/torso/weapon shapes, stronger edge highlights, and one color
   accent per character. The current avatars have enough pieces, but many are
   too small to read at the default camera distance.
5. Use lighting contrast instead of blur for drama: one warm key light per room,
   cool ambient fill, sharp contact shadows, and restrained emissive highlights
   for interactive objects.
6. Add short motion states for player movement: lean while walking, a small
   arrival settle, and a distinct idle pose. This will make remote avatars feel
   alive even before bespoke character animation.
7. Keep UI and scene palettes related but not identical. The scene should use
   darker stone/wood/metal neutrals with bright accents only for players,
   objectives, relics, and exits.

## Asset Plan

S7 keeps the active gameplay scene procedural-first. The measured full-map
baseline is already expensive enough that imported assets should not become a
hidden dependency until a hybrid loader, procedural fallback, and performance
budget exist. The decision and current metrics live in
[`asset-pipeline-decision.md`](asset-pipeline-decision.md).

S8 adds the first active-effects budget: rooms still render in the tactical
overview, but point lights and particles run only for a capped set of current,
selected, objective, focus, and party-near rooms. Per-room flame emitters were
also reduced so atmosphere supports readability instead of driving scene cost.

S9 adds room-level static batching: fully visible non-interactive room meshes
are merged by material after construction, while clue hotspots, resolved
markers, and action meshes stay separate for highlighting. This keeps the
procedural castle readable while lowering the mesh pressure measured in the
scene baselines.

S10 adds an event-cue budget so command snapshots do not spawn every scene
effect at once. The timeline still shows all events, but the Babylon scene picks
the strongest cue for a burst. The draw-call baseline now resets the counter per
rendered frame, so long reveal waits are comparable to ordinary planning views.

Refine procedural geometry in this order:

1. Room kit: reusable wall, floor, doorway, and stair pieces with consistent
   dimensions matching the existing room grid.
2. Readability props: distinct silhouettes for storage, shrine, trap, treasure,
   monster, and exit rooms.
3. Player avatars: one low-poly shared rig with material/color variants before
   bespoke character models.
4. Relic set: small inspectable objects with consistent highlight materials.
5. Danger set: collapse rubble, trap plates, monster traces, and exit light
   markers.

Future imported asset requirements:

- Use `public/models/rooms/`, `public/models/avatars/`, `public/models/relics/`,
  and `public/models/effects/` only after the hybrid gate opens.
- Keep every imported asset non-authoritative and replaceable by a procedural
  fallback.
- Define source/license, scale, origin, material mapping, and size budget before
  loading it in gameplay.
- Keep draw-call budget, active mesh count, and particle count measurable in the
  scene baseline metrics.
- Preserve clear silhouettes at the default tactical camera distance.
- No baked text in textures; all player-facing text stays in UI.
- Stable origin/pivot conventions so room sync remains data-driven.
