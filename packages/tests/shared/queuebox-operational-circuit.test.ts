import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    ResourceInboxHandlerFinalizedRejection,
    ResourceInboxHandlerRetryableConflict
} from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

describe('QueueBox operational failure circuit', () => {
    it('opens after genuine handler failures and leaves later work pending', async () => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(1, duration, duration, duration));
        const queue = new InMemoryQueueBox();
        const first = toResourceEntry('operational-failure', { value: 1 });
        const second = toResourceEntry('operational-failure', { value: 2 });
        await queue.enqueue(first);
        await queue.enqueue(second);
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await QueueBoxUtilities.defaultDequeue({
                qbox: queue,
                typesToDequeue: new Set(['operational-failure']),
                newLaneClaimOrder: 'queue',
                resilience,
                onDequeuedDo: async () => {
                    throw new Error('Storage transport unavailable');
                },
                options: { jitterUnit: () => 0.5 }
            });
            expect(resilience.isNotAllowedThroughToDequeue()).toBe(true);
            expect((await queue.getItem(first.key))?.status).toBe(EntityStatus.RETRY);
            expect((await queue.getItem(second.key))?.status).toBe(EntityStatus.RETRY);
            const later = toResourceEntry('later-work', { value: 3 });
            await queue.enqueue(later);
            await QueueBoxUtilities.defaultDequeue({
                qbox: queue,
                typesToDequeue: new Set(['later-work']),
                newLaneClaimOrder: 'queue',
                resilience,
                onDequeuedDo: async () => {},
                options: {}
            });
            expect((await queue.getItem(later.key))?.status).toBe(EntityStatus.NEW);
        }
        finally {
            errorLog.mockRestore();
            warningLog.mockRestore();
        }
    });
    it.each([false, true])('keeps durable rejection neutral while preserving operational failure in a mixed batch: %s', async (includeOperationalFailure) => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(0, duration, duration, duration));
        const queue = new InMemoryQueueBox();
        const rejected = toResourceEntry('command-rejection', { value: 1 });
        await queue.enqueue(rejected);
        const operational = toResourceEntry('storage-failure', { value: 2 });
        if (includeOperationalFailure) {
            await queue.enqueue(operational);
        }
        const cause = new Error('Group already exists');
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await QueueBoxUtilities.defaultDequeue({
                qbox: queue,
                typesToDequeue: new Set(['command-rejection', 'storage-failure']),
                newLaneClaimOrder: 'queue',
                resilience,
                onDequeuedDo: async (entry) => {
                    if (entry.typeId === 'storage-failure') {
                        throw new Error('Storage transport unavailable');
                    }
                    const released = await queue.releaseEntries([{ entry, disposition: { status: EntityStatus.FAILED, delayMs: null } }]);
                    const finalized = [...released.values()][0];
                    expect(finalized).toBeDefined();
                    if (finalized === undefined) {
                        throw new Error('Rejection did not finalize');
                    }
                    return new ResourceInboxHandlerFinalizedRejection(finalized, 'group-already-exists', cause);
                },
                options: { jitterUnit: () => 0.5 }
            });
            expect((await queue.getItem(rejected.key))?.status).toBe(EntityStatus.FAILED);
            expect(resilience.isNotAllowedThroughToDequeue()).toBe(includeOperationalFailure);
            if (includeOperationalFailure) {
                expect((await queue.getItem(operational.key))?.status).toBe(EntityStatus.RETRY);
            }
        }
        finally {
            errorLog.mockRestore();
        }
    });

    it('keeps a handler conflict value neutral for the admission rate, as a thrown conflict was', async () => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(10, duration, duration, duration));
        const signals: string[] = [];
        resilience.success = () => {
            signals.push('success');
        };
        resilience.failure = () => {
            signals.push('failure');
        };
        const queue = new InMemoryQueueBox();
        const conflicted = toResourceEntry('write-conflict', { value: 1 });
        await queue.enqueue(conflicted);
        const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            await QueueBoxUtilities.defaultDequeue({
                qbox: queue,
                typesToDequeue: new Set(['write-conflict']),
                newLaneClaimOrder: 'queue',
                resilience,
                onDequeuedDo: async (entry) =>
                    new ResourceInboxHandlerRetryableConflict(
                        entry,
                        'runtime-state-write-conflict',
                        Object.assign(new Error('Runtime state conditional write conflict'), {
                            code: 'runtime-state-write-conflict'
                        })
                    ),
                options: { jitterUnit: () => 0.5 }
            });
            expect((await queue.getItem(conflicted.key))?.status).toBe(EntityStatus.RETRY);
            expect(signals).toEqual([]);
        }
        finally {
            infoLog.mockRestore();
        }
    });
});
