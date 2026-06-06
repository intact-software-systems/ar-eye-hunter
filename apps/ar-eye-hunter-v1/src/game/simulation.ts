import {
    GAME_PROTOCOL,
    type ArenaEvent,
    type ArenaSnapshot,
    type EyeTargetState,
    type PlayerCombatState,
    type PlayerInputState,
    type ShotAccepted,
    type ShotIntent,
    type TargetRarity,
    type Vec3Tuple,
} from './types.ts';

export type LocalPlayerState = Readonly<{
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    yaw: number;
    pitch: number;
    grounded: boolean;
    slideUntilEpochMs?: number;
    dashUntilEpochMs?: number;
    combat: PlayerCombatState;
}>;

export type ArenaSimulationState = Readonly<{
    revision: number;
    seed: number;
    targets: readonly EyeTargetState[];
    events: readonly ArenaEvent[];
    activeEvent?: ArenaEvent;
}>;

export type ShotResolution = Readonly<{
    state: ArenaSimulationState;
    combat: PlayerCombatState;
    accepted: ShotAccepted;
}>;

const ARENA_HALF_SIZE = 20;
const PLAYER_EYE_HEIGHT = 1.72;
const GRAVITY = -28;
const BASE_SPEED = 7.6;
const SPRINT_SPEED = 11.4;
const SLIDE_SPEED = 14.8;
const DASH_SPEED = 19.5;
const AIR_CONTROL = 0.36;
const JUMP_VELOCITY = 8.3;
const DASH_COOLDOWN_MS = 780;
const SLIDE_COOLDOWN_MS = 900;
const SHOT_COOLDOWN_MS = 105;
const COMBO_TIMEOUT_MS = 2_250;
const TARGET_COUNT = 13;

export const EMPTY_INPUT: PlayerInputState = {
    moveX: 0,
    moveZ: 0,
    sprint: false,
    dash: false,
    slide: false,
    jump: false,
    fire: false,
    altFire: false,
    overdrive: false,
    pause: false,
};

export function createInitialCombatState(): PlayerCombatState {
    return {
        score: 0,
        combo: 0,
        multiplier: 1,
        energy: 100,
        overdrive: 0,
        dashReadyAtEpochMs: 0,
        slideReadyAtEpochMs: 0,
        shotReadyAtEpochMs: 0,
    };
}

export function createInitialPlayerState(nowEpochMs = Date.now()): LocalPlayerState {
    return {
        position: [0, PLAYER_EYE_HEIGHT, -11],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        grounded: true,
        combat: {
            ...createInitialCombatState(),
            dashReadyAtEpochMs: nowEpochMs,
            slideReadyAtEpochMs: nowEpochMs,
            shotReadyAtEpochMs: nowEpochMs,
        },
    };
}

export function createInitialArenaState(
    seed = 0x5eed_2026,
    nowEpochMs = Date.now(),
): ArenaSimulationState {
    return {
        revision: 1,
        seed,
        targets: Array.from({ length: TARGET_COUNT }, (_, index) =>
            createTarget(`eye-${index}`, index, seed, nowEpochMs)
        ),
        events: [],
    };
}

