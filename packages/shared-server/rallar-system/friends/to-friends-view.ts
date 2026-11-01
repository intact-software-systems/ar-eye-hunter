import type { FriendPerson, FriendsView } from '@shared/api/friends/friends-view.ts';

import type { FriendsAccount } from './friends-account-directory.ts';
import type { FriendsProfile } from './friends-profile.ts';

export interface FriendsPeerRead {
    readonly account: FriendsAccount;
    readonly profile: FriendsProfile | null;
    readonly online: boolean;
}

export interface FriendsViewRead {
    readonly profile: FriendsProfile;
    readonly peers: readonly FriendsPeerRead[];
    readonly nowEpochMs: number;
}

export function toFriendsView(read: FriendsViewRead): FriendsView {
    const peers = new Map(read.peers.map((peer) => [peer.account.principalId, peer]));
    const contacts: FriendPerson[] = [];
    for (const contact of read.profile.contacts) {
        const peer = peers.get(contact.principalId);
        if (peer === undefined) {
            continue;
        }
        const mutual = peer.profile?.contacts.some((other) =>
            other.principalId === read.profile.principalId && other.status === 'friend'
        ) === true;
        if (contact.status === 'friend' && !mutual) {
            continue;
        }
        contacts.push({
            ...peer.account,
            status: contact.status,
            presence: contact.status !== 'friend' || !peer.profile?.shareOnline
                ? 'hidden'
                : peer.online
                ? 'online'
                : 'away'
        });
    }
    const friends = new Set(
        contacts.filter((contact) => contact.status === 'friend').map((contact) => contact.principalId)
    );
    return {
        principalId: read.profile.principalId,
        shareOnline: read.profile.shareOnline,
        contacts,
        invitations: read.profile.invitations.filter((invitation) =>
            invitation.expiresAtEpochMs > read.nowEpochMs && friends.has(invitation.senderPrincipalId)
        )
    };
}
