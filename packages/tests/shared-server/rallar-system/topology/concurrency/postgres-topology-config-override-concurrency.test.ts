import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { expectPendingDirectResourceOutboxEvidence, findDirectResourceOutboxEvidence } from '../../../direct-resource-outbox-evidence.ts';
import { toOwnedAppInboxResourceIds } from '../../../postgres-app-inbox-attempt-evidence.ts';
import {
    cleanupTopologyApplicationRows,
    createPostgresSql,
    readTopologyWorkerTrace,
    seedTopologyGroup,
    spawnTopologyAppInboxWorker,
    topologyGroupSnapshot,
    waitForTopologyWorkerParticipants,
    type TopologyAppInboxWorkerInput,
    type TopologyAppInboxWorkerOutput,
    type TopologyWorkerTrace
} from './postgres-topology-concurrency-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const DURABLE_CONFIG: EffectiveGroupTopologyConfig = {
    topologyKind: 'auto',
    degreeLimit: 5,
    treeMinSize: 5,
    meshMinSize: 16,
    meshParamK: 4
};
const COMPLETE_OVERRIDE: EffectiveGroupTopologyConfig = {
    topologyKind: 'auto',
    degreeLimit: 3,
    treeMinSize: 5,
    meshMinSize: 16,
    meshParamK: 2
};

describe('Postgres topology config and override concurrency', () => {
    postgresIt(
        'revalidates true-overlap config and override writes against one invariant surface',
        async () => {
            const databaseUrl = requireDatabaseUrl();
            const applicationId = `topology-cross-target-${crypto.randomUUID()}`;
            const groupRef = { applicationId, workspaceId: 'concurrency', groupId: 'room' };
            const sql = await createPostgresSql(databaseUrl);
            const tmpDirPath = await mkdtemp(path.join(tmpdir(), 'rallar-topology-invariant-race-'));
            const inputs = createMixedTopologyInputs(groupRef, tmpDirPath, Date.now());
            const workers: Promise<TopologyAppInboxWorkerOutput>[] = [];
            try {
                await seedTopologyGroup(sql, topologyGroupSnapshot(groupRef));
                workers.push(...inputs.map((input) => spawnTopologyAppInboxWorker(databaseUrl, input)));
                await waitForTopologyWorkerParticipants(
                    inputs[0]!.barrier.readyDirectoryPath,
                    inputs.length,
                    workers
                );
                await writeFile(inputs[0]!.barrier.releaseFilePath, 'release', 'utf8');
                const outputs = await Promise.all(workers);
                const traces = await Promise.all(
                    inputs.map((input) => readTopologyWorkerTrace(input.traceFilePath))
                );

                await expectMixedTopologyOutcome({ sql, inputs, outputs, traces });
            }
            finally {
                await Promise.allSettled(workers);
                await cleanupTopologyApplicationRows(sql, applicationId);
                await expectTopologyApplicationRowsRemoved(sql, applicationId);
                await sql.end();
                await rm(tmpDirPath, { recursive: true, force: true });
            }
        },
        60_000
    );
});

interface MixedTopologyOutcomeInput {
    readonly sql: Awaited<ReturnType<typeof createPostgresSql>>;
    readonly inputs: readonly TopologyAppInboxWorkerInput[];
    readonly outputs: readonly TopologyAppInboxWorkerOutput[];
    readonly traces: readonly TopologyWorkerTrace[];
}

async function expectMixedTopologyOutcome(outcome: MixedTopologyOutcomeInput): Promise<void> {
    const [configInput, overrideInput] = outcome.inputs;
    const [configOutput, overrideOutput] = outcome.outputs;
    if (!configInput || !overrideInput || !configOutput || !overrideOutput) {
        throw new Error('Mixed topology workers did not return one canonical result per input');
    }
    expect(outcome.inputs.map(({ command }) => command)).toEqual(['put-config', 'put-override']);
    expect(outcome.outputs.map(({ requestId }) => requestId)).toEqual(
        outcome.inputs.map(({ request }) => request.requestId)
    );
    expect(outcome.traces.map(({ barrierWaitCount }) => barrierWaitCount)).toEqual([1, 1]);
    expect(
        outcome.traces.map(({ topologyReadBarrierPrimitive }) => topologyReadBarrierPrimitive)
    ).toEqual(['readRuntimeStateBatch', 'readRuntimeStateBatch']);
    expect(new Set(outcome.traces.map(({ backendPid }) => backendPid)).size).toBe(2);

    const repository = new GroupTopologyConfigRepository(new PSqlRuntimeStateRepository(outcome.sql));
    const [durable, temporary] = await Promise.all([
        repository.findConfig(configInput.groupRef),
        repository.findOverride(configInput.groupRef)
    ]);
    expect(durable).toMatchObject({
        config: DURABLE_CONFIG,
        version: 1,
        requestId: configInput.request.requestId
    });
    if (!durable) {
        throw new Error('Mixed topology workers did not persist a durable topology config');
    }

    if (overrideOutput.status === 'rejected') {
        await expectConfigWinnerOutcome({ ...outcome, repository, durable, temporary });
    }
    else if (configOutput.status === 'applied' && overrideOutput.status === 'applied') {
        await expectCompleteOverrideWinnerOutcome({ ...outcome, repository, durable, temporary });
    }
    else {
        throw new Error(`Unexpected mixed topology outcome: ${JSON.stringify(outcome.outputs)}`);
    }
}

