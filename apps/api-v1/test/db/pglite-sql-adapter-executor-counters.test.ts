import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';

import { createPSqlCounterScope } from '@shared-server/postgres/create-p-sql-counter-scope.ts';
import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { createPGliteSqlClient } from '../../src/db/pglite-sql-adapter.ts';

Deno.test('PGlite executor counters count every statement handed to one executor, inside and outside transactions, and never another executor', async () => {
    const first = createPGliteSqlClient(new PGlite('memory://'));
    const second = createPGliteSqlClient(new PGlite('memory://'));
    try {
        assert.deepEqual(first.getExecutorCounters?.(), { statements: 0, executorWaitMs: 0 });

        await first`select 1 as one`;
        await first`select pg_sleep(0.02)`;
        const afterRoot = first.getExecutorCounters?.();
        assert.equal(afterRoot?.statements, 2);
        assert.ok(afterRoot !== undefined && afterRoot.executorWaitMs >= 15, `wait ${afterRoot?.executorWaitMs}`);

        const inTransaction = await first.begin(async (transaction) => {
            await transaction`select 2 as two`;
            await transaction`select 3 as three`;
            return transaction.getExecutorCounters?.();
        });
        assert.equal(inTransaction?.statements, 4, 'a transaction-bound handle counts on its executor');
        assert.equal(first.getExecutorCounters?.().statements, 4);
        assert.deepEqual(second.getExecutorCounters?.(), { statements: 0, executorWaitMs: 0 });

        const snapshot = first.getExecutorCounters?.();
        await first`select 4 as four`;
        assert.equal(snapshot?.statements, 4, 'a read counters value is a snapshot, not live state');
    }
    finally {
        await first.close();
        await second.close();
    }
});

Deno.test('a counter scope over PGlite credits only the statements issued through it, inside and outside its transaction, while the executor counts them all', async () => {
    const root = createPGliteSqlClient(new PGlite('memory://'));
    try {
        const scoped = createPSqlCounterScope(root, { timesBeginWait: true });
        await Promise.all([
            scoped.begin(async (transaction) => {
                await transaction`select pg_sleep(0.01)`;
                await transaction`select 1 as one`;
            }),
            root`select 2 as two`,
            root`select 3 as three`
        ]);
        await scoped`select 4 as four`;
        await root`select 5 as five`;

        const scopedCounters = scoped.getExecutorCounters?.();
        assert.equal(scopedCounters?.statements, 3, 'the scope: two transaction statements and one outside');
        assert.ok(scopedCounters !== undefined && scopedCounters.executorWaitMs >= 5, `wait ${scopedCounters?.executorWaitMs}`);
        assert.equal(root.getExecutorCounters?.()?.statements, 6, 'the executor: every statement of every handle');
        assert.deepEqual(
            createPSqlCounterScope(root, { timesBeginWait: true }).getExecutorCounters?.(),
            { statements: 0, executorWaitMs: 0, beginWaitMs: 0 },
            'a new scope starts empty'
        );
        assert.deepEqual(
            ['close', 'exec', 'notify', 'listen', 'raw'].filter((name) => name in scoped),
            [],
            'a scope carries none of the shared database lifecycle'
        );
    }
    finally {
        await root.close();
    }
});

Deno.test('a counter scope opens its transaction through the wrapped handle\'s begin, so a rollback there undoes the scoped writes', async () => {
    const root = createPGliteSqlClient(new PGlite('memory://'));
    try {
        await root.exec('create table scoped_writes (id int)');
        let wrappedBegins = 0;
        const rollingBack = new Proxy(root, {
            get: (target, property, receiver) => {
                if (property !== 'begin') {
                    return Reflect.get(target, property, receiver);
                }
                const begin: PSqlSql['begin'] = async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
                    await root.begin(async (transaction) => {
                        wrappedBegins += 1;
                        await write(transaction);
                        throw new Error('rolled back by the wrapped begin');
                    });
                return begin;
            }
        });
        const scoped = createPSqlCounterScope(rollingBack, { timesBeginWait: true });

        await assert.rejects(
            scoped.begin(async (transaction) => {
                await transaction`insert into scoped_writes values (1)`;
            }),
            /rolled back by the wrapped begin/
        );

        assert.equal(wrappedBegins, 1);
        assert.equal(scoped.getExecutorCounters?.()?.statements, 1);
        const [row] = await root<{ count: string; }[]>`select count(*)::text as count from scoped_writes`;
        assert.equal(row?.count, '0');
    }
    finally {
        await root.close();
    }
});

