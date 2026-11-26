import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { toGroupGuestAdmissionCommand } from '@shared-server/rallar-system/group-state/mutation/membership/group-guest-admission.ts';
import { toGroupGuestSeatExpiryCommand } from '@shared-server/rallar-system/group-state/schedule/group-guest-seat-deadline.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { expect, it } from 'vitest';
import {
    commitMutation,
    createRetentionDatabaseFixture,
    prepareMutation,
    requireMutationWrite,
    RETENTION_REF,
    retryMutation,
    seedRetentionRoom,
    type RetentionDatabaseFixture
} from '../retention/group-retention-database-fixture.ts';

const VERIFIER = 'a'.repeat(64);
const SCOPE = { scope: RETENTION_REF, groupId: RETENTION_REF.groupId };

it('lets an admitted guest leave its own seat without retiring the room invitation', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        await ownerUpdate(fixture, 'bound', { maxMembers: 2, maxSpectators: 0 });
        await ownerUpdate(fixture, 'invite', { guestInvitationVerifier: VERIFIER });
        const guest = await admitGuest(fixture, 'b1', RETENTION_REF);
        const leave = await fixture.mutations.captureMutationIngress(guestLeave(guest.clientId, 'leave'), guest);
        const departure = requireMutationWrite(await retryMutation(fixture, leave));
        expect(departure.event?.eventType).toBe('member-left');
        await commitMutation(fixture, departure);

        const left = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(left?.members.find((member) => member.principalId === guest.clientId)?.status).toBe('left');
        expect(left?.group.activeMemberCount).toBe(1);
        expect(left?.group.guestInvitation?.verifier).toBe(VERIFIER);
        expect(await new AuthSessionPersistence(fixture.runtime).findBySessionId(guest.sessionId)).toBeUndefined();

        await expect(retryMutation(fixture, leave)).rejects.toThrow(/session/i);
        const rejoin = await fixture.mutations.captureGuestMembershipMutationIngress(
            toGroupGuestAdmissionCommand({
                roomRef: RETENTION_REF,
                principalId: guest.clientId,
                invitationVerifier: VERIFIER,
                requestId: 'rejoin',
                guestTransport: { sessionId: guest.sessionId, accessTokenDigest: await hashAuthSecret(guest.accessToken) }
            }),
            fixture.nowEpochMs
        );
        await expect(retryMutation(fixture, rejoin)).rejects.toThrow(/unavailable/i);

        const successor = await admitGuest(fixture, 'c1', RETENTION_REF);
        const seated = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(seated?.members.find((member) => member.principalId === successor.clientId)?.status).toBe('active');
        expect(seated?.members.find((member) => member.principalId === guest.clientId)?.status).toBe('left');

        const lease = left?.members.find((member) => member.principalId === guest.clientId)?.guestLease;
        if (!lease) {
            throw new Error('Departed guest lost its lease record');
        }
        fixture.nowEpochMs = lease.expiresAtEpochMs;
        const expiry = await fixture.mutations.captureGuestMembershipMutationIngress(
            toGroupGuestSeatExpiryCommand({
                roomRef: RETENTION_REF,
                principalId: guest.clientId,
                dueAtEpochMs: lease.expiresAtEpochMs,
                groupRevision: 4
            }),
            fixture.nowEpochMs
        );
        expect((await retryMutation(fixture, expiry)).outcome).toBe('no-op');
    }
    finally {
        await fixture.storage.close();
    }
});

