# Cash Chase Arena — Characters, Controls, Camera, and Presentation Plan

Updated: July 13, 2026

## Document authority

This document refines presentation and input behavior under the product and architecture decisions in:

- `Cash_Chase_Arena_Product_Owner_Document.md`
- `Cash_Chase_Arena_Rallar_React_Three_Plans.md`
- `Cash_Chase_Arena_Engineering_Standards.md`

It is renderer-neutral. It may not introduce another networking, state, persistence, physics, or renderer framework, and it may not move authority out of the pure simulation.

## Locked domain decisions

- Every runner uses the same fixed gameplay capsule and gameplay constants.
- Character identity is cosmetic only in MVP.
- Gameplay, visual, and animation tracks remain separate.
- The simulation moves the capsule; animation is in-place presentation.
- The first visual slice is procedural neon capsules/mannequins.
- GLB/glTF assets and a shared rig come only after procedural play is fun and measured.
- Keyboard and mouse are the active-play MVP target.
- Movement is fast, readable parkour chase: move, sprint, dash, contextual vault, interact.
- There is no free jump, combat, slide, roll, wall-run, crouch, or respawn in MVP.
- Primary camera is third-person soft follow with mouse orbit, obstruction handling, and restrained threat assist.
- Rallar Motion owns received-pose presentation, not camera behavior or simulation.
- React owns DOM UI only; the selected renderer owns scene objects and per-frame transforms.
- Essential gameplay information is never communicated by color alone or audio alone.

## Character model

### Gameplay character

`packages/cash-chase-arena` owns a renderer-neutral fixed capsule and authoritative fields:

```text
participantId
position
velocity
facingYaw
movementState
stamina
dashCooldownTicks
activeVault
playerState: active | caught | cashed-out | spectator
cosmeticPresetId
```

All presets share:

- capsule radius and height;
- walk/sprint speed and acceleration;
- stamina drain/recovery;
- dash distance/duration/cooldown;
- vault eligibility and duration;
- interact range;
- Sentinel detection/tag rules;
- scoring and cash-out behavior.

The pure package must not import renderer assets, meshes, materials, skeletons, animation clips, React, Rallar runtime code, DOM types, or browser storage.

### Visual character

Progression:

1. Procedural capsule with readable head/facing marker and accent pattern.
2. Procedural modular mannequin with headgear, torso, legs, accent, and trail slots.
3. Six to eight curated complete presets.
4. One shared humanoid rig and validated GLB/glTF assets after the renderer and performance gates.
5. Optional mix-and-match only after readability and asset budgets are proven.

Visual differences may change silhouette within a defined fairness envelope but may not hide the runner, obscure state, alter the capsule, or imply a larger interact/tag range. A debug view must overlay capsule and visual bounds.

### Original visual direction

- Futuristic chase-sport athletes, not soldiers or superheroes.
- Aerodynamic layers, strong shape blocking, luminous accents, readable head silhouettes, lightweight leg gear, and restrained trails.
- Use shape/pattern/icon differences as well as color.
- Avoid references to existing show names, costumes, masks, uniforms, music, signage, camera language, or branded UI.
- Run an independent assembled-presentation originality review before external marketing/assets.

### Cosmetic schema

MVP distributes curated preset IDs, not arbitrary cosmetic structures in every snapshot:

```ts
type CosmeticPresetId = string;

type CharacterVisualPreset = Readonly<{
  id: CosmeticPresetId;
  silhouetteId: string;
  headgearId: string;
  torsoId: string;
  legsId: string;
  accentColor: string;
  accentPattern: string;
  trailFxId: string;
}>;
```

The selected local ID persists through Rallar Data and validates against known presets. Reliable setup/profile state distributes the accepted preset/manifest revision. High-rate snapshots carry only `cosmeticPresetId`.

## Animation

Simulation emits semantic presentation state:

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

