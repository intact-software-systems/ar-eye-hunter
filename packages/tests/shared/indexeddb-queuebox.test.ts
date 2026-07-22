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

        const released = await reader.releaseEntries([reservedEntry], EntityStatus.COMPLETED, null);

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
            EntityStatus.RETRY,
            1_000,
        );

        const retryEntry = firstValue(retrying);
        expect(retryEntry.dequeueAudit.nextTs).toBeDefined();
        expect(
            retryEntry.dequeueAudit.endTs
                ?.until(retryEntry.dequeueAudit.nextTs!)
                .total({ unit: 'milliseconds' }),
        ).toBe(1_000);

        const immediatelyReservable = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.RETRY]),
            1,
        );

        expect(immediatelyReservable.size).toBe(0);
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
});

function createEntry(
    typeId: string,
    resourceId: string,
    options: Partial<{
        status: EntityStatus;
        startTs: Temporal.Instant;
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
