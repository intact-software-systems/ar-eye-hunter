import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { roomGuestTransportSessionId } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { toRoomGuestSeatExpiryCommand } from '@shared-server/rallar-system/group-state/schedule/room-guest-seat-deadline.ts';
import { expect, it } from 'vitest';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toRoomGuestAdmissionCommand } from '@shared-server/rallar-system/group-state/mutation/membership/room-guest-admission.ts';
import { commitMutation, createRetentionDatabaseFixture, prepareMutation, requireMutationWrite, RETENTION_REF, retryMutation, seedRetentionRoom } from '../retention/group-retention-database-fixture.ts';

it('commits one four-hour guest lease in the final seat and retires the link atomically on removal', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture, RETENTION_REF, { claimWindowMs: 60_000, returnWindowMs: 120_000 });
        const verifier = 'a'.repeat(64);
        const ownerUpdate = async (requestId: string, changes: { maxMembers?: number; guestInvitationVerifier?: string; }) => {
            const { computed } = await prepareMutation(fixture, mutationDescriptor({
                operation: 'updateGroup', scope: RETENTION_REF, groupId: RETENTION_REF.groupId,
                request: { actorPrincipalId: 'owner', requestId, ...changes }
            }));
            await commitMutation(fixture, requireMutationWrite(computed));
        };
        await ownerUpdate('bound', { maxMembers: 2 });
        await ownerUpdate('invite', { guestInvitationVerifier: verifier });
        const principals = ['b', 'c'].map(character => 'guest-' + character.repeat(64));
        const admissions = await Promise.all(principals.map(async principalId => fixture.mutations.captureGuestMembershipMutationIngress(
            toRoomGuestAdmissionCommand({ roomRef: RETENTION_REF, principalId, invitationVerifier: verifier, requestId: 'join', displayName: 'Grumpy Gull',
                guestTransport: { sessionId: await roomGuestTransportSessionId(principalId), accessTokenDigest: 'A'.repeat(43) } }), fixture.nowEpochMs
        )));
        const admissionTime = fixture.nowEpochMs;
        fixture.nowEpochMs += 900_000;
        await expect(retryMutation(fixture, admissions[0])).rejects.toThrow(/invitation/i);
        fixture.nowEpochMs = admissionTime;
        const candidates = await Promise.all(admissions.map(admission => retryMutation(fixture, admission)));
        await commitMutation(fixture, requireMutationWrite(candidates[0]));
        await expect(commitMutation(fixture, requireMutationWrite(candidates[1]))).rejects.toThrow();
        await expect(retryMutation(fixture, admissions[1])).rejects.toMatchObject({ denial: { code: 'group-full' } });
        const snapshot = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(snapshot?.members.find(member => member.principalId === principals[0])?.guestLease).toEqual({
            admittedAtEpochMs: fixture.nowEpochMs, expiresAtEpochMs: fixture.nowEpochMs + 14_400_000, displayName: 'Grumpy Gull'
        });
        expect(snapshot?.members.some(member => member.principalId === principals[1])).toBe(false);
        const held = await fixture.repository.findLobbyCommitmentEntry(RETENTION_REF, principals[0]);
        expect(held?.value.seat?.roomRef).toEqual(RETENTION_REF);
        await expect(prepareMutation(fixture, mutationDescriptor({
            operation: 'transferGroupOwnership', scope: RETENTION_REF, groupId: RETENTION_REF.groupId, targetPrincipalId: principals[0],
            request: { actorPrincipalId: 'owner', requestId: 'transfer', newOwnerPrincipalId: principals[0] }
        }))).rejects.toThrow(/guest/i);
        await expect(prepareMutation(fixture, mutationDescriptor({
            operation: 'setGroupMemberRole', scope: RETENTION_REF, groupId: RETENTION_REF.groupId, targetPrincipalId: principals[0],
            request: { actorPrincipalId: 'owner', requestId: 'promote', role: 'admin' }
        }))).rejects.toThrow(/guest/i);
        const removal = await prepareMutation(fixture, mutationDescriptor({
            operation: 'removeGroupMember', scope: RETENTION_REF, groupId: RETENTION_REF.groupId, targetPrincipalId: principals[0],
            request: { actorPrincipalId: 'owner', requestId: 'remove' }
        }));
        await commitMutation(fixture, requireMutationWrite(removal.computed));
        expect(await new AuthSessionPersistence(fixture.runtime).findBySessionId(await roomGuestTransportSessionId(principals[0]))).toBeUndefined();
        const after = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(after?.group.guestInvitation).toBeUndefined();
        expect(after?.members.find(member => member.principalId === principals[0])?.status).toBe('removed');
        await expect(retryMutation(fixture, admissions[1])).rejects.toThrow(/invitation/i);
    }
    finally {
        await fixture.storage.close();
    }
});

