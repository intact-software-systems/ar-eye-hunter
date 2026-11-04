import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { ArenaSimulationState } from './arena-contracts.ts';
import { finishArenaMatchIfDue } from './arena-match.ts';
import { WEAPON_STATS } from './arena-weapons.ts';
import {
    createTournamentArena,
    decodeTournamentArenaInput,
    type CreateTournamentArenaInput,
    type TournamentArena,
    type TournamentArenaPlayer
} from './tournament-arena.ts';

/** Recovery accepts the exact native state shape, never defaults, sparse patches or another rules instance. */
export function decodeTournamentArenaCheckpoint(value: unknown, identity: CreateTournamentArenaInput): TournamentArena {
    const initial = createTournamentArena(identity);
    const state = requireRecord(value, 'Tournament checkpoint');
    requireExactKeys(
        state,
        ['gameId', 'startedAtEpochMs', 'endsAtEpochMs', 'simulatedAtEpochMs', 'arena', 'players'],
        'Tournament checkpoint'
    );
    requireEpoch(state.simulatedAtEpochMs, 'Tournament simulated time');
    if (
        state.gameId !== initial.gameId || state.startedAtEpochMs !== initial.startedAtEpochMs ||
        state.endsAtEpochMs !== initial.endsAtEpochMs ||
        state.simulatedAtEpochMs < initial.startedAtEpochMs || state.simulatedAtEpochMs > initial.endsAtEpochMs ||
        (state.simulatedAtEpochMs - initial.startedAtEpochMs) % 50 !== 0
    ) {
        throw new TypeError('Tournament checkpoint identity or simulation time differs');
    }
    const simulatedAtEpochMs = state.simulatedAtEpochMs;
    const players = requireArray(state.players, 2, 'Tournament players').map((value, index) => {
        assertValidPlayer(value, initial.players[index], simulatedAtEpochMs);
        return value;
    });
    if (players.length !== 2) {
        throw new TypeError('Tournament checkpoint requires both competitors');
    }
    const arena = state.arena;
    assertValidArena(arena, initial.arena);
    const decoded: TournamentArena = {
        gameId: initial.gameId,
        startedAtEpochMs: initial.startedAtEpochMs,
        endsAtEpochMs: initial.endsAtEpochMs,
        simulatedAtEpochMs,
        players,
        arena
    };
    assertValidPlayerProjection(decoded);
    const expectedMatch = state.simulatedAtEpochMs === initial.endsAtEpochMs
        ? finishArenaMatchIfDue({ ...decoded.arena, match: initial.arena.match }, initial.endsAtEpochMs).match
        : initial.arena.match;
    if (!jsonEquals(decoded.arena.match, expectedMatch)) {
        throw new TypeError('Tournament checkpoint match differs from its authorized lifetime or native results');
    }
    return decoded;
}

function assertValidPlayer(
    value: unknown,
    initial: TournamentArenaPlayer,
    simulatedAt: number
): asserts value is TournamentArenaPlayer {
    const player = requireRecord(value, 'Tournament player');
    requireExactKeys(player, ['principalId', 'simulation', 'input', 'inputAtEpochMs'], 'Tournament player');
    requireEpoch(player.inputAtEpochMs, 'Tournament input time');
    if (
        player.principalId !== initial.principalId || player.inputAtEpochMs < initial.inputAtEpochMs ||
        player.inputAtEpochMs >= simulatedAt + 50
    ) {
        throw new TypeError('Tournament player identity or input time differs');
    }
    const input = requireRecord(player.input, 'Tournament stored input');
    if (input.sequence === 0) {
        if (!jsonEquals(input, initial.input) || player.inputAtEpochMs !== initial.inputAtEpochMs) {
            throw new TypeError('Tournament initial input differs');
        }
    }
    else {
        decodeTournamentArenaInput(input);
    }
    const simulation = requireRecord(player.simulation, 'Tournament player simulation');
    requireExactOptionalKeys({
        value: simulation,
        required: ['position', 'velocity', 'yaw', 'pitch', 'grounded', 'combat', 'vitals', 'loadout'],
        optional: ['slideUntilEpochMs', 'dashUntilEpochMs'],
        label: 'Tournament player simulation'
    });
    requireVector(simulation.position);
    requireVector(simulation.velocity);
    requireFinite(simulation.yaw, -Math.PI * 2, Math.PI * 2);
    requireFinite(simulation.pitch, -Math.PI / 2, Math.PI / 2);
    if (typeof simulation.grounded !== 'boolean') {
        throw new TypeError('Tournament grounded state is invalid');
    }
    optionalEpochs(simulation, ['slideUntilEpochMs', 'dashUntilEpochMs']);
    assertValidCombat(simulation.combat);
    assertValidVitals(simulation.vitals);
    assertValidLoadout(simulation.loadout);
}

