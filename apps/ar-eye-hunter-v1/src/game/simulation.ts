import {
    GAME_PROTOCOL,
    type ArenaLayoutSpec,
    type ArenaPickupState,
    type ArenaEvent,
    type ArenaSnapshot,
    type EyeAttackAccepted,
    type EyeAttackCue,
    type EyeTargetState,
    type EyeThreatState,
    type PickupAccepted,
    type PickupIntent,
    type PlayerArenaState,
    type PlayerCombatState,
    type PlayerHitAccepted,
    type PlayerHitIntent,
    type PlayerInputState,
    type PlayerLoadoutState,
    type ShotAccepted,
    type ShotIntent,
    type TargetRarity,
    type Vec3Tuple,
    type WaveState,
    type WeaponKind,
    type WeaponStats,
} from './types.ts';
import {
    FALLBACK_ARENA_LAYOUT,
    blocksShot,
    pickPickupAnchor,
    pickSpawnPoint,
} from './arenaLayout.ts';

export type LocalPlayerState = Readonly<{
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    yaw: number;
    pitch: number;
    grounded: boolean;
    slideUntilEpochMs?: number;
    dashUntilEpochMs?: number;
    combat: PlayerCombatState;
    vitals: PlayerArenaState['vitals'];
    loadout: PlayerLoadoutState;
}>;

export type ArenaSimulationState = Readonly<{
    revision: number;
    seed: number;
    layout: ArenaLayoutSpec;
    targets: readonly EyeTargetState[];
    pickups: readonly ArenaPickupState[];
    players: readonly PlayerArenaState[];
    attacks: readonly EyeAttackCue[];
    wave: WaveState;
    events: readonly ArenaEvent[];
    activeEvent?: ArenaEvent;
    nextPickupSeq: number;
    nextPickupAtEpochMs: number;
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
const WAVE_WARMUP_MS = 2_800;
const WAVE_ACTIVE_MS = 34_000;
const WAVE_REWARD_MS = 5_500;
const EYE_ATTACK_DEFAULT_WINDUP_MS = 1_050;
const EYE_ATTACK_DEFAULT_COOLDOWN_MS = 4_200;
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_RESPAWN_MS = 1_650;
export const PICKUP_RADIUS = 1.45;
export const PICKUP_TTL_MS = 12_000;
export const PICKUP_MIN_INTERVAL_MS = 4_200;
export const PICKUP_MAX_INTERVAL_MS = 8_600;
export const DEFAULT_WEAPON_KIND: WeaponKind = 'pulse-rifle';

export const WEAPON_STATS: Record<WeaponKind, WeaponStats> = {
    'pulse-rifle': {
        kind: 'pulse-rifle',
        label: 'Pulse Rifle',
        tier: 1,
        damage: 24,
        cooldownMs: 120,
        range: 138,
        spreadRadians: 0.012,
        rays: 1,
        knockback: 0.4,
        flavor: 'honest work, suspiciously glowing',
    },
    'spread-shot': {
        kind: 'spread-shot',
        label: 'Spread Shot',
        tier: 2,
        damage: 16,
        cooldownMs: 185,
        range: 87,
        spreadRadians: 0.095,
        rays: 5,
        knockback: 0.65,
        flavor: 'performance review in cone form',
    },
    'rail-lance': {
        kind: 'rail-lance',
        label: 'Rail Lance',
        tier: 3,
        damage: 46,
        cooldownMs: 420,
        range: 195,
        spreadRadians: 0.002,
        rays: 1,
        knockback: 1.1,
        flavor: 'one line item, many regrets',
    },
    'glitch-blaster': {
        kind: 'glitch-blaster',
        label: 'Glitch Blaster',
        tier: 3,
        damage: 32,
        cooldownMs: 210,
        range: 114,
        spreadRadians: 0.045,
        rays: 2,
        knockback: 0.9,
        flavor: 'undefined behavior, but marketable',
    },
    'audit-pea-shooter': {
        kind: 'audit-pea-shooter',
        label: 'Audit Pea Shooter',
        tier: 0,
        damage: 9,
        cooldownMs: 95,
        range: 81,
        spreadRadians: 0.08,
        rays: 1,
        knockback: 0.12,
        flavor: 'downgrade complete, morale retained',
    },
    'confetti-cannon': {
        kind: 'confetti-cannon',
        label: 'Confetti Cannon',
        tier: 2,
        damage: 18,
        cooldownMs: 155,
        range: 72,
        spreadRadians: 0.14,
        rays: 7,
        knockback: 0.35,
        flavor: 'mandatory fun, ballistic edition',
    },
};

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

export function createInitialVitalsState(): PlayerArenaState['vitals'] {
    return {
        health: PLAYER_MAX_HEALTH,
        maxHealth: PLAYER_MAX_HEALTH,
        kills: 0,
        deaths: 0,
    };
}

export function createInitialLoadoutState(): PlayerLoadoutState {
    return {
        weaponKind: DEFAULT_WEAPON_KIND,
        tier: WEAPON_STATS[DEFAULT_WEAPON_KIND].tier,
    };
}

export function createInitialWaveState(nowEpochMs = Date.now()): WaveState {
    return {
        number: 1,
        phase: 'warmup',
        startedAtEpochMs: nowEpochMs,
        nextPhaseAtEpochMs: nowEpochMs + WAVE_WARMUP_MS,
        targetBudget: TARGET_COUNT,
        hostileBudget: 2,
        pickupRewardBudget: 1,
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
            shotReadyAtEpochMs: nowEpochMs,
        },
        vitals: createInitialVitalsState(),
        loadout: createInitialLoadoutState(),
    };
}

