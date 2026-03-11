import { describe, expect, it } from 'vitest';
import { SuccessDto } from '@shared/queuebox/DequeueController.ts';
import { DequeueResourceEntryController, ResilienceDto, } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { EntityStatus, Key, NEVER_EXPIRE_TS, ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';

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
            duration,
        );

        const resilienceDto = ResilienceDto.toResilienceDto(
            circuitBreakerPolicy,
            initialRate,
            maxRate,
            concurrencyIncreaseStep,
            concurrencyReduceStep,
        );

        const helloWorld = 'hello world';
        const newEntry: ResourceEntry = {
            key: {
                topicId: 'test',
                resourceId: 'test',
                contextId: 'test',
            },
            resource: JSON.stringify(new TestData(helloWorld)),
            typeId: typeId,
            audit: {
                date: Temporal.Now.plainTimeISO(),
                createdBy: 'test',
                createdTs: Temporal.Now.plainDateTimeISO(),
                expiryTs: NEVER_EXPIRE_TS,
            },
            status: EntityStatus.NEW,
            dequeueAudit: {
                attempts: 0,
            },
            db: undefined,
        };

        await queue.enqueue(newEntry);

        const dequeued = await DequeueResourceEntryController.toDequeuer<string>(
                queue,
                () => types,
                () => 1,
                20,
                100,
                resilienceDto,
            )
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(async (_key, entry) => {
                const testData: TestData = JSON.parse(entry.resource);
                expect(testData.name).toBe(helloWorld);

                return helloWorld;
            });

        const successes: Array<SuccessDto<Key, ResourceEntry, string>> =
            DequeueResourceEntryController.toSuccesses(dequeued);

        expect(successes.length).toBeGreaterThan(0);
        expect(
            successes.some((success) => success.computedValue === helloWorld),
        ).toBe(true);
        expect(
            successes.some(
                (success) => success.value.status === EntityStatus.COMPLETED,
            ),
        ).toBe(true);
    });
});
