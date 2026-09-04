// @vitest-environment happy-dom

import '../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { encodeStoredResourceEntry } from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus, NEVER_EXPIRE_TS, ResourceEntry, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('IndexedDbQueueBox', () => {
    it('rejects a revisionless persisted row instead of retaining the legacy format', async () => {
        const dbName = `indexeddb-revisionless-row-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const original = createEntry('current.type', 'revisionless-row');
        await queue.enqueue(original);
        const database = await openQueueDatabase(dbName);
        try {
            await writeRawQueueEntry(database, withoutRevision(encodeStoredResourceEntry(original, 0)));
        }
        finally {
            database.close();
        }

        await expect(queue.getItem(original.key)).rejects.toThrow('IndexedDB queue row fields are invalid');
    });

    it('rejects a persisted row with no expiry instead of inventing one', async () => {
        const dbName = `indexeddb-corrupt-row-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const entry = createEntry('corrupt.type', 'missing-expiry');
        await queue.enqueue(entry);
        const database = await openQueueDatabase(dbName);
        try {
            const stored = encodeStoredResourceEntry(entry, 0);
            await writeRawQueueEntry(database, {
                ...stored,
                audit: {
                    date: stored.audit.date,
                    createdBy: stored.audit.createdBy,
                    createdTs: stored.audit.createdTs
                }
            });
        }
        finally {
            database.close();
        }

        await expect(queue.getItem(entry.key)).rejects.toThrow();
    });

    it('returns the existing entry from enqueueIfAbsent without overwriting it', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const original = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 1 })
        });
        const replacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 2 })
        });

        expect(await queue.enqueueIfAbsent(original)).toBe(original);

        const existing = await queue.enqueueIfAbsent(replacement);
        expect(existing.resource).toBe(original.resource);

        const reserved = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.NEW]),
            1
        );

        expect(firstValue(reserved).resource).toBe(original.resource);
    });

    it('uses enqueueIf predicate to decide whether active entries are overwritten', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const original = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 1 })
        });
        const skippedReplacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 2 })
        });
        const acceptedReplacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 3 })
        });

        await queue.enqueueIfAbsent(original);

        const skip = vi.fn(() => false);
        const skippedPrevious = await queue.enqueueIf(skippedReplacement, skip);
        expect(skippedPrevious?.resource).toBe(original.resource);
        expect(skip).toHaveBeenCalledWith(
            expect.objectContaining({
                resource: original.resource
            })
        );
        expect((await queue.getItem(original.key))?.resource).toBe(original.resource);

        const overwrite = vi.fn(() => true);
        const overwrittenPrevious = await queue.enqueueIf(acceptedReplacement, overwrite);
        expect(overwrittenPrevious?.resource).toBe(original.resource);
        expect(overwrite).toHaveBeenCalledWith(
            expect.objectContaining({
                resource: original.resource
            })
        );
        expect((await queue.getItem(original.key))?.resource).toBe(acceptedReplacement.resource);
    });

    it('computes an enqueueIf replacement before opening its write transaction', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const original = createEntry('presence.state.v1', 'prepared-write', {
            resource: JSON.stringify({ version: 1 })
        });
        const replacement = createEntry('presence.state.v1', 'prepared-write', {
            resource: JSON.stringify({ version: 2 })
        });
        await queue.enqueue(original);

        const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
        await queue.enqueueIf(replacement, () => {
            expect(transaction.mock.calls.some((call) => call[1] === 'readwrite')).toBe(false);
            return true;
        });

        expect(transaction.mock.calls.some((call) => call[1] === 'readonly')).toBe(true);
        expect(transaction.mock.calls.some((call) => call[1] === 'readwrite')).toBe(true);
    });

    it('overwrites expired entries with enqueueIf without calling the predicate', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'presence.state.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const expired = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 1 }),
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });
        const replacement = createEntry(typeId, 'resource-1', {
            resource: JSON.stringify({ version: 2 })
        });
        let predicateVisited = false;
        const enqueueIt = () => {
            predicateVisited = true;
            return false;
        };

        await queue.enqueue(expired);

        expect(await queue.enqueueIf(replacement, enqueueIt)).toBeUndefined();
        expect(predicateVisited).toBe(false);
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
            1
        );

        expect(reserved.size).toBe(1);

        const reservedEntry = firstValue(reserved);
        expect(reservedEntry.status).toBe(EntityStatus.RESERVED);
        expect(reservedEntry.dequeueAudit.attempts).toBe(1);

        const released = await reader.releaseEntries([reservedEntry], {
            status: EntityStatus.COMPLETED,
            delayMs: null
        });

        expect(firstValue(released).status).toBe(EntityStatus.COMPLETED);

        const hasWork = await writer.isAnyEntryToLock(
            new Set([typeId]),
            createWorkAdvertisementOptions()
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
            attempts: 0
        });
        const replacement = createEntry(typeId, 'msg-overwrite', {
            resource: JSON.stringify({ version: 2 }),
            status: EntityStatus.FAILED,
            attempts: 3
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

    it('reclaims a stale exhausted AppInbox reservation as a new finalization generation', async () => {
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-finalization-${crypto.randomUUID()}`
        });
        const exhausted = createEntry(EnqueuedType.APP_INBOX, 'recover-exhaustion', {
            status: EntityStatus.RESERVED,
            attempts: 20,
            startTs: Temporal.Now.instant().subtract({ minutes: 6 })
        });
        await queue.enqueue(exhausted);

        const recovered = await queue.reserveRetryExhaustionFinalizations(
            new Set([EnqueuedType.APP_INBOX]),
            {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 5 * 60 * 1000
            }
        );

        expect(firstValue(recovered)).toMatchObject({
            entry: {
                key: exhausted.key,
                status: EntityStatus.RESERVED,
                dequeueAudit: { attempts: 21 }
            },
            selectedDueTs: exhausted.dequeueAudit.startTs
        });
        expect((await queue.getItem(exhausted.key))?.dequeueAudit.attempts).toBe(21);
    });

    it('skips poison finalization generations and reserves the valid cursor sibling', async () => {
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-finalization-poison-${crypto.randomUUID()}`
        });
        const staleStart = Temporal.Now.instant().subtract({ minutes: 6 });
        const poison = createEntry(EnqueuedType.APP_INBOX, '000-overflow', {
            status: EntityStatus.RESERVED,
            attempts: Number.MAX_SAFE_INTEGER,
            startTs: staleStart
        });
        const valid = createEntry(EnqueuedType.APP_INBOX, 'zzz-valid', {
            status: EntityStatus.RESERVED,
            attempts: 20,
            startTs: staleStart
        });
        await queue.enqueue(poison);
        await queue.enqueue(valid);

        const selected = await queue.reserveRetryExhaustionFinalizations(
            new Set([EnqueuedType.APP_INBOX]),
            {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 5 * 60 * 1000
            }
        );

        expect(firstValue(selected).entry).toMatchObject({
            key: valid.key,
            dequeueAudit: { attempts: 21 }
        });
        expect((await queue.getItem(poison.key))?.dequeueAudit.attempts)
            .toBe(Number.MAX_SAFE_INTEGER);
    });

    it('does not advertise IndexedDB finalization work for poison generations alone', async () => {
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-finalization-advertisement-${crypto.randomUUID()}`
        });
        await queue.enqueue(createEntry(EnqueuedType.APP_INBOX, 'overflow-only', {
            status: EntityStatus.RESERVED,
            attempts: Number.MAX_SAFE_INTEGER,
            startTs: Temporal.Now.instant().subtract({ minutes: 6 })
        }));

        await expect(queue.isAnyEntryToLock(
            new Set([EnqueuedType.APP_INBOX]),
            {
                checkTimeout: RateLimiter.init(60_000, 1),
                checkFairness: RateLimiter.init(60_000, 1),
                checkFinalization: RateLimiter.init(60_000, 1),
                maxAttempts: 20,
                finalizationStaleAfterMs: 5 * 60 * 1000
            }
        )).resolves.toBe(false);
    });

    it('does not reserve retry entries before nextTs', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });

        await queue.enqueueIfAbsent(createEntry(typeId, 'msg-2'));

        const reserved = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.NEW]),
            1
        );

        const retrying = await queue.releaseEntries(
            [firstValue(reserved)],
            { status: EntityStatus.RETRY, delayMs: 1_000 }
        );

        const retryEntry = firstValue(retrying);
        expect(retryEntry.dequeueAudit.nextTs).toBeDefined();
        expect(
            retryEntry.dequeueAudit.endTs
                ?.until(retryEntry.dequeueAudit.nextTs!)
                .total({ unit: 'milliseconds' })
        ).toBe(1_000);
        expect((await queue.getItem(retryEntry.key))?.dequeueAudit.endTs?.toString())
            .toBe(retryEntry.dequeueAudit.endTs?.toString());
        expect((await queue.getItem(retryEntry.key))?.dequeueAudit.nextTs?.toString())
            .toBe(retryEntry.dequeueAudit.nextTs?.toString());

        const immediatelyReservable = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.RETRY]),
            1
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
            attempts: 2
        });
        await queue.enqueue(current);

        await expect(queue.releaseEntries([{
            ...current,
            dequeueAudit: { ...current.dequeueAudit, attempts: 1 }
        }], { status: EntityStatus.RETRY, delayMs: 1 })).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation'
        });

        expect(await queue.getItem(current.key)).toMatchObject({
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 2 }
        });
    });

    it('treats the exact already-completed AppInbox reservation as an idempotent IndexedDB success release', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const reserved = createEntry(EnqueuedType.APP_INBOX, 'atomic-success', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 7
        });
        await queue.enqueue({ ...reserved, status: EntityStatus.COMPLETED });

        const released = await queue.releaseEntries(
            [reserved],
            { status: EntityStatus.COMPLETED, delayMs: null }
        );

        expect(firstValue(released)).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 7 }
        });
        await expect(queue.releaseEntries(
            [{ ...reserved, dequeueAudit: { ...reserved.dequeueAudit, attempts: 6 } }],
            { status: EntityStatus.COMPLETED, delayMs: null }
        )).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        await expect(queue.releaseEntries(
            [reserved],
            { status: EntityStatus.FAILED, delayMs: null }
        )).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
    });

    it('rolls back the whole IndexedDB release transaction when one reservation is stale', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const first = createEntry(typeId, 'batch-current', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 1
        });
        const second = createEntry(typeId, 'batch-stale', {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 2
        });
        await queue.enqueue(first);
        await queue.enqueue(second);

        await expect(queue.releaseEntries([
            first,
            {
                ...second,
                dequeueAudit: { ...second.dequeueAudit, attempts: 1 }
            }
        ], { status: EntityStatus.COMPLETED, delayMs: null })).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation'
        });

        expect((await queue.getItem(first.key))?.status).toBe(EntityStatus.RESERVED);
        expect((await queue.getItem(second.key))?.dequeueAudit.attempts).toBe(2);
    });

    it.each(
        [
            ['retry without delay', { status: EntityStatus.RETRY, delayMs: null }],
            ['retry with zero delay', { status: EntityStatus.RETRY, delayMs: 0 }],
            ['retry with fractional delay', { status: EntityStatus.RETRY, delayMs: 1.5 }],
            ['terminal with delay', { status: EntityStatus.COMPLETED, delayMs: 1 }],
            ['unsupported status', { status: EntityStatus.RESERVED, delayMs: null }]
        ] as const
    )('atomically rejects invalid IndexedDB release disposition: %s', async (
        _scenario,
        disposition
    ) => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const first = createEntry(typeId, `invalid-first-${_scenario}`, {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 1
        });
        const second = createEntry(typeId, `invalid-second-${_scenario}`, {
            status: EntityStatus.RESERVED,
            startTs: Temporal.Now.instant(),
            attempts: 1
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
                status: EntityStatus.COMPLETED
            })
        );
        await queue.enqueue(createEntry(typeId, 'active-1'));

        expect(await queue.cleanupAsync()).toBe(true);

        const queueAfterCleanup = new IndexedDbQueueBox({ dbName });
        expect(await queueAfterCleanup.cleanupAsync()).toBe(false);

        const completed = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.COMPLETED]),
            10
        );
        const active = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.NEW]),
            10
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
                expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
            })
        );

        expect(
            await queue.getItem({
                topicId: typeId,
                resourceId: 'expired-1',
                contextId: 'ctx-1'
            })
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
                attempts: 1
            })
        );

        const reclaimed = await queue.reserveTimeoutEntries(
            new Set([typeId]),
            1,
            Temporal.Duration.from({ seconds: 1 })
        );

        expect(reclaimed.size).toBe(1);

        const reclaimedEntry = firstValue(reclaimed);
        expect(reclaimedEntry.status).toBe(EntityStatus.RESERVED);
        expect(reclaimedEntry.dequeueAudit.attempts).toBe(2);
        expect(reclaimedEntry.dequeueAudit.startTs).toBeDefined();
        expect(
            Temporal.Instant.compare(reclaimedEntry.dequeueAudit.startTs!, oldStartTs)
        ).toBeGreaterThan(0);
    });

    it('does not report failed entries as automatic queue work', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });

        await queue.enqueue(
            createEntry(typeId, 'msg-failed', {
                status: EntityStatus.FAILED,
                attempts: 2
            })
        );

        const hasWork = await queue.isAnyEntryToLock(
            new Set([typeId]),
            createWorkAdvertisementOptions()
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
            nextTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });
        await queue.enqueue(exhausted);

        const reserved = await queue.reserveEntries(
            new Set([typeId]),
            new Set([EntityStatus.RETRY]),
            { maxToReserve: 1, maxAttempts: 2 }
        );

        expect(reserved.size).toBe(0);
        expect((await queue.getItem(exhausted.key))?.dequeueAudit.attempts).toBe(2);
    });

    it.each(
        [
            ['ordinary retry', {
                status: EntityStatus.RETRY,
                nextTs: Temporal.Now.instant().subtract({ seconds: 1 })
            }],
            ['timed out reservation', {
                status: EntityStatus.RESERVED,
                startTs: Temporal.Now.instant().subtract({ minutes: 10 })
            }]
        ] as const
    )('does not advertise exhausted IndexedDB %s work', async (_lane, entryOptions) => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const typeId = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const exhausted = createEntry(typeId, `advertise-${_lane}`, {
            ...entryOptions,
            attempts: 2
        });
        await queue.enqueue(exhausted);

        const advertised = await queue.isAnyEntryToLock(
            new Set([typeId]),
            {
                checkTimeout: RateLimiter.init(60_000, 1),
                checkFairness: RateLimiter.init(60_000, 1),
                checkFinalization: RateLimiter.init(60_000, 1),
                maxAttempts: 2,
                finalizationStaleAfterMs: 5 * 60 * 1000
            } as never
        );
        const reserved = entryOptions.status === EntityStatus.RETRY
            ? await queue.reserveEntries(
                new Set([typeId]),
                new Set([EntityStatus.RETRY]),
                { maxToReserve: 1, maxAttempts: 2 }
            )
            : await queue.reserveTimeoutEntries(
                new Set([typeId]),
                { maxToReserve: 1, maxAttempts: 2 },
                Temporal.Duration.from({ minutes: 5 })
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
            attempts: 2
        }));

        const reclaimed = await queue.reserveTimeoutEntries(
            new Set([typeId]),
            { maxToReserve: 1, maxAttempts: 2 },
            Temporal.Duration.from({ minutes: 5 })
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
            nextTs: now.subtract({ seconds: 31 })
        });
        const older = createEntry(typeId, 'z-older', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 60 })
        });
        await queue.enqueue(newer);
        await queue.enqueue(older);

        const selected = firstValue(
            await queue.reserveOverdueRetryEntries(
                new Set([typeId]),
                Number(now.epochMilliseconds) - 30_000,
                1
            )
        );

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
            nextTs: dueTs
        });
        const earlierKey = createEntry(typeId, 'a-earlier-key', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: dueTs
        });
        await queue.enqueue(laterKey);
        await queue.enqueue(earlierKey);

        const selected = firstValue(
            await queue.reserveOverdueRetryEntries(
                new Set([typeId]),
                Number(now.epochMilliseconds) - 30_000,
                1
            )
        );

        expect(selected.entry.key.resourceId).toBe('a-earlier-key');
    });

    it('validates an empty fairness scan budget before opening IndexedDB cursors', async () => {
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-queue-${crypto.randomUUID()}`
        });
        let cursorOpened = false;
        const openCursorImplementation = IDBIndex.prototype.openCursor;
        const openCursor = vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (
            this: IDBIndex,
            ...args: Parameters<IDBIndex['openCursor']>
        ) {
            cursorOpened = true;
            return Reflect.apply(openCursorImplementation, this, args);
        });

        await expect(queue.reserveOverdueRetryEntries(
            new Set(['type-a']),
            Date.now(),
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 0 }
        )).rejects.toThrow(/at least the number of requested types/u);
        expect(cursorOpened).toBe(false);
        openCursor.mockRestore();
    });

    it('requires enough fairness scan budget for every requested type head', async () => {
        const queue = new IndexedDbQueueBox({
            dbName: `indexeddb-queue-${crypto.randomUUID()}`
        });

        await expect(queue.reserveOverdueRetryEntries(
            new Set(['type-a', 'type-b', 'type-c']),
            Date.now(),
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 2 }
        )).rejects.toThrow(/at least the number of requested types/u);
    });

    it('expands a numeric fairness budget to cover every requested type', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const types = new Set(Array.from({ length: 9 }, (_, index) => `type-${index}`));
        const entry = createEntry('type-8', 'numeric-budget-entry', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ minutes: 1 })
        });
        await queue.enqueue(entry);

        const selected = firstValue(
            await queue.reserveOverdueRetryEntries(
                types,
                Number(now.epochMilliseconds),
                1
            )
        );

        expect(selected.entry.key.resourceId).toBe(entry.key.resourceId);
    });

    it('charges each requested type head against the global fairness scan budget', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const exhausted = createEntry('type-a', 'exhausted-head', {
            status: EntityStatus.RETRY,
            attempts: 2,
            nextTs: now.subtract({ seconds: 100 })
        });
        const hiddenBehindHead = createEntry('type-a', 'hidden-behind-head', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 90 })
        });
        const visibleTypeB = createEntry('type-b', 'visible-type-b', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 80 })
        });
        const visibleTypeC = createEntry('type-c', 'visible-type-c', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 70 })
        });
        await queue.enqueue(exhausted);
        await queue.enqueue(hiddenBehindHead);
        await queue.enqueue(visibleTypeB);
        await queue.enqueue(visibleTypeC);

        const selected = firstValue(
            await queue.reserveOverdueRetryEntries(
                new Set(['type-a', 'type-b', 'type-c']),
                Number(now.epochMilliseconds),
                { maxToReserve: 1, maxAttempts: 2, maxToScan: 3 }
            )
        );

        expect(selected.entry.key.resourceId).toBe(visibleTypeB.key.resourceId);
    });

    it('bounds fairness cursor work while ignoring unrelated indexed ranges', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const requestedType = 'chat.private-text.v1';
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        await Promise.all(
            Array.from({ length: 200 }, (_, index) =>
                queue.enqueue(createEntry(
                    'irrelevant.type.v1',
                    `irrelevant-${index}`,
                    {
                        status: EntityStatus.RETRY,
                        attempts: 1,
                        nextTs: now.subtract({ seconds: 1_000 + index })
                    }
                )))
        );
        const exhaustedOldest = createEntry(requestedType, 'exhausted-oldest', {
            status: EntityStatus.RETRY,
            attempts: 2,
            nextTs: now.subtract({ seconds: 100 })
        });
        const exhaustedSecond = createEntry(requestedType, 'exhausted-second', {
            status: EntityStatus.RETRY,
            attempts: 2,
            nextTs: now.subtract({ seconds: 90 })
        });
        const validThird = createEntry(requestedType, 'valid-third', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 80 })
        });
        await queue.enqueue(exhaustedOldest);
        await queue.enqueue(exhaustedSecond);
        await queue.enqueue(validThird);

        const bounded = await queue.reserveOverdueRetryEntries(
            new Set([requestedType]),
            Number(now.epochMilliseconds) - 30_000,
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 2 } as never
        );
        const extended = await queue.reserveOverdueRetryEntries(
            new Set([requestedType]),
            Number(now.epochMilliseconds) - 30_000,
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 3 } as never
        );

        expect(bounded.size).toBe(0);
        expect(firstValue(extended).entry.key.resourceId).toBe(validThird.key.resourceId);
    });

    it('bounds requested fairness rows by the global scan budget across types', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const typeIds = ['type-a', 'type-b', 'type-c', 'type-d', 'type-e'];
        for (const [typeOffset, typeId] of typeIds.entries()) {
            for (let entryOffset = 0; entryOffset < 4; entryOffset += 1) {
                await queue.enqueue(createEntry(typeId, `${typeId}-${entryOffset}`, {
                    status: EntityStatus.RETRY,
                    attempts: 2,
                    nextTs: now.subtract({ seconds: 100 - typeOffset - entryOffset })
                }));
            }
        }
        const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

        await queue.reserveOverdueRetryEntries(
            new Set(typeIds),
            Number(now.epochMilliseconds),
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 7 }
        );

        const requestedRows = indexedReads.mock.calls.reduce(
            (total, call) => total + (call[1] ?? 0),
            0
        );
        expect(requestedRows).toBe(7);
    });

    it('merges ordered fairness cursors across requested types', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const newer = createEntry('type-a', 'newer', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 40 })
        });
        const older = createEntry('type-b', 'older', {
            status: EntityStatus.RETRY,
            attempts: 1,
            nextTs: now.subtract({ seconds: 60 })
        });
        await queue.enqueue(newer);
        await queue.enqueue(older);

        const selected = firstValue(
            await queue.reserveOverdueRetryEntries(
                new Set([newer.typeId, older.typeId]),
                Number(now.epochMilliseconds) - 30_000,
                { maxToReserve: 1, maxAttempts: 2, maxToScan: 8 } as never
            )
        );

        expect(selected.entry.key.resourceId).toBe(older.key.resourceId);
    });

    it('uses IndexedDB key ordering for mixed equal-due keys across types', async () => {
        const dbName = `indexeddb-queue-${crypto.randomUUID()}`;
        const queue = new IndexedDbQueueBox({ dbName });
        const now = Temporal.Now.instant();
        const dueTs = now.subtract({ minutes: 1 });
        const entries = ['A', 'a', 'é', '!', '_', '~'].map((typeId) =>
            createEntry(typeId, `resource-${typeId}`, {
                status: EntityStatus.RETRY,
                attempts: 1,
                nextTs: dueTs
            })
        );
        for (const entry of entries) {
            await queue.enqueue(entry);
        }
        const expected = [...entries].sort((left, right) =>
            indexedDB.cmp(
                toKeyAsString(left.key),
                toKeyAsString(right.key)
            )
        )[0];

        const selected = firstValue(
            await queue.reserveOverdueRetryEntries(
                new Set(entries.map((entry) => entry.typeId)),
                Number(now.epochMilliseconds),
                { maxToReserve: 1, maxAttempts: 2, maxToScan: entries.length }
            )
        );

        expect(selected.entry.key.resourceId).toBe(expected.key.resourceId);
    });
});

function withoutRevision(
    stored: ReturnType<typeof encodeStoredResourceEntry>
): Omit<ReturnType<typeof encodeStoredResourceEntry>, 'revision'> {
    const { revision: _revision, ...revisionless } = stored;
    return revisionless;
}

async function openQueueDatabase(dbName: string): Promise<IDBDatabase> {
    return await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB queue open failed'));
    });
}

async function writeRawQueueEntry(
    database: IDBDatabase,
    stored: object
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(
            IndexedDbQueueBox.DEFAULT_STORE_NAME,
            'readwrite'
        );
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB raw queue write aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB raw queue write failed'));
        transaction.objectStore(IndexedDbQueueBox.DEFAULT_STORE_NAME).put(stored);
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
