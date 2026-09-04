import { Temporal } from '@js-temporal/polyfill';
import type { EnqueueOrUpdateResult } from '@shared/queuebox/queue-box-types.ts';
import { isExpiredResourceEntry, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlResourceInboxRepository } from './create-p-sql-resource-inbox-repository.ts';
import {
    hasSamePersistedResourceEntry,
    hasSameResourceEntryContent
} from './resource-inbox-entry-comparison.ts';

export async function enqueueResourceInboxIf(
    repository: PSqlResourceInboxRepository,
    resourceEntry: ResourceEntry,
    enqueueIt: (existing: ResourceEntry) => boolean
): Promise<ResourceEntry | undefined> {
    const observedAt = Temporal.Now.instant();
    const observed = await repository.entries.findAnyByKey(resourceEntry.key);
    const replacesExpired = observed !== null && isExpiredResourceEntry(observed, observedAt);
    if (observed !== null && !replacesExpired && !enqueueIt(observed)) {
        return observed;
    }

    return await repository.transaction(async (transaction) => {
        const current = await transaction.entries.findAnyByKeyForUpdate(resourceEntry.key);
        assertSameObservedEntry(current, observed);
        if (observed === null) {
            const written = await transaction.entries.writeIfAbsentOrReplaceExpired(resourceEntry);
            if (!hasSameResourceEntryContent(written, resourceEntry)) {
                throw changedBeforeWriteError();
            }
            return undefined;
        }
        await transaction.entries.replace(resourceEntry);
        return replacesExpired ? undefined : observed;
    });
}

export async function enqueueOrUpdateResourceInbox(
    repository: PSqlResourceInboxRepository,
    resourceEntry: ResourceEntry,
    updateExisting: (existing: ResourceEntry) => ResourceEntry | undefined
): Promise<EnqueueOrUpdateResult> {
    const observedAt = Temporal.Now.instant();
    const observed = await repository.entries.findAnyByKey(resourceEntry.key);
    const replacesExpired = observed !== null && isExpiredResourceEntry(observed, observedAt);
    const updated = observed === null || replacesExpired
        ? resourceEntry
        : updateExisting(observed);
    if (updated === undefined) {
        if (observed === null) {
            throw new Error('Resource inbox update unexpectedly omitted a new entry');
        }
        return {
            action: 'unchanged',
            entry: observed,
            previous: observed
        };
    }

    return await repository.transaction(async (transaction) => {
        const current = await transaction.entries.findAnyByKeyForUpdate(resourceEntry.key);
        assertSameObservedEntry(current, observed);
        if (observed === null) {
            const written = await transaction.entries.writeIfAbsentOrReplaceExpired(resourceEntry);
            if (!hasSameResourceEntryContent(written, resourceEntry)) {
                throw changedBeforeWriteError();
            }
            return {
                action: 'inserted',
                entry: resourceEntry,
                previous: undefined
            };
        }

        await transaction.entries.replace(updated);
        return {
            action: 'updated',
            entry: updated,
            previous: replacesExpired ? undefined : observed
        };
    });
}

function assertSameObservedEntry(
    current: ResourceEntry | null,
    observed: ResourceEntry | null
): void {
    if (
        current === null || observed === null
            ? current !== observed
            : !hasSamePersistedResourceEntry(current, observed)
    ) {
        throw changedBeforeWriteError();
    }
}

function changedBeforeWriteError(): Error {
    return new Error('Resource inbox entry changed before conditional write');
}
