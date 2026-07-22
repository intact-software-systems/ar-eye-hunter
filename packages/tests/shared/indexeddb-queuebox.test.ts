// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { IndexedDbQueueBox } from '@shared/queuebox/IndexedDbQueueBox.ts';
import { EntityStatus, NEVER_EXPIRE_TS, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';

describe('IndexedDbQueueBox', () => {
    it('returns the existing entry from enqueueIfAbsent without overwriting it', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const original = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 1 }),
        });
        const replacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 2 }),
        });

        expect(await queue.enqueueIfAbsent(original)).toBe(original);

        const existing = await queue.enqueueIfAbsent(replacement);
        expect(existing.resource).toBe(original.resource);

        const reserved = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.NEW]),
            1,
        );

        expect(firstValue(reserved).resource).toBe(original.resource);
    });

    it('uses enqueueIf predicate to decide whether active entries are overwritten', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const original = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 1 }),
        });
        const skippedReplacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 2 }),
        });
        const acceptedReplacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 3 }),
        });

        await queue.enqueueIfAbsent(original);

        const skip = vi.fn(() => false);
        const skippedPrevious = await queue.enqueueIf(skippedReplacement, skip);
        expect(skippedPrevious?.resource).toBe(original.resource);
        expect(skip).toHaveBeenCalledWith(
            expect.objectContaining({
                resource: original.resource,
            }),
        );
        expect((await queue.getItem(original.key))?.resource).toBe(original.resource);

        const overwrite = vi.fn(() => true);
        const overwrittenPrevious = await queue.enqueueIf(acceptedReplacement, overwrite);
        expect(overwrittenPrevious?.resource).toBe(original.resource);
        expect(overwrite).toHaveBeenCalledWith(
            expect.objectContaining({
                resource: original.resource,
            }),
        );
        expect((await queue.getItem(original.key))?.resource).toBe(acceptedReplacement.resource);
    });

    it('overwrites expired entries with enqueueIf without calling the predicate', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const expired = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 1 }),
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });
        const replacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 2 }),
        });
        const enqueueIt = vi.fn(() => false);

        await queue.enqueue(expired);

        expect(await queue.enqueueIf(replacement, enqueueIt)).toBeUndefined();
        expect(enqueueIt).not.toHaveBeenCalled();
        expect((await queue.getItem(expired.key))?.resource).toBe(replacement.resource);
    });

    it('persists entries across queue instances and supports reserve/release flow', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.message.v1';
        const entry = createEntry(typeId, 'msg-1');

        const writer = new IndexedDbQueueBox({ dbName });
        const reader = new IndexedDbQueueBox({ dbName });

        await writer.enqueueIfAbsent(entry);

        const reserved = await reader.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.NEW]),
            1,
        );

        expect(reserved.size).toBe(1);

        const reservedEntry = firstValue(reserved);
        expect(reservedEntry.status).toBe(EntityStatus.RESERVED);
        expect(reservedEntry.dequeueAudit.attempts).toBe(1);

        const released = await reader.releaseEntries([reservedEntry], {
            status: EntityStatus.COMPLETED,
            delayMs: null,
        });

        expect(firstValue(released).status).toBe(EntityStatus.COMPLETED);

        const hasWork = await writer.isAnyEntryToLock(
            new Set([typeId]),
            RateLimiter.init(60_000, 1),
            RateLimiter.init(60_000, 1),
        );

        expect(hasWork).toBe(false);
    });

    it('returns the previous entry from enqueue and overwrites the stored value', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.message.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const original = createEntry(typeId, 'msg-overwrite', {
            resource: JSON.stringify({ version: 1 }),
            status: EntityStatus.NEW,
            attempts: 0,
        });
        const replacement = createEntry(typeId, 'msg-overwrite', {
            resource: JSON.stringify({ version: 2 }),
            status: EntityStatus.FAILED,
            attempts: 3,
        });

        expect(await queue.enqueue(original)).toBeUndefined();

        const previous = await queue.enqueue(replacement);
        expect(previous?.resource).toBe(original.resource);
        expect(previous?.status).toBe(EntityStatus.NEW);

        const stored = await queue.getItem(original.key);
        expect(stored?.resource).toBe(replacement.resource);
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(stored?.dequeueAudit.attempts).toBe(3);
    });

    it('does not reserve retry entries before nextTs', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });

        await queue.enqueueIfAbsent(createEntry(typeId, 'msg-2'));

        const reserved = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.NEW]),
            1,
        );

        const retrying = await queue.releaseEntries(
            [firstValue(reserved)],
            { status: EntityStatus.RETRY, delayMs: 1_000 },
        );

        const retryEntry = firstValue(retrying);
        expect(retryEntry.dequeueAudit.nextTs).toBeDefined();
        expect(
            retryEntry.dequeueAudit.endTs
                ?.until(retryEntry.dequeueAudit.nextTs!)
                .total({ unit: 'milliseconds' }),
        ).toBe(1_000);
        expect((await queue.getItem(retryEntry.key))?.dequeueAudit.endTs?.toString())
            .toBe(retryEntry.dequeueAudit.endTs?.toString());
        expect((await queue.getItem(retryEntry.key))?.dequeueAudit.nextTs?.toString())
            .toBe(retryEntry.dequeueAudit.nextTs?.toString());

        const immediatelyReservable = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.RETRY]),
            1,
        );

        expect(immediatelyReservable.size).toBe(0);
    });

    it('rejects a stale release without overwriting a newer IndexedDB reservation', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const current = createEntry(typeId, 'stale-release', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 2,
        });
        await queue.enqueue(current);

        await expect(queue.releaseEntries([{
            ...current,
            dequeueAudit: { ...current.dequeueAudit, attempts: 1 },
        }], { status: EntityStatus.RETRY, delayMs: 1 })).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation',
        });

        expect(await queue.getItem(current.key)).toMatchObject({
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 2 },
        });
    });

    it('rolls back the whole IndexedDB release transaction when one reservation is stale', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const first = createEntry(typeId, 'batch-current', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 1,
        });
        const second = createEntry(typeId, 'batch-stale', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 2,
        });
        await queue.enqueue(first);
        await queue.enqueue(second);

        await expect(queue.releaseEntries([
            first,
            {
                ...second,
                dequeueAudit: { ...second.dequeueAudit, attempts: 1 },
            },
        ], { status: EntityStatus.COMPLETED, delayMs: null })).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation',
        });

        expect((await queue.getItem(first.key))?.status).toBe(EntityStatus.RESERVED);
        expect((await queue.getItem(second.key))?.dequeueAudit.attempts).toBe(2);
    });

    it.each([
        ['retry without delay', { status: EntityStatus.RETRY, delayMs: null }],
        ['retry with zero delay', { status: EntityStatus.RETRY, delayMs: 0 }],
        ['retry with fractional delay', { status: EntityStatus.RETRY, delayMs: 1.5 }],
        ['terminal with delay', { status: EntityStatus.COMPLETED, delayMs: 1 }],
        ['unsupported status', { status: EntityStatus.RESERVED, delayMs: null }],
    ] as const)('atomically rejects invalid IndexedDB release disposition: %s', async (
        _scenario,
        disposition,
    ) => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const first = createEntry(typeId, `invalid-first-${_scenario}`, {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 1,
        });
        const second = createEntry(typeId, `invalid-second-${_scenario}`, {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 1,
        });
        await queue.enqueue(first);
        await queue.enqueue(second);

        await expect(queue.releaseEntries([first, second], disposition as never))
            .rejects.toMatchObject({ code: 'resource-inbox-invalid-release-disposition' });

        expect((await queue.getItem(first.key))?.status).toBe(EntityStatus.RESERVED);
        expect((await queue.getItem(second.key))?.status).toBe(EntityStatus.RESERVED);
    });

    it('removes completed entries during cleanup while keeping active work', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.message.v1';
        const queue = new IndexedDbQueueBox({ dbName });

        await queue.enqueue(
            createEntry(typeId, 'completed-1', {
                status: EntityStatus.COMPLETED,
            }),
        );
        await queue.enqueue(createEntry(typeId, 'active-1'));

        expect(await queue.cleanupAsync()).toBe(true);

        const queueAfterCleanup = new IndexedDbQueueBox({ dbName });
        expect(await queueAfterCleanup.cleanupAsync()).toBe(false);

        const completed = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.COMPLETED]),
            10,
        );
        const active = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.NEW]),
            10,
        );

        expect(completed.size).toBe(0);
        expect(active.size).toBe(1);
    });

    it('lazy-evicts expired entries from reads and cleanup', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.message.v1';
        const queue = new IndexedDbQueueBox({ dbName });

        await queue.enqueue(
            createEntry(typeId, 'expired-1', {
                expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
            }),
        );

        expect(
            await queue.getItem({
                topicId: typeId,
                resourceId: 'expired-1',
                contextId: 'ctx-1',
            }),
        ).toBeUndefined();
        expect(await queue.deleteExpired()).toBe(0);
        expect(await queue.cleanupAsync()).toBe(false);
    });

    it('reclaims timed out reserved entries', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const oldStartTs = Temporal.Now.instant().subtract({ seconds: 30 });

        await queue.enqueue(
            createEntry(typeId, 'msg-3', {
                status: EntityStatus.RESERVED,
                startTs: oldStartTs,
                attempts: 1,
            }),
        );

        const reclaimed = await queue.reserveTimeoutEntries(
            new Set([typeId]),
            1,
            Temporal.Duration.from({ seconds: 1 }),
        );

        expect(reclaimed.size).toBe(1);

        const reclaimedEntry = firstValue(reclaimed);
        expect(reclaimedEntry.status).toBe(EntityStatus.RESERVED);
        expect(reclaimedEntry.dequeueAudit.attempts).toBe(2);
        expect(reclaimedEntry.dequeueAudit.startTs).toBeDefined();
        expect(
            Temporal.Instant.compare(reclaimedEntry.dequeueAudit.startTs!, oldStartTs),
        ).toBeGreaterThan(0);
    });

    it('does not report failed entries as automatic queue work', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });

        await queue.enqueue(
            createEntry(typeId, 'msg-failed', {
                status: EntityStatus.FAILED,
                attempts: 2,
            }),
        );

        const hasWork = await queue.isAnyEntryToLock(
            new Set([typeId]),
            RateLimiter.init(60_000, 1),
            RateLimiter.init(60_000, 1),
        );

        expect(hasWork).toBe(false);
    });

    it('uses a custom two-attempt IndexedDB reservation budget', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const exhausted = createEntry(typeId, 'attempt-3', {
            status: EntityStatus.RETRY,
            attempts: 2,
            nextTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });
        await queue.enqueue(exhausted);

        const reserved = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.RETRY]),
            { maxToReserve: 1, maxAttempts: 2 },
        );

        expect(reserved.size).toBe(0);
        expect((await queue.getItem(exhausted.key))?.dequeueAudit.attempts).toBe(2);
    });

    it.each([
        ['ordinary retry', {
            status: EntityStatus.RETRY,
            nextTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        }],
        ['timed out reservation', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant().subtract({ minutes: 10 }),
        }],
    ] as const)('does not advertise exhausted IndexedDB %s work', async (_lane, entryOptions) => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const exhausted = createEntry(typeId, `advertise-${_lane}`, {
            ...entryOptions,
            attempts: 2,
        });
        await queue.enqueue(exhausted);

        const advertised = await queue.isAnyEntryToLock(
            new Set([typeId]),
            {
                checkTimeout: RateLimiter.init(60_000, 1),
                checkFairness: RateLimiter.init(60_000, 1),
                maxAttempts: 2,
            } as never,
        );
        const reserved = entryOptions.status === EntityStatus.RETRY
            ? await queue.reserveEntries(
                new Set([typeId]),
                new Set([EntityStatus.RETRY]),
                { maxToReserve: 1, maxAttempts: 2 },
            )
            : await queue.reserveTimeoutEntries(
                new Set([typeId]),
                { maxToReserve: 1, maxAttempts: 2 },
                Temporal.Duration.from({ minutes: 5 }),
            );

        expect(advertised).toBe(false);
        expect(reserved.size).toBe(0);
    });

    it('does not reclaim an IndexedDB timeout beyond a custom attempt budget', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        await queue.enqueue(createEntry(typeId, 'timeout-attempt-3', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant().subtract({ minutes: 10 }),
            attempts: 2,
        }));

        const reclaimed = await queue.reserveTimeoutEntries(
            new Set([typeId]),
            { maxToReserve: 1, maxAttempts: 2 },
            Temporal.Duration.from({ minutes: 5 }),
        );

        expect(reclaimed.size).toBe(0);
    });

    it('orders IndexedDB fairness by oldest due timestamp before applying the batch limit', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const newer = createEntry(typeId, 'a-newer', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 31 }),
        });
        const older = createEntry(typeId, 'z-older', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 60 }),
        });
        await queue.enqueue(newer);
        await queue.enqueue(older);

        const selected = firstValue(await queue.reserveOverdueRetryEntries(
            new Set([typeId]),
            Number(now.epochMilliseconds) - 30_000,
            1,
        ));

        expect(selected.entry.key.resourceId).toBe('z-older');
        expect(selected.selectedDueTs.toString()).toBe(older.dequeueAudit.nextTs?.toString());
        expect(selected.entry.dequeueAudit.nextTs).toBeUndefined();
        expect((await queue.getItem(older.key))?.dequeueAudit.nextTs).toBeUndefined();
    });

    it('breaks equal IndexedDB fairness due timestamps by canonical key', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const dueTs = now.subtract({ seconds: 60 });
        const laterKey = createEntry(typeId, 'z-later-key', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: dueTs,
        });
        const earlierKey = createEntry(typeId, 'a-earlier-key', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: dueTs,
        });
        await queue.enqueue(laterKey);
        await queue.enqueue(earlierKey);

        const selected = firstValue(await queue.reserveOverdueRetryEntries(
            new Set([typeId]),
            Number(now.epochMilliseconds) - 30_000,
            1,
        ));

        expect(selected.entry.key.resourceId).toBe('a-earlier-key');
    });

    it('upgrades an existing queue store with the ordered fairness index', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        await createLegacyQueueDatabase(dbName);
        const queue = new IndexedDbQueueBox({ dbName });

        await queue.getAllKeys();

        const db = await openDatabase(dbName);
        const store = db.transaction(IndexedDbQueueBox.DEFAULT_STORE_NAME, 'readonly')
            .objectStore(IndexedDbQueueBox.DEFAULT_STORE_NAME);
        expect([...store.indexNames]).toContain(IndexedDbQueueBox.FAIRNESS_INDEX_NAME);
        expect(store.index(IndexedDbQueueBox.FAIRNESS_INDEX_NAME).keyPath).toEqual([
            'typeId',
            'status',
            'dequeueAudit.nextTs',
            'keyString',
        ]);
        expect(db.version).toBeGreaterThan(1);
        db.close();
    });

    it('bounds fairness cursor work while ignoring unrelated indexed ranges', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const requestedType = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        await Promise.all(
            Array.from({ length: 200 }, (_, index) => queue.enqueue(createEntry(
                'irrelevant.type.v1',
                `irrelevant-${index}`,
                {
                    status: EntityStatus.RETRY,
                    attempts: 1,
                    nextTs: now.subtract({ seconds: 1_000 + index }),
                },
            ))),
        );
        const exhaustedOldest = createEntry(requestedType, 'exhausted-oldest', {
            status: EntityStatus.RETRY,
            attempts: 2,
            nextTs: now.subtract({ seconds: 100 }),
        });
        const exhaustedSecond = createEntry(requestedType, 'exhausted-second', {
            status: EntityStatus.RETRY,
            attempts: 2,
            nextTs: now.subtract({ seconds: 90 }),
        });
        const validThird = createEntry(requestedType, 'valid-third', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 80 }),
        });
        await queue.enqueue(exhaustedOldest);
        await queue.enqueue(exhaustedSecond);
        await queue.enqueue(validThird);

        const bounded = await queue.reserveOverdueRetryEntries(
            new Set([requestedType]),
            Number(now.epochMilliseconds) - 30_000,
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 2 } as never,
        );
        const extended = await queue.reserveOverdueRetryEntries(
            new Set([requestedType]),
            Number(now.epochMilliseconds) - 30_000,
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 3 } as never,
        );

        expect(bounded.size).toBe(0);
        expect(firstValue(extended).entry.key.resourceId).toBe(validThird.key.resourceId);
    });

    it('merges ordered fairness cursors across requested types', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const newer = createEntry('type-a', 'newer', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 40 }),
        });
        const older = createEntry('type-b', 'older', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 60 }),
        });
        await queue.enqueue(newer);
        await queue.enqueue(older);

        const selected = firstValue(await queue.reserveOverdueRetryEntries(
            new Set([newer.typeId, older.typeId]),
            Number(now.epochMilliseconds) - 30_000,
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 8 } as never,
        ));

        expect(selected.entry.key.resourceId).toBe(older.key.resourceId);
    });
});

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
    }> = {},
): ResourceEntry {
    return {
        key: {
            topicId: typeId,
            resourceId,
            contextId: 'ctx-1',
        },
        resource: options.resource ?? JSON.stringify({ typeId, resourceId }),
        typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: options.expiryTs ?? NEVER_EXPIRE_TS,
        },
        status: options.status ?? EntityStatus.NEW,
        dequeueAudit: {
            startTs: options.startTs,
            endTs: options.endTs,
            nextTs: options.nextTs,
            attempts: options.attempts ?? 0,
        },
        db: undefined,
    };
}

function firstValue<K, V>(map: Map<K, V>): V {
    const first = map.values().next().value;
    if (first === undefined) {
        throw new Error('Expected at least one map value');
    }
    return first;
}

async function createLegacyQueueDatabase(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(IndexedDbQueueBox.DEFAULT_STORE_NAME, {
                keyPath: 'keyString',
            });
        };
        request.onsuccess = () => {
            request.result.close();
            resolve();
        };
        request.onerror = () => reject(request.error ?? new Error('Legacy DB open failed'));
    });
}

async function openDatabase(dbName: string): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('DB open failed'));
    });
}
