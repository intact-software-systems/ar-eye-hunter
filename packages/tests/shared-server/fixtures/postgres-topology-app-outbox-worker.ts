import { Temporal } from '@js-temporal/polyfill';
import postgres from 'postgres';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
  createRtcTopologyOutboxPublisher,
  createRtcTopologyWorkHandler,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import {
  createPostgresWorkerTransactionGate,
  type WorkerBarrier,
} from './postgres-app-inbox-worker-runtime.ts';

interface WorkerInput {
  readonly groupSnapshot: GroupSnapshot;
  readonly targetKey: Key;
  readonly atEpochMs: number;
  readonly traceFilePath: string;
  readonly barrier: WorkerBarrier;
}

interface WorkerTrace {
  backendPid: number;
  barrierWaitCount: number;
}

interface RegisterTopologyAppOutboxHandlerInput {
  readonly input: WorkerInput;
  readonly sql: PSqlSql;
  readonly trace: WorkerTrace;
  readonly resources: ResourceInboxRepository;
  readonly outboxQueueReader: OutboxQueueReader;
}

async function main(): Promise<void> {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const input = readInput();
  const sql = postgres(databaseUrl, { max: 2, idle_timeout: 1 });
  const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
  const trace: WorkerTrace = { backendPid: pid, barrierWaitCount: 0 };
  try {
    const output = await runWorker(input, sql as unknown as PSqlSql, trace);
    console.log(JSON.stringify(output));
  } finally {
    await Deno.writeTextFile(input.traceFilePath, JSON.stringify(trace));
    await sql.end();
  }
}

async function runWorker(
  input: WorkerInput,
  sql: PSqlSql,
  trace: WorkerTrace,
): Promise<Readonly<{ resourceId: string; status: string; attemptCount: number }>> {
  const resources = new ResourceInboxRepository(sql);
  const outboxQueueReader = new OutboxQueueReader(new PSqlQueueBox(resources));
  registerTopologyAppOutboxHandler({ input, sql, trace, resources, outboxQueueReader });
  return await runTopologyAppOutboxUntilCompletion(input, resources, outboxQueueReader);
}

function registerTopologyAppOutboxHandler(
  registration: RegisterTopologyAppOutboxHandlerInput,
): void {
  const input = registration.input;
  const runtime = createRtcTopologyOutboxPublisher({
    outboxQueueReader: registration.outboxQueueReader,
    senderId: `postgres-topology-outbox-${Deno.pid}`,
    now: () => input.atEpochMs,
  });
  const transactionGate = createPostgresWorkerTransactionGate(
    registration.sql,
    async () => await waitAtBarrier(input.barrier, String(Deno.pid)),
    registration.trace,
  );
  const runtimeRepository = new PSqlRuntimeStateRepository(registration.sql);
  const topologyManagement = new GroupTopologyManagementService({
    findGroupSnapshotByRef: () => input.groupSnapshot,
    groupStateRepository: new GroupStateRepository(runtimeRepository),
    topologyService: new RallarRtcTopologyService({ now: () => input.atEpochMs }),
    processRttReader: () => [],
    serviceId: `postgres-topology-outbox-${Deno.pid}`,
  });
  registration.outboxQueueReader.onOutboxMessageDo(
    runtime.workType,
    createRtcTopologyWorkHandler({
      runtime,
      database: transactionGate.sql,
      topologyPlanning: topologyManagement.planningService,
      executionRepository: new RtcTopologyExecutionRepository(
        runtimeRepository,
        undefined,
        () => input.atEpochMs,
      ),
      serviceId: `postgres-topology-outbox-${Deno.pid}`,
    }),
  );
  transactionGate.arm();
}

async function runTopologyAppOutboxUntilCompletion(
  input: WorkerInput,
  resources: ResourceInboxRepository,
  outboxQueueReader: OutboxQueueReader,
): Promise<Readonly<{ resourceId: string; status: string; attemptCount: number }>> {
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const target = await resources.findAnyByKey(input.targetKey);
    if (target?.status === EntityStatus.COMPLETED) {
      return {
        resourceId: input.targetKey.resourceId,
        status: target.status,
        attemptCount: target.dequeueAudit.attempts,
      };
    }
    if (target?.status === EntityStatus.FAILED) {
      throw new Error(`Topology APP_OUTBOX failed: ${input.targetKey.resourceId}`);
    }
    await outboxQueueReader.dequeueOutbox(
      OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
      createResilience(),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Topology APP_OUTBOX did not complete: ${input.targetKey.resourceId}`);
}

function createResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(100, duration, duration, duration),
    1,
    1,
    1,
    1,
  );
}

async function waitAtBarrier(barrier: WorkerBarrier, participantId: string): Promise<void> {
  await Deno.mkdir(barrier.readyDirectoryPath, { recursive: true });
  await Deno.writeTextFile(`${barrier.readyDirectoryPath}/${participantId}.json`, participantId);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(barrier.releaseFilePath);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for topology APP_OUTBOX release: ${barrier.releaseFilePath}`);
}

function readInput(): WorkerInput {
  const raw = Deno.env.get('RALLAR_TOPOLOGY_CONCURRENCY_WORKER_INPUT');
  if (!raw) throw new Error('RALLAR_TOPOLOGY_CONCURRENCY_WORKER_INPUT is required');
  return JSON.parse(raw) as WorkerInput;
}

await main();
