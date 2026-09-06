import '../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toIndexedDbQueueStoreDefinition } from '@shared/queuebox/indexed-db-queue-box-store.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, NEVER_EXPIRE_TS, toKeyAsString, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createPSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

describe.each(['memory', 'indexeddb', 'pglite'] as const)('%s observed QueueBox reservation', (storage) => {
    it('claims only selected unchanged work without consuming stale or omitted attempts', async () => {
        const queue = await createQueue(storage);
        const stale = createEntry('first-stale');
        const eligible = createEntry('second-eligible');
        const waiting = createEntry('third-waiting');
        for (const entry of [stale, eligible, waiting]) {
            await queue.enqueue(entry);
        }
        const observations = [
            (await queue.getItem(stale.key))!,
            (await queue.getItem(eligible.key))!
        ];
        const before = observations.map((entry) => ({ ...entry, dequeueAudit: { ...entry.dequeueAudit } }));
        await queue.replaceIfObserved(observations[0], { ...observations[0], resource: 'replacement' });

        const claimed = await queue.reserveEntries(new Set(['ordered-work']), new Set([EntityStatus.NEW]), 1, observations);

        expect([...claimed.values()]).toMatchObject([{
            key: eligible.key,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1 }
        }]);
        expect(observations).toEqual(before);
        expect(await queue.getItem(stale.key)).toMatchObject({ resource: 'replacement', dequeueAudit: { attempts: 0 } });
        expect(await queue.getItem(waiting.key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
        expect(await queue.reserveEntries(new Set(['ordered-work']), new Set([EntityStatus.NEW]), 10, [])).toEqual(new Map());
    });

    it('reclaims only unchanged selected timed-out reservations', async () => {
        const queue = await createQueue(storage);
        const oldStart = Temporal.Instant.from('2026-01-02T00:00:00Z');
        const stale: ResourceEntry = {
            ...createEntry('first-stale'),
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1, startTs: oldStart }
        };
        const eligible = { ...stale, key: { ...stale.key, resourceId: 'second-eligible' } };
        const waiting = { ...stale, key: { ...stale.key, resourceId: 'third-waiting' } };
        for (const entry of [stale, eligible, waiting]) {
            await queue.enqueue(entry);
        }
        const observations = [(await queue.getItem(stale.key))!, (await queue.getItem(eligible.key))!];
        await queue.replaceIfObserved(observations[0], { ...observations[0], resource: 'replacement' });

        const claimed = await queue.reserveTimeoutEntries(
            new Set(['ordered-work']),
            1,
            Temporal.Duration.from({ seconds: 10 }),
            observations
        );

        expect([...claimed.values()]).toMatchObject([{
            key: eligible.key,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 2 }
        }]);
        expect(await queue.getItem(stale.key)).toMatchObject({ resource: 'replacement', dequeueAudit: { attempts: 1 } });
        expect(await queue.getItem(waiting.key)).toMatchObject({ dequeueAudit: { attempts: 1 } });
        expect(await queue.reserveTimeoutEntries(new Set(['ordered-work']), 10, Temporal.Duration.from({ seconds: 10 }), []))
            .toEqual(new Map());
    });

    it('captures observations before asynchronous work and claims a repeated selection once', async () => {
        const queue = await createQueue(storage);
        const entry = createEntry('selected');
        await queue.enqueue(entry);
        const observed = (await queue.getItem(entry.key))!;

        const claim = queue.reserveEntries(new Set(['ordered-work']), new Set([EntityStatus.NEW]), 10, [observed, observed]);
        observed.status = EntityStatus.NON_RETRYABLE;
        observed.dequeueAudit = { ...observed.dequeueAudit, attempts: 19 };

        expect([...(await claim).values()]).toMatchObject([{
            key: entry.key,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1 }
        }]);
        expect(await queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
    });

    it.each(['ordinary', 'observed'])('preserves queue type, status, due time and attempt limits for %s reservation', async (selection) => {
        const queue = await createQueue(storage);
        const past = Temporal.Instant.from('2026-01-02T00:00:00Z');
        const future = Temporal.Now.instant().add({ hours: 1 });
        const wrongType = { ...createEntry('wrong-type'), typeId: 'another-type' };
        const futureRetry: ResourceEntry = {
            ...createEntry('future-retry'),
            status: EntityStatus.RETRY,
            dequeueAudit: { attempts: 1, startTs: past, endTs: past, nextTs: future }
        };
        const exhausted = {
            ...futureRetry,
            key: { ...futureRetry.key, resourceId: 'exhausted' },
            dequeueAudit: { attempts: 20, startTs: past, endTs: past, nextTs: past }
        };
        const terminal: ResourceEntry = {
            ...createEntry('terminal'),
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, startTs: past, endTs: past }
        };
        const eligible = createEntry('eligible');
        const observations: ResourceEntry[] = [];
        for (const entry of [wrongType, futureRetry, exhausted, terminal, eligible]) {
            await queue.enqueue(entry);
            observations.push((await queue.getItem(entry.key))!);
        }

        const claimed = await queue.reserveEntries(
            new Set(['ordered-work']),
            new Set([EntityStatus.NEW, EntityStatus.RETRY]),
            { maxToReserve: 1, maxAttempts: 20 },
            selection === 'observed' ? observations : undefined
        );

        expect([...claimed.values()]).toMatchObject([{ key: eligible.key, dequeueAudit: { attempts: 1 } }]);
        for (const observed of observations.slice(0, -1)) {
            expect(await queue.getItem(observed.key)).toEqual(observed);
        }
    });

    it('does not claim a replacement after its predecessor observation disappeared', async () => {
        const queue = await createQueue(storage);
        const entry = createEntry('reused-key');
        await queue.enqueue(entry);
        const observed = (await queue.getItem(entry.key))!;
        await queue.removeItem(entry.key);
        expect(await queue.reserveEntries(new Set(['ordered-work']), new Set([EntityStatus.NEW]), 1, [observed])).toEqual(new Map());
        await queue.enqueue({ ...entry, resource: 'later-message' });

        expect(await queue.reserveEntries(new Set(['ordered-work']), new Set([EntityStatus.NEW]), 1, [observed])).toEqual(new Map());
        expect(await queue.getItem(entry.key)).toMatchObject({ resource: 'later-message', dequeueAudit: { attempts: 0 } });
    });
});

