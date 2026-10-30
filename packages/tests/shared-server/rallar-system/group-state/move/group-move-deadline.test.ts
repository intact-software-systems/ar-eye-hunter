import { Temporal } from '@js-temporal/polyfill';
import { installGroupMoveDeadline } from '@shared-server/rallar-system/group-state/move/group-move-inbox.ts';
import { computeGroupMovePublication, type GroupMoveDeadline } from '@shared-server/rallar-system/group-state/move/group-move-outbox.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { expect, it } from 'vitest';
import { createResilience } from '../inbox/group-state-inbox-test-runtime.ts';

it('retries durable deadline delivery after a reader restart without treating retry time as command identity', async () => {
    let now = Date.now();
    const source = { applicationId: 'app', workspaceId: 'default', groupId: 'source' };
    const move: GroupMove = {
        source,
        destination: { ...source, groupId: 'destination' },
        moveId: 'deadline-move',
        organizerSessionId: 'alice-session',
        participants: [{
            principalId: 'alice',
            sessionId: 'alice-session',
            generationId: 'generation',
            generationVersion: now - 130000,
            confirmedAtEpochMs: null,
            arrivedAtEpochMs: null
        }],
        createdAtEpochMs: now - 120100,
        expiresAtEpochMs: now - 100,
        completedAtEpochMs: null,
        status: 'proposed',
        reason: null,
        admissionFailure: null
    };
    const publication = computeGroupMovePublication({
        move,
        revision: 0,
        createdAtEpochMs: move.createdAtEpochMs,
        retentionMs: 86400000,
        serviceId: 'server',
        traceId: 'deadline-test',
        scheduleDeadline: true
    });
    const entry = publication.outbox.find((write) => JSON.parse(write.entry.resource).payload.typeId === 'GROUP_MOVE_DEADLINE')?.entry;
    if (!entry) {
        throw new Error('Expected durable deadline work');
    }
    const queue = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(now));
    await queue.enqueueIfAbsent(entry);
    const beforeRestart = new OutboxQueueReader(queue);
    installGroupMoveDeadline({
        outboxQueueReader: beforeRestart,
        now: () => now,
        enqueue: async () => {
            throw new Error('Database temporarily unavailable');
        }
    });
    await beforeRestart.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience());
    const retry = await queue.getItem(entry.key);
    expect(retry?.status).not.toBe(EntityStatus.COMPLETED);
    expect(retry?.dequeueAudit.attempts).toBe(1);
    expect(retry?.dequeueAudit.nextTs?.epochMilliseconds).toBeGreaterThan(move.expiresAtEpochMs);

    now += 1000;
    const delivered: GroupMoveDeadline[] = [];
    const afterRestart = new OutboxQueueReader(queue);
    installGroupMoveDeadline({
        outboxQueueReader: afterRestart,
        now: () => now,
        enqueue: async (command) => {
            delivered.push(command);
            return entry;
        }
    });
    await afterRestart.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience());
    expect(delivered).toEqual([{ source, moveId: move.moveId, expiresAtEpochMs: move.expiresAtEpochMs }]);
    expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
});
