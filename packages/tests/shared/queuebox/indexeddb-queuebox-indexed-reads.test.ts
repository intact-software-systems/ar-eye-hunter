// @vitest-environment happy-dom

import 'fake-indexeddb/auto';

import { Temporal } from '@js-temporal/polyfill';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
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

        await expect(queue.cleanupAsync()).resolves.toBe(true);

        expect(await queue.getItem(expiredActive.key)).toBeUndefined();
        expect(await queue.getItem(expiredCompleted.key)).toBeUndefined();
        expect(await queue.getItem(completedNotRetained.key)).toBeUndefined();
        expect((await queue.getItem(completedRetained.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await queue.getItem(activeNew.key))?.status).toBe(EntityStatus.NEW);
        expect((await queue.getItem(activeRetry.key))?.status).toBe(EntityStatus.RETRY);
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
