# UI And Gameplay

Last reviewed: 2026-10-23.

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

- Signed-out users see authentication and private-room entry controls immediately.
  An incoming reference/code survives registration and reload in the same tab.
- The room panel supports public, code, and invite-only creation. Code hosts can
  copy a link and rotate it; invite-only hosts invite or revoke account references.
  Generated codes are scoped to the current session and room. Entry failures keep
  the intended destination visible with retry, correction, and cancellation.
- Admission does not join the expedition. Hunters choose a character and press
  **Join as**; the lobby separately shows room presence and the expedition roster.
- `src/app.tsx` composes `GameHudLayout`. Capability-specific panels live under
  `src/game/hud/`; turn draft, preferences, and HUD playback have separate hooks.
- Named regions are top status, side controls, bottom timeline, floating prompts,
  and overlays for help, tension, and final scoring. Desktop side controls scroll
  independently; mobile retains page scrolling. Sticky section buttons navigate
  Rooms, Party/Plan, Map, and Intel.
- `RelicSceneNext.tsx` renders the accepted snapshot as a procedural neon facility.
  `OpeningRelicScene.tsx` renders when no snapshot is available. Avatar, Visor,
  Overview, and Flyover controls affect presentation only.
- The AI Companion is advisory. A validated local suggestion can prime a draft;
  it cannot submit. Proposals are shared only with the hunter's own sessions.

## Controls

- Primary planning controls are in the round plan panel.
- Primary executable buttons use direct verbs such as `Join as`, `Start`, and
  `Submit Plan`; themed copy should stay in supporting text.
- After a plan is locked, the locked-plan card remains visible and the action
  picker can still be used for inspection, but submission stays disabled.
- A command the rules refuse shows the rule's text in the error panel of the
  session that sent it. The hunter's other sessions are other players and show
  nothing of it; the locked-plan card stays the one display of the plan this
  session submitted.
- The AI Companion is disabled once the local hunter has locked a plan, is down,
  has escaped, or the snapshot is outside planning. Stale suggestions remain
  visible as stale until the player asks again on the current turn.
- During review, planning input is disabled and a round review panel replaces
  the plan submission controls. The scene remains visible so each browser can
  play the same reveal cues before a player continues to the next turn or
  finale.
- Number keys select actions, arrow-style target shortcuts select move targets,
  and Enter submits when the draft is legal.
- Scene clicks on a legal adjacent room prime a move draft for that room.
  Search hotspots can still prime search actions, and the visible action panel
  remains the authoritative planning surface.
- Avatar and Visor modes support camera look. Overview and Flyover expose the
  surrounding facility; choosing a camera does not change the authoritative room.
- Scene movement is cosmetic. Clicking an adjacent room or a search hotspot primes
  the same draft shown in the plan panel; only submission commits a gameplay action.

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

The AI Companion context is derived from the same public gameplay state and
view-model surfaces. It includes legal options, room-level relic signals,
warnings, objectives, visible investigations, and recent public events; it does
not expose raw hidden relic definitions to the provider.

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
  prompts, the side action panel, the minimap, room intel, and help
  overlays. Large-screen menu navigation now has sticky jump controls, but the
  underlying number of surfaces is still high.
- Mocked browser checks cover the single-client planning loop. The paired-server
  propagation and private-entry suites cover multiple browsers, participation,
  reload, and room admission. Use the validation commands in current-state.md;
  historical passes do not replace checks on the current revision.
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

The active scene uses the neon facility and camera model in
`scene/relicSceneNextModel.ts`, with palette values in `scene/neonTheme.ts`.
Room kinds, hazards, relics, avatars, and escape routes must remain readable at
both desktop and mobile sizes. Scene readiness, camera mode, review playback,
and render/motion diagnostics are exposed on the canvas for browser checks.

Remote avatar coordinates are cosmetic and room-relative. Snapshot room identity
wins over stale RTC coordinates. Authoritative membership, submissions, events,
relic ownership, and investigations remain server snapshot data. Scene clicks
prime ordinary draft controls; gameplay commits still use the visible command
path. Review animation does not change server event order.

See [scene-contracts.md](scene-contracts.md) and
[visual-direction.md](visual-direction.md) for the current presentation boundary.
