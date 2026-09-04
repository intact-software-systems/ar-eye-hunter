import { Temporal } from '@js-temporal/polyfill';
import type { StoredResourceEntry } from './indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueuePut,
    isStoredQueueEntryExpired,
    type ComputedIndexedDbQueueMutation
} from './indexed-db-queue-box-entry.ts';
import {
    isIdempotentHandlerFinalizedRelease,
    ResourceInboxLostReservationError,
    type ResourceInboxReleaseDisposition
} from './queue-box-types.ts';
import { EntityStatus, toKeyAsString, type Key, type ResourceEntry } from './ResourceEntry.ts';

type ComputeIndexedDbQueueReleaseInput = Readonly<{
    currentEntries: ReadonlyMap<string, ResourceEntry>;
    disposition: ResourceInboxReleaseDisposition;
    releasedAt: Temporal.Instant;
    resources: readonly ResourceEntry[];
    storedEntries: ReadonlyMap<string, StoredResourceEntry>;
}>;

type ComputedIndexedDbQueueRelease = Readonly<{
    mutations: readonly ComputedIndexedDbQueueMutation[];
    result: Map<Key, ResourceEntry>;
}>;

export function computeIndexedDbQueueRelease(
    input: ComputeIndexedDbQueueReleaseInput
): ComputedIndexedDbQueueRelease {
    const result = new Map<Key, ResourceEntry>();
    const mutations: ComputedIndexedDbQueueMutation[] = [];
    for (const resource of input.resources) {
        const stored = input.storedEntries.get(toKeyAsString(resource.key));
        const current = input.currentEntries.get(toKeyAsString(resource.key));
        if (
            !stored ||
            !current ||
            (
                (
                    isStoredQueueEntryExpired(stored, input.releasedAt) ||
                    stored.status !== EntityStatus.RESERVED ||
                    stored.dequeueAudit.attempts !== resource.dequeueAudit.attempts
                ) &&
                !isIdempotentHandlerFinalizedRelease(current, resource, input.disposition)
            )
        ) {
            throw new ResourceInboxLostReservationError(
                resource.key,
                resource.dequeueAudit.attempts
            );
        }
        if (current.status !== EntityStatus.RESERVED) {
            result.set(current.key, current);
            continue;
        }
        const updated: ResourceEntry = {
            ...current,
            status: input.disposition.status,
            dequeueAudit: {
                startTs: current.dequeueAudit.startTs,
                endTs: input.releasedAt,
                nextTs: input.disposition.delayMs !== null
                    ? input.releasedAt.add({ milliseconds: input.disposition.delayMs })
                    : undefined,
                attempts: current.dequeueAudit.attempts
            }
        };
        result.set(updated.key, updated);
        mutations.push(computeIndexedDbQueuePut(stored, updated));
    }
    return { mutations, result };
}
