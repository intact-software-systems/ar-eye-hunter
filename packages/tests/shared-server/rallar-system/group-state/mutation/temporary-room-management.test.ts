import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { expect, it } from 'vitest';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupGuestAdmissionCommand } from '@shared-server/rallar-system/group-state/mutation/membership/group-guest-admission.ts';
import { toTemporaryGroupCreationCommand } from '@shared-server/rallar-system/group-state/mutation/membership/temporary-group-creation.ts';
import { commitMutation, createRetentionDatabaseFixture, requireMutationWrite, RETENTION_REF, retryMutation } from '../retention/group-retention-database-fixture.ts';

const invitationVerifier = '1'.repeat(64);
const scope = { scope: RETENTION_REF, groupId: RETENTION_REF.groupId };

async function guest(secret: string, now: number) {
    const credential = await toRoomGuestCredential(RETENTION_REF, secret.repeat(64));
    return { ...credential, username: credential.clientId, issuedAtEpochMs: now, expiresAtEpochMs: now + 14_400_000 };
}

it('transfers room management to a present guest exactly once and rejects the former manager’s delayed edit', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        const now = fixture.nowEpochMs;
        const owner = await guest('a', now);
        const successor = await guest('b', now);
        for (const player of [owner, successor]) {
            const common = { roomRef: RETENTION_REF, principalId: player.clientId, requestId: player.clientId, invitationVerifier,
                guestTransport: { sessionId: player.sessionId, accessTokenDigest: await hashAuthSecret(player.accessToken) } };
            const command = player === owner ? toTemporaryGroupCreationCommand({ ...common, capacity: 2, lifetimeMs: 3_600_000, emptyReturnWindowMs: 30_000 })
                : toGroupGuestAdmissionCommand(common);
            const ingress = await fixture.mutations.captureGuestMembershipMutationIngress(command, now);
            await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, ingress)));
        }
        const transfer = await fixture.mutations.captureMutationIngress(mutationDescriptor({ ...scope, operation: 'transferGroupOwnership',
            targetPrincipalId: successor.clientId, request: { actorPrincipalId: owner.clientId, requestId: 'handover', newOwnerPrincipalId: successor.clientId } }), owner);
        await expect(retryMutation(fixture, transfer)).rejects.toThrow(/present/);
        const connect = async (player: typeof owner, generation: string) => {
            const ingress = await fixture.mutations.captureMutationIngress(mutationDescriptor({ ...scope, operation: 'connectPresence',
                sessionId: player.sessionId, request: { actorPrincipalId: player.clientId, principalId: player.clientId, requestId: 'connect-' + generation,
                    generationId: generation, connectionGenerationId: generation, publicationKey: null, connectedAtEpochMs: fixture.nowEpochMs,
                    lastHeartbeatAtEpochMs: fixture.nowEpochMs, expiresAtEpochMs: fixture.nowEpochMs + 60_000 } }), player);
            await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, ingress)));
        };
        await connect(owner, 'first-owner');
        const appoint = await fixture.mutations.captureMutationIngress(mutationDescriptor({ ...scope, operation: 'appointDirector',
            request: { requestId: 'appoint-owner', actorPrincipalId: owner.clientId, actorSessionId: owner.sessionId, succession: {
                operation: 'appoint', targetPrincipalId: owner.clientId, targetSessionId: owner.sessionId, expectedDirectorEpoch: 0
            } } }), owner);
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, appoint)));
        await connect(successor, 'first-successor');
        const interrupted = requireMutationWrite(await retryMutation(fixture, transfer));
        const disconnect = await fixture.mutations.captureMutationIngress(mutationDescriptor({ ...scope, operation: 'disconnectPresence',
            sessionId: successor.sessionId, request: { actorPrincipalId: successor.clientId, principalId: successor.clientId, requestId: 'leave',
                generationId: 'first-successor', disconnectedAtEpochMs: fixture.nowEpochMs } }), successor);
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, disconnect)));
        await expect(commitMutation(fixture, interrupted)).rejects.toThrow();
        await expect(retryMutation(fixture, transfer)).rejects.toThrow(/present/);
        fixture.nowEpochMs += 1000;
        await connect(successor, 'second-successor');
        const rotate = (actor: typeof owner, verifier: string) => fixture.mutations.captureMutationIngress(mutationDescriptor({ ...scope,
            operation: 'updateGroup', request: { requestId: 'rotate', actorPrincipalId: actor.clientId, guestInvitationVerifier: verifier } }), actor);
        const delayed = await rotate(owner, '2'.repeat(64));
        const stale = requireMutationWrite(await retryMutation(fixture, delayed));
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, transfer)));
        expect((await retryMutation(fixture, transfer)).outcome).toBe('replay');
        await expect(commitMutation(fixture, stale)).rejects.toThrow();
        await expect(retryMutation(fixture, delayed)).rejects.toThrow();
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, await rotate(successor, '3'.repeat(64)))));
        const snapshot = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(snapshot?.group).toMatchObject({ ownerPrincipalId: successor.clientId, activeMemberCount: 2, guestInvitation: { verifier: '3'.repeat(64) } });
        expect(readRallarGroupDirectorAppointment(snapshot?.group.metadata)).toMatchObject({ principalId: owner.clientId, epoch: 1 });
        expect(snapshot?.members.find(row => row.principalId === owner.clientId)).toMatchObject({ role: 'member', status: 'active' });
        expect(snapshot?.members.find(row => row.principalId === successor.clientId)).toMatchObject({ role: 'owner', guestLease: { temporaryManager: true } });
    }
    finally { await fixture.storage.close(); }
});

it('ends an empty private room at its return cutoff before the retirement worker runs', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        const now = fixture.nowEpochMs;
        const owner = await guest('a', now);
        const entrant = await guest('b', now);
        const commandFor = async (player: typeof owner) => {
            const common = { roomRef: RETENTION_REF, principalId: player.clientId, requestId: player.clientId, invitationVerifier,
                guestTransport: { sessionId: player.sessionId, accessTokenDigest: await hashAuthSecret(player.accessToken) } };
            return player === owner ? toTemporaryGroupCreationCommand({ ...common, capacity: 2, lifetimeMs: 3_600_000, emptyReturnWindowMs: 1_000 })
                : toGroupGuestAdmissionCommand(common);
        };
        const opened = await fixture.mutations.captureGuestMembershipMutationIngress(await commandFor(owner), now);
        await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, opened)));
        const room = (await fixture.repository.findGroup(RETENTION_REF))!;
        const redeem = await fixture.mutations.captureGuestMembershipMutationIngress(await commandFor(entrant), now);
        fixture.nowEpochMs += 999;
        expect(await fixture.repository.isTemporaryRoomAvailable(room, fixture.nowEpochMs)).toBe(true);
        expect((await retryMutation(fixture, redeem)).outcome).toBe('write');
        fixture.nowEpochMs++;
        expect(await fixture.repository.isTemporaryRoomAvailable(room, fixture.nowEpochMs)).toBe(false);
        await expect(retryMutation(fixture, redeem)).rejects.toThrow(/available/);
        expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('active');
    } finally { await fixture.storage.close(); }
});
