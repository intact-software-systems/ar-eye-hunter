import { Temporal } from '@js-temporal/polyfill';

import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

export function createQueueMessage(resourceId: string): ALMessage {
    return newALUntargetedMessage(
        'api-v1',
        newALRoute('app-inbox.fair-service', 'test-scope', resourceId),
        'test.fair-service',
        { resourceId },
        { ttlMs: 300_000 }
    );
}

export function createQueueResilience(maxAttempts = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        retryPolicy: { ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY, maxAttempts }
    });
}

export async function seedRetry(queue: QueueBoxResourceEntryRepository, resourceId: string): Promise<ResourceEntry> {
    const entry = await queue.enqueueIfAbsent(
        QueueBoxUtilities.toResourceEntryFromMsg(createQueueMessage(resourceId), EnqueuedType.APP_INBOX)
    );
    const reserved = await queue.reserveEntries({
        typeIds: new Set([EnqueuedType.APP_INBOX]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1,
        observedEntries: [await queue.getItem(entry.key) ?? entry]
    });
    const [claimed] = reserved.values();
    if (!claimed) {
        throw new Error('Expected the seeded command to be reserved');
    }
    const [retry] = (await queue.releaseEntries([
        { entry: claimed, disposition: { status: EntityStatus.RETRY, delayMs: 1 } }
    ])).values();
    return retry;
}