interface ObservedMixedTopologyOutcome extends MixedTopologyOutcomeInput {
    readonly repository: GroupTopologyConfigRepository;
    readonly durable: NonNullable<Awaited<ReturnType<GroupTopologyConfigRepository['findConfig']>>>;
    readonly temporary: Awaited<ReturnType<GroupTopologyConfigRepository['findOverride']>>;
}

async function expectConfigWinnerOutcome(outcome: ObservedMixedTopologyOutcome): Promise<void> {
    const [configInput, overrideInput] = outcome.inputs as readonly [
        TopologyAppInboxWorkerInput,
        TopologyAppInboxWorkerInput
    ];
    const [configOutput, overrideOutput] = outcome.outputs as readonly [
        TopologyAppInboxWorkerOutput,
        TopologyAppInboxWorkerOutput
    ];
    expect(configOutput.status).toBe('applied');
    expect(overrideOutput).toMatchObject({
        status: 'rejected',
        attemptCount: 2,
        acceptedVersion: null,
        outboxIds: [],
        receipt: null,
        failure: { code: 'group-topology-config-validation-failed' }
    });
    expect(configOutput.attemptCount).toBe(1);
    expect(outcome.temporary).toBeUndefined();
    expect(resolveGroupTopologyConfig({ durable: outcome.durable }).effective).toEqual(
        DURABLE_CONFIG
    );
    expectAppliedReceipt(configOutput, configInput, DURABLE_CONFIG);
    await expectMutationAndOutboxEvidence(outcome, [configOutput], [overrideInput.request.requestId]);
    await expect(
        outcome.repository.findInvariantGenerationEntry(configInput.groupRef)
    ).resolves.toMatchObject({ value: { version: 1 }, entry: { revision: 0 } });
    await expect(
        outcome.repository.findGenerationEntry(configInput.groupRef, 'config')
    ).resolves.toMatchObject({ value: { version: 1 }, entry: { revision: 0 } });
    await expect(
        outcome.repository.findGenerationEntry(configInput.groupRef, 'override')
    ).resolves.toBeUndefined();
    expectRejectedAttempts(outcome, overrideInput);
}

async function expectCompleteOverrideWinnerOutcome(
    outcome: ObservedMixedTopologyOutcome
): Promise<void> {
    const [configInput, overrideInput] = outcome.inputs as readonly [
        TopologyAppInboxWorkerInput,
        TopologyAppInboxWorkerInput
    ];
    const [configOutput, overrideOutput] = outcome.outputs as readonly [
        TopologyAppInboxWorkerOutput,
        TopologyAppInboxWorkerOutput
    ];
    expect(configOutput).toMatchObject({ status: 'applied', attemptCount: 2 });
    expect(overrideOutput).toMatchObject({ status: 'applied', attemptCount: 1 });
    expect(outcome.temporary).toMatchObject({
        config: COMPLETE_OVERRIDE,
        version: 1,
        requestId: overrideInput.request.requestId
    });
    expect(
        resolveGroupTopologyConfig({ durable: outcome.durable, temporary: outcome.temporary })
            .effective
    ).toEqual(COMPLETE_OVERRIDE);
    expectAppliedReceipt(configOutput, configInput, DURABLE_CONFIG);
    expectAppliedReceipt(overrideOutput, overrideInput, COMPLETE_OVERRIDE);
    await expectMutationAndOutboxEvidence(outcome, [configOutput, overrideOutput], []);
    await expect(
        outcome.repository.findInvariantGenerationEntry(configInput.groupRef)
    ).resolves.toMatchObject({ value: { version: 2 }, entry: { revision: 1 } });
    await expect(
        outcome.repository.findGenerationEntry(configInput.groupRef, 'config')
    ).resolves.toMatchObject({ value: { version: 1 }, entry: { revision: 0 } });
    await expect(
        outcome.repository.findGenerationEntry(configInput.groupRef, 'override')
    ).resolves.toMatchObject({ value: { version: 1 }, entry: { revision: 0 } });
    expect(readAttemptsForRequest(outcome, configInput)).toEqual([
        expect.objectContaining({ attempt: 1, classification: 'retryable', retryDelayMs: 1 }),
        expect.objectContaining({ attempt: 2, classification: 'accepted', retryDelayMs: 0 })
    ]);
    expect(readAttemptsForRequest(outcome, overrideInput)).toEqual([
        expect.objectContaining({ attempt: 1, classification: 'accepted', retryDelayMs: 0 })
    ]);
}

