# UI And Gameplay

Last reviewed: 2026-05-19.

## Player Flow

The intended playable loop is:

1. Sign in or register.
2. Create or join a Relic Hunters room.
3. Pick a character and join the expedition.
4. The Keeper/admin starts the expedition from the lobby after connected room
   members have joined the expedition.
5. Each active hunter chooses one plan for the round.
6. The server resolves all submitted plans together.
7. The app enters a review phase where every client watches the revealed moves,
   searches, steals, ruin reactions, and other round effects before anyone plans
   the next turn.
8. A player continues the review to the next planning turn, or to the finale if
   the expedition is over.
9. Hunters collect relics, reach the Exit, escape, and compare score when the
   expedition ends.

## Current Screens And Regions

- Signed-out users land directly on the auth form in the side panel. The intro
  scene exists in code but is disabled during playable-loop stabilization.
- Auth and lobby screens use a lightweight Babylon ambient scene. The full
  gameplay scene is mounted for planning, review, and finished expedition
  phases.
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
- The Babylon scene now defaults planning to a tactical castle overview, then
  provides optional close roaming, clue inspection, room selection, local
  prompts, player/relic meshes, fallback tactical rendering, and touch movement
  controls.
- Scene camera controls offer `Fly over rooms`, `Tactical overview`, and
  `Avatar`. Flyover is temporary and returns to the previous camera choice;
  Tactical and Avatar remain selected until another camera button is chosen.
- After avatar movement input stops, the scene holds the close follow camera
  briefly and then slowly returns to the tactical overview while keeping the
  local hunter in view.
- The intro cinematic canvas is non-interactive so it cannot intercept clicks if
  the cinematic is re-enabled. Tutorial overlays must follow the same rule or be
  opened only on explicit request.

## Controls

- Primary planning controls are in the round plan panel.
- Primary executable buttons use direct verbs such as `Join as`, `Start`, and
  `Submit Plan`; themed copy should stay in supporting text.
- After a plan is locked, the locked-plan card remains visible and the action
  picker can still be used for inspection, but submission stays disabled.
- During review, planning input is disabled and a round review panel replaces
  the plan submission controls. The scene remains visible so each browser can
  play the same reveal cues before a player continues to the next turn or
  finale.
- Number keys select actions, arrow-style target shortcuts select move targets,
  and Enter submits when the draft is legal.
- Scene clicks on a legal adjacent room prime a move draft for that room.
  Search hotspots can still prime search actions, and the visible action panel
  remains the authoritative planning surface.
- Ordinary tactical planning clicks do not start pointer lock. Pointer-look
  behavior is reserved for active roam and clue-inspection camera modes so menu
  navigation stays predictable.
- Holding forward in the scene exposes the currently faced legal move prompt
  immediately and keeps it briefly after key-up so a player can prime the move
  without walking to the far edge of a large room.
- Releasing movement keys does not immediately snap the camera back to the
  overview; the avatar remains the focus before the gradual zoom-out starts.
- The Avatar camera button keeps the close follow camera active for walking
  around. The Tactical overview button prioritizes nearby-room visibility while
  keeping the local hunter in frame.
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
watching a review, or has finished. The timeline is grouped by round and labels
entries as Reveal, Your Action, Party Action, Castle Reaction, or Result.

The review phase is part of shared game state, not only a client animation. A
resolved round stays at the same round number with `phase: review`,
`pendingActions: []`, and the full resolved event list. The next round starts
only after `continue-review`; if the review belongs to the final round or all
active hunters are escaped/defeated, `continue-review` moves the expedition to
`finished`.

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
- The latest scene tuning prioritizes crispness over cinematic softness:
  high-DPI/native canvas scaling, reduced fog/bloom/glow/grain/vignette, no
  depth of field, sharper shadows, and faster avatar roaming/interpolation.
- The S4 scene upgrade pass adds a camera-mode boundary in
  `src/game/scene/cameraModes.ts`. Idle planning uses a raised tactical view
  that frames the relevant castle rooms; close roam and inspection remain
  available as active modes.
- The S5 scene upgrade pass adds `src/game/scene/avatarPresentation.ts` for
  presentation-only avatar states. Active hunters are larger and easier to read
  from tactical view, submitted hunters use a locked glow, escaped hunters use a
  faint exit shimmer, and defeated hunters stay visibly downed instead of
  disappearing from the room scene.
- The S6 scene upgrade pass adds `src/game/scene/lightingPresets.ts` for
  presentation-only day, lantern, night, and sunset moods. These presets change
  scene readability and atmosphere only; gameplay state and action legality
  still come from public snapshots and the view model.
- The S7 scene upgrade pass keeps active gameplay procedural-first. Imported
  GLB assets are deferred until a measured hybrid boundary exists with
  procedural fallbacks, so missing assets cannot block the playable loop.
- The S8 scene-cost pass keeps the full tactical castle visible but runs room
  lights and particle effects only around the highest-priority rooms. This is a
  performance/readability budget and does not change room state or legal moves.
- The S9 static batching pass merges non-interactive room decoration by
  material. Room selection, clue inspection, resolved markers, action prompts,
  and legal move state remain separate from those render batches.
- The S10 event-cue budget limits simultaneous Babylon scene effects from a
  burst of new timeline events. The review phase then queues reveal cues
  sequentially so player moves and castle reactions can be watched instead of
  being visually flattened into one instant. It does not hide events from the
  timeline or change action resolution.
- The finale presentation now treats the final `game_finished` cue as a bigger
  scene beat: winners receive escape streaks from their final rooms while losing
  or defeated hunters remain in rooms that shake under the collapse.
- Player labels are names-only in normal play. Health, relic counts, score, and
  character details stay in HUD panels.
- Remote player avatars fall back to authoritative snapshot room positions, then
  interpolate toward live RTC position updates when another browser has an open
  reliable RTC lane. Live updates are resolved from the sender's room-relative
  offset so the visible avatar uses the receiver's current scene layout. If an
  RTC avatar packet still refers to the player's previous room, the snapshot
  room target wins so avatars do not stay pinned in old rooms.
- Room membership, player room ids, submissions, events, relic ownership, and
  investigations still come from public snapshots; RTC avatar coordinates do not
  override game state.
- Room visuals now use a dedicated identity mapping: Entrance as gatehouse,
  Hallway as main corridor, Storage as armory, Shrine as main hall, Trap Room as
  secret cell, Treasure as treasury, Monster as damaged barracks, and Exit as
  garden watchtower. These are presentation cues only; action legality and relic
  visibility still come from the public snapshot and view model.
- Iteration 14 now has a first scene-baseline pass through the scene upgrade
  S1 track. Further visual work should keep rooms, exits, players, relics,
  danger, current objective, prompts, minimap, and bottom HUD immediately
  legible at the captured desktop and mobile viewports.
- Player-facing labels and debug/development-only labels should be separated so
  the scene can stay clean in normal play.
