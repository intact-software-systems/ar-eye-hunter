import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import {
    createDensePrefixSuffixReadBatchFixture,
    createPrefixSuffixReadBatchFixture
} from '@shared-test/shared-server/prefix-suffix-read-batch-fixture.ts';
import assert from 'node:assert/strict';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

Deno.test('PGlite returns dense runtime-state key and prefix selections as one driver row per selected entry (D289)', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const sql = lifecycle.database;
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
        assert.deepEqual(
            { ...selections[2].entries[0], updatedTimestamp: undefined },
            { key: 'exact', value: 'exact-value', expireAtTimestamp: FUTURE_MS, updatedTimestamp: undefined, revision: 0 }
        );
        assert.ok(Number.isFinite(Date.parse(selections[2].entries[0].updatedTimestamp)));
        assert.deepEqual(driverRowCounts, [3]);
    }
    finally {
        await lifecycle.close();
    }
});

Deno.test('PGlite selects literal prefix-suffix matches in caller order and C key order', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const namespace = `read-batch-${crypto.randomUUID()}`;
    const fixture = createPrefixSuffixReadBatchFixture(namespace);
    const repository = new PSqlRuntimeStateRepository(lifecycle.database);

    try {
        for (const [index, entry] of fixture.entries.entries()) {
            await repository.upsert(entry.namespace, entry.key, `value-${index}`, FUTURE_MS);
        }

        const selections = await repository.readRuntimeStateBatch(fixture.selectors);

        assert.deepEqual(toSelectionKeys(selections), fixture.expectedSelections);
    }
    finally {
        await lifecycle.close();
    }
});

Deno.test('PGlite selects a dense workspace\'s prefix-suffix matches exactly as the in-memory selection does', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const namespace = `read-batch-${crypto.randomUUID()}`;
    const fixture = createDensePrefixSuffixReadBatchFixture(namespace);
    const repository = new PSqlRuntimeStateRepository(lifecycle.database);

    try {
        for (const [index, entry] of fixture.entries.entries()) {
            await repository.upsert(entry.namespace, entry.key, `value-${index}`, FUTURE_MS);
        }

        const selections = await repository.readRuntimeStateBatch(fixture.selectors);

        assert.deepEqual(toSelectionKeys(selections), fixture.expectedSelections);
    }
    finally {
        await lifecycle.close();
    }
});

Deno.test('PGlite probes a version of exactly the rows a batch reads that every write of one of them moves (D289)', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const namespace = `read-batch-${crypto.randomUUID()}`;
    const repository = new PSqlRuntimeStateRepository(lifecycle.database);
    const selectors = createSelectors(namespace);

    try {
        assert.equal(await repository.readRuntimeStateBatchVersion(selectors), undefined);
        await repository.upsert(namespace, 'prefix:a', 'prefix-a', FUTURE_MS);
        await repository.upsert(namespace, 'exact', 'exact-value', FUTURE_MS);
        const initial = await repository.readRuntimeStateBatchVersion(selectors);

        assert.deepEqual(initial?.expireAtEpochMs, [FUTURE_MS]);
        // The full read names the same version from its own statement, so a value read with it can be kept under it.
        const versioned = await repository.readRuntimeStateBatchWithVersion(selectors);
        assert.deepEqual(versioned.version, initial);
        assert.deepEqual(versioned.selections, await repository.readRuntimeStateBatch(selectors));
        assert.deepEqual(await repository.readRuntimeStateBatchVersion(selectors), initial);
        await repository.upsert(`${namespace}:sibling`, 'prefix:a', 'sibling', FUTURE_MS);
        assert.deepEqual(await repository.readRuntimeStateBatchVersion(selectors), initial);

        await repository.upsert(namespace, 'prefix:a', 'prefix-a-updated', FUTURE_MS);
        const updated = await repository.readRuntimeStateBatchVersion(selectors);
        assert.notEqual(updated?.version, initial?.version);

        await lifecycle.database.begin(async (transaction) => {
            await transaction`delete from runtime_state_store where store_namespace = ${namespace} and store_key = 'exact'`;
            await transaction`
              insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
              values (${namespace}, 'exact', 'replaced-value', to_timestamp(${FUTURE_MS} / 1000.0))
            `;
        });
        assert.notEqual((await repository.readRuntimeStateBatchVersion(selectors))?.version, updated?.version);
    }
    finally {
        await lifecycle.close();
    }
});

Deno.test('PGlite probes every selector group in one statement, each group reporting the version its own probe reports', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const namespace = `read-batch-${crypto.randomUUID()}`;
    const repository = new PSqlRuntimeStateRepository(lifecycle.database);
    const groups = ['first', 'empty', 'third'].map((group) => createSelectors(`${namespace}:${group}`));

    try {
        assert.deepEqual(await repository.readRuntimeStateBatchVersions(groups), [undefined, undefined, undefined]);
        await repository.upsert(`${namespace}:first`, 'prefix:a', 'first-a', FUTURE_MS);
        await repository.upsert(`${namespace}:third`, 'exact', 'third-exact', FUTURE_MS);
        await repository.upsert(`${namespace}:third`, 'prefix:b', 'third-b', FUTURE_MS);
        const statementsBefore = lifecycle.database.getExecutorCounters?.()?.statements ?? 0;

        const versions = await repository.readRuntimeStateBatchVersions(groups);

        assert.equal((lifecycle.database.getExecutorCounters?.()?.statements ?? 0) - statementsBefore, 1);
        const ownVersions = await Promise.all(
            groups.map(async (selectors) => (await repository.readRuntimeStateBatchVersion(selectors))?.version)
        );
        assert.deepEqual(versions, ownVersions);
        assert.equal(versions[1], undefined);
        assert.deepEqual(await repository.readRuntimeStateBatchVersions([]), []);
    }
    finally {
        await lifecycle.close();
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
    const observed = function<Rows extends PSqlRows> (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: PSqlParameter[]
    ): Promise<Rows> | object {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return sql(stringsOrValues);
        }
        return Promise.resolve(sql<Rows>(stringsOrValues, ...values)).then((result) => {
            rowCounts.push(Array.isArray(result) ? result.length : -1);
            return result;
        });
    } as PSqlSql;
    observed.begin = sql.begin.bind(sql);
    return observed;
}

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}
