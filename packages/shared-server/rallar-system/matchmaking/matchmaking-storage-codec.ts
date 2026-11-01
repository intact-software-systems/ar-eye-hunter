import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { MatchmakingFinished } from './matchmaking-pool.ts';
import type { MatchmakingRepository } from './matchmaking-repository.ts';

export function decodeMatchmakingFinishedEntry(
    entry: RuntimeStateEntry,
    identity: MatchmakingRepository.FinishedIdentity
): MatchmakingFinished {
    if (entry.key !== matchmakingFinishedKey(identity.scope, identity.principalId, identity.searchId)) {
        throw new TypeError('Finished search storage key differs');
    }
    const stored = requireRecord(JSON.parse(entry.value), 'Finished search record');
    requireExactKeys(stored, ['scope', 'search'], 'Finished search record');
    if (!jsonEquals(stored.scope, identity.scope)) {
        throw new TypeError('Finished search scope differs');
    }
    return decodeFinishedSearch(stored.search, identity);
}

export function decodeMatchmakingAccountEntry(
    entry: RuntimeStateEntry,
    input: Pick<MatchmakingRepository.AccountRead, 'scope' | 'principalId'>
): string {
    const { scope, principalId } = input;
    const value = requireRecord(JSON.parse(entry.value), 'Search account lookup');
    requireExactKeys(value, ['scope', 'principalId', 'searchId'], 'Search account lookup');
    requireString(value.searchId, 'Account search identity');
    if (
        entry.key !== matchmakingAccountKey(scope, principalId) || value.principalId !== principalId ||
        !jsonEquals(value.scope, scope)
    ) {
        throw new TypeError('Search account lookup identity differs');
    }
    return value.searchId;
}

export function matchmakingAccountKey(scope: StateScope, principalId: string): string {
    requireString(principalId, 'Matchmaking account');
    return `${groupStateScopeStorageKey(scope)}:principal=${encodeURIComponent(principalId)}`;
}

export function matchmakingFinishedKey(scope: StateScope, principalId: string, searchId: string): string {
    requireString(searchId, 'Matchmaking search');
    return `${matchmakingAccountKey(scope, principalId)}:search=${encodeURIComponent(searchId)}`;
}

function decodeFinishedSearch(value: unknown, identity: MatchmakingRepository.FinishedIdentity): MatchmakingFinished {
    const { scope, principalId, searchId } = identity;
    const search = requireRecord(value, 'Finished search');
    requireExactKeys(search, [
        'searchId',
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'createdAtEpochMs',
        'expiresAtEpochMs',
        'completedAtEpochMs',
        'reason',
        'roomRef',
        'leaderPrincipalId'
    ], 'Finished search');
    if (search.principalId !== principalId || search.searchId !== searchId) {
        throw new TypeError('Finished search account or search identity differs');
    }
    requireString(search.sessionId, 'Finished search session');
    requireEpoch(search.sessionIssuedAtEpochMs, 'Finished search session issuance');
    requireEpoch(search.sessionExpiresAtEpochMs, 'Finished search session expiry');
    requireEpoch(search.createdAtEpochMs, 'Finished search creation');
    requireEpoch(search.expiresAtEpochMs, 'Finished search deadline');
    requireEpoch(search.completedAtEpochMs, 'Finished search completion');
    const reason = requireOneOf(search.reason, [
        'search-timeout',
        'confirmation-timeout',
        'cancelled',
        'declined',
        'matched',
        'admission-denied'
    ], 'Finished search reason');
    if (search.completedAtEpochMs < search.createdAtEpochMs || search.expiresAtEpochMs <= search.createdAtEpochMs) {
        throw new TypeError('Finished search lifetime is invalid');
    }
    const destination = decodeFinishedDestination(search, scope, reason);
    return {
        principalId,
        searchId,
        sessionId: search.sessionId,
        sessionIssuedAtEpochMs: search.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: search.sessionExpiresAtEpochMs,
        createdAtEpochMs: search.createdAtEpochMs,
        expiresAtEpochMs: search.expiresAtEpochMs,
        completedAtEpochMs: search.completedAtEpochMs,
        reason,
        ...destination
    };
}

function decodeFinishedDestination(
    value: unknown,
    scope: StateScope,
    reason: MatchmakingFinished['reason']
): Pick<MatchmakingFinished, 'roomRef' | 'leaderPrincipalId'> {
    const search = requireRecord(value, 'Finished search destination');
    if (reason !== 'matched') {
        if (search.roomRef !== null || search.leaderPrincipalId !== null) {
            throw new TypeError('An unsuccessful search cannot grant a destination');
        }
        return { roomRef: null, leaderPrincipalId: null };
    }
    const room = requireRecord(search.roomRef, 'Matched destination');
    requireExactKeys(room, ['applicationId', 'workspaceId', 'groupId'], 'Matched destination');
    requireString(room.groupId, 'Matched group');
    requireString(search.leaderPrincipalId, 'Matched leader');
    if (room.applicationId !== scope.applicationId || room.workspaceId !== scope.workspaceId) {
        throw new TypeError('Matched destination scope differs');
    }
    return { roomRef: { ...scope, groupId: room.groupId }, leaderPrincipalId: search.leaderPrincipalId };
}
