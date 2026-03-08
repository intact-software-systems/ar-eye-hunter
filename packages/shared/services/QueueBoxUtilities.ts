import {DequeueResourceEntryController, ResilienceDto} from "../queuebox/DequeueResourceEntryController.ts";
import {DequeueController} from "../queuebox/DequeueController.ts";
import {QueueBoxResourceEntryRepository} from "../queuebox/QueueBoxTypes.ts";
import {EntityStatus, Key, ResourceEntry} from "../queuebox/ResourceEntry.ts";
import { ALMessage } from "../al-contracts/al-contract.ts";

export class QueueBoxUtilities {

    static async defaultDequeue(
        qbox: QueueBoxResourceEntryRepository,
        typesToDequeue: Set<string>,
        resilience: ResilienceDto,
        onDequeuedDo: (entry: ResourceEntry) => Promise<void>
    ): Promise<void> {

        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn("Dequeue blocked {}, circuit state {}", typesToDequeue, resilience.circuitBreaker.state.get());
            return;
        }

        await DequeueResourceEntryController.toDequeuer<Key>(
                qbox,
                () => typesToDequeue,
                () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE,
                DequeueController.DEFAULT_MAX_RETRY,
                DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE,
                resilience
            )
            .onFailedEntries(
                _ => resilience.failure()
            )
            .onCompletedEntries(
                _ => resilience.success()
            )
            .dequeueForCompute(
                async (key, entry) => {
                    await onDequeuedDo(entry)
                    return key
                }
            )
    }

    static toResourceEntry<T>(typeId: string, resource: T): ResourceEntry {
        return {
            key: {
                topicId: typeId,
                resourceId: crypto.randomUUID().toString(),
                contextId: "test"
            },
            resource: JSON.stringify(resource),
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
    }

    static toResourceEntryFromMsg(msg: ALMessage): ResourceEntry {
        return {
            key: {
                topicId: msg.key.topicId,
                resourceId: msg.key.resourceId,
                contextId: msg.key.contextId
            },
            resource: JSON.stringify(msg),
            typeId: msg.payload.typeId,
            audit: {
                date: Temporal.Now.plainTimeISO(),
                createdBy: msg.audit?.createdBy ?? "test",
                createdTs: Temporal.Now.plainDateTimeISO()
            },
            status: EntityStatus.NEW,
            dequeueAudit: {
                attempts: 0
            },
            db: undefined
        }
    }
}

