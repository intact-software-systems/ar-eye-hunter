import {
    ArenaSimulationState,
    GAME_PROTOCOL,
    type ArenaEvent,
    type ArenaPickupState,
    type ArenaSnapshot,
    type EyeAttackAccepted,
    type EyeAttackCue,
    type EyeTargetState,
    type EyeThreatState,
    type PickupAccepted,
    type PickupIntent,
    type PlayerArenaState,
    type PlayerHitAccepted,
    type PlayerHitIntent,
    type PlayerLoadoutState,
    type Vec3Tuple,
    type WaveState,
    type WeaponKind,
    type WeaponStats
} from './arena-contracts.ts';
import { createSystemEvent } from './arena-events.ts';
import { blocksShot, FALLBACK_ARENA_LAYOUT, pickPickupAnchor, pickSpawnPoint } from './arena-layout.ts';
import { finishArenaMatchIfDue } from './arena-match.ts';
import {
    add3,
    distance3,
    dot3,
    hashNumber,
    normalize3,
    round2,
    roundVec3,
    scale3,
    sub3
} from './arena-math.ts';
import { createInitialVitalsState } from './arena-player-state.ts';
import { applyEventToTargets, createEyeThreat, createTarget, rarityColor, TARGET_COUNT } from './arena-targets.ts';
import { createInitialLoadoutState, getWeaponStats } from './arena-weapons.ts';
const WAVE_WARMUP_MS = 2_800;
const WAVE_ACTIVE_MS = 34_000;
const WAVE_REWARD_MS = 5_500;
export const PLAYER_RESPAWN_MS = 1_650;
export const PLAYER_PVP_DAMAGE_MULTIPLIER = 0.15;
export const PICKUP_RADIUS = 1.45;
export const PICKUP_TTL_MS = 12_000;
/** A pickup intent's claim, and so its lifetime: a claimant the director refuses blocks the pickup no longer. */
export const PICKUP_CLAIM_TTL_MS = 4_000;
export const PICKUP_MIN_INTERVAL_MS = 4_200;
export const PICKUP_MAX_INTERVAL_MS = 8_600;

export function createInitialWaveState(nowEpochMs = Date.now()): WaveState {
    return {
        number: 1,
        phase: 'warmup',
        startedAtEpochMs: nowEpochMs,
        nextPhaseAtEpochMs: nowEpochMs + WAVE_WARMUP_MS,
        targetBudget: TARGET_COUNT,
        hostileBudget: 2,
        pickupRewardBudget: 1
    };
}

export function createInitialArenaState(
    seed = 0x5eed_2026,
    nowEpochMs = Date.now()
): ArenaSimulationState {
    return {
        revision: 1,
        seed,
        layout: FALLBACK_ARENA_LAYOUT,
        targets: Array.from(
            { length: TARGET_COUNT },
            (_, index) => createTarget({ id: `eye-${index}`, index, seed, nowEpochMs })
        ),
        pickups: [],
        players: [],
        attacks: [],
        wave: createInitialWaveState(nowEpochMs),
        match: undefined,
        events: [],
        nextPickupSeq: 0,
        nextPickupAtEpochMs: nowEpochMs + pickupIntervalMs(seed, 0)
    };
}

export function applyArenaEvent(
    state: ArenaSimulationState,
    event: ArenaEvent
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
            : state.nextPickupSeq
    };
}

export function stepArenaDirectorState(
    state: ArenaSimulationState,
    nowEpochMs: number
): ArenaSimulationState {
    let next = advanceWaveState(
        respawnDuePlayers(expirePickups(state, nowEpochMs), nowEpochMs),
        nowEpochMs
    );
    next = resolveDueEyeAttacks(next, nowEpochMs);
    next = scheduleHostileEyeAttacks(next, nowEpochMs);
    if (
        nowEpochMs >= next.nextPickupAtEpochMs &&
        next.pickups.filter((pickup) => !pickup.pickedBySessionId).length < 5
    ) {
        next = spawnWeaponPickup(next, nowEpochMs);
    }
    return finishArenaMatchIfDue(next, nowEpochMs);
}

export type EyeAttackResolution =
    | Readonly<{ accepted: false; state: ArenaSimulationState; reason: string; }>
    | Readonly<{ accepted: true; state: ArenaSimulationState; acceptedAttack: EyeAttackAccepted; }>;