export function createInitialArenaState(
    seed = 0x5eed_2026,
    nowEpochMs = Date.now(),
): ArenaSimulationState {
    return {
        revision: 1,
        seed,
        layout: FALLBACK_ARENA_LAYOUT,
        targets: Array.from({ length: TARGET_COUNT }, (_, index) =>
            createTarget(`eye-${index}`, index, seed, nowEpochMs)
        ),
        pickups: [],
        players: [],
        attacks: [],
        wave: createInitialWaveState(nowEpochMs),
        events: [],
        nextPickupSeq: 0,
        nextPickupAtEpochMs: nowEpochMs + pickupIntervalMs(seed, 0),
    };
}

export function stepLocalPlayer(
    player: LocalPlayerState,
    input: PlayerInputState,
    dtMs: number,
    nowEpochMs: number,
    arenaHalfSize = FALLBACK_ARENA_LAYOUT.halfSize,
): LocalPlayerState {
    if (input.pause) {
        return player;
    }

    if (player.vitals.deadUntilEpochMs && player.vitals.deadUntilEpochMs > nowEpochMs) {
        return {
            ...player,
            velocity: [0, 0, 0],
        };
    }

    const revivedPlayer = player.vitals.health <= 0 &&
            player.vitals.deadUntilEpochMs &&
            player.vitals.deadUntilEpochMs <= nowEpochMs
        ? {
            ...player,
            vitals: {
                ...player.vitals,
                health: player.vitals.maxHealth,
                deadUntilEpochMs: undefined,
                respawnedAtEpochMs: nowEpochMs,
            },
            loadout: createInitialLoadoutState(),
        }
        : player;

    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    const moveLength = Math.hypot(input.moveX, input.moveZ);
    const localMove = moveLength > 0
        ? [input.moveX / moveLength, input.moveZ / moveLength] as const
        : [0, 0] as const;
    const forward: Vec3Tuple = [Math.sin(revivedPlayer.yaw), 0, Math.cos(revivedPlayer.yaw)];
    const right: Vec3Tuple = [Math.cos(revivedPlayer.yaw), 0, -Math.sin(revivedPlayer.yaw)];
    const worldMove = normalize3(add3(
        scale3(right, localMove[0]),
        scale3(forward, localMove[1]),
    ));
    const startedDash = input.dash && nowEpochMs >= revivedPlayer.combat.dashReadyAtEpochMs;
    const startedSlide = input.slide &&
        revivedPlayer.grounded &&
        nowEpochMs >= revivedPlayer.combat.slideReadyAtEpochMs &&
        moveLength > 0.1;
    const dashUntil = startedDash
        ? nowEpochMs + 145
        : revivedPlayer.dashUntilEpochMs && revivedPlayer.dashUntilEpochMs > nowEpochMs
        ? revivedPlayer.dashUntilEpochMs
        : undefined;
    const slideUntil = startedSlide
        ? nowEpochMs + 390
        : revivedPlayer.slideUntilEpochMs && revivedPlayer.slideUntilEpochMs > nowEpochMs
        ? revivedPlayer.slideUntilEpochMs
        : undefined;
    const speed = dashUntil
        ? DASH_SPEED
        : slideUntil
        ? SLIDE_SPEED
        : input.sprint
        ? SPRINT_SPEED
        : BASE_SPEED;
    const control = revivedPlayer.grounded ? 1 : AIR_CONTROL;
    const desiredHorizontal = scale3(worldMove, speed);
    let velocity: Vec3Tuple = [
        lerp(revivedPlayer.velocity[0], desiredHorizontal[0], control),
        revivedPlayer.velocity[1] + GRAVITY * dt,
        lerp(revivedPlayer.velocity[2], desiredHorizontal[2], control),
    ];

    if (startedDash) {
        const dashDirection = moveLength > 0.1 ? worldMove : forward;
        velocity = [dashDirection[0] * DASH_SPEED, Math.max(velocity[1], 1.1), dashDirection[2] * DASH_SPEED];
    }

    if (startedSlide) {
        velocity = [worldMove[0] * SLIDE_SPEED, -0.6, worldMove[2] * SLIDE_SPEED];
    }

    if (input.jump && revivedPlayer.grounded && !slideUntil) {
        velocity = [velocity[0], JUMP_VELOCITY, velocity[2]];
    }

    let position = add3(revivedPlayer.position, scale3(velocity, dt));
    let grounded = false;
    if (position[1] <= PLAYER_EYE_HEIGHT) {
        position = [position[0], PLAYER_EYE_HEIGHT, position[2]];
        velocity = [velocity[0] * 0.92, 0, velocity[2] * 0.92];
        grounded = true;
    }

    position = [
        clamp(position[0], -arenaHalfSize, arenaHalfSize),
        position[1],
        clamp(position[2], -arenaHalfSize, arenaHalfSize),
    ];

    const energy = clamp(
        revivedPlayer.combat.energy +
            (input.sprint ? -18 : 24) * dt +
            (slideUntil ? -10 * dt : 0),
        0,
        100,
    );

    return {
        ...revivedPlayer,
        position: roundVec3(position),
        velocity: roundVec3(velocity),
        grounded,
        slideUntilEpochMs: slideUntil,
        dashUntilEpochMs: dashUntil,
        combat: {
            ...decayCombo(revivedPlayer.combat, nowEpochMs),
            energy: round2(energy),
            dashReadyAtEpochMs: startedDash
                ? nowEpochMs + DASH_COOLDOWN_MS
                : revivedPlayer.combat.dashReadyAtEpochMs,
            slideReadyAtEpochMs: startedSlide
                ? nowEpochMs + SLIDE_COOLDOWN_MS
                : revivedPlayer.combat.slideReadyAtEpochMs,
        },
    };
}