function assertValidCombat(value: unknown): void {
    const combat = requireRecord(value, 'Tournament combat');
    const epochs = ['dashReadyAtEpochMs', 'slideReadyAtEpochMs', 'shotReadyAtEpochMs'];
    const optional = ['overdriveActiveUntilEpochMs', 'lastHitAtEpochMs'];
    requireExactOptionalKeys({
        value: combat,
        required: ['score', 'combo', 'multiplier', 'energy', 'overdrive', ...epochs],
        optional,
        label: 'Tournament combat'
    });
    requireEpoch(combat.score, 'Tournament score');
    requireEpoch(combat.combo, 'Tournament combo');
    requireFinite(combat.multiplier, 1, 5);
    requireFinite(combat.energy, 0, 100);
    requireFinite(combat.overdrive, 0, 100);
    for (const key of epochs) {
        requireEpoch(combat[key], `Tournament ${key}`);
    }
    optionalEpochs(combat, optional);
}

function assertValidVitals(value: unknown): void {
    const vitals = requireRecord(value, 'Tournament vitals');
    const optional = ['deadUntilEpochMs', 'respawnedAtEpochMs', 'lastDamagedAtEpochMs'];
    requireExactOptionalKeys({
        value: vitals,
        required: ['health', 'maxHealth', 'deaths', 'kills'],
        optional,
        label: 'Tournament vitals'
    });
    if (vitals.maxHealth !== 100) {
        throw new TypeError('Tournament maximum health differs from native rules');
    }
    requireFinite(vitals.health, 0, 100);
    requireEpoch(vitals.deaths, 'Tournament deaths');
    requireEpoch(vitals.kills, 'Tournament kills');
    optionalEpochs(vitals, optional);
}

function assertValidLoadout(value: unknown): void {
    const loadout = requireRecord(value, 'Tournament loadout');
    requireExactOptionalKeys({
        value: loadout,
        required: ['weaponKind', 'tier'],
        optional: ['pickedAtEpochMs'],
        label: 'Tournament loadout'
    });
    const weaponKind = requireOneOf(loadout.weaponKind, Object.keys(WEAPON_STATS), 'Tournament weapon');
    if (loadout.tier !== WEAPON_STATS[weaponKind as keyof typeof WEAPON_STATS].tier) {
        throw new TypeError('Tournament weapon tier differs');
    }
    optionalEpochs(loadout, ['pickedAtEpochMs']);
}

function assertValidArena(value: unknown, initial: ArenaSimulationState): asserts value is ArenaSimulationState {
    const arena = requireRecord(value, 'Tournament arena');
    requireExactKeys(arena, [
        'revision',
        'seed',
        'layout',
        'targets',
        'pickups',
        'players',
        'attacks',
        'wave',
        'match',
        'events',
        'activeEvent',
        'nextPickupSeq',
        'nextPickupAtEpochMs'
    ], 'Tournament arena');
    for (const key of ['revision', 'nextPickupSeq', 'nextPickupAtEpochMs']) {
        requireEpoch(arena[key], `Tournament ${key}`);
    }
    if (arena.seed !== initial.seed || !jsonEquals(arena.layout, initial.layout)) {
        throw new TypeError('Tournament native layout or seed differs');
    }
    const targets = requireArray(arena.targets, 21, 'Tournament targets');
    targets.forEach(assertValidTarget);
    uniqueIdentities(targets, 'id');
    const pickups = requireArray(arena.pickups, 8, 'Tournament pickups');
    pickups.forEach(assertValidPickup);
    uniqueIdentities(pickups, 'id');
    const attacks = requireArray(arena.attacks, 12, 'Tournament attacks');
    attacks.forEach(assertValidAttack);
    uniqueIdentities(attacks, 'id');
    requireArray(arena.events, 24, 'Tournament events').forEach(assertValidEvent);
    assertValidEvent(arena.activeEvent);
    assertValidWave(arena.wave);
    requireArray(arena.players, 2, 'Tournament arena players').forEach(assertValidArenaPlayer);
}