export function resolveEyeAttackCue(
    state: ArenaSimulationState,
    cue: EyeAttackCue,
    nowEpochMs: number
): EyeAttackResolution {
    if (nowEpochMs < cue.firesAtEpochMs) {
        return { accepted: false, state, reason: 'windup-active' };
    }
    const target = state.players.find((player) => player.sessionId === cue.targetSessionId);
    const stale = cue.expiresAtEpochMs < nowEpochMs;
    const blocked = !stale && blocksShot(state.layout, cue.origin, cue.aimPoint);
    const dead = target ? isPlayerDead(target, nowEpochMs) : true;
    const hitCheck = target && !dead && !blocked && !stale ? beamHitsPlayer(cue, target) : undefined;
    const hit = Boolean(hitCheck);
    const revision = Math.max(state.revision + 1, cue.revision);
    const nextTarget = target && hit ? damageArenaPlayer(target, cue.damage, nowEpochMs) : target;
    const eliminated = hit && nextTarget !== undefined && nextTarget.vitals.health <= 0;
    const reason: EyeAttackAccepted['reason'] = hit
        ? 'hit'
        : stale
        ? 'stale-cue'
        : blocked
        ? 'cover'
        : dead
        ? 'dead-player'
        : 'dodged';
    const event = createSystemEvent({
        kind: hit ? 'eye-attack-hit' : 'eye-attack-dodged',
        revision,
        nowEpochMs,
        position: hitCheck?.point ?? cue.aimPoint,
        headline: hit
            ? `${target?.username ?? 'avatar'} received mandatory laser feedback`
            : 'Laser audit filed under not today'
    });
    return {
        accepted: true,
        state: {
            ...state,
            revision,
            players: nextTarget
                ? state.players.map((player) => player.sessionId === nextTarget.sessionId ? nextTarget : player)
                : state.players,
            attacks: state.attacks.filter((attack) => attack.id !== cue.id),
            events: [...state.events.slice(-23), event],
            activeEvent: event
        },
        acceptedAttack: {
            cue,
            hit,
            impact: roundVec3(hitCheck?.point ?? cue.aimPoint),
            damage: hit ? cue.damage : 0,
            target: nextTarget,
            eliminated,
            revision,
            acceptedAtEpochMs: nowEpochMs,
            reason
        }
    };
}

export function applyEyeAttackAccepted(
    state: ArenaSimulationState,
    accepted: EyeAttackAccepted
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
            ? state.players.map((player) => player.sessionId === acceptedTarget.sessionId ? acceptedTarget : player)
            : [...state.players, acceptedTarget]
        : state.players;
    const event = createSystemEvent({
        kind: accepted.hit ? 'eye-attack-hit' : 'eye-attack-dodged',
        revision: accepted.revision,
        nowEpochMs: accepted.acceptedAtEpochMs,
        position: accepted.impact,
        headline: accepted.hit
            ? 'Laser audit landed'
            : `Laser audit ${accepted.reason ?? 'missed'}`
    });
    return {
        ...state,
        revision: Math.max(state.revision, accepted.revision),
        players: players.slice(-16),
        attacks: state.attacks.filter((attack) => attack.id !== accepted.cue.id),
        events: [...state.events.filter((item) => item.id !== event.id).slice(-23), event],
        activeEvent: event
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
        score?: number;
        vitals?: PlayerArenaState['vitals'];
        loadout?: PlayerLoadoutState;
        seq: number;
        sentAtEpochMs: number;
    }>,
    nowEpochMs = Date.now()
): ArenaSimulationState {
    const existing = state.players.find((player) => player.sessionId === pose.sessionId);
    if (existing && existing.seq > pose.seq) {
        return state;
    }
    const player: PlayerArenaState = {
        sessionId: pose.sessionId,
        username: pose.username,
        color: pose.color,
        score: round2(pose.score ?? existing?.score ?? 0),
        position: roundVec3(pose.position),
        rotation: roundVec3(pose.rotation),
        vitals: pose.vitals ?? existing?.vitals ?? createInitialVitalsState(),
        loadout: pose.loadout ?? existing?.loadout ?? createInitialLoadoutState(),
        seq: pose.seq,
        updatedAtEpochMs: nowEpochMs
    };
    return {
        ...state,
        players: [
            ...state.players.filter((candidate) => candidate.sessionId !== pose.sessionId),
            player
        ].slice(-16)
    };
}

