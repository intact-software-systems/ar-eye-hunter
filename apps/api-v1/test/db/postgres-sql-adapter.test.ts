import assert from 'node:assert/strict';

import { createPSqlCounterScope } from '@shared-server/postgres/create-p-sql-counter-scope.ts';
import { PSqlFragment } from '@shared-server/postgres/p-sql-fragment.ts';
import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import {
    createPostgresSqlClient,
    type PostgresSqlClientSource,
    type PostgresSqlSource,
    type PostgresTransactionSqlSource
} from '../../src/db/postgres-sql-adapter.ts';
import { PostgresStatementCensus } from '../../src/db/postgres-statement-census.ts';

interface RecordedCall {
    readonly handle: 'root' | 'transaction' | 'savepoint';
    readonly text: string;
    readonly values: readonly PSqlParameter[];
    /** Present on a statement sent as text: the options it was sent with. */
    readonly options?: object;
}

interface FakePostgresClient {
    readonly client: PostgresSqlClientSource;
    readonly calls: RecordedCall[];
    readonly events: string[];
}

Deno.test('Postgres SQL client counts every statement of its root and transaction handles on one executor and forwards the client capabilities', async () => {
    const fake = createFakePostgresClient();
    const sql = createPostgresSqlClient(fake.client, undefined);

    assert.deepEqual(sql.getExecutorCounters(), { statements: 0, executorWaitMs: 0 });
    assert.deepEqual(await sql<readonly Record<string, number>[]>`select ${1} as one`, [{ one: 1 }]);
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

Deno.test('a counter scope over the Postgres client credits only its own statements, inside its transaction and savepoint, and carries none of the client lifecycle', async () => {
    const fake = createFakePostgresClient();
    const sql = createPostgresSqlClient(fake.client, undefined);
    const scoped = createPSqlCounterScope(sql, { timesBeginWait: true });
    const other = createPSqlCounterScope(sql, { timesBeginWait: true });

    await scoped`select ${1} as one`;
    await other`select ${2} as two`;
    await sql`select ${3} as three`;
    await scoped.begin(async (transaction) => {
        await transaction`update rows set value = ${4}`;
        assert.ok('savepoint' in transaction && typeof transaction.savepoint === 'function');
        const savepointSql = transaction as PSqlSql & { savepoint<T>(write: (sql: PSqlSql) => Promise<T>): Promise<T>; };
        await savepointSql.savepoint(async (nested) => {
            await nested`insert into rows values (${5})`;
        });
    });

    assert.equal(scoped.getExecutorCounters?.()?.statements, 3);
    assert.equal(other.getExecutorCounters?.()?.statements, 1);
    assert.equal(sql.getExecutorCounters().statements, 5);
    assert.deepEqual(fake.calls.map((call) => [call.handle, call.text, call.values]), [
        ['root', 'select ? as one', [1]],
        ['root', 'select ? as two', [2]],
        ['root', 'select ? as three', [3]],
        ['transaction', 'update rows set value = ?', [4]],
        ['savepoint', 'insert into rows values (?)', [5]]
    ]);
    assert.deepEqual(['end', 'notify', 'listen', 'close'].filter((name) => name in scoped), []);
});

Deno.test('with a census, every statement of the root, transaction and savepoint handles is recorded under its shape', async () => {
    const fake = createFakePostgresClient();
    const census = new PostgresStatementCensus();
    const sql = createPostgresSqlClient(fake.client, census);

    await sql`select ${'abc'} as one`;
    await sql`select ${'de'} as one`;
    await sql.begin(async (transaction) => {
        await transaction`update   rows
            set value = ${[1, 2]}`;
        const savepointSql = transaction as PSqlSql & { savepoint<T>(write: (sql: PSqlSql) => Promise<T>): Promise<T>; };
        await savepointSql.savepoint(async (nested) => {
            await nested`update   rows
            set value = ${7}`;
        });
    });

    const shapes = census.takeShapes();
    assert.deepEqual(
        shapes.map(({ shape, count, parameterChars }) => [shape, count, parameterChars]).sort(),
        [['select ? as one', 2, 5], ['update rows set value = ?', 2, 3]]
    );
    assert.ok(shapes.every((shape) => shape.executorWaitMs >= 0));
    assert.deepEqual(census.takeShapes(), [], 'a take empties the census');
});

Deno.test('at the root a statement planned per execution is sent unprepared as its positional text, counted and recorded like any other', async () => {
    const fake = createFakePostgresClient();
    const census = new PostgresStatementCensus();
    const sql = createPostgresSqlClient(fake.client, census);
    const statement = PSqlFragment.of`select * from rows where id = ${7} and name = ${'seven'}`;

    await sql(...statement.toPlannedPerExecution().toStatement());
    await sql(...statement.toStatement());

    assert.deepEqual(fake.calls.map((call) => [call.handle, call.text, call.values, call.options]), [
        ['root', 'select * from rows where id = $1 and name = $2', [7, 'seven'], { prepare: false }],
        ['root', 'select * from rows where id = ? and name = ?', [7, 'seven'], undefined]
    ]);
    assert.equal(sql.getExecutorCounters().statements, 2);
    assert.deepEqual(census.takeShapes().map(({ shape, count }) => [shape, count]), [
        ['select * from rows where id = ? and name = ?', 2]
    ]);
});

Deno.test('in a transaction a statement planned per execution goes out between two plan-cache settings in one pipelined write, counted and recorded once', async () => {
    const fake = createFakePostgresClient();
    const census = new PostgresStatementCensus();
    const sql = createPostgresSqlClient(fake.client, census);
    const statement = PSqlFragment.of`select * from rows where id = ${7}`.toPlannedPerExecution();

    const results = await sql.begin(async (transaction) => {
        const savepointSql = transaction as PSqlSql & { savepoint<T>(write: (sql: PSqlSql) => Promise<T>): Promise<T>; };
        const pending = transaction(...statement.toStatement());
        const issuedBeforeAwait = fake.calls.length;
        const inSavepoint = await savepointSql.savepoint(async (nested) => await nested(...statement.toStatement()));
        return { issuedBeforeAwait, inTransaction: await pending, inSavepoint };
    });

    assert.equal(results.issuedBeforeAwait, 3, 'all three statements are issued before any of them is awaited');
    assert.deepEqual(results.inTransaction, [{ answered: 'select * from rows where id = ?' }]);
    assert.deepEqual(results.inSavepoint, [{ answered: 'select * from rows where id = ?' }]);
    assert.deepEqual(fake.calls.map((call) => [call.handle, call.text, call.values]), [
        ['transaction', 'set local plan_cache_mode = force_custom_plan', []],
        ['transaction', 'select * from rows where id = ?', [7]],
        ['transaction', 'set local plan_cache_mode = default', []],
        ['savepoint', 'set local plan_cache_mode = force_custom_plan', []],
        ['savepoint', 'select * from rows where id = ?', [7]],
        ['savepoint', 'set local plan_cache_mode = default', []]
    ]);
    assert.equal(sql.getExecutorCounters().statements, 2, 'the plan-cache settings are not counted');
    assert.deepEqual(census.takeShapes().map(({ shape, count }) => [shape, count]), [['select * from rows where id = ?', 2]]);
});

Deno.test('without a census the client records nothing beside its counters', async () => {
    const fake = createFakePostgresClient();
    const sql = createPostgresSqlClient(fake.client, undefined);

    await sql`select ${1} as one`;

    assert.equal(sql.getExecutorCounters().statements, 1);
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
        const text = (stringsOrValues as TemplateStringsArray).join('?');
        calls.push({ handle, text, values });
        return Promise.resolve((handle === 'root' ? [{ one: 1 }] : [{ answered: text }]) as Result);
    }
    return Object.assign(sql, {
        unsafe: <Result>(text: string, values: readonly PSqlParameter[], options: { readonly prepare: false; }) => {
            calls.push({ handle, text, values, options });
            return Promise.resolve([] as Result);
        }
    });
}
