import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    isKeysEqual,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    retryAfterAttempt,
    type ResourceInboxRetryPolicy
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { PSqlQueueBox } from '../../queuebox/postgres/p-sql-queue-box.ts';

export async function requeueRemoteWsOutboxDeliveryFailure(
    repository: QueueBoxResourceEntryRepository,
    observed: ResourceEntry,
    options: Readonly<{
        retryPolicy?: ResourceInboxRetryPolicy;
        jitterUnit?: () => number;
    }> = {}
): Promise<ResourceEntry | undefined> {
    const policy = options.retryPolicy ?? DEFAULT_RESOURCE_INBOX_RETRY_POLICY;
    const decision = retryAfterAttempt(
        policy,
        observed.dequeueAudit.attempts,
        (options.jitterUnit ?? Math.random)()
    );
    const disposition = decision.status === 'retry'
        ? { status: EntityStatus.RETRY, delayMs: decision.delayMs } as const
        : { status: EntityStatus.FAILED, delayMs: null } as const;
    if (repository instanceof PSqlQueueBox) {
        return await repository.repo.requeueObservedDeliveryFailure(observed, disposition) ??
            undefined;
    }
    if (!(repository instanceof InMemoryQueueBox)) {
        throw new Error('Remote WS delivery requeue requires a CAS-capable queue repository');
    }
    const releasedAt = Temporal.Now.instant();
    const result = await repository.enqueueOrUpdate(observed, (current) => {
        if (!hasSameObservedDelivery(current, observed)) {
            return undefined;
        }
        return {
            ...current,
            status: disposition.status,
            dequeueAudit: {
                ...current.dequeueAudit,
                endTs: releasedAt,
                nextTs: disposition.delayMs === null
                    ? undefined
                    : releasedAt.add({ milliseconds: disposition.delayMs })
            }
        };
    });
    return result.action === 'updated' ? result.entry : undefined;
}

function hasSameObservedDelivery(current: ResourceEntry, observed: ResourceEntry): boolean {
    return !isExpiredResourceEntry(current) &&
        isKeysEqual(current.key, observed.key) &&
        current.typeId === observed.typeId &&
        current.resource === observed.resource &&
        current.dequeueAudit.attempts === observed.dequeueAudit.attempts &&
        (current.status === EntityStatus.RESERVED || current.status === EntityStatus.COMPLETED);
}
