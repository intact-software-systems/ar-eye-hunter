import { Temporal } from '@js-temporal/polyfill';
import {
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    isStoredQueueEntryExpired,
    isStoredQueueEntryReservable
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { NO_TEMPORAL_PARSES, recordTemporalParses } from './record-temporal-parses.ts';

describe('IndexedDB queue entry time checks', () => {
    it.each([
        { now: '2026-09-30T12:05:00.122Z', expired: false },
        { now: '2026-09-30T12:05:00.122999999Z', expired: false },
        { now: '2026-09-30T12:05:00.123Z', expired: true },
        { now: '2026-09-30T12:05:00.124Z', expired: true }
    ])('expires a millisecond-precise row at $now: $expired', ({ now, expired }) => {
        const stored = createStoredRow({ expiryTs: '2026-09-30T12:05:00.123Z' });

        expect(isStoredQueueEntryExpired(stored, Temporal.Instant.from(now))).toBe(expired);
    });

    it.each([
        { now: '2026-09-30T12:05:00.123Z', expired: false },
        { now: '2026-09-30T12:05:00.1232Z', expired: false },
        { now: '2026-09-30T12:05:00.1235Z', expired: true },
        { now: '2026-09-30T12:05:00.1237Z', expired: true },
        { now: '2026-09-30T12:05:00.124Z', expired: true }
    ])(
        'expires a row whose instant is finer than its millisecond mirror at $now: $expired',
        ({ now, expired }) => {
            const stored = createStoredRow({ expiryTs: '2026-09-30T12:05:00.1235Z' });

            expect(isStoredQueueEntryExpired(stored, Temporal.Instant.from(now))).toBe(expired);
        }
    );

    it.each([
        { now: '2026-09-30T12:00:02.999Z', reservable: false },
        { now: '2026-09-30T12:00:03Z', reservable: false },
        { now: '2026-09-30T12:00:03.000000001Z', reservable: true },
        { now: '2026-09-30T12:00:03.001Z', reservable: true }
    ])('holds a retry row until its next attempt at $now: $reservable', ({ now, reservable }) => {
        const stored = createStoredRow({ nextTs: '2026-09-30T12:00:03.000000001Z' });

        expect(isStoredQueueEntryReservable({
            stored,
            typeIds: new Set(['WS_OUTBOX']),
            statusIds: new Set([EntityStatus.RETRY]),
            now: Temporal.Instant.from(now),
            maxAttempts: 3
        })).toBe(reservable);
    });

    it('compares expiry and the next attempt on the epoch-ms mirrors', () => {
        const stored = createStoredRow({ nextTs: '2026-09-30T12:00:03.000000001Z' });
        const now = Temporal.Instant.from('2026-09-30T12:00:04Z');

        expect(
            recordTemporalParses(() => {
                isStoredQueueEntryExpired(stored, now);
                isStoredQueueEntryReservable({
                    stored,
                    typeIds: new Set(['WS_OUTBOX']),
                    statusIds: new Set([EntityStatus.RETRY]),
                    now,
                    maxAttempts: 3
                });
            }),
            'a mirror in another millisecond than now decides the comparison without parsing the instant'
        ).toEqual(NO_TEMPORAL_PARSES);
    });
});

interface StoredRowTimestamps {
    readonly expiryTs?: string;
    readonly nextTs?: string;
}

function createStoredRow(timestamps: StoredRowTimestamps): StoredResourceEntry {
    const entry: ResourceEntry = {
        key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        resource: '{}',
        typeId: 'WS_OUTBOX',
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'entry-test',
            createdTs: Temporal.PlainDateTime.from('2026-09-30T12:00:00'),
            expiryTs: Temporal.Instant.from(timestamps.expiryTs ?? '2026-09-30T13:00:00Z')
        },
        status: EntityStatus.RETRY,
        dequeueAudit: {
            nextTs: timestamps.nextTs === undefined
                ? undefined
                : Temporal.Instant.from(timestamps.nextTs),
            attempts: 1
        }
    };
    return encodeStoredResourceEntry(entry, 0);
}
