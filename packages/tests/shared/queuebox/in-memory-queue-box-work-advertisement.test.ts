import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { EnqueuedType } from '@shared/api/api-config.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { ResourceInboxWorkAdvertisementOptions } from '@shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';

const TYPES = new Set([EnqueuedType.APP_INBOX]);
const NOTHING_ADVERTISED: DequeueController.WorkAdvertisement = {
    FINALIZATION: false,
    NEW: false,
    RETRY: false,
    FAIRNESS: false,
    TIMEOUT: false
};

describe('InMemoryQueueBox work advertisement', () => {
    it('reports no lane for an empty queue and the NEW lane alone for a new row', async () => {
        const now = Temporal.Now.instant();
        const queue = new InMemoryQueueBox(new Map(), () => now);
        const options = createWorkAdvertisementOptions();

        expect(await queue.readWorkAdvertisement(TYPES, options)).toEqual(NOTHING_ADVERTISED);
        await queue.enqueue(createEntry('new-row', { status: EntityStatus.NEW }));
        expect(await queue.readWorkAdvertisement(TYPES, options)).toEqual({ ...NOTHING_ADVERTISED, NEW: true });
        expect(await queue.isAnyEntryToLock(TYPES, options)).toBe(true);
    });

    it('reports a due retry on the RETRY lane, an overdue retry on the FAIRNESS lane too, and a retry not yet due on neither', async () => {
        const now = Temporal.Now.instant();
        const queue = new InMemoryQueueBox(new Map(), () => now);
        await queue.enqueue(createEntry('pending', { status: EntityStatus.RETRY, attempts: 1, nextTs: now.add({ minutes: 1 }) }));
        expect(await queue.readWorkAdvertisement(TYPES, createWorkAdvertisementOptions())).toEqual(NOTHING_ADVERTISED);

        await queue.enqueue(createEntry('due', { status: EntityStatus.RETRY, attempts: 1, nextTs: now.subtract({ seconds: 1 }) }));
        expect(await queue.readWorkAdvertisement(TYPES, createWorkAdvertisementOptions())).toEqual({ ...NOTHING_ADVERTISED, RETRY: true });

        await queue.enqueue(createEntry('overdue', { status: EntityStatus.RETRY, attempts: 1, nextTs: now.subtract({ seconds: 31 }) }));
        expect(await queue.readWorkAdvertisement(TYPES, createWorkAdvertisementOptions())).toEqual({
            ...NOTHING_ADVERTISED,
            RETRY: true,
            FAIRNESS: true
        });
    });

    it('reports a reservation past its lease on the TIMEOUT lane once per advertisement window', async () => {
        const now = Temporal.Now.instant();
        const queue = new InMemoryQueueBox(new Map(), () => now);
        await queue.enqueue(createEntry('abandoned', { status: EntityStatus.RESERVED, attempts: 1, startTs: now.subtract({ seconds: 61 }) }));
        const options = createWorkAdvertisementOptions({ reservationLeaseMs: 60_000 });

        expect(await queue.readWorkAdvertisement(TYPES, options)).toEqual({ ...NOTHING_ADVERTISED, TIMEOUT: true });
        expect(await queue.readWorkAdvertisement(TYPES, options)).toEqual(NOTHING_ADVERTISED);
        expect(await queue.isAnyEntryToLock(TYPES, options)).toBe(false);
    });

    it('reports a stale exhausted reservation on the FINALIZATION lane for AppInbox types once per window', async () => {
        const now = Temporal.Now.instant();
        const queue = new InMemoryQueueBox(new Map(), () => now);
        await queue.enqueue(createEntry('exhausted', {
            status: EntityStatus.RESERVED,
            attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            startTs: now.subtract({ minutes: 6 })
        }));
        const options = createWorkAdvertisementOptions({ reservationLeaseMs: 60_000 });

        expect(await queue.readWorkAdvertisement(TYPES, options)).toEqual({ ...NOTHING_ADVERTISED, FINALIZATION: true });
        expect(await queue.readWorkAdvertisement(TYPES, options)).toEqual(NOTHING_ADVERTISED);
        expect(await queue.readWorkAdvertisement(new Set([EnqueuedType.APP_OUTBOX]), createWorkAdvertisementOptions()))
            .toEqual(NOTHING_ADVERTISED);
    });
});

function createWorkAdvertisementOptions(
    overrides: Partial<Pick<ResourceInboxWorkAdvertisementOptions, 'reservationLeaseMs' | 'maxAttempts'>> = {}
): ResourceInboxWorkAdvertisementOptions {
    return {
        checkTimeout: RateLimiter.init(60_000, 1),
        checkFairness: RateLimiter.init(60_000, 1),
        checkFinalization: RateLimiter.init(60_000, 1),
        maxAttempts: overrides.maxAttempts ?? DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        finalizationStaleAfterMs: 5 * 60_000,
        reservationLeaseMs: overrides.reservationLeaseMs ?? 5 * 60_000,
        staleDueThresholdMs: 30_000
    };
}

function createEntry(
    resourceId: string,
    lifecycle: Readonly<{ status: EntityStatus; attempts?: number; nextTs?: Temporal.Instant; startTs?: Temporal.Instant; }>
): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2026-07-22T12:00:00');
    return {
        key: { topicId: 'app-inbox.test', resourceId, contextId: 'context-1' },
        resource: JSON.stringify({ resourceId }),
        typeId: EnqueuedType.APP_INBOX,
        status: lifecycle.status,
        audit: { date: createdTs.toPlainTime(), createdBy: 'test', createdTs, expiryTs: NEVER_EXPIRE_TS },
        dequeueAudit: { attempts: lifecycle.attempts ?? 0, nextTs: lifecycle.nextTs, startTs: lifecycle.startTs },
        db: undefined
    };
}
