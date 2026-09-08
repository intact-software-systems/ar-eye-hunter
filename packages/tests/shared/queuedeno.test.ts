import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultResourceInboxDequeuer } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { EitherCollectors } from '@shared/resilience/Either.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

class TestData {
    public readonly name: string;

    constructor(name: string) {
        this.name = name;
    }
}

describe('queuedeno compatibility', () => {
    it('dequeues a queued resource entry', async () => {
        const queue = new InMemoryQueueBox();
        const typeId = 'WHACK';
        const types = new Set<string>([typeId]);
        const duration = Temporal.Duration.from({ seconds: 10 });
        const initialRate = 1;
        const maxRate = 10;
        const concurrencyIncreaseStep = 1;
        const concurrencyReduceStep = 1;

        const circuitBreakerPolicy = new CircuitBreakerPolicy(
            10,
            duration,
            duration,
            duration
        );

        const resilienceDto = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: circuitBreakerPolicy,
            initialRate: initialRate,
            maxRate: maxRate,
            concurrencyIncreaseStep: concurrencyIncreaseStep,
            concurrencyReduceStep: concurrencyReduceStep
        });

        const helloWorld = 'hello world';
        const newEntry: ResourceEntry = {
            key: {
                topicId: 'test',
                resourceId: 'test',
                contextId: 'test'
            },
            resource: JSON.stringify(new TestData(helloWorld)),
            typeId: typeId,
            audit: {
                date: Temporal.Now.plainTimeISO(),
                createdBy: 'test',
                createdTs: Temporal.Now.plainDateTimeISO(),
                expiryTs: NEVER_EXPIRE_TS
            },
            status: EntityStatus.NEW,
            dequeueAudit: {
                attempts: 0
            },
            db: undefined
        };

        await queue.enqueue(newEntry);

        const dequeued = await createDefaultResourceInboxDequeuer<string>({
            repository: queue,
            typesToDequeue: () => types,
            maxToReserve: () => 1,
            maxNumToDequeue: 100,
            resilience: resilienceDto
        })
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(async (_key, attempt) => {
                const entry = attempt.entry;
                const testData: TestData = JSON.parse(entry.resource);
                expect(testData.name).toBe(helloWorld);

                return helloWorld;
            });

        const successes = [...dequeued.values()].flatMap((lane) => EitherCollectors.toListFoldRights(lane.values()));

        expect(successes).toHaveLength(1);
        expect(
            successes.some((success) => success.computedValue === helloWorld)
        ).toBe(true);
        expect(
            successes.some(
                (success) => success.value.entry.status === EntityStatus.COMPLETED
            )
        ).toBe(true);
    });
});
