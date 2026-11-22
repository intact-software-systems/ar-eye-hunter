import { decodeRoomLobby, decodeRoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { ROOM_LOBBIES_NAMESPACE, ROOM_LOBBY_COMMITMENTS_NAMESPACE, type RoomLobbyRead } from './room-lobby-storage.ts';

/** Subsequent admissions in one transaction see earlier admissions' private seat and account writes. */
export function stageRoomLobbyRead(
    read: RoomLobbyRead | null,
    effects: readonly RuntimeStateGuardedBatchEffect[],
    nowEpochMs: number
): RoomLobbyRead | null {
    if (!read || !effects.length) {
        return read;
    }
    let lobby = read.lobby;
    const accounts = [...read.accounts];
    for (const effect of effects) {
        if (effect.namespace === ROOM_LOBBIES_NAMESPACE) {
            lobby = stageEntry(effect, nowEpochMs, decodeRoomLobby);
        }
        else if (effect.namespace === ROOM_LOBBY_COMMITMENTS_NAMESPACE) {
            const stored = stageEntry(effect, nowEpochMs, decodeRoomLobbyAccountView);
            const index = accounts.findIndex((account) =>
                account.stored?.entry.key === effect.key || stored?.value.principalId === account.principalId
            );
            if (index < 0) {
                throw new TypeError('Staging private lobby seats requires all affected account slots');
            }
            accounts[index] = { ...accounts[index], stored };
        }
    }
    return { ...read, lobby, accounts };
}

function stageEntry<T>(
    effect: RuntimeStateGuardedBatchEffect,
    nowEpochMs: number,
    decode: (value: unknown) => T
): RuntimeStateEntryValue<T> | null {
    if (effect.operation === 'delete') {
        return null;
    }
    if (effect.operation !== 'insert' && effect.operation !== 'update-exact') {
        throw new TypeError('Unsupported lobby write');
    }
    return {
        value: decode(JSON.parse(effect.value)),
        entry: {
            key: effect.key,
            value: effect.value,
            revision: effect.operation === 'insert' ? 0 : effect.expectedRevision + 1,
            expireAtTimestamp: effect.expireAtTimestamp,
            updatedTimestamp: new Date(nowEpochMs).toISOString()
        }
    };
}
