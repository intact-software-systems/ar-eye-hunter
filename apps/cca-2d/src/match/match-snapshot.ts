import Ajv from 'ajv';

import { validateJsonMessageSize } from '@shared/api/json-message-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createTownCreatures } from '../town/creatures/rules.ts';
import { TOWN_OBJECTS, TOWN_SHOPS } from '../town/map.ts';
import { TOWN_PERSONALITIES } from '../town/personalities/state.ts';
import type { TownCheckpoint, TownCheckpointIdentity } from './match-checkpoints.ts';
import { MATCH_SNAPSHOT_SCHEMA } from './match-snapshot-schema.ts';
import { validateTownMatchMembers, type TownMatchState } from './town-match.ts';

export interface TownMatchSnapshot {
    readonly snapshot: string;
    readonly digest: string;
}
export interface TownCheckpointWire extends TownCheckpointIdentity, TownMatchSnapshot {
    readonly matchId: string;
}

export const TOWN_SNAPSHOT_MAX_BYTES = 196_608;
const matchesSnapshot = new Ajv({ strict: true, allErrors: false }).compile<TownMatchState>(MATCH_SNAPSHOT_SCHEMA);

export async function createTownMatchSnapshot(
    state: TownMatchState,
    subtle: Pick<SubtleCrypto, 'digest'>
): Promise<Either<readonly string[], TownMatchSnapshot>> {
    const snapshot = JSON.stringify(state);
    const decoded = decodeTownMatchSnapshot(snapshot);
    if (decoded.left) {
        return Either.ofLeft(decoded.left);
    }
    const digest = await readTownSnapshotDigest(snapshot, subtle);
    return digest.mapRight((value) => ({ snapshot, digest: value }));
}

export async function decodeTownCheckpoint(
    checkpoint: TownCheckpointWire,
    subtle: Pick<SubtleCrypto, 'digest'>
): Promise<Either<readonly string[], TownCheckpoint>> {
    const decoded = decodeTownMatchSnapshot(checkpoint.snapshot);
    if (decoded.left) {
        return Either.ofLeft(decoded.left);
    }
    const digest = await readTownSnapshotDigest(checkpoint.snapshot, subtle);
    if (digest.left) {
        return Either.ofLeft(digest.left);
    }
    if (digest.right !== checkpoint.digest || decoded.right!.matchId !== checkpoint.matchId) {
        return Either.ofLeft(['The checkpoint bytes or match identity differ from the proposal.']);
    }
    return Either.ofRight({
        epoch: checkpoint.epoch,
        sequence: checkpoint.sequence,
        digest: checkpoint.digest,
        state: decoded.right!
    });
}

export function decodeTownMatchSnapshot(serialized: string): Either<readonly string[], TownMatchState> {
    const bounded = validateJsonMessageSize(serialized, TOWN_SNAPSHOT_MAX_BYTES);
    if (bounded.left) {
        return Either.ofLeft([bounded.left.message]);
    }
    let value: unknown;
    try {
        value = JSON.parse(serialized);
    }
    catch {
        return Either.ofLeft(['The match snapshot is not JSON.']);
    }
    if (!matchesSnapshot(value)) {
        return Either.ofLeft(
            matchesSnapshot.errors?.map((error) => `Invalid snapshot ${error.instancePath}: ${error.message}`) ??
                ['Invalid snapshot.']
        );
    }
    const issues = validateTownSnapshotRelations(value);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        ...value,
        interruption: value.interruption,
        players: value.players.map((player) => ({ ...player, rescueTarget: player.rescueTarget })),
        town: {
            ...value.town,
            companion: undefined,
            npcs: value.town.npcs.map((npc) => ({ ...npc, targetId: npc.targetId })),
            creatures: value.town.creatures.map((creature) => ({ ...creature, provokerId: creature.provokerId })),
            personalities: value.town.personalities.map((resident) => ({ ...resident, targetId: resident.targetId })),
            spectacles: { ...value.town.spectacles, active: value.town.spectacles.active }
        }
    });
}

