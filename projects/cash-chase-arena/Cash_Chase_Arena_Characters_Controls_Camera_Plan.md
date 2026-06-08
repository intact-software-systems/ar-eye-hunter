# Cash Chase Arena (CCA) - Characters, Controls, and Camera Plan
Prepared: June 8, 2026

## Purpose

This document locks the first implementation direction for playable runners, movement controls, and camera behavior. It extends the Rallar, React, and Three.js plan with decisions that affect simulation types, renderer behavior, input messages, animation, and early playtest tuning.

Read alongside:

- `Cash_Chase_Arena_Rallar_React_Three_Plans.md`
- `Cash_Chase_Arena_Product_Owner_Document.md`

## Locked Decisions

- Playable runners are cosmetic-only for MVP.
- Character development is split into gameplay, visual, and animation tracks.
- The gameplay character is a fixed simulation capsule, not a mesh-driven body.
- The visual character is renderer-owned and follows simulation state.
- Character animation follows simulation state and must not drive authoritative movement.
- The character style is neon athletes: sporty chase gear, readable silhouettes, bright accents, and original-IP arena identity.
- Character customization starts as modular outfit pieces.
- All characters share identical gameplay stats in MVP.
- The first character vertical slice uses simple R3F capsules before polished humanoid assets.
- Later shipped character assets use GLB or glTF 2.0 with one shared scale and one shared rig.
- The first control target is keyboard and mouse.
- The movement model is parkour chase, not slow stealth and not full trick movement.
- The first move set is sprint, evasive dash, and vault.
- Vaulting is triggered by the jump button near valid vaultable obstacles.
- The primary camera is third-person chase.
- The camera behavior is soft follow with mouse orbit.
- Danger camera behavior uses threat assist when a Sentinel is close or actively chasing.
- Rallar Motion is used for remote entity presentation smoothing once director snapshots exist.
- Rallar Motion does not own camera behavior, movement rules, collision, scoring, or match authority.

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

The gameplay character should be represented by a fixed capsule and serializable simulation fields:

```text
playerId
position
velocity
facingYaw
movementState
stamina
dashCooldown
activeVault
cosmeticLoadoutId
```

`packages/cash-chase-core` must never import Three.js, GLB data, animation clips, skeletons, materials, or renderer asset metadata. It owns the capsule, movement state, and cosmetic loadout ID only.

### Visual Character Model

The visual character is a renderer-owned presentation of the gameplay capsule. It should make players feel distinct without changing competitive rules.

Recommended visual progression:

1. Neon capsule runners with color accents.
2. Simple modular mannequin with headgear, torso, legs, accent color, and trail FX.
3. One shared humanoid rig with basic animation clips.
4. Six to eight curated complete presets.
5. Later mix-and-match customization after readability, UI, and asset budget are proven.

The renderer may offset meshes, add trails, blend animations, and show effects, but the collision capsule remains fixed. The debug overlay should be able to show the gameplay capsule and visual mesh together so scale drift is obvious during playtests.

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

Rallar AI can help propose preset names, accent colorways, trail FX labels, and modular outfit combinations after the base cosmetic schema exists. Those proposals are visual-content drafts only; CCA must validate that every accepted preset keeps shared gameplay stats and original-IP constraints.

Persist the selected cosmetic loadout ID and local cosmetic UI preferences through Rallar Data after the first vertical slice. Rallar Data should store the player's latest selection, not the authoritative match character state. The match snapshot still carries the accepted `cosmeticLoadoutId` used by other clients.

### Animation Plan

Animation is presentation only. The simulation moves the capsule; animation clips respond to `movementState`, speed, `facingYaw`, `activeVault`, and player state.

Use in-place animation clips for:

```text
idle
jog
sprint
dash
vault_start
vault_over
vault_land
interact
caught
cash_out
spectator_idle
```

