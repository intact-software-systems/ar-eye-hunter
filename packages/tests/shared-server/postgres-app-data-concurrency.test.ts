import { describe, expect, it } from 'vitest';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import { RallarServerDataFacade } from '@shared-server/rallar-facade/RallarServer.ts';

type PostgresSql = PSqlSql & Readonly<{
    end(): Promise<void>;
}>;

type PostgresModule = Readonly<{
    default: (
        databaseUrl: string,
        options: Readonly<{ max: number; idle_timeout: number }>,
    ) => PostgresSql;
}>;

type GlobalEnv = Readonly<{
    Deno?: Readonly<{
        env: Readonly<{
            get(key: string): string | undefined;
        }>;
    }>;
    process?: Readonly<{
        env?: Readonly<Record<string, string | undefined>>;
    }>;
}>;

const POSTGRES_INTEGRATION_ENABLED =
    readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;

describe('Postgres app-data concurrency', () => {
    postgresIt(
        'does not lose concurrent updateOrCreate increments',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const sql = await createSql(databaseUrl);
            const repository = new PSqlAppDataRepository(sql);
            const namespace = `app-data-concurrency-${Date.now()}-${Math.random()}`;

            try {
                const seed = await new RallarServerDataFacade(
                    new RepositoryManager(),
                    repository,
                ).open<{ count: number }>('counters', {
                    namespace,
                    maxConflictRetries: 100,
                });
                await seed.set('count', { count: 0 });

                const stores = await Promise.all(
                    Array.from({ length: 16 }, async () =>
                        await new RallarServerDataFacade(
                            new RepositoryManager(),
                            repository,
                        ).open<{ count: number }>('counters', {
                            namespace,
                            maxConflictRetries: 100,
                        })
                    ),
                );

                await Promise.all(
                    stores.map(async (store) =>
                        await store.updateOrCreate('count', (current) => ({
                            count: (current?.count ?? 0) + 1,
                        }))
                    ),
                );

                await expect(seed.get('count')).resolves.toEqual({ count: 16 });
            } finally {
                await sql`
                    delete
                    from app_data_store
                    where app_namespace = ${namespace}
                `;
                await sql.end();
            }
        },
        60_000,
    );
});

async function createSql(databaseUrl: string): Promise<PostgresSql> {
    const postgres = await import('postgres') as PostgresModule;
    return postgres.default(databaseUrl, { max: 5, idle_timeout: 1 });
}

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error(
            'DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1',
        );
    }

    return databaseUrl;
}

function readEnv(key: string): string | undefined {
    const globals = globalThis as GlobalEnv;
    return globals.Deno?.env.get(key) ?? globals.process?.env?.[key];
}