export function spawnWeaponPickup(
    state: ArenaSimulationState,
    nowEpochMs: number,
    weaponKind = chooseWeaponKind(state.seed, state.nextPickupSeq)
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
        label: stats.label
    };
    const revision = state.revision + 1;
    const event = createSystemEvent({
        kind: 'weapon-drop',
        revision,
        nowEpochMs,
        position: pickup.position,
        headline: `${stats.label} dropped`
    });
    return {
        ...state,
        revision,
        pickups: [...state.pickups.filter((item) => !item.pickedBySessionId), pickup].slice(-8),
        events: [...state.events.slice(-11), event],
        activeEvent: event,
        nextPickupSeq: state.nextPickupSeq + 1,
        nextPickupAtEpochMs: nowEpochMs + pickupIntervalMs(state.seed, state.nextPickupSeq + 1)
    };
}

export type PickupResolution =
    | Readonly<{ accepted: false; state: ArenaSimulationState; reason: string; }>
    | Readonly<{ accepted: true; state: ArenaSimulationState; acceptedPickup: PickupAccepted; }>;

export function resolvePickupIntent(
    state: ArenaSimulationState,
    intent: PickupIntent,
    nowEpochMs: number
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

    return collectArenaPickup({ state, intent, nowEpochMs, pickup, player });
}

export type PlayerHitResolution =
    | Readonly<{ accepted: false; state: ArenaSimulationState; reason: string; }>
    | Readonly<{ accepted: true; state: ArenaSimulationState; acceptedHit: PlayerHitAccepted; }>;

export function resolvePlayerHitIntent(
    state: ArenaSimulationState,
    intent: PlayerHitIntent,
    nowEpochMs: number
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
    const hit = findPlayerHit({ target, origin: intent.shot.origin, direction: intent.shot.direction, weapon });
    if (!hit || blocksShot(state.layout, intent.shot.origin, hit.point)) {
        return { accepted: false, state, reason: 'missed-player' };
    }

    return computePlayerHit({ state, intent, nowEpochMs, attacker, target, weapon, impact: hit.point });
}

export function applyPlayerHitAccepted(
    state: ArenaSimulationState,
    accepted: PlayerHitAccepted
): ArenaSimulationState {
    if (accepted.revision <= state.revision) {
        const target = state.players.find((player) => player.sessionId === accepted.target.sessionId);
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

    const event = createSystemEvent({
        kind: accepted.eliminated ? 'player-eliminated' : 'player-hit',
        revision: accepted.revision,
        nowEpochMs: accepted.acceptedAtEpochMs,
        position: accepted.impact,
        headline: accepted.eliminated
            ? `${accepted.target.username} decompiled`
            : `${accepted.target.username} audited`
    });
    return {
        ...state,
        revision: Math.max(state.revision, accepted.revision),
        players: players.slice(-16),
        events: [...state.events.filter((item) => item.id !== event.id).slice(-23), event],
        activeEvent: event
    };
}

export function applyPickupAccepted(
    state: ArenaSimulationState,
    accepted: PickupAccepted
): ArenaSimulationState {
    if (accepted.revision <= state.revision) {
        const pickup = state.pickups.find((item) => item.id === accepted.pickup.id);
        if (pickup?.pickedBySessionId === accepted.pickup.pickedBySessionId) {
            return state;
        }
    }

    const pickups = state.pickups.some((pickup) => pickup.id === accepted.pickup.id)
        ? state.pickups.map((pickup) => pickup.id === accepted.pickup.id ? accepted.pickup : pickup)
        : [...state.pickups, accepted.pickup];
    const players = state.players.some((player) => player.sessionId === accepted.player.sessionId)
        ? state.players.map((player) => player.sessionId === accepted.player.sessionId ? accepted.player : player)
        : [...state.players, accepted.player];
    const event = createSystemEvent({
        kind: 'weapon-picked-up',
        revision: accepted.revision,
        nowEpochMs: accepted.acceptedAtEpochMs,
        position: accepted.pickup.position,
        headline: `${accepted.player.username} got ${accepted.pickup.label}`
    });
    return {
        ...state,
        revision: Math.max(state.revision, accepted.revision),
        pickups: pickups.slice(-8),
        players: players.slice(-16),
        events: [...state.events.filter((item) => item.id !== event.id).slice(-23), event],
        activeEvent: event
    };
}

export function toArenaSnapshot(
    state: ArenaSimulationState,
    roomId: string | undefined,
    nowEpochMs: number
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
        match: state.match,
        events: state.events,
        activeEvent: state.activeEvent,
        sentAtEpochMs: nowEpochMs
    };
}

