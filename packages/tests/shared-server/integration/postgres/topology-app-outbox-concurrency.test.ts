import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { computeRtcTopologyEntry } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import {
    cleanupTopologyApplicationRows,
    createPostgresSql,
    readTopologyWorkerTrace,
    seedTopologyGroup,
    spawnTopologyAppOutboxWorker,
    topologyGroupSnapshot,
    waitForTopologyWorkerParticipants,
    type TopologyAppOutboxWorkerInput
} from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres topology APP_OUTBOX concurrency', () => {
    postgresIt(
        'converges true-overlap topology executions across independent clients',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-execution-${crypto.randomUUID()}`;
            const groupRef = { applicationId, workspaceId: 'concurrency', groupId: 'room' };
            const groupSnapshot = topologyGroupSnapshot(groupRef);
            const sql = await createPostgresSql(databaseUrl);
            const resources = createPSqlResourceInboxRepository(sql);
            const runtime = new PSqlRuntimeStateRepository(sql);
            const tmpDirPath = await mkdtemp(path.join(tmpdir(), 'rallar-topology-outbox-race-'));
            const releaseFilePath = path.join(tmpDirPath, 'release');
            const readyDirectoryPath = path.join(tmpDirPath, 'ready');
            const atEpochMs = Date.now();
            const entries = ['first', 'second'].map((name, index) =>
                computeRtcTopologyEntry({
                    commandId: `${applicationId}-${name}`,
                    aggregateRef: groupRef,
                    acceptedCausalRevision: groupSnapshot.causalRevision,
                    groupSnapshot,
                    effectKind: 'rtc-topology-recompute',
                    payloadKind: 'group-revision',
                    origin: 'automatic',
                    createdAtEpochMs: atEpochMs + index,
                    expireAtEpochMs: atEpochMs + 60_000 + index,
                    senderId: 'postgres-topology-concurrency',
                    resourceId: `${applicationId}-${name}-topology`,
                    requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                    publish: true
                })
            );
            const inputs: readonly TopologyAppOutboxWorkerInput[] = entries.map((entry, index) => ({
                groupSnapshot,
                targetKey: entry.key,
                atEpochMs,
                traceFilePath: path.join(tmpDirPath, `${index}-trace.json`),
                barrier: { readyDirectoryPath, releaseFilePath }
            }));
            const workers: Promise<Awaited<ReturnType<typeof spawnTopologyAppOutboxWorker>>>[] = [];
            try {
                await seedTopologyGroup(sql, groupSnapshot);
                expect(await resources.entries.writeIfAbsentOrMatch(entries[0]!)).toBe('inserted');
                workers.push(spawnTopologyAppOutboxWorker(databaseUrl, inputs[0]!));
                await waitForTopologyWorkerParticipants(readyDirectoryPath, 1, workers);

                expect(await resources.entries.writeIfAbsentOrMatch(entries[1]!)).toBe('inserted');
                workers.push(spawnTopologyAppOutboxWorker(databaseUrl, inputs[1]!));
                await waitForTopologyWorkerParticipants(readyDirectoryPath, 2, workers);
                await writeFile(releaseFilePath, 'release', 'utf8');
                const outputs = await Promise.all(workers);
                const traces = await Promise.all(
                    inputs.map((input) => readTopologyWorkerTrace(input.traceFilePath))
                );

                expect(outputs.map((output) => output.status)).toEqual(['COMPLETED', 'COMPLETED']);
                expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
                expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
                expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
                const storedEntries = await Promise.all(
                    entries.map((entry) => resources.entries.findAnyByKey(entry.key))
                );
                expect(storedEntries.map((entry) => entry?.dequeueAudit.attempts).sort()).toEqual([1, 2]);
                const storedSnapshot = await new RtcTopologySnapshotRepository(runtime).findSnapshot(
                    groupRef
                );
                expect(storedSnapshot).toBeDefined();
                const publications = new RtcTopologyPublicationRepository(runtime);
                const storedPublications = await Promise.all(
                    entries.map((entry) => publications.findPublicationForWork(groupRef, topologyWorkId(entry.resource)))
                );
                expect(storedPublications).toHaveLength(2);
                expect(storedPublications.every((publication) => publication !== undefined)).toBe(true);
                expect(
                    storedPublications.every(
                        (publication) => publication?.overlayVersion === storedSnapshot?.version
                    )
                ).toBe(true);
            }
            finally {
                await writeFile(releaseFilePath, 'release', 'utf8');
                await Promise.allSettled(workers);
                await cleanupTopologyApplicationRows(sql, applicationId);
                await sql.end();
                await rm(tmpDirPath, { recursive: true, force: true });
            }
        },
        60_000
    );
});

function topologyWorkId(serializedMessage: string): string {
    const message = JSON.parse(serializedMessage) as ALMessage;
    const envelope = JSON.parse(message.payload.resource) as Readonly<{
        topicId: string;
        contextId: string;
        resourceId: string;
    }>;
    return [envelope.topicId, envelope.contextId, envelope.resourceId, 0].join(':');
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when Postgres integration is enabled');
    }
    return databaseUrl;
}
