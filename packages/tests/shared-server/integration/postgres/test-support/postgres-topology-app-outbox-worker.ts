import { Temporal } from '@js-temporal/polyfill';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    decodeJsonWireText,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import type {
    TopologyAppOutboxWorkerInput,
    TopologyAppOutboxWorkerOutput
} from '../../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresClient,
    withPostgresClients,
    type PostgresSql
} from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { waitForPostgresWorkerBarrier } from './postgres-worker-barrier.ts';
import { createPostgresWorkerTransactionGate } from './postgres-worker-transaction-gate.ts';

export interface TopologyAppOutboxWorkerProcessInput {
    readonly rawInput: string;
    readonly workerPid: number;
    readonly createSql: () => Promise<PostgresSql>;
    readonly writeTrace: (path: string, content: string) => Promise<void>;
}

interface WorkerTrace {
    backendPid: number;
    barrierWaitCount: number;
}

interface TopologyAppOutboxWorkerExecutionInput {
    readonly input: TopologyAppOutboxWorkerInput;
    readonly sql: PSqlSql;
    readonly trace: WorkerTrace;
    readonly workerPid: number;
}

interface RegisterTopologyAppOutboxHandlerInput extends TopologyAppOutboxWorkerExecutionInput {
    readonly resources: PSqlResourceInboxRepository;
    readonly outboxQueueReader: OutboxQueueReader;
}

async function main(): Promise<void> {
    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required');
    }
    const rawInput = Deno.env.get('RALLAR_TOPOLOGY_CONCURRENCY_WORKER_INPUT');
    if (!rawInput) {
        throw new Error('RALLAR_TOPOLOGY_CONCURRENCY_WORKER_INPUT is required');
    }
    const output = await runTopologyAppOutboxWorkerProcess({
        rawInput,
        workerPid: Deno.pid,
        createSql: async () => await createRuntimeStatePostgresSql(databaseUrl, 2),
        writeTrace: async (path, content) => await Deno.writeTextFile(path, content)
    });
    console.log(JSON.stringify(output));
}

export async function runTopologyAppOutboxWorkerProcess(
    processInput: TopologyAppOutboxWorkerProcessInput
): Promise<TopologyAppOutboxWorkerOutput> {
    const input = decodeTopologyAppOutboxWorkerInput(processInput.rawInput);
    return await withPostgresClients({
        namespace: null,
        clientCount: 1,
        createClient: processInput.createSql
    }, async (clients) => {
        const sql = requirePostgresClient(clients, 0);
        let trace: WorkerTrace | undefined;
        let hasPrimaryFailure = false;
        try {
            const [backend] = await sql<{ pid: number; }[]>`select pg_backend_pid()::int as pid`;
            if (!backend || !Number.isSafeInteger(backend.pid) || backend.pid <= 0) {
                throw new TypeError('Topology APP_OUTBOX worker has no valid backend PID');
            }
            trace = { backendPid: backend.pid, barrierWaitCount: 0 };
            return await runWorker({ input, sql, trace, workerPid: processInput.workerPid });
        }
        catch (error) {
            hasPrimaryFailure = true;
            throw error;
        }
        finally {
            if (trace) {
                try {
                    await processInput.writeTrace(input.traceFilePath, JSON.stringify(trace));
                }
                catch (error) {
                    if (!hasPrimaryFailure) {
                        throw error;
                    }
                }
            }
        }
    });
}

async function runWorker(execution: TopologyAppOutboxWorkerExecutionInput): Promise<TopologyAppOutboxWorkerOutput> {
    const resources = createPSqlResourceInboxRepository(execution.sql, () => new Date(execution.input.atEpochMs));
    const outboxQueueReader = new OutboxQueueReader(new PSqlQueueBox(resources, Temporal.Now.instant));
    registerTopologyAppOutboxHandler({ ...execution, resources, outboxQueueReader });
    return await runTopologyAppOutboxUntilCompletion(execution.input, resources, outboxQueueReader);
}

