import { expect, it } from 'vitest';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupGuestAdmissionCommand } from '@shared-server/rallar-system/group-state/mutation/membership/group-guest-admission.ts';
import { commitMutation, createRetentionDatabaseFixture, prepareMutation, requireMutationWrite, RETENTION_REF, retryMutation, seedRetentionRoom } from '../group-state/retention/group-retention-database-fixture.ts';

it('admission creates a room-bound transport session that cannot authenticate as a registered user', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        const verifier = 'da'.repeat(32);
        const ownerUpdate = await prepareMutation(fixture, mutationDescriptor({
            operation: 'updateGroup', scope: RETENTION_REF, groupId: RETENTION_REF.groupId,
            request: { requestId: 'open', actorPrincipalId: 'owner', guestInvitationVerifier: verifier }
        }));
        await commitMutation(fixture, requireMutationWrite(ownerUpdate.computed));
        const guest = await toRoomGuestCredential(RETENTION_REF, 'af'.repeat(32));
        const command = toGroupGuestAdmissionCommand({
            roomRef: RETENTION_REF, principalId: guest.clientId, requestId: 'enter',
            invitationVerifier: verifier,
            guestTransport: { sessionId: guest.sessionId, accessTokenDigest: await hashAuthSecret(guest.accessToken) }
        });
        const ingress = await fixture.mutations.captureGuestMembershipMutationIngress(command, fixture.nowEpochMs);
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, ingress)));
        const auth = new AuthSessionRepository(fixture.runtime);
        const transportSession = await auth.findBySessionId(guest.sessionId);
        expect(transportSession).toMatchObject({
            clientId: guest.clientId, sessionId: guest.sessionId, guestRoom: RETENTION_REF,
            issuedAtEpochMs: fixture.nowEpochMs, expiresAtEpochMs: fixture.nowEpochMs + 14_400_000
        });
        expect(await auth.findByAccessToken(guest.accessToken)).toBeUndefined();
        const other = { ...RETENTION_REF, groupId: 'another-town' };
        await seedRetentionRoom(fixture, other);
        const revoke = await fixture.mutations.captureMutationIngress(mutationDescriptor({
            operation: 'joinGroup', scope: other, groupId: other.groupId, targetPrincipalId: guest.clientId,
            request: { requestId: 'illegal', actorPrincipalId: guest.clientId }
        }), { ...guest, username: guest.clientId, issuedAtEpochMs: fixture.nowEpochMs, expiresAtEpochMs: fixture.nowEpochMs + 14_400_000 });
        await expect(retryMutation(fixture, revoke)).rejects.toThrow(/guest.*room/i);
    } finally {
        await fixture.storage.close();
    }
});
