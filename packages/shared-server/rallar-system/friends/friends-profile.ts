import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { FriendContact, FriendInvitation } from '@shared/api/friends/friendship.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';

export interface FriendsProfile {
    readonly principalId: string;
    readonly shareOnline: boolean;
    readonly contacts: readonly FriendContact[];
    readonly invitations: readonly FriendInvitation[];
}

export const FRIENDS_PROFILE_NAMESPACE = 'friends:profiles';

export function friendsProfileKey(principalId: string): string {
    requireString(principalId, 'Friends principal');
    return `principal=${encodeURIComponent(principalId)}`;
}

export function decodeFriendsProfile(value: unknown, principalId: string): FriendsProfile {
    const profile = requireRecord(value, 'Friends profile');
    requireExactKeys(profile, ['principalId', 'shareOnline', 'contacts', 'invitations'], 'Friends profile');
    if (profile.principalId !== principalId || typeof profile.shareOnline !== 'boolean') {
        throw new TypeError('Friends profile identity or visibility is invalid');
    }
    if (!Array.isArray(profile.contacts) || !Array.isArray(profile.invitations)) {
        throw new TypeError('Friends profile collections are invalid');
    }
    const contacts = profile.contacts.map(decodeFriendContact);
    const invitations = profile.invitations.map(decodeFriendInvitation);
    assertUniqueContacts(contacts, principalId);
    assertFriendInvitations(invitations, contacts);
    return { principalId, shareOnline: profile.shareOnline, contacts, invitations };
}

function decodeFriendContact(value: unknown): FriendContact {
    const contact = requireRecord(value, 'Friend contact');
    requireExactKeys(contact, ['principalId', 'status'], 'Friend contact');
    requireString(contact.principalId, 'Friend contact principal');
    const status = requireOneOf(contact.status, ['outgoing', 'incoming', 'friend', 'blocked'], 'Friendship status');
    return { principalId: contact.principalId, status };
}

function decodeFriendInvitation(value: unknown): FriendInvitation {
    const invitation = requireRecord(value, 'Friend invitation');
    requireExactKeys(invitation, [
        'invitationId',
        'senderPrincipalId',
        'kind',
        'roomRef',
        'createdAtEpochMs',
        'expiresAtEpochMs'
    ], 'Friend invitation');
    requireString(invitation.invitationId, 'Friend invitation identity');
    requireString(invitation.senderPrincipalId, 'Friend invitation sender');
    const kind = requireOneOf(invitation.kind, ['room', 'scheduled-session'], 'Friend invitation kind');
    const ref = requireRecord(invitation.roomRef, 'Friend invitation destination');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Friend invitation destination');
    const roomRef = assertValidRallarGroupRef(ref);
    requireEpoch(invitation.createdAtEpochMs, 'Friend invitation creation');
    requireEpoch(invitation.expiresAtEpochMs, 'Friend invitation expiry');
    if (invitation.expiresAtEpochMs <= invitation.createdAtEpochMs) {
        throw new TypeError('Friend invitation lifetime is invalid');
    }
    return {
        invitationId: invitation.invitationId,
        senderPrincipalId: invitation.senderPrincipalId,
        kind,
        roomRef,
        createdAtEpochMs: invitation.createdAtEpochMs,
        expiresAtEpochMs: invitation.expiresAtEpochMs
    };
}

function assertUniqueContacts(contacts: readonly FriendContact[], principalId: string): void {
    const seen = new Set<string>([principalId]);
    for (const contact of contacts) {
        if (seen.has(contact.principalId)) {
            throw new TypeError('Friends profile contains self or duplicate contact');
        }
        seen.add(contact.principalId);
    }
}

function assertFriendInvitations(invitations: readonly FriendInvitation[], contacts: readonly FriendContact[]): void {
    const friends = new Set(
        contacts.filter((contact) => contact.status === 'friend').map((contact) => contact.principalId)
    );
    const seen = new Set<string>();
    for (const invitation of invitations) {
        if (!friends.has(invitation.senderPrincipalId) || seen.has(invitation.invitationId)) {
            throw new TypeError('Friends profile invitation sender or identity is invalid');
        }
        seen.add(invitation.invitationId);
    }
}
