import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { createGroupStateRepository } from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { AuditStamp, Group, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
    GroupTopologyManagementService,
    materializeRtcOverlayTopologyBroadcastMessage,
} from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import {
    groupStateMaintenanceRequestId,
    type GroupMaintenanceSemanticCommand,
} from '@shared-server/rallar-system/services/group-state-service.ts';
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
    RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
    RtcRttRepository,
} from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import type { RtcRttMutationCommand } from '@shared-server/rallar-system/services/rtc-topology-mutations.ts';
import {
    executeRttMutation as executeRttMutationService,
} from '@shared-server/rallar-system/services/rtc-rtt-mutation-service.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    expectPendingDirectResourceOutboxEvidence,
    findDirectResourceOutboxEvidence,
} from './direct-resource-outbox-evidence.ts';

type PostgresSql = PSqlSql & Readonly<{
    end(): Promise<void>;
}>;
type TopologyWorkerInput = Readonly<{
    command: 'topology-config-put' | 'topology-config-delete';
    groupRef: GroupRef;
    atEpochMs: number;
    traceFilePath: string;
    barrier: Readonly<{ readyFilePath: string; releaseFilePath: string }>;
    request: Readonly<Record<string, unknown>>;
}>;
type TopologyWorkerOutput = Readonly<{
    operation: TopologyWorkerInput['command'];
    requestId: string;
    commandHash: string;
    attemptCount: number;
    acceptedStorageRevision: number | null;
    acceptedCausalRevision: Readonly<Record<string, unknown>> | null;
    acceptedVersion: number | null;
    outboxIds: readonly string[];
    domainStatus: 'applied' | 'no-op' | 'rejected';
}>;
type TopologyWorkerTrace = Readonly<{
    backendPid: number;
    barrierWaitCount: number;
    sleeps: readonly Readonly<{ delayMs: number; inTransaction: boolean }>[];
    phases: readonly Readonly<{
        component: string;
        operation: string;
        status: 'ok' | 'error';
        attempt: number | null;
        backoffMs: number | null;
    }>[];
}>;
type TopologyWorkerHandle = Readonly<{ done: Promise<TopologyWorkerOutput> }>;

const ROOT_DENO_CONFIG_PATH = fileURLToPath(new URL('../../../deno.json', import.meta.url));
const STATE_MUTATION_WORKER_PATH = fileURLToPath(
    new URL('./fixtures/postgres-expiry-worker.ts', import.meta.url),
);

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
const task8PostScenarioIt = POSTGRES_INTEGRATION_ENABLED &&
        readEnv('RALLAR_TASK8_REPORT_PATH')
    ? it
    : it.skip;

type TestExecuteRttMutationInput = Omit<
    Parameters<typeof executeRttMutationService>[0],
    'request' | 'readCommand'
> & Readonly<{
    command: RtcRttMutationCommand;
    readCommand?: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
}>;

