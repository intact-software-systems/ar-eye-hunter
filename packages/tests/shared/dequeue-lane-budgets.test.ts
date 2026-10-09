import { describe, expect, expectTypeOf, it } from 'vitest';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { DequeueController, Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultResourceInboxDequeuer } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueMessage, createQueueResilience, seedRetry } from './app-inbox/fair-service-fixture.ts';

function laneBudgets(maxNumToDequeue: number): DequeueController.LaneBudgets {
    return {
        FINALIZATION: { maxToReserve: 1, maxNumToDequeue: 1 },
        NEW: { maxToReserve: 5, maxNumToDequeue },
        FAIRNESS: { maxToReserve: 1, maxNumToDequeue: 1 },
        RETRY: { maxToReserve: 1, maxNumToDequeue: 1 },
        TIMEOUT: { maxToReserve: 1, maxNumToDequeue: 1 }
    };
}

describe('DequeueController lane budgets', () => {
    it('keeps numeric limits per lane when no budget callback is configured', async () => {
        let now = Temporal.Now.instant();
        const queue = new InMemoryQueueBox(new Map(), () => now);
        const reader = new InboxQueueReader(queue);
        await seedRetry(queue, 'retry-a');
        await seedRetry(queue, 'retry-b');
        await reader.enqueueIfAbsent(createQueueMessage('new-a'));
        await reader.enqueueIfAbsent(createQueueMessage('new-b'));
        now = now.add({ milliseconds: 2 });
        const completed: string[] = [];

        await createDefaultResourceInboxDequeuer<string>({
            repository: queue,
            typesToDequeue: () => InboxQueueReader.INBOX_DEQUEUE_TYPES,
            maxToReserve: () => 1,
            maxNumToDequeue: 1,
            resilience: createQueueResilience()
        }).dequeueForCompute(async (_key, attempt) => {
            completed.push(attempt.entry.key.resourceId);
            return attempt.entry.key.resourceId;
        });

        expect(completed).toEqual(['new-a', 'retry-a']);
    });

    it('bounds separate finalization recovery and reports its key alongside ordinary computed values', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        for (const id of ['exhausted-a', 'exhausted-b']) {
            const entry = await seedRetry(queue, id);
            await queue.enqueue({
                ...entry,
                status: EntityStatus.RESERVED,
                dequeueAudit: {
                    ...entry.dequeueAudit,
                    attempts: 20,
                    startTs: Temporal.Now.instant().subtract({ milliseconds: ResourceInboxResilience.FINALIZATION_STALE_AFTER_MS + 1 })
                }
            });
        }
        await reader.enqueueIfAbsent(createQueueMessage('ordinary'));
        const budgets = laneBudgets(1);
        const completed: string[] = [];
        const controller = createDefaultResourceInboxDequeuer<string>({
            repository: queue,
            typesToDequeue: () => InboxQueueReader.INBOX_DEQUEUE_TYPES,
            maxToReserve: () => 5,
            maxNumToDequeue: 1000,
            resilience: createQueueResilience(),
            readLaneBudgets: () => ({ ...budgets, FINALIZATION: { maxToReserve: 5, maxNumToDequeue: 1 } }),
            options: {
                onRetryExhaustionRecovery: async ({ entry }) => {
                    const [released] = (await queue.releaseEntries([{ entry, disposition: { status: EntityStatus.FAILED, delayMs: null } }])).values();
                    return released;
                }
            }
        }).withReturnDequeuedEntries(true).onCompletedEntries((results) => {
            for (const result of results.values()) {
                completed.push(result.computedValue);
            }
        });

        const results = await controller.dequeueForCompute(async () => 'computed');

        expect(results.get(Reservator.FINALIZATION)?.size).toBe(1);
        const [finalized] = results.get(Reservator.FINALIZATION)!.values();
        expect(finalized?.right?.computedValue).toEqual(expect.objectContaining({ resourceId: 'exhausted-a' }));
        expectTypeOf(finalized?.right?.computedValue).toEqualTypeOf<string | Key | undefined>();
        expect(completed).toEqual(['computed']);
    });

    it('clamps claims to a lane quota and snapshots budgets before any handler can change them', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const entries = await Promise.all(['a', 'b', 'c', 'd'].map((id) => reader.enqueueIfAbsent(createQueueMessage(id))));
        const budgets = laneBudgets(2);
        let observations = 0;
        const completed: string[] = [];
        const dequeuer = createDefaultResourceInboxDequeuer<string>({
            repository: queue,
            typesToDequeue: () => new Set([EnqueuedType.APP_INBOX]),
            maxToReserve: () => 5,
            maxNumToDequeue: 1_000,
            resilience: createQueueResilience(),
            readLaneBudgets: () => {
                observations += 1;
                return budgets;
            }
        });

        await dequeuer.dequeueForCompute(async (_key, attempt) => {
            completed.push(attempt.entry.key.resourceId);
            Object.assign(budgets.NEW, { maxNumToDequeue: 4 });
            return attempt.entry.key.resourceId;
        });

        expect(completed).toEqual(['a', 'b']);
        expect(observations).toBe(1);
        expect(await Promise.all(entries.map(async (entry) => (await queue.getItem(entry.key))?.status)))
            .toEqual([EntityStatus.COMPLETED, EntityStatus.COMPLETED, EntityStatus.NEW, EntityStatus.NEW]);
    });

    it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1]
        .flatMap((invalid) => ['maxToReserve', 'maxNumToDequeue'].map((field) => ({ invalid, field }))))(
            'rejects invalid $field=$invalid before claiming any work',
            async ({ invalid, field }) => {
                const queue = new InMemoryQueueBox();
                const reader = new InboxQueueReader(queue);
                const entry = await reader.enqueueIfAbsent(createQueueMessage('untouched'));
                const dequeuer = createDefaultResourceInboxDequeuer<string>({
                    repository: queue,
                    typesToDequeue: () => InboxQueueReader.INBOX_DEQUEUE_TYPES,
                    maxToReserve: () => 1,
                    maxNumToDequeue: 1_000,
                    resilience: createQueueResilience(),
                    readLaneBudgets: () => ({ ...laneBudgets(1), NEW: { ...laneBudgets(1).NEW, [field]: invalid } })
                });

                await expect(dequeuer.dequeueForCompute(async () => 'unexpected')).rejects.toThrow();
                expect(await queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
            }
        );
});
import { Temporal } from '@js-temporal/polyfill';
