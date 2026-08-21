import { describe, expect, it } from 'vitest';

import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { toPSqlSql } from './fixtures/postgres-sql-adapter.ts';

describe('postgres.js PSqlSql adapter', () => {
    it('preserves root transactions, tagged queries, helpers, and object results', async () => {
        const harness = createPostgresSqlHarness();
        const sql = toPSqlSql(harness.sql);

        expect(sql(['store_namespace', 'store_key'])).toEqual({
            kind: 'query-helper',
            values: ['store_namespace', 'store_key']
        });
        await expect(sql<Array<{ answer: number; }>>`select ${42} as answer`).resolves.toEqual([
            { answer: 42 }
        ]);
        await expect(
            sql.begin(async (transaction) => {
                const rows = await transaction<Array<{ answer: number; }>>`
          select ${42} as answer
        `;
                return { kind: 'root-result', answer: rows[0]?.answer } as const;
            })
        ).resolves.toEqual({ kind: 'root-result', answer: 42 });

        expect(harness.events).toEqual([
            'root:query-helper',
            'root:query',
            'root:begin',
            'transaction:query',
            'root:commit'
        ]);
    });

    it('preserves savepoints through nested runtime repository transactions', async () => {
        const harness = createPostgresSqlHarness();
        const repository = new PSqlRuntimeStateRepository(toPSqlSql(harness.sql));

        const result = await repository.begin(async (transaction) => {
            return await transaction.begin(async () =>
                ({
                    kind: 'nested-result',
                    revision: 7
                }) as const
            );
        });

        expect(result).toEqual({ kind: 'nested-result', revision: 7 });
        expect(harness.events).toEqual([
            'root:begin',
            'transaction:savepoint',
            'transaction:release-savepoint',
            'root:commit'
        ]);
    });

    it('rolls a nested repository savepoint and root transaction back on failure', async () => {
        const harness = createPostgresSqlHarness();
        const failure = new Error('nested-write-failed');
        const repository = new PSqlRuntimeStateRepository(toPSqlSql(harness.sql));

        await expect(
            repository.begin(async (transaction) => {
                return await transaction.begin(async () => {
                    throw failure;
                });
            })
        ).rejects.toBe(failure);

        expect(harness.events).toEqual([
            'root:begin',
            'transaction:savepoint',
            'transaction:rollback-savepoint',
            'root:rollback'
        ]);
    });
});

interface PostgresSqlHarness {
    readonly sql: HarnessRootSql;
    readonly events: string[];
}

interface HarnessRootSql {
    (...arguments_: never[]): object;
    begin<T>(write: (transaction: HarnessTransactionSql) => Promise<T>): Promise<T>;
}

interface HarnessTransactionSql {
    (...arguments_: never[]): object;
    savepoint<T>(write: (transaction: HarnessTransactionSql) => Promise<T>): Promise<T>;
}

function createPostgresSqlHarness(): PostgresSqlHarness {
    const events: string[] = [];
    function transactionQuery(...argumentsList: never[]): object {
        return runQuery('transaction', argumentsList, events);
    }
    const transaction: HarnessTransactionSql = Object.assign(transactionQuery, {
        savepoint: async <T>(
            write: (transactionSql: HarnessTransactionSql) => Promise<T>
        ): Promise<T> => {
            events.push('transaction:savepoint');
            try {
                const result = await write(transaction);
                events.push('transaction:release-savepoint');
                return result;
            }
            catch (error) {
                events.push('transaction:rollback-savepoint');
                throw error;
            }
        }
    });
    function rootQuery(...argumentsList: never[]): object {
        return runQuery('root', argumentsList, events);
    }
    const sql: HarnessRootSql = Object.assign(rootQuery, {
        begin: async <T>(write: (transactionSql: HarnessTransactionSql) => Promise<T>): Promise<T> => {
            events.push('root:begin');
            try {
                const result = await write(transaction);
                events.push('root:commit');
                return result;
            }
            catch (error) {
                events.push('root:rollback');
                throw error;
            }
        }
    });
    return { sql, events };
}

function runQuery(
    scope: 'root' | 'transaction',
    argumentsList: HarnessQueryArgument[],
    events: string[]
): object {
    const [stringsOrValues, ...values] = argumentsList;
    if (!isTemplateStringsArray(stringsOrValues)) {
        events.push(`${scope}:query-helper`);
        return { kind: 'query-helper', values: stringsOrValues };
    }

    events.push(`${scope}:query`);
    return Promise.resolve([{ answer: values[0] }]);
}

type HarnessQueryArgument = TemplateStringsArray | readonly string[] | number;

function isTemplateStringsArray(
    value: HarnessQueryArgument | undefined
): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
