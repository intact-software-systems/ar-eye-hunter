import { assertEquals } from "@std/assert";
import { SuccessDto } from "@shared/queuebox/DequeueController.ts";
import { DequeueResourceEntryController, ResilienceDto } from "@shared/queuebox/DequeueResourceEntryController.ts";
import { InMemoryQueueBox } from "@shared/queuebox/InMemoryQueueBox.ts";
import { EntityStatus, Key, ResourceEntry } from "@shared/queuebox/ResourceEntry.ts";
import { CircuitBreakerPolicy } from "@shared/resilience/Resilience.ts";

class TestData {
    public readonly name: string;

    constructor(
        name: string
    ) {
        this.name = name;
    }
}

Deno.test('data successfully queued', async () => {
    const queue = new InMemoryQueueBox()
    const typeId = "WHACK";
    const types = new Set<string>([typeId])
    const duration = Temporal.Duration.from({seconds: 10});
    const initialRate = 1;
    const maxRate = 10;
    const concurrencyIncreaseStep = 1;
    const concurrencyReduceStep = 1;

    const circuitBreakerPolicy =
        new CircuitBreakerPolicy(
            10,
            duration,
            duration,
            duration
        )

    const resilienceDto =
        ResilienceDto.toResilienceDto(
            circuitBreakerPolicy,
            initialRate,
            maxRate,
            concurrencyIncreaseStep,
            concurrencyReduceStep
        );

    const helloWorld = "hello world";


    const newEntry: ResourceEntry = {
        key: {
            topicId: "test",
            resourceId: "test",
            contextId: "test"
        },
        resource: JSON.stringify(new TestData(helloWorld)),
        typeId: typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: "test",
            createdTs: Temporal.Now.plainDateTimeISO()
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0
        },
        db: undefined
    }

    await queue.enqueue(newEntry)

    const dequeued =
        await DequeueResourceEntryController.toDequeuer<string>(
                queue,
                () => types,
                () => 1,
                20,
                100,
                resilienceDto
            )
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(
                async (key, entry) => {

                    const testData: TestData = await JSON.parse(entry.resource)
                    assertEquals(testData.name, helloWorld);

                    return helloWorld;
                }
            )

    const successes: Array<SuccessDto<Key, ResourceEntry, string>> = DequeueResourceEntryController.toSuccesses(dequeued);


    console.log(JSON.stringify(successes))

    assertEquals(successes.length, 1)
})