export function hydrateArenaSnapshot(snapshot: ArenaSnapshot): ArenaSimulationState {
    return {
        revision: snapshot.revision,
        seed: snapshot.seed,
        layout: snapshot.layout,
        targets: snapshot.targets,
        pickups: snapshot.pickups,
        players: snapshot.players,
        attacks: snapshot.attacks,
        wave: snapshot.wave,
        match: snapshot.match,
        events: snapshot.events,
        activeEvent: snapshot.activeEvent,
        nextPickupSeq: snapshot.pickups.length,
        nextPickupAtEpochMs: snapshot.sentAtEpochMs + PICKUP_MIN_INTERVAL_MS
    };
}

export function arenaRevisionKey(state: ArenaSimulationState): string {
    return `ar-eye-hunter|${state.seed}|${state.revision}|${state.targets.length}|${state.players.length}|${state.pickups.length}|${state.attacks.length}|${state.wave.number}:${state.wave.phase}|${
        state.match?.matchId ?? 'no-match'
    }:${state.match?.status ?? 'idle'}|${state.layout.id}`;
}

export function isPlayerDead(player: PlayerArenaState, nowEpochMs: number): boolean {
    return player.vitals.health <= 0 ||
        Boolean(player.vitals.deadUntilEpochMs && player.vitals.deadUntilEpochMs > nowEpochMs);
}

export function findPickupNearPlayer(
    state: ArenaSimulationState,
    sessionId: string,
    nowEpochMs: number
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
    nowEpochMs: number
): ArenaSimulationState {
    const pickups = state.pickups.filter((pickup) => pickup.pickedBySessionId || pickup.expiresAtEpochMs > nowEpochMs)
        .slice(-8);
    return pickups.length === state.pickups.length ? state : { ...state, pickups };
}

function respawnDuePlayers(
    state: ArenaSimulationState,
    nowEpochMs: number
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
                respawnedAtEpochMs: nowEpochMs
            },
            loadout: createInitialLoadoutState(),
            updatedAtEpochMs: nowEpochMs
        };
    });
    if (!changed) {
        return state;
    }
    const revision = state.revision + 1;
    const event = createSystemEvent({
        kind: 'player-respawned',
        revision,
        nowEpochMs,
        position: undefined,
        headline: 'Respawn paperwork auto-approved'
    });
    return {
        ...state,
        revision,
        players,
        events: [...state.events.slice(-11), event],
        activeEvent: event
    };
}

function materializeEventPickup(
    state: ArenaSimulationState,
    event: ArenaEvent
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
        label: stats.label
    };
    return [
        ...state.pickups.filter((item) => item.id !== pickup.id && !item.pickedBySessionId),
        pickup
    ].slice(-8);
}

function advanceWaveState(
    state: ArenaSimulationState,
    nowEpochMs: number
): ArenaSimulationState {
    if (nowEpochMs < state.wave.nextPhaseAtEpochMs) {
        return state;
    }

    if (state.wave.phase === 'warmup') {
        const wave: WaveState = {
            ...state.wave,
            phase: 'active',
            startedAtEpochMs: nowEpochMs,
            nextPhaseAtEpochMs: nowEpochMs + WAVE_ACTIVE_MS + state.wave.number * 1_500
        };
        const event = createSystemEvent({
            kind: 'wave-start',
            revision: state.revision + 1,
            nowEpochMs,
            position: undefined,
            headline: `Wave ${wave.number}: compliance lasers armed`
        });
        return {
            ...state,
            revision: event.revision,
            wave,
            targets: applyWaveThreatBudget(state.targets, wave, nowEpochMs),
            events: [...state.events.slice(-23), event],
            activeEvent: event
        };
    }

    if (state.wave.phase === 'active') {
        return completeArenaWave(state, nowEpochMs);
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
            : undefined
    };
    return {
        ...state,
        wave,
        targets: ensureTargetBudget({ targets: state.targets, seed: state.seed + nextNumber * 1337, wave, nowEpochMs })
    };
}

