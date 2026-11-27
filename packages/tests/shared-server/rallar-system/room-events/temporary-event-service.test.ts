import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { expect, it, vi } from 'vitest';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { createTestAuthSession } from '../group-state/group-state-test-runtime.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { decodeViewInvalidation } from '@shared/api/views/view-invalidation.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { RoomEventRepository } from '@shared-server/rallar-system/room-events/room-event-repository.ts';
import { EventRoomAccessEffects } from '@shared-server/rallar-system/room-events/event-room-access-effects.ts';
import { TemporaryEventService } from '@shared-server/rallar-system/room-events/temporary-event-service.ts';
import { createSqlServerAppInbox } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { commitMutation, createRetentionDatabaseFixture, prepareMutation, requireMutationWrite, RETENTION_REF, seedRetentionRoom } from '../group-state/retention/group-retention-database-fixture.ts';

it.each(['hard close', 'empty return window'])('recovers the %s and closes both courts with the organizer offline', async cause => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        const config = { serviceId: 'events', handoverWindowMs: 1000, finishedRetentionMs: 3_600_000, organizerIds: ['owner'] };
        const nowEpochMs = () => Date.now();
        const authSessions = new AuthSessionPersistence(fixture.runtime);
        const groups = fixture.repository;
        const roomAccess = new EventRoomAccessEffects({ groups, sessions: authSessions, ...config });
        const startWorker = () => {
            const queue = createSqlServerAppInbox({ database: fixture.storage.sql, nowEpochMs });
            const service = new TemporaryEventService({ appInbox: queue.inbox, runtime: fixture.runtime, groups, authSessions, roomAccess, nowEpochMs }, config);
            service.listen({ database: fixture.storage.sql, outboxQueueReader: queue.outbox });
            queue.inbox.start();
            return { queue, service };
        };
        const original = startWorker();
        const command = { action: 'create', courts: [{ groupId: 'one', capacity: 2 }, { groupId: 'two', capacity: 1 }], emptyReturnWindowMs: cause === 'hard close' ? 60_000 : 1500, closesAt: nowEpochMs() + (cause === 'hard close' ? 1500 : 60_000) } as const;
        const request = { lobby: RETENTION_REF, command, principalId: 'owner', sessionId: fixture.owner.sessionId, requestId: 'open' };
        const admitted = await original.service.mutate.enqueue({ command: request, traceId: 'first' });
        await original.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await admitted.right!.wait()).right).toEqual({ revision: 1 });
        expect((await original.service.mutate.submit({ command: request, traceId: 'lost-response' })).right).toEqual({ revision: 1 });
        if (cause === 'empty return window') {
            // Claiming a seat may finish just before the browser goes away and before its first presence admission.
            for (const next of [
                { action: 'propose', partyId: 'alone', players: ['owner'] },
                { action: 'claim', groupId: 'one', occurrence: 1, partyId: 'alone', offerRevision: 2 }
            ] satisfies RoomEvent.Command[]) {
                const pending = await original.service.mutate.enqueue({ command: { ...request, command: next, requestId: next.action }, traceId: next.action });
                await original.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                expect((await pending.right!.wait()).left).toBeFalsy();
            }
        }
        original.queue.inbox.stop();
        if (cause === 'empty return window') {
            const lobby = (await groups.findGroup(RETENTION_REF))!;
            expect(await groups.isTemporaryGroupAvailable(lobby, nowEpochMs() + 2000)).toBe(false);
        }
        const replacement = startWorker();
        await vi.waitFor(async () => {
            expect(await replacement.queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0))).toBeGreaterThan(0);
        }, { timeout: 7000, interval: 50 });
        await replacement.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await new RoomEventRepository(fixture.runtime).read(RETENTION_REF))?.value.closed).toBe(true);
        for (const groupId of [RETENTION_REF.groupId, 'one', 'two']) {
            expect((await groups.findGroup({ ...RETENTION_REF, groupId }))?.status).toBe('archived');
        }
        replacement.queue.inbox.stop();
    }
    finally { await fixture.storage.close(); }
});

