import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import type { RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/RuntimeStateReadBatch.ts';
import { describe, expect, it } from 'vitest';
import { createRuntimeStatePostgresSql } from '../../postgres-runtime-state-client-fixtures.ts';

const POSTGRES_INTEGRATION_ENABLED = readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

type GlobalEnv = Readonly<{
    Deno?: Readonly<{
        env: Readonly<{ get(key: string): string | undefined; }>;
    }>;
    process?: Readonly<{
        env?: Readonly<Record<string, string | undefined>>;
    }>;
}>;

describe('Postgres runtime-state read batches', () => {
    postgresIt('returns exact, prefix, and missing selections in one packed row', async () => {
        const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
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

            const selections = await repository.readRuntimeStateBatch(
                createSelectors(namespace)
            );

            expect(selections.map((selection) => ({
                selectorId: selection.selectorId,
                keys: selection.entries.map((entry) => entry.key)
            }))).toEqual([{
                selectorId: 'missing',
                keys: []
            }, {
                selectorId: 'prefix',
                keys: ['prefix:a', 'prefix:b']
            }, {
                selectorId: 'exact',
                keys: ['exact']
            }]);
            expect(selections[2].entries[0].value).toBe('exact-value');
            expect(driverRowCounts).toEqual([1]);
        }
        finally {
            await sql`
        delete from runtime_state_store
        where store_namespace in (${namespace}, ${`${namespace}:sibling`})
      `;
            await sql.end();
        }
    });
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

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}

function readEnv(name: string): string | undefined {
    const globals = globalThis as GlobalEnv;
    return globals.Deno?.env.get(name) ?? globals.process?.env?.[name];
}