export function applyArenaEvent(
    state: ArenaSimulationState,
    event: ArenaEvent,
): ArenaSimulationState {
    const events = [...state.events.filter((item) => item.expiresAtEpochMs > event.startsAtEpochMs), event]
        .slice(-24);
    const targets = applyEventToTargets(state.targets, event, state.seed);
    const pickups = event.kind === 'weapon-drop'
        ? materializeEventPickup(state, event)
        : state.pickups;
    return {
        ...state,
        revision: Math.max(state.revision + 1, event.revision),
        targets,
        pickups,
        events,
        activeEvent: event,
        nextPickupSeq: event.kind === 'weapon-drop'
            ? state.nextPickupSeq + 1
            : state.nextPickupSeq,
    };
}

export function stepArenaDirectorState(
    state: ArenaSimulationState,
    nowEpochMs: number,
): ArenaSimulationState {
    let next = advanceWaveState(
        respawnDuePlayers(expirePickups(state, nowEpochMs), nowEpochMs),
        nowEpochMs,
    );
    next = resolveDueEyeAttacks(next, nowEpochMs);
    next = scheduleHostileEyeAttacks(next, nowEpochMs);
    if (
        nowEpochMs >= next.nextPickupAtEpochMs &&
        next.pickups.filter((pickup) => !pickup.pickedBySessionId).length < 5
    ) {
        next = spawnWeaponPickup(next, nowEpochMs);
    }
    return next;
}

export type EyeAttackResolution =
    | Readonly<{ accepted: false; state: ArenaSimulationState; reason: string }>
    | Readonly<{ accepted: true; state: ArenaSimulationState; acceptedAttack: EyeAttackAccepted }>;

export function resolveEyeAttackCue(
    state: ArenaSimulationState,
    cue: EyeAttackCue,
    nowEpochMs: number,
): EyeAttackResolution {
    if (nowEpochMs < cue.firesAtEpochMs) {
        return { accepted: false, state, reason: 'windup-active' };
    }
    const target = state.players.find((player) => player.sessionId === cue.targetSessionId);
    const stale = cue.expiresAtEpochMs < nowEpochMs;
    const blocked = !stale && blocksShot(state.layout, cue.origin, cue.aimPoint);
    const dead = target ? isPlayerDead(target, nowEpochMs) : true;
    const hitCheck = target && !dead && !blocked && !stale
        ? beamHitsPlayer(cue, target)
        : undefined;
    const hit = Boolean(hitCheck);
    const revision = Math.max(state.revision + 1, cue.revision);
    const healthAfterHit = target && hit
        ? round2(Math.max(0, target.vitals.health - cue.damage))
        : 0;
    const eliminated = hit && healthAfterHit <= 0;
    const nextTarget: PlayerArenaState | undefined = target && hit
        ? {
            ...target,
            vitals: {
                ...target.vitals,
                health: healthAfterHit,
                deaths: target.vitals.deaths + (eliminated ? 1 : 0),
                deadUntilEpochMs: eliminated ? nowEpochMs + PLAYER_RESPAWN_MS : target.vitals.deadUntilEpochMs,
                lastDamagedAtEpochMs: nowEpochMs,
            },
            updatedAtEpochMs: nowEpochMs,
        }
        : target;
    const reason: EyeAttackAccepted['reason'] = hit
        ? 'hit'
        : stale
        ? 'stale-cue'
        : blocked
        ? 'cover'
        : dead
        ? 'dead-player'
        : 'dodged';
    const event = createSystemEvent(
        hit ? 'eye-attack-hit' : 'eye-attack-dodged',
        revision,
        nowEpochMs,
        hitCheck?.point ?? cue.aimPoint,
        hit
            ? `${target?.username ?? 'avatar'} received mandatory laser feedback`
            : 'Laser audit filed under not today',
    );
    const nextState: ArenaSimulationState = {
        ...state,
        revision,
        players: nextTarget
            ? state.players.map((player) =>
                player.sessionId === nextTarget.sessionId ? nextTarget : player
            )
            : state.players,
        attacks: state.attacks.filter((attack) => attack.id !== cue.id),
        events: [...state.events.slice(-23), event],
        activeEvent: event,
    };
    return {
        accepted: true,
        state: nextState,
        acceptedAttack: {
            cue,
            hit,
            impact: roundVec3(hitCheck?.point ?? cue.aimPoint),
            damage: hit ? cue.damage : 0,
            target: nextTarget,
            eliminated,
            revision,
            acceptedAtEpochMs: nowEpochMs,
            reason,
        },
    };
}

export function applyEyeAttackAccepted(
    state: ArenaSimulationState,
    accepted: EyeAttackAccepted,
): ArenaSimulationState {
    if (accepted.revision <= state.revision) {
        const activeCue = state.attacks.find((attack) => attack.id === accepted.cue.id);
        if (!activeCue) {
            return state;
        }
    }

    const acceptedTarget = accepted.target;
    const players = acceptedTarget
        ? state.players.some((player) => player.sessionId === acceptedTarget.sessionId)
            ? state.players.map((player) =>
                player.sessionId === acceptedTarget.sessionId ? acceptedTarget : player
            )
            : [...state.players, acceptedTarget]
        : state.players;
    const event = createSystemEvent(
        accepted.hit ? 'eye-attack-hit' : 'eye-attack-dodged',
        accepted.revision,
        accepted.acceptedAtEpochMs,
        accepted.impact,
        accepted.hit
            ? 'Laser audit landed'
            : `Laser audit ${accepted.reason ?? 'missed'}`,
    );
    return {
        ...state,
        revision: Math.max(state.revision, accepted.revision),
        players: players.slice(-16),
        attacks: state.attacks.filter((attack) => attack.id !== accepted.cue.id),
        events: [...state.events.filter((item) => item.id !== event.id).slice(-23), event],
        activeEvent: event,
    };
}

