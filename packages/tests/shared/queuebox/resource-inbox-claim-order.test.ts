import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { compareResourceEntriesByDue } from '@shared/queuebox/resource-inbox/resource-inbox-claim-order.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const NOW = Temporal.Instant.from('2026-11-18T12:00:00Z');

describe('compareResourceEntriesByDue', () => {
    it('orders dated rows by their next time', () => {
        const earlier = createEntry({ nextTs: NOW.subtract({ seconds: 10 }) });
        const later = createEntry({ nextTs: NOW.subtract({ seconds: 5 }) });

        expect([compareResourceEntriesByDue(earlier, later), compareResourceEntriesByDue(later, earlier)]).toEqual([-1, 1]);
    });

    it('places an undated row among dated rows by its creation instant', () => {
        const dated = createEntry({ nextTs: NOW.subtract({ seconds: 5 }) });
        const createdBefore = createEntry({ createdAt: NOW.subtract({ seconds: 10 }) });
        const createdAfter = createEntry({ createdAt: NOW });

        expect([compareResourceEntriesByDue(createdBefore, dated), compareResourceEntriesByDue(createdAfter, dated)]).toEqual([-1, 1]);
    });

    it('ties an undated row with a dated row due at its creation instant', () => {
        expect(compareResourceEntriesByDue(createEntry({ createdAt: NOW }), createEntry({ nextTs: NOW }))).toBe(0);
    });
});

function createEntry(input: Readonly<{ nextTs?: Temporal.Instant; createdAt?: Temporal.Instant; }>): ResourceEntry {
    const createdAt = (input.createdAt ?? NOW.subtract({ minutes: 1 })).toZonedDateTimeISO('UTC');
    return {
        key: { topicId: 'claim-order', resourceId: 'row', contextId: 'context' },
        resource: 'row',
        typeId: 'claim-order',
        audit: { date: createdAt.toPlainTime(), createdBy: 'test', createdTs: createdAt.toPlainDateTime(), expiryTs: NEVER_EXPIRE_TS },
        status: EntityStatus.NEW,
        dequeueAudit: { nextTs: input.nextTs, attempts: 0 },
        db: undefined
    };
}
