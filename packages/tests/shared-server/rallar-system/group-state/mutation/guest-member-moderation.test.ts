import { expect, it } from 'vitest';
import { roomGuestTransportSessionId } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { toGroupGuestAdmissionCommand } from '@shared-server/rallar-system/group-state/mutation/membership/group-guest-admission.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';
import { commitMutation, createRetentionDatabaseFixture, prepareMutation, requireMutationWrite, RETENTION_REF, retryMutation, seedRetentionRoom } from '../retention/group-retention-database-fixture.ts';

it('reserves guest departure and invitation revocation for the owner while admins can moderate registered members', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        const scope = { scope: RETENTION_REF, groupId: RETENTION_REF.groupId };
        const owner = async (descriptor: GroupMutationDescriptor) => commitMutation(fixture,
            requireMutationWrite((await prepareMutation(fixture, descriptor)).computed));
        const admin = createTestAuthSession('town-admin');
        await new AuthSessionRepository(fixture.runtime).putSession(admin);
        for (const [principalId, role] of [[admin.clientId, 'admin'], ['registered-player', 'member']] as const) {
            await owner(mutationDescriptor({ ...scope, operation: 'upsertMember', targetPrincipalId: principalId,
                request: { requestId: 'admit-' + principalId, actorPrincipalId: 'owner', status: 'active', role } }));
        }
        const invitationVerifier = 'a'.repeat(64);
        const guest = 'guest-' + 'b'.repeat(64);
        await owner(mutationDescriptor({ ...scope, operation: 'updateGroup',
            request: { requestId: 'invite', actorPrincipalId: 'owner', guestInvitationVerifier: invitationVerifier } }));
        const join = await fixture.mutations.captureGuestMembershipMutationIngress(toGroupGuestAdmissionCommand({
            roomRef: RETENTION_REF, principalId: guest, invitationVerifier, requestId: 'join',
            guestTransport: { sessionId: await roomGuestTransportSessionId(guest), accessTokenDigest: 'A'.repeat(43) }
        }), fixture.nowEpochMs);
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, join)));
        const byAdmin = async (descriptor: GroupMutationDescriptor) => {
            const command = await fixture.mutations.captureMutationIngress(descriptor, admin);
            return retryMutation(fixture, command);
        };
        for (const operation of ['removeGroupMember', 'banGroupMember'] as const) {
            await expect(byAdmin(mutationDescriptor({ ...scope, operation, targetPrincipalId: guest,
                request: { requestId: operation, actorPrincipalId: admin.clientId } }))).rejects.toThrow(/owner/i);
        }
        for (const status of ['left', 'invited'] as const) {
            await expect(byAdmin(mutationDescriptor({ ...scope, operation: 'upsertMember', targetPrincipalId: guest,
                request: { requestId: 'deactivate-' + status, actorPrincipalId: admin.clientId, status } }))).rejects.toThrow(/owner/i);
        }
        const retained = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(retained?.group.guestInvitation?.verifier).toBe(invitationVerifier);
        expect(retained?.members.find(member => member.principalId === guest)?.status).toBe('active');
        await commitMutation(fixture, requireMutationWrite(await byAdmin(mutationDescriptor({ ...scope,
            operation: 'removeGroupMember', targetPrincipalId: 'registered-player',
            request: { requestId: 'moderate-registered', actorPrincipalId: admin.clientId } }))));
        await owner(mutationDescriptor({ ...scope, operation: 'banGroupMember', targetPrincipalId: guest,
            request: { requestId: 'ban-guest', actorPrincipalId: 'owner' } }));
        const removed = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(removed?.members.find(member => member.principalId === 'registered-player')?.status).toBe('removed');
        expect(removed?.members.find(member => member.principalId === guest)?.status).toBe('banned');
        expect(removed?.group.guestInvitation).toBeUndefined();
    } finally {
        await fixture.storage.close();
    }
});