export function upsertPlayerPose(
    state: ArenaSimulationState,
    pose: Readonly<{
        sessionId: string;
        username: string;
        color: string;
        position: Vec3Tuple;
        rotation: Vec3Tuple;
        vitals?: PlayerArenaState['vitals'];
        loadout?: PlayerLoadoutState;
        seq: number;
        sentAtEpochMs: number;
    }>,
    nowEpochMs = Date.now(),
): ArenaSimulationState {
    const existing = state.players.find((player) => player.sessionId === pose.sessionId);
    if (existing && existing.seq > pose.seq) {
        return state;
    }
    const player: PlayerArenaState = {
        sessionId: pose.sessionId,
        username: pose.username,
        color: pose.color,
        position: roundVec3(pose.position),
        rotation: roundVec3(pose.rotation),
        vitals: pose.vitals ?? existing?.vitals ?? createInitialVitalsState(),
        loadout: pose.loadout ?? existing?.loadout ?? createInitialLoadoutState(),
        seq: pose.seq,
        updatedAtEpochMs: nowEpochMs,
    };
    return {
        ...state,
        players: [
            ...state.players.filter((candidate) => candidate.sessionId !== pose.sessionId),
            player,
        ].slice(-16),
    };
}

export function spawnWeaponPickup(
    state: ArenaSimulationState,
    nowEpochMs: number,
    weaponKind = chooseWeaponKind(state.seed, state.nextPickupSeq),
): ArenaSimulationState {
    const anchor = pickPickupAnchor(state.layout, state.nextPickupSeq);
    const stats = getWeaponStats(weaponKind);
    const pickup: ArenaPickupState = {
        id: `pickup:${state.revision + 1}:${state.nextPickupSeq}`,
        weaponKind,
        tier: stats.tier,
        position: anchor.position,
        anchorId: anchor.id,
        spawnedAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + PICKUP_TTL_MS,
        label: stats.label,
    };
    const revision = state.revision + 1;
    const event = createSystemEvent('weapon-drop', revision, nowEpochMs, pickup.position, `${stats.label} dropped`);
    return {
        ...state,
        revision,
        pickups: [...state.pickups.filter((item) => !item.pickedBySessionId), pickup].slice(-8),
        events: [...state.events.slice(-11), event],
        activeEvent: event,
        nextPickupSeq: state.nextPickupSeq + 1,
        nextPickupAtEpochMs: nowEpochMs + pickupIntervalMs(state.seed, state.nextPickupSeq + 1),
    };
}

export type PickupResolution =
    | Readonly<{ accepted: false; state: ArenaSimulationState; reason: string }>
    | Readonly<{ accepted: true; state: ArenaSimulationState; acceptedPickup: PickupAccepted }>;

export function resolvePickupIntent(
    state: ArenaSimulationState,
    intent: PickupIntent,
    nowEpochMs: number,
): PickupResolution {
    const pickup = state.pickups.find((item) => item.id === intent.pickupId);
    if (!pickup) {
        return { accepted: false, state, reason: 'pickup-missing' };
    }
    if (pickup.pickedBySessionId || pickup.expiresAtEpochMs <= nowEpochMs) {
        return { accepted: false, state, reason: 'pickup-unavailable' };
    }
    const player = state.players.find((item) => item.sessionId === intent.sessionId);
    if (!player) {
        return { accepted: false, state, reason: 'player-missing' };
    }
    if (isPlayerDead(player, nowEpochMs)) {
        return { accepted: false, state, reason: 'player-dead' };
    }
    if (distance3(player.position, pickup.position) > PICKUP_RADIUS + 0.55) {
        return { accepted: false, state, reason: 'too-far' };
    }

    const stats = getWeaponStats(pickup.weaponKind);
    const nextPlayer: PlayerArenaState = {
        ...player,
        loadout: {
            weaponKind: pickup.weaponKind,
            tier: stats.tier,
            pickedAtEpochMs: nowEpochMs,
        },
        updatedAtEpochMs: nowEpochMs,
    };
    const nextPickup: ArenaPickupState = {
        ...pickup,
        pickedBySessionId: intent.sessionId,
        pickedAtEpochMs: nowEpochMs,
    };
    const revision = state.revision + 1;
    const event = createSystemEvent(
        'weapon-picked-up',
        revision,
        nowEpochMs,
        pickup.position,
        `${player.username} got ${stats.label}`,
    );
    const nextState: ArenaSimulationState = {
        ...state,
        revision,
        pickups: state.pickups.map((item) => item.id === pickup.id ? nextPickup : item),
        players: state.players.map((item) => item.sessionId === player.sessionId ? nextPlayer : item),
        events: [...state.events.slice(-11), event],
        activeEvent: event,
    };
    return {
        accepted: true,
        state: nextState,
        acceptedPickup: {
            intent,
            pickup: nextPickup,
            player: nextPlayer,
            revision,
            acceptedAtEpochMs: nowEpochMs,
        },
    };
}

export type PlayerHitResolution =
    | Readonly<{ accepted: false; state: ArenaSimulationState; reason: string }>
    | Readonly<{ accepted: true; state: ArenaSimulationState; acceptedHit: PlayerHitAccepted }>;

