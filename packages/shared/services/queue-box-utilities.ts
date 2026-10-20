import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../al-contracts/al-policy.ts';
import { toAppQueueCreatedBy } from '../queuebox/AppQueueIdentity.ts';
import { DequeueController } from '../queuebox/dequeue/dequeue-controller.ts';
import type { DequeueLaneFlight } from '../queuebox/dequeue/dequeue-lane-flight.ts';
import type { QueueBoxResourceEntryRepository, ResourceInboxClaimOrder } from '../queuebox/queue-box-types.ts';
import {
    createDefaultResourceInboxDequeuer,
    type DequeueResourceEntryOptions
} from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../queuebox/resource-inbox/not-ready-exception.ts';
import type {
    ResourceInboxAttempt,
    ResourceInboxAttemptTelemetry
} from '../queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import {
    ResourceInboxHandlerRetryableConflict,
    type ResourceInboxHandlerOutcome
} from '../queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import type { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type Key,
    type ResourceEntry
} from '../queuebox/ResourceEntry.ts';

export namespace QueueBoxUtilities {
    export type CreationClock = () => Temporal.Instant;

    /**
     * Told when a pass claims an entry, and when the entry's handler starts and settles, whatever its outcome; the owner
     * measures around them. With a standing flight the handler may start and settle after the claiming pass returned.
     */
    export interface DequeueHandlerObserver {
        onEntryClaimed(attempt: ResourceInboxAttempt): void;
        onHandlerStarted(attempt: ResourceInboxAttempt): void;
        onHandlerFinished(attempt: ResourceInboxAttempt): void;
    }

    export interface DequeueInput {
        readonly qbox: QueueBoxResourceEntryRepository;
        readonly typesToDequeue: Set<string>;
        readonly resilience: ResourceInboxResilience;
        readonly newLaneClaimOrder: ResourceInboxClaimOrder;
        readonly onDequeuedDo: (
            entry: ResourceEntry,
            attemptTelemetry: ResourceInboxAttemptTelemetry
        ) => Promise<void | ResourceInboxHandlerOutcome>;
        readonly options: DequeueResourceEntryOptions;
        readonly readLaneBudgets?: DequeueController.ReadLaneBudgets;
        /** The probe that preceded this pass; without one every lane is offered a reservation. */
        readonly workAdvertisement?: DequeueController.WorkAdvertisement;
        readonly handlerObserver?: DequeueHandlerObserver;
        /** Absent, the pass drains what it claims before it resolves. */
        readonly standingFlight?: DequeueLaneFlight<Key, ResourceInboxAttempt, ResourceInboxHandlerOutcome | undefined>;
    }
}

export class QueueBoxUtilities {
    /**
     * Resolves with the number of entries this invocation's processing lanes claimed, whatever each handler's outcome;
     * a claim retried within the same invocation counts again. The breaker hears each entry's verdict when it is
     * released, which with a standing flight may be after the invocation resolved.
     */
    static async defaultDequeue(
        {
            qbox,
            typesToDequeue,
            resilience,
            newLaneClaimOrder,
            onDequeuedDo,
            options,
            readLaneBudgets,
            workAdvertisement,
            handlerObserver,
            standingFlight
        }: QueueBoxUtilities.DequeueInput
    ): Promise<number> {
        if (resilience.isNotAllowedThroughToDequeue()) {
            console.warn(
                'Dequeue blocked by an open circuit',
                [...typesToDequeue],
                resilience.circuitBreaker.state.get()
            );
            return 0;
        }

        let claimedCount = 0;
        await createDefaultResourceInboxDequeuer<ResourceInboxHandlerOutcome | undefined>({
            repository: qbox,
            typesToDequeue: () => typesToDequeue,
            newLaneClaimOrder,
            maxToReserve: () => DequeueController.DEFAULT_MAX_NUM_TO_RESERVE,
            maxNumToDequeue: DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE,
            readLaneBudgets,
            workAdvertisement,
            resilience: resilience,
            options: options,
            standingFlight
        })
            .onClaimedEntries((claimed) => {
                claimedCount += claimed.size;
                for (const attempt of claimed.values()) {
                    handlerObserver?.onEntryClaimed(attempt);
                }
            })
            .onFailedEntries((failures) => {
                if ([...failures.values()].some((failure) => isOperationalDequeueFailure(failure.exception, options))) {
                    resilience.failure();
                }
            })
            .onCompletedEntries((completed) => {
                // A typed rejection is a completed entry: the queue worked, so it is a resilience success. A conflict
                // value is redelivered, neither a success nor an operational failure.
                if (
                    [...completed.values()].some((success) =>
                        !(success.computedValue instanceof ResourceInboxHandlerRetryableConflict)
                    )
                ) {
                    resilience.success();
                }
            })
            .dequeueForCompute(async (_key, attempt) => {
                handlerObserver?.onHandlerStarted(attempt);
                try {
                    return (await onDequeuedDo(attempt.entry, attempt.telemetry)) ?? undefined;
                }
                finally {
                    handlerObserver?.onHandlerFinished(attempt);
                }
            });
        return claimedCount;
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

/** A handler failure the queue cannot explain as not-ready or an expected conflict; a typed rejection is a value. */
function isOperationalDequeueFailure(exception: Error, options: DequeueResourceEntryOptions): boolean {
    return !isNotReadyException(exception) && !(options.isRetryableConflict?.(exception) ?? false);
}
