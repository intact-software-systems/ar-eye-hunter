import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';

type PostgresSql = PSqlSql & Readonly<{
    end(): Promise<void>;
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
            let hasPrimaryFailure = false;

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
            } catch (error) {
                hasPrimaryFailure = true;
                throw error;
            } finally {
                await cleanupRuntimeState(
                    namespace,
                    firstSql,
                    [firstSql, secondSql],
                    hasPrimaryFailure,
                );
            }
        },
        60_000,
    );

    postgresIt(
        'uses savepoints for nested optimistic transactions',
        async () => {
            const sql = await createSql(requireDatabaseUrl());
            const repository = new PSqlRuntimeStateRepository(sql);
            const namespace = `runtime-state-savepoint-${crypto.randomUUID()}`;
            let hasPrimaryFailure = false;

            try {
                await repository.begin(async (transactionRepository) => {
                    await expect(
                        transactionRepository.insertIfAbsent(
                            namespace,
                            'outer',
                            'outer-value',
                            NEVER_EXPIRE_AT_TIMESTAMP,
                        ),
                    ).resolves.toEqual({ status: 'applied', revision: 0 });

                    await expect(
                        transactionRepository.begin(async (nestedRepository) => {
                            await nestedRepository.insertIfAbsent(
                                namespace,
                                'rolled-back',
                                'nested-value',
                                NEVER_EXPIRE_AT_TIMESTAMP,
                            );
                            throw new Error('rollback nested savepoint');
                        }),
                    ).rejects.toThrow('rollback nested savepoint');

                    await expect(
                        transactionRepository.begin(async (nestedRepository) =>
                            await nestedRepository.insertIfAbsent(
                                namespace,
                                'committed',
                                'nested-value',
                                NEVER_EXPIRE_AT_TIMESTAMP,
                            )
                        ),
                    ).resolves.toEqual({ status: 'applied', revision: 0 });
                });

                await expect(repository.findEntry(namespace, 'outer')).resolves
                    .toMatchObject({ value: 'outer-value', revision: 0 });
                await expect(repository.findEntry(namespace, 'committed')).resolves
                    .toMatchObject({ value: 'nested-value', revision: 0 });
                await expect(repository.findEntry(namespace, 'rolled-back')).resolves
                    .toBeUndefined();
            } catch (error) {
                hasPrimaryFailure = true;
                throw error;
            } finally {
                await cleanupRuntimeState(
                    namespace,
                    sql,
                    [sql],
                    hasPrimaryFailure,
                );
            }
        },
        60_000,
    );
});

async function createSql(databaseUrl: string): Promise<PostgresSql> {
    const postgres = await import('postgres');
    return postgres.default(
        databaseUrl,
        { max: 1, idle_timeout: 1 },
    ) as unknown as PostgresSql;
}

async function cleanupRuntimeState(
    namespace: string,
    cleanupSql: PostgresSql,
    clients: readonly PostgresSql[],
    hasPrimaryFailure: boolean,
): Promise<void> {
    const failures: unknown[] = [];
    const deleteResult = await Promise.allSettled([
        cleanupSql`
            delete from runtime_state_store
            where store_namespace = ${namespace}
        `,
    ]);
    if (deleteResult[0].status === 'rejected') {
        failures.push(deleteResult[0].reason);
    }

    const closeResults = await Promise.allSettled(
        clients.map(async (client) => await client.end()),
    );
    for (const closeResult of closeResults) {
        if (closeResult.status === 'rejected') {
            failures.push(closeResult.reason);
        }
    }

    if (!hasPrimaryFailure && failures.length > 0) {
        throw new AggregateError(
            failures,
            'Failed to clean up Postgres runtime-state integration resources.',
        );
    }
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