function assertValidTarget(value: unknown): void {
    const target = requireRecord(value, 'Tournament target');
    requireExactOptionalKeys({
        value: target,
        required: ['id', 'position', 'velocity', 'radius', 'health', 'maxHealth', 'rarity', 'phase', 'color'],
        optional: ['threat', 'bountyUntilEpochMs'],
        label: 'Tournament target'
    });
    requireString(target.id, 'Tournament target ID');
    requireString(target.color, 'Tournament target color');
    requireVector(target.position);
    requireVector(target.velocity);
    requireFinite(target.radius, 0, 10);
    requireFinite(target.maxHealth, 0, 100);
    requireFinite(target.health, 0, target.maxHealth as number);
    requireFinite(target.phase, 0, Math.PI * 2);
    requireOneOf(target.rarity, ['common', 'volatile', 'bounty', 'rift'], 'Tournament target rarity');
    optionalEpochs(target, ['bountyUntilEpochMs']);
    if (target.threat !== undefined) {
        assertValidThreat(target.threat);
    }
}

function assertValidThreat(value: unknown): void {
    const threat = requireRecord(value, 'Tournament threat');
    requireExactOptionalKeys({
        value: threat,
        required: ['kind', 'damage', 'range', 'coneRadians', 'windupMs', 'cooldownMs', 'nextAttackAtEpochMs'],
        optional: ['targetSessionId'],
        label: 'Tournament threat'
    });
    requireOneOf(threat.kind, ['passive', 'beam-sentry', 'boss'], 'Tournament threat kind');
    for (const key of ['damage', 'range', 'coneRadians']) {
        requireFinite(threat[key], 0, 1000);
    }
    for (const key of ['windupMs', 'cooldownMs', 'nextAttackAtEpochMs']) {
        requireEpoch(threat[key], `Tournament ${key}`);
    }
    if (threat.targetSessionId !== undefined) {
        requireString(threat.targetSessionId, 'Tournament threat target');
    }
}

function assertValidPickup(value: unknown): void {
    const pickup = requireRecord(value, 'Tournament pickup');
    requireExactOptionalKeys({
        value: pickup,
        required: ['id', 'weaponKind', 'tier', 'position', 'anchorId', 'spawnedAtEpochMs', 'expiresAtEpochMs', 'label'],
        optional: ['pickedBySessionId', 'pickedAtEpochMs'],
        label: 'Tournament pickup'
    });
    for (const key of ['id', 'anchorId', 'label']) {
        requireString(pickup[key], `Tournament pickup ${key}`);
    }
    assertValidLoadout({ weaponKind: pickup.weaponKind, tier: pickup.tier });
    requireVector(pickup.position);
    requireEpoch(pickup.spawnedAtEpochMs, 'Tournament pickup spawn');
    requireEpoch(pickup.expiresAtEpochMs, 'Tournament pickup expiry');
    if (pickup.expiresAtEpochMs <= pickup.spawnedAtEpochMs) {
        throw new TypeError('Tournament pickup lifetime is invalid');
    }
    if (pickup.pickedBySessionId !== undefined) {
        requireString(pickup.pickedBySessionId, 'Tournament pickup claimant');
        requireEpoch(pickup.pickedAtEpochMs, 'Tournament pickup claim time');
    }
    else if (pickup.pickedAtEpochMs !== undefined) {
        throw new TypeError('Tournament pickup has no claimant');
    }
}

function assertValidAttack(value: unknown): void {
    const attack = requireRecord(value, 'Tournament eye attack');
    requireExactKeys(attack, [
        'id',
        'targetId',
        'targetSessionId',
        'origin',
        'aimPoint',
        'damage',
        'range',
        'coneRadians',
        'startsAtEpochMs',
        'firesAtEpochMs',
        'expiresAtEpochMs',
        'revision'
    ], 'Tournament eye attack');
    for (const key of ['id', 'targetId', 'targetSessionId']) {
        requireString(attack[key], `Tournament attack ${key}`);
    }
    requireVector(attack.origin);
    requireVector(attack.aimPoint);
    for (const key of ['damage', 'range', 'coneRadians']) {
        requireFinite(attack[key], 0, 1000);
    }
    for (const key of ['startsAtEpochMs', 'firesAtEpochMs', 'expiresAtEpochMs', 'revision']) {
        requireEpoch(attack[key], `Tournament attack ${key}`);
    }
    if (
        (attack.startsAtEpochMs as number) > (attack.firesAtEpochMs as number) ||
        (attack.firesAtEpochMs as number) >= (attack.expiresAtEpochMs as number)
    ) {
        throw new TypeError('Tournament attack lifetime is invalid');
    }
}

