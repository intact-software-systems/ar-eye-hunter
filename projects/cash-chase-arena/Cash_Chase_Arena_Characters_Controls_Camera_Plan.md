# Cash Chase Arena - Characters, Controls, and Camera Plan
Prepared: June 8, 2026

## Purpose

This document locks the first implementation direction for playable runners, movement controls, and camera behavior. It extends the Rallar, React, and Three.js plan with decisions that affect simulation types, renderer behavior, input messages, animation, and early playtest tuning.

Read alongside:

- `Cash_Chase_Arena_Rallar_React_Three_Plans.md`
- `Cash_Chase_Arena_Product_Owner_Document.md`

## Locked Decisions

- Playable runners are cosmetic-only for MVP.
- The character style is neon athletes: sporty chase gear, readable silhouettes, bright accents, and original-IP arena identity.
- Character customization starts as modular outfit pieces.
- All characters share identical gameplay stats in MVP.
- The first control target is keyboard and mouse.
- The movement model is parkour chase, not slow stealth and not full trick movement.
- The first move set is sprint, evasive dash, and vault.
- Vaulting is triggered by the jump button near valid vaultable obstacles.
- The primary camera is third-person chase.
- The camera behavior is soft follow with mouse orbit.
- Danger camera behavior uses threat assist when a Sentinel is close or actively chasing.

## Character Plan

### Gameplay Model

Characters must not affect gameplay stats in MVP. Every runner uses the same:

- walk speed
- sprint speed
- stamina rules
- dash distance
- dash cooldown
- vault rules
- interaction range
- collision capsule
- scoring rules
- Sentinel detection rules

This keeps the first multiplayer version fair, testable, and easier to tune. Character identity is visual and social, not mechanical.

### Visual Direction

Use neon athlete language:

- aerodynamic jackets and fitted arena gear
- luminous accent strips
- readable helmet or headgear silhouettes
- strong color blocking
- lightweight shoes or leg gear
- subtle trails or glow effects
- no direct references to existing shows, teams, uniforms, masks, costumes, music, or branded presentation

Characters should look like contestants in an original futuristic chase sport, not like soldiers, superheroes, or copied game-show figures.

### Modular Customization

MVP customization should expose curated modular outfit choices:

```text
headgear
torso
legs
accentColor
trailFx
```

Start with 6-8 complete presets built from those parts. Full mix-and-match can come after the first playable slice if the UI and asset budget allow it.

### Fairness Constraints

Cosmetics must not alter:

- collision size
- animation timing used by simulation
- movement speed
- Sentinel visibility
- interact range
- cash-out behavior

Renderer-only differences are allowed if they do not hide the runner or obscure gameplay readability.

## Control Plan

### Input Device Priority

Tune keyboard and mouse first.

Gamepad can be added after the keyboard/mouse controller feels good. Touch controls are responsive-layout only for MVP and should not drive first-pass tuning.

### Default Bindings

```text
WASD       move, camera-relative
Mouse      orbit camera and set facing intent
Shift      sprint while stamina is available
Space      jump or vault when vault conditions are valid
Q or Ctrl  evasive dash
E          interact with terminal, gate, mission object, or cash-out station
Tab        compact match/status overlay
Esc        pause/menu and release pointer lock
```

If one binding must be preferred for dash, use `Q` as the primary visible binding and support `Ctrl` as an alternate.

### Movement Model

Use a shared parkour chase controller:

- movement is camera-relative on the horizontal plane
- diagonal movement is normalized
- sprint drains stamina while held
- stamina recovers after a short delay when not sprinting
- dash is a short directional burst with cooldown
- vault is a contextual action triggered from jump input
- no wall-run, roll, slide, crouch, or stamina-combo system in MVP

The first version should feel fast and readable rather than deeply technical. Players should understand the movement kit within one round.

### Dash

Dash is an evasive burst:

- short duration
- short distance
- cooldown-based
- direction follows current movement input, falling back to facing direction
- cannot be spammed for long-distance travel
- should help dodge Sentinels, cross exposed gaps, or reach a station under pressure

Simulation owns dash legality and cooldown. The renderer can add squash, trail, FOV, or afterimage effects, but those effects do not affect gameplay.

### Vault

Vaulting is triggered by `Space` when conditions are valid:

- runner is near a vaultable low obstacle
- runner is moving toward the obstacle
- approach angle is within the allowed range
- runner has enough speed
- obstacle is marked vaultable by the arena layout
- destination is clear

If vault conditions are not valid, `Space` can become a small hop or no-op in MVP. Prefer no-op if jumping creates tuning noise during the Rallar vertical slice.

### Interact

Use `E` for deliberate interactions:

- terminals
- Sentinel gates
- cash-out stations
- mission objects
- sync or ready prompts where appropriate

Interact should be host/director-validated by distance, phase, player state, object state, and cooldown.

## Camera Plan

### Primary Camera

Use third-person soft follow:

- behind and above the runner
- slight shoulder offset
- mouse-orbit yaw
- limited pitch range
- smooth position follow
- smooth look target follow
- camera-relative movement
- obstruction handling against walls and large obstacles

The camera should make the runner, nearby Sentinels, cash-out stations, terminals, and other players readable during a chase.

### Suggested Initial Tuning

These are first-pass defaults for implementation. They are expected to be tuned during playtests.

