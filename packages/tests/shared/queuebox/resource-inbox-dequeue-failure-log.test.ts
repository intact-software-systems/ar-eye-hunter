import { Temporal } from '@js-temporal/polyfill';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultResourceInboxDequeuer } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import * as Resource from '@shared/queuebox/ResourceEntry.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

type ReleasedFailures = Map<Resource.Key, DequeueController.Failure<Resource.Key, ResourceInboxAttempt>>;

describe('ResourceInbox dequeue failure log', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs an unexpected handler failure once with the key identity', async () => {
        const queue = new InMemoryQueueBox();
        const enqueued = toResourceEntry('storage-failure', { value: 2 });
        await queue.enqueue(enqueued);
        const failure = new Error('Storage transport unavailable');
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        let attempts = 0;

        const failures = await dequeueOnce(queue, 'storage-failure', async () => {
            attempts += 1;
            if (attempts === 1) {
                throw failure;
            }
            return undefined;
        });

        expect(errorLog).toHaveBeenCalledTimes(1);
        const [message, logged] = errorLog.mock.calls[0]!;
        expect(message).toContain(enqueued.key.topicId);
        expect(message).toContain(enqueued.key.resourceId);
        expect(message).toContain(enqueued.key.contextId);
        expect(message).not.toContain('[object Object]');
        expect(logged).toBe(failure);
        expect([...failures.values()].map(({ exception }) => exception)).toEqual([failure]);
    });
});

async function dequeueOnce(
    queue: InMemoryQueueBox,
    typeId: string,
    computer: (attempt: ResourceInboxAttempt) => Promise<undefined>
): Promise<ReleasedFailures> {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const failures: ReleasedFailures = new Map();
    await createDefaultResourceInboxDequeuer<undefined>({
        repository: queue,
        typesToDequeue: () => new Set([typeId]),
        maxToReserve: () => 1,
        maxNumToDequeue: 1,
        resilience: ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        }),
        options: { jitterUnit: () => 0.5 }
    })
        .onFailedEntries((released) => {
            for (const [key, failure] of released) {
                failures.set(key, failure);
            }
        })
        .dequeueForCompute(async (_key, attempt) => await computer(attempt));
    return failures;
}