function expectAppliedReceipt(
    output: TopologyAppInboxWorkerOutput,
    input: TopologyAppInboxWorkerInput,
    acceptedConfig: EffectiveGroupTopologyConfig
): void {
    expect(output.failure).toBeNull();
    expect(output.receipt?.commandId).toBe(input.request.requestId);
    expect(output.receipt?.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(output.receipt).toMatchObject({
        requestId: input.request.requestId,
        operation: input.command === 'put-config' ? 'putConfig' : 'putOverride',
        outcome: 'applied',
        attemptCount: output.attemptCount,
        groupRef: input.groupRef,
        target: input.command === 'put-config' ? 'config' : 'override',
        acceptedVersion: 1,
        acceptedStorageRevision: 0,
        acceptedCreatedAtEpochMs: input.atEpochMs,
        acceptedUpdatedAtEpochMs: input.atEpochMs,
        acceptedExpiresAtEpochMs: input.command === 'put-override' ? input.request.expiresAtEpochMs : null,
        acceptedConfig,
        acceptedCausalRevision: {
            stateRevision: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0
        },
        eventId: null,
        outboxId: output.outboxIds[0],
        outboxIds: output.outboxIds
    });
    expect(output.outboxIds).toHaveLength(1);
}

function expectRejectedAttempts(
    outcome: ObservedMixedTopologyOutcome,
    input: TopologyAppInboxWorkerInput
): void {
    expect(readAttemptsForRequest(outcome, input)).toEqual([
        expect.objectContaining({ attempt: 1, classification: 'retryable', retryDelayMs: 1 }),
        expect.objectContaining({ attempt: 2, classification: 'non-retryable', retryDelayMs: 0 })
    ]);
}

function readAttemptsForRequest(
    outcome: Pick<ObservedMixedTopologyOutcome, 'traces'>,
    input: TopologyAppInboxWorkerInput
) {
    const resourceId = toOwnedAppInboxResourceIds([input.request.requestId])[0];
    return outcome.traces
        .flatMap(({ attempts }) => attempts ?? [])
        .filter((attempt) => attempt.resourceId === resourceId)
        .sort((left, right) => left.attempt - right.attempt);
}

async function expectMutationAndOutboxEvidence(
    outcome: ObservedMixedTopologyOutcome,
    applied: readonly TopologyAppInboxWorkerOutput[],
    rejectedRequestIds: readonly string[]
): Promise<void> {
    for (const output of applied) {
        await expect(
            outcome.repository.findMutationRecord(outcome.inputs[0]!.groupRef, output.requestId)
        ).resolves.toMatchObject({ receipt: output.receipt });
    }
    for (const requestId of rejectedRequestIds) {
        await expect(
            outcome.repository.findMutationRecord(outcome.inputs[0]!.groupRef, requestId)
        ).resolves.toBeUndefined();
    }
    const outboxIds = applied.flatMap(({ outboxIds }) => outboxIds).map(toStoredOutboxId);
    expectPendingDirectResourceOutboxEvidence(
        await findDirectResourceOutboxEvidence(outcome.sql, outboxIds),
        outboxIds
    );
}

function createMixedTopologyInputs(
    groupRef: TopologyAppInboxWorkerInput['groupRef'],
    tmpDirPath: string,
    atEpochMs: number
): readonly TopologyAppInboxWorkerInput[] {
    const barrier = {
        readyDirectoryPath: path.join(tmpDirPath, 'ready'),
        releaseFilePath: path.join(tmpDirPath, 'release')
    };
    return [
        {
            command: 'put-config',
            barrierPhase: 'topology-read',
            groupRef,
            atEpochMs,
            traceFilePath: path.join(tmpDirPath, 'config-trace.json'),
            barrier,
            request: {
                requestId: `${groupRef.applicationId}-config`,
                updatedByPrincipalId: 'owner',
                config: { meshParamK: 4 }
            }
        },
        {
            command: 'put-override',
            barrierPhase: 'topology-read',
            groupRef,
            atEpochMs,
            traceFilePath: path.join(tmpDirPath, 'override-trace.json'),
            barrier,
            request: {
                requestId: `${groupRef.applicationId}-override`,
                updatedByPrincipalId: 'owner',
                config: { degreeLimit: 3 },
                expiresAtEpochMs: atEpochMs + 60_000
            }
        }
    ];
}

function toStoredOutboxId(resourceId: string): string {
    return toAppQueueKey({ resourceId, topicId: '', contextId: '' }).resourceId;
}

async function expectTopologyApplicationRowsRemoved(
    sql: Awaited<ReturnType<typeof createPostgresSql>>,
    applicationId: string
): Promise<void> {
    const pattern = `%${applicationId}%`;
    const [counts] = await sql<Array<{ runtimeCount: number; inboxCount: number; resultCount: number; }>>`
    select
      (select count(*)::int from runtime_state_store where store_value like ${pattern})
        as "runtimeCount",
      (select count(*)::int from resource_inbox where ri_resource like ${pattern})
        as "inboxCount",
      (select count(*)::int from resource_inbox_results where ris_resource like ${pattern})
        as "resultCount"
  `;
    expect(counts).toEqual({ runtimeCount: 0, inboxCount: 0, resultCount: 0 });
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when Postgres integration is enabled');
    }
    return databaseUrl;
}
