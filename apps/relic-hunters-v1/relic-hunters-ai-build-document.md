# Relic Hunters: Turn-Based Expedition — AI Build Document

## Purpose of This Document

This document describes a turn-based first-person relic-hunting game in a way that an AI coding assistant can use to help design, implement, test, and extend the game.

The game should be implemented as a small but expandable turn-based adventure where players explore ancient ruins, inspect clues, choose hidden actions, bluff with decoys, collect relics, and escape before the ruin collapses.

The visual presentation should use first-person 3D scenes and animations, while the core game logic should remain discrete, deterministic, and easy to test.

---

# 1. Game Summary

## Game Title

**Relic Hunters: Turn-Based Expedition**

## Genre

Turn-based multiplayer adventure game with first-person 3D presentation.

## Core Fantasy

Players are rival relic hunters entering a dangerous ancient ruin. Each hunter wants to discover valuable relics, mislead rivals, avoid traps, interpret clues, and escape before the ruin collapses.

## Core Experience

The player should feel like they are:

- Carefully observing a dangerous room
- Reading clues before committing to an action
- Bluffing and predicting rival hunters
- Watching each turn resolve like a short cinematic story
- Escaping with legendary treasure at the last possible moment

## Main Design Pillar

> The game logic is a simple turn-based graph game underneath, but the player experiences it as a cinematic first-person 3D expedition.

---

# 2. High-Level Game Loop

Each round has five phases:

```text
1. Observation Phase
2. Planning Phase
3. Reveal Phase
4. Resolution Phase
5. Ruin Phase
```

## 2.1 Observation Phase

Each player can inspect a limited number of things before choosing an action.

Example inspection targets:

- Altar
- Floor
- Doorway
- Statue
- Ceiling
- Wall cracks
- Footprints
- Relic glow
- Strange sound

The player receives clues, not perfect information.

Example clue:

```text
A thin wire catches the torchlight near the north door.
```

This may suggest a trap, but does not directly say:

```text
There is a trap.
```

## 2.2 Planning Phase

Each player secretly chooses one main action.

Possible actions:

- Move
- Search
- Steal
- Rest
- Set trap
- Disarm trap
- Escape

For the MVP, use only:

- Move
- Search
- Steal
- Escape

## 2.3 Optional Decoy

Each player has one decoy per match.

The decoy creates a false clue, usually a fake movement trace.

Example:

```text
The player stays in the Hallway but creates footprints toward the Shrine.
```

The decoy affects what other players can observe. It does not change the true game state.

## 2.4 Reveal Phase

All selected actions are revealed.

The reveal should feel dramatic and narrative.

Example:

```text
Alice reaches for the altar.
Bob follows footprints toward the Shrine.
Clara moves silently toward the exit.
```

## 2.5 Resolution Phase

The game resolves the selected actions.

Resolution handles:

- Movement
- Searches
- Relic discovery
- Stealing
- Traps
- Escape attempts
- Noise
- Player conflicts

## 2.6 Ruin Phase

The ruin reacts.

Possible effects:

- Room becomes unstable
- Room collapses
- Monster warning appears
- Monster moves
- New trap activates
- Noise spreads
- Collapse timer advances

---

# 3. Core Game Rules

## 3.1 Players

Each player controls one relic hunter.

Each hunter has:

```text
id
displayName
role
currentRoomId
health
relicInventory
hasEscaped
isDefeated
decoyAvailable
score
```

Recommended starting values:

```text
health: 3
decoyAvailable: true
hasEscaped: false
isDefeated: false
score: 0
```

## 3.2 Rooms

The map is made of discrete connected rooms.

Each room has:

```text
id
name
description
connectedRoomIds
roomType
isExit
isCollapsed
isUnstable
hiddenRelics
knownRelics
traps
noiseLevel
dangerLevel
clueSources
```

Example room types:

```text
Entrance
Hallway
Shrine
TreasureChamber
TrapRoom
MonsterLair
HiddenPassage
Exit
```

## 3.3 Map

The map is a graph.

Players move from one room to an adjacent connected room.

The player should experience this visually as first-person 3D movement, but the internal game state should remain simple.

Example:

```text
Entrance -- Hallway -- Shrine
    |          |          |
Storage -- TrapRoom -- TreasureChamber
               |
          MonsterLair
               |
              Exit
```

## 3.4 Relics

Relics are the main source of points.

Each relic has:

```text
id
name
value
rarity
effectType
isCursed
description
```

Example relics:

| Name          | Value | Effect                        |
| ------------- | ----: | ----------------------------- |
| Golden Idol   |     5 | No special effect             |
| Cursed Mask   |     8 | Valuable but dangerous        |
| Oracle Stone  |     4 | Reveals one clue more clearly |
| Sun Disk      |     6 | Protects from one trap        |
| Serpent Crown |     7 | Increases monster attention   |

## 3.5 Health

Recommended MVP health:

```text
3 health per player
```

Damage examples:

| Source          |      Damage |
| --------------- | ----------: |
| Minor trap      |           1 |
| Monster attack  |         1–2 |
| Collapsing room | 2 or defeat |
| Curse           |     special |

Avoid early hard elimination if possible. A defeated player may drop relics and return to the entrance instead.

---

# 4. Player Actions

## 4.1 Move

Move to an adjacent connected room.

Input:

```text
targetRoomId
```

Rules:

- Target room must be connected to the current room.
- Target room must not be collapsed.
- Movement creates low noise.
- Movement may trigger traps or room hazards.

Example result:

```text
Alice moves from the Hallway to the Shrine.
```

## 4.2 Search

Search the current room.

Rules:

- May reveal a relic.
- May reveal a hidden passage.
- May trigger a trap.
- Creates medium noise.
- Gives the player something meaningful if successful.

Example result:

```text
Alice searches the altar and finds the Oracle Stone.
```

## 4.3 Steal

Attempt to steal from another player in the same room.

Input:

```text
targetPlayerId
```

Rules:

- Target player must be in the same room.
- Target player must have at least one relic.
- Success may depend on simple deterministic rules, role bonuses, or random seed.
- Creates high noise.
- On success, steal one relic.
- On failure, create a dramatic failed attempt event.

Example result:

```text
Clara reaches for Bob's satchel, but Bob has already moved away.
```

## 4.4 Escape

Attempt to leave the ruin.

Rules:

- Player must be in an exit room.
- Escaping locks in the player's score.
- Escaped players no longer submit normal actions.
- Escaping early is safe but may reduce treasure opportunities.

Example result:

```text
Alice escapes the ruin with the Cursed Mask and the Sun Disk.
```

## 4.5 Set Trap

Later expansion action.

Rules:

- Places a trap in the current room.
- Trap may affect the next player entering or searching the room.
- Creates medium noise.

## 4.6 Disarm Trap

Later expansion action.

Rules:

- Attempts to remove a known or suspected trap.
- May fail and trigger the trap.
- Guardian role may have a bonus.

## 4.7 Rest

Later expansion action.

Rules:

- Restores one health or removes a minor curse.
- Creates no noise.
- Consumes a turn.

---

# 5. Decoy System

## 5.1 Purpose

Decoys create bluffing and misdirection.

Each player has one decoy per match.

## 5.2 MVP Decoy

The MVP decoy should be:

```text
Fake Movement Clue
```

The player creates a false clue suggesting they moved to an adjacent room.

Example:

```text
Real action: Search Hallway
Decoy: Fake movement toward Shrine
```

Other players may observe:

```text
Fresh footprints lead from the Hallway toward the Shrine.
```

But the player actually stayed and searched.

## 5.3 Decoy Rules

- A decoy does not move the player.
- A decoy does not alter true room state.
- A decoy only adds false clue data.
- A decoy must be plausible.
- A decoy can only point to an adjacent room.
- Strong observation may detect that the clue is suspicious.

## 5.4 Decoy Detection

Possible detection clue:

```text
The footprints look deliberate, almost too neat.
```

This suggests a decoy without fully confirming it.

---

# 6. Clue System

## 6.1 Purpose

The clue system gives players partial information before choosing actions.

Clues should create deduction, suspicion, and tension.

## 6.2 Clue Categories

### Player Clues

Reveal traces of other hunters.

Examples:

```text
Fresh footprints lead toward the Shrine.
Someone recently searched this room.
You hear a satchel buckle behind the east door.
```