export function resolvePlayerHitIntent(
    state: ArenaSimulationState,
    intent: PlayerHitIntent,
    nowEpochMs: number,
): PlayerHitResolution {
    const attacker = state.players.find((player) => player.sessionId === intent.shot.sessionId);
    const target = state.players.find((player) => player.sessionId === intent.targetSessionId);
    if (!attacker || !target) {
        return { accepted: false, state, reason: 'player-missing' };
    }
    if (attacker.sessionId === target.sessionId) {
        return { accepted: false, state, reason: 'self-hit' };
    }
    if (isPlayerDead(attacker, nowEpochMs) || isPlayerDead(target, nowEpochMs)) {
        return { accepted: false, state, reason: 'dead-player' };
    }
    if (Math.abs(nowEpochMs - intent.sentAtEpochMs) > 1_500) {
        return { accepted: false, state, reason: 'stale-hit' };
    }

    const weapon = getWeaponStats(attacker.loadout.weaponKind);
    const hit = findPlayerHit(target, intent.shot.origin, intent.shot.direction, weapon);
    if (!hit || blocksShot(state.layout, intent.shot.origin, hit.point)) {
        return { accepted: false, state, reason: 'missed-player' };
    }

    const damage = intent.shot.overdrive ? weapon.damage * 1.35 : weapon.damage;
    const health = round2(Math.max(0, target.vitals.health - damage));
    const eliminated = health <= 0;
    const revision = state.revision + 1;
    const nextTarget: PlayerArenaState = {
        ...target,
        vitals: {
            ...target.vitals,
            health,
            deaths: target.vitals.deaths + (eliminated ? 1 : 0),
            deadUntilEpochMs: eliminated ? nowEpochMs + PLAYER_RESPAWN_MS : target.vitals.deadUntilEpochMs,
            lastDamagedAtEpochMs: nowEpochMs,
        },
        updatedAtEpochMs: nowEpochMs,
    };
    const nextAttacker: PlayerArenaState = {
        ...attacker,
        vitals: {
            ...attacker.vitals,
            kills: attacker.vitals.kills + (eliminated ? 1 : 0),
        },
        updatedAtEpochMs: nowEpochMs,
    };
    const event = createSystemEvent(
        eliminated ? 'player-eliminated' : 'player-hit',
        revision,
        nowEpochMs,
        hit.point,
        eliminated
            ? `${target.username} decompiled`
            : `${target.username} audited`,
    );
    const nextState: ArenaSimulationState = {
        ...state,
        revision,
        players: state.players.map((player) =>
            player.sessionId === nextTarget.sessionId
                ? nextTarget
                : player.sessionId === nextAttacker.sessionId
                ? nextAttacker
                : player
        ),
        events: [...state.events.slice(-11), event],
        activeEvent: event,
    };
    return {
        accepted: true,
        state: nextState,
        acceptedHit: {
            intent,
            hit: true,
            impact: roundVec3(hit.point),
            damage: round2(damage),
            weaponKind: weapon.kind,
            target: nextTarget,
            attacker: nextAttacker,
            eliminated,
            revision,
            acceptedAtEpochMs: nowEpochMs,
        },
    };
}

export function applyPlayerHitAccepted(
    state: ArenaSimulationState,
    accepted: PlayerHitAccepted,
): ArenaSimulationState {
    if (accepted.revision <= state.revision) {
        const target = state.players.find((player) =>
            player.sessionId === accepted.target.sessionId
        );
        if (
            target &&
            target.vitals.health === accepted.target.vitals.health &&
            target.vitals.lastDamagedAtEpochMs === accepted.target.vitals.lastDamagedAtEpochMs
        ) {
            return state;
        }
    }

    const existingIds = new Set(state.players.map((player) => player.sessionId));
    const players = state.players
        .map((player) =>
            player.sessionId === accepted.target.sessionId
                ? accepted.target
                : player.sessionId === accepted.attacker.sessionId
                ? accepted.attacker
                : player
        );
    if (!existingIds.has(accepted.target.sessionId)) {
        players.push(accepted.target);
    }
    if (!existingIds.has(accepted.attacker.sessionId)) {
        players.push(accepted.attacker);
    }

    const event = createSystemEvent(
        accepted.eliminated ? 'player-eliminated' : 'player-hit',
        accepted.revision,
        accepted.acceptedAtEpochMs,
        accepted.impact,
        accepted.eliminated
            ? `${accepted.target.username} decompiled`
            : `${accepted.target.username} audited`,
    );
    return {
        ...state,
        revision: Math.max(state.revision, accepted.revision),
        players: players.slice(-16),
        events: [...state.events.filter((item) => item.id !== event.id).slice(-23), event],
        activeEvent: event,
    };
}

export function applyPickupAccepted(
    state: ArenaSimulationState,
    accepted: PickupAccepted,
): ArenaSimulationState {
    if (accepted.revision <= state.revision) {
        const pickup = state.pickups.find((item) => item.id === accepted.pickup.id);
        if (pickup?.pickedBySessionId === accepted.pickup.pickedBySessionId) {
            return state;
        }
    }

    const pickups = state.pickups.some((pickup) => pickup.id === accepted.pickup.id)
        ? state.pickups.map((pickup) =>
            pickup.id === accepted.pickup.id ? accepted.pickup : pickup
        )
        : [...state.pickups, accepted.pickup];
    const players = state.players.some((player) =>
        player.sessionId === accepted.player.sessionId
    )
        ? state.players.map((player) =>
            player.sessionId === accepted.player.sessionId ? accepted.player : player
        )
        : [...state.players, accepted.player];
    const event = createSystemEvent(
        'weapon-picked-up',
        accepted.revision,
        accepted.acceptedAtEpochMs,
        accepted.pickup.position,
        `${accepted.player.username} got ${accepted.pickup.label}`,
    );
    return {
        ...state,
        revision: Math.max(state.revision, accepted.revision),
        pickups: pickups.slice(-8),
        players: players.slice(-16),
        events: [...state.events.filter((item) => item.id !== event.id).slice(-23), event],
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

    const weapon = getWeaponStats(shot.weaponKind ?? DEFAULT_WEAPON_KIND);
    const hit = findClosestTargetHit(state.targets, shot.origin, shot.direction, weapon.range);
    if (!hit || blocksShot(state.layout, shot.origin, hit.point)) {
        return missResolution(state, {
            ...decayCombo(combat, nowEpochMs),
            shotReadyAtEpochMs: nowEpochMs + weapon.cooldownMs,
        }, shot, nowEpochMs);
    }

    const target = hit.target;
    const damage = shot.overdrive || combat.overdriveActiveUntilEpochMs && combat.overdriveActiveUntilEpochMs > nowEpochMs
        ? weapon.damage / 18 * 2
        : shot.charged
        ? weapon.damage / 18 * 1.5
        : weapon.damage / 18;
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
        shotReadyAtEpochMs: nowEpochMs + weapon.cooldownMs,
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
        layout: state.layout,
        targets: state.targets,
        pickups: state.pickups,
        players: state.players,
        attacks: state.attacks,
        wave: state.wave,
        events: state.events,
        activeEvent: state.activeEvent,
        sentAtEpochMs: nowEpochMs,
    };
}