```text
camera distance: 5.5-7.0 world units
camera height: 2.8-4.0 world units
shoulder offset: 0.45-0.8 world units
pitch range: -25deg to 55deg
horizontal sensitivity: medium desktop mouse feel
vertical sensitivity: slightly lower than horizontal
follow smoothing: 120-220ms feel
look target smoothing: 80-160ms feel
normal FOV: 65-72deg equivalent
sprint FOV lift: small
dash FOV pulse: brief and subtle
```

Do not use aggressive camera shake in MVP. Use motion sparingly so the game remains comfortable in browser playtests.

### Threat Assist

Threat assist activates when a Sentinel is near or chasing:

- nearest active Sentinel can bias the camera target slightly
- bias must not override direct player mouse orbit
- use edge indicators or subtle pulses when the threat is off-screen
- use a small FOV lift or audio/visual cue during close pursuit
- do not hard-lock the camera to the Sentinel
- do not rotate the camera without player input strongly enough to cause disorientation

Threat assist is a readability feature, not an aim assist or cinematic camera takeover.

### Camera States

Implement explicit camera states:

```text
lobbyShowcase
activeChase
interactionFocus
spectator
results
debugFreeCamera
```

`debugFreeCamera` must be behind a debug toggle and should not affect simulation state.

### Input And UI Boundaries

Pointer/camera input should pause or be gated when:

- pause menu is open
- settings are open
- lobby panel is active
- scoreboard is active
- text input is focused
- browser pointer lock is not active, if pointer lock is required for current mode

The DOM HUD must not fight the camera. Active play should keep center and lower-middle viewport clear.

## Core Interfaces To Add

Add these concepts to `packages/cash-chase-core`:

```text
CharacterCosmeticLoadout
CharacterPreset
CosmeticPartId
AccentColorId
TrailFxId
PlayerControlInput
MoveIntent
MovementActionFlags
CameraIntent
CameraMode
DashState
VaultAttempt
VaultResult
```

`PlayerControlInput` should be serializable and suitable for Rallar realtime input messages:

```text
protocolVersion
playerId
seq
sentAtEpochMs
moveX
moveY
cameraYaw
sprintHeld
dashPressed
jumpPressed
interactPressed
```

Simulation snapshots should include enough player presentation data for clients to render movement state:

```text
position
velocity
facingYaw
movementState
dashCooldownUntil
stamina
activeVault
cosmeticLoadout
```

The renderer may maintain camera smoothing locally, but it must not send renderer objects or non-serializable camera state across Rallar.

## Implementation Placement

`packages/cash-chase-core` owns:

- input type definitions
- movement state machine
- stamina rules
- dash legality
- vault legality
- cosmetic schema
- gameplay stat invariants
- tests

`apps/cash-chase-arena` owns:

- keyboard/mouse event capture
- pointer lock or pointer drag behavior
- React Three Fiber camera rig
- camera smoothing
- camera obstruction handling
- threat-assist presentation
- character mesh composition
- cosmetic selection UI
- HUD hints and binding display

`RallarMatchRuntime` owns:

- input send cadence
- input sequence numbers
- stale input handling
- director-side input validation before simulation
- snapshot publication

## Iteration Placement

### Iteration 0

Define types and defaults:

- cosmetic loadout
- character preset
- player control input
- camera intent
- movement action flags

Add unit tests proving cosmetics do not change gameplay stats.

### Iteration 1

Use simple R3F capsules for neon athlete runners.

Implement:

- WASD camera-relative input
- mouse orbit
- third-person soft-follow camera
- sprint
- dash
- jump input as a placeholder, with vault eligibility stubbed if no arena obstacles exist yet

### Iteration 2

Add playable chase movement:

- stamina drain/recovery
- dash cooldown
- vaultable obstacles
- vault validation
- Sentinel threat camera cues
- cash-out and terminal interaction with `E`

### Iteration 3+

Tune:

- camera obstruction handling
- threat assist
- outfit modularity
- animation transitions
- gamepad support
- optional touch controls

## Test Plan

### Unit Tests

Cover:

- all cosmetic presets resolve to identical gameplay stats
- movement input normalization
- camera yaw to world move vector conversion
- sprint stamina drain and recovery
- dash cooldown and direction fallback
- vault eligibility by distance, angle, speed, and destination clearance
- interact eligibility by distance and match phase
- stale and duplicate input sequence rejection

### Browser Tests

Cover:

- keyboard movement changes local input intent
- mouse orbit changes camera intent
- pointer lock or pointer capture is released on menu open
- `Shift` toggles sprint intent
- `Q` and `Ctrl` trigger dash intent
- `Space` triggers jump/vault intent
- `E` triggers interact intent
- HUD and menu states gate camera input

### Visual QA

Cover:

- character silhouettes remain readable at camera distance
- modular outfit parts do not obscure gameplay state
- camera does not clip through common obstacles
- threat assist does not hijack control
- sprint and dash effects are readable but not disorienting
- HUD does not obscure the center or lower-middle playfield

## Non-Goals For MVP

- character stats
- character abilities
- perks or loadouts with gameplay effects
- wall-run
- slide
- roll
- combat attacks
- stealth crouch
- full mobile touch controller
- first-person mode
- top-down tactical mode
- cinematic camera takeover during chase