### Relic Clues

Hint at treasure.

Examples:

```text
A golden shimmer leaks from a cracked stone box.
The altar hums softly.
The air around the statue feels warm.
```

### Trap Clues

Warn careful players.

Examples:

```text
One floor tile sits slightly lower than the others.
A thin wire catches the torchlight.
Old blood marks stain the doorway.
```

### Monster Clues

Build suspense.

Examples:

```text
Something large is breathing nearby.
Claws scrape against stone.
A shadow moves behind the wall.
```

### Collapse Clues

Communicate room danger.

Examples:

```text
Dust falls from the ceiling.
The support pillar groans.
The west wall has widened cracks.
```

## 6.3 Clue Quality

Clues can have quality levels.

```text
Weak
Clear
Strong
```

Example:

Weak:

```text
You think you hear movement.
```

Clear:

```text
You hear footsteps behind the north door.
```

Strong:

```text
You recognize Bob's bootprints leading north.
```

## 6.4 Observation Limits

For the MVP:

```text
Each player may inspect up to 2 targets per round.
```

Inspection does not consume the main action.

## 6.5 Private Information

Clues are private to the observing player unless intentionally shared.

This supports bluffing.

---

# 7. Noise System

## 7.1 Purpose

Noise makes the ruin feel alive and dangerous.

Actions create noise.

Noise may trigger ruin events.

## 7.2 Suggested Noise Values

| Action      | Noise |
| ----------- | ----: |
| Rest        |     0 |
| Move        |     1 |
| Disarm trap |     1 |
| Search      |     2 |
| Set trap    |     2 |
| Steal       |     3 |

## 7.3 Noise Feedback

Noise should be shown visually and narratively.

Example:

```text
The sound echoes through the corridor.
Something below the ruin hears it.
```

Possible visual effects:

- Dust pulse
- Sound wave shimmer
- Torch flicker
- Door vibration
- Monster growl in distance

---

# 8. Ruin Collapse System

## 8.1 Purpose

The collapse timer creates urgency.

## 8.2 Recommended Match Length

```text
10 rounds
```

## 8.3 Collapse Stages

| Round | State                 |
| ----: | --------------------- |
|   1–3 | Stable                |
|   4–6 | Warning signs         |
|   7–9 | Rooms become unstable |
|    10 | Final escape pressure |
|   11+ | Collapse              |

## 8.4 Ruin Events

Possible events:

```text
Room becomes unstable
Unstable room collapses
Monster warning appears
Trap activates
Exit route becomes dangerous
Noise attracts danger
```

## 8.5 Collapse Feedback

Bad:

```text
3 rounds remaining.
```

Better:

```text
The ruin groans. You may have only 3 rounds left.
```

---

# 9. Characters

The characters should be cool-looking but easy to model, rig, and animate.

Important character design rules:

- Strong silhouette
- Clear color blocks
- Simple layered clothing
- Minimal tiny decorations
- Modular accessories
- Few cloth-simulation requirements
- Animation-friendly hands, feet, torso, and legs
- Distinct role identity
- One signature prop per character

## 9.1 Scout

### Fantasy

Fast, careful, observant explorer.

### Visual Identity

- Hood
- Short cloak
- Light expedition clothes
- Rope coil
- Small lantern
- Compact satchel

### Implementation-Friendly Traits

- Simple silhouette
- Modular gear
- Easy rig
- Few dangling parts
- Good first-person hand visibility

### Possible Gameplay Bonus

Better movement and footprint clues.

### Signature Prop

Lantern or rope.

---

## 9.2 Scholar

### Fantasy

Relic expert and ruin interpreter.

### Visual Identity

- Long vest or short coat
- Relic amulet
- Scroll case or book satchel
- Gloves
- Practical boots

### Implementation-Friendly Traits

- Clear color blocks
- Single signature prop
- Few cloth layers
- Easy facial expression set
- Good inspection animation potential

### Possible Gameplay Bonus

Better relic and curse clues.

### Signature Prop

Relic amulet or scroll case.

---

## 9.3 Trickster

### Fantasy

Stealthy rival hunter who misleads others.

### Visual Identity

