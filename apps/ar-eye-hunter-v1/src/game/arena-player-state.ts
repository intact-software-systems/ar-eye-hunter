import {
    type PlayerArenaState,
    type PlayerCombatState,
    type PlayerInputState,
    type PlayerLoadoutState,
    type Vec3Tuple
} from './arena-contracts.ts';
import { FALLBACK_ARENA_LAYOUT } from './arena-layout.ts';
import { add3, clamp, lerp, normalize3, round2, roundVec3, scale3 } from './arena-math.ts';
import { createInitialLoadoutState } from './arena-weapons.ts';

export interface LocalPlayerState {
    readonly position: Vec3Tuple;
    readonly velocity: Vec3Tuple;
    readonly yaw: number;
    readonly pitch: number;
    readonly grounded: boolean;
    readonly slideUntilEpochMs?: number;
    readonly dashUntilEpochMs?: number;
    readonly combat: PlayerCombatState;
    readonly vitals: PlayerArenaState['vitals'];
    readonly loadout: PlayerLoadoutState;
}

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

export const COMBO_TIMEOUT_MS = 2_250;

export const PLAYER_MAX_HEALTH = 100;

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
    pause: false
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
        shotReadyAtEpochMs: 0
    };
}

export function createInitialVitalsState(): PlayerArenaState['vitals'] {
    return {
        health: PLAYER_MAX_HEALTH,
        maxHealth: PLAYER_MAX_HEALTH,
        kills: 0,
        deaths: 0
    };
}

export function createInitialPlayerState(nowEpochMs = Date.now()): LocalPlayerState {
    return {
        position: FALLBACK_ARENA_LAYOUT.spawnPoints[0],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        grounded: true,
        combat: {
            ...createInitialCombatState(),
            dashReadyAtEpochMs: nowEpochMs,
            slideReadyAtEpochMs: nowEpochMs,
            shotReadyAtEpochMs: nowEpochMs
        },
        vitals: createInitialVitalsState(),
        loadout: createInitialLoadoutState()
    };
}

export interface StepLocalPlayerInput {
    readonly player: LocalPlayerState;
    readonly input: PlayerInputState;
    readonly dtMs: number;
    readonly nowEpochMs: number;
    readonly arenaHalfSize?: number;
}

export function stepLocalPlayer(
    { player, input, dtMs, nowEpochMs, arenaHalfSize = FALLBACK_ARENA_LAYOUT.halfSize }: StepLocalPlayerInput
): LocalPlayerState {
    if (input.pause) {
        return player;
    }
    if (player.vitals.deadUntilEpochMs && player.vitals.deadUntilEpochMs > nowEpochMs) {
        return { ...player, velocity: [0, 0, 0] };
    }
    const revived = reviveLocalPlayer(player, nowEpochMs);
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    const movement = computeLocalMovement({ player: revived, input, dt, nowEpochMs });
    const integrated = integrateLocalMovement({ player: revived, velocity: movement.velocity, dt, arenaHalfSize });
    const energy = clamp(
        revived.combat.energy + (input.sprint ? -18 : 24) * dt + (movement.slideUntil ? -10 * dt : 0),
        0,
        100
    );
    return {
        ...revived,
        ...integrated,
        slideUntilEpochMs: movement.slideUntil,
        dashUntilEpochMs: movement.dashUntil,
        combat: {
            ...decayCombo(revived.combat, nowEpochMs),
            energy: round2(energy),
            dashReadyAtEpochMs: movement.startedDash
                ? nowEpochMs + DASH_COOLDOWN_MS
                : revived.combat.dashReadyAtEpochMs,
            slideReadyAtEpochMs: movement.startedSlide
                ? nowEpochMs + SLIDE_COOLDOWN_MS
                : revived.combat.slideReadyAtEpochMs
        }
    };
}

export function decayCombo(combat: PlayerCombatState, nowEpochMs: number): PlayerCombatState {
    if (!combat.lastHitAtEpochMs || nowEpochMs - combat.lastHitAtEpochMs <= COMBO_TIMEOUT_MS) {
        return combat;
    }
    return {
        ...combat,
        combo: 0,
        multiplier: 1
    };
}

