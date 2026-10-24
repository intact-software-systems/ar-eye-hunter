import {
    describe,
    expect,
    it
} from 'vitest';

import { createDefaultApiV1DatabaseLifecycle } from '../../../../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

/** API requests must not pay compilation cost on any pooled connection, even when a plan estimate is high. */
describe('API PostgreSQL query planning', () => {
    postgresIt('executes short requests without JIT on every application connection', async () => {
        const url = process.env.DATABASE_URL;
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
                    const [explanation] = await transaction<{ 'QUERY PLAN': readonly Record<string, unknown>[]; }[]>`
                        explain (analyze, format json) select sum(value) from generate_series(1, 1000) value
                    `;
                    return { ...connection, plan: explanation['QUERY PLAN'][0] };
                }));
            const [connections] = await Promise.all([Promise.all(requests), ready.promise]);

            expect(new Set(connections.map((connection) => connection.pid)).size).toBe(3);
            for (const connection of connections) {
                expect(connection.jit).toBe('off');
                expect(connection.plan).not.toHaveProperty('JIT');
            }
            const [result] = await lifecycle.database<{ total: number; }[]>`select 2 + 3 as total`;
            expect(result.total).toBe(5);
        }
        finally {
            clearTimeout(acquisitionDeadline);
            ready.resolve();
            await lifecycle.close();
        }
    });
});