- Asymmetric scarf
- Light leather armor
- Belt pouches
- Sheathed curved dagger
- Confident stance

### Implementation-Friendly Traits

- Sleek silhouette
- Modular accessories
- Easy rig
- Strong personality animation
- Minimal cloth simulation

### Possible Gameplay Bonus

Improved decoy or stealing.

### Signature Prop

Curved dagger or scarf.

---

## 9.4 Guardian

### Fantasy

Strong protector and trap-resistant expedition member.

### Visual Identity

- Broad silhouette
- Heavy expedition gear
- Padded armor
- Gauntlets
- Utility belt
- Relic shield charm

### Implementation-Friendly Traits

- Strong silhouette
- Modular gear
- Clear color blocks
- Simple heroic animation set
- Easy readable poses

### Possible Gameplay Bonus

Better trap resistance and disarm actions.

### Signature Prop

Relic shield charm or gauntlets.

---

# 10. First-Person 3D Presentation

## 10.1 Core Visual Approach

The game should feel first-person, but movement should be discrete.

The player does not freely run through the ruin.

Instead, the player chooses from valid options:

```text
Move to Hallway
Move to Shrine
Search altar
Inspect floor
Escape
```

The game then plays short first-person animations.

## 10.2 Movement Animation

When a player moves to another room:

```text
Camera glides forward
Corridor passes by
Door or archway opens
New room appears
```

The animation should be short and skippable.

## 10.3 Search Animation

Possible search sequence:

```text
Hands reach toward altar
Dust is brushed away
Stone compartment opens
Relic glow appears
```

## 10.4 Trap Animation

Possible trap sequence:

```text
Floor tile sinks
Click sound plays
Camera shakes
Spike shadow flashes
Player loses health
```

## 10.5 Steal Animation

Possible steal sequence:

```text
A hand reaches toward a rival satchel
The rival turns
Success or failure is shown
```

## 10.6 Escape Animation

The winner's escape should be cinematic.

Sequence:

```text
Camera rushes through collapsing corridor
Dust and stones fall
Exit light grows brighter
Player bursts into daylight
Ruin collapses behind them
```

---

# 11. Winner Prize and Ending

## 11.1 Main Prize

The final prize should be:

```text
The Heart Relic
```

Each ruin can have a different Heart Relic name.

Examples:

```text
The Heart of the Sunken Temple
The Moon-Eye Idol
The Crown of the First Hunter
The Oracle Flame
The Starstone Skull
The Serpent King's Heart
```

## 11.2 Winner Animation

End sequence:

```text
1. First-person escape from collapsing ruin
2. Burst into daylight
3. Ruin collapses behind the hunter
4. Hunter opens hand or satchel
5. Heart Relic floats and glows
6. Ancient symbols rotate around it
7. Victory title appears
```

Example victory text:

```text
The Heart Relic has chosen its hunter.
```

## 11.3 Victory Screen

Show:

```text
Winner name
Hunter role
Heart Relic claimed
Final score
Relics collected
Score breakdown
Expedition chronicle
```

## 11.4 Losing Player Endings

Each losing player should receive a small narrative ending.

Examples:

```text
Bob escaped bruised but alive.
Clara was last seen chasing whispers beneath the Shrine.
David escaped empty-handed, carrying only a broken map.
```

---

# 12. Feedback and Fun

The feedback system is critical.

The game should not simply update numbers. Each turn should feel like a mini story.

## 12.1 Round Chronicle

Each round should generate a short narrative summary.

Example:

```text
Round 5 — Greed Echoes Loudly

Alice searched the Shrine and found the Cursed Mask.
Bob followed footprints toward the exit.
Clara tried to steal from Alice, but Alice was already gone.

The Cursed Mask whispered.
The noise reached the Monster Lair.

A guardian is coming.
```

## 12.2 Tactical Summary

After the dramatic chronicle, show a clear summary.

Example:

```text
Alice:
- Found Cursed Mask
- Gained 8 potential points
- Created 2 noise

Bob:
- Moved to Exit Route
- Followed a false clue

Clara:
- Failed to steal
- Created 3 noise

Ruin:
- Monster danger increased near Shrine
```

## 12.3 Feedback Tone

The tone should be:

```text
Adventure narrator
Playful danger
Clear tactical summary
```