export function stepLocalPlayer(
    player: LocalPlayerState,
    input: PlayerInputState,
    dtMs: number,
    nowEpochMs: number,
): LocalPlayerState {
    if (input.pause) {
        return player;
    }

    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    const moveLength = Math.hypot(input.moveX, input.moveZ);
    const localMove = moveLength > 0
        ? [input.moveX / moveLength, input.moveZ / moveLength] as const
        : [0, 0] as const;
    const forward: Vec3Tuple = [Math.sin(player.yaw), 0, Math.cos(player.yaw)];
    const right: Vec3Tuple = [Math.cos(player.yaw), 0, -Math.sin(player.yaw)];
    const worldMove = normalize3(add3(
        scale3(right, localMove[0]),
        scale3(forward, localMove[1]),
    ));
    const startedDash = input.dash && nowEpochMs >= player.combat.dashReadyAtEpochMs;
    const startedSlide = input.slide &&
        player.grounded &&
        nowEpochMs >= player.combat.slideReadyAtEpochMs &&
        moveLength > 0.1;
    const dashUntil = startedDash
        ? nowEpochMs + 145
        : player.dashUntilEpochMs && player.dashUntilEpochMs > nowEpochMs
        ? player.dashUntilEpochMs
        : undefined;
    const slideUntil = startedSlide
        ? nowEpochMs + 390
        : player.slideUntilEpochMs && player.slideUntilEpochMs > nowEpochMs
        ? player.slideUntilEpochMs
        : undefined;
    const speed = dashUntil
        ? DASH_SPEED
        : slideUntil
        ? SLIDE_SPEED
        : input.sprint
        ? SPRINT_SPEED
        : BASE_SPEED;
    const control = player.grounded ? 1 : AIR_CONTROL;
    const desiredHorizontal = scale3(worldMove, speed);
    let velocity: Vec3Tuple = [
        lerp(player.velocity[0], desiredHorizontal[0], control),
        player.velocity[1] + GRAVITY * dt,
        lerp(player.velocity[2], desiredHorizontal[2], control),
    ];

    if (startedDash) {
        const dashDirection = moveLength > 0.1 ? worldMove : forward;
        velocity = [dashDirection[0] * DASH_SPEED, Math.max(velocity[1], 1.1), dashDirection[2] * DASH_SPEED];
    }

    if (startedSlide) {
        velocity = [worldMove[0] * SLIDE_SPEED, -0.6, worldMove[2] * SLIDE_SPEED];
    }

    if (input.jump && player.grounded && !slideUntil) {
        velocity = [velocity[0], JUMP_VELOCITY, velocity[2]];
    }

    let position = add3(player.position, scale3(velocity, dt));
    let grounded = false;
    if (position[1] <= PLAYER_EYE_HEIGHT) {
        position = [position[0], PLAYER_EYE_HEIGHT, position[2]];
        velocity = [velocity[0] * 0.92, 0, velocity[2] * 0.92];
        grounded = true;
    }

    position = [
        clamp(position[0], -ARENA_HALF_SIZE, ARENA_HALF_SIZE),
        position[1],
        clamp(position[2], -ARENA_HALF_SIZE, ARENA_HALF_SIZE),
    ];

    const energy = clamp(
        player.combat.energy +
            (input.sprint ? -18 : 24) * dt +
            (slideUntil ? -10 * dt : 0),
        0,
        100,
    );

    return {
        ...player,
        position: roundVec3(position),
        velocity: roundVec3(velocity),
        grounded,
        slideUntilEpochMs: slideUntil,
        dashUntilEpochMs: dashUntil,
        combat: {
            ...decayCombo(player.combat, nowEpochMs),
            energy: round2(energy),
            dashReadyAtEpochMs: startedDash
                ? nowEpochMs + DASH_COOLDOWN_MS
                : player.combat.dashReadyAtEpochMs,
            slideReadyAtEpochMs: startedSlide
                ? nowEpochMs + SLIDE_COOLDOWN_MS
                : player.combat.slideReadyAtEpochMs,
        },
    };
}

export function applyArenaEvent(
    state: ArenaSimulationState,
    event: ArenaEvent,
): ArenaSimulationState {
    const events = [...state.events.filter((item) => item.expiresAtEpochMs > event.startsAtEpochMs), event]
        .slice(-10);
    const targets = applyEventToTargets(state.targets, event, state.seed);
    return {
        ...state,
        revision: Math.max(state.revision + 1, event.revision),
        targets,
        events,
        activeEvent: event,
    };
}

export function resolveShot(
    state: ArenaSimulationState,
    combat: PlayerCombatState,
    shot: ShotIntent,
    nowEpochMs: number,
): ShotResolution {
    if (nowEpochMs < combat.shotReadyAtEpochMs) {
        return missResolution(state, combat, shot, nowEpochMs);
    }

    const hit = findClosestTargetHit(state.targets, shot.origin, shot.direction);
    if (!hit) {
        return missResolution(state, {
            ...decayCombo(combat, nowEpochMs),
            shotReadyAtEpochMs: nowEpochMs + SHOT_COOLDOWN_MS,
        }, shot, nowEpochMs);
    }

    const target = hit.target;
    const damage = shot.overdrive || combat.overdriveActiveUntilEpochMs && combat.overdriveActiveUntilEpochMs > nowEpochMs
        ? 2
        : shot.charged
        ? 1.5
        : 1;
    const nextHealth = Math.max(0, target.health - damage);
    const killed = nextHealth <= 0;
    const combo = combat.lastHitAtEpochMs && nowEpochMs - combat.lastHitAtEpochMs <= COMBO_TIMEOUT_MS
        ? combat.combo + 1
        : 1;
    const multiplier = 1 + Math.min(4, Math.floor(combo / 4) * 0.5);
    const rarityBonus = target.rarity === 'bounty'
        ? 75
        : target.rarity === 'rift'
        ? 55
        : target.rarity === 'volatile'
        ? 35
        : 20;
    const scoreDelta = Math.round((killed ? 100 + rarityBonus : 18) * multiplier);
    const overdrive = clamp(combat.overdrive + (killed ? 14 : 5), 0, 100);
    const nextCombat: PlayerCombatState = {
        ...combat,
        score: combat.score + scoreDelta,
        combo,
        multiplier,
        energy: clamp(combat.energy + (killed ? 10 : 3), 0, 100),
        overdrive,
        lastHitAtEpochMs: nowEpochMs,
        shotReadyAtEpochMs: nowEpochMs + SHOT_COOLDOWN_MS,
    };
    const replacement = killed
        ? respawnTarget(target, state.revision + scoreDelta, state.seed, nowEpochMs)
        : { ...target, health: round2(nextHealth) };
    const nextState = {
        ...state,
        revision: state.revision + 1,
        targets: state.targets.map((candidate) =>
            candidate.id === target.id ? replacement : candidate
        ),
    };
    const accepted: ShotAccepted = {
        shot,
        hit: true,
        targetId: target.id,
        impact: roundVec3(hit.point),
        scoreDelta,
        combo,
        multiplier,
        overdrive,
        revision: nextState.revision,
        acceptedAtEpochMs: nowEpochMs,
    };
    return { state: nextState, combat: nextCombat, accepted };
}