it('holds the lobby open from an occupied court, then rejects a late reconnect before a worker archives it', async () => {
    const fixture = await createRetentionDatabaseFixture();
    const nowEpochMs = () => fixture.nowEpochMs;
    const queue = createSqlServerAppInbox({ database: fixture.storage.sql, nowEpochMs });
    try {
        await seedRetentionRoom(fixture);
        const config = { serviceId: 'events', handoverWindowMs: 1000, finishedRetentionMs: 3_600_000, organizerIds: ['owner'] };
        const groups = fixture.repository;
        const authSessions = new AuthSessionPersistence(fixture.runtime);
        const roomAccess = new EventRoomAccessEffects({ groups, sessions: authSessions, ...config });
        const service = new TemporaryEventService({ appInbox: queue.inbox, runtime: fixture.runtime, groups, authSessions, roomAccess, nowEpochMs }, config);
        queue.inbox.start();
        const issue = async (command: RoomEvent.Command) => {
            const admitted = await service.mutate.enqueue({ command: { command, lobby: RETENTION_REF, requestId: command.action,
                principalId: 'owner', sessionId: fixture.owner.sessionId }, traceId: command.action });
            await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).left).toBeFalsy();
        };
        await issue({ action: 'create', courts: [{ groupId: 'court', capacity: 1 }], closesAt: nowEpochMs() + 60_000, emptyReturnWindowMs: 1000 });
        await issue({ action: 'propose', partyId: 'solo', players: ['owner'] });
        await issue({ action: 'claim', groupId: 'court', occurrence: 1, partyId: 'solo', offerRevision: 2 });
        const organizer = { principalId: 'owner', sessionId: fixture.owner.sessionId };
        await expect(service.readOrganizer(RETENTION_REF, organizer)).resolves.toMatchObject({
            organizerId: 'owner', revision: 3, queue: [], players: [{ principalId: 'owner', displayName: 'owner' }],
            courts: [{ groupId: 'court', seats: [{ principalId: 'owner', partyId: 'solo', deadline: null }] }]
        });
        await expect(service.readOrganizer(RETENTION_REF, { ...organizer, principalId: 'other' })).rejects.toThrow(/organizer|membership/i);
        const court = { ...RETENTION_REF, groupId: 'court' };
        const connect = (generation: string) => mutationDescriptor({ scope: court, groupId: court.groupId, operation: 'connectPresence',
            sessionId: fixture.owner.sessionId, request: { actorPrincipalId: 'owner', principalId: 'owner', generationId: generation,
                publicationKey: null, connectionGenerationId: generation, requestId: generation,
                connectedAtEpochMs: nowEpochMs(), lastHeartbeatAtEpochMs: nowEpochMs(), expiresAtEpochMs: nowEpochMs() + 20_000 } });
        await commitMutation(fixture, requireMutationWrite((await prepareMutation(fixture, connect('first'))).computed));
        fixture.nowEpochMs += 1100;
        const lobby = (await groups.findGroup(RETENTION_REF))!;
        expect(await groups.isTemporaryGroupAvailable(lobby, nowEpochMs())).toBe(true);
        const departure = await prepareMutation(fixture, mutationDescriptor({ scope: court, groupId: court.groupId,
            operation: 'disconnectPresence', sessionId: fixture.owner.sessionId, request: {
                actorPrincipalId: 'owner', generationId: 'first', requestId: 'depart', disconnectedAtEpochMs: nowEpochMs() } }));
        await commitMutation(fixture, requireMutationWrite(departure.computed));
        fixture.nowEpochMs += 999;
        expect(await groups.isTemporaryGroupAvailable(lobby, nowEpochMs())).toBe(true);
        fixture.nowEpochMs++;
        expect(await groups.isTemporaryGroupAvailable(lobby, nowEpochMs())).toBe(false);
        await expect(prepareMutation(fixture, connect('late'))).rejects.toThrow('event is no longer available');
        expect((await groups.findGroup(court))?.status).toBe('active');
    }
    finally { queue.inbox.stop(); await fixture.storage.close(); }
});

