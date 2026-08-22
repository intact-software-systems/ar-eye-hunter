import assert from 'node:assert/strict';

import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { getSql } from '../../src/db/db.ts';

Deno.test({
    name: 'default server constructs the complete PGlite runtime from operational configuration',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await withDefaultServerEnvironment(async () => {
            const server = createDefaultRallarServer({
                ws: {
                    allowImplicitUserTopics: false,
                    defaultFanout: 'live-only'
                }
            });

            assert.ok(server.runtime.authSessionRepository);
            assert.ok(server.runtime.groupStateService);
            assert.ok(server.runtime.backgroundTasks);
            try {
                await server.runtime.readiness;
            }
            finally {
                await server.runtime.backgroundTasks.stop();
                const database = getSql();
                if ('close' in database && typeof database.close === 'function') {
                    await database.close();
                }
            }
        });
    }
});

async function withDefaultServerEnvironment(run: () => Promise<void>): Promise<void> {
    const values = {
        RALLAR_SQL_BACKEND: 'pglite-memory',
        RALLAR_PGLITE_DATA_DIR: 'memory://',
        RALLAR_PGLITE_SCHEMA_INIT: 'auto',
        RALLAR_DB_PUBSUB: 'local',
        RALLAR_AUTH_CREDENTIAL_SECRET: 'default-server-test-credential-secret',
        RALLAR_TIMING_LOGS: 'false'
    } as const;
    const previous = new Map(
        Object.keys(values).map((name) => [name, Deno.env.get(name)])
    );
    try {
        for (const [name, value] of Object.entries(values)) {
            Deno.env.set(name, value);
        }
        await run();
    }
    finally {
        for (const [name, value] of previous) {
            if (value === undefined) {
                Deno.env.delete(name);
            }
            else {
                Deno.env.set(name, value);
            }
        }
    }
}
