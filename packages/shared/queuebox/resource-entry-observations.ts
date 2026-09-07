import { Either } from '../resilience/Either.ts';
import { hasSameResourceEntryValue } from './has-same-resource-entry-value.ts';
import type { Key, ResourceEntry } from './ResourceEntry.ts';

export function captureResourceEntryObservations(
    entries: readonly ResourceEntry[] | undefined
): ReadonlyMap<string, ResourceEntry> | undefined {
    return entries === undefined ? undefined : new Map(entries.map((entry) => [
        toObservationKey(entry.key),
        toResourceEntrySnapshot(entry)
    ]));
}

export function validateResourceEntryObservation(
    current: ResourceEntry,
    observations: ReadonlyMap<string, ResourceEntry> | undefined
): Either<'stale', ResourceEntry> {
    if (observations === undefined) {
        return Either.ofRight(current);
    }
    const observed = observations.get(toObservationKey(current.key));
    return observed !== undefined && hasSameResourceEntryValue(current, observed)
        ? Either.ofRight(current)
        : Either.ofLeft('stale');
}

function toObservationKey(key: Key): string {
    return JSON.stringify([key.topicId, key.resourceId, key.contextId]);
}

export function toResourceEntrySnapshot(entry: ResourceEntry): ResourceEntry {
    // Temporal leaves are immutable; copy the mutable records without structuredClone losing their prototypes.
    return {
        ...entry,
        key: { ...entry.key },
        audit: { ...entry.audit },
        dequeueAudit: { ...entry.dequeueAudit },
        db: entry.db === undefined ? undefined : { ...entry.db }
    };
}
