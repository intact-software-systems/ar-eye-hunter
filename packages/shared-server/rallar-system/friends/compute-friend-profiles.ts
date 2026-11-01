import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { FriendsRefusal } from '@shared/api/friends/friends-request.ts';
import type { FriendshipStatus } from '@shared/api/friends/friendship.ts';
import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
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
    if (!target || target.principalId === actor.principalId) {
        return Either.ofLeft('person-unavailable');
    }
    const withdrawsKnownConsent = request.action !== 'request' && request.action !== 'accept' &&
        request.action !== 'invite' &&
        actor.contacts.some((contact) => contact.principalId === target.principalId);
    if (!read.targetAvailable && !withdrawsKnownConsent) {
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
    if (!canShareFriendsDestination(read)) {
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

function canShareFriendsDestination(read: FriendsMutationRead): boolean {
    const request = read.input.request;
    const snapshot = read.destination?.snapshot;
    if (request.action !== 'invite' || snapshot === undefined || !isSameGroupRef(snapshot.group, request.roomRef)) {
        return false;
    }
    const schedule = readGroupSessionSchedule(snapshot.group.metadata);
    return snapshot.group.status === 'active' &&
        (snapshot.group.expiresAtEpochMs === null || snapshot.group.expiresAtEpochMs > read.nowEpochMs) &&
        snapshot.members.some((member) =>
            member.principalId === read.input.principalId && member.status === 'active'
        ) &&
        (request.kind === 'room' || (schedule !== null && schedule.cancelledAtEpochMs === null));
}