export function hydrateArenaSnapshot(snapshot: ArenaSnapshot): ArenaSimulationState {
    return {
        revision: snapshot.revision,
        seed: snapshot.seed,
        layout: snapshot.layout ?? FALLBACK_ARENA_LAYOUT,
        targets: snapshot.targets,
        pickups: snapshot.pickups ?? [],
        players: snapshot.players ?? [],
        attacks: snapshot.attacks ?? [],
        wave: snapshot.wave ?? createInitialWaveState(snapshot.sentAtEpochMs),
        events: snapshot.events,
        activeEvent: snapshot.activeEvent,
        nextPickupSeq: snapshot.pickups?.length ?? 0,
        nextPickupAtEpochMs: snapshot.sentAtEpochMs + PICKUP_MIN_INTERVAL_MS,
    };
}

export function arenaRevisionKey(state: ArenaSimulationState): string {
    return `ar-eye-hunter|${state.seed}|${state.revision}|${state.targets.length}|${state.players.length}|${state.pickups.length}|${state.attacks.length}|${state.wave.number}:${state.wave.phase}|${state.layout.id}`;
}

export function getWeaponStats(kind: WeaponKind): WeaponStats {
    return WEAPON_STATS[kind] ?? WEAPON_STATS[DEFAULT_WEAPON_KIND];
}

export function isPlayerDead(player: PlayerArenaState, nowEpochMs: number): boolean {
    return player.vitals.health <= 0 ||
        Boolean(player.vitals.deadUntilEpochMs && player.vitals.deadUntilEpochMs > nowEpochMs);
}

export function findPickupNearPlayer(
    state: ArenaSimulationState,
    sessionId: string,
    nowEpochMs: number,
): ArenaPickupState | undefined {
    const player = state.players.find((candidate) => candidate.sessionId === sessionId);
    if (!player || isPlayerDead(player, nowEpochMs)) {
        return undefined;
    }
    return state.pickups.find((pickup) =>
        !pickup.pickedBySessionId &&
        pickup.expiresAtEpochMs > nowEpochMs &&
        distance3(player.position, pickup.position) <= PICKUP_RADIUS
    );
}

function expirePickups(
    state: ArenaSimulationState,
    nowEpochMs: number,
): ArenaSimulationState {
    const pickups = state.pickups.filter((pickup) =>
        pickup.pickedBySessionId || pickup.expiresAtEpochMs > nowEpochMs
    ).slice(-8);
    return pickups.length === state.pickups.length ? state : { ...state, pickups };
}

function respawnDuePlayers(
    state: ArenaSimulationState,
    nowEpochMs: number,
): ArenaSimulationState {
    let changed = false;
    const players = state.players.map((player) => {
        if (
            player.vitals.health > 0 ||
            !player.vitals.deadUntilEpochMs ||
            player.vitals.deadUntilEpochMs > nowEpochMs
        ) {
            return player;
        }
        changed = true;
        return {
            ...player,
            position: pickSpawnPoint(state.layout, player.sessionId, player.vitals.deaths),
            vitals: {
                ...player.vitals,
                health: player.vitals.maxHealth,
                deadUntilEpochMs: undefined,
                respawnedAtEpochMs: nowEpochMs,
            },
            loadout: createInitialLoadoutState(),
            updatedAtEpochMs: nowEpochMs,
        };
    });
    if (!changed) {
        return state;
    }
    const revision = state.revision + 1;
    const event = createSystemEvent('player-respawned', revision, nowEpochMs, undefined, 'Respawn paperwork auto-approved');
    return {
        ...state,
        revision,
        players,
        events: [...state.events.slice(-11), event],
        activeEvent: event,
    };
}

function materializeEventPickup(
    state: ArenaSimulationState,
    event: ArenaEvent,
): readonly ArenaPickupState[] {
    const weaponKind = chooseWeaponKind(state.seed + event.revision, state.nextPickupSeq);
    const stats = getWeaponStats(weaponKind);
    const anchor = pickPickupAnchor(state.layout, state.nextPickupSeq);
    const pickup: ArenaPickupState = {
        id: `ai-${event.id}:pickup`,
        weaponKind,
        tier: stats.tier,
        position: event.position ?? anchor.position,
        anchorId: anchor.id,
        spawnedAtEpochMs: event.startsAtEpochMs,
        expiresAtEpochMs: event.expiresAtEpochMs,
        label: stats.label,
    };
    return [
        ...state.pickups.filter((item) => item.id !== pickup.id && !item.pickedBySessionId),
        pickup,
    ].slice(-8);
}