function reviveLocalPlayer(player: LocalPlayerState, nowEpochMs: number): LocalPlayerState {
    return player.vitals.health <= 0 && player.vitals.deadUntilEpochMs && player.vitals.deadUntilEpochMs <= nowEpochMs
        ? {
            ...player,
            vitals: {
                ...player.vitals,
                health: player.vitals.maxHealth,
                deadUntilEpochMs: undefined,
                respawnedAtEpochMs: nowEpochMs
            },
            loadout: createInitialLoadoutState()
        }
        : player;
}
interface LocalMovementInput {
    readonly player: LocalPlayerState;
    readonly input: PlayerInputState;
    readonly dt: number;
    readonly nowEpochMs: number;
}
interface LocalMovement {
    readonly velocity: Vec3Tuple;
    readonly startedDash: boolean;
    readonly startedSlide: boolean;
    readonly dashUntil: number | undefined;
    readonly slideUntil: number | undefined;
}
function computeLocalMovement({ player, input, dt, nowEpochMs }: LocalMovementInput): LocalMovement {
    const moveLength = Math.hypot(input.moveX, input.moveZ);
    const localMove = moveLength > 0 ? [input.moveX / moveLength, input.moveZ / moveLength] as const : [0, 0] as const;
    const forward: Vec3Tuple = [Math.sin(player.yaw), 0, Math.cos(player.yaw)];
    const right: Vec3Tuple = [Math.cos(player.yaw), 0, -Math.sin(player.yaw)];
    const worldMove = normalize3(add3(scale3(right, localMove[0]), scale3(forward, localMove[1])));
    const startedDash = input.dash && nowEpochMs >= player.combat.dashReadyAtEpochMs;
    const startedSlide = input.slide && player.grounded && nowEpochMs >= player.combat.slideReadyAtEpochMs &&
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
    const speed = dashUntil ? DASH_SPEED : slideUntil ? SLIDE_SPEED : input.sprint ? SPRINT_SPEED : BASE_SPEED;
    const control = player.grounded ? 1 : AIR_CONTROL;
    const desiredHorizontal = scale3(worldMove, speed);
    let velocity: Vec3Tuple = [
        lerp(player.velocity[0], desiredHorizontal[0], control),
        player.velocity[1] + GRAVITY * dt,
        lerp(player.velocity[2], desiredHorizontal[2], control)
    ];
    if (startedDash) {
        const direction = moveLength > 0.1 ? worldMove : forward;
        velocity = [direction[0] * DASH_SPEED, Math.max(velocity[1], 1.1), direction[2] * DASH_SPEED];
    }
    if (startedSlide) {
        velocity = [worldMove[0] * SLIDE_SPEED, -0.6, worldMove[2] * SLIDE_SPEED];
    }
    if (input.jump && player.grounded && !slideUntil) {
        velocity = [velocity[0], JUMP_VELOCITY, velocity[2]];
    }
    return { velocity, startedDash, startedSlide, dashUntil, slideUntil };
}
interface LocalMovementIntegration {
    readonly player: LocalPlayerState;
    readonly velocity: Vec3Tuple;
    readonly dt: number;
    readonly arenaHalfSize: number;
}
interface LocalMovementPosition {
    readonly position: Vec3Tuple;
    readonly velocity: Vec3Tuple;
    readonly grounded: boolean;
}
function integrateLocalMovement(
    { player, velocity, dt, arenaHalfSize }: LocalMovementIntegration
): LocalMovementPosition {
    let position = add3(player.position, scale3(velocity, dt));
    const grounded = position[1] <= PLAYER_EYE_HEIGHT;
    const nextVelocity: Vec3Tuple = grounded ? [velocity[0] * 0.92, 0, velocity[2] * 0.92] : velocity;
    if (grounded) {
        position = [position[0], PLAYER_EYE_HEIGHT, position[2]];
    }
    position = [
        clamp(position[0], -arenaHalfSize, arenaHalfSize),
        position[1],
        clamp(position[2], -arenaHalfSize, arenaHalfSize)
    ];
    return { position: roundVec3(position), velocity: roundVec3(nextVelocity), grounded };
}