function scheduleHostileEyeAttacks(
    state: ArenaSimulationState,
    nowEpochMs: number
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
        const player = pickEyeAttackTarget({ state: next, eye: target, threat, nowEpochMs });
        if (!player) {
            continue;
        }
        const cue = createEyeAttackCue({ target, player, threat, nowEpochMs, revision: next.revision + 1 });
        const event = createSystemEvent({
            kind: 'eye-attack-windup',
            revision: cue.revision,
            nowEpochMs,
            position: player.position,
            headline: 'Compliance Laser Auditor is charging'
        });
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
                            nextAttackAtEpochMs: nowEpochMs + candidate.threat.cooldownMs
                        }
                    }
                    : candidate
            ),
            events: [...next.events.slice(-23), event],
            activeEvent: event
        };
    }
    return next;
}

function resolveDueEyeAttacks(
    state: ArenaSimulationState,
    nowEpochMs: number
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

interface PickEyeAttackTargetInput {
    readonly state: ArenaSimulationState;
    readonly eye: EyeTargetState;
    readonly threat: EyeThreatState;
    readonly nowEpochMs: number;
}

function pickEyeAttackTarget(
    { state, eye, threat, nowEpochMs }: PickEyeAttackTargetInput
): PlayerArenaState | undefined {
    let best: Readonly<{ player: PlayerArenaState; distance: number; }> | undefined;
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
    player: PlayerArenaState
): Readonly<{ point: Vec3Tuple; }> | undefined {
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
    nowEpochMs: number
): readonly EyeTargetState[] {
    return targets.map((target, index) => {
        if (index >= wave.hostileBudget) {
            return {
                ...target,
                threat: target.threat?.kind === 'boss'
                    ? createEyeThreat({ kind: 'beam-sentry', waveNumber: wave.number, index, nowEpochMs })
                    : target.threat
            };
        }
        const boss = wave.number > 0 && wave.number % 5 === 0 && index === 0;
        return {
            ...target,
            rarity: boss ? 'rift' : target.rarity,
            color: boss ? rarityColor('rift') : target.color,
            threat: createEyeThreat({ kind: boss ? 'boss' : 'beam-sentry', waveNumber: wave.number, index, nowEpochMs })
        };
    });
}

interface EnsureTargetBudgetInput {
    readonly targets: readonly EyeTargetState[];
    readonly seed: number;
    readonly wave: WaveState;
    readonly nowEpochMs: number;
}

function ensureTargetBudget({ targets, seed, wave, nowEpochMs }: EnsureTargetBudgetInput): readonly EyeTargetState[] {
    const next = [...targets];
    for (let index = next.length; index < wave.targetBudget; index += 1) {
        next.push(createTarget({ id: `eye-wave-${wave.number}-${index}`, index, seed, nowEpochMs }));
    }
    return applyWaveThreatBudget(next.slice(-Math.max(TARGET_COUNT, wave.targetBudget)), wave, nowEpochMs);
}

interface FindPlayerHitInput {
    readonly target: PlayerArenaState;
    readonly origin: Vec3Tuple;
    readonly direction: Vec3Tuple;
    readonly weapon: WeaponStats;
}

function findPlayerHit(
    { target, origin, direction, weapon }: FindPlayerHitInput
): Readonly<{ distance: number; point: Vec3Tuple; }> | undefined {
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
        'confetti-cannon'
    ];
    return weapons[Math.abs(hashNumber(seed + sequence * 911)) % weapons.length];
}

function pickupIntervalMs(seed: number, sequence: number): number {
    const span = PICKUP_MAX_INTERVAL_MS - PICKUP_MIN_INTERVAL_MS;
    return PICKUP_MIN_INTERVAL_MS + Math.abs(hashNumber(seed + sequence * 1777)) % span;
}

