import { describe, expect, it } from 'vitest';

import { RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    createRuntimeStatePostgresSql as createSql,
    requirePostgresClient as requireClient,
    requirePostgresDatabaseUrl as requireDatabaseUrl,
    withPostgresClients
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres runtime-state optimistic concurrency', () => {
    postgresIt(
        'preserves protected RTC receipt families during generic live expiry',
        async () => {
            const sql = await createSql(requireDatabaseUrl());
            const repository = new PSqlRuntimeStateRepository(sql);
            const ordinaryNamespace = `runtime-expiry-${crypto.randomUUID()}`;
            const key = `expiry-${crypto.randomUUID()}`;
            const expiredAtEpochMs = Date.now() - 1_000;
            try {
                for (
                    const namespace of [
                        ...RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
                        ordinaryNamespace
                    ]
                ) {
                    await expect(
                        repository.insertIfAbsent(namespace, key, '{}', new Date(expiredAtEpochMs).toISOString())
                    ).resolves.toMatchObject({ status: 'applied' });
                }

                await expect(
                    repository.deleteAllExpired(RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES)
                ).resolves.toBeGreaterThanOrEqual(1);
                await expect(repository.findEntry(ordinaryNamespace, key)).resolves.toBeUndefined();
                for (const namespace of RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES) {
                    await expect(repository.findEntry(namespace, key)).resolves.toBeDefined();
                }
            }
            finally {
                await sql`
                    delete from runtime_state_store
                    where store_namespace in ${
                    sql([
                        ...RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
                        ordinaryNamespace
                    ])
                }
                      and store_key = ${key}
                `;
                await sql.end();
            }
        },
        60_000
    );

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
                    const firstRepository = new PSqlRuntimeStateRepository(firstSql);
                    const secondRepository = new PSqlRuntimeStateRepository(secondSql);

                    expect(firstSql).not.toBe(secondSql);
                    await expect(
                        firstRepository.insertIfAbsent(namespace, key, 'seed', new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString())
                    ).resolves.toEqual({ status: 'applied', revision: 0 });

                    const [firstObservation, secondObservation] = await Promise.all([
                        firstRepository.findEntry(namespace, key),
                        secondRepository.findEntry(namespace, key)
                    ]);
                    expect(firstObservation?.revision).toBe(0);
                    expect(secondObservation?.revision).toBe(0);

                    const updateResults = await Promise.all([
                        firstRepository.upsertIfRevision(
                            namespace,
                            key,
                            updateValues[0],
                            new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString(),
                            firstObservation?.revision ?? -1
                        ),
                        secondRepository.upsertIfRevision(
                            namespace,
                            key,
                            updateValues[1],
                            new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString(),
                            secondObservation?.revision ?? -1
                        )
                    ]);
                    const winningUpdateIndex = updateResults.findIndex(
                        (result) => result.status === 'applied'
                    );
                    expect(updateResults.filter((result) => result.status === 'applied')).toHaveLength(1);
                    expect(updateResults.filter((result) => result.status === 'conflict')).toHaveLength(1);

                    await expect(firstRepository.findEntry(namespace, key)).resolves.toMatchObject({
                        value: updateValues[winningUpdateIndex],
                        revision: 1
                    });

                    const [firstRefresh, secondRefresh] = await Promise.all([
                        firstRepository.findEntry(namespace, key),
                        secondRepository.findEntry(namespace, key)
                    ]);
                    expect(firstRefresh?.revision).toBe(1);
                    expect(secondRefresh?.revision).toBe(1);

                    const deleteResults = await Promise.all([
                        firstRepository.deleteIfRevision(namespace, key, firstRefresh?.revision ?? -1),
                        secondRepository.deleteIfRevision(namespace, key, secondRefresh?.revision ?? -1)
                    ]);
                    expect(deleteResults.filter((result) => result.status === 'applied')).toHaveLength(1);
                    expect(deleteResults.filter((result) => result.status === 'conflict')).toHaveLength(1);
                    await expect(secondRepository.findEntry(namespace, key)).resolves.toBeUndefined();
                }
            );
        },
        60_000
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
                    const repository = new PSqlRuntimeStateRepository(requireClient(clients, 0));

                    await repository.begin(async (transactionRepository) => {
                        await expect(
                            transactionRepository.insertIfAbsent(
                                namespace,
                                'outer',
                                'outer-value',
                                new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
                            )
                        ).resolves.toEqual({ status: 'applied', revision: 0 });

                        await expect(
                            transactionRepository.begin(async (nestedRepository) => {
                                await nestedRepository.insertIfAbsent(
                                    namespace,
                                    'rolled-back',
                                    'nested-value',
                                    new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
                                );
                                throw new Error('rollback nested savepoint');
                            })
                        ).rejects.toThrow('rollback nested savepoint');

                        await expect(
                            transactionRepository.begin(
                                async (nestedRepository) =>
                                    await nestedRepository.insertIfAbsent(
                                        namespace,
                                        'committed',
                                        'nested-value',
                                        new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
                                    )
                            )
                        ).resolves.toEqual({ status: 'applied', revision: 0 });
                    });

                    await expect(repository.findEntry(namespace, 'outer')).resolves.toMatchObject({
                        value: 'outer-value',
                        revision: 0
                    });
                    await expect(repository.findEntry(namespace, 'committed')).resolves.toMatchObject({
                        value: 'nested-value',
                        revision: 0
                    });
                    await expect(repository.findEntry(namespace, 'rolled-back')).resolves.toBeUndefined();
                }
            );
        },
        60_000
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
                    await expect(repository.findEntry(namespace, key)).resolves.toMatchObject({
                        value: 'original',
                        revision: Number.MAX_SAFE_INTEGER
                    });

                    await expect(
                        repository.upsertIfRevision(
                            namespace,
                            key,
                            'changed',
                            new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString(),
                            Number.MAX_SAFE_INTEGER
                        )
                    ).resolves.toEqual({ status: 'conflict' });

                    const rows = await sql<
                        Array<{
                            store_value: string;
                            revision: string;
                        }>
                    >`
                        select store_value, revision
                        from runtime_state_store
                        where store_namespace = ${namespace}
                          and store_key = ${key}
                    `;
                    expect(rows).toEqual([
                        {
                            store_value: 'original',
                            revision: String(Number.MAX_SAFE_INTEGER)
                        }
                    ]);
                    await expect(
                        repository.deleteIfRevision(namespace, key, Number.MAX_SAFE_INTEGER)
                    ).resolves.toEqual({ status: 'applied' });
                }
            );
        },
        60_000
    );
});
