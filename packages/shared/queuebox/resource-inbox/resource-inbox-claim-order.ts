import { Temporal } from '@js-temporal/polyfill';

import { EntityStatus, type ResourceEntry } from '../ResourceEntry.ts';

/**
 * The order a claim takes its rows in. A claim without RETRY takes them in creation order, because a store's row
 * identity or key order need not follow arrival; a claim with RETRY takes them in due order. Entries store their
 * creation time to the whole millisecond, so creation order is millisecond order. Rows created in one millisecond tie,
 * and a tie falls to insertion order in memory and in IndexedDB and to row id in PostgreSQL; row ids from different
 * connections need not follow arrival, so arrival within one millisecond is not ordered there.
 *
 * Due order, on every store: a row is due when it has no next time or its next time is at or before now. A `due`
 * claim takes at most `maxToReserve` due rows, counted across every type and status it names, the earliest next time
 * first; a row that is not yet due is never read as a candidate in place of one that is. A row with no next time comes
 * before every dated row. Rows that tie, and rows with no next time among themselves, fall to the store's own arrival
 * order. A `due` work page reads a type and status's rows in the same order.
 */
export type ResourceInboxClaimOrder = 'creation' | 'due';

export function resolveResourceInboxClaimOrder(statusIds: ReadonlySet<EntityStatus>): ResourceInboxClaimOrder {
    return statusIds.has(EntityStatus.RETRY) ? 'due' : 'creation';
}

/** Due order: a row with no next time first, then next time ascending; 0 on a tie. */
export function compareResourceEntriesByDue(left: ResourceEntry, right: ResourceEntry): number {
    const leftNextTs = left.dequeueAudit.nextTs;
    const rightNextTs = right.dequeueAudit.nextTs;
    if (leftNextTs === undefined || rightNextTs === undefined) {
        return Number(leftNextTs !== undefined) - Number(rightNextTs !== undefined);
    }
    return Temporal.Instant.compare(leftNextTs, rightNextTs);
}

/** The entries in creation order to the millisecond, ties kept in the order given. */
export function toCreationOrderedEntries<T>(
    entries: readonly T[],
    toCreatedTs: (entry: T) => Temporal.PlainDateTime
): T[] {
    return entries
        .map((entry) => ({ entry, createdAtMs: toCreatedAtEpochMs(toCreatedTs(entry)) }))
        .sort((left, right) => left.createdAtMs - right.createdAtMs)
        .map(({ entry }) => entry);
}

/** The creation time is stored as UTC wall time, so its fields read as UTC without building a zoned date. */
function toCreatedAtEpochMs(createdTs: Temporal.PlainDateTime): number {
    return Date.UTC(
        createdTs.year,
        createdTs.month - 1,
        createdTs.day,
        createdTs.hour,
        createdTs.minute,
        createdTs.second,
        createdTs.millisecond
    );
}