- Clips are in place; visual root follows the authoritative/presented capsule.
- Clip timing never changes movement, dash, vault, interact, catch, or cash-out legality.
- Imported root motion is stripped or ignored.
- Remote animation reads Rallar Motion estimates plus snapshot metadata, never raw packets.
- Recovery/catch/cash-out discontinuities snap or transition deliberately rather than blending through impossible space.
- Reduced-motion mode shortens/removes nonessential trails, FOV pulses, afterimages, and camera easing without hiding state.

## Asset pipeline

Runtime format after the procedural MVP: GLB or glTF 2.0.

Rules:

- one world scale and forward axis;
- one shared rig for runner presets;
- stable mesh, bone, material, clip, and attachment names;
- consistent character-root origin aligned to the capsule base;
- reusable materials/texture atlases and explicit texture budgets;
- no mesh-driven collision or runtime compensation for avoidable source errors;
- renderer-neutral manifest and validator in the app/pure contract boundary;
- optional glTF Transform CLI is dev-only and added when real GLBs exist.

Asset acceptance records compressed transfer size, decoded texture memory, mesh/triangle/material counts, draw-call effect, scale/orientation/pivot, animation mapping, capsule alignment, and disposal behavior.

## Input architecture

### Action abstraction

Input capture produces actions rather than directly mutating simulation:

```text
move
look
sprint
dash
vault
interact
status overlay
pause/menu
```

Every gameplay action is remappable. Settings include mouse sensitivity, invert-Y, hold/toggle choices where appropriate, reduced intensity, and conflict detection.

### Default keyboard/mouse bindings

```text
WASD       camera-relative move
Mouse      orbit camera and facing intent
Shift      sprint while stamina is available
Space      contextual vault; no free jump in MVP
Q          evasive dash
Ctrl       alternate dash binding
E          interact
Tab        compact match/status overlay
Esc        pause/menu and release pointer lock
```

### Network input payload

Rallar Game envelope supplies trusted sender, sequence, sender time, match, and director epoch. CCA payload contains only game input:

```ts
type CashChaseInput = Readonly<{
  version: 1;
  clientTick: number;
  moveX: number;
  moveY: number;
  cameraYaw: number;
  sprintHeld: boolean;
  dashPressed: boolean;
  vaultPressed: boolean;
  interactPressed: boolean;
}>;
```

Rules:

- clamp axes to `[-1, 1]` and normalize diagonals;
- normalize/wrap yaw;
- reject invalid numbers and implausible client ticks;
- edge actions are consumed once by envelope sequence and are never repeated from held fallback;
- director validates phase, player state, cooldown, stamina, proximity, target state, and rate;
- no payload `playerId`, transport sequence, send timestamp, or authority epoch is trusted or duplicated.
- at the simulation boundary, axes and yaw are quantized according to the engineering deterministic contract; presentation may retain higher precision, but authoritative movement stores quantized position, velocity, and orientation.
- Node, Chromium, Firefox, and WebKit fixtures must agree on authoritative camera-relative movement hashes before Gate 1 exits.

### Input/UI boundaries

Movement/look capture is gated when:

- lobby, pause, settings, results, or blocking error is active;
- a text/form control has focus;
- pointer lock/capture is absent when required;
- document visibility/background policy pauses active input;
- authority is stale or recovery is active.

Opening a menu releases pointer lock/capture and clears held/edge actions. Blur, visibility change, pointer cancel, disconnect, room switch, and unmount reset input state.

A duplicate tab/session for the same scoped participant cannot control a second runner. Late joiners and reconnects after the gameplay grace period enter spectator mode until the next readiness cycle.

### Device scope

- Keyboard/mouse is the tuned MVP path.
- Gamepad mapping is post-MVP unless accessibility testing elevates it.
- Touch-only active play is unsupported in MVP; mobile lobby/spectator UI must state this before start.

## Movement

### Move and sprint

- Camera-relative movement on the horizontal plane.
- Shared acceleration/deceleration and maximum speeds.
- Sprint drains stamina while active and recovers after a configured delay.
- Direction changes remain readable and deterministic; renderer smoothing cannot change the simulation path.

