import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { Group } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { expectPendingDirectResourceOutboxEvidence, findDirectResourceOutboxEvidence } from '../../../direct-resource-outbox-evidence.ts';
import { findSingleRetriedAppInboxAttemptSequence } from '../../../fixtures/postgres-app-inbox-worker-runtime.ts';
import { toOwnedAppInboxResourceIds } from '../../../postgres-app-inbox-attempt-evidence.ts';
import {
    cleanupTopologyApplicationRows,
    createPostgresSql,
    readTopologyWorkerTrace,
    seedTopologyGroup,
    spawnTopologyAppInboxWorker,
    topologyGroupSnapshot,
    waitForTopologyWorkerParticipants,
    type TopologyAppInboxWorkerInput
} from './postgres-topology-concurrency-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres topology AppInbox concurrency', () => {
    postgresIt(
        'converges true-overlap topology config transactions across independent clients',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-postgres-${crypto.randomUUID()}`;
            const groupRef = { applicationId, workspaceId: 'concurrency', groupId: 'room' };
            const sql = await createPostgresSql(databaseUrl);
            const tmpDirPath = await mkdtemp(path.join(tmpdir(), 'rallar-topology-config-race-'));
            const releaseFilePath = path.join(tmpDirPath, 'release');
            const inputs = topologyInputs(applicationId, groupRef, tmpDirPath, releaseFilePath, [
                { requestId: `${applicationId}-a`, config: { topologyKind: 'tree' } },
                { requestId: `${applicationId}-b`, config: { topologyKind: 'mesh' } }
            ]);
            const workers: Promise<Awaited<ReturnType<typeof spawnTopologyAppInboxWorker>>>[] = [];
            try {
                await seedTopologyGroup(sql, topologyGroupSnapshot(groupRef));
                workers.push(...inputs.map((input) => spawnTopologyAppInboxWorker(databaseUrl, input)));
                await waitForTopologyWorkerParticipants(inputs[0]!.barrier.readyDirectoryPath, 2, workers);
                await writeFile(releaseFilePath, 'release', 'utf8');
                const outputs = await Promise.all(workers);
                const traces = await Promise.all(
                    inputs.map((input) => readTopologyWorkerTrace(input.traceFilePath))
                );

                expect(outputs.map((output) => output.status)).toEqual(['applied', 'applied']);
                expect(outputs.map((output) => output.acceptedVersion).sort()).toEqual([1, 2]);
                expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
                expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
                expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
                expect(
                    findSingleRetriedAppInboxAttemptSequence({
                        traces: traces.map((trace) => ({ attempts: trace.attempts ?? [] })),
                        ownedResourceIds: toOwnedAppInboxResourceIds(outputs.map((output) => output.requestId))
                    }).map(({ attempt, classification, retryDelayMs }) => ({
                        attempt,
                        classification,
                        retryDelayMs
                    }))
                ).toEqual([
                    { attempt: 1, classification: 'retryable', retryDelayMs: 1 },
                    { attempt: 2, classification: 'accepted', retryDelayMs: 0 }
                ]);
                const repository = new GroupTopologyConfigRepository(new PSqlRuntimeStateRepository(sql));
                await expect(
                    repository.findMutationRecord(groupRef, `${applicationId}-a`)
                ).resolves.toBeDefined();
                await expect(
                    repository.findMutationRecord(groupRef, `${applicationId}-b`)
                ).resolves.toBeDefined();
                await expect(repository.findGenerationEntry(groupRef, 'config')).resolves.toMatchObject({
                    value: { version: 2 },
                    entry: { revision: 1 }
                });
                await expect(repository.findInvariantGenerationEntry(groupRef)).resolves.toMatchObject({
                    value: { version: 2 },
                    entry: { key: repository.invariantGenerationKey(groupRef), revision: 1 }
                });
                const outboxIds = outputs
                    .flatMap((output) => output.outboxIds)
                    .map(
                        (resourceId) => toAppQueueKey({ resourceId, topicId: '', contextId: '' }).resourceId
                    );
                expectPendingDirectResourceOutboxEvidence(
                    await findDirectResourceOutboxEvidence(sql, outboxIds),
                    outboxIds
                );
            }
            finally {
                await Promise.allSettled(workers);
                await cleanupTopologyApplicationRows(sql, applicationId);
                await sql.end();
                await rm(tmpDirPath, { recursive: true, force: true });
            }
        },
        60_000
    );

    postgresIt(
        'rejects a true-overlap archive after stable authority read and before the fence CAS',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-authority-${crypto.randomUUID()}`;
            const groupRef = { applicationId, workspaceId: 'concurrency', groupId: 'room' };
            const sql = await createPostgresSql(databaseUrl);
            const runtime = new PSqlRuntimeStateRepository(sql);
            const groups = createTestGroupStateRepository(
                runtime,
                new PSqlGroupStateEventRepository(sql)
            );
            const topology = new GroupTopologyConfigRepository(runtime);
            const tmpDirPath = await mkdtemp(path.join(tmpdir(), 'rallar-topology-authority-race-'));
            const releaseFilePath = path.join(tmpDirPath, 'release');
            const input: TopologyAppInboxWorkerInput = {
                command: 'put-config',
                barrierPhase: 'transaction',
                groupRef,
                atEpochMs: 2,
                traceFilePath: path.join(tmpDirPath, 'trace.json'),
                barrier: { readyDirectoryPath: path.join(tmpDirPath, 'ready'), releaseFilePath },
                request: {
                    requestId: `${applicationId}-mutation`,
                    updatedByPrincipalId: 'owner',
                    config: { topologyKind: 'tree' }
                }
            };
            const workers: Promise<Awaited<ReturnType<typeof spawnTopologyAppInboxWorker>>>[] = [];
            try {
                await seedTopologyGroup(sql, topologyGroupSnapshot(groupRef));
                const worker = spawnTopologyAppInboxWorker(databaseUrl, input);
                workers.push(worker);
                await waitForTopologyWorkerParticipants(input.barrier.readyDirectoryPath, 1, workers);
                const current = await groups.findGroupEntry(groupRef);
                expect(current).toBeDefined();
                const archived: Group = {
                    ...current!.value,
                    status: 'archived',
                    snapshotVersion: current!.value.snapshotVersion + 1,
                    updated: { ...current!.value.updated, atEpochMs: 2 },
                    archived: { ...current!.value.updated, atEpochMs: 2 },
                    deleted: null
                };
                expect(await groups.updateGroup(archived, current!.entry.revision)).toMatchObject({
                    status: 'applied'
                });
                await writeFile(releaseFilePath, 'release', 'utf8');
                await expect(worker).resolves.toMatchObject({
                    status: 'rejected',
                    attemptCount: 2,
                    failure: { status: 403 }
                });
                await expect(topology.findConfig(groupRef)).resolves.toBeUndefined();
                await expect(
                    topology.findMutationRecord(groupRef, input.request.requestId)
                ).resolves.toBeUndefined();
                expect((await groups.findGroup(groupRef))?.status).toBe('archived');
                const [{ count }] = await sql<{ count: number; }[]>`
          select count(*)::int as count from resource_inbox
          where ri_type_id = 'APP_OUTBOX' and ri_resource like ${`%${applicationId}%`}
        `;
                expect(count).toBe(0);
            }
            finally {
                await Promise.allSettled(workers);
                await cleanupTopologyApplicationRows(sql, applicationId);
                await sql.end();
                await rm(tmpDirPath, { recursive: true, force: true });
            }
        },
        60_000
    );
});

function topologyInputs(
    applicationId: string,
    groupRef: TopologyAppInboxWorkerInput['groupRef'],
    tmpDirPath: string,
    releaseFilePath: string,
    requests: readonly Readonly<{
        requestId: string;
        config: Readonly<Record<string, unknown>>;
    }>[]
): readonly TopologyAppInboxWorkerInput[] {
    const readyDirectoryPath = path.join(tmpDirPath, 'ready');
    return requests.map((request, index) => ({
        command: 'put-config',
        barrierPhase: 'topology-read',
        groupRef,
        atEpochMs: index + 2,
        traceFilePath: path.join(tmpDirPath, `${applicationId}-${index}.json`),
        barrier: { readyDirectoryPath, releaseFilePath },
        request: { ...request, updatedByPrincipalId: 'owner' }
    }));
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when Postgres integration is enabled');
    }
    return databaseUrl;
}
