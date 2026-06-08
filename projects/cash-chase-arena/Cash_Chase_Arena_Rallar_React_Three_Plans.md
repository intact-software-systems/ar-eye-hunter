# Cash Chase Arena (CCA) - Rallar, React, and Three.js Plans
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

- Build Cash Chase Arena (CCA) as a new app inside the existing monorepo.
- Use Rallar as the only application communication middleware.
- Use React for app shell, lobby, menus, HUD, connection state, debug panels, and settings.
- Use Three.js through React Three Fiber for the 3D playfield.
- Keep simulation, scoring, missions, map validation, and protocol types in plain TypeScript outside React and outside the renderer.
- Use an elected browser director as the authoritative match host for MVP.
- Use cosmetic-only neon athlete runners for MVP; gameplay stats are shared.
- Develop characters through separate gameplay, visual, and animation tracks.
- Start with a fixed gameplay capsule and simple R3F neon capsules before polished humanoid assets.
- Use keyboard and mouse first, with third-person soft-follow camera, mouse orbit, sprint, evasive dash, and jump-triggered vaulting.
- Do not add a separate game-specific netcode package that creates raw `WebSocket`, `RTCPeerConnection`, or DataChannel objects.
- Use Rallar Motion for snapshot presentation smoothing, short-gap extrapolation, and prediction correction.
- Use Rallar AI as an optional creative proposal layer, not as a live game authority.
- Treat Rallar CRDT as optional collaboration/document infrastructure around the match, not as live match state.
- Do not persist app-owned CCA match or game data server-side in MVP; server persistence is limited to Rallar Server infrastructure data.
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
- browser Rallar Data stores for local latest-value state
- explicit CRDT documents for collaborative authored state outside the match simulation
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

### Character Development Track

CCA character development should follow three independent tracks that meet through serializable state:

1. Gameplay character
   - fixed capsule owned by `packages/cash-chase-core`
   - movement, collision, dash, vault, stamina, interact range, scoring, and Sentinel visibility are shared by every runner
   - exports only serializable state such as position, velocity, facing yaw, movement state, stamina, active vault, and cosmetic loadout ID

2. Visual character
   - renderer-owned presentation in `apps/cash-chase-arena`
   - starts as neon capsules, then a modular mannequin, then one shared humanoid rig
   - supports headgear, torso, legs, accent color, and trail FX without changing gameplay dimensions

3. Animation character
   - presentation-only animation driven by simulation state
   - uses in-place clips such as idle, jog, sprint, dash, vault, interact, caught, cash-out, and spectator idle
   - does not use root motion for authoritative movement

The first character vertical slice should prove:

- fixed gameplay capsule visible in debug mode
- three simple visual silhouettes
- six accent colors
- local movement and camera readability
- remote runner smoothing through Rallar Motion
- dash trail and vault placeholder animation

Later shipped assets should use GLB or glTF 2.0 with one shared scale, one shared rig, stable names, reusable materials, consistent pivots, and validation against the gameplay capsule. Do not block MVP on a heavy character asset pipeline.

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

Use Rallar Game lane presets for high-rate traffic. Prefer the default generic lane IDs for implementation, with CCA-specific names only as aliases in docs or debug labels:

```text
game-input      client to director input samples
game-snapshot   director to clients state snapshots
game-metrics    optional diagnostics and ping samples
```

Use Rallar WS messages for reliable room coordination and fallback:

- capability reports
- room-level match status
- AI or fallback map commit
- playtest diagnostics
- fallback delivery when RTC lanes are not ready

No game code should directly create raw WebSocket, WebRTC, or DataChannel objects.

## Rallar Data Fit For CCA

Rallar Data is a good fit for CCA browser-local latest-value state that should persist or coordinate across browser tabs. It is not a realtime transport, not a CRDT, not match authority, and not an MVP server-side CCA game-data store.

Browser `rallar.data` should be used for local/player-owned state:

- `cca-settings`: audio, graphics, input bindings, accessibility, HUD density, reduced-motion choices
- `cca-loadout-selection`: selected cosmetic loadout ID and local cosmetic UI state
- `cca-room-recents`: last-used room codes, lobby display preferences, onboarding flags
- `cca-ai-replay`: local replay/cache of accepted Rallar AI proposal envelopes for debugging
- `cca-debug-log`: bounded transport, playtest, and visual QA diagnostics

MVP CCA should not use server `rallar.data.open(...)` for app-owned match or game data. Server persistence is limited to data that belongs to the generic Rallar Server itself, such as auth/session/room/signaling/runtime infrastructure. Generated arena layouts, mission decks, cosmetic proposals, match summaries, score results, debug reports, and playtest reports should not be retained as CCA server app data in MVP.

Do not use Rallar Data for:

- live player positions
- input streams
- director snapshots
- Sentinel state during a match
- active score, banked credits, caught state, or cash-out authority
- host election, director leases, or recovery leases
- collaborative arena or mission editing
- authoritative inventory, unlocks, ownership, or anti-cheat state without stronger server-side rules
- server-side Rallar AI proposal caches, content catalogs, match summaries, playtest reports, or fallback arena/mission catalogs in MVP

Rallar Data is latest-value storage. Browser `sync: true` only coordinates open tabs through `BroadcastChannel`; it is not server sync. If CCA later adds app-owned server data after MVP, that must be a separate product decision with clear schema ownership, migration rules, retention rules, and authority boundaries.

Recommended browser store defaults:

```text
settings/loadout: scope principal, durability write-through
room recents/onboarding: scope principal, durability write-behind
debug log/AI replay: scope session or principal, durability write-behind, bounded TTL
```

## Rallar Motion Fit For CCA

Rallar Motion should be part of the CCA live presentation runtime. It belongs between `RallarMatchRuntime` and `CashChaseScene`, where it can turn received director snapshots into smooth render poses without changing simulation truth.

Use Rallar Motion for:

- remote runner, Sentinel, pickup, gate, and moving-prop interpolation
- adaptive snapshot delay for jitter on `game-snapshot`
- short dead-reckoning windows when snapshots are late
- local prediction correction when the director snapshot disagrees with the client's predicted runner pose
- discontinuity handling for dash snaps, caught transitions, respawns, cash-out exits, spectator handoff, and recovery snapshots
- kinematic estimation for trails, animation blending, and debug diagnostics when velocity is absent or noisy

Do not use Rallar Motion for:

- movement rules
- physics or collision
- scoring
- Sentinel decisions
- mission legality
- authority or anti-cheat
- host election or recovery policy

Recommended runtime shape:

```text
RallarMatchRuntime
  receives and accepts DirectorSnapshot
    -> CashChaseMotionPresenter
      -> Rallar Motion buffers per entity
        -> CashChaseScene samples render poses each frame
```

Use receiver-local `observedAtEpochMs` for interpolation timing. Store sender `sentAtEpochMs`, director tick, and snapshot sequence in metadata for diagnostics, but do not drive interpolation from sender clocks unless CCA later adds explicit clock sync.

Initial tuning targets:

```text
interpolation delay: 100-140ms, adaptive after baseline tests
max extrapolation: 120-200ms
interpolation mode: hermite when velocity is reliable, linear otherwise
rotation wrap: 2 * Math.PI for yaw in radians
discontinuity snap threshold: tuned per arena scale, starting around dash distance
```

## Rallar CRDT Fit For CCA

Rallar CRDT is useful around CCA when multiple humans or tools are editing shared authored state. It should not participate in the live authoritative match loop.

Good CCA CRDT document candidates:

- lobby planning board
- rich ready checklist or session setup notes
- collaborative arena draft editor
- mission deck draft editor
- Rallar AI proposal review board with generated layouts, comments, accept/reject notes, and rationale
- playtest notes and annotations
- creator-mode scratch documents

Do not use Rallar CRDT for:

- player positions or motion
- director snapshots
- Sentinel state
- credits, banked score, caught state, cash-out, or mission completion
- host election, director appointment, leases, or recovery state
- inventory, unlocks, ownership, entitlements, or anti-cheat state

