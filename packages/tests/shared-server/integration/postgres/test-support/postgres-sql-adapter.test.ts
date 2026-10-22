import { describe, expect, it } from 'vitest';

import { PSqlFragment } from '@shared-server/postgres/p-sql-fragment.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { toPSqlSql } from './postgres-sql-adapter.ts';

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
            'root:query:select ? as answer',
            'root:begin',
            'transaction:query:select ? as answer',
            'root:commit'
        ]);
    });

    it('sends a statement planned per execution unprepared at the root, and between plan-cache settings in one write in a transaction', async () => {
        const harness = createPostgresSqlHarness();
        const sql = toPSqlSql(harness.sql);
        const statement = PSqlFragment.of`select ${42} as answer`.toPlannedPerExecution();

        await expect(sql(...statement.toStatement())).resolves.toEqual([{ answer: 42 }]);
        const inTransaction = await sql.begin(async (transaction) => {
            const pending = transaction(...statement.toStatement());
            const issuedBeforeAwait = harness.events.length;
            return { issuedBeforeAwait, rows: await pending };
        });
        await sql(...PSqlFragment.of`select ${42} as answer`.toStatement());

        expect(inTransaction).toEqual({ issuedBeforeAwait: 5, rows: [{ answer: 42 }] });
        expect(harness.events).toEqual([
            'root:unprepared:select $1 as answer',
            'root:begin',
            'transaction:query:set local plan_cache_mode = force_custom_plan',
            'transaction:query:select ? as answer',
            'transaction:query:set local plan_cache_mode = default',
            'root:commit',
            'root:query:select ? as answer'
        ]);
        expect(() => sql(...PSqlFragment.of`select ${new Map()}`.toPlannedPerExecution().toStatement())).toThrow(TypeError);
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
    unsafe(...arguments_: never[]): object;
    begin<T>(write: (transaction: HarnessTransactionSql) => Promise<T>): Promise<T>;
}

interface HarnessTransactionSql {
    (...arguments_: never[]): object;
    unsafe(...arguments_: never[]): object;
    savepoint<T>(write: (transaction: HarnessTransactionSql) => Promise<T>): Promise<T>;
}

function createPostgresSqlHarness(): PostgresSqlHarness {
    const events: string[] = [];
    function transactionQuery(...argumentsList: never[]): object {
        return runQuery('transaction', argumentsList, events);
    }
    const transaction: HarnessTransactionSql = Object.assign(transactionQuery, {
        unsafe: (...statement: HarnessUnsafeStatement): object => runUnpreparedQuery('transaction', statement, events),
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
        unsafe: (...statement: HarnessUnsafeStatement): object => runUnpreparedQuery('root', statement, events),
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

    events.push(`${scope}:query:${stringsOrValues.join('?').replace(/\s+/gu, ' ').trim()}`);
    return Promise.resolve([{ answer: values[0] }]);
}

/** postgres.js `unsafe(text, values, options)`. */
type HarnessUnsafeStatement = [text: string, values: readonly number[], options: { readonly prepare: boolean; }];

function runUnpreparedQuery(
    scope: 'root' | 'transaction',
    [text, values, options]: HarnessUnsafeStatement,
    events: string[]
): object {
    events.push(`${scope}:${options.prepare ? 'prepared' : 'unprepared'}:${text}`);
    return Promise.resolve([{ answer: values[0] }]);
}

type HarnessQueryArgument = TemplateStringsArray | readonly string[] | number;

function isTemplateStringsArray(
    value: HarnessQueryArgument | undefined
): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
