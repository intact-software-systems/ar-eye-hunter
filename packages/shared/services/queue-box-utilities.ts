import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../al-contracts/al-policy.ts';
import { toAppQueueCreatedBy } from '../queuebox/AppQueueIdentity.ts';
import { DequeueController } from '../queuebox/dequeue/dequeue-controller.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import {
    createDefaultResourceInboxDequeuer,
    type DequeueResourceEntryOptions,
    type ResourceInboxHandlerFinalizedSuccess
} from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceInboxAttemptTelemetry } from '../queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxCommandRejectedError } from '../queuebox/resource-inbox/resource-inbox-command-rejected-error.ts';
import type { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '../queuebox/ResourceEntry.ts';

export namespace QueueBoxUtilities {
    export type CreationClock = () => Temporal.Instant;

    export interface DequeueInput {
        readonly qbox: QueueBoxResourceEntryRepository;
        readonly typesToDequeue: Set<string>;
        readonly resilience: ResourceInboxResilience;
        readonly onDequeuedDo: (
            entry: ResourceEntry,
            attemptTelemetry: ResourceInboxAttemptTelemetry
        ) => Promise<void | ResourceInboxHandlerFinalizedSuccess>;
        readonly options: DequeueResourceEntryOptions;
        readonly readLaneBudgets?: DequeueController.ReadLaneBudgets;
    }
}

export class QueueBoxUtilities {
    /** Resolves with the number of entries this invocation claimed across every lane. */
    static async defaultDequeue(
        { qbox, typesToDequeue, resilience, onDequeuedDo, options, readLaneBudgets }: QueueBoxUtilities.DequeueInput
    ): Promise<number> {
        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn(
                'Dequeue blocked by an open circuit',
                [...typesToDequeue],
                resilience.circuitBreaker.state.get()
            );
            return 0;
        }

        const claimedByLane = await createDefaultResourceInboxDequeuer<
            ResourceInboxHandlerFinalizedSuccess | undefined
        >({
            repository: qbox,
            typesToDequeue: () => typesToDequeue,
            maxToReserve: () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE,
            maxNumToDequeue: DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE,
            readLaneBudgets,
            resilience: resilience,
            options: options
        })
            .withReturnDequeuedEntries(true)
            .onFailedEntries(
                (failures) => {
                    if (
                        [...failures.values()].some((failure) =>
                            !isNotReadyException(failure.exception) &&
                            !(failure.exception instanceof ResourceInboxCommandRejectedError) &&
                            !(options.isRetryableConflict?.(failure.exception) ?? false)
                        )
                    ) {
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
                async (_key, attempt) => (await onDequeuedDo(attempt.entry, attempt.telemetry)) ?? undefined
            );
        return [...claimedByLane.values()].reduce((claimed, lane) => claimed + lane.size, 0);
    }

    static toResourceEntryFromMsg(
        msg: ALMessage,
        typeId: string,
        createdAt: Temporal.Instant
    ): ResourceEntry {
        const expireAtMs = resolveALMessageExpireAtMs(msg);
        const expiryTs = expireAtMs !== undefined
            ? Temporal.Instant.fromEpochMilliseconds(expireAtMs)
            : NEVER_EXPIRE_TS;

        const createdAtUtc = createdAt.toZonedDateTimeISO('UTC');
        return {
            key: {
                topicId: msg.route.topicId,
                resourceId: msg.route.resourceId,
                contextId: msg.route.contextId
            },
            resource: JSON.stringify(msg),
            typeId: typeId,
            audit: {
                date: createdAtUtc.toPlainTime(),
                // The stored creator column is 16 characters wide; the message keeps its full audit.
                createdBy: toAppQueueCreatedBy(msg.audit?.createdBy ?? 'test'),
                createdTs: createdAtUtc.toPlainDateTime(),
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