CRDT merge semantics are a strength for collaborative documents because conflicts can be preserved and resolved by UI. They are a poor fit for competitive match truth, where CCA needs one authority to decide what happened. In MVP, do not create durable server-backed CRDT documents for CCA match or game data. Accepted CRDT-authored content must be committed once through normal Rallar WS or Rallar Game match startup messages before a round starts.

Recommended document types:

```text
cca-lobby-plan
cca-arena-draft
cca-mission-deck-draft
cca-ai-review
cca-playtest-notes
```

Use room-scoped CRDT documents for shared room planning and review only after MVP, or keep them explicitly local-only/non-server-persisted during MVP. Durable WS-backed CRDT transport can be considered later for planning documents; RTC acceleration can be considered later for creator tools, but neither path must become gameplay authority.

## Rallar AI Fit For CCA

Rallar AI should be the CCA creative proposal layer. Generated output is candidate JSON wrapped in Rallar AI result metadata, then accepted or rejected by CCA code.

Best V1 uses:

- arena layout proposals: obstacles, terminals, cash-out stations, Sentinel gates, spawn zones, and patrol anchors
- mission deck proposals: mission template selection, timing windows, rewards, target objects, and failure consequences
- arena flavor: original-IP arena names, signage copy, palette suggestions, and short environmental descriptions
- character cosmetics: preset names, colorway suggestions, and modular outfit combinations that keep shared gameplay stats
- tutorial and mission copy: concise objectives, alerts, onboarding hints, and failure messages
- playtest analysis: summaries of telemetry and suggested tuning changes that humans or deterministic tools review

Do not use Rallar AI for:

- live Sentinel chase decisions
- movement, dash, vault, collision, scoring, cash-out, or mission legality
- host election or backup selection
- authoritative snapshots or reliable game events
- anti-cheat or protocol decisions

Recommended flow:

1. Build deterministic fallback arena layouts and mission decks first.
2. Define strict CCA schemas for `CcaArenaLayoutProposal`, `CcaMissionDeckProposal`, and optional flavor/cosmetic proposal types.
3. Generate through Rallar AI Server for production pre-match content so provider credentials stay server-side.
4. Validate bounds, reachability, object counts, spawn safety, mission eligibility, and template-specific constraints.
5. Accept once by `dedupeKey` or `generationId`; rejected, stale, timed-out, or invalid results fall back to deterministic content.
6. Commit only the accepted layout/deck through normal Rallar WS or Rallar Game match startup messages.
7. Do not persist generated, accepted, rejected, or fallback CCA game content on the server in MVP; treat server-side generation output as ephemeral.

Browser-side Rallar AI is optional and advisory only. It can support debug tools, creator-mode previews, cosmetic suggestions, or local proposal drafts, but peers should not trust browser-generated output unless host or server validation accepts it.

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
GameplayCapsule
VisualCharacterPreset
CharacterAnimationState
CharacterAssetManifest
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
- pure type definitions for gameplay capsule, cosmetic loadouts, visual character presets, animation state, player control input, movement flags, and camera intent.
- browser-local Rallar Data store definitions for settings, loadout selection, room recents, AI replay, and debug logs.
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
- lane readiness checks for `game-input` and `game-snapshot`
- client sends movement input to director
- director runs a tiny fixed tick simulation
- director broadcasts snapshots
- clients render simple neon athlete capsules in R3F
- debug overlay can show fixed gameplay capsule versus visual runner
- clients route accepted snapshots through Rallar Motion buffers before rendering remote entity poses
- clients use keyboard/mouse controls with camera-relative movement, sprint, dash, and jump/vault input
- clients use a third-person soft-follow camera with mouse orbit
- local settings and selected cosmetic loadout persist through browser-local Rallar Data
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

- browser-local Rallar Data-backed settings, loadout selection, room recents, AI replay, and bounded debug log stores
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
- dash trail and vault placeholder animation driven by simulation state
- compact DOM HUD for timer, credits, mission prompt, and connection status

Done when:

