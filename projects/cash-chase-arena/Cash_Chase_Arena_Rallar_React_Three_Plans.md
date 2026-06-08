# Cash Chase Arena - Rallar, React, and Three.js Plans
Prepared: June 7, 2026

## Purpose

This document updates the Cash Chase Arena implementation direction after evaluating the existing product documents, the current repository shape, and the requirement that Rallar is the only communication middleware.

It should be read alongside:

- `Cash_Chase_Arena_Product_Owner_Document.md`
- `Cash_Chase_Arena_Implementation_Plan.md`
- `Cash_Chase_Arena_Codex_Prompt_Pack.md`
- `Cash_Chase_Arena_Characters_Controls_Camera_Plan.md`

Where this document conflicts with the earlier implementation plan, prefer this document for stack, repository, and networking decisions.

## Locked Decisions

- Build Cash Chase Arena as a new app inside the existing monorepo.
- Use Rallar as the only application communication middleware.
- Use React for app shell, lobby, menus, HUD, connection state, debug panels, and settings.
- Use Three.js through React Three Fiber for the 3D playfield.
- Keep simulation, scoring, missions, map validation, and protocol types in plain TypeScript outside React and outside the renderer.
- Use an elected browser director as the authoritative match host for MVP.
- Use cosmetic-only neon athlete runners for MVP; gameplay stats are shared.
- Use keyboard and mouse first, with third-person soft-follow camera, mouse orbit, sprint, evasive dash, and jump-triggered vaulting.
- Do not add a separate game-specific netcode package that creates raw `WebSocket`, `RTCPeerConnection`, or DataChannel objects.
- Defer full anti-cheat. Preserve host-owned state and validation boundaries so the game can later move authority server-side if needed.

## Stack Evaluation

### Rallar

Rallar is a good fit for this project because it already provides the main primitives the game needs:

- auth and restored sessions
- room create, join, leave, list, and event replay
- people and presence state
- WebSocket messages for reliable server-routed traffic
- RTC messages and realtime RTC lanes for peer-to-peer traffic
- configurable DataChannel lanes, readiness checks, health, and diagnostics
- director appointment and director relay helpers
- Rallar motion buffers, adaptive delay, send gates, and smoothing helpers
- black-box and browser validation tooling for multiplayer confidence

Game code should treat Rallar as the network platform, not as a low-level transport detail. Cash Chase Arena should define its protocol in terms of Rallar topics, message types, room membership, director status, realtime lanes, and lane health.

### React

React is the right app shell for this repository and this game. Existing apps already use Vite and React, and Cash Chase needs a lot of stateful UI around the game:

- login and session restore
- create or join room
- player readiness
- host or director diagnostics
- match phase status
- mission alerts
- score HUD
- final scoreboard
- debug overlay
- playtest error surfaces

React should not own the high-frequency simulation loop. React components should render state summaries, not become the authoritative game runtime.

### Three.js And React Three Fiber

Three.js is a good renderer choice for the desired 3D browser-native arena. Because the app is React-first, use React Three Fiber as the default integration layer.

Use:

- `three`
- `@react-three/fiber`
- `@react-three/drei`
- `@react-three/postprocessing` only after the scene is stable
- GLB or glTF 2.0 for shipped 3D assets later

Do not use Rapier in the first multiplayer slice. For the MVP, deterministic movement and simple collision math in the simulation package are easier to test, replay, and migrate.

### Babylon.js

The existing repo has Babylon-based game experiments. Babylon remains viable, but this project should use Three.js because the desired direction is React plus Three.js. R3F also gives a clean boundary between React app state and scene composition.

## Implementation Paths Evaluated

### Plan A: Rallar Vertical Slice First

This is the recommended path.

Build the smallest multiplayer loop through Rallar before investing in rich gameplay or visual polish. Prove rooms, director election, Rallar lanes, input routing, snapshots, fallback behavior, and diagnostics with simple shapes first.

Why this is best:

- It tackles the biggest project risk first: browser-hosted multiplayer over Rallar.
- It validates that Rallar can be the only communication middleware.
- It prevents the renderer from hiding protocol or authority problems.
- It creates a thin playable spine that later iterations can safely expand.

### Plan B: Game Feel First

Build a local single-player 3D chase prototype first, then network it later.

This is useful if movement, camera, and Sentinel behavior are highly uncertain. It is not recommended as the main path because it delays the Rallar-only networking proof and can create simulation assumptions that are hard to network.

Use only as a short side prototype if the first 3D controls feel unclear.

### Plan C: Server Authority First

Make a Rallar server app authoritative from the start. Browsers send intents; the server owns simulation and broadcasts snapshots.

This improves consistency and cheat resistance, but it contradicts the current product direction of an elected browser host and increases backend scope. Keep it as a future migration path if browser director authority causes unacceptable playtest problems.

## Recommended Architecture

### Repository Shape

Add:

```text
apps/cash-chase-arena/
packages/cash-chase-core/
```

`apps/cash-chase-arena` owns:

- Vite app setup
- React routes or app shell
- Rallar session and room lifecycle
- React Three Fiber scene
- DOM HUD and menus
- browser runtime orchestration
- Playwright smoke tests for the app

