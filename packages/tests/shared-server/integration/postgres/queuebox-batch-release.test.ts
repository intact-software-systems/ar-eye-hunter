import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import type { PSqlParameter, PSqlSql, PSqlTransactionWrite } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { computeResourceInboxRelease } from '@shared/queuebox/compute-resource-inbox-release.ts';
import type { ResourceInboxRelease, ResourceInboxReleaseDisposition } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const MIXED_DISPOSITIONS: readonly ResourceInboxReleaseDisposition[] = [
    { status: EntityStatus.COMPLETED, delayMs: null },
    { status: EntityStatus.RETRY, delayMs: 1_000 },
    { status: EntityStatus.RETRY, delayMs: 250, reason: 'not-ready' },
    { status: EntityStatus.NON_RETRYABLE, delayMs: null },
    { status: EntityStatus.FAILED, delayMs: null },
    { status: EntityStatus.COMPLETED, delayMs: null }
];

describe('Postgres batch release', () => {
    postgresIt('releases a mixed batch in one update, each row as its own release computes it', async () => {
        const storage = await createReleaseStorage(16);
        const releasedAt = Temporal.Now.instant().round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' });
        const releases = toMixedReleases(storage.reserved);
        const counted = countResourceInboxUpdates(storage.sql);
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(counted.sql, () => new Date()), () => releasedAt);

        const released = await queue.releaseEntries(releases);

        expect(counted.updates()).toBe(1);
        expect(released.size).toBe(16);
        for (const { entry, disposition } of releases) {
            const expected = computeResourceInboxRelease(entry, disposition, releasedAt);
            const stored = await storage.other.entries.findAnyByKey(entry.key);
            expect(stored).toEqual(expected);
            expect([...released.values()].find((value) => value.db?.id === entry.db?.id)).toEqual(expected);
        }
    });

    postgresIt('keeps an idempotently finalized row as stored and releases the rest in the same update', async () => {
        const storage = await createReleaseStorage(4, EnqueuedType.WS_OUTBOX);
        const releasedAt = Temporal.Now.instant().round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' });
        const requeued = storage.reserved[2]!;
        const current = await storage.other.entries.replaceIfObserved(requeued, {
            ...requeued,
            status: EntityStatus.RETRY,
            dequeueAudit: { ...requeued.dequeueAudit, endTs: releasedAt, nextTs: releasedAt.add({ seconds: 10 }) }
        });
        const counted = countResourceInboxUpdates(storage.sql);
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(counted.sql, () => new Date()), () => releasedAt);
        const releases = storage.reserved.map((entry) => ({ entry, disposition: MIXED_DISPOSITIONS[0]! }));

        const released = await queue.releaseEntries(releases);

        expect(counted.updates()).toBe(1);
        expect([...released.values()]).toEqual(
            storage.reserved.map((entry) => entry === requeued ? current : computeResourceInboxRelease(entry, MIXED_DISPOSITIONS[0]!, releasedAt))
        );
        expect(await storage.other.entries.findAnyByKey(requeued.key)).toEqual(current);
    });

    postgresIt('rolls the whole update back when a middle reservation was lost', async () => {
        const storage = await createReleaseStorage(6);
        const lost = storage.reserved[3]!;
        await storage.other.entries.replaceIfObserved(lost, { ...lost, dequeueAudit: { ...lost.dequeueAudit, attempts: 2 } });
        const before = await storage.sql`select * from resource_inbox where fk_ext_bank_id = ${storage.namespace} order by ri_row_id`;
        const queue = new PSqlQueueBox(storage.repository, Temporal.Now.instant);

        await expect(queue.releaseEntries(toMixedReleases(storage.reserved))).rejects.toMatchObject({
            code: 'resource-inbox-lost-reservation',
            key: lost.key
        });
        expect(await storage.sql`select * from resource_inbox where fk_ext_bank_id = ${storage.namespace} order by ri_row_id`).toEqual(before);
    });
});

interface ReleaseStorage {
    readonly namespace: string;
    readonly sql: PostgresSql;
    readonly repository: PSqlResourceInboxRepository;
    readonly other: PSqlResourceInboxRepository;
    readonly reserved: readonly ResourceEntry[];
}

/** Reserved rows of a fresh context; their type is the context unless a test needs a queue type's own rules. */
async function createReleaseStorage(count: number, queueType?: string): Promise<ReleaseStorage> {
    const namespace = crypto.randomUUID();
    const typeId = queueType ?? namespace;
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await sql`delete from resource_inbox where fk_ext_bank_id = ${namespace}`;
        }
        finally {
            await sql.end();
        }
    });
    const otherSql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => otherSql.end());
    const repository = createPSqlResourceInboxRepository(sql, () => new Date());
    const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
        await queue.enqueue(toReleaseEntry(namespace, typeId, ordinal));
    }
    const reserved = [
        ...(await queue.reserveEntries({
            typeIds: new Set([typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: count
        })).values()
    ].filter((entry) => entry.key.contextId === namespace).sort((left, right) => Number(left.key.resourceId) - Number(right.key.resourceId));
    expect(reserved).toHaveLength(count);
    return { namespace, sql, repository, other: createPSqlResourceInboxRepository(otherSql, () => new Date()), reserved };
}

function toReleaseEntry(namespace: string, typeId: string, ordinal: number): ResourceEntry {
    return {
        key: { topicId: 'batch-release', contextId: namespace, resourceId: String(ordinal) },
        typeId,
        resource: `release ${ordinal}`,
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

function toMixedReleases(reserved: readonly ResourceEntry[]): readonly ResourceInboxRelease[] {
    return reserved.map((entry, index) => ({ entry, disposition: MIXED_DISPOSITIONS[index % MIXED_DISPOSITIONS.length]! }));
}

/** Counts the `update resource_inbox` statements issued inside the release transaction. */
function countResourceInboxUpdates(source: PSqlSql): { readonly sql: PSqlSql; readonly updates: () => number; } {
    let updates = 0;
    const toCounting = (transaction: PSqlSql): PSqlSql => {
        function sql<T>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<T>;
        function sql(values: readonly PSqlParameter[]): object;
        function sql<T>(stringsOrValues: TemplateStringsArray | readonly PSqlParameter[], ...values: readonly PSqlParameter[]): object | Promise<T> {
            if (!('raw' in stringsOrValues)) {
                return transaction(stringsOrValues);
            }
            if (stringsOrValues.join(' ').includes('update resource_inbox')) {
                updates += 1;
            }
            return transaction<T>(stringsOrValues, ...values);
        }
        return Object.assign(sql, { begin: transaction.begin.bind(transaction) });
    };
    const sql = Object.assign(source.bind(undefined), {
        begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> => await source.begin(async (transaction) => await write(toCounting(transaction)))
    });
    return { sql, updates: () => updates };
}
