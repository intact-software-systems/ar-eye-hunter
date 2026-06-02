import assert from 'node:assert/strict';
import { Temporal } from '@js-temporal/polyfill';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');
const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const PAST_INSTANT = Temporal.Instant.from('2000-01-01T00:00:00.000Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');

Deno.test('PGlite SQL adapter supports tagged templates, array interpolation, and transactions', async () => {
    await withPGliteSql(async (sql) => {
        const scalarRows = await sql<{ value: number }[]>`
            select ${1}::int as value
        `;

        assert.deepEqual(scalarRows, [{ value: 1 }]);

        const arrayRows = await sql<{ value: string }[]>`
            select value
            from (values ('a'), ('b'), ('c')) as t(value)
            where value in ${sql(['a', 'c'])}
            order by value
        `;

        assert.deepEqual(arrayRows, [{ value: 'a' }, { value: 'c' }]);

        await assert.rejects(
            async () => {
                await sql.begin(async (tx) => {
                    await tx`
                        insert into runtime_state_store (store_namespace,
                                                         store_key,
                                                         store_value,
                                                         expire_at_ts)
                        values (${'tx'}, ${'rollback'}, ${'value'}, ${new Date(FUTURE_MS)})
                    `;
                    throw new Error('rollback smoke');
                });
            },
            /rollback smoke/,
        );

        const rowsAfterRollback = await sql<{ count: string }[]>`
            select count(*)
            from runtime_state_store
            where store_namespace = ${'tx'}
        `;

        assert.equal(Number(rowsAfterRollback[0].count), 0);
    });
});

Deno.test('PSqlRuntimeStateRepository runs against PGlite SQL adapter', async () => {
    await withPGliteSql(async (sql) => {
        const repository = new PSqlRuntimeStateRepository(sql);

        await repository.upsert('runtime-smoke', 'b', '{"value":2}', FUTURE_MS);
        await repository.upsert('runtime-smoke', 'a', '{"value":1}', FUTURE_MS);
        await repository.upsert('runtime-smoke', 'a', '{"value":3}', FUTURE_MS);

        const entry = await repository.findEntry('runtime-smoke', 'a');
        assert.equal(entry?.value, '{"value":3}');
        assert.equal(entry?.revision, 1);

        const allEntries = await repository.findAllEntries('runtime-smoke');
        assert.deepEqual(allEntries.map((row) => row.key), ['a', 'b']);

        const prefixedEntries = await repository.findEntriesByPrefix('runtime-smoke', 'a');
        assert.deepEqual(prefixedEntries.map((row) => row.key), ['a']);

        await assert.rejects(
            async () => {
                await repository.begin(async (txRepository) => {
                    await txRepository.lockKey('runtime-smoke', 'rollback');
                    await txRepository.upsert('runtime-smoke', 'rollback', 'value', FUTURE_MS);
                    throw new Error('rollback runtime state');
                });
            },
            /rollback runtime state/,
        );
        assert.equal(await repository.findEntry('runtime-smoke', 'rollback'), undefined);

        await repository.upsert('runtime-smoke', 'expired', 'expired', PAST_MS);
        assert.equal(await repository.deleteExpired('runtime-smoke'), 1);
        assert.equal(await repository.findEntry('runtime-smoke', 'expired'), undefined);
    });
});

