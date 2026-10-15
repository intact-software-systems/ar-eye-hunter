import assert from 'node:assert/strict';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import {
    createPostgresSqlClient,
    type PostgresSqlClientSource,
    type PostgresSqlSource,
    type PostgresTransactionSqlSource
} from '../../src/db/postgres-sql-adapter.ts';

interface RecordedCall {
    readonly handle: 'root' | 'transaction' | 'savepoint';
    readonly text: string;
    readonly values: readonly unknown[];
}

interface FakePostgresClient {
    readonly client: PostgresSqlClientSource;
    readonly calls: RecordedCall[];
    readonly events: string[];
}

Deno.test('Postgres SQL client counts every statement of its root and transaction handles on one executor and forwards the client capabilities', async () => {
    const fake = createFakePostgresClient();
    const sql = createPostgresSqlClient(fake.client);

    assert.deepEqual(sql.getExecutorCounters(), { statements: 0, executorWaitMs: 0 });
    assert.deepEqual(await sql<readonly unknown[]>`select ${1} as one`, [{ one: 1 }]);
    assert.deepEqual(sql([1, 2]), { helper: [1, 2] });
    const inTransaction = await sql.begin(async (transaction) => {
        await transaction`update rows set value = ${2}`;
        const savepointSql = transaction as PSqlSql & { savepoint<T>(write: (sql: PSqlSql) => Promise<T>): Promise<T>; };
        await savepointSql.savepoint(async (nested) => {
            await nested`insert into rows values (${3})`;
        });
        return [transaction.getExecutorCounters?.()?.statements];
    });

    assert.deepEqual(inTransaction, [3], 'a transaction-bound handle counts on its executor and an array result is returned as is');
    assert.equal(sql.getExecutorCounters().statements, 3);
    assert.ok(sql.getExecutorCounters().executorWaitMs >= 0);
    assert.deepEqual(fake.calls.map((call) => [call.handle, call.text, call.values]), [
        ['root', 'select ? as one', [1]],
        ['transaction', 'update rows set value = ?', [2]],
        ['savepoint', 'insert into rows values (?)', [3]]
    ]);
    assert.deepEqual(sql.getExecutorCounters(), sql.getExecutorCounters(), 'a counters read is a stable snapshot');

    await sql.notify('channel', 'payload');
    await sql.listen('channel', () => undefined);
    await sql.end();
    assert.deepEqual(fake.events, ['notify:channel:payload', 'listen:channel', 'end']);
});

function createFakePostgresClient(): FakePostgresClient {
    const calls: RecordedCall[] = [];
    const events: string[] = [];
    const client = Object.assign(
        createFakeHandle('root', calls),
        {
            begin: async <T>(write: (transaction: PostgresTransactionSqlSource) => Promise<T>): Promise<T> => {
                const result = await write(createFakeTransactionHandle('transaction', calls));
                return Array.isArray(result) ? (await Promise.all(result)) as T : result;
            },
            notify: async (channel: string, payload: string) => {
                events.push(`notify:${channel}:${payload}`);
            },
            listen: async (channel: string) => {
                events.push(`listen:${channel}`);
            },
            end: async () => {
                events.push('end');
            }
        }
    );
    return { client, calls, events };
}

function createFakeTransactionHandle(
    handle: RecordedCall['handle'],
    calls: RecordedCall[]
): PostgresTransactionSqlSource {
    return Object.assign(createFakeHandle(handle, calls), {
        savepoint: async <T>(write: (transaction: PostgresTransactionSqlSource) => Promise<T>): Promise<T> =>
            await write(createFakeTransactionHandle('savepoint', calls))
    });
}

function createFakeHandle(handle: RecordedCall['handle'], calls: RecordedCall[]): PostgresSqlSource {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): PromiseLike<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): PromiseLike<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return { helper: stringsOrValues };
        }
        calls.push({ handle, text: (stringsOrValues as TemplateStringsArray).join('?'), values });
        return Promise.resolve((handle === 'root' ? [{ one: 1 }] : []) as Result);
    }
    return sql;
}
