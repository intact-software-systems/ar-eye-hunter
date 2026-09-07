import '../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { PSqlResourceInboxReservationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts';
import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toIndexedDbQueueStoreDefinition } from '@shared/queuebox/indexed-db-queue-box-store.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from '../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

interface QueueWorkQueryPlan {
    readonly 'Node Type': string;
    readonly 'Actual Rows': number;
    readonly 'Actual Loops': number;
    readonly 'Rows Removed by Filter'?: number;
    readonly 'Rows Removed by Index Recheck'?: number;
    readonly Plans?: readonly QueueWorkQueryPlan[];
}

it.each(['ascending', 'descending', 'shuffled'] as const)('drains memory work pages after %s insertion and unrelated status changes', async (order) => {
    const queue = new InMemoryQueueBox();
    const count = 4_096;
    const entries = Array.from({ length: count }, (_, index) => createEntry(String(index).padStart(4, '0')));
    for (let index = 0; index < count; index += 1) {
        const position = order === 'ascending' ? index : order === 'descending' ? count - 1 - index : (index * 37) % count;
        await queue.enqueue(entries[position]);
    }
    for (let index = 1; index < count; index += 2) {
        await queue.enqueue({ ...entries[index], status: EntityStatus.RETRY });
    }
    const request = { typeId: 'ordered-work', status: EntityStatus.NEW, maxToRead: 31, cursor: null } as const;
    let page = await queue.readWorkPage(request);
    const drained: string[] = [];
    while (page.entries.length > 0) {
        for (const entry of page.entries) {
            drained.push(entry.resource);
            await queue.removeItem(entry.key);
        }
        if (page.nextCursor === null) {
            break;
        }
        page = await queue.readWorkPage({ ...request, cursor: page.nextCursor });
    }

    expect(drained).toEqual(entries.filter((_, index) => index % 2 === 0).map((entry) => entry.resource));
    expect((await queue.readWorkPage(request)).entries).toEqual([]);
    expect((await queue.readWorkPage({ ...request, status: EntityStatus.RETRY })).entries.map((entry) => entry.resource))
        .toEqual(entries.filter((_, index) => index % 2 === 1).slice(0, 31).map((entry) => entry.resource));
});

