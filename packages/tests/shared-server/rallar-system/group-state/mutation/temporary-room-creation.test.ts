import { expect, it } from 'vitest';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toGroupGuestAdmissionCommand } from '@shared-server/rallar-system/group-state/mutation/membership/group-guest-admission.ts';
import { roomGuestTransportSessionId } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { assertTemporaryGroupCreation, toTemporaryGroupCreationCommand } from '@shared-server/rallar-system/group-state/mutation/membership/temporary-group-creation.ts';
import { commitMutation, createRetentionDatabaseFixture, requireMutationWrite, RETENTION_REF, retryMutation } from '../retention/group-retention-database-fixture.ts';

it('seats the temporary creator and issues the invitation and transport exactly once after a lost response', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        const principalId = 'guest-' + 'a'.repeat(64);
        const sessionId = await roomGuestTransportSessionId(principalId);
        const createdAt = fixture.nowEpochMs;
        const command = toTemporaryGroupCreationCommand({roomRef: RETENTION_REF, principalId, requestId: 'create',
            guestTransport: { sessionId, accessTokenDigest: 'A'.repeat(43) }, capacity: 6, lifetimeMs: 3_600_000,
            emptyReturnWindowMs: 30_000, invitationVerifier: 'b'.repeat(64) });
        const ingress = await fixture.mutations.captureGuestMembershipMutationIngress(command, createdAt);
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, ingress)));
        fixture.nowEpochMs += 1000;
        expect((await retryMutation(fixture, ingress)).outcome).toBe('replay');
        const snapshot = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(snapshot?.group).toMatchObject({ownerPrincipalId: principalId, maxMembers: 6, activeMemberCount: 1, joinMode: 'invite-only',
            expiresAtEpochMs: createdAt + 3_600_000, guestInvitation: {verifier: 'b'.repeat(64), expiresAtEpochMs: createdAt + 900_000}});
        expect(snapshot?.members).toMatchObject([{principalId, role: 'owner', status: 'active', guestLease: { admittedAtEpochMs: createdAt }}]);
        if (!snapshot) throw new Error('Missing private room');
        const { temporaryPlayerRoom: _temporary, ...ordinary } = snapshot.group;
        expect(() => validateAuthoritativeGroupSnapshot({ ...snapshot, group: ordinary }, RETENTION_REF)).toThrow(/manager/i);
        expect(await new AuthSessionPersistence(fixture.runtime).findBySessionId(sessionId)).toMatchObject({clientId: principalId, guestRoom: RETENTION_REF});
        fixture.nowEpochMs = createdAt + 30_000;
        const stranger = 'guest-' + 'c'.repeat(64);
        const join = toGroupGuestAdmissionCommand({
            roomRef: RETENTION_REF, invitationVerifier: 'b'.repeat(64), principalId: stranger, requestId: 'late',
            guestTransport: {sessionId: await roomGuestTransportSessionId(stranger), accessTokenDigest: 'A'.repeat(43)}
        });
        const arrival = await fixture.mutations.captureGuestMembershipMutationIngress(join, fixture.nowEpochMs);
        await expect(retryMutation(fixture, arrival)).rejects.toThrow(/no longer available/);
    }
    finally { await fixture.storage.close(); }
});

it('rejects forged guest creator commands that expand capacity, lifetime or management rights', () => {
    const command = toTemporaryGroupCreationCommand({ roomRef: RETENTION_REF, principalId: 'guest-' + 'd'.repeat(64), requestId: 'open',
        guestTransport: { sessionId: 'guest-session-' + 'c'.repeat(64), accessTokenDigest: 'A'.repeat(43) }, capacity: 2,
        lifetimeMs: 60_000, emptyReturnWindowMs: 1_000, invitationVerifier: 'b'.repeat(64) });
    if (command.operation !== 'createGroup' || !command.input.temporaryCreator) throw new Error('Invalid creation command');
    const changes = [{ maxMembers: null }, { maxSpectators: 99 }, { publicationGrants: { outsider: { publish: true, subscribe: true } } },
        { temporaryCreator: { ...command.input.temporaryCreator, lifetimeMs: Number.MAX_SAFE_INTEGER } }];
    for (const change of changes) {
        expect(() => assertTemporaryGroupCreation({ ...command, input: { ...command.input, ...change } })).toThrow();
    }
});