`packages/cash-chase-core` owns:

- protocol constants
- shared TypeScript types
- validation helpers
- arena layout generation and validation
- deterministic simulation
- scoring
- Sentinel AI
- missions
- snapshot ordering and acceptance rules
- unit tests

### Runtime Boundary

Keep three runtimes separate:

1. `GameSimulation`
   - Pure TypeScript.
   - Owns match state, ticks, movement, collision, Sentinels, missions, scoring, and snapshots.
   - No React imports.
   - No Three.js imports.
   - No Rallar imports.

2. `RallarMatchRuntime`
   - Browser orchestration layer.
   - Connects Rallar room state, director status, realtime lanes, reliable messages, and simulation.
   - Owns send cadence, snapshot cadence, sync requests, and reconnection handling.
   - No renderer-specific logic.

3. `CashChaseScene`
   - React Three Fiber scene.
   - Renders interpolated snapshots and local prediction state.
   - Owns camera, lights, procedural meshes, materials, animation presentation, and visual effects.
   - Does not decide game rules.

### Rallar Protocol

Use Rallar rooms as match lobbies. One room equals one lobby or match.

Use the current Rallar session ID as the peer/player identity for MVP.

Use Rallar director appointment as the authoritative browser director lease:

- The elected browser calls `rallar.director.appoint()`.
- Other clients observe director status and send intents to the current director.
- A stale director pauses the match and triggers re-election.

Use Rallar Director Relay for reliable low-rate traffic:

- match start intent
- ready changes
- mission interactions
- cash-out interactions
- reliable game events
- sync requests
- recovery snapshots

Use Rallar realtime lanes for high-rate traffic:

```text
cash-input      client to director input samples
cash-snapshot   director to clients state snapshots
cash-metrics    optional diagnostics and ping samples
```

Use Rallar WS messages for reliable room coordination and fallback:

- capability reports
- room-level match status
- AI or fallback map commit
- playtest diagnostics
- fallback delivery when RTC lanes are not ready

No game code should directly create raw WebSocket, WebRTC, or DataChannel objects.

## Public Interfaces

`packages/cash-chase-core` should export these stable concepts:

```text
CashChaseProtocolVersion
CashChaseLaneIds
CashChaseTopicIds
CashChaseTypeIds
HostCapability
ClientInput
DirectorSnapshot
ReliableGameEvent
ArenaLayout
MissionCard
MatchPhase
PlayerState
SentinelState
CharacterCosmeticLoadout
PlayerControlInput
CameraIntent
createInitialMatchState
stepMatch
buildDirectorSnapshot
applyClientInput
validateArenaLayout
createFallbackArenaLayout
scoreHostCapability
electDirectorCandidate
```

Initial protocol defaults:

```text
simulation tick rate: 30Hz
input send rate: 20Hz
snapshot send rate: 12Hz
metrics send rate: 2Hz
director heartbeat TTL: use Rallar default first, then tune after smoke tests
player count: 2-8
```

## Iteration Plan

### Iteration 0: Project And Protocol Skeleton

Goal: create the foundation without gameplay risk.

Build:

- `apps/cash-chase-arena` as a React + Vite app.
- `packages/cash-chase-core` as a TypeScript package.
- protocol constants for topics, type IDs, lane IDs, tick rates, and protocol version.
- pure type definitions for inputs, snapshots, match phase, player state, Sentinel state, missions, and arena layout.
- pure type definitions for cosmetic loadouts, player control input, movement flags, and camera intent.
- basic unit tests for protocol guards and host capability scoring.

Done when:

- app builds
- core package typechecks
- unit tests pass
- no direct game networking APIs exist outside Rallar-facing integration points

### Iteration 1: Rallar Vertical Slice

Goal: prove the smallest multiplayer loop through Rallar.

Build:

- login or restored session flow
- create room and join room
- ready toggle
- active player list
- capability report over Rallar WS messages
- deterministic director election
- director appointment through Rallar
- lane readiness checks for `cash-input` and `cash-snapshot`
- client sends movement input to director
- director runs a tiny fixed tick simulation
- director broadcasts snapshots
- clients render simple neon athlete capsules in R3F
- clients use keyboard/mouse controls with camera-relative movement, sprint, dash, and jump/vault input
- clients use a third-person soft-follow camera with mouse orbit
- debug overlay for room ID, session ID, director status, RTC lane health, snapshot age, and missed snapshots

Done when:

- two browser contexts can join the same room
- one browser becomes director
- non-director input reaches director
- director snapshots reach clients
- movement is visible in both browsers
- WS fallback or clear degraded state appears when RTC is not ready

### Iteration 2: Playable Chase Loop

Goal: turn the networking spine into a game.

Build:

- deterministic fallback arena layout
- spawn zone
- obstacle collision
- vaultable low obstacles
- cash-out stations
- simple Sentinel patrol and chase
- tag radius and caught state
- survival scoring
- banked and unbanked credits
- cash-out interaction
- match timer
- final scoreboard
- R3F arena rendering with procedural meshes
- threat-assist camera cues when a Sentinel is close or chasing
- compact DOM HUD for timer, credits, mission prompt, and connection status

