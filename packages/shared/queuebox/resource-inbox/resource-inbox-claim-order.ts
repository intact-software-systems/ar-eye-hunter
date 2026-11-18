import { Temporal } from '@js-temporal/polyfill';

import { EntityStatus, type ResourceEntry } from '../ResourceEntry.ts';

/**
 * The order a claim takes its rows in. A claim without RETRY takes them in creation order, because a store's row
 * identity or key order need not follow arrival; a claim with RETRY takes them in due order. Entries store their
 * creation time to the whole millisecond, so creation order is millisecond order. Rows created in one millisecond tie,
 * and a tie falls to insertion order in memory and in IndexedDB and to row id in PostgreSQL; row ids from different
 * connections need not follow arrival, so arrival within one millisecond is not ordered there.
 *
 * Due order, on every store: a row is due when it has no next time or its next time is at or before now; a row with no
 * next time is due at once. A `due` claim takes at most `maxToReserve` due rows, counted across every type and status it
 * names, the earliest first; a row that is not yet due is never read as a candidate in place of one that is. Where an
 * undated row falls among dated rows is each store's own: the IndexedDB and memory stores place it by its creation
 * instant, PostgreSQL before every dated row, and no caller may rely on either. Rows that tie fall to the store's own
 * arrival order. A `due` work page reads a type and status's rows in the same order, due yet or not, and reads past an
 * expired row as a `due` claim does: an expired row is not pending work, so it never takes a live row's place on the
 * page. Expired means what the store's claim means by it, at the store's own clock: the injected clock in memory and
 * in IndexedDB, the database's `now()` in PostgreSQL. A `key` page returns expired rows, for the cleanup that pages by
 * key.
 */
export type ResourceInboxClaimOrder = 'creation' | 'due';

export function resolveResourceInboxClaimOrder(statusIds: ReadonlySet<EntityStatus>): ResourceInboxClaimOrder {
    return statusIds.has(EntityStatus.RETRY) ? 'due' : 'creation';
}

/** A row's place in due order: its next time, or, when it has none, its creation instant. */
export function toResourceEntryDueInstant(entry: ResourceEntry): Temporal.Instant {
    return entry.dequeueAudit.nextTs ??
        Temporal.Instant.fromEpochMilliseconds(toCreatedAtEpochMs(entry.audit.createdTs));
}

/** Due order as the IndexedDB and memory stores keep it: by `toResourceEntryDueInstant`; 0 on a tie. */
export function compareResourceEntriesByDue(left: ResourceEntry, right: ResourceEntry): number {
    return Temporal.Instant.compare(toResourceEntryDueInstant(left), toResourceEntryDueInstant(right));
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
export function toCreatedAtEpochMs(createdTs: Temporal.PlainDateTime): number {
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
