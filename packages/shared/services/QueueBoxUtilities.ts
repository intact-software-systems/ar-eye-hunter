import { Temporal } from '@js-temporal/polyfill';
import { ALMessage } from '../al-contracts/al-contract.ts';
import { DequeueController } from '../queuebox/DequeueController.ts';
import {
    DequeueResourceEntryController,
    ResilienceDto,
    type DequeueResourceEntryOptions
} from '../queuebox/DequeueResourceEntryController.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { EntityStatus, Key, NEVER_EXPIRE_TS, ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { computeResourceEntryFromALMessage } from './queue-box-resource-entry-computation.ts';

export class QueueBoxUtilities {
    static readonly RETRY_DISPOSITION_ERROR = 'Queue entry requested retry';

    static async defaultDequeue(
        qbox: QueueBoxResourceEntryRepository,
        typesToDequeue: Set<string>,
        resilience: ResilienceDto,
        onDequeuedDo: (entry: ResourceEntry) => Promise<void>,
        options: DequeueResourceEntryOptions = {}
    ): Promise<void> {
        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn('Dequeue blocked {}, circuit state {}', typesToDequeue, resilience.circuitBreaker.state.get());
            return;
        }

        await DequeueResourceEntryController.toDequeuer<Key>(
            qbox,
            () => typesToDequeue,
            () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE,
            resilience.retryPolicy.maxAttempts,
            DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE,
            resilience,
            options
        )
            .onFailedEntries(
                (_) => resilience.failure()
            )
            .onCompletedEntries(
                (_) => resilience.success()
            )
            .dequeueForCompute(
                async (key, entry) => {
                    await onDequeuedDo(entry);
                    return key;
                }
            );
    }

    static withRetryDisposition(
        onDequeuedDo: (entry: ResourceEntry) => Promise<'completed' | 'retry'>
    ): (entry: ResourceEntry) => Promise<void> {
        return async (entry: ResourceEntry): Promise<void> => {
            const disposition = await onDequeuedDo(entry);
            if (disposition === 'retry') {
                throw new Error(QueueBoxUtilities.RETRY_DISPOSITION_ERROR);
            }
        };
    }

    static toResourceEntry<T>(typeId: string, resource: T): ResourceEntry {
        return {
            key: {
                topicId: typeId,
                resourceId: crypto.randomUUID().toString(),
                contextId: 'test'
            },
            resource: JSON.stringify(resource),
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
    }

    static toResourceEntryFromMsg(msg: ALMessage, typeId: string): ResourceEntry {
        return computeResourceEntryFromALMessage(msg, typeId, {
            date: Temporal.Now.plainTimeISO(),
            createdTs: Temporal.Now.plainDateTimeISO()
        });
    }
}