Done when:

- 2-4 players can complete a full round
- a player can be caught
- a player can cash out
- final scoreboard is consistent across clients
- fallback arena works without AI

### Iteration 3: Missions And Match Flow

Goal: add pressure and a complete MVP match structure.

Build:

- match phases: lobby, electing, connecting, countdown, active, results
- three MVP mission templates:
  - disable Sentinel gate
  - open cash-out window
  - double reward zone
- mission scheduler
- terminal interaction intents
- reliable mission events through Director Relay
- sync request and director snapshot response for late or recovering clients
- mission alert UI with objective, countdown, reward, and failure state

Done when:

- missions appear during active rounds
- mission effects are visible and authoritative
- late/rejoining clients can request a current snapshot
- players understand the active objective quickly during playtest

### Iteration 4: Playtest Hardening

Goal: make the game robust enough for external testers.

Build:

- stale director detection
- pause and re-elect flow
- backup director candidate tracking
- recent director snapshot retention on clients
- clear error states for:
  - Rallar API unavailable
  - auth failure
  - room join failure
  - no director
  - stale director
  - RTC lane timeout
  - partial RTC readiness
  - unsupported browser
- onboarding disclosure for peer-hosted Rallar matches
- manual QA checklist
- 2-3 browser smoke test

Done when:

- testers can recover from common setup and connection failures
- stale director state does not silently corrupt a match
- a controlled host disconnect produces a clear paused or recovered state
- playtest logs expose enough data to debug transport issues

### Iteration 5: Visual Identity And AI Variety

Goal: improve replayability and presentation after the multiplayer loop works.

Build:

- stronger original-IP visual direction
- procedural arena variants
- refined materials, lighting, silhouettes, and UI motion
- optional postprocessing with performance budget
- server-side AI layout generation through Rallar Server only
- strict validation for AI-generated arena layouts and mission decks
- fallback to deterministic layouts on validation or provider failure

Done when:

- generated layouts never bypass validation
- fallback maps remain available offline or without AI
- visual polish improves readability rather than hiding gameplay state

## UI Direction

Use a low-chrome 3D game interface. The playfield should dominate.

Persistent UI should be limited to:

- compact timer and credits cluster
- mission/status chip
- small connection/director status indicator
- optional debug toggle

Use DOM for text-heavy UI:

- lobby
- player list
- readiness
- settings
- scoreboard
- debug overlay
- error states

Use the 3D scene for:

- arena
- players
- Sentinels
- terminals
- cash-out stations
- gates
- spatial mission markers
- simple effects

Avoid large centered panels during active play. Keep the lower-middle viewport clear for movement and spatial reading.

## Testing Strategy

### Core Unit Tests

Cover:

- host capability scoring
- director election tie-breaks
- input validation
- cosmetic loadouts do not alter gameplay stats
- movement update
- sprint stamina
- evasive dash cooldown
- jump-triggered vault eligibility
- collision with bounds and obstacles
- snapshot creation
- snapshot ordering
- scoring
- cash-out rules
- caught behavior
- Sentinel detection and tag logic
- mission eligibility, completion, timeout, and effects
- arena layout validation

### Rallar Integration Tests

Use mocked or thin Rallar adapters where possible.

Cover:

- room lifecycle mapping
- director appointment and stale director handling
- reliable intent send and receive
- realtime input routing
- snapshot receive and acceptance
- sync request flow
- partial lane readiness

### Browser Smoke Tests

Use Playwright with multiple browser contexts.

Cover:

- create room
- join room
- elect director
- wait for Rallar lanes
- send input
- observe remote movement
- complete a cash-out
- finish a round
- inspect debug overlay for non-empty lane health and snapshot cadence

### Visual QA

After R3F work, verify:

- canvas is nonblank
- scene is correctly framed
- player and Sentinel silhouettes are readable
- HUD does not cover active play space
- desktop and mobile layouts do not overlap
- debug overlay can be toggled
- reduced-motion preference is respected for nonessential UI motion

## Milestone Gate Order

Do not advance to a later gate until the earlier gate is true.

1. Rallar vertical slice works across two browser contexts.
2. Pure simulation tests are stable.
3. One complete playable round works with simple geometry.
4. Three mission templates work.
5. Playtest error states and debug data are usable.
6. Visual polish and AI variety begin.

## Explicit Non-Goals For MVP

- no real money
- no direct references to existing shows, characters, costumes, music, UI, or lore
- no custom raw WebRTC manager in game code
- no custom raw WebSocket channel in game code
- no full anti-cheat
- no mobile touch-first control scheme
- no asset-heavy GLB pipeline before procedural maps are fun
- no AI-generated map dependency for basic play

## Assumptions

- Desktop keyboard and mouse are the first target.
- Mobile should be responsive but not fully touch-optimized in MVP.
- Browser director authority is acceptable for first playtests.
- Rallar internal use of WebSocket and WebRTC is allowed because Rallar is the middleware boundary.
- Host migration can start as pause, re-elect, and sync rather than fully seamless continuation.
- AI layout generation is post-playable-loop and must be server-side with deterministic validation.
