import { describe, expect, it } from 'vitest';

import { decodeFriendsProfile, friendsProfileKey } from '@shared-server/rallar-system/friends/friends-profile.ts';

const alice = { principalId: 'alice', shareOnline: false, contacts: [], invitations: [] };

describe('private friends persistence', () => {
    it('decodes complete account records without exposing implicit sharing defaults', () => {
        expect(decodeFriendsProfile(alice, 'alice')).toEqual(alice);
        expect(() => decodeFriendsProfile({ principalId: 'alice', contacts: [], invitations: [] }, 'alice')).toThrow();
        expect(() => decodeFriendsProfile({ ...alice, shareOnline: 'true' }, 'alice')).toThrow();
    });

    it('rejects the wrong account slot, self contacts and duplicated contacts', () => {
        expect(() => decodeFriendsProfile(alice, 'bob')).toThrow();
        expect(() => decodeFriendsProfile({ ...alice, contacts: [{ principalId: 'alice', status: 'friend' }] }, 'alice')).toThrow();
        expect(() =>
            decodeFriendsProfile({
                ...alice,
                contacts: [
                    { principalId: 'bob', status: 'friend' },
                    { principalId: 'bob', status: 'blocked' }
                ]
            }, 'alice')
        ).toThrow();
    });

    it('rejects malformed destinations, non-friend senders and unexpected private fields', () => {
        const invitation = {
            invitationId: 'invite-1',
            senderPrincipalId: 'bob',
            kind: 'room',
            roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'arena' },
            createdAtEpochMs: 10,
            expiresAtEpochMs: 20
        };
        const profile = { ...alice, contacts: [{ principalId: 'bob', status: 'friend' }], invitations: [invitation] };
        expect(decodeFriendsProfile(profile, 'alice')).toEqual(profile);
        expect(() => decodeFriendsProfile({ ...profile, contacts: [] }, 'alice')).toThrow();
        expect(() => decodeFriendsProfile({ ...profile, invitations: [{ ...invitation, roomRef: { groupId: 'arena' } }] }, 'alice')).toThrow();
        expect(() => decodeFriendsProfile({ ...profile, currentRoom: invitation.roomRef }, 'alice')).toThrow();
        expect(() => decodeFriendsProfile({ ...profile, invitations: [{ ...invitation, expiresAtEpochMs: 10 }] }, 'alice')).toThrow();
    });

    it('uses injective account keys even for delimiters and encoded lookalikes', () => {
        const principals = ['alice', 'principal=alice', ':', '%3A', '/', '%2F', 'undefined', 'null'];
        expect(new Set(principals.map(friendsProfileKey)).size).toBe(principals.length);
        expect(() => friendsProfileKey('')).toThrow();
    });
});
