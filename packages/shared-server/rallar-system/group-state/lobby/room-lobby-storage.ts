import { isSameGroupRef, isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { GroupMember, GroupPresenceSession, GroupScope, GroupRef } from '@shared/api/group-types.ts';
import { decodeRoomLobby, decodeRoomLobbyAccountView, type RoomLobbyAccountView, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { isExactlyAdmitted } from '../mutation/aggregate/group-aggregate-mutation-policy.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { groupStateGroupStorageKey, groupStateScopeStorageKey, groupStateChildStorageKeySuffix } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '../persistence/group-state-persistence-contracts.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';

import { projectRoomLobbyCommitments } from './project-room-lobby-commitments.ts';

export const ROOM_LOBBIES_NAMESPACE = 'group-state:room-lobbies';
export const ROOM_LOBBY_COMMITMENTS_NAMESPACE = 'group-state:room-lobby-commitments';

export interface RoomLobbyRead {
    readonly lobby: RuntimeStateEntryValue<RoomLobby> | null;
    readonly sessions: readonly GroupPresenceSession[];
    readonly candidateMembers: readonly GroupMember[];
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

export async function readRoomLobbyState(
    repository: GroupStateRepository, roomRef: GroupRef, principalIds: readonly string[],
    mode: 'active' | 'expired' = 'active', includeCandidateMembers = false
): Promise<RoomLobbyRead> {
    const [commitments, sessions, admissions, candidateMembers] = await Promise.all([
        readRoomLobbyCommitments(repository, roomRef, principalIds, mode),
        repository.listPresenceSessions(roomRef),
        repository.listPresenceAdmissions(roomRef),
        includeCandidateMembers ? repository.listMembers(roomRef) : []
    ]);
    const principals = new Map(admissions.map(admission => [admission.principalId, admission]));
    return { ...commitments, candidateMembers, sessions: sessions.filter(session => isExactlyAdmitted(principals.get(session.principalId), session)) };
}

export async function readRoomLobbyCommitments(
    repository: Pick<GroupStateRepository, 'findRoomLobbyEntry' | 'findLobbyCommitmentEntry'>,
    roomRef: GroupRef,
    principalIds: readonly string[],
    mode: 'active' | 'expired' = 'active'
): Promise<Pick<RoomLobbyRead, 'lobby' | 'accounts'>> {
    const lobby = await repository.findRoomLobbyEntry(roomRef) ?? null;
    const views = projectRoomLobbyCommitments(roomRef, lobby?.value ?? null);
    const accounts = await Promise.all([...new Set([...principalIds, ...views.keys()])].map(async principalId => {
        const stored = await repository.findLobbyCommitmentEntry(roomRef, principalId) ?? null;
        const seat = views.get(principalId);
        if (mode === 'active' && seat && !jsonEquals(stored?.value.seat, seat)) throw new RuntimeStateWriteConflictError();
        return { principalId, stored };
    }));
    return { lobby, accounts };
}

/** Commit the room CAS and only the account projections or storage lifetimes that changed. */
export function computeRoomLobbyEffects(
    read: Pick<RoomLobbyRead, 'lobby' | 'accounts'>,
    after: RoomLobby | null,
    roomRef: GroupRef,
    mode: 'active' | 'expired' = 'active'
): RuntimeStateGuardedBatchEffect[] {
    const before = read.lobby;
    if (before?.value === after || (!before && !after)) return [];
    const row = { namespace: ROOM_LOBBIES_NAMESPACE, key: groupStateGroupStorageKey(roomRef), effectId: 'lobby' };
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    if (after) {
        effects.push({
            ...row, ...conditionalUpsert(before), value: JSON.stringify(after), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
    } else if (before) {
        effects.push({ ...row, operation: 'delete', expectedRevision: before.entry.revision });
    }
    const previousSeats = projectRoomLobbyCommitments(roomRef, before?.value ?? null);
    const nextSeats = projectRoomLobbyCommitments(roomRef, after);
    const accounts = new Map(read.accounts.map(account => [account.principalId, account]));
    const scope = { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId };
    for (const principalId of new Set([...previousSeats.keys(), ...nextSeats.keys()])) {
        const previous = previousSeats.get(principalId);
        const next = nextSeats.get(principalId);
        const expiry = after?.expiresAtEpochMs ?? NEVER_EXPIRE_AT_TIMESTAMP;
        const account = accounts.get(principalId);
        if (!account) throw new TypeError('A lobby commitment change requires the observed account slot');
        if (jsonEquals(previous, next) && account.stored?.entry.expireAtTimestamp === expiry) continue;
        const identity = { namespace: ROOM_LOBBY_COMMITMENTS_NAMESPACE, key: lobbyCommitmentKey(roomRef, principalId), effectId: 'lobby-account:' + principalId };
        const stored = account.stored;
        const own = stored?.value.seat && isSameGroupRef(stored.value.seat.roomRef, roomRef);
        if (next) {
            if (stored && !own) throw new RuntimeStateWriteConflictError();
            effects.push({
                ...identity, ...conditionalUpsert(stored), value: JSON.stringify({ scope, principalId, seat: next }), expireAtTimestamp: expiry
            });
        } else if (stored && own) {
            effects.push({ ...identity, operation: 'delete', expectedRevision: stored.entry.revision });
        } else if (mode !== 'expired') {
            throw new RuntimeStateWriteConflictError();
        }
    }
    return effects;
}

function conditionalUpsert(stored: RuntimeStateEntryValue<unknown> | null) {
    return stored
        ? { operation: 'update-exact', expectedRevision: stored.entry.revision, expectedValue: stored.entry.value } as const
        : { operation: 'insert' } as const;
}
