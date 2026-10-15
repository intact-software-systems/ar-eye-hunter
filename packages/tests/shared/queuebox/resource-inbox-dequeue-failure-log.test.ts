import { Temporal } from '@js-temporal/polyfill';
import { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    createDefaultResourceInboxDequeuer,
    ResourceInboxHandlerEntryError
} from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxCommandRejectedError } from '@shared/queuebox/resource-inbox/resource-inbox-command-rejected-error.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import * as Resource from '@shared/queuebox/ResourceEntry.ts';
import { EntityStatus, toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
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

    it('releases a committed command rejection as a terminal failure without logging it', async () => {
        const queue = new InMemoryQueueBox();
        const enqueued = toResourceEntry('command-rejection', { value: 1 });
        await queue.enqueue(enqueued);
        const rejection = new ResourceInboxCommandRejectedError('group-already-exists', new Error('Group already exists'));
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

        const failures = await dequeueOnce(queue, 'command-rejection', async (attempt) => {
            const released = await queue.releaseEntries([
                { entry: attempt.entry, disposition: { status: EntityStatus.FAILED, delayMs: null } }
            ]);
            throw new ResourceInboxHandlerEntryError([...released.values()][0]!, rejection);
        });

        expect(errorLog).not.toHaveBeenCalled();
        expect([...failures.values()]).toEqual([
            expect.objectContaining({
                key: enqueued.key,
                exception: rejection,
                value: expect.objectContaining({ entry: expect.objectContaining({ status: EntityStatus.FAILED }) })
            })
        ]);
        expect((await queue.getItem(enqueued.key))?.status).toBe(EntityStatus.FAILED);
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
