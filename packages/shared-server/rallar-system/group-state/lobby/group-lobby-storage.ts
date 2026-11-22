import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { isSameGroupRef, isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { GroupPresenceSession, GroupScope, GroupRef } from '@shared/api/group-types.ts';
import { projectRoomLobbySeat, decodeRoomLobby, decodeRoomLobbyAccountView, type RoomLobbyAccountView, type RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { isExactlyAdmitted } from '../mutation/aggregate/group-aggregate-mutation-policy.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { groupStateGroupStorageKey, groupStateScopeStorageKey, groupStateChildStorageKeySuffix } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '../persistence/group-state-persistence-contracts.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';

export const GROUP_LOBBIES_NAMESPACE = 'group-state:room-lobbies';
export const GROUP_LOBBY_COMMITMENTS_NAMESPACE = 'group-state:room-lobby-commitments';

export interface GroupLobbyRead {
    readonly lobby: RuntimeStateEntryValue<RoomLobby> | null;
    readonly sessions: readonly GroupPresenceSession[];
    readonly accounts: readonly { readonly principalId: string; readonly stored: RuntimeStateEntryValue<RoomLobbyAccountView> | null; }[];
}

export function lobbyCommitmentKey(scope: GroupScope, principalId: string): string {
    return groupStateScopeStorageKey(scope) + groupStateChildStorageKeySuffix('principal', principalId);
}

export function decodeStoredLobby(stored: RuntimeStateEntryValue<JsonWireValue>, ref: GroupRef): RuntimeStateEntryValue<RoomLobby> {
    const value = decodeRoomLobby(stored.value);
    if (stored.entry.key !== groupStateGroupStorageKey(ref) || !isSameGroupRef(value.roomRef, ref)) {
        throw new GroupStateRepositoryInvariantCorruptionError(stored.entry.key, 'Lobby belongs to another room');
    }
    return { entry: stored.entry, value };
}

export function decodeStoredCommitment(stored: RuntimeStateEntryValue<JsonWireValue>, scope: GroupScope, principalId: string): RuntimeStateEntryValue<RoomLobbyAccountView> {
    const value = decodeRoomLobbyAccountView(stored.value);
    if (!value.seat || stored.entry.key !== lobbyCommitmentKey(scope, principalId) || !isSameGroupScope(value.scope, scope) ||
        value.principalId !== principalId) {
        throw new GroupStateRepositoryInvariantCorruptionError(stored.entry.key, 'Lobby commitment belongs to another account or scope');
    }
    return { entry: stored.entry, value };
}

interface ReadGroupLobbyStateInput {
    readonly repository: GroupStateRepository;
    readonly roomRef: GroupRef;
    readonly principalIds: readonly string[];
    readonly mode?: 'active' | 'expired';
}

export async function readGroupLobbyState({ repository, roomRef, principalIds, mode = 'active' }: ReadGroupLobbyStateInput): Promise<GroupLobbyRead> {
    // An arrival commits its presence and roster together. A later arrival must invalidate this roster predecessor.
    const commitments = await readGroupLobbyCommitments({ repository, roomRef, principalIds, mode });
    const [sessions, admissions] = await Promise.all([
        repository.listPresenceSessions(roomRef),
        repository.listPresenceAdmissions(roomRef)
    ]);
    const principals = new Map(admissions.map(admission => [admission.principalId, admission]));
    return { ...commitments, sessions: sessions.filter(session => isExactlyAdmitted(principals.get(session.principalId), session)) };
}

interface ReadGroupLobbyCommitmentsInput {
    readonly repository: Pick<GroupStateRepository, 'findGroupLobbyEntry' | 'findLobbyCommitmentEntry'>;
    readonly roomRef: GroupRef;
    readonly principalIds: readonly string[];
    readonly mode?: 'active' | 'expired';
}

export async function readGroupLobbyCommitments(
    { repository, roomRef, principalIds, mode = 'active' }: ReadGroupLobbyCommitmentsInput
): Promise<Pick<GroupLobbyRead, 'lobby' | 'accounts'>> {
    const lobby = await repository.findGroupLobbyEntry(roomRef) ?? null;
    const seats = new Map(lobby?.value.seats.map(seat => [seat.principalId, seat]));
    const accounts = await Promise.all([...new Set([...principalIds, ...seats.keys()])].map(async principalId => {
        const stored = await repository.findLobbyCommitmentEntry(roomRef, principalId) ?? null;
        const seat = seats.get(principalId);
        if (mode === 'active' && seat && !jsonEquals(stored?.value.seat, projectRoomLobbySeat(roomRef, seat))) throw new RuntimeStateWriteConflictError();
        return { principalId, stored };
    }));
    return { lobby, accounts };
}

/** Commit the room CAS and only the account projections or storage lifetimes that changed. */
interface ComputeGroupLobbyEffectsInput {
    readonly read: Pick<GroupLobbyRead, 'lobby' | 'accounts'>;
    readonly after: RoomLobby | null;
    readonly roomRef: GroupRef;
    readonly mode?: 'active' | 'expired';
}

export function computeGroupLobbyEffects(
    { read, after, roomRef, mode = 'active' }: ComputeGroupLobbyEffectsInput
): RuntimeStateGuardedBatchEffect[] {
    const before = read.lobby;
    if (before?.value === after || (!before && !after)) return [];
    const row = { namespace: GROUP_LOBBIES_NAMESPACE, key: groupStateGroupStorageKey(roomRef), effectId: 'lobby' };
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    if (after) {
        effects.push({
            ...row, ...conditionalUpsert(before), value: JSON.stringify(after), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
    } else if (before) {
        effects.push({ ...row, operation: 'delete', expectedRevision: before.entry.revision });
    }
    const previousSeats = new Map(before?.value.seats.map(seat => [seat.principalId, seat]));
    const nextSeats = new Map(after?.seats.map(seat => [seat.principalId, seat]));
    const accounts = new Map(read.accounts.map(account => [account.principalId, account]));
    const scope = { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId };
    for (const principalId of new Set([...previousSeats.keys(), ...nextSeats.keys()])) {
        const previous = projectRoomLobbySeat(roomRef, previousSeats.get(principalId));
        const next = projectRoomLobbySeat(roomRef, nextSeats.get(principalId));
        const expiry = after?.expiresAtEpochMs ?? NEVER_EXPIRE_AT_TIMESTAMP;
        const account = accounts.get(principalId);
        if (!account) throw new TypeError('A lobby commitment change requires the observed account slot');
        if (jsonEquals(previous, next) && account.stored?.entry.expireAtTimestamp === expiry) continue;
        const identity = { namespace: GROUP_LOBBY_COMMITMENTS_NAMESPACE, key: lobbyCommitmentKey(roomRef, principalId), effectId: 'lobby-account:' + principalId };
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

function conditionalUpsert(stored: Pick<RuntimeStateEntryValue<JsonWireValue>, 'entry'> | null) {
    return stored
        ? { operation: 'update-exact', expectedRevision: stored.entry.revision, expectedValue: stored.entry.value } as const
        : { operation: 'insert' } as const;
}
