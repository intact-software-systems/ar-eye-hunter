import { Temporal } from '@js-temporal/polyfill';
import {
    decodeAdminPruneOutboxMessage,
    decodeAdminPruneWork,
    toAdminPruneOutbox,
    type AdminPrunePageWork
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

describe('admin prune application outbox dispatch', () => {
    it('delivers a persisted page through AL validation to its reserved-work decoder', async () => {
        const now = Date.now();
        const queue = new InMemoryQueueBox();
        const reader = new OutboxQueueReader(queue);
        const delivered: AdminPrunePageWork[] = [];
        const entry = toAdminPruneOutbox({
            kind: 'page',
            jobId: 'queue-prune-job',
            category: 'runtime-state',
            requestedBy: 'admin-1',
            requestedSessionId: 'admin-session-1',
            capturedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        }, 'server-1');
        reader.onOutboxMessageDo('ADMIN_PRUNE_EXPIRED', {
            onMessage: async (_message, reserved) => {
                delivered.push(decodeAdminPruneWork(reserved));
            }
        });
        await queue.enqueueIfAbsent(entry);

        await reader.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience());

        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({
            jobId: 'queue-prune-job',
            category: 'runtime-state',
            requestedBy: 'admin-1',
            requestedSessionId: 'admin-session-1',
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            reservation: { status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } }
        });
        expect((await queue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it.each([
        { mode: 'all', scope: 'global' },
        { mode: 'broadcast', scope: 'world' },
        { mode: 'unicast', toPeerId: 'server-1' }
    ])('rejects a page addressed outside canonical application-worker scope: %j', (targets) => {
        const entry = toAdminPruneOutbox({
            kind: 'page',
            jobId: 'wrong-scope-job',
            category: 'runtime-state',
            requestedBy: 'admin-1',
            requestedSessionId: 'admin-session-1',
            capturedAtEpochMs: 1_700_000_000_000,
            expireAtEpochMs: 1_700_000_060_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        }, 'server-1');
        const message = decodePersistedALMessage(entry.resource);

        expect(() =>
            decodeAdminPruneOutboxMessage({
                ...entry,
                resource: JSON.stringify({ ...message, targets })
            })
        ).toThrow(TypeError);
    });
});

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    );
}
