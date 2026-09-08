import { Temporal } from '@js-temporal/polyfill';
import { Either } from '../resilience/Either.ts';
import { computeResourceInboxRelease } from './compute-resource-inbox-release.ts';
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
import { hasSameResourceEntryValue } from './resource-entry-observations.ts';
import {
    EntityStatus,
    toKeyAsString,
    type Key,
    type ResourceEntry
} from './ResourceEntry.ts';

interface ComputeIndexedDbQueueReleaseInput {
    readonly currentEntries: ReadonlyMap<string, ResourceEntry>;
    readonly disposition: ResourceInboxReleaseDisposition;
    readonly releasedAt: Temporal.Instant;
    readonly resources: readonly ResourceEntry[];
    readonly storedEntries: ReadonlyMap<string, StoredResourceEntry>;
}

interface ComputedIndexedDbQueueRelease {
    readonly mutations: readonly ComputedIndexedDbQueueMutation[];
    readonly result: Map<Key, ResourceEntry>;
}

export function computeIndexedDbQueueRelease(
    input: ComputeIndexedDbQueueReleaseInput
): Either<ResourceInboxLostReservationError, ComputedIndexedDbQueueRelease> {
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
                    !hasSameResourceEntryValue(current, resource)
                ) &&
                !isIdempotentHandlerFinalizedRelease({
                    current,
                    reserved: resource,
                    disposition: input.disposition,
                    observedAt: input.releasedAt
                })
            )
        ) {
            return Either.ofLeft(
                new ResourceInboxLostReservationError(
                    resource.key,
                    resource.dequeueAudit.attempts
                )
            );
        }
        if (current.status !== EntityStatus.RESERVED) {
            result.set(current.key, current);
            continue;
        }
        const updated = computeResourceInboxRelease(current, input.disposition, input.releasedAt);
        result.set(updated.key, updated);
        mutations.push(computeIndexedDbQueuePut(stored, updated));
    }
    return Either.ofRight({ mutations, result });
}