Do not use root motion for authoritative movement in MVP. If an imported animation contains root motion, strip or ignore it at runtime and keep the visual root following the simulation pose. Animation timing must not affect dash distance, vault clearance, interact eligibility, caught state, or cash-out behavior.

Remote player animation should read Rallar Motion render estimates and snapshot metadata. It should not read raw network packets directly.

### 3D Asset Pipeline

The final character asset pipeline should target GLB or glTF 2.0. Do not ship FBX, OBJ, or Blender-native files as runtime assets.

Runtime-ready character asset rules:

- one shared world scale
- one shared forward axis
- one shared humanoid rig for all runner presets
- stable bone, mesh, material, and attachment names
- consistent origin at the gameplay capsule base or agreed character root
- reusable materials and texture atlases where possible
- low texture budgets until gameplay readability is proven
- modular parts authored to the same attachment points
- no mesh-driven collision
- no cosmetic part may change gameplay capsule size
- no runtime code should compensate for avoidable scale, pivot, or orientation mistakes in source assets

Recommended source-to-runtime flow:

1. Author or edit source assets in Blender or another DCC tool.
2. Normalize transforms, pivots, scale, and orientation.
3. Export GLB or glTF 2.0.
4. Optimize with glTF Transform for prune, dedupe, texture packaging, and optional mesh compression.
5. Validate in the CCA R3F scene against the gameplay capsule, camera distance, and HUD.
6. Add the asset only after desktop browser performance and readability are acceptable.

MVP should not wait for this pipeline. The first playable slice should use procedural capsule/mannequin visuals and reserve GLB work for the visual identity pass.

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
GameplayCapsule
VisualCharacterPreset
CharacterAnimationState
CharacterAssetManifest
CharacterAttachmentPoint
PlayerControlInput
MoveIntent
MovementActionFlags
CameraIntent
CameraMode
DashState
VaultAttempt
VaultResult
CashChaseMotionSampleMetadata
CashChaseMotionDiscontinuityReason
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

The renderer may maintain camera smoothing locally, but it must not send renderer objects or non-serializable camera state across Rallar. Camera smoothing is separate from Rallar Motion: the camera follows the locally rendered player pose, while Rallar Motion smooths network-observed entity poses.

## Rallar Motion Placement

Use Rallar Motion for received snapshot presentation, not for input interpretation or simulation.

`DirectorSnapshot` should be converted into per-entity motion samples for:

- other runners
- Sentinels
- pickups or cash tokens if they move
- moving gates, platforms, or mission props
- the local runner only when reconciling prediction against director truth

Suggested sample metadata:

```text
snapshotSeq
directorTick
sentAtEpochMs
movementState
playerState
activeVault
cosmeticLoadoutId
entityKind
```

Use `observedAtEpochMs` from the local receiver clock when pushing samples into Rallar Motion. Keep `sentAtEpochMs` as metadata for diagnostics unless CCA later adds explicit clock synchronization.

Discontinuities should snap or hold rather than interpolate through impossible space for:

- dash correction beyond the normal blend threshold
- respawn
- caught state
- cash-out exit
- spectator handoff
- late-join sync snapshot
- director recovery snapshot

Local prediction correction should use a correction blender. Small director disagreements blend over a short window; large disagreements snap and emit a debug event. The simulation remains authoritative either way.

## Implementation Placement

`packages/cash-chase-core` owns:

- input type definitions
- fixed gameplay capsule definition
- movement state machine
- stamina rules
- dash legality
- vault legality
- cosmetic schema
- cosmetic loadout IDs and gameplay stat invariants
- Rallar Data validation for local cosmetic loadout selection persistence
- tests

`apps/cash-chase-arena` owns:

- keyboard/mouse event capture
- pointer lock or pointer drag behavior
- React Three Fiber camera rig
- `CashChaseMotionPresenter` that owns Rallar Motion buffers for render poses
- camera smoothing
- camera obstruction handling
- threat-assist presentation
- character mesh composition
- character asset loading and GLB/glTF validation
- animation clip mapping and blending
- debug display of gameplay capsule versus visual mesh
- cosmetic selection UI
- HUD hints and binding display