function advanceWaveState(
    state: ArenaSimulationState,
    nowEpochMs: number,
): ArenaSimulationState {
    if (nowEpochMs < state.wave.nextPhaseAtEpochMs) {
        return state;
    }

    if (state.wave.phase === 'warmup') {
        const wave: WaveState = {
            ...state.wave,
            phase: 'active',
            startedAtEpochMs: nowEpochMs,
            nextPhaseAtEpochMs: nowEpochMs + WAVE_ACTIVE_MS + state.wave.number * 1_500,
        };
        const event = createSystemEvent(
            'wave-start',
            state.revision + 1,
            nowEpochMs,
            undefined,
            `Wave ${wave.number}: compliance lasers armed`,
        );
        return {
            ...state,
            revision: event.revision,
            wave,
            targets: applyWaveThreatBudget(state.targets, wave, nowEpochMs),
            events: [...state.events.slice(-23), event],
            activeEvent: event,
        };
    }

    if (state.wave.phase === 'active') {
        const wave: WaveState = {
            ...state.wave,
            phase: 'reward',
            startedAtEpochMs: nowEpochMs,
            nextPhaseAtEpochMs: nowEpochMs + WAVE_REWARD_MS,
        };
        const event = createSystemEvent(
            'wave-complete',
            state.revision + 1,
            nowEpochMs,
            [0, 1.05, 0],
            `Wave ${wave.number} survived; HR is disappointed`,
        );
        return spawnWeaponPickup({
            ...state,
            revision: event.revision,
            wave,
            attacks: [],
            events: [...state.events.slice(-23), event],
            activeEvent: event,
        }, nowEpochMs);
    }

    const nextNumber = state.wave.number + 1;
    const wave: WaveState = {
        number: nextNumber,
        phase: 'warmup',
        startedAtEpochMs: nowEpochMs,
        nextPhaseAtEpochMs: nowEpochMs + Math.max(1_200, WAVE_WARMUP_MS - nextNumber * 120),
        targetBudget: TARGET_COUNT + Math.min(8, Math.floor(nextNumber / 2)),
        hostileBudget: Math.min(8, 2 + Math.floor(nextNumber * 0.75)),
        pickupRewardBudget: 1 + Math.floor(nextNumber / 4),
        activeModifierId: state.activeEvent?.kind === 'chaos-modifier'
            ? state.activeEvent.id
            : undefined,
    };
    return {
        ...state,
        wave,
        targets: ensureTargetBudget(state.targets, state.seed + nextNumber * 1337, wave, nowEpochMs),
    };
}

function scheduleHostileEyeAttacks(
    state: ArenaSimulationState,
    nowEpochMs: number,
): ArenaSimulationState {
    if (state.wave.phase !== 'active' || state.players.length === 0) {
        return state;
    }

    let next = state;
    for (const target of state.targets) {
        const threat = target.threat;
        if (!threat || threat.kind === 'passive' || nowEpochMs < threat.nextAttackAtEpochMs) {
            continue;
        }
        if (next.attacks.some((attack) => attack.targetId === target.id)) {
            continue;
        }
        const player = pickEyeAttackTarget(next, target, threat, nowEpochMs);
        if (!player) {
            continue;
        }
        const cue: EyeAttackCue = {
            id: `eye-cue:${target.id}:${nowEpochMs}:${next.revision + 1}`,
            targetId: target.id,
            targetSessionId: player.sessionId,
            origin: target.position,
            aimPoint: player.position,
            damage: threat.damage,
            range: threat.range,
            coneRadians: threat.coneRadians,
            startsAtEpochMs: nowEpochMs,
            firesAtEpochMs: nowEpochMs + threat.windupMs,
            expiresAtEpochMs: nowEpochMs + threat.windupMs + 420,
            revision: next.revision + 1,
        };
        const event = createSystemEvent(
            'eye-attack-windup',
            cue.revision,
            nowEpochMs,
            player.position,
            'Compliance Laser Auditor is charging',
        );
        next = {
            ...next,
            revision: cue.revision,
            attacks: [...next.attacks, cue].slice(-12),
            targets: next.targets.map((candidate) =>
                candidate.id === target.id && candidate.threat
                    ? {
                        ...candidate,
                        threat: {
                            ...candidate.threat,
                            targetSessionId: player.sessionId,
                            nextAttackAtEpochMs: nowEpochMs + candidate.threat.cooldownMs,
                        },
                    }
                    : candidate
            ),
            events: [...next.events.slice(-23), event],
            activeEvent: event,
        };
    }
    return next;
}

function resolveDueEyeAttacks(
    state: ArenaSimulationState,
    nowEpochMs: number,
): ArenaSimulationState {
    let next = state;
    for (const cue of state.attacks) {
        if (cue.firesAtEpochMs > nowEpochMs) {
            continue;
        }
        const resolution = resolveEyeAttackCue(next, cue, nowEpochMs);
        if (resolution.accepted) {
            next = resolution.state;
        }
    }
    return next;
}

function pickEyeAttackTarget(
    state: ArenaSimulationState,
    eye: EyeTargetState,
    threat: EyeThreatState,
    nowEpochMs: number,
): PlayerArenaState | undefined {
    let best: Readonly<{ player: PlayerArenaState; distance: number }> | undefined;
    for (const player of state.players) {
        if (isPlayerDead(player, nowEpochMs)) {
            continue;
        }
        const distance = distance3(player.position, eye.position);
        if (distance > threat.range || blocksShot(state.layout, eye.position, player.position)) {
            continue;
        }
        if (!best || distance < best.distance) {
            best = { player, distance };
        }
    }
    return best?.player;
}

function beamHitsPlayer(
    cue: EyeAttackCue,
    player: PlayerArenaState,
): Readonly<{ point: Vec3Tuple }> | undefined {
    const ray = normalize3(sub3(cue.aimPoint, cue.origin));
    const toPlayer = sub3(player.position, cue.origin);
    const along = dot3(toPlayer, ray);
    if (along < 0 || along > cue.range) {
        return undefined;
    }
    const closestPoint = add3(cue.origin, scale3(ray, along));
    const distance = distance3(closestPoint, player.position);
    const coneRadius = Math.max(0.85, Math.tan(cue.coneRadians) * along);
    if (distance > coneRadius) {
        return undefined;
    }
    return { point: closestPoint };
}