The game can be dramatic and slightly funny.

---

# 13. Suggested Data Model

The following TypeScript-style interfaces describe the core model.

```ts
export type PlayerId = string;
export type RoomId = string;
export type RelicId = string;
export type TrapId = string;
export type GameId = string;

export type GamePhase =
    | 'observation'
    | 'planning'
    | 'reveal'
    | 'resolution'
    | 'ruin'
    | 'finished';

export type HunterRole =
    | 'scout'
    | 'scholar'
    | 'trickster'
    | 'guardian';

export type RoomType =
    | 'entrance'
    | 'hallway'
    | 'shrine'
    | 'treasure_chamber'
    | 'trap_room'
    | 'monster_lair'
    | 'hidden_passage'
    | 'exit';

export interface GameState {
    gameId: GameId;
    round: number;
    maxRounds: number;
    phase: GamePhase;
    map: RuinMap;
    players: Record<PlayerId, PlayerState>;
    pendingActions: Record<PlayerId, PlayerAction>;
    eventLog: GameEvent[];
    rngSeed: string;
}

export interface RuinMap {
    rooms: Record<RoomId, RoomState>;
}

export interface RoomState {
    id: RoomId;
    name: string;
    description: string;
    type: RoomType;
    connectedRoomIds: RoomId[];
    isExit: boolean;
    isCollapsed: boolean;
    isUnstable: boolean;
    hiddenRelicIds: RelicId[];
    visibleRelicIds: RelicId[];
    trapIds: TrapId[];
    noiseLevel: number;
    dangerLevel: number;
    clueSources: ClueSource[];
}

export interface PlayerState {
    id: PlayerId;
    displayName: string;
    role: HunterRole;
    currentRoomId: RoomId;
    health: number;
    relicIds: RelicId[];
    hasEscaped: boolean;
    isDefeated: boolean;
    decoyAvailable: boolean;
    score: number;
}
```

## 13.1 Actions

```ts
export type PlayerAction =
    | MoveAction
    | SearchAction
    | StealAction
    | EscapeAction
    | SetTrapAction
    | DisarmTrapAction
    | RestAction;

export interface MoveAction {
    type: 'move';
    playerId: PlayerId;
    targetRoomId: RoomId;
    decoy?: DecoyAction;
}

export interface SearchAction {
    type: 'search';
    playerId: PlayerId;
    target?: string;
    decoy?: DecoyAction;
}

export interface StealAction {
    type: 'steal';
    playerId: PlayerId;
    targetPlayerId: PlayerId;
    decoy?: DecoyAction;
}

export interface EscapeAction {
    type: 'escape';
    playerId: PlayerId;
    decoy?: DecoyAction;
}

export interface SetTrapAction {
    type: 'set_trap';
    playerId: PlayerId;
    decoy?: DecoyAction;
}

export interface DisarmTrapAction {
    type: 'disarm_trap';
    playerId: PlayerId;
    targetTrapId?: TrapId;
    decoy?: DecoyAction;
}

export interface RestAction {
    type: 'rest';
    playerId: PlayerId;
    decoy?: DecoyAction;
}

export interface DecoyAction {
    type: 'fake_movement';
    fakeTargetRoomId: RoomId;
}
```

## 13.2 Clues

```ts
export type ClueCategory =
    | 'player'
    | 'relic'
    | 'trap'
    | 'monster'
    | 'collapse'
    | 'decoy';

export type ClueQuality =
    | 'weak'
    | 'clear'
    | 'strong';

export interface ClueSource {
    id: string;
    category: ClueCategory;
    roomId: RoomId;
    isFalse: boolean;
    relatedPlayerId?: PlayerId;
    relatedRoomId?: RoomId;
    relatedRelicId?: RelicId;
    quality: ClueQuality;
    text: string;
}
```

## 13.3 Events

```ts
export type GameEventType =
    | 'round_started'
    | 'player_observed'
    | 'action_revealed'
    | 'player_moved'
    | 'player_searched'
    | 'relic_found'
    | 'steal_succeeded'
    | 'steal_failed'
    | 'trap_triggered'
    | 'player_damaged'
    | 'player_escaped'
    | 'decoy_created'
    | 'room_unstable'
    | 'room_collapsed'
    | 'monster_warning'
    | 'monster_attack'
    | 'game_finished';

export interface GameEvent {
    id: string;
    round: number;
    type: GameEventType;
    publicText: string;
    privateTextByPlayerId?: Record<PlayerId, string>;
    animationCue?: AnimationCue;
}
```

