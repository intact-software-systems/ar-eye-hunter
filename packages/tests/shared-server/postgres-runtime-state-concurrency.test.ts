import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { Group, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { StateMutationOutboxRepository } from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
    RtcTopologyExecutionRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
    RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    RTC_RTT_LATEST_NAMESPACE,
    RtcRttRepository,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import { executeRttMutation } from '@shared-server/rallar-system/services/rtc-topology-mutations.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    newALBroadcastMessage,
    newALRoute,
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';

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

    it('closes acquired clients and preserves an acquisition failure when cleanup throws synchronously', async () => {
        const setupFailure = new Error('second client failed');
        const cleanupFailure = new Error('cleanup query threw synchronously');
        let createCalls = 0;
        let endCalls = 0;
        const firstClient = createLifecycleSql(
            () => {
                throw cleanupFailure;
            },
            () => {
                endCalls += 1;
                return Promise.resolve();
            },
        );

        await expect(
            withPostgresClients(
                'synchronous-cleanup-acquisition-failure',
                2,
                async () => {
                    createCalls += 1;
                    if (createCalls === 1) {
                        return firstClient;
                    }
                    throw setupFailure;
                },
                async () => {},
            ),
        ).rejects.toBe(setupFailure);
        expect(createCalls).toBe(2);
        expect(endCalls).toBe(1);
    });

    it('aggregates a cleanup-only synchronous query failure after closing clients', async () => {
        const cleanupFailure = new Error('cleanup query threw synchronously');
        let endCalls = 0;
        const client = createLifecycleSql(
            () => {
                throw cleanupFailure;
            },
            () => {
                endCalls += 1;
                return Promise.resolve();
            },
        );

        await expect(
            withPostgresClients(
                'synchronous-cleanup-only-failure',
                1,
                async () => client,
                async () => undefined,
            ),
        ).rejects.toMatchObject({
            errors: [cleanupFailure],
        });
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
        'converges true-overlap topology config transactions across independent clients',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-postgres-${crypto.randomUUID()}`;
            const groupRef = {
                applicationId,
                workspaceId: 'concurrency',
                groupId: 'room',
            };
            const snapshot = topologyGroupSnapshot(groupRef);
            const clients = [await createSql(databaseUrl), await createSql(databaseUrl)];
            try {
                const barrier = createReadBarrier(2);
                const firstRuntime = new BarrierRuntimeStateRepository(
                    clients[0]!,
                    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                    barrier,
                );
                const secondRuntime = new BarrierRuntimeStateRepository(
                    clients[1]!,
                    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                    barrier,
                );
                const groupStateRepository = new GroupStateRepository(firstRuntime);
                expect(await groupStateRepository.insertGroup(snapshot.group))
                    .toMatchObject({ status: 'applied' });
                for (const member of snapshot.members) {
                    await groupStateRepository.putMember(member);
                }
                const service = (runtime: PSqlRuntimeStateRepository) =>
                    new GroupTopologyManagementService({
                        findGroupSnapshotByRef: () => snapshot,
                        groupStateRepository: new GroupStateRepository(runtime),
                        configRepository: new GroupTopologyConfigRepository(runtime),
                        topologyService: new RallarRtcTopologyService(),
                        sleep: () => Promise.resolve(),
                    });

                const results = await Promise.all([
                    service(firstRuntime).putConfig({
                        groupRef,
                        config: { topologyKind: 'tree' },
                        updatedByPrincipalId: 'owner',
                        requestId: `${applicationId}-a`,
                    }),
                    service(secondRuntime).putConfig({
                        groupRef,
                        config: { topologyKind: 'mesh' },
                        updatedByPrincipalId: 'owner',
                        requestId: `${applicationId}-b`,
                    }),
                ]);

                expect(results.map(({ config }) => config.version).sort())
                    .toEqual([1, 2]);
                const repository = new GroupTopologyConfigRepository(firstRuntime);
                expect(await repository.findMutationRecord(groupRef, `${applicationId}-a`))
                    .toBeDefined();
                expect(await repository.findMutationRecord(groupRef, `${applicationId}-b`))
                    .toBeDefined();
                expect(await repository.findGenerationEntry(groupRef, 'config'))
                    .toMatchObject({ value: { version: 2 }, entry: { revision: 1 } });
                expect(await repository.findInvariantGenerationEntry(groupRef))
                    .toMatchObject({
                        value: { version: 2 },
                        entry: {
                            key: repository.invariantGenerationKey(groupRef),
                            revision: 1,
                        },
                    });
                const outbox = new StateMutationOutboxRepository(firstRuntime);
                const exactRecords = await Promise.all(results.map(({ receipt }) =>
                    outbox.find(receipt.outboxId!)
                ));
                expect(exactRecords.map((stored) => stored?.record.commandId).sort())
                    .toEqual([`${applicationId}-a`, `${applicationId}-b`]);
                expect(exactRecords.every((stored) =>
                    stored?.record.effects.length === 1 &&
                    stored.record.effects[0] === 'rtc-topology-recompute'
                )).toBe(true);
            } finally {
                await Promise.allSettled(clients.map(async (client) => {
                    await client`
                        delete from runtime_state_store
                        where store_value like ${`%${applicationId}%`}
                    `;
                }));
                await Promise.allSettled(clients.map(async (client) => await client.end()));
            }
        },
        60_000,
    );

    postgresIt(
        'revalidates true-overlap config and override writes against one invariant surface',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-cross-target-${crypto.randomUUID()}`;
            const groupRef = {
                applicationId,
                workspaceId: 'concurrency',
                groupId: 'room',
            };
            const snapshot = topologyGroupSnapshot(groupRef);
            const clients = [await createSql(databaseUrl), await createSql(databaseUrl)];
            try {
                const barrier = createReadBarrier(2);
                const firstRuntime = new BarrierRuntimeStateRepository(
                    clients[0]!,
                    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                    barrier,
                );
                const secondRuntime = new BarrierRuntimeStateRepository(
                    clients[1]!,
                    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
                    barrier,
                );
                const groupStateRepository = new GroupStateRepository(firstRuntime);
                expect(await groupStateRepository.insertGroup(snapshot.group))
                    .toMatchObject({ status: 'applied' });
                for (const member of snapshot.members) {
                    await groupStateRepository.putMember(member);
                }
                const service = (runtime: PSqlRuntimeStateRepository) =>
                    new GroupTopologyManagementService({
                        findGroupSnapshotByRef: () => snapshot,
                        groupStateRepository: new GroupStateRepository(runtime),
                        configRepository: new GroupTopologyConfigRepository(runtime),
                        topologyService: new RallarRtcTopologyService(),
                        sleep: () => Promise.resolve(),
                    });

                const settled = await Promise.allSettled([
                    service(firstRuntime).putConfig({
                        groupRef,
                        config: { meshParamK: 4 },
                        updatedByPrincipalId: 'owner',
                        requestId: `${applicationId}-config`,
                    }),
                    service(secondRuntime).putOverride({
                        groupRef,
                        config: { degreeLimit: 3 },
                        expiresAtEpochMs: Date.now() + 60_000,
                        updatedByPrincipalId: 'owner',
                        requestId: `${applicationId}-override`,
                    }),
                ]);

                expect(settled.filter(({ status }) => status === 'fulfilled'))
                    .toHaveLength(1);
                expect(settled.filter(({ status }) => status === 'rejected'))
                    .toEqual([expect.objectContaining({
                        reason: expect.objectContaining({
                            code: 'group-topology-config-validation-failed',
                        }),
                    })]);
                const repository = new GroupTopologyConfigRepository(firstRuntime);
                const [durable, temporary] = await Promise.all([
                    repository.findConfig(groupRef),
                    repository.findOverride(groupRef),
                ]);
                expect(Number(durable !== undefined) + Number(temporary !== undefined))
                    .toBe(1);
                expect(await repository.findInvariantGenerationEntry(groupRef))
                    .toMatchObject({
                        value: { version: 1 },
                        entry: {
                            key: repository.invariantGenerationKey(groupRef),
                            revision: 0,
                        },
                    });
            } finally {
                await Promise.allSettled(clients.map(async (client) => {
                    await client`
                        delete from runtime_state_store
                        where store_value like ${`%${applicationId}%`}
                    `;
                }));
                await Promise.allSettled(clients.map(async (client) => await client.end()));
            }
        },
        60_000,
    );

    postgresIt(
        'converges true-overlap topology executions across independent clients',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-execution-${crypto.randomUUID()}`;
            const groupRef = { applicationId, workspaceId: 'concurrency', groupId: 'room' };
            const clients = [await createSql(databaseUrl), await createSql(databaseUrl)];
            try {
                const barrier = createReadBarrier(2);
                const firstRuntime = new BarrierRuntimeStateRepository(
                    clients[0]!, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, barrier,
                );
                const secondRuntime = new BarrierRuntimeStateRepository(
                    clients[1]!, RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, barrier,
                );
                const first = topologyExecutionFixture(groupRef, 'first');
                const second = topologyExecutionFixture(groupRef, 'second');
                const repositories = [
                    new RtcTopologyExecutionRepository(firstRuntime),
                    new RtcTopologyExecutionRepository(secondRuntime),
                ] as const;
                const initial = await Promise.all([
                    repositories[0].commit({ expected: undefined, ...first }),
                    repositories[1].commit({ expected: undefined, ...second }),
                ]);
                const settled = await Promise.all(initial.map(async (result, index) =>
                    result.status === 'retry'
                        ? await repositories[index as 0 | 1].commit({
                            expected: result.current,
                            ...(index === 0 ? first : second),
                        })
                        : result
                ));

                expect(settled.filter(({ status }) => status === 'committed'))
                    .toHaveLength(1);
                expect(settled.filter(({ status }) => status === 'loaded'))
                    .toHaveLength(1);
                const storedSnapshot = await new RtcTopologySnapshotRepository(firstRuntime)
                    .findSnapshot(groupRef);
                const storedPublication = await new RtcTopologyPublicationRepository(firstRuntime)
                    .findPublicationForWork(groupRef, `${applicationId}-work`);
                expect(storedSnapshot).toBeDefined();
                expect(storedPublication).toBeDefined();
                expect(storedPublication?.overlayVersion).toBe(storedSnapshot?.version);
            } finally {
                await cleanupApplicationRows(clients, applicationId);
            }
        },
        60_000,
    );

    postgresIt(
        'converges true-overlap RTT endpoint admission across independent clients',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `rtt-execution-${crypto.randomUUID()}`;
            const a = `${applicationId}-a`;
            const b = `${applicationId}-b`;
            const c = `${applicationId}-c`;
            const clients = [await createSql(databaseUrl), await createSql(databaseUrl)];
            try {
                const barrier = createReadBarrier(2);
                const firstRuntime = new BarrierRuntimeStateRepository(
                    clients[0]!, RTC_RTT_LATEST_NAMESPACE, barrier,
                );
                const secondRuntime = new BarrierRuntimeStateRepository(
                    clients[1]!, RTC_RTT_LATEST_NAMESPACE, barrier,
                );
                const groups = [
                    rttGroupSnapshot({ applicationId, workspaceId: 'concurrency', groupId: 'ab' }, [a, b]),
                    rttGroupSnapshot({ applicationId, workspaceId: 'concurrency', groupId: 'ac' }, [a, c]),
                ] as const;
                const result = await Promise.all([
                    executeRttMutation({
                        repository: new RtcRttRepository(firstRuntime, { now: () => 1 }),
                        runtime: firstRuntime,
                        command: {
                            rtt: { sessionIdFrom: a, sessionIdTo: b, rttMs: 1, createdAtEpochMs: 1, version: 1 },
                            alSenderId: a, candidateGroups: [groups[0]],
                            overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
                        },
                        readFacts: () => ({
                            requestedAtEpochMs: 1,
                            purgeAfterEpochMs: 60_001,
                        }),
                        sleep: async () => {},
                    }),
                    executeRttMutation({
                        repository: new RtcRttRepository(secondRuntime, { now: () => 1 }),
                        runtime: secondRuntime,
                        command: {
                            rtt: { sessionIdFrom: a, sessionIdTo: c, rttMs: 2, createdAtEpochMs: 1, version: 1 },
                            alSenderId: a, candidateGroups: [groups[1]],
                            overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
                        },
                        readFacts: () => ({
                            requestedAtEpochMs: 1,
                            purgeAfterEpochMs: 60_001,
                        }),
                        sleep: async () => {},
                    }),
                ]);

                expect(result.filter(({ updated }) => updated)).toHaveLength(1);
                const stored = new RtcRttRepository(firstRuntime, { now: () => 2 });
                expect(await stored.listMeasurements()).toHaveLength(1);
                expect(await stored.listRecomputeIntents()).toHaveLength(1);
            } finally {
                await cleanupApplicationRows(clients, applicationId);
            }
        },
        60_000,
    );

    postgresIt(
        'rejects a true-overlap archive after stable authority read and before the fence CAS',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-authority-${crypto.randomUUID()}`;
            const groupRef = {
                applicationId,
                workspaceId: 'concurrency',
                groupId: 'room',
            };
            const snapshot = topologyGroupSnapshot(groupRef);
            const clients = [await createSql(databaseUrl), await createSql(databaseUrl)];
            try {
                const mutationRuntime = new PSqlRuntimeStateRepository(clients[0]!);
                const concurrentRuntime = new PSqlRuntimeStateRepository(clients[1]!);
                const seed = new GroupStateRepository(mutationRuntime);
                expect(await seed.insertGroup(snapshot.group))
                    .toMatchObject({ status: 'applied' });
                for (const member of snapshot.members) await seed.putMember(member);
                let releaseRead!: () => void;
                let markObserved!: () => void;
                const observed = new Promise<void>((resolve) => {
                    markObserved = resolve;
                });
                const release = new Promise<void>((resolve) => {
                    releaseRead = resolve;
                });
                let pauseFirstRead = true;
                class PausingGroupStateRepository extends GroupStateRepository {
                    override async readSnapshotWithAuthorityGuard(ref: GroupRef) {
                        const observation = await super
                            .readSnapshotWithAuthorityGuard(ref);
                        if (pauseFirstRead) {
                            pauseFirstRead = false;
                            markObserved();
                            await release;
                        }
                        return observation;
                    }
                }
                const topology = new GroupTopologyConfigRepository(mutationRuntime);
                const service = new GroupTopologyManagementService({
                    findGroupSnapshotByRef: () => snapshot,
                    groupStateRepository: new PausingGroupStateRepository(
                        mutationRuntime,
                    ),
                    configRepository: topology,
                    topologyService: new RallarRtcTopologyService(),
                    sleep: () => Promise.resolve(),
                });

                const mutation = service.putConfig({
                    groupRef,
                    config: { topologyKind: 'tree' },
                    updatedByPrincipalId: 'owner',
                    requestId: `${applicationId}-mutation`,
                });
                await observed;
                const concurrentGroups = new GroupStateRepository(concurrentRuntime);
                const current = await concurrentGroups.findGroupEntry(groupRef);
                expect(current).toBeDefined();
                const archived: Group = {
                    ...current!.value,
                    status: 'archived',
                    snapshotVersion: current!.value.snapshotVersion + 1,
                    updated: { atEpochMs: 2, byPrincipalId: 'owner' },
                    archived: { atEpochMs: 2, byPrincipalId: 'owner' },
                };
                expect(await concurrentGroups.updateGroup(
                    archived,
                    current!.entry.revision,
                )).toMatchObject({ status: 'applied' });
                releaseRead();

                await expect(mutation).rejects.toMatchObject({ status: 403 });
                expect(await topology.findConfig(groupRef)).toBeUndefined();
                expect(await topology.findMutationRecord(
                    groupRef,
                    `${applicationId}-mutation`,
                )).toBeUndefined();
                expect((await concurrentGroups.findGroup(groupRef))?.status)
                    .toBe('archived');
                const pending = await new StateMutationOutboxRepository(mutationRuntime)
                    .listPendingPage({ limit: 100 });
                expect(pending.records.filter(({ record }) =>
                    record.aggregateRef.applicationId === applicationId
                )).toHaveLength(0);
            } finally {
                await Promise.allSettled(clients.map(async (client) => {
                    await client`
                        delete from runtime_state_store
                        where store_value like ${`%${applicationId}%`}
                    `;
                }));
                await Promise.allSettled(clients.map(async (client) => await client.end()));
            }
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

class BarrierRuntimeStateRepository extends PSqlRuntimeStateRepository {
    constructor(
        sql: PSqlSql,
        private readonly barrierNamespace: string,
        private readonly barrier: () => Promise<void>,
    ) {
        super(sql);
    }

    override async findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        const entry = await super.findEntry(namespace, key);
        if (namespace === this.barrierNamespace) await this.barrier();
        return entry;
    }
}

function createReadBarrier(parties: number): () => Promise<void> {
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    return async () => {
        if (arrivals >= parties) return;
        arrivals += 1;
        if (arrivals === parties) release();
        await ready;
    };
}

function topologyGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: {
            ...groupRef,
            displayName: 'Topology concurrency room',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            created: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        },
        members: [{
            ...groupRef,
            principalId: 'owner',
            role: 'owner',
            status: 'active',
            joined: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        }],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0,
    };
}