it('reads only selected IndexedDB rows, leaving unrelated malformed storage outside reservation', async () => {
    const db = await openIndexedDbWithStores(
        `observed-point-read-${crypto.randomUUID()}`,
        [toIndexedDbQueueStoreDefinition('entries')]
    );
    onTestFinished(() => db.close());
    const queue = new IndexedDbQueueBox({ connection: new IndexedDbConnection(async () => db), storeName: 'entries' });
    const entry = createEntry('selected');
    await queue.enqueue(entry);
    const observed = (await queue.getItem(entry.key))!;
    const corrupt = { keyString: toKeyAsString(createEntry('unrelated').key), resource: 'malformed-outer-record' };
    const transaction = db.transaction('entries', 'readwrite');
    await readIndexedDbTransaction(transaction, async () => await readIndexedDbRequest(transaction.objectStore('entries').put(corrupt)));

    const claimed = await queue.reserveEntries(new Set(['ordered-work']), new Set([EntityStatus.NEW]), 1, [observed]);

    expect([...claimed.values()]).toMatchObject([{ key: entry.key, dequeueAudit: { attempts: 1 } }]);
    const readback = db.transaction('entries', 'readonly');
    expect(await readIndexedDbTransaction(readback, async () => await readIndexedDbRequest(readback.objectStore('entries').get(corrupt.keyString))))
        .toEqual(corrupt);
});

async function createQueue(storage: 'memory' | 'indexeddb' | 'pglite'): Promise<QueueBoxResourceEntryRepository> {
    switch (storage) {
        case 'memory':
            return new InMemoryQueueBox();
        case 'indexeddb': {
            const connection = new IndexedDbConnection(() =>
                openIndexedDbWithStores(
                    `observed-reservation-${crypto.randomUUID()}`,
                    [toIndexedDbQueueStoreDefinition('entries')]
                )
            );
            const db = await connection.open();
            onTestFinished(() => db.close());
            return new IndexedDbQueueBox({ connection, storeName: 'entries' });
        }
        case 'pglite': {
            const { sql } = await createPSqlAdmissionTestStorage();
            return new PSqlQueueBox(createPSqlResourceInboxRepository(sql));
        }
    }
}

function createEntry(resourceId: string): ResourceEntry {
    return {
        key: { topicId: 'ordered-work', resourceId, contextId: 'test' },
        typeId: 'ordered-work',
        resource: resourceId,
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 0 }
    };
}
