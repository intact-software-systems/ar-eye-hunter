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
    it('closes acquired clients and preserves an acquisition failure', async () => {
        const setupFailure = new Error('second client failed');
        let createCalls = 0;
        let endCalls = 0;
        let runCalls = 0;
        const firstClient = createLifecycleSql(
            () => Promise.reject(new Error('cleanup query failed')),
            () => {
                endCalls += 1;
                return Promise.resolve();
            },
        );

        await expect(
            withPostgresClients(
                'acquisition-failure',
                2,
                async () => {
                    createCalls += 1;
                    if (createCalls === 1) {
                        return firstClient;
                    }
                    throw setupFailure;
                },
                async () => {
                    runCalls += 1;
                },
            ),
        ).rejects.toBe(setupFailure);
        expect(createCalls).toBe(2);
        expect(runCalls).toBe(0);
        expect(endCalls).toBe(1);
    });

    postgresIt(
        'allows one independent writer to update and delete each revision',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const namespace = `runtime-state-concurrency-${crypto.randomUUID()}`;
            const key = 'shared-key';
            const updateValues = ['first-writer', 'second-writer'] as const;

            await withPostgresClients(
                namespace,
                2,
                async () => await createSql(databaseUrl),
                async (clients) => {
                    const firstSql = requireClient(clients, 0);
                    const secondSql = requireClient(clients, 1);
                    const firstRepository = new PSqlRuntimeStateRepository(
                        firstSql,
                    );
                    const secondRepository = new PSqlRuntimeStateRepository(
                        secondSql,
                    );

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
                },
            );
        },
        60_000,
    );

    postgresIt(
        'uses savepoints for nested optimistic transactions',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const namespace = `runtime-state-savepoint-${crypto.randomUUID()}`;

            await withPostgresClients(
                namespace,
                1,
                async () => await createSql(databaseUrl),
                async (clients) => {
                    const repository = new PSqlRuntimeStateRepository(
                        requireClient(clients, 0),
                    );

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
                },
            );
        },
        60_000,
    );

    postgresIt(
        'prevents an update from overflowing MAX_SAFE_INTEGER',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const namespace = `runtime-state-max-revision-${crypto.randomUUID()}`;
            const key = 'max-safe';

            await withPostgresClients(
                namespace,
                1,
                async () => await createSql(databaseUrl),
                async (clients) => {
                    const sql = requireClient(clients, 0);
                    const repository = new PSqlRuntimeStateRepository(sql);

                    await sql`
                        insert into runtime_state_store (
                            store_namespace,
                            store_key,
                            store_value,
                            expire_at_ts,
                            revision
                        ) values (
                            ${namespace},
                            ${key},
                            'original',
                            ${new Date(NEVER_EXPIRE_AT_TIMESTAMP)},
                            ${Number.MAX_SAFE_INTEGER}
                        )
                    `;
                    await expect(repository.findEntry(namespace, key)).resolves
                        .toMatchObject({
                            value: 'original',
                            revision: Number.MAX_SAFE_INTEGER,
                        });

                    await expect(
                        repository.upsertIfRevision(
                            namespace,
                            key,
                            'changed',
                            NEVER_EXPIRE_AT_TIMESTAMP,
                            Number.MAX_SAFE_INTEGER,
                        ),
                    ).rejects.toThrow();

                    const rows = await sql<Array<{
                        store_value: string;
                        revision: string;
                    }>>`
                        select store_value, revision
                        from runtime_state_store
                        where store_namespace = ${namespace}
                          and store_key = ${key}
                    `;
                    expect(rows).toEqual([{
                        store_value: 'original',
                        revision: String(Number.MAX_SAFE_INTEGER),
                    }]);
                    await expect(
                        repository.deleteIfRevision(
                            namespace,
                            key,
                            Number.MAX_SAFE_INTEGER,
                        ),
                    ).resolves.toEqual({ status: 'applied' });
                },
            );
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

function createLifecycleSql(
    query: () => Promise<unknown>,
    end: () => Promise<void>,
): PostgresSql {
    return Object.assign(
        () => query(),
        { end },
    ) as unknown as PostgresSql;
}

async function withPostgresClients<T>(
    namespace: string,
    clientCount: number,
    createClient: () => Promise<PostgresSql>,
    run: (clients: readonly PostgresSql[]) => Promise<T>,
): Promise<T> {
    const clients: PostgresSql[] = [];
    let hasPrimaryFailure = false;

    try {
        for (let index = 0; index < clientCount; index += 1) {
            clients.push(await createClient());
        }
        return await run(clients);
    } catch (error) {
        hasPrimaryFailure = true;
        throw error;
    } finally {
        await cleanupRuntimeState(
            namespace,
            clients[0],
            clients,
            hasPrimaryFailure,
        );
    }
}

function requireClient(
    clients: readonly PostgresSql[],
    index: number,
): PostgresSql {
    const client = clients[index];
    if (!client) {
        throw new Error(`Expected Postgres client at index ${index}.`);
    }
    return client;
}

async function cleanupRuntimeState(
    namespace: string,
    cleanupSql: PostgresSql | undefined,
    clients: readonly PostgresSql[],
    hasPrimaryFailure: boolean,
): Promise<void> {
    const failures: unknown[] = [];
    if (cleanupSql) {
        const deleteResult = await Promise.allSettled([
            cleanupSql`
                delete from runtime_state_store
                where store_namespace = ${namespace}
            `,
        ]);
        if (deleteResult[0].status === 'rejected') {
            failures.push(deleteResult[0].reason);
        }
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