function topologyExecutionFixture(
    groupRef: GroupRef,
    name: string,
): Readonly<{
    candidate: RallarOverlayTopologySnapshot;
    publication: ReturnType<typeof topologyPublication>;
}> {
    const candidate: RallarOverlayTopologySnapshot = {
        sourceGroupStateRevision: 1,
        state: 'active',
        overlayId: JSON.stringify([groupRef.applicationId, groupRef.workspaceId ?? '', groupRef.groupId]),
        groupRef,
        name,
        topology: 'tree',
        activeSessionIds: [`${groupRef.applicationId}-a`, `${groupRef.applicationId}-b`],
        nextHopsBySessionId: {
            [`${groupRef.applicationId}-a`]: [`${groupRef.applicationId}-b`],
            [`${groupRef.applicationId}-b`]: [`${groupRef.applicationId}-a`],
        },
        degreeLimit: 1,
        version: 1,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
    };
    return { candidate, publication: topologyPublication(candidate, `${groupRef.applicationId}-work`) };
}

function topologyPublication(
    snapshot: RallarOverlayTopologySnapshot,
    workId: string,
) {
    return {
        publicationId: `${workId}:${snapshot.sourceGroupStateRevision}:${snapshot.version}`,
        workId,
        groupRef: snapshot.groupRef,
        sourceGroupStateRevision: snapshot.sourceGroupStateRevision,
        overlayVersion: snapshot.version,
        recipientSessionIds: snapshot.activeSessionIds,
        message: newALBroadcastMessage(
            'rallar-server',
            newALRoute(
                AppTopics.overlayTopology,
                snapshot.groupRef.groupId,
                `${snapshot.overlayId}:${snapshot.sourceGroupStateRevision}:${snapshot.version}`,
            ),
            'room',
            AppTopics.overlayTopology,
            snapshot,
            {
                groupRef: snapshot.groupRef,
                minSnapshotVersion: 1,
                reliability: 'best-effort',
                ack: 'none',
            },
        ),
        createdAtEpochMs: 1,
    };
}

function rttGroupSnapshot(
    groupRef: GroupRef,
    sessionIds: readonly string[],
): GroupSnapshot {
    const base = topologyGroupSnapshot(groupRef);
    return {
        ...base,
        group: {
            ...base.group,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId: sessionIds[0]!,
        },
        members: sessionIds.map((sessionId, index) => ({
            ...groupRef,
            principalId: sessionId,
            role: index === 0 ? 'owner' as const : 'member' as const,
            status: 'active' as const,
            joined: { atEpochMs: 1, byPrincipalId: 'owner' },
            updated: { atEpochMs: 1, byPrincipalId: 'owner' },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            ...groupRef,
            sessionId,
            principalId: sessionId,
            generationId: `${sessionId}-generation`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

async function cleanupApplicationRows(
    clients: readonly PostgresSql[],
    applicationId: string,
): Promise<void> {
    await Promise.allSettled(clients.map(async (client) => {
        await client`
            delete from runtime_state_store
            where store_value like ${`%${applicationId}%`}
        `;
    }));
    await Promise.allSettled(clients.map(async (client) => await client.end()));
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
            Promise.resolve().then(
                () => cleanupSql`
                    delete from runtime_state_store
                    where store_namespace = ${namespace}
                `,
            ),
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
