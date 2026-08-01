import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import {
  expectPendingDirectResourceOutboxEvidence,
  findDirectResourceOutboxEvidence,
} from './direct-resource-outbox-evidence.ts';
import { findSingleRetriedAppInboxAttemptSequence } from './fixtures/postgres-app-inbox-worker-runtime.ts';
import { toOwnedAppInboxResourceIds } from './postgres-app-inbox-attempt-evidence.ts';
import {
  cleanupTopologyApplicationRows,
  createPostgresSql as createSql,
  topologyGroupSnapshot,
  type PostgresSql,
  waitForTopologyWorkerParticipants,
} from './postgres-topology-concurrency-fixtures.ts';
import {
  readTopologyMutationWorkerTrace as readTopologyWorkerTrace,
  spawnTopologyMutationWorker as spawnTopologyWorker,
  type TopologyMutationWorkerHandle as TopologyWorkerHandle,
  type TopologyMutationWorkerInput as TopologyWorkerInput,
  type TopologyMutationWorkerOutput as TopologyWorkerOutput,
  type TopologyMutationWorkerTrace as TopologyWorkerTrace,
} from './postgres-topology-mutation-worker-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres topology mutation worker concurrency', () => {
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
          readyDirectoryPath: path.join(tmpDirPath, 'ready'),
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
        expect(await groupState.insertGroup(snapshot.group)).toMatchObject({ status: 'applied' });
        for (const member of snapshot.members) await groupState.putMember(member);
        await writeFile(input.barrier.releaseFilePath, 'release', 'utf8');
        handle = spawnTopologyWorker(databaseUrl, input);

        await expect(handle.done).rejects.toThrow('requestId is required');
        expect(
          await new GroupTopologyConfigRepository(runtime).findConfig(groupRef),
        ).toBeUndefined();
        expect((await readTopologyWorkerTrace(input.traceFilePath)).barrierWaitCount).toBe(0);
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
      const releaseFilePath = path.join(tmpDirPath, 'release');
      const inputs: readonly TopologyWorkerInput[] = [
        {
          command: 'topology-config-put',
          groupRef,
          atEpochMs: 2,
          traceFilePath: path.join(tmpDirPath, 'put-trace.json'),
          barrier: {
            readyDirectoryPath: path.join(tmpDirPath, 'ready'),
            releaseFilePath,
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
            readyDirectoryPath: path.join(tmpDirPath, 'ready'),
            releaseFilePath,
          },
          request: {
            updatedByPrincipalId: 'owner',
            requestId: `${applicationId}-delete`,
          },
        },
      ];
      const handles: TopologyWorkerHandle[] = [];
      try {
        expect(await groupState.insertGroup(snapshot.group)).toMatchObject({ status: 'applied' });
        for (const member of snapshot.members) await groupState.putMember(member);
        const seedBarrier = {
          readyDirectoryPath: path.join(tmpDirPath, 'seed-ready'),
          releaseFilePath: path.join(tmpDirPath, 'seed-release'),
        };
        await writeFile(seedBarrier.releaseFilePath, 'release', 'utf8');
        const seed = await spawnTopologyWorker(databaseUrl, {
          command: 'topology-config-put',
          groupRef,
          atEpochMs: 1,
          traceFilePath: path.join(tmpDirPath, 'seed-trace.json'),
          barrier: seedBarrier,
          request: {
            config: { topologyKind: 'mesh', degreeLimit: 3 },
            updatedByPrincipalId: 'owner',
            requestId: `${applicationId}-seed`,
          },
        }).done;
        expect(seed.acceptedVersion).toBe(1);

        handles.push(...inputs.map((input) => spawnTopologyWorker(databaseUrl, input)));
        await waitForTopologyWorkerParticipants(
          inputs[0]!.barrier.readyDirectoryPath,
          handles.length,
          handles.map((handle) => handle.done),
        );
        await writeFile(releaseFilePath, 'release', 'utf8');
        const outputs = await Promise.all(handles.map((handle) => handle.done));
        outputs.forEach(expectCompactTopologyWorkerOutput);
        expect(outputs.every((output) => output.domainStatus === 'applied')).toBe(true);
        expect(outputs.map((output) => output.attemptCount).sort()).toEqual([1, 2]);
        const traces = await Promise.all(
          inputs.map((input) => readTopologyWorkerTrace(input.traceFilePath)),
        );
        assertOneTopologyWorkerRebased(outputs, traces);

        const repository = new GroupTopologyConfigRepository(runtime);
        const generation = await repository.findGenerationEntry(groupRef, 'config');
        expect(generation?.value.version).toBe(
          Math.max(...outputs.map((output) => output.acceptedVersion ?? 0)),
        );
        expect(generation?.value.version).toBe(3);
        const latest = outputs.reduce((left, right) =>
          (left.acceptedVersion ?? 0) > (right.acceptedVersion ?? 0) ? left : right,
        );
        expect(await repository.findConfig(groupRef)).toEqual(
          latest.operation === 'topology-config-put'
            ? expect.objectContaining({
                version: 3,
                config: {
                  topologyKind: 'tree',
                  degreeLimit: 2,
                  treeMinSize: 5,
                  meshMinSize: 16,
                  meshParamK: 2,
                },
                updatedByPrincipalId: 'owner',
              })
            : undefined,
        );
        await expectPendingTopologyWorkerOutboxes(setupSql, outputs);
        expect(JSON.stringify(outputs)).not.toMatch(/DATABASE_URL|accessToken|commandMac|app:app/u);
      } finally {
        await Promise.allSettled(handles.map((handle) => handle.done));
        await cleanupApplicationRows([setupSql], applicationId);
        await rm(tmpDirPath, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

function expectCompactTopologyWorkerOutput(output: TopologyWorkerOutput): void {
  expect(Object.keys(output).sort()).toEqual([
    'acceptedCausalRevision',
    'acceptedStorageRevision',
    'acceptedVersion',
    'attemptCount',
    'commandHash',
    'domainStatus',
    'operation',
    'outboxIds',
    'requestId',
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
  const outboxIds = outputs.map(
    (output) =>
      toAppQueueKey({
        resourceId: output.outboxIds[0]!,
        topicId: '',
        contextId: '',
      }).resourceId,
  );
  expect(new Set(outboxIds).size).toBe(outboxIds.length);
  expectPendingDirectResourceOutboxEvidence(
    await findDirectResourceOutboxEvidence(sql, outboxIds),
    outboxIds,
  );
}

function assertOneTopologyWorkerRebased(
  outputs: readonly TopologyWorkerOutput[],
  traces: readonly TopologyWorkerTrace[],
): void {
  expect(traces.every((trace) => trace.barrierWaitCount === 1)).toBe(true);
  expect(new Set(traces.map((trace) => trace.backendPid)).size).toBe(2);
  expect(outputs.findIndex((output) => output.attemptCount === 2)).toBeGreaterThanOrEqual(0);
  expect(
    findSingleRetriedAppInboxAttemptSequence({
      traces,
      ownedResourceIds: toOwnedAppInboxResourceIds(outputs.map((output) => output.requestId)),
    }).map(({ attempt, classification, retryDelayMs }) => ({
      attempt,
      classification,
      retryDelayMs,
    })),
  ).toEqual([
    { attempt: 1, classification: 'retryable', retryDelayMs: 1 },
    { attempt: 2, classification: 'accepted', retryDelayMs: 0 },
  ]);
}

async function cleanupApplicationRows(
  clients: readonly PostgresSql[],
  applicationId: string,
): Promise<void> {
  const cleanupClient = clients[0];
  try {
    if (cleanupClient) await cleanupTopologyApplicationRows(cleanupClient, applicationId);
  } finally {
    await Promise.allSettled(clients.map(async (client) => await client.end()));
  }
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
  }
  return databaseUrl;
}
