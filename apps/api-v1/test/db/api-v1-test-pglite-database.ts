import type { ApiV1DatabaseLifecycle } from '../../src/db/api-v1-database-lifecycle.ts';
import { createApiV1DatabaseLifecycle } from '../../src/db/api-v1-database-lifecycle.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

export interface ApiV1TestPGliteDatabaseLifecycle extends ApiV1DatabaseLifecycle {
    readonly database: PGliteSql;
}

export async function createApiV1TestPGliteDatabaseLifecycle(): Promise<ApiV1TestPGliteDatabaseLifecycle> {
    const lifecycle = await createApiV1DatabaseLifecycle({
        database: {
            mode: 'pglite-memory',
            dataDirectory: 'memory://',
            schemaInitialization: 'auto',
            pubSub: 'local',
            applicationPool: {
                maxConnections: 5,
                idleTimeoutSeconds: 20
            },
            listenerPool: {
                maxConnections: 1,
                idleTimeoutSeconds: 0
            }
        },
        pgliteEvidence: {
            mode: 'disabled',
            pollIntervalMs: 25
        }
    });

    return {
        ...lifecycle,
        database: lifecycle.database as PGliteSql
    };
}
