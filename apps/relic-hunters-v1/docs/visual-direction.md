# Visual Direction

Last reviewed: 2026-10-23.

## Current presentation

The active gameplay scene is the procedural neon facility in
`src/game/RelicSceneNext.tsx`. Its palette is `scene/neonTheme.ts`; facility
positions, room callsigns, signage, and camera planning are in
`scene/relicSceneNextModel.ts`. The opening scene remains a lightweight ambient
backdrop while no expedition snapshot is available.

The former castle renderer and its exclusive avatar/camera/effect selectors have
been removed. Older castle kit and baseline records describe that earlier work;
they do not define the active facility renderer or its current performance.

## Readability goals

- Rooms and their connections should read at a glance. Keep the current room,
  hazard, and objective available in the HUD as well as the scene.
- Exits use clear route/escape language. Relics use distinct highlights and only
  appear when the public snapshot permits them.
- Hunter identity, position, and state should remain legible in Avatar, Visor,
  Overview, and Flyover views. Health, score, and detailed loadout belong in the
  HUD where they can be inspected without obscuring the playfield.
- Danger should be visible without covering movement prompts, draft controls,
  room-entry errors, or help. Review effects must preserve the order and meaning
  of the shared event history.
- Preserve a usable side-panel scroll region on desktop and page scrolling on
  mobile. Private-room controls must remain reachable before and after login.

## Ownership boundaries

Camera preference, cosmetic movement, lighting, materials, and effects are
presentation. The snapshot owns room identity, action legality, relic visibility,
submissions, escaped/defeated status, and scores. RTC positions can smooth an
avatar but cannot override a conflicting snapshot room.

The app composes HUD capabilities rather than placing their state in the root
component. Turn drafting, HUD playback, preferences, and authenticated runtime
lifecycle have separate owners. AI suggestions can prime the existing draft only
after validation; their appearance does not grant authority to submit a plan.

## Visual validation

Use fresh desktop and mobile browser captures for a presentation change. Check
nonblank canvases, room/avatar contrast, camera controls, draft submission,
review, and final scoring. Canvas diagnostics expose render and motion facts;
measure the current workload before making performance claims or adding assets.
The gameplay loop is capped at 45 fps, but that cap is not evidence of achieved
frame rate on any device.

Procedural geometry is the current runtime path. Any future asset loader needs
an explicit loading/failure owner, source/license and size information, and
measured scene impact before becoming a gameplay dependency. Historical asset
experiments live in [asset-pipeline-decision.md](asset-pipeline-decision.md).
Current interaction boundaries live in [scene-contracts.md](scene-contracts.md).
