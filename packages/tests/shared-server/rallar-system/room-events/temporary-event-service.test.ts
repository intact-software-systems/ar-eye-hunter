import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { expect, it, vi } from 'vitest';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
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
        const config = { serviceId: 'events', finishedRetentionMs: 3_600_000, organizerIds: ['owner'] };
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
            expect(await groups.isTemporaryRoomAvailable(lobby, nowEpochMs() + 2000)).toBe(false);
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
        const config = { serviceId: 'events', finishedRetentionMs: 3_600_000, organizerIds: ['owner'] };
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
        const court = { ...RETENTION_REF, groupId: 'court' };
        const connect = (generation: string) => mutationDescriptor({ scope: court, groupId: court.groupId, operation: 'connectPresence',
            sessionId: fixture.owner.sessionId, request: { actorPrincipalId: 'owner', principalId: 'owner', generationId: generation,
                publicationKey: null, connectionGenerationId: generation, requestId: generation,
                connectedAtEpochMs: nowEpochMs(), lastHeartbeatAtEpochMs: nowEpochMs(), expiresAtEpochMs: nowEpochMs() + 20_000 } });
        await commitMutation(fixture, requireMutationWrite((await prepareMutation(fixture, connect('first'))).computed));
        fixture.nowEpochMs += 1100;
        const lobby = (await groups.findGroup(RETENTION_REF))!;
        expect(await groups.isTemporaryRoomAvailable(lobby, nowEpochMs())).toBe(true);
        const departure = await prepareMutation(fixture, mutationDescriptor({ scope: court, groupId: court.groupId,
            operation: 'disconnectPresence', sessionId: fixture.owner.sessionId, request: {
                actorPrincipalId: 'owner', generationId: 'first', requestId: 'depart', disconnectedAtEpochMs: nowEpochMs() } }));
        await commitMutation(fixture, requireMutationWrite(departure.computed));
        fixture.nowEpochMs += 999;
        expect(await groups.isTemporaryRoomAvailable(lobby, nowEpochMs())).toBe(true);
        fixture.nowEpochMs++;
        expect(await groups.isTemporaryRoomAvailable(lobby, nowEpochMs())).toBe(false);
        await expect(prepareMutation(fixture, connect('late'))).rejects.toThrow('event is no longer available');
        expect((await groups.findGroup(court))?.status).toBe('active');
    }
    finally { queue.inbox.stop(); await fixture.storage.close(); }
});
