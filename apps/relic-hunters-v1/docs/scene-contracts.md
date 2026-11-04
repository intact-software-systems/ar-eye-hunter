# Scene Contracts

Last reviewed: 2026-10-23.

The active gameplay renderer is `src/game/relic-scene.tsx`. It consumes public
Relic snapshots and uses the procedural facility/camera model in
`src/game/scene/relic-scene-model.ts`. `opening-relic-scene.tsx` renders while the
app has no game snapshot. Historical castle scene baselines are not evidence for
the current renderer.

## Authority and input

The public snapshot owns the game room, phase, room graph, player identity and
room, health, escaped/defeated state, submitted players, relic visibility,
investigations, events, and scores. Presentation may derive targets and effects
from these fields; it cannot create game authority or expose hidden relics.

`src/app.tsx` supplies the current snapshot, local session/player identity,
selected/primed room action, focus room, RTC readiness, and input permissions.
The scene sends selection, draft priming, pickup, and review-complete callbacks
to the existing turn/runtime owners. Only those command paths can change game
state. Review disables planning; presentation timing does not delay snapshot
acceptance or reorder authoritative events.

## Coordinates and interaction

Facility positions and camera poses are derived from the public map in
`relic-scene-model.ts`. Mesh metadata identifies its room, player, or interaction
target. Room selection uses the existing `scene/movement.ts` legality bridge to
prime a legal adjacent move. Interactive meshes must remain separate from any
future static batching that would lose their target identity.

Camera controls select Avatar, Visor/first-person, Overview, or Flyover. Saved
camera preference is local presentation state. Camera placement and cosmetic
roaming cannot change the snapshot room, legal targets, or submitted action.
The normal draft panel remains available for inspecting and submitting the plan.

## Cosmetic motion

`scene/networking.ts` owns room-scoped RTC avatar motion. Payloads carry the full
application/workspace/game-room reference and a separate dungeon-room identity.
Receivers reject wrong scope, wrong player room, and stale samples. Live positions
remain room-relative and presentation-only; the authoritative snapshot wins when
a hunter changes rooms. Rallar Motion interpolation cannot authorize movement.

## Review and HUD playback

The scene owns its animation queue and review-complete notification. The HUD's
separate ordered reveal state lives in `use-relic-playback.ts`. Both consume the
accepted event history. They must not remove events, invent results, or submit a
second action. `use-relic-turn.ts` controls continuation through the normal runtime
command path and suppresses duplicate continuations for the same review.

## Rendering and diagnostics

The live gameplay render loop is capped at 45 fps. Only an authoritative non-null
native tournament with status `finished` or `cancelled` switches to a static,
shader-ready image. Casual finished games and active spectators keep rendering.
Terminal polls with unchanged scene content do not draw. Changed terminal content,
camera controls and resize request a fresh ready image, then stop again. Room
changes and nonterminal state resume the same owned loop when the scene remains
mounted. Input, pointer capture, motion history and frame timing reset at that
transition; room, bracket and React subscriptions stay live.

`scene/start-capped-render-loop.ts` is the single Babylon driver adapter for both
gameplay and the opening scene. The framework-independent mechanism lives in
`packages/shared/resilience/timing/capped-frame-loop.ts`; it never imports Babylon
or React. `read-relic-frame-readiness.ts` checks the active visible mesh materials,
applicable glow passes/composition, camera and pending data before and after drawing.
The active mesh set must match across that draw before the loop accepts the image;
disabled or off-camera shader variants do not contribute to it. No readiness
callback can later restart an idle or disposed scene. `sync-relic-avatar-presentation.ts`
reconciles body/label and visor visibility before both live and terminal draws.

The camera preference storage key and existing canvas diagnostic/style identities
remain their established consumer contracts; their spelling does not name a
second renderer. No fallback, migration, compatibility alias or parallel scene
implementation is retained.

## Ownership and navigation

| Question                                                                 | Direct owner                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| React presentation and current callback bindings                         | `src/game/relic-scene.tsx`, `scene/neon/use-relic-scene.ts`           |
| Graphics construction, accepted snapshot synchronization and live motion | `scene/neon/relic-scene-runtime.ts`                                   |
| Native terminal decision and content equality                            | `scene/neon/compute-relic-terminal-presentation-key.ts`               |
| Loop mode, redraw, resize and complete disposal                          | `scene/neon/relic-scene-lifecycle.ts`                                 |
| Browser keys, pointer capture and Babylon picking                        | `scene/neon/relic-scene-input.ts`                                     |
| Facility, avatar and relic mesh ownership                                | `scene/neon/relic-facility.ts`, `relic-avatars.ts`, `relic-relics.ts` |
| Review playback and transient effects                                    | `scene/neon/relic-review.ts`                                          |
| Camera mode and framing                                                  | `scene/neon/relic-camera.ts`, `scene/relic-scene-model.ts`            |
| Materials, text textures and render diagnostics                          | `scene/neon/relic-materials.ts`, `relic-scene-diagnostics.ts`         |

Start at `App` → `RelicGameScene` → `RelicScene` → `useRelicScene`. A completed
runtime is constructed before the render callback; the loop and input owner are
constructed before listeners register. Snapshot effects call
`RelicSceneLifecycle.update` directly; shader-ready frames go through the shared
loop's existing driver registration. Unmount stops the loop, removes input and
resize registrations, clears diagnostics, then disposes scene and engine. Failed
partial startup follows that same owned cleanup.

Current geometry and materials are
procedural. The canvas publishes an every-render counter and current-image readiness,
separate from its last ready timestamp. Pending mesh, glow mesh/composition, camera
and data categories remain observable on every draw. It also publishes camera mode/control, visual theme,
lighting, mesh/material/effect counts, review state, nearby relic, and Rallar
Motion diagnostics. These are rendering observations, never gameplay authority.
The current renderer reports `next`, `neon-dystopian`, and `procedural` identities.
Tests should observe the rendered state and reachable controls without binding
unrelated gameplay behavior to private helper names or mesh construction order.

## Browser acceptance

A renderer change needs nonblank opening/gameplay canvases, readable rooms and
avatars, reachable planning/camera controls, and usable desktop/mobile layouts.
Room-entry tests additionally prove actual expedition participation and return,
not merely a successful HTTP admission. Capture fresh screenshots when changing
the presentation; a historical screenshot or metric is not a current measurement.

```sh
npm run test:playwright:relic
npm run test:playwright:relic:full-stack
```

See [visual-direction.md](visual-direction.md) for presentation goals and
[runtime-data-flow.md](runtime-data-flow.md) for transport/authority ownership.
