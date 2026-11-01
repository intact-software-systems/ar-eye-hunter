import { describe, expect, it } from 'vitest';

import { toFriendsView } from '@shared-server/rallar-system/friends/to-friends-view.ts';

const roomRef = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'private-arena' };
const profile = {
    principalId: 'alice',
    shareOnline: false,
    contacts: [{ principalId: 'bob', status: 'friend' as const }],
    invitations: [{ invitationId: 'invite-1', senderPrincipalId: 'bob', kind: 'room' as const, roomRef, createdAtEpochMs: 1, expiresAtEpochMs: 100 }]
};
const peer = {
    account: { principalId: 'bob', username: 'bob', displayName: 'Bob' },
    profile: { principalId: 'bob', shareOnline: true, contacts: [{ principalId: 'alice', status: 'friend' as const }], invitations: [] },
    online: true
};

describe('private friends read projection', () => {
    it('exposes online status only after mutual consent and explicit sharing', () => {
        const visible = toFriendsView({ profile, peers: [peer], nowEpochMs: 50 });
        expect(visible.contacts).toEqual([{ principalId: 'bob', username: 'bob', displayName: 'Bob', status: 'friend', presence: 'online' }]);
        const hidden = toFriendsView({ profile, peers: [{ ...peer, profile: { ...peer.profile, shareOnline: false } }], nowEpochMs: 50 });
        expect(hidden.contacts[0]?.presence).toBe('hidden');
        const revoked = toFriendsView({ profile, peers: [{ ...peer, profile: { ...peer.profile, contacts: [] } }], nowEpochMs: 50 });
        expect(revoked.contacts).toEqual([]);
        expect(revoked.invitations).toEqual([]);
    });

    it('keeps room references exclusively inside explicit, unexpired invitations', () => {
        const visible = toFriendsView({ profile, peers: [peer], nowEpochMs: 50 });
        expect(visible.invitations).toEqual(profile.invitations);
        expect(JSON.stringify(visible.contacts)).not.toContain('private-arena');
        expect(toFriendsView({ profile, peers: [peer], nowEpochMs: 100 }).invitations).toEqual([]);
        expect(Object.keys(visible).sort()).toEqual(['contacts', 'invitations', 'principalId', 'shareOnline']);
    });

    it('does not disclose online status for requests or blocked contacts', () => {
        for (const status of ['incoming', 'outgoing', 'blocked'] as const) {
            const view = toFriendsView({ profile: { ...profile, invitations: [], contacts: [{ principalId: 'bob', status }] }, peers: [peer], nowEpochMs: 50 });
            expect(view.contacts[0]?.presence).toBe('hidden');
        }
    });
});
