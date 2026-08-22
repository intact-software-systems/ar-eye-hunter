import { PSqlRuntimeStateRepository, type RuntimeStateReadBatchSelector } from '@shared-server/mod.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import assert from 'node:assert/strict';
import { createApiV1SqlClient } from '../../src/db/db.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

Deno.test('PGlite returns dense packed runtime-state key and prefix selections', async () => {
    const sql = createApiV1SqlClient({ sqlBackend: 'pglite-memory' }) as PGliteSql;
    const namespace = `read-batch-${crypto.randomUUID()}`;
    const seed = new PSqlRuntimeStateRepository(sql);

    try {
        await seed.upsert(namespace, 'prefix:b', 'prefix-b', FUTURE_MS);
        await seed.upsert(namespace, 'exact', 'exact-value', FUTURE_MS);
        await seed.upsert(namespace, 'prefix:a', 'prefix-a', FUTURE_MS);
        await seed.upsert(`${namespace}:sibling`, 'prefix:a', 'sibling', FUTURE_MS);
        const driverRowCounts: number[] = [];
        const repository = new PSqlRuntimeStateRepository(
            observeDriverRowCounts(sql, driverRowCounts)
        );
        const selectors = createSelectors(namespace);

        const selections = await repository.readRuntimeStateBatch(selectors);

        assert.deepEqual(toSelectionKeys(selections), [{
            selectorId: 'missing',
            keys: []
        }, {
            selectorId: 'prefix',
            keys: ['prefix:a', 'prefix:b']
        }, {
            selectorId: 'exact',
            keys: ['exact']
        }]);
        assert.equal(selections[2].entries[0].value, 'exact-value');
        assert.deepEqual(driverRowCounts, [1]);
    }
    finally {
        await sql.close();
    }
});

function createSelectors(
    namespace: string
): readonly RuntimeStateReadBatchSelector[] {
    return [{
        selectorId: 'missing',
        kind: 'key',
        namespace,
        key: 'missing'
    }, {
        selectorId: 'prefix',
        kind: 'prefix',
        namespace,
        keyPrefix: 'prefix:'
    }, {
        selectorId: 'exact',
        kind: 'key',
        namespace,
        key: 'exact'
    }];
}

function toSelectionKeys(
    selections: Awaited<ReturnType<PSqlRuntimeStateRepository['readRuntimeStateBatch']>>
): readonly Readonly<{ selectorId: string; keys: readonly string[]; }>[] {
    return selections.map((selection) => ({
        selectorId: selection.selectorId,
        keys: selection.entries.map((entry) => entry.key)
    }));
}

function observeDriverRowCounts(
    sql: PSqlSql,
    rowCounts: number[]
): PSqlSql {
    const observed = function<T> (
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ): Promise<T> | unknown {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return sql(stringsOrValues);
        }
        return Promise.resolve(sql<T>(stringsOrValues, ...values)).then((result) => {
            rowCounts.push(Array.isArray(result) ? result.length : -1);
            return result;
        });
    } as PSqlSql;
    observed.begin = sql.begin.bind(sql);
    return observed;
}

function isTemplateStringsArray(value: readonly unknown[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}