it.each([false, true])('releases the seat at its fixed cutoff without a connected session (finishing a round: %s)', async (inRound) => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture, RETENTION_REF, { claimWindowMs: 14_460_000, returnWindowMs: 120_000 });
        const invitationVerifier = 'd'.repeat(64);
        const principalId = 'guest-' + 'e'.repeat(64);
        const update = await prepareMutation(fixture, mutationDescriptor({
            operation: 'updateGroup', scope: RETENTION_REF, groupId: RETENTION_REF.groupId,
            request: { actorPrincipalId: 'owner', requestId: 'invite', guestInvitationVerifier: invitationVerifier }
        }));
        await commitMutation(fixture, requireMutationWrite(update.computed));
        const join = await fixture.mutations.captureGuestMembershipMutationIngress(toRoomGuestAdmissionCommand({
            roomRef: RETENTION_REF, principalId, invitationVerifier, requestId: 'join',
            guestTransport: { sessionId: await roomGuestTransportSessionId(principalId), accessTokenDigest: 'A'.repeat(43) }
        }), fixture.nowEpochMs);
        const admission = requireMutationWrite(await retryMutation(fixture, join));
        const expiresAtEpochMs = fixture.nowEpochMs + 14_400_000;
        expect(admission.outboxWrites.some(row => Number(row.entry.dequeueAudit.nextTs?.epochMilliseconds) === expiresAtEpochMs)).toBe(true);
        await commitMutation(fixture, admission);
        fixture.nowEpochMs = expiresAtEpochMs;
        const deadline = { roomRef: RETENTION_REF, principalId, dueAtEpochMs: expiresAtEpochMs, groupRevision: 3 };
        const expire = await fixture.mutations.captureGuestMembershipMutationIngress(toRoomGuestSeatExpiryCommand(deadline), fixture.nowEpochMs);
        let cleanup = expire;
        if (inRound) {
            fixture.nowEpochMs = expiresAtEpochMs - 1000;
            const scope = { scope: RETENTION_REF, groupId: RETENTION_REF.groupId };
            const actor = { actorPrincipalId: 'owner', actorSessionId: 'owner-session' };
            const presence = await prepareMutation(fixture, mutationDescriptor({ ...scope, operation: 'connectPresence', sessionId: 'owner-session',
                request: { ...actor, principalId: 'owner', requestId: 'connect', generationId: 'gen', publicationKey: null,
                    connectionGenerationId: 'socket', connectedAtEpochMs: fixture.nowEpochMs, lastHeartbeatAtEpochMs: fixture.nowEpochMs,
                    expiresAtEpochMs: fixture.nowEpochMs + 30_000 } }));
            await commitMutation(fixture, requireMutationWrite(presence.computed));
            const host = await prepareMutation(fixture, mutationDescriptor({ ...scope, operation: 'appointDirector',
                request: { ...actor, requestId: 'appoint', succession: { operation: 'appoint', expectedDirectorEpoch: 0,
                    targetPrincipalId: 'owner', targetSessionId: 'owner-session' } } }));
            await commitMutation(fixture, requireMutationWrite(host.computed));
            const round = await prepareMutation(fixture, mutationDescriptor({ ...scope, operation: 'updateGroup',
                request: { ...actor, requestId: 'round', roomClock: {
                    operation: 'advance-phase', name: 'guest-play', phase: 'playing', durationMs: 2000,
                    expectedRevision: 0, expectedDirectorEpoch: 1, participantPrincipalIds: [principalId]
                } } }));
            await commitMutation(fixture, requireMutationWrite(round.computed));
            const row = await new AuthSessionPersistence(fixture.runtime).findSessionBySessionIdEntry(await roomGuestTransportSessionId(principalId));
            expect(row?.entry.expireAtTimestamp).toBe(expiresAtEpochMs + 1000);
            expect(row?.value.expiresAtEpochMs).toBe(expiresAtEpochMs + 1000);
            fixture.nowEpochMs = expiresAtEpochMs;
            expect((await retryMutation(fixture, expire)).outcome).toBe('no-op');
            fixture.nowEpochMs = expiresAtEpochMs + 1000;
            const finish = { ...deadline, groupRevision: 4, dueAtEpochMs: fixture.nowEpochMs };
            cleanup = await fixture.mutations.captureGuestMembershipMutationIngress(toRoomGuestSeatExpiryCommand(finish), fixture.nowEpochMs);
        }
        const released = requireMutationWrite(await retryMutation(fixture, cleanup));
        await commitMutation(fixture, released);
        const current = await fixture.repository.readSnapshot(RETENTION_REF);
        expect(current?.members.find(member => member.principalId === principalId)?.status).toBe('left');
        expect(current?.group.activeMemberCount).toBe(1);
        expect(current?.group.guestInvitation?.verifier).toBe(invitationVerifier);
    }
    finally {
        await fixture.storage.close();
    }
});
