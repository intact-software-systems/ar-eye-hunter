import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import { decodeFriendInvitation, type FriendContact, type FriendInvitation } from './friendship.ts';

export interface FriendPerson extends FriendContact {
    readonly username: string;
    readonly displayName: string;
    readonly presence: 'online' | 'away' | 'hidden';
}

export interface FriendsView {
    readonly principalId: string;
    readonly shareOnline: boolean;
    readonly contacts: readonly FriendPerson[];
    readonly invitations: readonly FriendInvitation[];
}

export function decodeFriendsView(value: unknown): FriendsView {
    const view = requireRecord(value, 'Friends view');
    requireExactKeys(view, ['principalId', 'shareOnline', 'contacts', 'invitations'], 'Friends view');
    requireString(view.principalId, 'Friends view principal');
    if (typeof view.shareOnline !== 'boolean' || !Array.isArray(view.contacts) || !Array.isArray(view.invitations)) {
        throw new TypeError('Friends view visibility or collections are invalid');
    }
    return {
        principalId: view.principalId,
        shareOnline: view.shareOnline,
        contacts: view.contacts.map(decodeFriendPerson),
        invitations: view.invitations.map(decodeFriendInvitation)
    };
}

function decodeFriendPerson(value: unknown): FriendPerson {
    const person = requireRecord(value, 'Friend person');
    requireExactKeys(person, ['principalId', 'username', 'displayName', 'status', 'presence'], 'Friend person');
    requireString(person.principalId, 'Friend principal');
    requireString(person.username, 'Friend username');
    requireString(person.displayName, 'Friend display name');
    const status = requireOneOf(person.status, ['outgoing', 'incoming', 'friend', 'blocked'], 'Friend status');
    const presence = requireOneOf(person.presence, ['online', 'away', 'hidden'], 'Friend presence');
    if (status !== 'friend' && presence !== 'hidden') {
        throw new TypeError('Presence requires friendship');
    }
    return {
        principalId: person.principalId,
        username: person.username,
        displayName: person.displayName,
        status,
        presence
    };
}