Deno.test('a counter scope keeps the PGlite transaction savepoint and counts its statements', async () => {
    const root = createPGliteSqlClient(new PGlite('memory://'));
    try {
        await root.exec('create table savepoint_writes (id int)');
        const scoped = createPSqlCounterScope(root, { timesBeginWait: true });
        await scoped.begin(async (transaction) => {
            assert.ok('savepoint' in transaction && typeof transaction.savepoint === 'function');
            const savepointSql = transaction as PSqlSql & { savepoint<T>(write: (nested: PSqlSql) => Promise<T>): Promise<T>; };
            await transaction`insert into savepoint_writes values (1)`;
            await assert.rejects(savepointSql.savepoint(async (nested) => {
                await nested`insert into savepoint_writes values (2)`;
                throw new Error('undo the savepoint only');
            }));
        });

        assert.equal(scoped.getExecutorCounters?.()?.statements, 2);
        const [row] = await root<{ count: string; }[]>`select count(*)::text as count from savepoint_writes`;
        assert.equal(row?.count, '1');
    }
    finally {
        await root.close();
    }
});

Deno.test('a counter scope credits the time from its begin call to the transaction callback entry, and none to the transaction body', async () => {
    const holdMs = 30;
    const bodyMs = 200;
    const slowToOpen = createSlowToOpenSql(holdMs);
    const scoped = createPSqlCounterScope(slowToOpen, { timesBeginWait: true });

    await scoped.begin(async () => {
        await new Promise((resolve) => setTimeout(resolve, bodyMs));
    });

    const beginWaitMs = scoped.getExecutorCounters?.()?.beginWaitMs;
    assert.ok(beginWaitMs !== undefined && beginWaitMs >= holdMs - 2, `begin wait ${beginWaitMs}`);
    assert.ok(beginWaitMs < holdMs + bodyMs, `begin wait excludes the body: ${beginWaitMs}`);
});

Deno.test('a counter scope that does not time begin waits reports none and still counts its statements', async () => {
    const root = createPGliteSqlClient(new PGlite('memory://'));
    try {
        const scoped = createPSqlCounterScope(root, { timesBeginWait: false });
        await scoped.begin(async (transaction) => {
            await transaction`select 1 as one`;
        });

        const counters = scoped.getExecutorCounters?.();
        assert.equal(counters?.statements, 1);
        assert.equal(counters !== undefined && 'beginWaitMs' in counters, false);
    }
    finally {
        await root.close();
    }
});

Deno.test('a handle that is not a counter scope reports no begin wait', async () => {
    const root = createPGliteSqlClient(new PGlite('memory://'));
    try {
        await root.begin(async (transaction) => {
            await transaction`select 1 as one`;
        });

        assert.equal(root.getExecutorCounters?.()?.beginWaitMs, undefined);
    }
    finally {
        await root.close();
    }
});

function createSlowToOpenSql(holdMs: number): PSqlSql {
    function sql(stringsOrValues: TemplateStringsArray | readonly PSqlParameter[], ..._values: readonly PSqlParameter[]): object {
        return Array.isArray(stringsOrValues) && 'raw' in stringsOrValues ? Promise.resolve([]) : {};
    }
    const database: PSqlSql = Object.assign(sql, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            await new Promise((resolve) => setTimeout(resolve, holdMs));
            return await write(database);
        }
    }) as PSqlSql;
    return database;
}
