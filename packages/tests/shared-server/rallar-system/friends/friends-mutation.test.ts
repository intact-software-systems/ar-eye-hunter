import { describe, expect, it } from 'vitest';

import { computeFriendsMutation } from '@shared-server/rallar-system/friends/compute-friends-mutation.ts';
import type { FriendsMutationRead } from '@shared-server/rallar-system/friends/friends-mutation-contracts.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { FriendsRequest } from '@shared/api/friends/friends-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

function read(request: FriendsRequest): FriendsMutationRead {
    const snapshot = createGroupSnapshot(1, []);
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
        session: {
            entry: { key: 'session=alice-session', value: '{}', revision: 0, expireAtTimestamp: 10000, updatedTimestamp: '2026-11-01' },
            value: {
                clientId: 'alice',
                username: 'alice',
                sessionId: 'alice-session',
                accessTokenDigest: 'test-digest',
                issuedAtEpochMs: 1,
                expiresAtEpochMs: 10000
            }
        },
        targetAvailable: true,
        destination: {
            snapshot,
            authorityGuard: {
                groupRef: snapshot.group,
                causalGroupRevision: snapshot.group.snapshotVersion,
                entry: {
                    key: groupStateGroupStorageKey(snapshot.group),
                    value: JSON.stringify(snapshot.group),
                    revision: 0,
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                    updatedTimestamp: '2026-11-01'
                }
            }
        },
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
        expect(computed.storage?.guardSqlDescriptor.expireAtTimestamp).toBe('1970-01-01T00:00:10.000Z');
        expect(computed.storage?.effectSqlDescriptors.map((effect) => JSON.parse(effect.value!).principalId)).toEqual(['alice', 'bob']);
        expect(computed.storage?.effectSqlDescriptors.every((effect) => typeof effect.expireAtTimestamp === 'string')).toBe(true);
    });

    it('refuses absent authority, self requests and capacity without prepared writes', () => {
        const before = read({ action: 'request', username: 'bob' });
        for (
            const changed of [
                { ...before, session: null },
                { ...before, target: before.actor },
                { ...before, config: { ...before.config, maxContacts: 0 } }
            ]
        ) {
            const computed = computeFriendsMutation(changed);
            expect(computed.result.status).toBe('refused');
            expect(computed.storage).toBeNull();
        }
    });

    it('only sends an invitation to a mutual friend and never grants room membership', () => {
        const request: FriendsRequest = {
            action: 'invite',
            principalId: 'bob',
            kind: 'room',
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
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
        expect(computeFriendsMutation({ ...friends, destination: null }).result)
            .toMatchObject({ status: 'refused', code: 'destination-unavailable' });
        expect(computeFriendsMutation({ ...friends, nowEpochMs: 1010 }).result)
            .toMatchObject({ status: 'refused', code: 'invitation-expired' });
    });

    it('rejects a cancelled scheduled destination even when its host remains a member', () => {
        const before = read({
            action: 'invite',
            principalId: 'bob',
            kind: 'scheduled-session',
            roomRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
        });
        const friends: FriendsMutationRead = {
            ...before,
            actor: { ...before.actor, profile: { ...before.actor.profile, contacts: [{ principalId: 'bob', status: 'friend' }] } },
            target: {
                entry: null,
                profile: { principalId: 'bob', shareOnline: false, contacts: [{ principalId: 'alice', status: 'friend' }], invitations: [] }
            }
        };
        const destination = friends.destination!;
        const scheduled: FriendsMutationRead = {
            ...friends,
            destination: {
                ...destination,
                snapshot: {
                    ...destination.snapshot,
                    group: {
                        ...destination.snapshot.group,
                        metadata: { rallarSessionSchedule: { revision: 1, startsAtEpochMs: 100, cancelledAtEpochMs: null } }
                    }
                }
            }
        };
        expect(computeFriendsMutation(scheduled).result.status).toBe('applied');
        const cancelled: FriendsMutationRead = {
            ...scheduled,
            destination: {
                ...scheduled.destination!,
                snapshot: {
                    ...scheduled.destination!.snapshot,
                    group: {
                        ...scheduled.destination!.snapshot.group,
                        metadata: { rallarSessionSchedule: { revision: 2, startsAtEpochMs: 100, cancelledAtEpochMs: 15 } }
                    }
                }
            }
        };
        const refused = computeFriendsMutation(cancelled);
        expect(refused.result).toMatchObject({ status: 'refused', code: 'destination-unavailable' });
        expect(refused.storage).toBeNull();
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

    it('allows withdrawing existing consent even when the other account is unavailable', () => {
        const before = read({ action: 'remove', principalId: 'bob' });
        const computed = computeFriendsMutation({
            ...before,
            targetAvailable: false,
            actor: { ...before.actor, profile: { ...before.actor.profile, contacts: [{ principalId: 'bob', status: 'friend' }] } },
            target: {
                entry: null,
                profile: { principalId: 'bob', shareOnline: false, contacts: [{ principalId: 'alice', status: 'friend' }], invitations: [] }
            }
        });
        expect(computed.result.status).toBe('applied');
        expect(computed.profiles.map((profile) => profile.contacts)).toEqual([[], []]);
    });

    it('allows turning sharing off after an operator lowers contact limits', () => {
        const before = read({ action: 'visibility', shareOnline: false });
        const computed = computeFriendsMutation({
            ...before,
            actor: {
                ...before.actor,
                profile: {
                    ...before.actor.profile,
                    shareOnline: true,
                    contacts: [
                        { principalId: 'bob', status: 'friend' },
                        { principalId: 'carol', status: 'outgoing' }
                    ]
                }
            },
            config: { ...before.config, maxContacts: 1 }
        });
        expect(computed.result.status).toBe('applied');
        expect(computed.profiles[0]?.shareOnline).toBe(false);
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