## 13.4 Animation Cues

```ts
export type AnimationCueType =
    | 'camera_move'
    | 'search_altar'
    | 'relic_reveal'
    | 'trap_click'
    | 'damage_shake'
    | 'steal_attempt'
    | 'escape_run'
    | 'heart_relic_victory'
    | 'noise_pulse'
    | 'room_collapse';

export interface AnimationCue {
    type: AnimationCueType;
    roomId?: RoomId;
    playerId?: PlayerId;
    targetPlayerId?: PlayerId;
    relicId?: RelicId;
    durationMs?: number;
    intensity?: 'low' | 'medium' | 'high';
}
```

---

# 14. Deterministic Game Engine Requirements

The game engine should be deterministic.

Given:

```text
previous GameState
submitted PlayerActions
rngSeed
```

It should produce:

```text
next GameState
GameEvents
new rngSeed
```

Main function:

```ts
export function resolveTurn(input: ResolveTurnInput): ResolveTurnOutput;
```

Example:

```ts
export interface ResolveTurnInput {
    state: GameState;
    actions: PlayerAction[];
}

export interface ResolveTurnOutput {
    state: GameState;
    events: GameEvent[];
}
```

Important rules:

- Do not mutate input state directly.
- Validate every action.
- Invalid actions should create clear failure events.
- Keep random decisions seeded and reproducible.
- Store important outcomes as events.
- UI should render from state and events.

---

# 15. Babylon.js Implementation Guidelines

## 15.1 Scene Structure

Use simple scenes and reusable components.

Recommended scene objects:

```text
GameScene
RoomScene
HunterAvatar
FirstPersonHands
RelicMesh
TrapMesh
ClueMarker
NoiseEffect
RuinCollapseEffect
VictoryRelicEffect
```

## 15.2 Room Rendering

Each room should be a small 3D set.

A room can have:

```text
floor
walls
ceiling
doorways
inspection targets
props
lights
particle effects
ambient sound
```

Rooms should be modular.

Example room modules:

```text
Stone floor tile
Wall segment
Door arch
Torch
Altar
Statue
Chest
Broken pillar
Rubble pile
Exit gate
```

## 15.3 First-Person Camera

The player should see:

- Room environment
- First-person hands during interactions
- Inspection targets
- Movement transitions
- Relic reveal animations
- Trap reactions

The camera should not allow free exploration in the MVP.

Instead, camera positions are predefined per room.

Example:

```ts
export interface RoomCameraAnchor {
    roomId: RoomId;
    position: { x: number; y: number; z: number; };
    rotation: { x: number; y: number; z: number; };
}
```

## 15.4 Inspection Targets

Inspection targets should be selectable.

Example targets:

```text
altar
floor
north_door
east_wall
statue
ceiling
chest
footprints
```

Each target can map to possible clues.

## 15.5 Animation Philosophy

Animations should be short and reusable.

Required MVP animation cues:

```text
camera_move
search_altar
relic_reveal
trap_click
damage_shake
steal_attempt
escape_run
heart_relic_victory
noise_pulse
room_collapse
```

Animations should be skippable.

## 15.6 Asset Simplicity Rules

To make implementation easier:

- Prefer modular props over huge unique models.
- Use simple humanoid rigs.
- Avoid complex capes.
- Avoid heavy cloth simulation.
- Avoid too many dangling items.
- Use readable silhouettes.
- Use color blocks instead of dense ornamentation.
- Keep relics visually distinct but simple.

---

# 16. MVP Scope

## 16.1 MVP Features

The first playable version should include:

```text
2–4 players
4 hunter roles
10-room ruin map
10 rounds
Observation phase
Hidden action selection
Move action
Search action
Steal action
Escape action
One decoy per player
Basic relic inventory
Basic scoring
Round chronicle
Simple first-person room view
Short action animations
Victory screen
```

## 16.2 MVP Rooms