### Dash

- Short directionally controlled evasive burst.
- Uses current move direction, falling back to facing.
- Cooldown- and state-gated; cannot become sustained travel.
- Simulation owns position/path/collision; renderer may add restrained trail/FOV/afterimage cues.

### Contextual vault

Vault begins only when:

- a marked low obstacle is within configured distance;
- approach direction/angle and minimum speed are valid;
- destination capsule is clear and in bounds;
- player is active and not already dashing/vaulting/interacting;
- authoritative cooldown/state permits it.

If invalid, `Space` is a no-op. The result is deterministic and serializable; animation cannot extend or redirect the vault.

### Interact

`E` requests interaction with the best eligible nearby object. Director validates participant, phase, distance, line/obstruction rule, object state, cooldown, and mission/cash-out eligibility. UI may preview a prompt but never decides success.

## Camera

### Primary chase camera

- Behind and above the locally presented runner.
- Slight configurable shoulder offset.
- Mouse orbit yaw and limited pitch.
- Smooth position/look target based on presentation time, not simulation authority.
- Camera-relative movement uses local camera yaw sampled into input.
- Obstruction handling shortens camera distance against walls/large obstacles and restores smoothly.
- Active play keeps center/lower-middle clear.

Initial tuning hypotheses:

```text
distance: 5.5–7.0 world units
height: 2.8–4.0 world units
shoulder offset: 0.45–0.8 world units
pitch: -25° to 55°
normal FOV: 65–72° equivalent
position follow feel: 120–220 ms
look-target feel: 80–160 ms
sprint FOV lift: small
dash FOV pulse: optional and disabled by reduced motion
```

### Threat assist

- Nearest chasing Sentinel may bias look target slightly.
- Never overrides direct mouse orbit or hard-locks.
- Off-screen threat uses edge/icon/pattern plus restrained audio cue.
- Close pursuit may use small FOV/audio/intensity changes.
- Threat state is readable with audio muted and without color perception.

### Camera states

```text
lobbyShowcase
activeChase
interactionFocus
spectator
results
debugFreeCamera
```

`debugFreeCamera` is operator-only and never changes simulation/input authority.

## Rallar Motion placement

Accepted authoritative snapshots become per-entity samples for runners, Sentinels, and dynamic props. Metadata may include:

```text
snapshotRevision
directorTick
sender timestamp for diagnostics only
movementState
playerState
activeVault
cosmeticPresetId
entityKind
authorityEpoch
```

Use receiver-local observed time. Motion tracks support interpolation, bounded extrapolation, confidence/mode diagnostics, and removal. The local runner uses Motion/correction only to reconcile prediction with director truth.

Discontinuities include:

- large dash/prediction correction;
- caught or cash-out transition;
- late-join full sync;
- authority recovery snapshot;
- match/epoch change;
- entity spawn/despawn or arena relocation.

During director migration, active input is frozen, the camera holds the last safe presentation frame, and the recovery commit/full snapshot clears prediction and old Motion tracks before presentation resumes under the higher authority epoch.

## Audio presentation

Use native Web Audio:

- user-gesture unlock and suspended-context recovery;
- master/music/SFX/threat buses;
- bounded active voices and no unbounded oscillator/buffer retention;
- mission alert, success/failure, interact, dash, caught, cash-out, Sentinel proximity, recovery, and result cues;
- adaptive intensity with reduced-intensity mode;
- teardown on room leave/logout/unmount;
- explicit recovery from audio interruption without blocking gameplay;
- every essential audio cue has a visual/text equivalent.

No external audio framework is part of MVP.

## Accessibility