function registerTopologyAppOutboxHandler(
    registration: RegisterTopologyAppOutboxHandlerInput
): void {
    const input = registration.input;
    const transactionGate = createPostgresWorkerTransactionGate({
        sql: registration.sql,
        beforeMutationTransaction: async () => await waitForPostgresWorkerBarrier(input.barrier, String(registration.workerPid)),
        trace: registration.trace
    });
    const runtimeRepository = new PSqlRuntimeStateRepository(registration.sql);
    const groupStateRepository = createTestGroupStateRepository(
        runtimeRepository,
        new PSqlGroupStateEventRepository(registration.sql)
    );
    const topologyManagement = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: () => input.groupSnapshot,
        readCurrentGroupSnapshot: async (ref) => await groupStateRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        topologyService: new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000, now: () => input.atEpochMs })
    });
    registration.outboxQueueReader.onOutboxMessageDo(
        AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        createRtcTopologyWorkHandler({
            nowEpochMs: () => input.atEpochMs,
            outboxQueueReader: registration.outboxQueueReader,
            database: transactionGate.sql,
            topologyPlanning: topologyManagement.planning,
            executionRepository: new RtcTopologyExecutionRepository(
                runtimeRepository,
                undefined,
                () => input.atEpochMs
            ),
            serviceId: `postgres-topology-outbox-${registration.workerPid}`
        })
    );
    transactionGate.arm();
}

async function runTopologyAppOutboxUntilCompletion(
    input: TopologyAppOutboxWorkerInput,
    resources: PSqlResourceInboxRepository,
    outboxQueueReader: OutboxQueueReader
): Promise<TopologyAppOutboxWorkerOutput> {
    for (let iteration = 0; iteration < 40; iteration += 1) {
        const target = await resources.entries.findAnyByKey(input.targetKey);
        if (target?.status === EntityStatus.COMPLETED) {
            return {
                resourceId: input.targetKey.resourceId,
                status: target.status,
                attemptCount: target.dequeueAudit.attempts
            };
        }
        if (target?.status === EntityStatus.FAILED) {
            throw new Error(`Topology APP_OUTBOX failed: ${input.targetKey.resourceId}`);
        }
        await outboxQueueReader.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience()
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Topology APP_OUTBOX did not complete: ${input.targetKey.resourceId}`);
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(100, duration, duration, duration));
}

function decodeTopologyAppOutboxWorkerInput(raw: string): TopologyAppOutboxWorkerInput {
    const input = decodeJsonWireText(raw, 'Topology APP_OUTBOX worker input');
    if (!isJsonWireObject(input)) {
        throw new TypeError('Topology APP_OUTBOX worker input must be an object');
    }
    const groupSnapshot = input.groupSnapshot;
    validateAuthoritativeGroupSnapshot(groupSnapshot);
    const targetKey = input.targetKey;
    const barrier = input.barrier;
    if (
        !isJsonWireObject(targetKey) || !isJsonWireObject(barrier) ||
        !isNonEmptyString(targetKey.topicId) ||
        !isNonEmptyString(targetKey.contextId) ||
        !isNonEmptyString(targetKey.resourceId) ||
        typeof input.atEpochMs !== 'number' ||
        !Number.isSafeInteger(input.atEpochMs) || input.atEpochMs < 0 ||
        !isNonEmptyString(input.traceFilePath) ||
        !isNonEmptyString(barrier.readyDirectoryPath) ||
        !isNonEmptyString(barrier.releaseFilePath)
    ) {
        throw new TypeError('Topology APP_OUTBOX worker input has invalid runtime fields');
    }
    return {
        groupSnapshot,
        targetKey: { topicId: targetKey.topicId, contextId: targetKey.contextId, resourceId: targetKey.resourceId },
        atEpochMs: input.atEpochMs,
        traceFilePath: input.traceFilePath,
        barrier: { readyDirectoryPath: barrier.readyDirectoryPath, releaseFilePath: barrier.releaseFilePath }
    };
}

function isJsonWireObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: JsonWireValue | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
}

if (import.meta.main) {
    await main();
}