it('grants the roster and all room ownership only after the eligible recipient accepts from their present session', async () => {
    const f = await createRetentionDatabaseFixture();
    const nowEpochMs = () => f.nowEpochMs;
    const queue = createSqlServerAppInbox({ database: f.storage.sql, nowEpochMs });
    try {
        await seedRetentionRoom(f);
        const other = createTestAuthSession('staff');
        await new AuthSessionRepository(f.runtime).putSession(other);
        const config = { serviceId: 'events', handoverWindowMs: 1000, finishedRetentionMs: 3_600_000, organizerIds: ['owner', 'staff'] };
        const authSessions = new AuthSessionPersistence(f.runtime);
        const roomAccess = new EventRoomAccessEffects({ groups: f.repository, sessions: authSessions, ...config });
        const service = new TemporaryEventService({ appInbox: queue.inbox, runtime: f.runtime, groups: f.repository,
            authSessions, roomAccess, nowEpochMs }, config);
        queue.inbox.start();
        const actor = { principalId: 'owner', sessionId: f.owner.sessionId };
        const pending = await service.mutate.enqueue({ command: { ...actor, lobby: RETENTION_REF, requestId: 'start',
            command: { action: 'create', courts: [{ groupId: 'court', capacity: 2 }], closesAt: nowEpochMs() + 60_000 } }, traceId: 'create' });
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await pending.right!.wait()).left).toBeFalsy();
        const invite = await prepareMutation(f, mutationDescriptor({ scope: RETENTION_REF, groupId: RETENTION_REF.groupId,
            operation: 'createGroupInvite', targetPrincipalId: 'staff', request: { requestId: 'invite', actorPrincipalId: 'owner' } }));
        await commitMutation(f, requireMutationWrite(invite.computed));
        const join = await prepareMutation({ ...f, owner: other }, mutationDescriptor({ scope: RETENTION_REF, groupId: RETENTION_REF.groupId,
            operation: 'acceptGroupInvite', request: { requestId: 'accept', actorPrincipalId: 'staff' } }));
        await commitMutation(f, requireMutationWrite(join.computed));
        const view = await service.readOrganizer(RETENTION_REF, actor);
        expect(view.players.map(p => p.principalId).sort()).toEqual(['owner', 'staff']);
        expect(view.revision).toBe(1);
        await expect(service.readOrganizer(RETENTION_REF, { principalId: 'staff', sessionId: other.sessionId })).rejects.toThrow(/organizer/);
        const rows = await f.storage.sql<{ ri_resource: string }[]>`select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated'`;
        const notices = rows.map(row => decodeViewInvalidation(JSON.parse(JSON.parse(row.ri_resource).payload.resource)));
        expect(notices.filter(n => n.resource === 'room-event-organizer').map(n => n.principalId)).toEqual(['owner', 'owner']);
        const player = { principalId: 'staff', sessionId: other.sessionId };
        const send = async (who: typeof actor, cmd: RoomEvent.Command, id: string) => {
            const submitted = await service.mutate.enqueue({ command: { ...who, command: cmd, lobby: RETENTION_REF, requestId: id }, traceId: id });
            if (submitted.left) throw new Error(submitted.left.message);
            await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            return submitted.right!.wait();
        };
        const offer = { action: 'offer-handover', recipientId: 'staff' } as const;
        expect((await send(actor, offer, 'absent')).left).toBeTruthy();
        const connect = await prepareMutation({ ...f, owner: other }, mutationDescriptor({ scope: RETENTION_REF, groupId: RETENTION_REF.groupId,
            operation: 'connectPresence', sessionId: other.sessionId, request: { requestId: 'present', principalId: 'staff', actorPrincipalId: 'staff',
                generationId: 'staff-live', connectionGenerationId: 'staff-live', publicationKey: null,
                connectedAtEpochMs: nowEpochMs(), lastHeartbeatAtEpochMs: nowEpochMs(), expiresAtEpochMs: nowEpochMs() + 20_000 } }));
        await commitMutation(f, requireMutationWrite(connect.computed));
        expect((await send(actor, offer, 'offer')).right).toEqual({ revision: 2 });
        const handover = (await service.read(RETENTION_REF, player))!.handover!;
        const accept = { action: 'accept-handover', offerId: handover.offerId } as const;
        const otherSession = createTestAuthSession('staff', 'staff-other-device');
        await new AuthSessionRepository(f.runtime).putSession(otherSession);
        expect((await send({ ...player, sessionId: otherSession.sessionId }, accept, 'other-device')).left).toBeTruthy();
        expect((await send(player, accept, 'accept')).right).toEqual({ revision: 3 });
        expect((await send(player, accept, 'accept')).right).toEqual({ revision: 3 });
        expect((await service.readOrganizer(RETENTION_REF, player)).organizerId).toBe('staff');
        await expect(service.readOrganizer(RETENTION_REF, actor)).rejects.toThrow(/organizer/);
        expect((await send(actor, { action: 'close' }, 'late')).left).toBeTruthy();
        for (const [groupId, previousStatus] of [[RETENTION_REF.groupId, 'active'], ['court', 'left']]) {
            const ref = { ...RETENTION_REF, groupId };
            const rename = (principalId: string) => mutationDescriptor({ scope: ref, groupId, operation: 'updateGroup',
                request: { requestId: 'rename-' + groupId + '-' + principalId, actorPrincipalId: principalId, displayName: 'New name' } });
            expect((await prepareMutation(f, rename('owner'))).computed).toMatchObject({ outcome: 'rejected', policyDenial: { code: 'forbidden-role' } });
            const authorizedRename = await prepareMutation({ ...f, owner: other }, rename('staff'));
            await commitMutation(f, requireMutationWrite(authorizedRename.computed));
            expect((await f.repository.findGroup(ref))?.displayName).toBe('New name');
            expect((await f.repository.findGroup(ref))?.ownerPrincipalId).toBe('staff');
            expect(await f.repository.findMember({ ...ref, principalId: 'owner' })).toMatchObject({ role: 'member', status: previousStatus });
            expect(await f.repository.findMember({ ...ref, principalId: 'staff' })).toMatchObject({ role: 'owner', status: 'active' });
        }
    } finally { queue.inbox.stop(); await f.storage.close(); }
});
