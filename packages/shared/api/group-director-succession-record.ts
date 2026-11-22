import type { ApiJsonObject } from './api-json-value.ts';
import { requireEpoch, requireExactKeys, requireExactOptionalKeys, requireRecord, requireString } from './exact-object-decoding.ts';

export const ROOM_DIRECTOR_SUCCESSION_METADATA_KEY = 'rallarDirectorSuccession';

export namespace RoomDirectorSuccession {
    export interface Policy {
        readonly reconnectWindowMs: number;
        readonly deputyWindowMs: number;
        readonly deputyPrincipalId: string | null;
    }
    export interface Loss {
        readonly directorEpoch: number;
        readonly lostAtEpochMs: number;
        readonly reconnectUntilEpochMs: number;
        readonly deputyUntilEpochMs: number;
        readonly declined: boolean;
    }
    export type Command = { readonly expectedDirectorEpoch: number } & (
        | ({ readonly operation: 'configure'; readonly expectedRevision: number } & Pick<Policy, 'deputyPrincipalId'> & Partial<Pick<Policy, 'reconnectWindowMs' | 'deputyWindowMs'>>)
        | { readonly operation: 'appoint'; readonly targetPrincipalId: string; readonly targetSessionId: string }
        | { readonly operation: 'claim-deputy' | 'decline-deputy' }
    );
}

export interface RoomDirectorSuccession extends RoomDirectorSuccession.Policy {
    readonly revision: number;
    readonly directorLeaseExpiresAtEpochMs: number | null;
    readonly spectatorDirectorEpoch: number | null;
    readonly loss: RoomDirectorSuccession.Loss | null;
}

function readPolicy(record: Record<string, unknown>): RoomDirectorSuccession.Policy {
    const { reconnectWindowMs, deputyWindowMs, deputyPrincipalId } = record;
    requireEpoch(reconnectWindowMs, 'Reconnect window');
    requireEpoch(deputyWindowMs, 'Deputy window');
    if (deputyPrincipalId !== null) requireString(deputyPrincipalId, 'Designated deputy');
    return { reconnectWindowMs, deputyWindowMs, deputyPrincipalId };
}

export function decodeRoomDirectorSuccessionCommand(value: unknown): RoomDirectorSuccession.Command {
    const record = requireRecord(value, 'Director succession command');
    const { operation, expectedDirectorEpoch } = record;
    requireEpoch(expectedDirectorEpoch, 'Expected director epoch');
    const common = ['operation', 'expectedDirectorEpoch'];
    if (operation === 'configure') {
        requireExactOptionalKeys({ value: record, required: [...common, 'expectedRevision', 'deputyPrincipalId'],
            optional: ['reconnectWindowMs', 'deputyWindowMs'], label: 'Director succession policy command' });
        const { deputyPrincipalId, reconnectWindowMs, deputyWindowMs } = record;
        if (deputyPrincipalId !== null) requireString(deputyPrincipalId, 'Designated deputy');
        if (reconnectWindowMs !== undefined) requireEpoch(reconnectWindowMs, 'Reconnect window');
        if (deputyWindowMs !== undefined) requireEpoch(deputyWindowMs, 'Deputy window');
        requireEpoch(record.expectedRevision, 'Expected succession revision');
        return { operation, expectedDirectorEpoch, expectedRevision: record.expectedRevision, deputyPrincipalId,
            ...(reconnectWindowMs !== undefined && { reconnectWindowMs }), ...(deputyWindowMs !== undefined && { deputyWindowMs }) };
    }
    if (operation === 'appoint') {
        requireExactKeys(record, [...common, 'targetPrincipalId', 'targetSessionId'], 'Director appointment command');
        requireString(record.targetPrincipalId, 'Appointee account');
        requireString(record.targetSessionId, 'Appointee session');
        return { operation, expectedDirectorEpoch, targetPrincipalId: record.targetPrincipalId, targetSessionId: record.targetSessionId };
    }
    requireExactKeys(record, common, 'Director claim command');
    if (operation !== 'claim-deputy' && operation !== 'decline-deputy') throw new TypeError('Unknown director succession command');
    return { operation, expectedDirectorEpoch };
}

function decodeDirectorLoss(value: unknown): RoomDirectorSuccession.Loss | null {
    if (value === null) return null;
    const loss = requireRecord(value, 'Director loss');
    requireExactKeys(loss, ['directorEpoch', 'lostAtEpochMs', 'reconnectUntilEpochMs', 'deputyUntilEpochMs', 'declined'], 'Director loss');
    const { directorEpoch, lostAtEpochMs, reconnectUntilEpochMs, deputyUntilEpochMs, declined } = loss;
    requireEpoch(directorEpoch, 'Lost director epoch');
    requireEpoch(lostAtEpochMs, 'Director loss time');
    requireEpoch(reconnectUntilEpochMs, 'Director reconnect cutoff');
    requireEpoch(deputyUntilEpochMs, 'Deputy cutoff');
    if (!directorEpoch || reconnectUntilEpochMs < lostAtEpochMs || deputyUntilEpochMs < reconnectUntilEpochMs ||
        typeof declined !== 'boolean') throw new TypeError('Invalid director loss');
    return { directorEpoch, lostAtEpochMs, reconnectUntilEpochMs, deputyUntilEpochMs, declined };
}

export function readRoomDirectorSuccession(metadata: ApiJsonObject | undefined): RoomDirectorSuccession | null {
    if (!metadata || !Object.hasOwn(metadata, ROOM_DIRECTOR_SUCCESSION_METADATA_KEY)) return null;
    const record = requireRecord(metadata[ROOM_DIRECTOR_SUCCESSION_METADATA_KEY], 'Director succession');
    requireExactKeys(record, ['revision', 'reconnectWindowMs', 'deputyWindowMs', 'deputyPrincipalId', 'spectatorDirectorEpoch', 'directorLeaseExpiresAtEpochMs', 'loss'], 'Director succession');
    requireEpoch(record.revision, 'Succession revision');
    if (!record.revision) throw new TypeError('Invalid stored succession revision');
    const directorLeaseExpiresAtEpochMs = record.directorLeaseExpiresAtEpochMs;
    if (directorLeaseExpiresAtEpochMs !== null) requireEpoch(directorLeaseExpiresAtEpochMs, 'Director lease end');
    const spectatorDirectorEpoch = record.spectatorDirectorEpoch;
    if (spectatorDirectorEpoch !== null) {
        requireEpoch(spectatorDirectorEpoch, 'Appointed spectator epoch');
        if (!spectatorDirectorEpoch) throw new TypeError('Invalid spectator epoch');
    }
    return { revision: record.revision, ...readPolicy(record), directorLeaseExpiresAtEpochMs, spectatorDirectorEpoch, loss: decodeDirectorLoss(record.loss) };
}

export function storeRoomDirectorSuccession(metadata: ApiJsonObject, state: RoomDirectorSuccession, leaseRenewal = false): ApiJsonObject {
    const revision = state.revision + (leaseRenewal ? 0 : 1);
    requireEpoch(revision, 'Succession revision');
    return { ...metadata, [ROOM_DIRECTOR_SUCCESSION_METADATA_KEY]: {
        ...state, revision, loss: state.loss && { ...state.loss }
    } };
}