function executeRttMutation(input: TestExecuteRttMutationInput) {
    const { command, readCommand, ...rest } = input;
    return executeRttMutationService({
        ...rest,
        request: { rtt: command.rtt, alSenderId: command.alSenderId },
        readCommand: readCommand ?? (() => command),
    });
}

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
                () => {
                    createCalls += 1;
                    if (createCalls === 1) {
                        return Promise.resolve(firstClient);
                    }
                    throw setupFailure;
                },
                () => {
                    runCalls += 1;
                    return Promise.resolve();
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
                () => {
                    createCalls += 1;
                    if (createCalls === 1) {
                        return Promise.resolve(firstClient);
                    }
                    throw setupFailure;
                },
                () => Promise.resolve(),
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
                () => Promise.resolve(client),
                () => Promise.resolve(undefined),
            ),
        ).rejects.toMatchObject({
            errors: [cleanupFailure],
        });
        expect(endCalls).toBe(1);
    });

    postgresIt(
        'preserves protected RTC receipt families during generic live expiry',
        async () => {
            const sql = await createSql(requireDatabaseUrl());
            const repository = new PSqlRuntimeStateRepository(sql);
            const ordinaryNamespace = `runtime-expiry-${crypto.randomUUID()}`;
            const key = `expiry-${crypto.randomUUID()}`;
            const expiredAtEpochMs = Date.now() - 1_000;
            try {
                for (const namespace of [
                    ...RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
                    ordinaryNamespace,
                ]) {
                    await expect(repository.insertIfAbsent(
                        namespace,
                        key,
                        '{}',
                        expiredAtEpochMs,
                    )).resolves.toMatchObject({ status: 'applied' });
                }

                await expect(repository.deleteAllExpired(
                    RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
                )).resolves.toBeGreaterThanOrEqual(1);
                await expect(repository.findEntry(ordinaryNamespace, key))
                    .resolves.toBeUndefined();
                for (const namespace of RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES) {
                    await expect(repository.findEntry(namespace, key))
                        .resolves.toBeDefined();
                }
            } finally {
                await sql`
                    delete from runtime_state_store
                    where store_namespace in ${sql([
                        ...RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
                        ordinaryNamespace,
                    ])}
                      and store_key = ${key}
                `;
                await sql.end();
            }
        },
        60_000,
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
                const resourceIds = results.map(({ receipt }) => receipt.outboxId!);
                const entries = await findDirectResourceOutboxEvidence(firstSql, resourceIds);
                expectPendingDirectResourceOutboxEvidence(entries, resourceIds);
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
        'rejects topology worker inputs without request ids before mutation',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-worker-request-id-${crypto.randomUUID()}`;
            const groupRef = {
                applicationId,
                workspaceId: 'concurrency',
                groupId: 'room',
            };
            const setupSql = await createSql(databaseUrl);
            const runtime = new PSqlRuntimeStateRepository(setupSql);
            const groupState = new GroupStateRepository(runtime);
            const tmpDirPath = await mkdtemp(path.join(tmpdir(), 'rallar-topology-request-id-'));
            const input: TopologyWorkerInput = {
                command: 'topology-config-put',
                groupRef,
                atEpochMs: 2,
                traceFilePath: path.join(tmpDirPath, 'trace.json'),
                barrier: {
                    readyFilePath: path.join(tmpDirPath, 'ready.json'),
                    releaseFilePath: path.join(tmpDirPath, 'release'),
                },
                request: {
                    config: { topologyKind: 'tree', degreeLimit: 2 },
                    updatedByPrincipalId: 'owner',
                },
            };
            let handle: TopologyWorkerHandle | undefined;
            try {
                const snapshot = topologyGroupSnapshot(groupRef);
                expect(await groupState.insertGroup(snapshot.group))
                    .toMatchObject({ status: 'applied' });
                for (const member of snapshot.members) await groupState.putMember(member);
                await writeFile(input.barrier.releaseFilePath, 'release', 'utf8');
                handle = spawnTopologyWorker(databaseUrl, input);

                await expect(handle.done).rejects.toThrow('requestId is required');
                expect(await new GroupTopologyConfigRepository(runtime).findConfig(groupRef))
                    .toBeUndefined();
                expect((await readTopologyWorkerTrace(input.traceFilePath)).barrierWaitCount)
                    .toBe(0);
            } finally {
                if (handle) await Promise.allSettled([handle.done]);
                await cleanupApplicationRows([setupSql], applicationId);
                await rm(tmpDirPath, { recursive: true, force: true });
            }
        },
        60_000,
    );

    postgresIt(
        'rebases independent topology put and delete workers without deleting a newer config',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-worker-${crypto.randomUUID()}`;
            const groupRef = {
                applicationId,
                workspaceId: 'concurrency',
                groupId: 'room',
            };
            const snapshot = topologyGroupSnapshot(groupRef);
            const setupSql = await createSql(databaseUrl);
            const runtime = new PSqlRuntimeStateRepository(setupSql);
            const groupState = new GroupStateRepository(runtime);
            const tmpDirPath = await mkdtemp(path.join(tmpdir(), 'rallar-topology-worker-race-'));
            const putReleaseFilePath = path.join(tmpDirPath, 'put-release');
            const deleteReleaseFilePath = path.join(tmpDirPath, 'delete-release');
            const inputs: readonly TopologyWorkerInput[] = [
                {
                    command: 'topology-config-put',
                    groupRef,
                    atEpochMs: 2,
                    traceFilePath: path.join(tmpDirPath, 'put-trace.json'),
                    barrier: {
                        readyFilePath: path.join(tmpDirPath, 'put-ready.json'),
                        releaseFilePath: putReleaseFilePath,
                    },
                    request: {
                        config: { topologyKind: 'tree', degreeLimit: 2 },
                        updatedByPrincipalId: 'owner',
                        requestId: `${applicationId}-put`,
                    },
                },
                {
                    command: 'topology-config-delete',
                    groupRef,
                    atEpochMs: 3,
                    traceFilePath: path.join(tmpDirPath, 'delete-trace.json'),
                    barrier: {
                        readyFilePath: path.join(tmpDirPath, 'delete-ready.json'),
                        releaseFilePath: deleteReleaseFilePath,
                    },
                    request: {
                        updatedByPrincipalId: 'owner',
                        requestId: `${applicationId}-delete`,
                    },
                },
            ];
            const handles: TopologyWorkerHandle[] = [];
            try {
                expect(await groupState.insertGroup(snapshot.group))
                    .toMatchObject({ status: 'applied' });
                for (const member of snapshot.members) await groupState.putMember(member);
                const topology = new GroupTopologyManagementService({
                    findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
                    groupStateRepository: groupState,
                    configRepository: new GroupTopologyConfigRepository(runtime),
                    topologyService: new RallarRtcTopologyService(),
                    now: () => 1,
                    sleep: () => Promise.resolve(),
                });
                expect((await topology.putConfig({
                    groupRef,
                    config: { topologyKind: 'mesh', degreeLimit: 3 },
                    updatedByPrincipalId: 'owner',
                    requestId: `${applicationId}-seed`,
                })).config.version).toBe(1);

                handles.push(...inputs.map((input) => spawnTopologyWorker(databaseUrl, input)));
                await Promise.all(inputs.map((input, index) =>
                    waitForTopologyWorkerBarrier(input.barrier.readyFilePath, handles[index]!)
                ));
                await writeFile(deleteReleaseFilePath, 'release', 'utf8');
                const deleteOutput = await handles[1]!.done;
                await writeFile(putReleaseFilePath, 'release', 'utf8');
                const outputs = [await handles[0]!.done, deleteOutput];
                outputs.forEach(expectCompactTopologyWorkerOutput);
                expect(outputs.every((output) => output.domainStatus === 'applied')).toBe(true);
                expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
                const traces = await Promise.all(inputs.map((input) =>
                    readTopologyWorkerTrace(input.traceFilePath)
                ));
                assertOneTopologyWorkerRebased(outputs, traces);
                expect(traces.every((trace) =>
                    trace.sleeps.every((sleep) => !sleep.inTransaction)
                )).toBe(true);

                const repository = new GroupTopologyConfigRepository(runtime);
                expect(await repository.findConfig(groupRef)).toMatchObject({
                    config: { topologyKind: 'tree', degreeLimit: 2 },
                    updatedByPrincipalId: 'owner',
                });
                const generation = await repository.findGenerationEntry(groupRef, 'config');
                expect(generation?.value.version).toBe(
                    Math.max(...outputs.map((output) => output.acceptedVersion ?? 0)),
                );
                expect(generation?.value.version).toBe(3);
                expect(await repository.findConfig(groupRef)).toMatchObject({ version: 3 });
                await expectPendingTopologyWorkerOutboxes(runtime, outputs);
                expect(JSON.stringify(outputs)).not.toMatch(
                    /DATABASE_URL|accessToken|commandMac|app:app/u,
                );
            } finally {
                await Promise.allSettled(handles.map((handle) => handle.done));
                await cleanupApplicationRows([setupSql], applicationId);
                await rm(tmpDirPath, { recursive: true, force: true });
            }
        },
        60_000,
    );

    task8PostScenarioIt(
        'binds live maintenance and final topology receipts to Postgres state',
        async () => {
            const reportPath = readEnv('RALLAR_TASK8_REPORT_PATH');
            if (!reportPath) throw new Error('RALLAR_TASK8_REPORT_PATH is required');
            const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
                resultsByName?: Record<string, Array<{
                    actual?: { body?: { receipt?: Record<string, unknown> } };
                }>>;
                outputs?: Record<string, unknown>;
            };
            const receipt = report.resultsByName?.putFinalTopologyConfig?.[0]
                ?.actual?.body?.receipt;
            if (!receipt) throw new Error('Final topology receipt is absent from the report');
            const outboxIds = receipt.outboxIds;
            const groupRef = receipt.groupRef;
            const ownerClientId = report.outputs?.ownerClientId;
            const reusedSessionId = report.outputs?.reusedSessionId;
            const expiryProbeSessionId = report.outputs?.expiryProbeSessionId;
            const expiredPresenceAtEpochMs = report.outputs?.expiredPresenceAtEpochMs;
            const expandedRecipe = JSON.parse(await readFile(
                path.join(path.dirname(reportPath), 'expanded-recipe.json'),
                'utf8',
            )) as {
                recipe?: {
                    variables?: Record<string, unknown>;
                    steps?: Array<{
                        name?: unknown;
                        request?: { body?: Record<string, unknown> };
                    }>;
                };
            };
            const runId = expandedRecipe.recipe?.variables?.runId;
            const expiryProbeGenerationTemplate = expandedRecipe.recipe?.steps?.find((step) =>
                step.name === 'connectExpiredPresenceProbe'
            )?.request?.body?.generationId;
            const reusedGenerationOneTemplate = expandedRecipe.recipe?.steps?.find((step) =>
                step.name === 'connectReusedSessionGenerationOne'
            )?.request?.body?.generationId;
            if (
                !Array.isArray(outboxIds) || outboxIds.length !== 1 ||
                typeof outboxIds[0] !== 'string' || outboxIds[0].length === 0 ||
                !isGroupRefRecord(groupRef) ||
                typeof ownerClientId !== 'string' || ownerClientId.length === 0 ||
                typeof reusedSessionId !== 'string' || reusedSessionId.length === 0 ||
                typeof expiryProbeSessionId !== 'string' ||
                expiryProbeSessionId.length === 0 ||
                typeof expiredPresenceAtEpochMs !== 'number' ||
                !Number.isSafeInteger(expiredPresenceAtEpochMs) ||
                expiredPresenceAtEpochMs <= 0 ||
                typeof runId !== 'string' || runId.length === 0 ||
                typeof expiryProbeGenerationTemplate !== 'string' ||
                typeof reusedGenerationOneTemplate !== 'string'
            ) {
                throw new Error('Scenario receipt or presence identity is invalid');
            }
            const expiryProbeGenerationId = expiryProbeGenerationTemplate.replaceAll(
                '{runId}',
                runId,
            );
            const reusedGenerationOneId = reusedGenerationOneTemplate.replaceAll(
                '{runId}',
                runId,
            );

            const sql = await createSql(requireDatabaseUrl());
            try {
                const runtime = new PSqlRuntimeStateRepository(sql);
                const entries = await findDirectResourceOutboxEvidence(sql, outboxIds);
                expect(entries).toHaveLength(1);
                expect(entries[0]?.resource).toContain(receipt.commandId);
                expect(await new GroupTopologyConfigRepository(runtime).findConfig(groupRef))
                    .toMatchObject({
                        version: receipt.acceptedVersion,
                        requestId: receipt.requestId,
                        config: receipt.acceptedConfig,
                    });
                const groupRepository = createGroupStateRepository(runtime);
                expect(await groupRepository.findPresenceEntry({
                    ...groupRef,
                    sessionId: reusedSessionId,
                })).toMatchObject({
                    value: {
                        sessionId: reusedSessionId,
                        generationId: expect.stringMatching(/^generation-2-/u),
                        status: 'active',
                        disconnectedAtEpochMs: null,
                    },
                });
                await expect(groupRepository.findPresenceEntry({
                    ...groupRef,
                    sessionId: expiryProbeSessionId,
                })).resolves.toBeUndefined();
                const expiryEvents = (await groupRepository.listEvents(groupRef))
                    .filter((event) =>
                        event.eventType === 'session-disconnected' &&
                        event.reason === 'expired'
                    );
                expect(expiryEvents).toHaveLength(1);
                const expiryEvent = expiryEvents[0];
                if (!expiryEvent) throw new Error('Expiry event is absent from Postgres');
                expect(expiryEvent).toMatchObject({
                    ...groupRef,
                    eventType: 'session-disconnected',
                    reason: 'expired',
                    traceId: null,
                    payload: {},
                    actor: {
                        kind: 'service',
                        serviceId: expect.stringMatching(/\S/u),
                    },
                });
                const expirySemanticCommand: GroupMaintenanceSemanticCommand = {
                    operation: 'disconnectPresence',
                    aggregateRef: groupRef,
                    sessionId: expiryProbeSessionId,
                    input: {
                        principalId: ownerClientId,
                        generationId: expiryProbeGenerationId,
                        generationVersion: expiredPresenceAtEpochMs,
                        observedExpiresAtEpochMs: expiredPresenceAtEpochMs,
                        disconnectedAtEpochMs: expiryEvent.occurredAtEpochMs,
                        lastHeartbeatAtEpochMs: expiredPresenceAtEpochMs,
                        expiresAtEpochMs: expiredPresenceAtEpochMs,
                        actorPrincipalId: null,
                        actorSessionId: null,
                        reason: 'expired',
                        traceId: null,
                    },
                };
                expect(expiryEvent.requestId).toBe(
                    groupStateMaintenanceRequestId('expiry', expirySemanticCommand),
                );
                const reusedGenerationOneCommand: GroupMaintenanceSemanticCommand = {
                    ...expirySemanticCommand,
                    sessionId: reusedSessionId,
                    input: {
                        ...expirySemanticCommand.input,
                        generationId: reusedGenerationOneId,
                    },
                };
                expect(expiryEvent.requestId).not.toBe(
                    groupStateMaintenanceRequestId('expiry', reusedGenerationOneCommand),
                );
            } finally {
                await sql.end();
            }
        },
        30_000,
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
                    deleted: null,
                    snapshotVersion: current!.value.snapshotVersion + 1,
                    updated: audit(2),
                    archived: audit(2),
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
                const [{ count }] = await clients[0]!<{ count: number }[]>`
                    select count(*)::int as count
                    from runtime_state_store
                    where ri_resource_id like ${`%${applicationId}%`}
                `;
                expect(count).toBe(0);
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