function assertValidEvent(value: unknown): void {
    const event = requireRecord(value, 'Tournament native event');
    requireExactOptionalKeys({
        value: event,
        required: [
            'id',
            'kind',
            'radius',
            'intensity',
            'durationMs',
            'startsAtEpochMs',
            'expiresAtEpochMs',
            'revision',
            'source',
            'headline'
        ],
        optional: ['position'],
        label: 'Tournament native event'
    });
    requireOneOf(event.kind, [
        'weapon-drop',
        'weapon-picked-up',
        'player-hit',
        'player-eliminated',
        'player-respawned',
        'wave-start',
        'wave-complete',
        'eye-attack-windup',
        'eye-attack-hit',
        'eye-attack-dodged',
        'match-started',
        'match-ended'
    ], 'Tournament event kind');
    for (const key of ['id', 'headline']) {
        requireString(event[key], `Tournament event ${key}`);
    }
    for (const key of ['durationMs', 'startsAtEpochMs', 'expiresAtEpochMs', 'revision']) {
        requireEpoch(event[key], `Tournament event ${key}`);
    }
    for (const key of ['radius', 'intensity']) {
        requireFinite(event[key], 0, 1000);
    }
    if (event.source !== 'director') {
        throw new TypeError('Tournament event source differs from native simulation');
    }
    if (event.position !== undefined) {
        requireVector(event.position);
    }
}

function assertValidWave(value: unknown): void {
    const wave = requireRecord(value, 'Tournament wave');
    requireExactOptionalKeys({
        value: wave,
        required: [
            'number',
            'phase',
            'startedAtEpochMs',
            'nextPhaseAtEpochMs',
            'targetBudget',
            'hostileBudget',
            'pickupRewardBudget'
        ],
        optional: ['activeModifierId'],
        label: 'Tournament wave'
    });
    for (
        const key of [
            'number',
            'startedAtEpochMs',
            'nextPhaseAtEpochMs',
            'targetBudget',
            'hostileBudget',
            'pickupRewardBudget'
        ]
    ) {
        requireEpoch(wave[key], `Tournament wave ${key}`);
    }
    requireOneOf(wave.phase, ['warmup', 'active', 'reward'], 'Tournament wave phase');
    if (wave.activeModifierId !== undefined) {
        requireString(wave.activeModifierId, 'Tournament wave modifier');
    }
}

function assertValidArenaPlayer(value: unknown): void {
    const player = requireRecord(value, 'Tournament arena player');
    requireExactKeys(player, [
        'sessionId',
        'username',
        'color',
        'score',
        'position',
        'rotation',
        'vitals',
        'loadout',
        'seq',
        'updatedAtEpochMs'
    ], 'Tournament arena player');
    for (const key of ['sessionId', 'username', 'color']) {
        requireString(player[key], `Tournament arena player ${key}`);
    }
    for (const key of ['score', 'seq', 'updatedAtEpochMs']) {
        requireEpoch(player[key], `Tournament arena player ${key}`);
    }
    requireVector(player.position);
    requireVector(player.rotation);
    assertValidVitals(player.vitals);
    assertValidLoadout(player.loadout);
}

function assertValidPlayerProjection(state: TournamentArena): void {
    if (state.arena.players.length !== 2) {
        throw new TypeError('Tournament arena projection requires both competitors');
    }
    for (const player of state.players) {
        const projected = state.arena.players.find((entry) => entry.sessionId === player.principalId);
        const simulation = player.simulation;
        if (
            projected === undefined || projected.username !== player.principalId ||
            projected.score !== simulation.combat.score ||
            !jsonEquals(projected.position, simulation.position) ||
            !jsonEquals(projected.rotation, [simulation.pitch, simulation.yaw, 0]) ||
            !jsonEquals(projected.vitals, simulation.vitals) || !jsonEquals(projected.loadout, simulation.loadout)
        ) {
            throw new TypeError('Tournament player projection differs from authoritative state');
        }
    }
}

function requireArray(value: unknown, maximum: number, label: string): readonly unknown[] {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new TypeError(`${label} must be a bounded array`);
    }
    return value;
}

function requireFinite(value: unknown, minimum: number, maximum: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new TypeError('Tournament numeric state is invalid');
    }
}

function requireVector(value: unknown): void {
    if (!Array.isArray(value) || value.length !== 3) {
        throw new TypeError('Tournament vector must have three coordinates');
    }
    value.forEach((coordinate) => requireFinite(coordinate, -10000, 10000));
}

function optionalEpochs(record: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
    for (const key of keys) {
        if (record[key] !== undefined) {
            requireEpoch(record[key], `Tournament ${key}`);
        }
    }
}

function uniqueIdentities(values: readonly unknown[], field: string): void {
    const identities = values.map((value) => requireRecord(value, 'Tournament entity')[field]);
    if (new Set(identities).size !== values.length) {
        throw new TypeError('Tournament entity identities must be unique');
    }
}
