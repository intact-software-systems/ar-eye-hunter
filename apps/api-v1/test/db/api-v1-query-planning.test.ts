import assert from 'node:assert/strict';

import { createDefaultApiV1DatabaseLifecycle } from '../../src/db/api-v1-database-lifecycle.ts';

/** API requests must not pay compilation cost on any pooled connection, even when a plan estimate is high. */
Deno.test({
    name: 'API PostgreSQL executes short requests without JIT on every application connection',
    ignore: Deno.env.get('RALLAR_POSTGRES_INTEGRATION') !== '1',
    fn: async () => {
        const url = Deno.env.get('DATABASE_URL');
        if (!url) {
            throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
        }
        const lifecycle = await createDefaultApiV1DatabaseLifecycle({
            database: {
                mode: 'postgres',
                url,
                schemaInitialization: 'disabled',
                pubSub: 'postgres',
                applicationPool: { maxConnections: 3, idleTimeoutSeconds: 20 },
                listenerPool: { maxConnections: 1, idleTimeoutSeconds: 0 }
            },
            pgliteEvidence: { mode: 'disabled', pollIntervalMs: 25 },
            statementCensus: undefined
        });
        const ready = Promise.withResolvers<void>();
        const acquisitionDeadline = setTimeout(() => {
            ready.reject(new Error('The application pool did not acquire three connections within five seconds'));
        }, 5_000);
        let acquired = 0;
        try {
            const requests = Array.from({ length: 3 }, () =>
                lifecycle.database.begin(async (transaction) => {
                    // Keep each transaction open until all concurrent requests own a connection.
                    acquired += 1;
                    if (acquired === 3) {
                        ready.resolve();
                    }
                    await ready.promise;
                    const [connection] = await transaction<{ pid: number; jit: string; }[]>`
                        select pg_backend_pid() as pid, current_setting('jit') as jit
                    `;
                    await transaction`set local jit_above_cost = 0`;
                    const explanation = await transaction<{ 'QUERY PLAN': string; }[]>`
                        explain (analyze, format text) select sum(value) from generate_series(1, 1000) value
                    `;
                    return { ...connection, plan: explanation.map((row) => row['QUERY PLAN']).join('\n') };
                }));
            const [connections] = await Promise.all([Promise.all(requests), ready.promise]);

            assert.equal(new Set(connections.map((connection) => connection.pid)).size, 3);
            for (const connection of connections) {
                assert.equal(connection.jit, 'off');
                assert.match(connection.plan, /Execution Time:/u);
                assert.doesNotMatch(connection.plan, /^JIT:/mu);
            }
            const [result] = await lifecycle.database<{ total: number; }[]>`select 2 + 3 as total`;
            assert.equal(result.total, 5);
        }
        finally {
            clearTimeout(acquisitionDeadline);
            ready.resolve();
            await lifecycle.close();
        }
    }
});
