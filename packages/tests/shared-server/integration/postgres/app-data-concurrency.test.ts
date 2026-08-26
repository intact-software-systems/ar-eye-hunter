import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RallarServerAppData } from '@shared-server/app-data/rallar-server-app-data.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { describe, expect, it } from 'vitest';
import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

interface GlobalEnv {
    Deno?: Readonly<{
        env: Readonly<{
            get(key: string): string | undefined;
        }>;
    }>;
    process?: Readonly<{
        env?: Readonly<Record<string, string | undefined>>;
    }>;
}

const POSTGRES_INTEGRATION_ENABLED = readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

describe('Postgres app-data concurrency', () => {
    postgresIt(
        'does not lose concurrent updateOrCreate increments',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const sql = await createRuntimeStatePostgresSql(databaseUrl, 5);
            const repository = new PSqlAppDataRepository(sql);
            const namespace = `app-data-concurrency-${Date.now()}-${Math.random()}`;

            try {
                const seed = await createAppData(repository).open('counters', {
                    codec: COUNTER_CODEC,
                    namespace,
                    maxConflictRetries: 100
                });
                await seed.set('count', { count: 0 });

                const stores = await Promise.all(
                    Array.from({ length: 16 }, async () =>
                        await createAppData(repository).open('counters', {
                            codec: COUNTER_CODEC,
                            namespace,
                            maxConflictRetries: 100
                        }))
                );

                await Promise.all(
                    stores.map(async (store) =>
                        await store.updateOrCreate('count', (current) => ({
                            count: (current?.count ?? 0) + 1
                        }))
                    )
                );

                await expect(seed.get('count')).resolves.toEqual({ count: 16 });
            }
            finally {
                await sql`
                    delete
                    from app_data_store
                    where app_namespace = ${namespace}
                `;
                await sql.end();
            }
        },
        60_000
    );
});

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error(
            'DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1'
        );
    }

    return databaseUrl;
}

const COUNTER_CODEC = {
    schemaVersion: 1,
    encode: (value: Counter) => ({ count: value.count }),
    decode: (value: JsonWireValue): Counter => {
        if (!isJsonWireObject(value) || typeof value.count !== 'number') {
            throw new TypeError('Counter app data must contain a numeric count.');
        }
        return { count: value.count };
    }
};

interface Counter {
    readonly count: number;
}

function createAppData(repository: PSqlAppDataRepository): RallarServerAppData {
    return new RallarServerAppData({
        repositories: new RepositoryManager(),
        repository,
        nowEpochMs: Date.now
    });
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readEnv(key: string): string | undefined {
    const globals = globalThis as GlobalEnv;
    return globals.Deno?.env.get(key) ?? globals.process?.env?.[key];
}