Deno.test('ResourceInboxRepository and ResourceInboxResultsRepository run against PGlite SQL adapter', async () => {
    await withPGliteSql(async (sql) => {
        const inbox = new ResourceInboxRepository(sql);
        const results = new ResourceInboxResultsRepository(sql);
        const active = createResourceEntry('active-1', {
            payload: { text: 'active' },
            typeId: 'TYPE_A',
        });
        const expired = createResourceEntry('expired-1', {
            payload: { text: 'expired' },
            typeId: 'TYPE_A',
            expiryTs: PAST_INSTANT,
        });

        const stored = await inbox.write(active);
        assert.ok(stored.db?.id);
        await inbox.write(expired);

        assert.equal((await inbox.findByKey(active.key))?.key.resourceId, 'active-1');
        assert.equal(await inbox.findByKey(expired.key), null);
        assert.equal(
            await inbox.isEntriesToLock(
                new Set(['TYPE_A']),
                new Set([EntityStatus.NEW]),
            ),
            true,
        );

        const locked = await inbox.begin((txInbox) =>
            txInbox.findEntriesSkipLocked(
                new Set(['TYPE_A']),
                new Set([EntityStatus.NEW]),
                10,
            )
        );
        assert.equal(locked.size, 1);
        assert.equal([...locked.values()][0].key.resourceId, 'active-1');

        const reserved = await inbox.startProcessingEntity(active);
        assert.equal(reserved.right?.status, EntityStatus.RESERVED);
        assert.equal(reserved.right?.dequeueAudit.attempts, 1);

        assert.equal(await inbox.updateResourceEntry(active.key, EntityStatus.COMPLETED), 1);
        assert.equal((await inbox.findByKey(active.key))?.status, EntityStatus.COMPLETED);
        assert.equal(await inbox.deleteExpired(), 1);

        const resultEntry = createResourceEntry('result-1', {
            topicId: 'result-topic',
            typeId: 'RESULT',
            status: EntityStatus.COMPLETED,
            payload: { text: 'result' },
        });
        const activeResult = await results.writeIfAbsentOrReplaceExpired(resultEntry);
        assert.equal(activeResult.key.resourceId, 'result-1');

        const replacedResult = await results.replace(
            createResourceEntry('result-1', {
                topicId: 'result-topic',
                typeId: 'RESULT',
                status: EntityStatus.FAILED,
                payload: { text: 'result-updated' },
            }),
        );
        assert.equal(replacedResult.status, EntityStatus.FAILED);
        assert.deepEqual(JSON.parse(replacedResult.resource), { text: 'result-updated' });

        await results.replace(
            createResourceEntry('result-expired', {
                topicId: 'result-topic',
                typeId: 'RESULT',
                status: EntityStatus.COMPLETED,
                expiryTs: PAST_INSTANT,
            }),
        );
        assert.equal(await results.deleteExpired(), 1);
        assert.equal(await inbox.deleteByKey(active.key), true);
    });
});

Deno.test('PSqlAppDataRepository runs against PGlite SQL adapter', async () => {
    await withPGliteSql(async (sql) => {
        const repository = new PSqlAppDataRepository(sql);

        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'alpha',
            value: { count: 1 },
            schemaVersion: 1,
            expireAtTimestamp: FUTURE_MS,
        });
        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'alpha',
            value: { count: 2 },
            schemaVersion: 2,
            expireAtTimestamp: FUTURE_MS,
        });
        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'beta',
            value: { count: 3 },
            schemaVersion: 1,
            expireAtTimestamp: FUTURE_MS,
        });
        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'expired',
            value: { count: 4 },
            schemaVersion: 1,
            expireAtTimestamp: PAST_MS,
        });

        const alpha = await repository.findEntry('app-smoke', 'store', 'alpha');
        assert.deepEqual(alpha?.value, { count: 2 });
        assert.equal(alpha?.schemaVersion, 2);
        assert.equal(alpha?.revision, 1);

        const prefixed = await repository.findEntries('app-smoke', 'store', 'a');
        assert.deepEqual(prefixed.map((entry) => entry.key), ['alpha']);

        assert.equal(await repository.deleteExpired('app-smoke', 'store'), 1);
        assert.equal(await repository.deleteByKey('app-smoke', 'store', 'beta'), true);
        assert.equal(await repository.findEntry('app-smoke', 'store', 'beta'), undefined);
    });
});

async function withPGliteSql(
    fn: (sql: PGliteSql) => Promise<void>,
): Promise<void> {
    const sql = createApiV1SqlClient({ sqlBackend: 'pglite-memory' }) as PGliteSql;
    try {
        await fn(sql);
    } finally {
        await sql.close();
    }
}

function createResourceEntry(
    resourceId: string,
    options: Readonly<{
        topicId?: string;
        contextId?: string;
        typeId?: string;
        status?: EntityStatus;
        payload?: unknown;
        expiryTs?: Temporal.Instant;
    }> = {},
): ResourceEntry {
    return {
        key: {
            topicId: options.topicId ?? 'topic-smoke',
            resourceId,
            contextId: options.contextId ?? 'ctx-smoke',
        },
        resource: JSON.stringify(options.payload ?? { resourceId }),
        typeId: options.typeId ?? 'TYPE_A',
        status: options.status ?? EntityStatus.NEW,
        audit: {
            date: CREATED_TS.toPlainTime(),
            createdBy: 'tester',
            createdTs: CREATED_TS,
            expiryTs: options.expiryTs ?? FUTURE_INSTANT,
        },
        dequeueAudit: {
            attempts: 0,
        },
    };
}