function validateTownSnapshotRelations(state: TownMatchState): readonly string[] {
    const issues = [
        ...validateTownMatchMembers(state.members, state.phase === 'interrupted' || state.phase === 'finished' ? 0 : 1)
    ];
    const playerIds = state.players.map((player) => player.id);
    if (new Set(playerIds).size !== playerIds.length || (playerIds.length === 0 && state.phase !== 'interrupted')) {
        issues.push('Snapshot players must have distinct identities.');
    }
    if (
        state.phase !== 'interrupted' && state.phase !== 'finished' &&
        (state.members.length !== playerIds.length || state.members.some((member) => !playerIds.includes(member.id)))
    ) {
        issues.push('Snapshot players do not match the round roster.');
    }
    if (
        state.tick + state.remainingTicks !== 5400 ||
        (state.phase === 'finished' && (state.remainingTicks !== 0 || state.results.length !== playerIds.length))
    ) {
        issues.push('Snapshot clock or results are inconsistent.');
    }
    if (state.phase !== 'finished' && state.results.length > 0) {
        issues.push('Only a finished round can have results.');
    }
    if (
        state.results.some((result, index) => {
            const player = state.players[index];
            return result.id !== player?.id || result.score !== player.score || result.rescues !== player.rescues ||
                result.qualified !== (player.score >= 100);
        })
    ) {
        issues.push('Snapshot results do not describe the players.');
    }
    return [...issues, ...validateTownSnapshotClock(state), ...validateTownSnapshotMap(state)];
}

function validateTownSnapshotClock(state: TownMatchState): readonly string[] {
    if ((state.phase === 'lobby' || state.phase === 'countdown') && state.tick !== 0) {
        return ['A lobby or countdown cannot contain elapsed round time.'];
    }
    if (state.phase === 'countdown' && state.countdownTicks === 0) {
        return ['A countdown must still have ticks remaining.'];
    }
    if (
        (state.phase === 'lobby' || state.phase === 'playing' || state.phase === 'finished') &&
        state.countdownTicks !== 0
    ) {
        return ['Only a countdown or interrupted countdown may retain countdown ticks.'];
    }
    if (state.phase === 'playing' && state.remainingTicks === 0) {
        return ['A round with no time remaining must be finished.'];
    }
    return [];
}

function validateTownSnapshotMap(state: TownMatchState): readonly string[] {
    const { town } = state;
    const creatures = createTownCreatures();
    const correctShops = town.shops.length === TOWN_SHOPS.length && town.npcs.length === TOWN_SHOPS.length &&
        TOWN_SHOPS.every((shop, index) => town.shops[index].id === shop.id && town.npcs[index].shopId === shop.id);
    const correctObjects = town.objects.length === TOWN_OBJECTS.length && TOWN_OBJECTS.every((object, index) => {
        const actual = town.objects[index];
        return actual.id === object.id && actual.kind === object.kind && actual.owner === object.owner &&
            actual.x === object.x && actual.z === object.z && actual.width === object.width &&
            actual.depth === object.depth;
    });
    const correctResidents = town.personalities.length === TOWN_PERSONALITIES.length &&
        TOWN_PERSONALITIES.every((resident, index) => {
            const actual = town.personalities[index];
            return actual.id === resident.id && actual.kind === resident.kind && actual.color === resident.color &&
                actual.home.x === resident.home.x && actual.home.z === resident.home.z &&
                actual.prop.x === resident.prop.x && actual.prop.z === resident.prop.z &&
                actual.prop.width === resident.prop.width && actual.prop.depth === resident.prop.depth;
        });
    const correctCreatures = town.creatures.length === creatures.length && creatures.every((creature, index) => {
        const actual = town.creatures[index];
        return actual.id === creature.id && actual.kind === creature.kind &&
            actual.home.x === creature.home.x && actual.home.z === creature.home.z;
    });
    return correctShops && correctObjects && correctResidents && correctCreatures
        ? []
        : ['Snapshot scenery and resident identities do not match this town build.'];
}

async function readTownSnapshotDigest(
    snapshot: string,
    subtle: Pick<SubtleCrypto, 'digest'>
): Promise<Either<readonly string[], string>> {
    try {
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
        return Either.ofRight(
            Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
        );
    }
    catch {
        return Either.ofLeft(['Checkpoint verification is unavailable. Use a secure browser connection.']);
    }
}
