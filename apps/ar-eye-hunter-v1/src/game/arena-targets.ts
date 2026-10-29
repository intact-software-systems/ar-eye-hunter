import {
    ArenaSimulationState,
    type ArenaEvent,
    type EyeTargetState,
    type EyeThreatState,
    type PlayerCombatState,
    type ShotAccepted,
    type ShotIntent,
    type TargetRarity,
    type Vec3Tuple,
    type WeaponStats
} from './arena-contracts.ts';
import { blocksShot } from './arena-layout.ts';
import {
    add3,
    clamp,
    distance3,
    dot3,
    mulberry32,
    normalize3,
    round2,
    roundVec3,
    scale3,
    sub3
} from './arena-math.ts';
import { COMBO_TIMEOUT_MS, decayCombo } from './arena-player-state.ts';
import { getWeaponStats } from './arena-weapons.ts';
export interface ShotResolution {
    readonly state: ArenaSimulationState;
    readonly combat: PlayerCombatState;
    readonly accepted: ShotAccepted;
}

export const TARGET_COUNT = 13;

const EYE_ATTACK_DEFAULT_WINDUP_MS = 1_050;

const EYE_ATTACK_DEFAULT_COOLDOWN_MS = 4_200;

export const PLAYER_EYE_ATTACK_DAMAGE_MULTIPLIER = 0.2;

export interface ResolveShotInput {
    readonly state: ArenaSimulationState;
    readonly combat: PlayerCombatState;
    readonly shot: ShotIntent;
    readonly nowEpochMs: number;
}

export function resolveShot({ state, combat, shot, nowEpochMs }: ResolveShotInput): ShotResolution {
    if (nowEpochMs < combat.shotReadyAtEpochMs) {
        return missResolution({ state, combat, shot, nowEpochMs });
    }

    const weapon = getWeaponStats(shot.weaponKind);
    const hit = findClosestTargetHit({
        targets: state.targets,
        origin: shot.origin,
        direction: shot.direction,
        range: weapon.range
    });
    if (!hit || blocksShot(state.layout, shot.origin, hit.point)) {
        return missResolution({
            state,
            combat: {
                ...decayCombo(combat, nowEpochMs),
                shotReadyAtEpochMs: nowEpochMs + weapon.cooldownMs
            },
            shot,
            nowEpochMs
        });
    }

    const target = hit.target;
    const damage =
        shot.overdrive || combat.overdriveActiveUntilEpochMs && combat.overdriveActiveUntilEpochMs > nowEpochMs
            ? weapon.damage / 18 * 2
            : shot.charged
            ? weapon.damage / 18 * 1.5
            : weapon.damage / 18;
    const nextHealth = Math.max(0, target.health - damage);
    const killed = nextHealth <= 0;
    const nextCombat = rewardArenaShot({ combat, target, killed, weapon, nowEpochMs });
    const scoreDelta = nextCombat.score - combat.score;
    const { combo, multiplier, overdrive } = nextCombat;
    const replacement = killed
        ? respawnTarget({ target, salt: state.revision + scoreDelta, seed: state.seed, nowEpochMs })
        : { ...target, health: round2(nextHealth) };
    const nextState = {
        ...state,
        revision: state.revision + 1,
        targets: state.targets.map((candidate) => candidate.id === target.id ? replacement : candidate)
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
        acceptedAtEpochMs: nowEpochMs
    };
    return { state: nextState, combat: nextCombat, accepted };
}

interface CreateEyeThreatInput {
    readonly kind: Exclude<EyeThreatState['kind'], 'passive'>;
    readonly waveNumber: number;
    readonly index: number;
    readonly nowEpochMs: number;
}

export function createEyeThreat({ kind, waveNumber, index, nowEpochMs }: CreateEyeThreatInput): EyeThreatState {
    const boss = kind === 'boss';
    const baseDamage = boss ? 38 : 16 + Math.min(14, waveNumber * 2);
    return {
        kind,
        damage: round2(baseDamage * PLAYER_EYE_ATTACK_DAMAGE_MULTIPLIER),
        range: boss ? 88 : 68,
        coneRadians: boss ? 0.12 : 0.085,
        windupMs: Math.max(620, EYE_ATTACK_DEFAULT_WINDUP_MS - waveNumber * 35),
        cooldownMs: Math.max(1_900, EYE_ATTACK_DEFAULT_COOLDOWN_MS - waveNumber * 130 + index * 90),
        nextAttackAtEpochMs: nowEpochMs + 900 + index * 240
    };
}

interface CreateTargetInput {
    readonly id: string;
    readonly index: number;
    readonly seed: number;
    readonly nowEpochMs: number;
}