export function toArenaSnapshot(
    state: ArenaSimulationState,
    roomId: string | undefined,
    nowEpochMs: number,
): ArenaSnapshot {
    return {
        protocol: GAME_PROTOCOL,
        roomId,
        revision: state.revision,
        seed: state.seed,
        targets: state.targets,
        events: state.events,
        activeEvent: state.activeEvent,
        sentAtEpochMs: nowEpochMs,
    };
}

export function hydrateArenaSnapshot(snapshot: ArenaSnapshot): ArenaSimulationState {
    return {
        revision: snapshot.revision,
        seed: snapshot.seed,
        targets: snapshot.targets,
        events: snapshot.events,
        activeEvent: snapshot.activeEvent,
    };
}

export function arenaRevisionKey(state: ArenaSimulationState): string {
    return `ar-eye-hunter|${state.seed}|${state.revision}|${state.targets.length}`;
}

function createTarget(
    id: string,
    index: number,
    seed: number,
    nowEpochMs: number,
): EyeTargetState {
    const rng = mulberry32(seed + index * 991);
    const ring = index % 4;
    const angle = (index / TARGET_COUNT) * Math.PI * 2 + rng() * 0.28;
    const radius = 5.5 + ring * 3.4 + rng() * 1.8;
    const rarity = targetRarity(rng());
    return {
        id,
        position: roundVec3([
            Math.cos(angle) * radius,
            2.2 + rng() * 3.6,
            Math.sin(angle) * radius,
        ]),
        velocity: roundVec3([
            Math.sin(angle) * (0.4 + rng() * 0.8),
            0.25 + rng() * 0.65,
            -Math.cos(angle) * (0.4 + rng() * 0.8),
        ]),
        radius: rarity === 'rift' ? 0.86 : rarity === 'bounty' ? 0.72 : 0.62,
        health: rarity === 'rift' ? 3 : rarity === 'bounty' ? 2 : 1,
        maxHealth: rarity === 'rift' ? 3 : rarity === 'bounty' ? 2 : 1,
        rarity,
        phase: rng() * Math.PI * 2,
        color: rarityColor(rarity),
        bountyUntilEpochMs: rarity === 'bounty' ? nowEpochMs + 15_000 : undefined,
    };
}

function respawnTarget(
    target: EyeTargetState,
    salt: number,
    seed: number,
    nowEpochMs: number,
): EyeTargetState {
    return createTarget(target.id, salt % 997, seed + salt * 17, nowEpochMs);
}

