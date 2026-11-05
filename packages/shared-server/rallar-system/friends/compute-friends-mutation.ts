import type { FriendsRefusal } from '@shared/api/friends/friends-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchUpdate,
    RuntimeStateGuardedBatchWrite
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import { materializeGroupStateAuthorityGuard } from '../group-state/persistence/aggregate/group-aggregate-repository.ts';

import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '../websocket/outbox/compute-view-invalidation-publication.ts';
import { computeFriendProfiles } from './compute-friend-profiles.ts';
import type {
    FriendsMutationComputed,
    FriendsMutationRead,
    FriendsProfileRead
} from './friends-mutation-contracts.ts';
import {
    areMutualFriends,
    decodeFriendsProfile,
    FRIENDS_PROFILE_NAMESPACE,
    friendsProfileKey,
    type FriendsProfile
} from './friends-profile.ts';

export function computeFriendsMutation(read: FriendsMutationRead): FriendsMutationComputed {
    const identity = { principalId: read.input.principalId, requestId: read.input.requestId };
    const decision = isFriendsAuthorityCurrent(read)
        ? computeFriendProfiles(read)
        : Either.ofLeft<FriendsRefusal, readonly FriendsProfile[]>('unauthorized');
    if (decision.left !== undefined) {
        return refusedFriendsMutation(read, decision.left);
    }
    const profiles = decision.right!;
    if (profiles.some((profile) => exceedsFriendsCapacity(read, profile))) {
        return refusedFriendsMutation(read, 'capacity');
    }
    const audience = computeFriendsViewAudience(read, profiles);
    const publication = computeViewInvalidationPublication({
        resource: 'friends',
        scope: null,
        principalIds: audience,
        changeId: computeSha256CanonicalJson({ principalId: read.input.principalId, requestId: read.input.requestId }),
        createdAtEpochMs: read.nowEpochMs,
        retentionMs: read.finishedRetentionMs,
        serviceId: read.serviceId,
        traceId: read.traceId
    });
    return {
        read,
        profiles,
        outbox: publication.outbox,
        storage: computeFriendsStorage(read, profiles, publication.provenance),
        result: { ...identity, status: 'applied' }
    };
}

function refusedFriendsMutation(read: FriendsMutationRead, code: FriendsRefusal): FriendsMutationComputed {
    return {
        read,
        profiles: [],
        storage: null,
        outbox: [],
        result: { principalId: read.input.principalId, requestId: read.input.requestId, status: 'refused', code }
    };
}

export function validateFriendsMutation(computed: FriendsMutationComputed): readonly string[] {
    return JSON.stringify(computed) === JSON.stringify(computeFriendsMutation(computed.read))
        ? []
        : ['Friends mutation differs from its complete read and command'];
}

function exceedsFriendsCapacity(read: FriendsMutationRead, profile: FriendsProfile): boolean {
    const previous = profile.principalId === read.actor.profile.principalId ? read.actor.profile : read.target?.profile;
    if (previous === undefined) {
        throw new TypeError('Friends capacity requires the captured account predecessor');
    }
    // Lowered limits prevent growth, but must never prevent withdrawing consent or online sharing.
    return (profile.contacts.length > read.config.maxContacts && profile.contacts.length > previous.contacts.length) ||
        (profile.invitations.length > read.config.maxInvitations &&
            profile.invitations.length > previous.invitations.length);
}

function computeFriendsStorage(
    read: FriendsMutationRead,
    profiles: readonly FriendsProfile[],
    provenance: readonly RuntimeStateGuardedBatchEffect[]
): RuntimeStateGuardedBatchWrite {
    const writes = profiles.map((profile) => toFriendsProfileWrite(read, profile)).toSorted((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    );
    const [guard, ...effects] = [...computeFriendsAuthorityGuards(read), ...writes];
    return computeRuntimeStateGuardedBatchWrite({
        guard: guard!,
        effects: [...effects.map((effect, index) => ({ ...effect, effectId: `friends:${index}` })), ...provenance]
    });
}

function toFriendsProfileWrite(read: FriendsMutationRead, profile: FriendsProfile): RuntimeStateGuardedBatchGuard {
    const previous = profile.principalId === read.actor.profile.principalId ? read.actor : read.target;
    if (previous === null || previous.profile.principalId !== profile.principalId) {
        throw new TypeError('Friends write has no captured account predecessor');
    }
    const canonical = decodeFriendsProfile(profile, profile.principalId);
    const write = {
        namespace: FRIENDS_PROFILE_NAMESPACE,
        key: friendsProfileKey(profile.principalId),
        value: JSON.stringify(canonical),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
    return previous.entry === null
        ? { ...write, operation: 'insert' }
        : { ...write, operation: 'update', expectedRevision: previous.entry.revision };
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
    for (const peer of computeMutualFriendsViewPeers(read)) {
        if (peer.entry === null) {
            throw new TypeError('Mutual friendship requires a persisted peer profile');
        }
        guards.push({
            operation: 'update',
            namespace: FRIENDS_PROFILE_NAMESPACE,
            key: peer.entry.key,
            value: peer.entry.value,
            expectedRevision: peer.entry.revision,
            expireAtTimestamp: peer.entry.expireAtTimestamp
        });
    }
    return guards;
}

function computeMutualFriendsViewPeers(read: FriendsMutationRead): readonly FriendsProfileRead[] {
    return read.input.request.action !== 'visibility'
        ? []
        : read.peers.filter(({ profile }) => areMutualFriends(read.actor.profile, profile));
}

function computeFriendsViewAudience(read: FriendsMutationRead, profiles: readonly FriendsProfile[]): readonly string[] {
    const changed = profiles.filter((profile) =>
        !jsonEquals(
            profile,
            profile.principalId === read.actor.profile.principalId ? read.actor.profile : read.target?.profile
        )
    ).map((profile) => profile.principalId);
    return read.input.request.action === 'visibility' && changed.includes(read.input.principalId)
        ? [...changed, ...computeMutualFriendsViewPeers(read).map(({ profile }) => profile.principalId)]
        : changed;
}
