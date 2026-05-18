# UI And Gameplay

Last reviewed: 2026-05-18.

## Player Flow

The intended playable loop is:

1. Sign in or register.
2. Create or join a Relic Hunters room.
3. Pick a character and join the expedition.
4. The Keeper/admin starts the expedition from the lobby after connected room
   members have joined the expedition.
5. Each active hunter chooses one plan for the round.
6. The server resolves all submitted plans together.
7. Hunters collect relics, reach the Exit, escape, and compare score when the
   expedition ends.

## Current Screens And Regions

- Signed-out users land directly on the auth form in the side panel. The intro
  scene exists in code but is disabled during playable-loop stabilization.
- Auth and lobby screens use a lightweight Babylon ambient scene. The full
  gameplay scene is mounted only for playable expedition phases.
- First-time onboarding is disabled during stabilization so the first playable
  action is not hidden behind a modal.
- Authenticated users see rooms, current expedition state, party/lobby controls,
  or planning controls depending on snapshot phase.
- The lobby separates room presence from expedition readiness: online room
  members are counted separately from joined expedition hunters, and the Keeper
  is labelled in the joined roster.
- `GameHudLayout` gives the SPA stable regions:
  - top: connection, room, round, score, progress, and language/status controls
  - side: auth, room actions, lobby controls, or round planning
  - bottom: hunter readiness, current-turn summary, and grouped turn timeline
  - floating: scene prompts, minimap, and action nudges
  - overlay: onboarding, help, brief non-interactive tension beat, and end-state
    panels
- Signed-in side menus have a sticky section jump bar for Rooms, Party/Plan,
  Map, and Intel. Extra-wide desktop screens use the available width for a
  wider, two-column menu stack, and the bottom HUD is kept out of the right
  column so the side menu gets the full available height. The desktop side menu
  owns its own scroll range, and mobile lets the page scroll through the whole
  side menu instead of clipping it.
- The Babylon scene provides first-person roaming, room selection, local prompts,
  player/relic meshes, fallback tactical rendering, and touch movement controls.
- The intro cinematic canvas is non-interactive so it cannot intercept clicks if
  the cinematic is re-enabled. Tutorial overlays must follow the same rule or be
  opened only on explicit request.

## Controls

- Primary planning controls are in the round plan panel.
- Primary executable buttons use direct verbs such as `Join as`, `Start`, and
  `Submit Plan`; themed copy should stay in supporting text.
- After a plan is locked, the locked-plan card remains visible and the action
  picker can still be used for inspection, but submission stays disabled.
- Number keys select actions, arrow-style target shortcuts select move targets,
  and Enter submits when the draft is legal.
- Scene clicks can prime room movement or search actions, but the visible action
  panel is intended to remain the authoritative planning surface.
- Holding forward in the scene exposes the currently faced legal move prompt
  immediately and keeps it briefly after key-up so a player can prime the move
  without walking to the far edge of a large room.
- Touch D-pad controls are contained inside the scene layer.

## Gameplay State Shown To Players

The view model currently exposes:

- local player and room
- legal move targets
- legal steal targets
- action legality and blockers
- submitted/locked state
- active/submitted/waiting player counts
- current objective text
- low-health, round-limit, search-danger, and noise warnings
- relic and escape progress

Turn results now converge in the bottom HUD. The current-turn summary explains
whether the local player should choose a plan, is waiting with a locked plan, is
watching, or has finished. The timeline is grouped by round and labels entries
as Reveal, Your Action, Party Action, Castle Reaction, or Result.

Gameplay rule state now avoids a relic in the starting room, so the first
meaningful route is outward from Entrance. When multiple adjacent rooms contain
hidden relics, route hints prefer the higher-value relic lead instead of map
array order. Relic discoveries now create durable room investigations
immediately, so clue trails and room objectives can update after the first find.

## Current UX Gaps

- A first-time player can still be pulled between several surfaces: scene
  prompts, the side action panel, the minimap, room intel, and help/onboarding
  overlays. Large-screen menu navigation now has sticky jump controls, but the
  underlying number of surfaces is still high.
- `App.tsx` remains large enough that small UI changes can accidentally affect
  gameplay timing, audio, or event reveal behavior.
- Planning state is covered by a mocked single-client Playwright loop from room
  creation through first-turn resolution. Iteration 12 adds a gated full-stack
  two-browser Playwright path for submit/wait/resolve propagation, reset/rejoin,
  and reload recovery. It is skipped by default, and the real
  `RELIC_HUNTERS_FULL_STACK=1` paired-server run now passes locally.
- Accepted public snapshots are now also shared over RTC as a repair path, so a
  browser that misses a WS update can catch up from a peer before the two scenes
  drift indefinitely.
- Stale or disconnected joined players still remain in the active expedition
  after start. The player-facing policy is now timer-based: reset rebuilds the
  roster, while continuing keeps those hunters; after the round timer expires,
  any active hunter can resolve the round and skip missing plans. If another
  browser misses the push update for that timeout resolution, it now repairs from
  the authoritative room snapshot after the deadline instead of staying on the
  stale timed-out controls.

## Visual State

- The scene uses procedural castle rooms, props, player avatars, labels, relic
  meshes, particles, shadows, fog, bloom, glow, SSAO, vignette, and grain.
- During the current cleanup pass, the scene uses lighter shadows/SSAO and a
  capped render loop. Preserve-drawing-buffer is disabled; smoke checks use the
  canvas `data-scene-ready` signal emitted after Babylon renders.
- Player labels are names-only in normal play. Health, relic counts, score, and
  character details stay in HUD panels.
- Remote player avatars fall back to authoritative snapshot room positions, then
  interpolate toward live RTC position updates when another browser has an open
  reliable RTC lane. Live updates are resolved from the sender's room-relative
  offset so the visible avatar uses the receiver's current scene layout.
- Room membership, player room ids, submissions, events, relic ownership, and
  investigations still come from public snapshots; RTC avatar coordinates do not
  override game state.
- Iteration 14 should finish the baseline visual coverage that started in
  Iterations 7, 8, and 11: rooms, exits, players, relics, danger, current
  objective, prompts, minimap, and bottom HUD should be immediately legible at
  the captured desktop and mobile viewports.
- Player-facing labels and debug/development-only labels should be separated so
  the scene can stay clean in normal play.