describe.each(['memory', 'indexeddb', 'pglite'] as const)('%s QueueBox work pages', (storage) => {
    it('reads bounded independent observations before claiming eligible work', async () => {
        const queue = await createQueue(storage);
        const first = createEntry('first');
        const second = createEntry('second');
        const third = createEntry('third');
        for (
            const entry of [
                first,
                { ...createEntry('other-type'), typeId: 'another-work-type' },
                { ...createEntry('completed'), status: EntityStatus.COMPLETED },
                { ...createEntry('malformed-terminal'), status: EntityStatus.NON_RETRYABLE },
                second,
                third
            ]
        ) {
            await queue.enqueue(entry);
        }
        const request = { typeId: 'ordered-work', status: EntityStatus.NEW, maxToRead: 2, cursor: null } as const;

        const page = await queue.readWorkPage(request);

        expect(page.entries.map((entry) => entry.resource)).toEqual(['first', 'second']);
        expect(page.entries.map((entry) => entry.dequeueAudit.attempts)).toEqual([0, 0]);
        expect(page.nextCursor).not.toBeNull();
        expect(await queue.readWorkPage(request)).toEqual(page);
        const next = await queue.readWorkPage({ ...request, cursor: page.nextCursor });
        expect(next.entries.map((entry) => entry.resource)).toEqual(['third']);
        expect(next.nextCursor).toBeNull();

        const changed = await queue.replaceIfObserved(page.entries[0], { ...page.entries[0], resource: 'newer-value' });
        expect(changed).not.toBeNull();
        const claimed = await queue.reserveEntries({
            typeIds: new Set(['ordered-work']),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 2,
            observedEntries: page.entries
        });
        expect([...claimed.values()]).toMatchObject([{ key: second.key, dequeueAudit: { attempts: 1 } }]);
        expect(await queue.getItem(first.key)).toMatchObject({ resource: 'newer-value', dequeueAudit: { attempts: 0 } });
        expect(await queue.getItem(third.key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
    });

    it('reflects replacement, reservation and release without retaining work in an old status', async () => {
        const queue = await createQueue(storage);
        const entry = createEntry('transition');
        await queue.enqueue(entry);
        const pending = { typeId: 'ordered-work', status: EntityStatus.NEW, maxToRead: 2, cursor: null } as const;
        const retry = { ...entry, status: EntityStatus.RETRY, dequeueAudit: { attempts: 1, nextTs: Temporal.Now.instant() } };
        await queue.enqueue(retry);
        expect((await queue.readWorkPage(pending)).entries).toEqual([]);
        const page = await queue.readWorkPage({ ...pending, status: EntityStatus.RETRY });
        expect(page.entries).toMatchObject([{ key: entry.key, status: EntityStatus.RETRY }]);
        const claimed = await queue.reserveEntries({
            typeIds: new Set(['ordered-work']),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: 1,
            observedEntries: page.entries
        });
        expect((await queue.readWorkPage({ ...pending, status: EntityStatus.RETRY })).entries).toEqual([]);
        expect((await queue.readWorkPage({ ...pending, status: EntityStatus.RESERVED })).entries)
            .toMatchObject([{ key: entry.key, dequeueAudit: { attempts: 2 } }]);
        await queue.releaseEntries([...claimed.values()], { status: EntityStatus.NON_RETRYABLE, delayMs: null });
        expect((await queue.readWorkPage({ ...pending, status: EntityStatus.RESERVED })).entries).toEqual([]);
        expect((await queue.readWorkPage({ ...pending, status: EntityStatus.NON_RETRYABLE })).entries)
            .toMatchObject([{ key: entry.key, dequeueAudit: { attempts: 2 } }]);
        await queue.removeItem(entry.key);
        expect((await queue.readWorkPage({ ...pending, status: EntityStatus.NON_RETRYABLE })).entries).toEqual([]);
    });

    it('keeps expiry reads observational and returns independently owned values', async () => {
        const queue = await createQueue(storage);
        const entry = createEntry('expired');
        await queue.enqueue({ ...entry, audit: { ...entry.audit, expiryTs: Temporal.Instant.from('2020-01-01T00:00:00Z') } });
        const request = { typeId: 'ordered-work', status: EntityStatus.NEW, maxToRead: 2, cursor: null } as const;
        const observed = await queue.readWorkPage(request);
        expect(observed.entries).toMatchObject([{ resource: 'expired', status: EntityStatus.NEW }]);
        observed.entries[0].status = EntityStatus.NON_RETRYABLE;
        observed.entries[0].dequeueAudit = { attempts: 99 };
        expect((await queue.readWorkPage(request)).entries)
            .toMatchObject([{ resource: 'expired', status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } }]);
    });

    it('rejects invalid bounds and cursor reuse in another scope before changing work', async () => {
        const queue = await createQueue(storage);
        const entry = createEntry('unchanged');
        await queue.enqueue(entry);
        const request = { typeId: 'ordered-work', status: EntityStatus.NEW, maxToRead: 1, cursor: null } as const;
        const observed = await queue.readWorkPage(request);
        for (const maxToRead of [0, -1, 257, Number.MAX_SAFE_INTEGER, Number.NaN]) {
            await expect(queue.readWorkPage({ ...request, maxToRead })).rejects.toBeInstanceOf(TypeError);
        }
        await expect(queue.readWorkPage({ ...request, typeId: 'other', cursor: observed.nextCursor }))
            .rejects.toBeInstanceOf(TypeError);
        await expect(queue.readWorkPage({ ...request, status: EntityStatus.RETRY, cursor: observed.nextCursor }))
            .rejects.toBeInstanceOf(TypeError);
        expect(await queue.readWorkPage(request)).toEqual(observed);
    });

    it('continues after the cursor row disappears and rediscovers new work on the next scan', async () => {
        const queue = await createQueue(storage);
        const first = createEntry('first');
        const second = createEntry('second');
        await queue.enqueue(first);
        await queue.enqueue(second);
        const request = { typeId: 'ordered-work', status: EntityStatus.NEW, maxToRead: 1, cursor: null } as const;
        const page = await queue.readWorkPage(request);
        await queue.removeItem(first.key);
        const next = await queue.readWorkPage({ ...request, cursor: page.nextCursor });
        expect(next.entries).toMatchObject([{ key: second.key, dequeueAudit: { attempts: 0 } }]);
        expect((await queue.readWorkPage({ ...request, cursor: next.nextCursor })).entries).toEqual([]);

        const predecessor = createEntry('earlier');
        await queue.enqueue(predecessor);
        const restarted = await queue.readWorkPage({ ...request, maxToRead: 2 });
        expect(restarted.entries.map((entry) => entry.key)).toEqual(expect.arrayContaining([predecessor.key, second.key]));
        expect(restarted.entries.map((entry) => entry.dequeueAudit.attempts)).toEqual([0, 0]);
    });
});

it('keeps IndexedDB page reads readonly and leaves corruption outside the requested page untouched', async () => {
    const { queue, db } = await createIndexedDbQueue();
    await queue.enqueue(createEntry('first'));
    await queue.enqueue(createEntry('second'));
    const corrupt = {
        keyString: 'ordered-work/third/test',
        typeId: 'ordered-work',
        status: EntityStatus.NEW,
        resource: 'malformed outer storage'
    };
    const write = db.transaction('entries', 'readwrite');
    await readIndexedDbTransaction(write, async () => await readIndexedDbRequest(write.objectStore('entries').put(corrupt)));
    const transactions = vi.spyOn(db, 'transaction');
    const request = { typeId: 'ordered-work', status: EntityStatus.NEW, maxToRead: 2, cursor: null } as const;
    try {
        const page = await queue.readWorkPage(request);
        expect(page.entries.map((entry) => entry.resource)).toEqual(['first', 'second']);
        await expect(queue.readWorkPage({ ...request, cursor: page.nextCursor })).rejects.toBeInstanceOf(TypeError);
        expect(transactions.mock.calls.map((call) => call[1])).toEqual(['readonly', 'readonly']);
    }
    finally {
        transactions.mockRestore();
    }
    const read = db.transaction('entries', 'readonly');
    expect(await readIndexedDbTransaction(read, async () => await readIndexedDbRequest(read.objectStore('entries').get(corrupt.keyString))))
        .toEqual(corrupt);
});

it('bounds SQL rows visited across a large unrelated gap on both the first and subsequent work page', async () => {
    const { sql } = await createPSqlAdmissionTestStorage();
    await sql`
        insert into resource_inbox
            (ri_row_id, ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
             fk_ext_bank_id, system_date, created_by, created_ts, ri_attempts, expire_ts)
        select g, g::text, 'page-work', 'payload',
            case when g between 50001 and 50016 or g > 100000 then 'page-work' else 'unrelated' end,
            'NEW', 'page-test', date '2026-01-01', 'test',
            timestamp '2026-01-01 12:00:00.123456', 0, timestamp '2027-01-01 12:00:00'
        from generate_series(1, 110000) as g
    `;
    await sql`analyze resource_inbox`;
    const plans: QueueWorkQueryPlan[] = [];
    const explainedSql = new Proxy(sql, {
        apply: async (target, receiver, arguments_) => {
            const [strings, ...parameters] = arguments_;
            if (!Array.isArray(strings) || !('raw' in strings)) {
                throw new TypeError('Page query instrumentation requires a tagged SQL statement');
            }
            const chunks = ['explain (analyze, format json) ' + strings[0], ...strings.slice(1)];
            const query = Object.assign(chunks, { raw: chunks.slice() });
            const result: readonly { readonly 'QUERY PLAN': readonly { readonly Plan: QueueWorkQueryPlan; }[]; }[] = await Reflect.apply(target, receiver, [
                query,
                ...parameters
            ]);
            plans.push(result[0]['QUERY PLAN'][0].Plan);
            return await Reflect.apply(target, receiver, arguments_);
        }
    });
    const repository = new PSqlResourceInboxReservationRepository(explainedSql);
    const request = { typeId: 'page-work', status: EntityStatus.NEW, maxToRead: 16, cursor: null } as const;

    const first = await repository.readWorkPage(request);
    const next = await repository.readWorkPage({ ...request, cursor: first.nextCursor });

    expect(first.entries.map((entry) => entry.db?.id)).toEqual(Array.from({ length: 16 }, (_, index) => String(50001 + index)));
    expect(next.entries.map((entry) => entry.db?.id)).toEqual(Array.from({ length: 16 }, (_, index) => String(100001 + index)));
    expect(plans.map(computeVisitedQueueRows)).toEqual([16, 16]);
}, 15_000);

function computeVisitedQueueRows(plan: QueueWorkQueryPlan): number {
    const scanRows = ['Index Scan', 'Index Only Scan', 'Seq Scan', 'Bitmap Heap Scan'].includes(plan['Node Type'])
        ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0) + (plan['Rows Removed by Index Recheck'] ?? 0)) *
            plan['Actual Loops']
        : 0;
    return scanRows + (plan.Plans ?? []).reduce((sum, child) => sum + computeVisitedQueueRows(child), 0);
}

async function createQueue(storage: 'memory' | 'indexeddb' | 'pglite'): Promise<QueueBoxResourceEntryRepository> {
    switch (storage) {
        case 'memory':
            return new InMemoryQueueBox();
        case 'indexeddb':
            return (await createIndexedDbQueue()).queue;
        case 'pglite': {
            const { sql } = await createPSqlAdmissionTestStorage();
            return new PSqlQueueBox(createPSqlResourceInboxRepository(sql));
        }
    }
}

async function createIndexedDbQueue() {
    const dbName = `queuebox-work-page-${crypto.randomUUID()}`;
    const connection = new IndexedDbConnection(() => openIndexedDbWithStores(dbName, [toIndexedDbQueueStoreDefinition('entries')]));
    const db = await connection.open();
    onTestFinished(async () => {
        db.close();
        await readIndexedDbRequest(indexedDB.deleteDatabase(dbName));
    });
    return { db, queue: new IndexedDbQueueBox({ connection, storeName: 'entries' }) };
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
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00.123456'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 0 },
        db: undefined
    };
}
