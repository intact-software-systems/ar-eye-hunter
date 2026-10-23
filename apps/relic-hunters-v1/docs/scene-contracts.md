# Scene Contracts

Last reviewed: 2026-10-23.

The active gameplay renderer is `src/game/RelicSceneNext.tsx`. It consumes public
Relic snapshots and uses the procedural facility/camera model in
`src/game/scene/relicSceneNextModel.ts`. `OpeningRelicScene.tsx` renders while the
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
`relicSceneNextModel.ts`. Mesh metadata identifies its room, player, or interaction
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

The gameplay render loop is capped at 45 fps. Current geometry and materials are
procedural. The canvas publishes readiness, camera mode/control, visual theme,
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
