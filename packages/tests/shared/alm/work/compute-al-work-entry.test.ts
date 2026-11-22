import { computeALWorkEntry } from '@shared/alm/work/compute-al-work-entry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

const key = { topicId: 'TOPIC', resourceId: 'resource', contextId: 'context' };

describe('computeALWorkEntry', () => {
    // Distinct observed, ready and expiry times pin that the row is due at its ready time, not when it was observed,
    // and that it expires at the given timestamp rather than at either of the other two.
    it('builds a new work row due at its ready time', () => {
        const entry = computeALWorkEntry({
            key,
            typeId: 'T',
            resource: 'r',
            observedAtMs: 1_000,
            readyAtMs: 6_000,
            expireAtTimestamp: 36_000
        });

        expect(entry).toMatchObject({
            key,
            typeId: 'T',
            resource: 'r',
            status: EntityStatus.NEW,
            db: undefined,
            dequeueAudit: { attempts: 0 },
            audit: { createdBy: 'ALM' }
        });
        expect(entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(6_000);
        expect(entry.audit.expiryTs.epochMilliseconds).toBe(36_000);
        expect(entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds).toBe(1_000);
    });
});
