import { describe, expect, it } from 'vitest';

import { computeFriendsMutation } from '@shared-server/rallar-system/friends/compute-friends-mutation.ts';
import type { FriendsMutationRead } from '@shared-server/rallar-system/friends/friends-mutation-contracts.ts';
import type { FriendsRequest } from '@shared/api/friends/friends-request.ts';

function read(request: FriendsRequest): FriendsMutationRead {
    return {
        input: {
            principalId: 'alice',
            sessionId: 'alice-session',
            sessionIssuedAtEpochMs: 1,
            sessionExpiresAtEpochMs: 10000,
            requestId: 'request-1',
            capturedAtEpochMs: 10,
            request
        },
        actor: { entry: null, profile: { principalId: 'alice', shareOnline: false, contacts: [], invitations: [] } },
        target: { entry: null, profile: { principalId: 'bob', shareOnline: false, contacts: [], invitations: [] } },
        authorized: true,
        targetAvailable: true,
        destinationAvailable: true,
        nowEpochMs: 20,
        config: { maxContacts: 10, maxInvitations: 10, invitationLifetimeMs: 1000 }
    };
}

describe('private friends mutations', () => {
    it('computes both sides before persistence without changing the supplied profiles', () => {
        const before = read({ action: 'request', username: 'bob' });
        const computed = computeFriendsMutation(before);
        expect(computed.result).toEqual({ principalId: 'alice', requestId: 'request-1', status: 'applied' });
        expect(computed.profiles.map((profile) => profile.contacts)).toEqual([
            [{ principalId: 'bob', status: 'outgoing' }],
            [{ principalId: 'alice', status: 'incoming' }]
        ]);
        expect(before.actor.profile.contacts).toEqual([]);
        expect(computed.writes).toHaveLength(2);
        expect(computed.writes.every((write) => typeof write.value === 'string')).toBe(true);
    });

    it('refuses absent authority, self requests and capacity without prepared writes', () => {
        const before = read({ action: 'request', username: 'bob' });
        for (
            const changed of [
                { ...before, authorized: false },
                { ...before, target: before.actor },
                { ...before, config: { ...before.config, maxContacts: 0 } }
            ]
        ) {
            const computed = computeFriendsMutation(changed);
            expect(computed.result.status).toBe('refused');
            expect(computed.writes).toEqual([]);
        }
    });

    it('only sends an invitation to a mutual friend and never grants room membership', () => {
        const request: FriendsRequest = {
            action: 'invite',
            principalId: 'bob',
            kind: 'room',
            roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'arena' }
        };
        const before = read(request);
        expect(computeFriendsMutation(before).result).toMatchObject({ status: 'refused', code: 'friend-required' });
        const friends: FriendsMutationRead = {
            ...before,
            actor: { ...before.actor, profile: { ...before.actor.profile, contacts: [{ principalId: 'bob', status: 'friend' }] } },
            target: {
                entry: null,
                profile: { principalId: 'bob', shareOnline: false, contacts: [{ principalId: 'alice', status: 'friend' }], invitations: [] }
            }
        };
        const computed = computeFriendsMutation(friends);
        expect(computed.profiles[1]?.invitations).toEqual([{
            invitationId: 'alice:request-1',
            senderPrincipalId: 'alice',
            kind: 'room',
            roomRef: request.roomRef,
            createdAtEpochMs: 10,
            expiresAtEpochMs: 1010
        }]);
        expect(computeFriendsMutation({ ...friends, destinationAvailable: false }).result)
            .toMatchObject({ status: 'refused', code: 'destination-unavailable' });
        expect(computeFriendsMutation({ ...friends, nowEpochMs: 1010 }).result)
            .toMatchObject({ status: 'refused', code: 'invitation-expired' });
    });

    it('removes pending invitations in both directions when friendship is removed', () => {
        const before = read({ action: 'remove', principalId: 'bob' });
        const invitation = {
            invitationId: 'old',
            senderPrincipalId: 'bob',
            kind: 'room' as const,
            roomRef: { applicationId: 'relic-hunters', workspaceId: 'default', groupId: 'expedition' },
            createdAtEpochMs: 1,
            expiresAtEpochMs: 1000
        };
        const computed = computeFriendsMutation({
            ...before,
            actor: { entry: null, profile: { ...before.actor.profile, contacts: [{ principalId: 'bob', status: 'friend' }], invitations: [invitation] } },
            target: {
                entry: null,
                profile: {
                    principalId: 'bob',
                    shareOnline: true,
                    contacts: [{ principalId: 'alice', status: 'friend' }],
                    invitations: [{ ...invitation, senderPrincipalId: 'alice' }]
                }
            }
        });
        expect(computed.profiles.map((profile) => profile.invitations)).toEqual([[], []]);
        expect(computed.profiles.map((profile) => profile.contacts)).toEqual([[], []]);
    });

    it('changes only the caller visibility and can dismiss only the caller invitations', () => {
        const visible = computeFriendsMutation({ ...read({ action: 'visibility', shareOnline: true }), target: null });
        expect(visible.profiles).toHaveLength(1);
        expect(visible.profiles[0]?.shareOnline).toBe(true);
        const dismissed = computeFriendsMutation({ ...read({ action: 'dismiss', invitationId: 'missing' }), target: null });
        expect(dismissed.result.status).toBe('applied');
        expect(dismissed.profiles).toHaveLength(1);
    });
});
