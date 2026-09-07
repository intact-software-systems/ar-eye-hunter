import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../al-contracts/al-policy.ts';
import { DequeueController } from '../queuebox/dequeue/dequeue-controller.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import {
    createDefaultResourceInboxDequeuer,
    type DequeueResourceEntryOptions
} from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceInboxAttemptTelemetry } from '../queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type Key,
    type ResourceEntry
} from '../queuebox/ResourceEntry.ts';

export namespace QueueBoxUtilities {
    export interface DequeueInput {
        readonly qbox: QueueBoxResourceEntryRepository;
        readonly typesToDequeue: Set<string>;
        readonly resilience: ResourceInboxResilience;
        readonly onDequeuedDo: (entry: ResourceEntry, attemptTelemetry: ResourceInboxAttemptTelemetry) => Promise<void>;
        readonly options: DequeueResourceEntryOptions;
    }
}

export class QueueBoxUtilities {
    static async defaultDequeue(
        { qbox, typesToDequeue, resilience, onDequeuedDo, options }: QueueBoxUtilities.DequeueInput
    ): Promise<void> {
        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn('Dequeue blocked {}, circuit state {}', typesToDequeue, resilience.circuitBreaker.state.get());
            return;
        }

        await createDefaultResourceInboxDequeuer<Key>({
            repository: qbox,
            typesToDequeue: () => typesToDequeue,
            maxToReserve: () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE,
            maxNumToDequeue: DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE,
            resilience: resilience,
            options: options
        })
            .onFailedEntries(
                (failures) => {
                    if ([...failures.values()].some((failure) => !isNotReadyException(failure.exception))) {
                        resilience.failure();
                    }
                }
            )
            .onCompletedEntries(
                (completed) => {
                    if (completed.size > 0) {
                        resilience.success();
                    }
                }
            )
            .dequeueForCompute(
                async (key, attempt) => {
                    await onDequeuedDo(attempt.entry, attempt.telemetry);
                    return key;
                }
            );
    }

    static toResourceEntryFromMsg(msg: ALMessage, typeId: string): ResourceEntry {
        const expireAtMs = resolveALMessageExpireAtMs(msg);
        const expiryTs = expireAtMs !== undefined
            ? Temporal.Instant.fromEpochMilliseconds(expireAtMs)
            : NEVER_EXPIRE_TS;

        return {
            key: {
                topicId: msg.route.topicId,
                resourceId: msg.route.resourceId,
                contextId: msg.route.contextId
            },
            resource: JSON.stringify(msg),
            typeId: typeId,
            audit: {
                date: Temporal.Now.plainTimeISO(),
                createdBy: msg.audit?.createdBy ?? 'test',
                createdTs: Temporal.Now.plainDateTimeISO(),
                expiryTs
            },
            status: EntityStatus.NEW,
            dequeueAudit: {
                attempts: 0
            },
            db: undefined
        };
    }
}