function damageArenaPlayer(target: PlayerArenaState, damage: number, nowEpochMs: number): PlayerArenaState {
    const health = round2(Math.max(0, target.vitals.health - damage));
    const eliminated = health <= 0;
    return {
        ...target,
        vitals: {
            ...target.vitals,
            health,
            deaths: target.vitals.deaths + (eliminated ? 1 : 0),
            deadUntilEpochMs: eliminated ? nowEpochMs + PLAYER_RESPAWN_MS : target.vitals.deadUntilEpochMs,
            lastDamagedAtEpochMs: nowEpochMs
        },
        updatedAtEpochMs: nowEpochMs
    };
}
interface ArenaPlayerHitInput {
    readonly state: ArenaSimulationState;
    readonly intent: PlayerHitIntent;
    readonly nowEpochMs: number;
    readonly attacker: PlayerArenaState;
    readonly target: PlayerArenaState;
    readonly weapon: WeaponStats;
    readonly impact: Vec3Tuple;
}
function computePlayerHit(
    { state, intent, nowEpochMs, attacker, target, weapon, impact }: ArenaPlayerHitInput
): PlayerHitResolution {
    const baseDamage = intent.shot.overdrive ? weapon.damage * 1.35 : weapon.damage;
    const damage = round2(baseDamage * PLAYER_PVP_DAMAGE_MULTIPLIER);
    const nextTarget = damageArenaPlayer(target, damage, nowEpochMs);
    const eliminated = nextTarget.vitals.health <= 0;
    const revision = state.revision + 1;
    const nextAttacker: PlayerArenaState = {
        ...attacker,
        vitals: {
            ...attacker.vitals,
            kills: attacker.vitals.kills + (eliminated ? 1 : 0)
        },
        updatedAtEpochMs: nowEpochMs
    };
    const event = createSystemEvent({
        kind: eliminated ? 'player-eliminated' : 'player-hit',
        revision,
        nowEpochMs,
        position: impact,
        headline: eliminated
            ? `${target.username} decompiled`
            : `${target.username} audited`
    });
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
        activeEvent: event
    };
    return {
        accepted: true,
        state: nextState,
        acceptedHit: {
            intent,
            hit: true,
            impact: roundVec3(impact),
            damage: round2(damage),
            weaponKind: weapon.kind,
            target: nextTarget,
            attacker: nextAttacker,
            eliminated,
            revision,
            acceptedAtEpochMs: nowEpochMs
        }
    };
}
interface ArenaPickupCollection {
    readonly state: ArenaSimulationState;
    readonly intent: PickupIntent;
    readonly nowEpochMs: number;
    readonly pickup: ArenaPickupState;
    readonly player: PlayerArenaState;
}
function collectArenaPickup({ state, intent, nowEpochMs, pickup, player }: ArenaPickupCollection): PickupResolution {
    const stats = getWeaponStats(pickup.weaponKind);
    const nextPlayer: PlayerArenaState = {
        ...player,
        loadout: {
            weaponKind: pickup.weaponKind,
            tier: stats.tier,
            pickedAtEpochMs: nowEpochMs
        },
        updatedAtEpochMs: nowEpochMs
    };
    const nextPickup: ArenaPickupState = {
        ...pickup,
        pickedBySessionId: intent.sessionId,
        pickedAtEpochMs: nowEpochMs
    };
    const revision = state.revision + 1;
    const event = createSystemEvent({
        kind: 'weapon-picked-up',
        revision,
        nowEpochMs,
        position: pickup.position,
        headline: `${player.username} got ${stats.label}`
    });
    const nextState: ArenaSimulationState = {
        ...state,
        revision,
        pickups: state.pickups.map((item) => item.id === pickup.id ? nextPickup : item),
        players: state.players.map((item) => item.sessionId === player.sessionId ? nextPlayer : item),
        events: [...state.events.slice(-11), event],
        activeEvent: event
    };
    return {
        accepted: true,
        state: nextState,
        acceptedPickup: {
            intent,
            pickup: nextPickup,
            player: nextPlayer,
            revision,
            acceptedAtEpochMs: nowEpochMs
        }
    };
}

function completeArenaWave(state: ArenaSimulationState, nowEpochMs: number): ArenaSimulationState {
    const wave: WaveState = {
        ...state.wave,
        phase: 'reward',
        startedAtEpochMs: nowEpochMs,
        nextPhaseAtEpochMs: nowEpochMs + WAVE_REWARD_MS
    };
    const event = createSystemEvent({
        kind: 'wave-complete',
        revision: state.revision + 1,
        nowEpochMs,
        position: [0, 1.05, 0],
        headline: `Wave ${wave.number} survived; HR is disappointed`
    });
    return spawnWeaponPickup({
        ...state,
        revision: event.revision,
        wave,
        attacks: [],
        events: [...state.events.slice(-23), event],
        activeEvent: event
    }, nowEpochMs);
}
interface EyeAttackCueInput {
    readonly target: EyeTargetState;
    readonly player: PlayerArenaState;
    readonly threat: EyeThreatState;
    readonly nowEpochMs: number;
    readonly revision: number;
}
function createEyeAttackCue({ target, player, threat, nowEpochMs, revision }: EyeAttackCueInput): EyeAttackCue {
    const cue: EyeAttackCue = {
        id: `eye-cue:${target.id}:${nowEpochMs}:${revision}`,
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
        revision: revision
    };

    return cue;
}
