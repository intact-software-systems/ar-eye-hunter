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
