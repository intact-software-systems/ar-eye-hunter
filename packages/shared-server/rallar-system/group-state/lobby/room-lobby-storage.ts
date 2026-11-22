import { isSameGroupRef, isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { GroupPresenceSession, GroupScope, GroupRef } from '@shared/api/group-types.ts';
import { decodeRoomLobby, decodeRoomLobbyAccountView, projectRoomLobbyAccount, type RoomLobbyAccountView, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { groupStateGroupStorageKey, groupStateScopeStorageKey, groupStateChildStorageKeySuffix } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '../persistence/group-state-persistence-contracts.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';

export const ROOM_LOBBIES_NAMESPACE = 'group-state:room-lobbies';
export const ROOM_LOBBY_COMMITMENTS_NAMESPACE = 'group-state:room-lobby-commitments';

export interface RoomLobbyRead {
    readonly lobby: RuntimeStateEntryValue<RoomLobby> | null;
    readonly sessions: readonly GroupPresenceSession[];
    readonly accounts: readonly { readonly principalId: string; readonly stored: RuntimeStateEntryValue<RoomLobbyAccountView> | null; }[];
}

export function lobbyCommitmentKey(scope: GroupScope, principalId: string): string {
    return groupStateScopeStorageKey(scope) + groupStateChildStorageKeySuffix('principal', principalId);
}

export function decodeStoredLobby(stored: RuntimeStateEntryValue<unknown>, ref: GroupRef): RuntimeStateEntryValue<RoomLobby> {
    const value = decodeRoomLobby(stored.value);
    if (stored.entry.key !== groupStateGroupStorageKey(ref) || !isSameGroupRef(value.roomRef, ref)) {
        throw new GroupStateRepositoryInvariantCorruptionError(stored.entry.key, 'Lobby belongs to another room');
    }
    return { entry: stored.entry, value };
}

export function decodeStoredCommitment(stored: RuntimeStateEntryValue<unknown>, scope: GroupScope, principalId: string): RuntimeStateEntryValue<RoomLobbyAccountView> {
    const value = decodeRoomLobbyAccountView(stored.value);
    if (!value.seat || stored.entry.key !== lobbyCommitmentKey(scope, principalId) || !isSameGroupScope(value.scope, scope) ||
        value.principalId !== principalId) {
        throw new GroupStateRepositoryInvariantCorruptionError(stored.entry.key, 'Lobby commitment belongs to another account or scope');
    }
    return { entry: stored.entry, value };
}

export async function readRoomLobbyState(repository: GroupStateRepository, roomRef: GroupRef, principalIds: readonly string[]): Promise<RoomLobbyRead> {
    const lobby = await repository.findRoomLobbyEntry(roomRef) ?? null;
    const accounts = new Set([...principalIds, ...(lobby?.value.seats.map(seat => seat.principalId) ?? [])]);
    const sessions = await repository.listPresenceSessions(roomRef);
    return { lobby, sessions, accounts: await Promise.all([...accounts].map(async principalId => ({
        principalId, stored: await repository.findLobbyCommitmentEntry(roomRef, principalId) ?? null
    }))) };
}

/** The room write and changes to the scope's exclusive account slots commit together. */
export function computeRoomLobbyEffects(read: RoomLobbyRead, after: RoomLobby | null, roomRef: GroupRef): RuntimeStateGuardedBatchEffect[] {
    const before = read.lobby;
    if (before?.value === after || (!before && !after)) return [];
    const row = { namespace: ROOM_LOBBIES_NAMESPACE, key: groupStateGroupStorageKey(roomRef), effectId: 'lobby' };
    const effects: RuntimeStateGuardedBatchEffect[] = after ? [{
        ...row, ...(before ? { operation: 'update-exact', expectedRevision: before.entry.revision, expectedValue: before.entry.value } as const
            : { operation: 'insert' } as const), value: JSON.stringify(after), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    }] : [{ ...row, operation: 'delete', expectedRevision: before!.entry.revision }];
    const previous = new Set(before?.value.seats.map(seat => seat.principalId));
    const next = new Set(after?.seats.map(seat => seat.principalId));
    for (const principalId of new Set([...previous, ...next])) {
        const scope = { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId };
        const previousView = projectRoomLobbyAccount(scope, principalId, before?.value ?? null);
        const nextView = projectRoomLobbyAccount(scope, principalId, after);
        if (jsonEquals(previousView, nextView)) continue;
        const account = read.accounts.find(slot => slot.principalId === principalId);
        if (!account) throw new TypeError('A lobby commitment change requires the observed account slot');
        const identity = { namespace: ROOM_LOBBY_COMMITMENTS_NAMESPACE, key: lobbyCommitmentKey(roomRef, principalId), effectId: 'lobby-account:' + principalId };
        if (nextView.seat) {
            const stored = account.stored;
            if (stored && (!stored.value.seat || !isSameGroupRef(stored.value.seat.roomRef, roomRef))) {
                throw new TypeError('Lobby admission requires an available account slot');
            }
            effects.push({ ...identity, ...(stored ? {
                operation: 'update-exact' as const, expectedRevision: stored.entry.revision, expectedValue: stored.entry.value
            } : { operation: 'insert' as const }), value: JSON.stringify(nextView), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        } else {
            if (!account.stored || (!account.stored.value.seat || !isSameGroupRef(account.stored.value.seat.roomRef, roomRef))) {
                throw new TypeError('Seat release requires the matching account commitment');
            }
            effects.push({ ...identity, operation: 'delete', expectedRevision: account.stored.entry.revision });
        }
    }
    return effects;
}
