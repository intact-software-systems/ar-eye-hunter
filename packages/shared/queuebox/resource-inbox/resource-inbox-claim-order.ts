import type { Temporal } from '@js-temporal/polyfill';

import { EntityStatus } from '../ResourceEntry.ts';

/**
 * The order a claim takes its rows in. A claim without RETRY takes them in creation order, because a store's row
 * identity or key order need not follow arrival; a claim with RETRY takes them in due order. Entries store their
 * creation time to the whole millisecond, so creation order is millisecond order. Rows created in one millisecond tie,
 * and a tie falls to insertion order in memory and in IndexedDB and to row id in PostgreSQL; row ids from different
 * connections need not follow arrival, so arrival within one millisecond is not ordered there.
 */
export type ResourceInboxClaimOrder = 'creation' | 'due';

export function resolveResourceInboxClaimOrder(statusIds: ReadonlySet<EntityStatus>): ResourceInboxClaimOrder {
    return statusIds.has(EntityStatus.RETRY) ? 'due' : 'creation';
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
