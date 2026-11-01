import type { FriendsRefusal } from '@shared/api/friends/friends-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { Either } from '@shared/resilience/Either.ts';

import { computeFriendProfiles } from './compute-friend-profiles.ts';
import type {
    FriendsMutationComputed,
    FriendsMutationRead,
    FriendsProfileWrite
} from './friends-mutation-contracts.ts';
import { decodeFriendsProfile, friendsProfileKey, type FriendsProfile } from './friends-profile.ts';

export function computeFriendsMutation(read: FriendsMutationRead): FriendsMutationComputed {
    const identity = { principalId: read.input.principalId, requestId: read.input.requestId };
    const decision = read.authorized
        ? computeFriendProfiles(read)
        : Either.ofLeft<FriendsRefusal, readonly FriendsProfile[]>('unauthorized');
    if (decision.left !== undefined) {
        return { read, profiles: [], writes: [], result: { ...identity, status: 'refused', code: decision.left } };
    }
    const profiles = decision.right!;
    if (
        profiles.some((profile) =>
            profile.contacts.length > read.config.maxContacts || profile.invitations.length > read.config.maxInvitations
        )
    ) {
        return { read, profiles: [], writes: [], result: { ...identity, status: 'refused', code: 'capacity' } };
    }
    const writes = profiles.map((profile) => toFriendsProfileWrite(read, profile));
    return { read, profiles, writes, result: { ...identity, status: 'applied' } };
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
