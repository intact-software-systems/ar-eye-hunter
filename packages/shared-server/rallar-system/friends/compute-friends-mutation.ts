import type { FriendsRefusal } from '@shared/api/friends/friends-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchWrite
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import {
    computeRuntimeStateObservations,
    type RuntimeStateObservation
} from '../../runtime-state/observation/runtime-state-observation.ts';
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
        observations: computeRuntimeStateObservations(computeFriendsObservations(read, profiles)),
        result: { ...identity, status: 'applied' }
    };
}

function refusedFriendsMutation(read: FriendsMutationRead, code: FriendsRefusal): FriendsMutationComputed {
    return {
        read,
        profiles: [],
        storage: null,
        observations: computeRuntimeStateObservations([]),
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
    const previous = toFriendsProfileRead(read, profile).profile;
    // Lowered limits prevent growth, but must never prevent withdrawing consent or online sharing.
    return (profile.contacts.length > read.config.maxContacts && profile.contacts.length > previous.contacts.length) ||
        (profile.invitations.length > read.config.maxInvitations &&
            profile.invitations.length > previous.invitations.length);
}

function computeFriendsStorage(
    read: FriendsMutationRead,
    profiles: readonly FriendsProfile[],
    provenance: readonly RuntimeStateGuardedBatchEffect[]
): RuntimeStateGuardedBatchWrite | null {
    const writes = profiles.filter((profile) => isFriendsProfileChanged(read, profile))
        .map((profile) => toFriendsProfileWrite(read, profile))
        .toSorted((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const destination = read.input.request.action === 'invite' && read.destination !== null
        ? [materializeGroupStateAuthorityGuard(read.destination.authorityGuard)]
        : [];
    const [guard, ...effects] = [...destination, ...writes];
    return guard === undefined ? null : computeRuntimeStateGuardedBatchWrite({
        guard,
        effects: [...effects.map((effect, index) => ({ ...effect, effectId: `friends:${index}` })), ...provenance]
    });
}

function toFriendsProfileRead(read: FriendsMutationRead, profile: FriendsProfile): FriendsProfileRead {
    const previous = profile.principalId === read.actor.profile.principalId ? read.actor : read.target;
    if (previous === null || previous.profile.principalId !== profile.principalId) {
        throw new TypeError('Friends profile has no captured account predecessor');
    }
    return previous;
}

function isFriendsProfileChanged(read: FriendsMutationRead, profile: FriendsProfile): boolean {
    return !jsonEquals(profile, toFriendsProfileRead(read, profile).profile);
}

function toFriendsProfileWrite(read: FriendsMutationRead, profile: FriendsProfile): RuntimeStateGuardedBatchGuard {
    const previous = toFriendsProfileRead(read, profile);
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

/** The session, unchanged profiles and visibility audience the decision read; none is rewritten to fence it. */
function computeFriendsObservations(
    read: FriendsMutationRead,
    profiles: readonly FriendsProfile[]
): readonly RuntimeStateObservation[] {
    const session = read.session;
    if (session === null) {
        throw new TypeError('Accepted friends mutation requires a captured session');
    }
    const unchanged = profiles.filter((profile) => !isFriendsProfileChanged(read, profile))
        .map((profile) => toFriendsProfileRead(read, profile));
    return [
        { namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE, key: session.entry.key, entry: session.entry },
        ...[...unchanged, ...computeMutualFriendsViewPeers(read)].map(({ entry, profile }) => ({
            namespace: FRIENDS_PROFILE_NAMESPACE,
            key: friendsProfileKey(profile.principalId),
            entry
        }))
    ];
}

function computeMutualFriendsViewPeers(read: FriendsMutationRead): readonly FriendsProfileRead[] {
    return read.input.request.action !== 'visibility'
        ? []
        : read.peers.filter(({ profile }) => areMutualFriends(read.actor.profile, profile));
}

function computeFriendsViewAudience(read: FriendsMutationRead, profiles: readonly FriendsProfile[]): readonly string[] {
    const changed = profiles.filter((profile) => isFriendsProfileChanged(read, profile))
        .map((profile) => profile.principalId);
    return read.input.request.action === 'visibility' && changed.includes(read.input.principalId)
        ? [...changed, ...computeMutualFriendsViewPeers(read).map(({ profile }) => profile.principalId)]
        : changed;
}