Suggested rooms:

```text
Entrance
Hallway
Shrine
Treasure Chamber
Trap Room
Storage
Broken Gallery
Monster Lair
Exit Route
Exit Gate
```

## 16.3 MVP Relics

Suggested relics:

```text
Golden Idol
Cursed Mask
Oracle Stone
Sun Disk
Serpent Crown
```

## 16.4 MVP Hazards

Suggested hazards:

```text
Spike trap
Loose floor
Collapsing ceiling
Monster warning
```

## 16.5 MVP Actions

Only implement:

```text
Move
Search
Steal
Escape
```

Add the following after the core loop is fun:

```text
Set trap
Disarm trap
Rest
Character role bonuses
Advanced relic effects
Campaign mode
```

---

# 17. Scoring

## 17.1 Basic Scoring

| Event           | Points |
| --------------- | -----: |
| Escape alive    |     +5 |
| Common relic    |     +2 |
| Rare relic      |     +5 |
| Legendary relic |     +8 |
| Fail to escape  |     -5 |
| Defeated        |     -3 |

## 17.2 Winner

The winner is the escaped player with the highest score.

If no one escapes, the player with the highest relic value may receive a tragic ending, but should not receive the full victory animation.

## 17.3 Score Breakdown

The end screen should show:

```text
Escape bonus
Relic points
Special bonuses
Penalties
Final score
```

---

# 18. AI Implementation Instructions

When an AI assistant helps implement this game, it should follow these rules.

## 18.1 Keep Game Logic Separate

Do not mix core rules with rendering.

Separate:

```text
game engine
transport
UI state
Babylon scene
animations
assets
```

## 18.2 Prefer Pure Functions

The turn resolver should be mostly pure.

Good:

```ts
const output = resolveTurn({ state, actions });
```

Avoid:

```ts
state.players[id].health -= 1;
```

Unless the mutation is isolated inside a builder or reducer pattern.

## 18.3 Use Events for Feedback

Every important outcome should create a `GameEvent`.

The UI should use events to show:

- chronicle text
- tactical summary
- animations
- sound cues
- clue updates

## 18.4 Do Not Overbuild the MVP

Do not implement these in the first version:

```text
free FPS movement
physics puzzles
real-time combat
complex AI
procedural 3D level generation
large inventory system
advanced character progression
```

## 18.5 Make Everything Testable

Required tests:

```text
move to connected room succeeds
move to non-connected room fails
search can find relic
steal fails if target not in same room
escape only works in exit room
decoy creates false clue
resolved turn is deterministic
collapsed room cannot be entered
score calculation is correct
```

## 18.6 Use Simple Mock Assets First

Initial visuals can be:

```text
boxes
capsules
simple props
colored relic meshes
placeholder hands
basic particle effects
```

The gameplay should work before polished assets.

---

# 19. Suggested Implementation Milestones

## Milestone 1 — Core Game Model

Implement:

```text
GameState
RoomState
PlayerState
Relic
PlayerAction
GameEvent
```

## Milestone 2 — Turn Resolver

Implement:

```text
resolveTurn
validateAction
resolveMove
resolveSearch
resolveSteal
resolveEscape
calculateScore
```

## Milestone 3 — Clue and Observation System

Implement:

```text
inspection targets
clue generation
private clues
false decoy clues
clue quality
```

## Milestone 4 — Basic UI

Implement:

```text
room view
available actions
inspection choices
selected action
round chronicle
tactical summary
score display
```

## Milestone 5 — Babylon.js Room Prototype

Implement:

```text
one room scene
camera anchors
inspection target picking
movement transition
search animation
relic reveal animation
```

## Milestone 6 — Full MVP Map

Implement:

```text
10 rooms
connected map
room-specific props
basic room atmosphere
collapse feedback
```

## Milestone 7 — Character Avatars

Implement:

```text
Scout
Scholar
Trickster
Guardian
simple animations
first-person hands
third-person reveal/victory poses
```

## Milestone 8 — Multiplayer

Implement:

```text
room creation
join room
submit action
wait for all players
server-authoritative turn resolution
broadcast state and events
```

## Milestone 9 — Victory Sequence

Implement:

```text
escape animation
Heart Relic reveal
score breakdown
expedition chronicle
losing player endings
```

---

# 20. Example Round

## Starting Situation

```text
Round: 5
Alice: Shrine, carrying Oracle Stone
Bob: Hallway, carrying no relics
Clara: Treasure Chamber, carrying Golden Idol
Ruin: unstable, 5 rounds remaining
```

## Observation

Alice inspects the altar:

```text
The altar has fresh scratches, but something still hums inside.
```

Bob inspects the floor:

```text
Fresh footprints lead toward the Shrine.
```

Clara listens at the west door:

```text
You hear a low clicking sound beyond the door.
```

## Planning

```text
Alice chooses Search.
Bob chooses Move to Shrine.
Clara chooses Escape Route.
Alice spends decoy: fake movement toward Exit.
```

## Reveal

```text
Alice reaches for the altar.
Bob follows the footprints toward the Shrine.
Clara slips away from the treasure chamber.
```

## Resolution

```text
Alice finds the Cursed Mask.
Bob enters the Shrine.
Clara moves toward the Exit Route.
Alice's false tracks suggest she went to the Exit.
```

## Ruin Phase

```text
The Cursed Mask whispers.
The noise reaches the Monster Lair.
Something wakes up.
```

## Tactical Summary

```text
Alice:
- Found Cursed Mask
- Created 2 noise
- Used decoy

Bob:
- Moved to Shrine
- Is now in the same room as Alice

Clara:
- Moved toward Exit Route

Ruin:
- Monster warning increased
```

---

# 21. Recommended File Organization

This is only a suggested organization.

```text
src/
  game/
    model/
      game-state.ts
      player-state.ts
      room-state.ts
      relic.ts
      actions.ts
      events.ts
      clues.ts
    engine/
      resolve-turn.ts
      validate-action.ts
      resolve-move.ts
      resolve-search.ts
      resolve-steal.ts
      resolve-escape.ts
      scoring.ts
      rng.ts
    content/
      default-map.ts
      default-relics.ts
      default-hunters.ts
      clue-texts.ts
      chronicle-texts.ts

  ui/
    screens/
      lobby-screen.ts
      game-screen.ts
      victory-screen.ts
    components/
      action-picker.ts
      observation-panel.ts
      round-chronicle.ts
      tactical-summary.ts
      player-status.ts

  scene/
    babylon/
      create-engine.ts
      game-scene.ts
      room-scene.ts
      camera-controller.ts
      animation-cues.ts
      inspection-targets.ts
      effects/
        noise-pulse.ts
        relic-glow.ts
        collapse-shake.ts
      avatars/
        hunter-avatar.ts
        first-person-hands.ts
```

---

# 22. AI Coding Prompt

Use this prompt when asking an AI assistant to implement part of the game:

```text
You are helping implement Relic Hunters: Turn-Based Expedition.

Follow these rules:
- Keep game logic separate from Babylon.js rendering.
- The game engine must be deterministic and testable.
- Represent the map as connected room nodes.
- Resolve turns from GameState + PlayerAction[].
- Emit GameEvent objects for all important outcomes.
- Use AnimationCue objects to connect game events to Babylon.js animations.
- Keep MVP scope small.
- Do not implement free FPS movement.
- Use first-person 3D as presentation only.
- Prefer simple modular assets and reusable animations.
- Write TypeScript with clear interfaces.
- Prefer pure functions and immutable state updates where practical.
```

---

# 23. Future Expansions

After MVP, consider:

```text
Character role bonuses
More relic effects
Trap placement and disarming
Monster movement
Procedural ruin layouts
Campaign mode
Persistent relic collection
Daily expeditions
Team mode
P2P mode
AR-inspired location mode
```

---

# 24. Final Design Summary

The game should be:

```text
Turn-based
First-person presented
Clue-driven
Bluff-friendly
Cinematic
Short-match
Deterministic underneath
Stylish but implementable
```

The most important loop is:

```text
Observe carefully
Form a theory
Choose a hidden action
Maybe bluff with a decoy
Watch the round resolve
Adapt to the ruin
Race for the exit
```

The goal is not to build a full FPS.

The goal is to build a compact, highly readable, cinematic turn-based adventure where every round creates a memorable story.