- Semantic DOM for lobby, settings, errors, objective, and results.
- Keyboard/focus operability and visible focus.
- Remapping with conflict warnings and restore defaults.
- HUD scale, contrast, reduced motion, reduced audio intensity, sensitivity, invert-Y.
- Shape/pattern/text redundancy for teams/state/objectives/threats.
- Avoid flashing and aggressive shake; preserve readable safe areas at zoom.
- Announce blocking connection/recovery/error state in accessible DOM without spamming high-rate changes.

## Ownership map

### `packages/cash-chase-arena`

- fixed capsule and movement constants;
- input payload and validators;
- movement/sprint/dash/vault/interact rules;
- character presentation enums and cosmetic preset IDs;
- snapshot/checkpoint presentation fields;
- deterministic tests.

### `apps/cash-chase-arena`

- keyboard/mouse capture, remapping, pointer lock/capture;
- worker bridge and Rallar adapter;
- Motion presenter;
- renderer/camera/character meshes/animations/effects;
- GLB loading/manifest validation;
- Web Audio;
- React HUD/settings/accessibility UI;
- lifecycle/resource diagnostics.
- explicit `visibilitychange`, `pagehide/pageshow`, offline/online, audio interruption, and WebGL context-loss transitions.

### Rallar

- identity, room, presence, transport, game envelope/order/authority, readiness, diagnostics, recovery orchestration, Motion toolkit, and local Data.

## Implementation gates

1. Define pure capsule/input/presentation contracts and fairness tests.
2. Prove local movement/camera intent and remote Motion poses in a DOM/debug renderer.
3. Prove sprint, dash, contextual vault, interact, caught/cash-out/spectator states.
4. Run renderer bake-off with procedural capsules and camera obstruction.
5. Integrate selected renderer, procedural mannequin/presets, audio, accessibility, and visual QA.
6. Add shared rig/GLB assets only after performance and readability gates.

## Test plan

### Pure tests

- all presets resolve to identical gameplay constants/capsule;
- input validation, axis normalization, yaw wrap, edge-action consumption;
- camera yaw to world movement;
- sprint drain/recovery;
- dash direction, cooldown, collision, and state gating;
- vault distance/angle/speed/destination/state eligibility;
- interact target selection and director eligibility;
- caught/cash-out/spectator transitions;
- snapshot/presentation mapping and compact preset ID;
- Motion discontinuity classification and prediction correction thresholds;
- character manifest/attachment/clip validation.

### Browser tests

- visible create/join/start then keyboard movement through human controls;
- remapping/conflict/reset and settings persistence through Rallar Data;
- pointer lock/capture release and input reset on every boundary;
- remote pose interpolation/hold and local correction behavior;
- camera obstruction and threat assist do not hijack control;
- cosmetic change affects visuals only;
- reduced motion/intensity, HUD scale, keyboard focus, non-color cues;
- audio unlock/mute/voice cap/teardown;
- renderer mount/load/resize/dispose cycles do not retain resources.
- context-loss restore rebuilds renderer-owned resources from current presentation state without changing simulation state;
- background/resume clears input edges and cannot replay dash, vault, or interact;
- duplicate-session, late-join spectator, disconnect-grace, voluntary-leave, and rematch input ownership follow the product lifecycle rules.

### Visual QA

- capsule and visual bounds align in every movement/player state;
- silhouettes remain readable at camera distance without color alone;
- camera never exposes persistent clipping or disorienting forced rotation;
- HUD preserves center/lower-middle play area at supported viewport/zoom;
- Motion improves remote movement without visible over-extrapolation;
- effects/audio remain restrained and state-readable;
- later GLBs meet transfer, decode, GPU, draw-call, scale, rig, pivot, and material budgets.

## MVP non-goals

- gameplay-changing characters, classes, perks, abilities, combat;
- free jump, wall-run, slide, roll, crouch, respawn/reentry;
- root-motion authority or mesh collision;
- first-person/top-down modes;
- full touch controller or tuned gamepad;
- R3F, Drei, postprocessing, physics, audio, state, networking, or persistence frameworks;
- asset-heavy character pipeline before the procedural vertical slice is fun and within budget.