function applyEventToTargets(
    targets: readonly EyeTargetState[],
    event: ArenaEvent,
    seed: number,
): readonly EyeTargetState[] {
    if (event.kind === 'spawn-eye') {
        const id = event.targetId ?? `eye-${targets.length}-${event.revision}`;
        return [
            ...targets,
            {
                ...createTarget(id, targets.length + event.revision, seed, event.startsAtEpochMs),
                position: event.position ?? createTarget(id, targets.length, seed, event.startsAtEpochMs).position,
                rarity: event.rarity ?? 'volatile',
                color: rarityColor(event.rarity ?? 'volatile'),
            },
        ].slice(-18);
    }

    if (event.kind === 'combo-bounty' || event.kind === 'mutate-target') {
        return targets.map((target, index) => {
            if (event.targetId && target.id !== event.targetId) {
                return target;
            }
            if (!event.targetId && index % 3 !== event.revision % 3) {
                return target;
            }
            const rarity: TargetRarity = event.kind === 'combo-bounty'
                ? 'bounty'
                : event.rarity ?? 'volatile';
            return {
                ...target,
                rarity,
                color: rarityColor(rarity),
                maxHealth: Math.max(target.maxHealth, rarity === 'bounty' ? 2 : 1),
                health: Math.max(target.health, rarity === 'bounty' ? 2 : 1),
                bountyUntilEpochMs: event.expiresAtEpochMs,
            };
        });
    }

    if (event.kind === 'arena-shift') {
        return targets.map((target, index) => {
            const angle = (event.revision + index) * 0.42;
            return {
                ...target,
                velocity: roundVec3([
                    Math.cos(angle) * (event.intensity ?? 1.2),
                    target.velocity[1],
                    Math.sin(angle) * (event.intensity ?? 1.2),
                ]),
            };
        });
    }

    return targets;
}

function findClosestTargetHit(
    targets: readonly EyeTargetState[],
    origin: Vec3Tuple,
    direction: Vec3Tuple,
): Readonly<{ target: EyeTargetState; distance: number; point: Vec3Tuple }> | undefined {
    const ray = normalize3(direction);
    let best: Readonly<{ target: EyeTargetState; distance: number; point: Vec3Tuple }> | undefined;
    for (const target of targets) {
        const toTarget = sub3(target.position, origin);
        const along = dot3(toTarget, ray);
        if (along < 0 || along > 80) {
            continue;
        }
        const closestPoint = add3(origin, scale3(ray, along));
        const miss = distance3(closestPoint, target.position);
        if (miss > target.radius) {
            continue;
        }
        if (!best || along < best.distance) {
            best = {
                target,
                distance: along,
                point: closestPoint,
            };
        }
    }
    return best;
}

function missResolution(
    state: ArenaSimulationState,
    combat: PlayerCombatState,
    shot: ShotIntent,
    nowEpochMs: number,
): ShotResolution {
    const accepted: ShotAccepted = {
        shot,
        hit: false,
        impact: roundVec3(add3(shot.origin, scale3(normalize3(shot.direction), 40))),
        scoreDelta: 0,
        combo: combat.combo,
        multiplier: combat.multiplier,
        overdrive: combat.overdrive,
        revision: state.revision,
        acceptedAtEpochMs: nowEpochMs,
    };
    return { state, combat, accepted };
}

function decayCombo(combat: PlayerCombatState, nowEpochMs: number): PlayerCombatState {
    if (!combat.lastHitAtEpochMs || nowEpochMs - combat.lastHitAtEpochMs <= COMBO_TIMEOUT_MS) {
        return combat;
    }
    return {
        ...combat,
        combo: 0,
        multiplier: 1,
    };
}

function targetRarity(value: number): TargetRarity {
    if (value > 0.94) {
        return 'rift';
    }
    if (value > 0.82) {
        return 'bounty';
    }
    if (value > 0.58) {
        return 'volatile';
    }
    return 'common';
}

export function rarityColor(rarity: TargetRarity): string {
    if (rarity === 'rift') {
        return '#8e7dff';
    }
    if (rarity === 'bounty') {
        return '#ffc857';
    }
    if (rarity === 'volatile') {
        return '#ff4d6d';
    }
    return '#00c2a8';
}

function mulberry32(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
        value += 0x6d2b79f5;
        let next = value;
        next = Math.imul(next ^ next >>> 15, next | 1);
        next ^= next + Math.imul(next ^ next >>> 7, next | 61);
        return ((next ^ next >>> 14) >>> 0) / 4294967296;
    };
}

function add3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(value: Vec3Tuple, scalar: number): Vec3Tuple {
    return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function dot3(a: Vec3Tuple, b: Vec3Tuple): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distance3(a: Vec3Tuple, b: Vec3Tuple): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalize3(value: Vec3Tuple): Vec3Tuple {
    const length = Math.hypot(value[0], value[1], value[2]);
    return length > 0.0001
        ? [value[0] / length, value[1] / length, value[2] / length]
        : [0, 0, 0];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * clamp(t, 0, 1);
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function roundVec3(value: Vec3Tuple): Vec3Tuple {
    return [
        Math.round(value[0] * 1000) / 1000,
        Math.round(value[1] * 1000) / 1000,
        Math.round(value[2] * 1000) / 1000,
    ];
}
