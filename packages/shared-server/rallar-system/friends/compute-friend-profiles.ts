import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { FriendsRefusal } from '@shared/api/friends/friends-request.ts';
import type { FriendshipStatus } from '@shared/api/friends/friendship.ts';
import { Either } from '@shared/resilience/Either.ts';

import { computeFriendship } from './compute-friendship.ts';
import type { FriendsMutationRead } from './friends-mutation-contracts.ts';
import type { FriendsProfile } from './friends-profile.ts';

export function computeFriendProfiles(read: FriendsMutationRead): Either<FriendsRefusal, readonly FriendsProfile[]> {
    const { request } = read.input;
    const actor = read.actor.profile;
    if (request.action === 'visibility') {
        return Either.ofRight([{ ...actor, shareOnline: request.shareOnline }]);
    }
    if (request.action === 'dismiss') {
        return Either.ofRight([{
            ...actor,
            invitations: actor.invitations.filter((invitation) => invitation.invitationId !== request.invitationId)
        }]);
    }
    const target = read.target?.profile;
    if (!read.targetAvailable || !target || target.principalId === actor.principalId) {
        return Either.ofLeft('person-unavailable');
    }
    if (request.action === 'invite') {
        return computeFriendInvitation(read, target);
    }
    const decision = computeFriendship({
        action: request.action,
        actor: actor.contacts.find((contact) => contact.principalId === target.principalId)?.status ?? null,
        target: target.contacts.find((contact) => contact.principalId === actor.principalId)?.status ?? null
    });
    return decision.mapRight((relationship) => [
        toFriendProfileContact(actor, target.principalId, relationship.actor),
        toFriendProfileContact(target, actor.principalId, relationship.target)
    ]);
}

function toFriendProfileContact(
    profile: FriendsProfile,
    principalId: string,
    status: FriendshipStatus | null
): FriendsProfile {
    const contacts = profile.contacts.filter((contact) => contact.principalId !== principalId);
    if (status !== null) {
        contacts.push({ principalId, status });
    }
    return {
        ...profile,
        contacts: contacts.toSorted((a, b) =>
            a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0
        ),
        invitations: profile.invitations.filter((invitation) =>
            status === 'friend' || invitation.senderPrincipalId !== principalId
        )
    };
}

function computeFriendInvitation(
    read: FriendsMutationRead,
    target: FriendsProfile
): Either<FriendsRefusal, readonly FriendsProfile[]> {
    const { request, capturedAtEpochMs } = read.input;
    if (request.action !== 'invite' || capturedAtEpochMs === null) {
        throw new TypeError('Friend invitation requires a captured invitation command');
    }
    const actor = read.actor.profile;
    if (
        !actor.contacts.some((contact) => contact.principalId === target.principalId && contact.status === 'friend') ||
        !target.contacts.some((contact) => contact.principalId === actor.principalId && contact.status === 'friend')
    ) {
        return Either.ofLeft('friend-required');
    }
    if (!read.destinationAvailable) {
        return Either.ofLeft('destination-unavailable');
    }
    const expiresAtEpochMs = capturedAtEpochMs + read.config.invitationLifetimeMs;
    if (expiresAtEpochMs <= read.nowEpochMs) {
        return Either.ofLeft('invitation-expired');
    }
    const invitation = {
        invitationId: `${encodeURIComponent(actor.principalId)}:${encodeURIComponent(read.input.requestId)}`,
        senderPrincipalId: actor.principalId,
        kind: request.kind,
        roomRef: request.roomRef,
        createdAtEpochMs: capturedAtEpochMs,
        expiresAtEpochMs
    };
    const invitations = target.invitations.filter((existing) =>
        existing.expiresAtEpochMs > read.nowEpochMs &&
        !(existing.senderPrincipalId === actor.principalId && existing.kind === request.kind &&
            isSameGroupRef(existing.roomRef, request.roomRef))
    );
    invitations.push(invitation);
    return Either.ofRight([actor, {
        ...target,
        invitations: invitations.toSorted((a, b) =>
            a.invitationId < b.invitationId ? -1 : a.invitationId > b.invitationId ? 1 : 0
        )
    }]);
}
