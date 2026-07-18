import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';

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

describe('Postgres runtime-state conditional-write concurrency', () => {
    postgresIt(
        'allows one independent writer to update and delete each revision',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const firstSql = await createSql(databaseUrl);
            const secondSql = await createSql(databaseUrl);
            const firstRepository = new PSqlRuntimeStateRepository(firstSql);
            const secondRepository = new PSqlRuntimeStateRepository(secondSql);
            const namespace = `runtime-state-concurrency-${crypto.randomUUID()}`;
            const key = 'shared-key';
            const updateValues = ['first-writer', 'second-writer'] as const;

            try {
                expect(firstSql).not.toBe(secondSql);
                await expect(
                    firstRepository.insertIfAbsent(
                        namespace,
                        key,
                        'seed',
                        NEVER_EXPIRE_AT_TIMESTAMP,
                    ),
                ).resolves.toEqual({ status: 'applied', revision: 0 });

                const [firstObservation, secondObservation] = await Promise.all([
                    firstRepository.findEntry(namespace, key),
                    secondRepository.findEntry(namespace, key),
                ]);
                expect(firstObservation?.revision).toBe(0);
                expect(secondObservation?.revision).toBe(0);

                const updateResults = await Promise.all([
                    firstRepository.upsertIfRevision(
                        namespace,
                        key,
                        updateValues[0],
                        NEVER_EXPIRE_AT_TIMESTAMP,
                        firstObservation?.revision ?? -1,
                    ),
                    secondRepository.upsertIfRevision(
                        namespace,
                        key,
                        updateValues[1],
                        NEVER_EXPIRE_AT_TIMESTAMP,
                        secondObservation?.revision ?? -1,
                    ),
                ]);
                const winningUpdateIndex = updateResults.findIndex(
                    (result) => result.status === 'applied',
                );
                expect(updateResults.filter((result) => result.status === 'applied'))
                    .toHaveLength(1);
                expect(updateResults.filter((result) => result.status === 'conflict'))
                    .toHaveLength(1);

                await expect(firstRepository.findEntry(namespace, key)).resolves
                    .toMatchObject({
                        value: updateValues[winningUpdateIndex],
                        revision: 1,
                    });

                const [firstRefresh, secondRefresh] = await Promise.all([
                    firstRepository.findEntry(namespace, key),
                    secondRepository.findEntry(namespace, key),
                ]);
                expect(firstRefresh?.revision).toBe(1);
                expect(secondRefresh?.revision).toBe(1);

                const deleteResults = await Promise.all([
                    firstRepository.deleteIfRevision(
                        namespace,
                        key,
                        firstRefresh?.revision ?? -1,
                    ),
                    secondRepository.deleteIfRevision(
                        namespace,
                        key,
                        secondRefresh?.revision ?? -1,
                    ),
                ]);
                expect(deleteResults.filter((result) => result.status === 'applied'))
                    .toHaveLength(1);
                expect(deleteResults.filter((result) => result.status === 'conflict'))
                    .toHaveLength(1);
                await expect(secondRepository.findEntry(namespace, key)).resolves
                    .toBeUndefined();
            } finally {
                await firstSql`
                    delete from runtime_state_store
                    where store_namespace = ${namespace}
                `;
                await Promise.all([firstSql.end(), secondSql.end()]);
            }
        },
        60_000,
    );
});

async function createSql(databaseUrl: string): Promise<PostgresSql> {
    const postgres = await import('postgres') as PostgresModule;
    return postgres.default(databaseUrl, { max: 1, idle_timeout: 1 });
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