export function createTarget({ id, index, seed, nowEpochMs }: CreateTargetInput): EyeTargetState {
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
            Math.sin(angle) * orbitRadius
        ]),
        velocity: roundVec3([
            Math.sin(angle) * (0.4 + rng() * 0.8),
            0.25 + rng() * 0.65,
            -Math.cos(angle) * (0.4 + rng() * 0.8)
        ]),
        radius: rarity === 'rift' ? 0.86 : rarity === 'bounty' ? 0.72 : 0.62,
        health: rarity === 'rift' ? 3 : rarity === 'bounty' ? 2 : 1,
        maxHealth: rarity === 'rift' ? 3 : rarity === 'bounty' ? 2 : 1,
        rarity,
        phase: rng() * Math.PI * 2,
        color: threat?.kind === 'beam-sentry' ? '#ff3df2' : rarityColor(rarity),
        threat,
        bountyUntilEpochMs: rarity === 'bounty' ? nowEpochMs + 15_000 : undefined
    };
}

function defaultThreatForTarget(
    index: number,
    nowEpochMs: number
): EyeThreatState | undefined {
    if (index !== 0 && index !== 7) {
        return undefined;
    }
    return createEyeThreat({ kind: 'beam-sentry', waveNumber: 1, index, nowEpochMs });
}

interface RespawnTargetInput {
    readonly target: EyeTargetState;
    readonly salt: number;
    readonly seed: number;
    readonly nowEpochMs: number;
}

function respawnTarget({ target, salt, seed, nowEpochMs }: RespawnTargetInput): EyeTargetState {
    return createTarget({ id: target.id, index: salt % 997, seed: seed + salt * 17, nowEpochMs });
}

export function applyEventToTargets(
    targets: readonly EyeTargetState[],
    event: ArenaEvent,
    seed: number
): readonly EyeTargetState[] {
    if (event.kind === 'spawn-eye') {
        return spawnEventTarget(targets, event, seed);
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
                bountyUntilEpochMs: event.expiresAtEpochMs
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
                    Math.sin(angle) * (event.intensity ?? 1.2)
                ])
            };
        });
    }

    return targets;
}

interface FindClosestTargetHitInput {
    readonly targets: readonly EyeTargetState[];
    readonly origin: Vec3Tuple;
    readonly direction: Vec3Tuple;
    readonly range?: number;
}

function findClosestTargetHit(
    { targets, origin, direction, range = 120 }: FindClosestTargetHitInput
): Readonly<{ target: EyeTargetState; distance: number; point: Vec3Tuple; }> | undefined {
    const ray = normalize3(direction);
    let best: Readonly<{ target: EyeTargetState; distance: number; point: Vec3Tuple; }> | undefined;
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
                point: closestPoint
            };
        }
    }
    return best;
}

interface MissResolutionInput {
    readonly state: ArenaSimulationState;
    readonly combat: PlayerCombatState;
    readonly shot: ShotIntent;
    readonly nowEpochMs: number;
}

function missResolution({ state, combat, shot, nowEpochMs }: MissResolutionInput): ShotResolution {
    const weapon = getWeaponStats(shot.weaponKind);
    const accepted: ShotAccepted = {
        shot,
        hit: false,
        impact: roundVec3(add3(shot.origin, scale3(normalize3(shot.direction), weapon.range))),
        scoreDelta: 0,
        combo: combat.combo,
        multiplier: combat.multiplier,
        overdrive: combat.overdrive,
        revision: state.revision,
        acceptedAtEpochMs: nowEpochMs
    };
    return { state, combat, accepted };
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

interface ArenaShotReward {
    readonly combat: PlayerCombatState;
    readonly target: EyeTargetState;
    readonly killed: boolean;
    readonly weapon: WeaponStats;
    readonly nowEpochMs: number;
}

function rewardArenaShot({ combat, target, killed, weapon, nowEpochMs }: ArenaShotReward): PlayerCombatState {
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
        shotReadyAtEpochMs: nowEpochMs + weapon.cooldownMs
    };

    return nextCombat;
}

function spawnEventTarget(
    targets: readonly EyeTargetState[],
    event: ArenaEvent,
    seed: number
): readonly EyeTargetState[] {
    const id = event.targetId ?? `eye-${targets.length}-${event.revision}`;
    return [
        ...targets,
        {
            ...createTarget({
                id,
                index: targets.length + event.revision,
                seed,
                nowEpochMs: event.startsAtEpochMs
            }),
            position: event.position ??
                createTarget({ id, index: targets.length, seed, nowEpochMs: event.startsAtEpochMs }).position,
            rarity: event.rarity ?? 'volatile',
            color: rarityColor(event.rarity ?? 'volatile')
        }
    ].slice(-18);
}
