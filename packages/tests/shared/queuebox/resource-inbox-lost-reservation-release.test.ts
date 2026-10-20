import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxLostReservationError } from '@shared/queuebox/queue-box-types.ts';
import { createDefaultResourceInboxDequeuer } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueMessage, createQueueResilience } from '../app-inbox/fair-service-fixture.ts';

const LANE_BUDGET: DequeueController.LaneBudget = { maxToReserve: 2, maxNumToDequeue: 2, maxConcurrentComputes: 2 };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('resource inbox lost reservation release', () => {
    it('rejects the pass with a row whose reservation another owner took and still completes the other row', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: 2 });
        const stolen = await reader.enqueueIfAbsent(createQueueMessage('stolen'));
        const kept = await reader.enqueueIfAbsent(createQueueMessage('kept'));
        const releaseEntries = queue.releaseEntries.bind(queue);
        vi.spyOn(queue, 'releaseEntries').mockImplementation(async (releases) => {
            const [release] = releases;
            if (release?.entry.key.resourceId === 'stolen') {
                throw new ResourceInboxLostReservationError(release.entry.key, release.entry.dequeueAudit.attempts);
            }
            return await releaseEntries(releases);
        });
        const completed: string[] = [];
        const dequeuer = createDefaultResourceInboxDequeuer<string>({
            repository: queue,
            typesToDequeue: () => InboxQueueReader.INBOX_DEQUEUE_TYPES,
            newLaneClaimOrder: 'queue',
            maxToReserve: () => 2,
            maxNumToDequeue: 2,
            resilience: createQueueResilience(),
            readLaneBudgets: () => ({
                FINALIZATION: LANE_BUDGET,
                NEW: LANE_BUDGET,
                FAIRNESS: LANE_BUDGET,
                RETRY: LANE_BUDGET,
                TIMEOUT: LANE_BUDGET
            })
        }).onCompletedEntries((entries) => completed.push(...[...entries.keys()].map((key) => key.resourceId)));

        await expect(dequeuer.dequeueForCompute(async (key) => key.resourceId))
            .rejects.toBeInstanceOf(ResourceInboxLostReservationError);

        expect(completed).toEqual(['kept']);
        expect(await queue.getItem(kept.key)).toMatchObject({ status: EntityStatus.COMPLETED });
        expect(await queue.getItem(stolen.key)).toMatchObject({ status: EntityStatus.RESERVED });
    });
});