- 2-4 players can complete a full round
- settings/loadout reload correctly without affecting match authority
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
- simple modular mannequin
- headgear, torso, legs, accent color, and trail FX slots
- one shared humanoid rig plan
- in-place animation clip mapping for idle, jog, sprint, dash, vault, interact, caught, cash-out, and spectator
- GLB or glTF character asset validation plan
- procedural arena variants
- refined materials, lighting, silhouettes, and UI motion
- optional postprocessing with performance budget
- ephemeral server-side Rallar AI generation through Rallar Server only
- strict validation for Rallar AI-generated arena layouts, mission decks, flavor, and cosmetic proposals
- fallback to deterministic layouts on validation or provider failure

Done when:

- generated layouts never bypass validation
- Rallar AI output is accepted once before it can affect match setup
- Rallar AI output is not persisted as CCA server app data in MVP
- character presets remain cosmetic-only and use the same gameplay capsule
- animation follows simulation state and does not drive authoritative movement
- fallback maps remain available offline or without AI
- visual polish improves readability rather than hiding gameplay state

### Iteration 6: Optional CRDT Collaboration Tools

Goal: add collaborative authored-state surfaces only after the playable loop and AI proposal flow are stable.

Build:

- room-scoped lobby planning document
- Rallar AI proposal review document for generated arena and mission candidates
- collaborative arena or mission draft editor if creator mode is still desired
- local-only or post-MVP playtest notes document tied to room or match ID
- deterministic commit path from accepted CRDT-authored content into normal CCA match setup

Done when:

- CRDT documents are useful without being required for basic play
- MVP CRDT documents are local-only/non-server-persisted, or the feature waits until post-MVP
- accepted content is committed once before match start
- live match simulation never reads CRDT as authoritative state
- CRDT document health is visible in creator/debug UI

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
- Rallar Data store names, scopes, schema versions, migrations, TTLs, and validation
- gameplay capsule invariants across all character presets
- character animation state mapping from simulation state
- character asset manifest validation
- movement update
- sprint stamina
- evasive dash cooldown
- jump-triggered vault eligibility
- collision with bounds and obstacles
- snapshot creation
- snapshot ordering
- Rallar Motion sample conversion from snapshots
- motion discontinuity classification for dash, respawn, cash-out, and recovery transitions
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
- Rallar Motion buffer push, duplicate/stale sequence handling, and render estimate sampling
- sync request flow
- partial lane readiness
- Rallar Data open/hydrate/read/write/update/flush flows for settings, loadout, AI replay, and debug logs
- tests proving Rallar Data is not used for live snapshots, input streams, scores, host election, or recovery leases
- tests or review checks proving no server `rallar.data.open(...)` calls are introduced for app-owned CCA match/game data in MVP
- optional CRDT document open/apply/subscribe flows for lobby or AI review documents

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
- gameplay capsule and visual runner stay aligned across idle, sprint, dash, vault, caught, and cash-out states
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
- no polished humanoid character dependency before the capsule/mannequin vertical slice works
- no root-motion-driven authoritative movement
- no mesh-derived collision
- no Rallar Data dependency for live match traffic or authority
- no server-side persistence of app-owned CCA match/game data in MVP
- no Rallar Data for collaborative editing; use Rallar CRDT instead
- no Rallar AI-generated map dependency for basic play
- no Rallar CRDT dependency for basic play
- no Rallar CRDT for live match authority, player positions, scoring, or mission completion

## Assumptions

- Desktop keyboard and mouse are the first target.
- Mobile should be responsive but not fully touch-optimized in MVP.
- Browser director authority is acceptable for first playtests.
- Rallar internal use of WebSocket and WebRTC is allowed because Rallar is the middleware boundary.
- Host migration can start as pause, re-elect, and sync rather than fully seamless continuation.
- Rallar AI layout generation is post-playable-loop and must be server-side with deterministic validation.
- Rallar AI generation output must remain ephemeral server-side in MVP.
- Rallar Data should be added for browser-local preferences/debug persistence after the first Rallar vertical slice, not before.
- Rallar Motion should be used as soon as remote snapshots exist.
- Rallar CRDT should wait until CCA has a real collaborative planning, creator, or AI-review surface.
- Character polish should follow gameplay readability; the first playable slice can ship with capsules or mannequins.
