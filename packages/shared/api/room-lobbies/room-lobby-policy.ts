import type { ApiJsonObject } from '../api-json-value.ts';
import { requireEpoch, requireExactKeys, requireRecord } from '../exact-object-decoding.ts';
import type { RoomLobby } from './room-lobby.ts';

export const DEFAULT_ROOM_LOBBY_POLICY: RoomLobby.Policy = Object.freeze({ returnWindowMs: 120000, claimWindowMs: 60000 });
export const ROOM_LOBBY_METADATA_KEY = 'rallarRoomLobby';

export function decodePositiveLobbyInteger(value: unknown, label: string): number {
    requireEpoch(value, label);
    if (value === 0) throw new TypeError(`${label} must be positive`);
    return value;
}

export function decodeRoomLobbyPolicy(value: unknown): RoomLobby.Policy {
    const policy = requireRecord(value, 'Room lobby policy');
    requireExactKeys(policy, ['returnWindowMs', 'claimWindowMs'], 'Room lobby policy');
    return {
        returnWindowMs: decodePositiveLobbyInteger(policy.returnWindowMs, 'Return duration'),
        claimWindowMs: decodePositiveLobbyInteger(policy.claimWindowMs, 'Claim duration')
    };
}

export function roomLobbyApplicationDefault(
    policies: Readonly<Record<string, RoomLobby.Policy>> | undefined,
    applicationId: string
): RoomLobby.Policy | undefined {
    return policies && Object.hasOwn(policies, applicationId) ? policies[applicationId] : undefined;
}

export function readRoomLobbyPolicy(metadata: ApiJsonObject): RoomLobby.Policy | null {
    return Object.hasOwn(metadata, ROOM_LOBBY_METADATA_KEY) ? decodeRoomLobbyPolicy(metadata[ROOM_LOBBY_METADATA_KEY]) : null;
}
