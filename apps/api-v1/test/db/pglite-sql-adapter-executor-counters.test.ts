import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';

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

Deno.test('PGlite counter scope credits only the statements issued through the scoped handle, inside and outside its transaction, while the executor counts them all', async () => {
    const root = createPGliteSqlClient(new PGlite('memory://'));
    try {
        const scoped = root.openCounterScope?.();
        assert.ok(scoped, 'the PGlite port opens counter scopes');
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

        assert.equal(scoped.getExecutorCounters?.()?.statements, 3, 'the scope: two transaction statements and one outside');
        assert.equal(root.getExecutorCounters?.()?.statements, 6, 'the executor: every statement of every handle');
        const second = root.openCounterScope?.();
        assert.deepEqual(second?.getExecutorCounters?.(), { statements: 0, executorWaitMs: 0 }, 'a new scope starts empty');
    }
    finally {
        await root.close();
    }
});
