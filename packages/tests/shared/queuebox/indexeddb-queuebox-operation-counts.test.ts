// @vitest-environment happy-dom

import 'fake-indexeddb/auto';

import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

const TYPE_ID = 'counted.type.v1';
const FINALIZATION_OPTIONS = { processingAttempts: 20, maxToReserve: 1, staleAfterMs: 5 * 60 * 1000 };

// R-S3a-11: the observer counts the IndexedDB operations a call performs, not the calls. A volatile
// page's storage window (D55) reads zero only if a call that opens no transaction counts nothing.
// R-S3a-13: an operation that reads and changes nothing is a `work-probe`; one that writes is a `work-reserve`.
describe('IndexedDbQueueBox operation counts', () => {
    it.each([
        { name: 'an observed claim that observed nothing', observedEntries: [], reservationInput: 4 },
        { name: 'a claim for no entries', observedEntries: undefined, reservationInput: 0 }
    ])('counts nothing for $name, which opens no transaction', async ({ observedEntries, reservationInput }) => {
        const { queue, observer } = await createQueueWithOneNewEntry();

        await queue.reserveEntries({
            typeIds: new Set([TYPE_ID]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput,
            observedEntries
        });
        await queue.reserveTimeoutEntries({
            typeIds: new Set([TYPE_ID]),
            reservationInput,
            timeSinceStartTs: Temporal.Duration.from({ seconds: 30 }),
            observedEntries
        });
        await queue.reserveOverdueRetryEntries(new Set(), Date.now(), 4);

        expect(observer.getCounts()).toEqual({ total: 0, byOwner: { 'al-admission': 0, 'al-work': 0 }, byKind: {} });
    });

    it('still counts one work-reserve for a claim that reads storage', async () => {
        const { queue, observer } = await createQueueWithOneNewEntry();

        const reserved = await queue.reserveEntries({
            typeIds: new Set([TYPE_ID]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 4
        });

        expect(reserved.size).toBe(1);
        expect(observer.getCounts().byKind).toEqual({ 'work-reserve': 1 });
    });

    // R-S3a-13: a claim that reads storage and changes nothing is the durable owner's idle inspection.
    it('counts a claim, a timeout claim and a fairness scan that change nothing as work-probes', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const queue = new IndexedDbQueueBox({ dbName: `counted-empty-${crypto.randomUUID()}`, observer });

        const reserved = await queue.reserveEntries({
            typeIds: new Set([TYPE_ID]),
            statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
            reservationInput: 4
        });
        const timedOut = await queue.reserveTimeoutEntries({
            typeIds: new Set([TYPE_ID]),
            reservationInput: 4,
            timeSinceStartTs: Temporal.Duration.from({ seconds: 30 })
        });
        const overdue = await queue.reserveOverdueRetryEntries(new Set([TYPE_ID]), Date.now(), 4);

        expect([reserved.size, timedOut.size, overdue.size]).toEqual([0, 0, 0]);
        expect(observer.getCounts().byKind).toEqual({ 'work-probe': 3 });
    });

    it('counts an exhausted-retry finalization that finds nothing to finalize as a work-probe', async () => {
        const { queue, observer } = await createQueueWithOneNewEntry();

        const finalized = await queue.reserveRetryExhaustionFinalizations(new Set([TYPE_ID]), FINALIZATION_OPTIONS);

        expect(finalized.size).toBe(0);
        expect(observer.getCounts().byKind).toEqual({ 'work-probe': 1 });
    });

    it('counts an exhausted-retry finalization that writes as a work-reserve', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const queue = new IndexedDbQueueBox({ dbName: `counted-finalization-${crypto.randomUUID()}`, observer });
        await queue.enqueue(createEntry(EnqueuedType.APP_INBOX, {
            status: EntityStatus.RESERVED,
            attempts: FINALIZATION_OPTIONS.processingAttempts,
            startTs: Temporal.Now.instant().subtract({ minutes: 6 })
        }));
        observer.reset();

        const finalized = await queue.reserveRetryExhaustionFinalizations(
            new Set([EnqueuedType.APP_INBOX]),
            FINALIZATION_OPTIONS
        );

        expect(finalized.size).toBe(1);
        expect(observer.getCounts().byKind).toEqual({ 'work-reserve': 1 });
    });
});

async function createQueueWithOneNewEntry(): Promise<Readonly<{ queue: IndexedDbQueueBox; observer: CountingIndexedDbOperationObserver; }>> {
    const observer = createCountingIndexedDbOperationObserver();
    const queue = new IndexedDbQueueBox({ dbName: `counted-queue-${crypto.randomUUID()}`, observer });
    await queue.enqueue(createEntry(TYPE_ID, { status: EntityStatus.NEW, attempts: 0, startTs: undefined }));
    observer.reset();
    return { queue, observer };
}

function createEntry(
    typeId: string,
    dequeue: Readonly<{ status: EntityStatus; attempts: number; startTs: Temporal.Instant | undefined; }>
): ResourceEntry {
    return {
        key: { topicId: typeId, resourceId: 'counted', contextId: 'ctx-1' },
        resource: JSON.stringify({ typeId }),
        typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: dequeue.status,
        dequeueAudit: { startTs: dequeue.startTs, endTs: undefined, nextTs: undefined, attempts: dequeue.attempts },
        db: undefined
    };
}
