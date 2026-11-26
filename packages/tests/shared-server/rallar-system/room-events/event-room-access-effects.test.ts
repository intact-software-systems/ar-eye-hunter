import { expect, it } from 'vitest';
import { createRoomEvent, changeRoomEvent, type RoomEvent } from '@shared/api/room-events/room-event.ts';
import { toEventCourtGuestCredential, toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { writeGuardedViewPublication } from '@shared-server/rallar-system/websocket/outbox/guarded-view-publication.ts';
import { RoomEventRepository } from '@shared-server/rallar-system/room-events/room-event-repository.ts';
import { EventRoomAccessEffects } from '@shared-server/rallar-system/room-events/event-room-access-effects.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { commitMutation, requireMutationWrite, prepareMutation, createRetentionDatabaseFixture, RETENTION_REF, seedRetentionRoom } from '../group-state/retention/group-retention-database-fixture.ts';

it('creates private courts, admits only the claimed same-identity seat and revokes it before reopening the court', async () => {
    const f = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(f);
        const lobbyRef = RETENTION_REF;
        const registered = await prepareMutation(f, mutationDescriptor({ operation: 'upsertMember', scope: lobbyRef,
            groupId: lobbyRef.groupId, targetPrincipalId: 'registered', request: { requestId: 'seat-registered',
                status: 'active', actorPrincipalId: 'owner' } }));
        await commitMutation(f, requireMutationWrite(registered.computed));
        const courtRef = { ...lobbyRef, groupId: 'court-a' };
        const credential = await toRoomGuestCredential(lobbyRef, '1'.repeat(64));
        const court = await toEventCourtGuestCredential(courtRef, credential.clientId, '3'.repeat(64));
        const sessions = new AuthSessionPersistence(f.runtime);
        const events = new RoomEventRepository(f.runtime);
        const effects = new EventRoomAccessEffects({ groups: f.repository, sessions, serviceId: 'events', finishedRetentionMs: 3_600_000 });
        const command = { action: 'create', courts: [{ groupId: courtRef.groupId, capacity: 1 }], emptyReturnWindowMs: 12345, closesAt: f.nowEpochMs + 30_000 } as const;
        let event = createRoomEvent({ command, lobby: lobbyRef, organizerId: 'owner', nowEpochMs: f.nowEpochMs });
        const write = async (before: RoomEvent | null, command: RoomEvent.Command) => {
            const changed = await effects.prepare({ before, after: event, command, lobbyRef, requestId: 'test-' + event.revision,
                actor: { principalId: command.action === 'claim' ? credential.clientId : 'owner', sessionId: 'owner-session' },
                actorGuestLease: { admittedAtEpochMs: f.nowEpochMs - 3_600_000, expiresAtEpochMs: f.nowEpochMs + 10_800_000 },
                guestTransport: {sessionId: court.sessionId, accessTokenDigest: await hashAuthSecret(court.accessToken)},
                nowEpochMs: f.nowEpochMs, traceId: 'trace' });
            const eventChange = events.prepare(await events.read(lobbyRef), event, [], { createdAtEpochMs: f.nowEpochMs,
                retentionMs: 3_600_000, traceId: 'trace', serviceId: 'events', audience: ['owner', credential.clientId] });
            await f.storage.sql.begin(async tx => {
                await writeGuardedViewPublication(tx, eventChange);
                await effects.write(tx, changed);
            });
        };
        await write(null, command);
        for (const ref of [lobbyRef, courtRef]) expect((await f.repository.readSnapshot(ref))?.group.eventRoom?.emptyReturnWindowMs).toBe(12345);
        expect((await f.repository.readSnapshot(courtRef))?.group).toMatchObject({ kind: 'room', joinMode: 'invite-only', expiresAtEpochMs: command.closesAt });
        const directChange = (operation: 'updateGroup' | 'removeGroupMember', ref = lobbyRef) => operation === 'updateGroup'
            ? prepareMutation(f, mutationDescriptor({ scope: ref, groupId: ref.groupId, operation,
                request: { requestId: 'bypass-close', status: 'archived', actorPrincipalId: 'owner' } }))
            : prepareMutation(f, mutationDescriptor({ scope: ref, groupId: ref.groupId, operation, targetPrincipalId: credential.clientId,
                request: { requestId: 'bypass-remove', actorPrincipalId: 'owner' } }));
        await expect(directChange('updateGroup')).rejects.toThrow(/event/);
        await expect(directChange('removeGroupMember')).rejects.toThrow(/event/);
        await expect(prepareMutation(f, mutationDescriptor({ scope: courtRef, groupId: courtRef.groupId, operation: 'updateGroup',
            request: { requestId: 'bypass-invitation', guestInvitationVerifier: '4'.repeat(64), actorPrincipalId: 'owner' } }))).rejects.toThrow(/event/);
        const change = async (cmd: RoomEvent.Command) => {
            const before = event;
            event = changeRoomEvent({ event, command: cmd, principalId: cmd.action === 'close' ? 'owner' : credential.clientId, nowEpochMs: f.nowEpochMs });
            await write(before, cmd);
        };
        await change({ action: 'propose', partyId: 'team', players: [credential.clientId] });
        expect(await sessions.findBySessionId(court.sessionId)).toBeUndefined();
        await change({ action: 'claim', groupId: courtRef.groupId, occurrence: 1, offerRevision: event.courts[0]!.seats[0]!.offerRevision, partyId: 'team' });
        expect((await f.repository.readSnapshot(courtRef))?.members.find(member => member.principalId === credential.clientId)).toMatchObject({
            role: 'member', status: 'active', guestLease: { courtSessionId: court.sessionId, expiresAtEpochMs: f.nowEpochMs + 10_800_000 }
        });
        expect(await sessions.findBySessionId(court.sessionId)).toMatchObject({ guestRoom: courtRef, clientId: credential.clientId });
        await change({ action: 'release', groupId: courtRef.groupId, occurrence: 1, requeue: false });
        expect((await f.repository.readSnapshot(courtRef))?.members.find(member => member.principalId === credential.clientId)?.status).toBe('left');
        expect(await sessions.findBySessionId(court.sessionId)).toBeUndefined();
        const ownerChange = async (cmd: RoomEvent.Command) => {
            const before = event;
            event = changeRoomEvent({ event, command: cmd, principalId: 'owner', nowEpochMs: f.nowEpochMs });
            await write(before, cmd);
        };
        await ownerChange({ action: 'propose', partyId: 'owner-party', players: ['owner'] });
        const occurrence = event.courts[0]!.occurrence;
        await ownerChange({ action: 'claim', groupId: courtRef.groupId, occurrence, offerRevision: event.courts[0]!.seats[0]!.offerRevision, partyId: 'owner-party' });
        const connected = await prepareMutation(f, mutationDescriptor({
            operation: 'connectPresence', scope: courtRef, groupId: courtRef.groupId, sessionId: 'owner-session',
            request: { requestId: 'play-court', principalId: 'owner', generationId: 'play', publicationKey: null,
                connectionGenerationId: 'play-connection', connectedAtEpochMs: f.nowEpochMs, lastHeartbeatAtEpochMs: f.nowEpochMs,
                expiresAtEpochMs: f.nowEpochMs + 15_000, actorPrincipalId: 'owner' }
        }));
        await commitMutation(f, requireMutationWrite(connected.computed));
        await ownerChange({ action: 'release', groupId: courtRef.groupId, occurrence, requeue: false });
        expect((await f.repository.findPresenceAdmissionEntry({ ...courtRef, principalId: 'owner' }))?.value.admittedSessions).toEqual([]);
        await ownerChange({ action: 'remove', targetId: 'registered' });
        await expect(prepareMutation(f, mutationDescriptor({ operation: 'createGroupInvite', scope: lobbyRef,
            groupId: lobbyRef.groupId, targetPrincipalId: 'registered', request: { requestId: 'readmit-removed',
                actorPrincipalId: 'owner' } }))).rejects.toThrow(/banned|event/);
        await change({ action: 'close' });
        for (const ref of [lobbyRef, courtRef]) expect((await f.repository.readSnapshot(ref))?.group.status).toBe('archived');
    } finally { await f.storage.close(); }
});
