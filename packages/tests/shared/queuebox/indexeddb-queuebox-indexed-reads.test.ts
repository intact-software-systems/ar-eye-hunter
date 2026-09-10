// @vitest-environment happy-dom

import 'fake-indexeddb/auto';

import { Temporal } from '@js-temporal/polyfill';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import {
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import * as indexedDbQueueBoxStoreModule from '@shared/queuebox/indexed-db-queue-box-store.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

const SEEDED_TYPES = ['seeded.type-a.v1', 'seeded.type-b.v1', 'seeded.type-c.v1'];
const SEEDED_STATUSES = [
    EntityStatus.NEW,
    EntityStatus.RETRY,
    EntityStatus.RESERVED,
    EntityStatus.FAILED,
    EntityStatus.COMPLETED
] as const;
const SEEDED_ENTRIES_PER_TYPE = 100;
// The sweep's own page size and per-run page budget; both are internal to the store module.
const CLEANUP_SWEEP_PAGE_SIZE = 256;
const CLEANUP_MAX_PAGES_PER_RUN = 8;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('IndexedDbQueueBox indexed reads', () => {
    it('reserveEntries for one type never returns another type and stays within the requested bound', async () => {
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-indexed-reads-reserve-${crypto.randomUUID()}`,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        await seedMixedTypeAndStatusEntries(queue);
        const maxToReserve = 5;

        const getAllSpy = vi.spyOn(IDBIndex.prototype, 'getAll');
        const storeGetAllSpy = vi.spyOn(IDBObjectStore.prototype, 'getAll');
        const reserved = await queue.reserveEntries({
            typeIds: new Set([SEEDED_TYPES[0]]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: maxToReserve
        });

        expect(reserved.size).toBe(maxToReserve);
        for (const entry of reserved.values()) {
            expect(entry.typeId).toBe(SEEDED_TYPES[0]);
        }
        expect(getAllSpy.mock.calls.length).toBeGreaterThan(0);
        for (const call of getAllSpy.mock.calls) {
            expect(call[1]).toBeLessThanOrEqual(maxToReserve);
        }
        // Any whole-store read would bypass the index range entirely.
        expect(storeGetAllSpy).not.toHaveBeenCalled();
    });

    it('cleanupAsync removes only expired rows and completed rows past retention', async () => {
        const now = Temporal.Now.instant();
        const sweptTypeId = 'cleanup.swept.v1';
        const retainedTypeId = 'cleanup.retained.v1';
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-indexed-reads-cleanup-${crypto.randomUUID()}`,
            observer: createPassThroughIndexedDbOperationObserver(),
            completedRetention: { typeIds: [retainedTypeId], topicIds: [] }
        });

        const expiredActive = createEntry(sweptTypeId, 'expired-active', {
            expiryTs: now.subtract({ seconds: 1 })
        });
        // Both expired and completed-and-unretained: proves cleanup does not double-delete it.
        const expiredCompleted = createEntry(sweptTypeId, 'expired-completed', {
            status: EntityStatus.COMPLETED,
            endTs: now.subtract({ minutes: 10 }),
            expiryTs: now.subtract({ seconds: 1 })
        });
        const completedNotRetained = createEntry(sweptTypeId, 'completed-not-retained', {
            status: EntityStatus.COMPLETED,
            endTs: now.subtract({ minutes: 10 })
        });
        const completedRetained = createEntry(retainedTypeId, 'completed-retained', {
            status: EntityStatus.COMPLETED,
            endTs: now.subtract({ minutes: 10 })
        });
        const activeNew = createEntry(sweptTypeId, 'active-new');
        const activeRetry = createEntry(sweptTypeId, 'active-retry', { status: EntityStatus.RETRY });

        for (
            const entry of [
                expiredActive,
                expiredCompleted,
                completedNotRetained,
                completedRetained,
                activeNew,
                activeRetry
            ]
        ) {
            await queue.enqueue(entry);
        }

        await expect(queue.cleanupAsync()).resolves.toMatchObject({ saturated: false });

        expect(await queue.getItem(expiredActive.key)).toBeUndefined();
        expect(await queue.getItem(expiredCompleted.key)).toBeUndefined();
        expect(await queue.getItem(completedNotRetained.key)).toBeUndefined();
        expect((await queue.getItem(completedRetained.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await queue.getItem(activeNew.key))?.status).toBe(EntityStatus.NEW);
        expect((await queue.getItem(activeRetry.key))?.status).toBe(EntityStatus.RETRY);
    });

    it('deletes a row that is both expired and terminal without rejecting the write', async () => {
        const now = Temporal.Now.instant();
        const typeId = 'cleanup.duplicate.v1';
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-indexed-reads-duplicate-${crypto.randomUUID()}`,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const expiredCompleted = createEntry(typeId, 'expired-completed', {
            status: EntityStatus.COMPLETED,
            endTs: now.subtract({ minutes: 10 }),
            expiryTs: now.subtract({ seconds: 1 })
        });
        await queue.enqueue(expiredCompleted);

        // The row is on both sweep lists; a second mutation for its key would reject the write.
        await expect(queue.cleanupAsync()).resolves.toMatchObject({ saturated: false });

        expect(await queue.getItem(expiredCompleted.key)).toBeUndefined();
    });

    it('pages past retained terminal rows so an unretained row still reaches the deletion budget', async () => {
        const now = Temporal.Now.instant();
        const retainedTopicId = 'retention.retained.v1';
        const sweptTypeId = 'retention.swept.v1';
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-indexed-reads-starvation-${crypto.randomUUID()}`,
            observer: createPassThroughIndexedDbOperationObserver(),
            completedRetention: { typeIds: [], topicIds: [retainedTopicId] }
        });
        const retained = createCompletedEntries(retainedTopicId, 300, {});
        const swept = createCompletedEntries(sweptTypeId, 10, {
            endTs: now.subtract({ minutes: 10 })
        });
        for (const entry of [...retained, ...swept]) {
            await queue.enqueue(entry);
        }

        await expect(queue.cleanupAsync()).resolves.toMatchObject({ saturated: false });

        const survivingKeys = await queue.getAllKeys();
        expect(survivingKeys).toHaveLength(retained.length);
        expect(survivingKeys.every((key) => key.topicId === retainedTopicId)).toBe(true);
    });

    it('bounds one cleanup run by its page budget', async () => {
        const now = Temporal.Now.instant();
        const retainedTopicId = 'page-budget.retained.v1';
        const sweptTypeId = 'page-budget.swept.v1';
        const storeName = IndexedDbQueueBox.DEFAULT_STORE_NAME;
        const connection = new IndexedDbConnection(async () =>
            await openIndexedDbWithStores(
                `indexeddb-indexed-reads-page-budget-${crypto.randomUUID()}`,
                [indexedDbQueueBoxStoreModule.toIndexedDbQueueStoreDefinition(storeName)]
            )
        );
        const queue = new IndexedDbQueueBox({
            connection,
            storeName,
            observer: createPassThroughIndexedDbOperationObserver(),
            completedRetention: { typeIds: [], topicIds: [retainedTopicId] }
        });
        // One row past the pages a single run may read, so only a ninth page would reach the sweepable row.
        const retained = createCompletedEntries(
            retainedTopicId,
            CLEANUP_SWEEP_PAGE_SIZE * CLEANUP_MAX_PAGES_PER_RUN + 1,
            {}
        );
        const swept = createCompletedEntries(sweptTypeId, 1, { endTs: now.subtract({ minutes: 10 }) });
        await writeRawQueueEntries(
            await connection.open(),
            storeName,
            [...retained, ...swept].map((entry) => encodeStoredResourceEntry(entry, 0))
        );

        const getAllSpy = vi.spyOn(IDBIndex.prototype, 'getAll');
        // A run that exhausts its page budget without deleting is not saturated: re-running it would
        // page from the same start and make no progress, so the bound is the sweep's own, not a loop's.
        await expect(queue.cleanupAsync()).resolves.toEqual({ deleted: 0, saturated: false });

        expect(await queue.getItem(swept[0].key)).toBeDefined();
        expect(getAllSpy.mock.calls.length).toBeLessThanOrEqual(CLEANUP_MAX_PAGES_PER_RUN + 1);
    });

    it('reserves a timed-out row that sorts after a live reservation', async () => {
        const now = Temporal.Now.instant();
        const typeId = 'timeout.lookahead.v1';
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-indexed-reads-timeout-${crypto.randomUUID()}`,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const live = createEntry(typeId, 'a-live', {
            status: EntityStatus.RESERVED,
            startTs: now,
            attempts: 1
        });
        const timedOut = createEntry(typeId, 'z-timed-out', {
            status: EntityStatus.RESERVED,
            startTs: now.subtract({ seconds: 30 }),
            attempts: 1
        });
        await queue.enqueue(live);
        await queue.enqueue(timedOut);

        const reclaimed = await queue.reserveTimeoutEntries({
            typeIds: new Set([typeId]),
            reservationInput: 1,
            timeSinceStartTs: Temporal.Duration.from({ seconds: 1 })
        });

        expect(reclaimed.size).toBe(1);
        expect(firstValue(reclaimed).key.resourceId).toBe('z-timed-out');
    });

    it('isAnyEntryToLock returns true when one RETRY row is due and false when none is', async () => {
        const typeId = 'probe.type.v1';
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-indexed-reads-probe-${crypto.randomUUID()}`,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const now = Temporal.Now.instant();
        const dueRetry = createEntry(typeId, 'due-retry', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 5 })
        });
        await queue.enqueue(dueRetry);

        await expect(
            queue.isAnyEntryToLock(new Set([typeId]), createWorkAdvertisementOptions())
        ).resolves.toBe(true);

        const reserved = await queue.reserveEntries({
            typeIds: new Set([typeId]),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: 1
        });
        await queue.releaseEntries([firstValue(reserved)], { status: EntityStatus.COMPLETED, delayMs: null });

        await expect(
            queue.isAnyEntryToLock(new Set([typeId]), createWorkAdvertisementOptions())
        ).resolves.toBe(false);
    });

    it('isAnyEntryToLock returns false for a RETRY row that is not yet due', async () => {
        const typeId = 'probe.not-due.v1';
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-indexed-reads-not-due-${crypto.randomUUID()}`,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        await queue.enqueue(createEntry(typeId, 'pending-retry', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: Temporal.Now.instant().add({ minutes: 5 })
        }));

        await expect(
            queue.isAnyEntryToLock(new Set([typeId]), createWorkAdvertisementOptions())
        ).resolves.toBe(false);
    });

    it('deletes the whole-store reader from the store module', () => {
        expect('readAllStoredQueueEntries' in indexedDbQueueBoxStoreModule).toBe(false);
    });
});

async function seedMixedTypeAndStatusEntries(queue: IndexedDbQueueBox): Promise<void> {
    const now = Temporal.Now.instant();
    const entries: ResourceEntry[] = [];
    for (const typeId of SEEDED_TYPES) {
        for (let index = 0; index < SEEDED_ENTRIES_PER_TYPE; index += 1) {
            const status = SEEDED_STATUSES[index % SEEDED_STATUSES.length];
            entries.push(createEntry(typeId, `${typeId}-${String(index).padStart(3, '0')}`, {
                status,
                nextTs: status === EntityStatus.RETRY ? now.subtract({ seconds: 60 }) : undefined,
                startTs: status === EntityStatus.RESERVED ? now.subtract({ seconds: 5 }) : undefined,
                endTs: status === EntityStatus.COMPLETED ? now.subtract({ seconds: 5 }) : undefined
            }));
        }
    }
    await Promise.all(entries.map((entry) => queue.enqueue(entry)));
}

/**
 * Completed rows for retention sweeps. Leaving endTs unset stamps endEpochMs 0, which is where the
 * ALM retention topics sit: at the very front of the terminal index range.
 */
function createCompletedEntries(
    typeId: string,
    count: number,
    options: { endTs?: Temporal.Instant; }
): ResourceEntry[] {
    return Array.from({ length: count }, (_unused, index) =>
        createEntry(typeId, `${typeId}-${String(index).padStart(5, '0')}`, {
            status: EntityStatus.COMPLETED,
            endTs: options.endTs
        }));
}

async function writeRawQueueEntries(
    database: IDBDatabase,
    storeName: string,
    stored: readonly StoredResourceEntry[]
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB raw queue write aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB raw queue write failed'));
        const store = transaction.objectStore(storeName);
        for (const row of stored) {
            store.put(row);
        }
    });
}

function createEntry(
    typeId: string,
    resourceId: string,
    options: Partial<{
        status: EntityStatus;
        startTs: Temporal.Instant;
        endTs: Temporal.Instant;
        nextTs: Temporal.Instant;
        attempts: number;
        resource: string;
        expiryTs: Temporal.Instant;
    }> = {}
): ResourceEntry {
    return {
        key: {
            topicId: typeId,
            resourceId,
            contextId: 'ctx-1'
        },
        resource: options.resource ?? JSON.stringify({ typeId, resourceId }),
        typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: options.expiryTs ?? NEVER_EXPIRE_TS
        },
        status: options.status ?? EntityStatus.NEW,
        dequeueAudit: {
            startTs: options.startTs,
            endTs: options.endTs,
            nextTs: options.nextTs,
            attempts: options.attempts ?? 0
        },
        db: undefined
    };
}

function firstValue<K, V>(map: Map<K, V>): V {
    const first = map.values().next().value;
    if (first === undefined) {
        throw new Error('Expected at least one map value');
    }
    return first;
}

function createWorkAdvertisementOptions() {
    return {
        checkTimeout: RateLimiter.init(60_000, 1),
        checkFairness: RateLimiter.init(60_000, 1),
        checkFinalization: RateLimiter.init(60_000, 1),
        maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        finalizationStaleAfterMs: 5 * 60 * 1000
    };
}