`RallarMatchRuntime` owns:

- input send cadence
- input sequence numbers
- stale input handling
- director-side input validation before simulation
- snapshot publication
- accepted snapshot delivery into the motion presenter

## Iteration Placement

### Iteration 0

Define types and defaults:

- gameplay capsule
- cosmetic loadout
- character preset
- visual character preset
- character animation state
- player control input
- camera intent
- movement action flags

Add unit tests proving cosmetics do not change gameplay stats.

Persist selected loadout and local cosmetic UI preferences through Rallar Data only after the basic runtime can already render local and remote capsules.

### Iteration 1

Build the character vertical slice with simple R3F capsules for neon athlete runners.

Implement:

- fixed gameplay capsule rendered in debug mode
- three simple visual silhouettes
- six accent colors
- WASD camera-relative input
- mouse orbit
- third-person soft-follow camera
- Rallar Motion buffers for remote capsule interpolation
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
- dash trail and vault placeholder animation driven by simulation state

### Iteration 3

Add the first visual character production layer:

- simple modular mannequin
- headgear, torso, legs, accent color, and trail FX slots
- six to eight curated presets
- in-place animation states for idle, jog, sprint, dash, vault, interact, caught, cash-out, and spectator
- Rallar AI-assisted preset names and colorway drafts, validated as cosmetic-only data

### Iteration 4+

Move toward shippable assets:

- one shared humanoid rig
- GLB or glTF 2.0 character export
- glTF Transform optimization
- stable asset manifest
- attachment-point validation
- browser performance checks
- optional mix-and-match customization

### Later Tuning

Tune:

- camera obstruction handling
- threat assist
- outfit modularity
- animation transitions
- GLB asset budgets
- LOD strategy if repeated characters become expensive
- gamepad support
- optional touch controls

## Test Plan

### Unit Tests

Cover:

- all cosmetic presets resolve to identical gameplay stats
- cosmetic loadout IDs map to visual data without changing simulation constants
- persisted loadout selection validates against known presets before use
- gameplay capsule dimensions are invariant across presets
- movement input normalization
- camera yaw to world move vector conversion
- sprint stamina drain and recovery
- dash cooldown and direction fallback
- vault eligibility by distance, angle, speed, and destination clearance
- interact eligibility by distance and match phase
- stale and duplicate input sequence rejection
- snapshot-to-motion-sample conversion
- duplicate and stale motion sample rejection by sequence
- discontinuity classification for dash, respawn, cash-out, spectator, and recovery transitions
- animation state mapping from movement/player state
- character asset manifest validation for required slots and attachment names

### Browser Tests

Cover:

- debug overlay can show gameplay capsule versus visual mesh
- keyboard movement changes local input intent
- mouse orbit changes camera intent
- pointer lock or pointer capture is released on menu open
- `Shift` toggles sprint intent
- `Q` and `Ctrl` trigger dash intent
- `Space` triggers jump/vault intent
- `E` triggers interact intent
- HUD and menu states gate camera input
- remote capsule render pose continues briefly during one or two missed snapshots and then settles to a held pose
- local prediction correction blends small errors and snaps large errors
- cosmetic preset changes update visual identity without changing movement or collision

### Visual QA

Cover:

- gameplay capsule and visual mesh stay aligned at idle, sprint, dash, vault, caught, and cash-out states
- character silhouettes remain readable at camera distance
- Rallar Motion smoothing improves remote motion without adding visible rubber-banding
- modular outfit parts do not obscure gameplay state
- animation does not visually imply a larger interact or collision range
- GLB/glTF assets keep consistent scale, orientation, pivots, and material budgets
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
- root-motion-driven authoritative movement
- mesh-derived collision
- character-specific rigs in MVP
- asset-heavy GLB character pipeline before the capsule/mannequin vertical slice works