function spawnTopologyWorker(
    databaseUrl: string,
    input: TopologyWorkerInput,
): TopologyWorkerHandle {
    const child = spawn(process.env.DENO_BIN ?? 'deno', [
        'run', '-A', '--unstable-temporal', '--node-modules-dir=none', '--no-lock',
        '--config', ROOT_DENO_CONFIG_PATH, STATE_MUTATION_WORKER_PATH,
    ], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            RALLAR_EXPIRY_WORKER_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => stdout += chunk);
    child.stderr.on('data', (chunk: string) => stderr += chunk);
    return {
        done: new Promise<TopologyWorkerOutput>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Topology worker failed (${code})\n${stdout}\n${stderr}`));
                    return;
                }
                const lastLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
                if (!lastLine) {
                    reject(new Error(`Topology worker produced no JSON\n${stderr}`));
                    return;
                }
                try {
                    resolve(JSON.parse(lastLine) as TopologyWorkerOutput);
                } catch (error) {
                    reject(new Error(`Topology worker produced invalid JSON: ${lastLine}`, {
                        cause: error,
                    }));
                }
            });
        }),
    };
}

async function waitForTopologyWorkerBarrier(
    readyFilePath: string,
    handle: TopologyWorkerHandle,
): Promise<void> {
    const waitForFile = async (): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            try {
                await readFile(readyFilePath, 'utf8');
                return;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        throw new Error(`Timed out waiting for topology worker barrier: ${readyFilePath}`);
    };
    await Promise.race([
        waitForFile(),
        handle.done.then(() => {
            throw new Error(`Topology worker exited before barrier: ${readyFilePath}`);
        }),
    ]);
}

async function readTopologyWorkerTrace(traceFilePath: string): Promise<TopologyWorkerTrace> {
    return JSON.parse(await readFile(traceFilePath, 'utf8')) as TopologyWorkerTrace;
}

function expectCompactTopologyWorkerOutput(output: TopologyWorkerOutput): void {
    expect(Object.keys(output).sort()).toEqual([
        'acceptedCausalRevision', 'acceptedStorageRevision', 'acceptedVersion',
        'attemptCount', 'commandHash', 'domainStatus', 'operation', 'outboxIds', 'requestId',
    ]);
    expect(output.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(output.requestId).toMatch(/\S/u);
    expect(output.attemptCount).toBeGreaterThanOrEqual(1);
    expect(output.attemptCount).toBeLessThanOrEqual(3);
    if (output.domainStatus === 'applied') {
        expect(output.outboxIds).toHaveLength(1);
        expect(output.outboxIds[0]).toMatch(/\S/u);
    }
}

async function expectPendingTopologyWorkerOutboxes(
    sql: PSqlSql,
    outputs: readonly TopologyWorkerOutput[],
): Promise<void> {
    outputs.forEach((output) => {
        expect(output.domainStatus).toBe('applied');
        expect(output.outboxIds).toHaveLength(1);
        expect(output.outboxIds[0]).toMatch(/\S/u);
    });
    const outboxIds = outputs.map((output) => output.outboxIds[0]!);
    expect(new Set(outboxIds).size).toBe(outboxIds.length);
    expectPendingDirectResourceOutboxEvidence(
        await findDirectResourceOutboxEvidence(sql, outboxIds),
        outboxIds,
    );
}

function isGroupRefRecord(value: unknown): value is GroupRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return ['applicationId', 'workspaceId', 'groupId'].every((key) =>
        typeof record[key] === 'string' && record[key].length > 0
    );
}

function assertOneTopologyWorkerRebased(
    outputs: readonly TopologyWorkerOutput[],
    traces: readonly TopologyWorkerTrace[],
): void {
    expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
    expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
    const loserIndex = outputs.findIndex((output) => output.attemptCount === 2);
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    const loser = traces[loserIndex]!;
    for (const phase of ['mutation.read', 'mutation.compute', 'mutation.validate']) {
        expect(loser.phases.filter((event) => event.operation === phase)
            .map((event) => event.attempt)).toEqual([0, 1]);
    }
    expect(loser.phases.filter((event) => event.operation === 'mutation.conflict'))
        .toHaveLength(1);
    expect(loser.sleeps).toContainEqual({ delayMs: 2, inTransaction: false });
    expect(traces.flatMap((trace) => trace.phases)
        .filter((event) => event.operation === 'mutation.conflict')).toHaveLength(1);
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

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}

function topologyGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: {
            ...groupRef,
            slug: null,
            displayName: 'Topology concurrency room',
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            created: audit(1),
            updated: audit(1),
        },
        members: [{
            ...groupRef,
            principalId: 'owner',
            role: 'owner',
            status: 'active',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: audit(1),
            updated: audit(1),
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
        sourceGroupStateCausalRevision: {
            groupRevision: 1,
            presenceRevision: 0,
        },
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
    const createdAtEpochMs = 1;
    const message = materializeRtcOverlayTopologyBroadcastMessage(
        topologyGroupSnapshot(snapshot.groupRef),
        snapshot,
        {
            workId,
            createdAtEpochMs,
            expiresAtEpochMs: createdAtEpochMs + 60_000,
        },
    );
    return {
        publicationId: `${workId}:${snapshot.sourceGroupStateCausalRevision.groupRevision}:${snapshot.sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`,
        workId,
        groupRef: snapshot.groupRef,
        sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 1,
        recipientSessionIds: snapshot.activeSessionIds,
        message,
        createdAtEpochMs,
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
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: audit(1),
            updated: audit(1),
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
            status: 'active' as const,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
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