it('limits a guest to its own departure in its own room', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        await ownerUpdate(fixture, 'invite', { guestInvitationVerifier: VERIFIER });
        await commitMutation(
            fixture,
            requireMutationWrite(
                (await prepareMutation(
                    fixture,
                    mutationDescriptor({
                        ...SCOPE,
                        operation: 'upsertMember',
                        targetPrincipalId: 'registered-player',
                        request: { requestId: 'admit-registered', actorPrincipalId: 'owner', status: 'active', role: 'member' }
                    })
                )).computed
            )
        );
        const guest = await admitGuest(fixture, 'd1', RETENTION_REF);
        const asGuest = async (descriptor: GroupMutationDescriptor) =>
            retryMutation(fixture, await fixture.mutations.captureMutationIngress(descriptor, guest));
        const refusals: readonly GroupMutationDescriptor[] = [
            mutationDescriptor({
                ...SCOPE,
                operation: 'upsertMember',
                targetPrincipalId: 'registered-player',
                request: { requestId: 'leave-other', actorPrincipalId: guest.clientId, status: 'left' }
            }),
            mutationDescriptor({
                ...SCOPE,
                operation: 'removeGroupMember',
                targetPrincipalId: 'registered-player',
                request: { requestId: 'remove-other', actorPrincipalId: guest.clientId }
            }),
            mutationDescriptor({
                ...SCOPE,
                operation: 'banGroupMember',
                targetPrincipalId: 'registered-player',
                request: { requestId: 'ban-other', actorPrincipalId: guest.clientId }
            }),
            mutationDescriptor({
                ...SCOPE,
                operation: 'upsertMember',
                targetPrincipalId: guest.clientId,
                request: { requestId: 'spectate', actorPrincipalId: guest.clientId, status: 'active', role: 'spectator' }
            })
        ];
        for (const descriptor of refusals) {
            await expect(asGuest(descriptor)).rejects.toThrow(/guest room operation/i);
        }
        const elsewhere = { ...RETENTION_REF, groupId: 'another-room' };
        await seedRetentionRoom(fixture, elsewhere);
        await expect(
            asGuest(
                mutationDescriptor({
                    scope: elsewhere,
                    groupId: elsewhere.groupId,
                    operation: 'upsertMember',
                    targetPrincipalId: guest.clientId,
                    request: { requestId: 'leave-elsewhere', actorPrincipalId: guest.clientId, status: 'left' }
                })
            )
        )
            .rejects.toThrow(/admitted room/i);
        const unchanged = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(unchanged?.members.find((member) => member.principalId === 'registered-player')?.status).toBe('active');
        expect(unchanged?.members.find((member) => member.principalId === guest.clientId)?.status).toBe('active');
    }
    finally {
        await fixture.storage.close();
    }
});

function guestLeave(targetPrincipalId: string, requestId: string): GroupMutationDescriptor {
    return mutationDescriptor({
        ...SCOPE,
        operation: 'upsertMember',
        targetPrincipalId,
        request: { requestId, actorPrincipalId: targetPrincipalId, status: 'left' }
    });
}

async function ownerUpdate(
    fixture: RetentionDatabaseFixture,
    requestId: string,
    changes: { maxMembers?: number; maxSpectators?: number; guestInvitationVerifier?: string; }
): Promise<void> {
    const { computed } = await prepareMutation(
        fixture,
        mutationDescriptor({ ...SCOPE, operation: 'updateGroup', request: { actorPrincipalId: 'owner', requestId, ...changes } })
    );
    await commitMutation(fixture, requireMutationWrite(computed));
}

async function admitGuest(fixture: RetentionDatabaseFixture, secretPair: string, roomRef: GroupRef): Promise<IssuedAuthSession> {
    const credential = await toRoomGuestCredential(roomRef, secretPair.repeat(32));
    const admission = await fixture.mutations.captureGuestMembershipMutationIngress(
        toGroupGuestAdmissionCommand({
            roomRef,
            principalId: credential.clientId,
            invitationVerifier: VERIFIER,
            requestId: 'join-' + secretPair,
            guestTransport: { sessionId: credential.sessionId, accessTokenDigest: await hashAuthSecret(credential.accessToken) }
        }),
        fixture.nowEpochMs
    );
    await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, admission)));
    return { ...credential, username: credential.clientId, issuedAtEpochMs: fixture.nowEpochMs, expiresAtEpochMs: fixture.nowEpochMs + 14_400_000 };
}