function applyWaveThreatBudget(
    targets: readonly EyeTargetState[],
    wave: WaveState,
    nowEpochMs: number,
): readonly EyeTargetState[] {
    return targets.map((target, index) => {
        if (index >= wave.hostileBudget) {
            return {
                ...target,
                threat: target.threat?.kind === 'boss'
                    ? createEyeThreat('beam-sentry', wave.number, index, nowEpochMs)
                    : target.threat,
            };
        }
        const boss = wave.number > 0 && wave.number % 5 === 0 && index === 0;
        return {
            ...target,
            rarity: boss ? 'rift' : target.rarity,
            color: boss ? rarityColor('rift') : target.color,
            threat: createEyeThreat(boss ? 'boss' : 'beam-sentry', wave.number, index, nowEpochMs),
        };
    });
}

function ensureTargetBudget(
    targets: readonly EyeTargetState[],
    seed: number,
    wave: WaveState,
    nowEpochMs: number,
): readonly EyeTargetState[] {
    const next = [...targets];
    for (let index = next.length; index < wave.targetBudget; index += 1) {
        next.push(createTarget(`eye-wave-${wave.number}-${index}`, index, seed, nowEpochMs));
    }
    return applyWaveThreatBudget(next.slice(-Math.max(TARGET_COUNT, wave.targetBudget)), wave, nowEpochMs);
}

function createEyeThreat(
    kind: Exclude<EyeThreatState['kind'], 'passive'>,
    waveNumber: number,
    index: number,
    nowEpochMs: number,
): EyeThreatState {
    const boss = kind === 'boss';
    return {
        kind,
        damage: boss ? 38 : 16 + Math.min(14, waveNumber * 2),
        range: boss ? 88 : 68,
        coneRadians: boss ? 0.12 : 0.085,
        windupMs: Math.max(620, EYE_ATTACK_DEFAULT_WINDUP_MS - waveNumber * 35),
        cooldownMs: Math.max(1_900, EYE_ATTACK_DEFAULT_COOLDOWN_MS - waveNumber * 130 + index * 90),
        nextAttackAtEpochMs: nowEpochMs + 900 + index * 240,
    };
}

function findPlayerHit(
    target: PlayerArenaState,
    origin: Vec3Tuple,
    direction: Vec3Tuple,
    weapon: WeaponStats,
): Readonly<{ distance: number; point: Vec3Tuple }> | undefined {
    const ray = normalize3(direction);
    const toTarget = sub3(target.position, origin);
    const along = dot3(toTarget, ray);
    if (along < 0 || along > weapon.range) {
        return undefined;
    }
    const closestPoint = add3(origin, scale3(ray, along));
    const targetRadius = 0.78 + weapon.spreadRadians * 4;
    const miss = distance3(closestPoint, target.position);
    if (miss > targetRadius) {
        return undefined;
    }
    return { distance: along, point: closestPoint };
}

function chooseWeaponKind(seed: number, sequence: number): WeaponKind {
    const weapons: readonly WeaponKind[] = [
        'pulse-rifle',
        'spread-shot',
        'rail-lance',
        'glitch-blaster',
        'audit-pea-shooter',
        'confetti-cannon',
    ];
    return weapons[Math.abs(hashNumber(seed + sequence * 911)) % weapons.length];
}

function pickupIntervalMs(seed: number, sequence: number): number {
    const span = PICKUP_MAX_INTERVAL_MS - PICKUP_MIN_INTERVAL_MS;
    return PICKUP_MIN_INTERVAL_MS + Math.abs(hashNumber(seed + sequence * 1777)) % span;
}

function createSystemEvent(
    kind: ArenaEvent['kind'],
    revision: number,
    nowEpochMs: number,
    position: Vec3Tuple | undefined,
    headline: string,
): ArenaEvent {
    return {
        id: `${kind}:${revision}:${nowEpochMs}`,
        kind,
        position,
        radius: kind === 'player-eliminated' ? 5 : 3,
        intensity: 1,
        durationMs: 2_800,
        startsAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + 2_800,
        revision,
        source: 'director',
        headline,
    };
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
    const orbitRadius = 14 + ring * 10.5 + rng() * 4.5;
    const rarity = targetRarity(rng());
    const threat = defaultThreatForTarget(index, nowEpochMs);
    return {
        id,
        position: roundVec3([
            Math.cos(angle) * orbitRadius,
            2.2 + rng() * 3.6,
            Math.sin(angle) * orbitRadius,
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
        color: threat?.kind === 'beam-sentry' ? '#ff3df2' : rarityColor(rarity),
        threat,
        bountyUntilEpochMs: rarity === 'bounty' ? nowEpochMs + 15_000 : undefined,
    };
}

function defaultThreatForTarget(
    index: number,
    nowEpochMs: number,
): EyeThreatState | undefined {
    if (index !== 0 && index !== 7) {
        return undefined;
    }
    return createEyeThreat('beam-sentry', 1, index, nowEpochMs);
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
    range = 120,
): Readonly<{ target: EyeTargetState; distance: number; point: Vec3Tuple }> | undefined {
    const ray = normalize3(direction);
    let best: Readonly<{ target: EyeTargetState; distance: number; point: Vec3Tuple }> | undefined;
    for (const target of targets) {
        const toTarget = sub3(target.position, origin);
        const along = dot3(toTarget, ray);
        if (along < 0 || along > range) {
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
    const weapon = getWeaponStats(shot.weaponKind ?? DEFAULT_WEAPON_KIND);
    const accepted: ShotAccepted = {
        shot,
        hit: false,
        impact: roundVec3(add3(shot.origin, scale3(normalize3(shot.direction), weapon.range))),
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

function hashNumber(value: number): number {
    let hash = value | 0;
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    return hash | 0;
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
