import type { FriendsRefusal } from '@shared/api/friends/friends-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RuntimeStateGuardedBatchUpdate } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import { materializeGroupStateAuthorityGuard } from '../group-state/persistence/aggregate/group-aggregate-repository.ts';

import { computeFriendProfiles } from './compute-friend-profiles.ts';
import type {
    FriendsMutationComputed,
    FriendsMutationRead,
    FriendsProfileWrite
} from './friends-mutation-contracts.ts';
import { decodeFriendsProfile, friendsProfileKey, type FriendsProfile } from './friends-profile.ts';

export function computeFriendsMutation(read: FriendsMutationRead): FriendsMutationComputed {
    const identity = { principalId: read.input.principalId, requestId: read.input.requestId };
    const decision = isFriendsAuthorityCurrent(read)
        ? computeFriendProfiles(read)
        : Either.ofLeft<FriendsRefusal, readonly FriendsProfile[]>('unauthorized');
    if (decision.left !== undefined) {
        return {
            read,
            profiles: [],
            writes: [],
            guards: [],
            result: { ...identity, status: 'refused', code: decision.left }
        };
    }
    const profiles = decision.right!;
    if (
        profiles.some((profile) =>
            profile.contacts.length > read.config.maxContacts || profile.invitations.length > read.config.maxInvitations
        )
    ) {
        return {
            read,
            profiles: [],
            writes: [],
            guards: [],
            result: { ...identity, status: 'refused', code: 'capacity' }
        };
    }
    const writes = profiles.map((profile) => toFriendsProfileWrite(read, profile)).toSorted((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    );
    return {
        read,
        profiles,
        writes,
        guards: computeFriendsAuthorityGuards(read),
        result: { ...identity, status: 'applied' }
    };
}

export function validateFriendsMutation(computed: FriendsMutationComputed): readonly string[] {
    return JSON.stringify(computed) === JSON.stringify(computeFriendsMutation(computed.read))
        ? []
        : ['Friends mutation differs from its complete read and command'];
}

function toFriendsProfileWrite(read: FriendsMutationRead, profile: FriendsProfile): FriendsProfileWrite {
    const previous = profile.principalId === read.actor.profile.principalId ? read.actor : read.target;
    if (previous === null || previous.profile.principalId !== profile.principalId) {
        throw new TypeError('Friends write has no captured account predecessor');
    }
    const canonical = decodeFriendsProfile(profile, profile.principalId);
    return {
        key: friendsProfileKey(profile.principalId),
        expectedRevision: previous.entry?.revision ?? null,
        value: JSON.stringify(canonical),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

function isFriendsAuthorityCurrent(read: FriendsMutationRead): boolean {
    const session = read.session?.value;
    return session !== undefined && session.clientId === read.input.principalId &&
        session.sessionId === read.input.sessionId &&
        session.issuedAtEpochMs === read.input.sessionIssuedAtEpochMs &&
        session.expiresAtEpochMs === read.input.sessionExpiresAtEpochMs &&
        session.expiresAtEpochMs > read.nowEpochMs;
}

function computeFriendsAuthorityGuards(read: FriendsMutationRead): readonly RuntimeStateGuardedBatchUpdate[] {
    const session = read.session;
    if (session === null) {
        throw new TypeError('Accepted friends mutation requires a captured session');
    }
    const guards: RuntimeStateGuardedBatchUpdate[] = [{
        operation: 'update',
        namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
        key: session.entry.key,
        value: session.entry.value,
        expectedRevision: session.entry.revision,
        expireAtTimestamp: session.entry.expireAtTimestamp
    }];
    if (read.input.request.action === 'invite' && read.destination !== null) {
        guards.push(materializeGroupStateAuthorityGuard(read.destination.authorityGuard));
    }
    return guards;
}
