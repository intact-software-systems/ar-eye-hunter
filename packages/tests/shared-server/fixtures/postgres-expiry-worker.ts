import postgres from 'postgres';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
  BanGroupMemberRequest,
  ConnectClientSessionRequest,
  ConnectGroupPresenceSessionRequest,
  DisconnectClientSessionRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatClientSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
  JoinGroupRequest,
  StateScope,
} from '@shared/api/state-types.ts';
import type {
  DeleteGroupTopologyConfigInput,
  PutGroupTopologyConfigInput,
} from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
  createClientStateEventRepository,
  createClientStateRepository,
  createGroupStateEventRepository,
  createGroupStateRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import type {
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { ClientMutationReceipt } from '@shared-server/rallar-system/services/client-state-mutations.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { createGroupStateRuntime } from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type {
  RallarTimingEvent,
  RallarTimingSink,
} from '@shared-server/rallar-system/services/timing.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { createTestGroupStateRuntime } from '../group-state-test-runtime.ts';

type ExpiryWorkerInput = Readonly<{
  mode: 'client' | 'group';
  scope: StateScope;
  atEpochMs: number;
  pidFilePath: string;
}>;

type WorkerBarrier = Readonly<{
  readyFilePath: string;
  releaseFilePath: string;
}>;

type WorkerCommandBase = Readonly<{
  scope: StateScope;
  atEpochMs: number;
  traceFilePath: string;
  barrier: WorkerBarrier;
}>;

type ClientWorkerInput =
  & WorkerCommandBase
  & Readonly<{
    command: 'client-heartbeat' | 'client-disconnect' | 'client-reconnect';
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request:
      | HeartbeatClientSessionRequest
      | DisconnectClientSessionRequest
      | ConnectClientSessionRequest;
  }>;

type GroupWorkerInput =
  & WorkerCommandBase
  & Readonly<{
    command:
      | 'group-join'
      | 'group-ban'
      | 'group-presence-connect'
      | 'group-presence-heartbeat'
      | 'group-presence-disconnect';
    groupId: string;
    targetPrincipalId?: string;
    sessionId?: string;
    request:
      | JoinGroupRequest
      | BanGroupMemberRequest
      | ConnectGroupPresenceSessionRequest
      | HeartbeatGroupPresenceSessionRequest
      | DisconnectGroupPresenceSessionRequest;
  }>;

type TopologyWorkerInput =
  & Readonly<{
    groupRef: GroupRef;
    atEpochMs: number;
    traceFilePath: string;
    barrier: WorkerBarrier;
  }>
  & (
    | Readonly<{
      command: 'topology-config-put';
      request: Omit<PutGroupTopologyConfigInput, 'groupRef'>;
    }>
    | Readonly<{
      command: 'topology-config-delete';
      request: Omit<DeleteGroupTopologyConfigInput, 'groupRef'>;
    }>
  );

type StateMutationWorkerInput =
  | ClientWorkerInput
  | GroupWorkerInput
  | TopologyWorkerInput;

type ExpiryWorkerOutput = Readonly<{
  mode: ExpiryWorkerInput['mode'];
  backendPid: number;
  resultCount: number;
  eventTypes: readonly string[];
}>;

type CompactStateMutationWorkerOutput = Readonly<{
  operation: StateMutationWorkerInput['command'];
  requestId: string | null;
  commandHash: string;
  attemptCount: number;
  acceptedStorageRevision: number | null;
  acceptedCausalRevision: Readonly<Record<string, unknown>> | null;
  acceptedVersion: number | null;
  outboxIds: readonly string[];
  domainStatus: 'applied' | 'no-op' | 'rejected';
}>;

type WorkerPhase = Readonly<{
  component: string;
  operation: string;
  status: 'ok' | 'error';
  attempt: number | null;
  backoffMs: number | null;
}>;

type WorkerTraceState = {
  backendPid: number;
  barrierWaitCount: number;
  sleeps: Array<Readonly<{ delayMs: number; inTransaction: boolean }>>;
  phases: WorkerPhase[];
};

async function main(): Promise<void> {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for postgres-expiry-worker');
  }

  const input = readInput();
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1 });

  try {
    const [{ pid }] = await sql<{ pid: number }[]>`
        select pg_backend_pid()::int as pid
    `;
    if (isExpiryWorkerInput(input)) {
      await Deno.writeTextFile(
        input.pidFilePath,
        JSON.stringify({ backendPid: pid }),
      );
      console.log(JSON.stringify(
        await runExpiryWorker(
          input,
          new PSqlRuntimeStateRepository(sql as unknown as PSqlSql),
          pid,
        ),
      ));
    } else {
      const trace: WorkerTraceState = {
        backendPid: pid,
        barrierWaitCount: 0,
        sleeps: [],
        phases: [],
      };
      const runtimeRepository = new BarrierControlledRuntimeStateRepository(
        sql as unknown as PSqlSql,
        input.barrier,
        trace,
      );
      try {
        console.log(JSON.stringify(
          await runStateMutationWorker(
            input,
            runtimeRepository,
            trace,
          ),
        ));
      } finally {
        await Deno.writeTextFile(input.traceFilePath, JSON.stringify(trace));
      }
    }
  } finally {
    await sql.end();
  }
}

async function runStateMutationWorker(
  input: StateMutationWorkerInput,
  runtimeRepository: BarrierControlledRuntimeStateRepository,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  if (input.command.startsWith('client-')) {
    return await runClientMutation(input as ClientWorkerInput, runtimeRepository, trace);
  }
  if (input.command.startsWith('group-')) {
    return await runGroupMutation(input as GroupWorkerInput, runtimeRepository, trace);
  }
  return await runTopologyMutation(input as TopologyWorkerInput, runtimeRepository, trace);
}

async function runClientMutation(
  input: ClientWorkerInput,
  runtimeRepository: BarrierControlledRuntimeStateRepository,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const service = createClientStateService({
    runtimeRepository,
    createClientStateEventStore: createClientStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => input.atEpochMs,
    sleep: createRecordedSleep(runtimeRepository, trace),
    timing: createTimingSink(trace),
    serviceId: `postgres-state-worker-${Deno.pid}`,
  });
  runtimeRepository.armBarrier();
  if (input.command === 'client-heartbeat') {
    await service.heartbeatSession(
      input.scope,
      input.principalId,
      input.clientInstanceId,
      input.sessionId,
      input.request as HeartbeatClientSessionRequest,
    );
  } else if (input.command === 'client-disconnect') {
    await service.disconnectSession(
      input.scope,
      input.principalId,
      input.clientInstanceId,
      input.sessionId,
      input.request as DisconnectClientSessionRequest,
    );
  } else {
    await service.connectSession(
      input.scope,
      input.principalId,
      input.clientInstanceId,
      input.sessionId,
      input.request as ConnectClientSessionRequest,
    );
  }

  const requestId = requireRequestId(input.request.requestId);
  const stored = await createClientStateRepository(runtimeRepository)
    .findIdempotentClientMutationReceipt(
      { ...input.scope, principalId: input.principalId },
      requestId,
    );
  if (!stored) {
    throw new Error(`Client mutation receipt not found: ${requestId}`);
  }
  return compactClientReceipt(input.command, stored.receipt);
}

async function runGroupMutation(
  input: GroupWorkerInput,
  runtimeRepository: BarrierControlledRuntimeStateRepository,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const service = createTestGroupStateRuntime({
    runtimeRepository,
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => input.atEpochMs,
    sleep: createRecordedSleep(runtimeRepository, trace),
    timing: createTimingSink(trace),
    serviceId: `postgres-state-worker-${Deno.pid}`,
  }).service;
  runtimeRepository.armBarrier();
  let receipt: GroupMutationReceipt | undefined;
  if (input.command === 'group-join') {
    await service.joinGroup(
      input.scope,
      input.groupId,
      input.request as JoinGroupRequest,
    );
  } else if (input.command === 'group-ban') {
    await service.banGroupMember(
      input.scope,
      input.groupId,
      requireString(input.targetPrincipalId, 'targetPrincipalId'),
      input.request as BanGroupMemberRequest,
    );
  } else if (input.command === 'group-presence-connect') {
    receipt = await service.connectPresenceSessionReceipt(
      input.scope,
      input.groupId,
      requireString(input.sessionId, 'sessionId'),
      input.request as ConnectGroupPresenceSessionRequest,
    );
  } else if (input.command === 'group-presence-heartbeat') {
    receipt = await service.heartbeatPresenceSessionReceipt(
      input.scope,
      input.groupId,
      requireString(input.sessionId, 'sessionId'),
      input.request as HeartbeatGroupPresenceSessionRequest,
    );
  } else {
    receipt = await service.disconnectPresenceSessionReceipt(
      input.scope,
      input.groupId,
      requireString(input.sessionId, 'sessionId'),
      input.request as DisconnectGroupPresenceSessionRequest,
    );
  }

  if (!receipt) {
    const requestId = requireRequestId(input.request.requestId);
    receipt = (await createGroupStateRepository(runtimeRepository)
      .findIdempotentGroupMutationReceipt(
        { ...input.scope, groupId: input.groupId },
        requestId,
      ))?.receipt;
    if (!receipt) {
      throw new Error(`Group mutation receipt not found: ${requestId}`);
    }
  }
  return compactGroupReceipt(input.command, receipt);
}

async function runTopologyMutation(
  input: TopologyWorkerInput,
  runtimeRepository: BarrierControlledRuntimeStateRepository,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const groupStateRepository = createGroupStateRepository(runtimeRepository);
  const service = new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => groupStateRepository.readSnapshot(ref),
    groupStateRepository,
    configRepository: new GroupTopologyConfigRepository(runtimeRepository),
    topologyService: new RallarRtcTopologyService(),
    now: () => input.atEpochMs,
    sleep: createRecordedSleep(runtimeRepository, trace),
    timing: createTimingSink(trace),
    serviceId: `postgres-state-worker-${Deno.pid}`,
  });
  await service.readConfig(input.groupRef);
  runtimeRepository.armBarrier();
  const receipt = input.command === 'topology-config-put'
    ? (await service.putConfig({
      ...input.request,
      groupRef: input.groupRef,
    })).receipt
    : (await service.deleteConfig({
      ...input.request,
      groupRef: input.groupRef,
    })).receipt;
  return compactTopologyReceipt(input.command, receipt);
}

function compactClientReceipt(
  operation: ClientWorkerInput['command'],
  receipt: ClientMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: receipt.requestId,
    commandHash: receipt.commandHash,
    attemptCount: receipt.attemptCount,
    acceptedStorageRevision: receipt.acceptedStorageRevision,
    acceptedCausalRevision: {
      kind: 'client',
      stateRevision: receipt.stateRevision,
      snapshotVersion: receipt.snapshotVersion,
      presenceVersion: receipt.presenceVersion,
    },
    acceptedVersion: null,
    outboxIds: [...receipt.outboxIds],
    domainStatus: receipt.outcome,
  };
}

function compactGroupReceipt(
  operation: GroupWorkerInput['command'],
  receipt: GroupMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: receipt.requestId,
    commandHash: receipt.commandHash,
    attemptCount: receipt.attemptCount,
    acceptedStorageRevision: receipt.acceptedStorageRevision,
    acceptedCausalRevision: {
      kind: 'group',
      stateRevision: receipt.stateRevision,
      causalRevision: { ...receipt.causalRevision },
      snapshotVersion: receipt.snapshotVersion,
    },
    acceptedVersion: null,
    outboxIds: [...receipt.outboxIds],
    domainStatus: receipt.outcome,
  };
}

function compactTopologyReceipt(
  operation: TopologyWorkerInput['command'],
  receipt: GroupTopologyConfigMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: receipt.requestId,
    commandHash: receipt.commandHash,
    attemptCount: receipt.attemptCount,
    acceptedStorageRevision: receipt.acceptedStorageRevision,
    acceptedCausalRevision: receipt.acceptedCausalRevision === null ? null : {
      ...receipt.acceptedCausalRevision,
      causalRevision: { ...receipt.acceptedCausalRevision.causalRevision },
    },
    acceptedVersion: receipt.acceptedVersion,
    outboxIds: [...receipt.outboxIds],
    domainStatus: receipt.outcome,
  };
}

class BarrierControlledRuntimeStateRepository extends PSqlRuntimeStateRepository {
  private barrierArmed = false;
  private barrierConsumed = false;
  private transactionDepth = 0;

  constructor(
    sql: PSqlSql,
    private readonly barrier: WorkerBarrier,
    private readonly trace: WorkerTraceState,
  ) {
    super(sql);
  }

  armBarrier(): void {
    this.barrierArmed = true;
  }

  isInTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  override async begin<T>(
    fn: (
      repository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.barrierArmed && !this.barrierConsumed) {
      this.barrierConsumed = true;
      this.trace.barrierWaitCount += 1;
      await waitAtBarrier(this.barrier);
    }
    this.transactionDepth += 1;
    try {
      return await super.begin(fn);
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

function createRecordedSleep(
  runtimeRepository: BarrierControlledRuntimeStateRepository,
  trace: WorkerTraceState,
): (delayMs: number) => Promise<void> {
  return async (delayMs) => {
    trace.sleeps.push({
      delayMs,
      inTransaction: runtimeRepository.isInTransaction(),
    });
    await delay(delayMs);
  };
}

function createTimingSink(trace: WorkerTraceState): RallarTimingSink {
  return (event: RallarTimingEvent) => {
    trace.phases.push({
      component: event.component,
      operation: event.operation,
      status: event.status,
      attempt: typeof event.details?.attempt === 'number' ? event.details.attempt : null,
      backoffMs: typeof event.details?.backoffMs === 'number' ? event.details.backoffMs : null,
    });
  };
}

async function waitAtBarrier(barrier: WorkerBarrier): Promise<void> {
  await Deno.writeTextFile(
    barrier.readyFilePath,
    JSON.stringify({ workerPid: Deno.pid }),
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(barrier.releaseFilePath);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await delay(5);
    }
  }
  throw new Error(`Timed out waiting for worker barrier release: ${barrier.releaseFilePath}`);
}

async function runExpiryWorker(
  input: ExpiryWorkerInput,
  runtimeRepository: PSqlRuntimeStateRepository,
  backendPid: number,
): Promise<ExpiryWorkerOutput> {
  if (input.mode === 'client') {
    const results = await createClientStateService({
      runtimeRepository,
      createClientStateEventStore: createClientStateEventRepository,
      syncPublisher: createPublisher(),
      now: () => input.atEpochMs,
      serviceId: `postgres-expiry-worker-${Deno.pid}`,
    }).expireExpiredSessions(input.atEpochMs);

    return {
      mode: input.mode,
      backendPid,
      resultCount: results.length,
      eventTypes: results
        .map((result) => result.result.right?.event?.eventType)
        .filter(isDefined),
    };
  }

  const results = await createGroupStateRuntime({
    runtimeRepository,
    authSessionRepository: new AuthSessionRepository(runtimeRepository),
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: createPublisher(),
    now: () => input.atEpochMs,
    serviceId: `postgres-expiry-worker-${Deno.pid}`,
  }).maintenance.expireExpiredPresenceSessions(input.atEpochMs);

  return {
    mode: input.mode,
    backendPid,
    resultCount: results.length,
    eventTypes: results
      .map((result) => result.result.right?.event?.eventType)
      .filter(isDefined),
  };
}

function readInput(): ExpiryWorkerInput | StateMutationWorkerInput {
  const raw = Deno.env.get('RALLAR_EXPIRY_WORKER_INPUT');
  if (!raw) {
    throw new Error('RALLAR_EXPIRY_WORKER_INPUT is required');
  }

  return JSON.parse(raw) as ExpiryWorkerInput | StateMutationWorkerInput;
}

function isExpiryWorkerInput(
  input: ExpiryWorkerInput | StateMutationWorkerInput,
): input is ExpiryWorkerInput {
  return 'mode' in input;
}

function requireRequestId(requestId: string | undefined): string {
  return requireString(requestId, 'requestId');
}

function requireString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function createPublisher(): StateSyncPublisher {
  return {
    publishClientSnapshot: async () => undefined,
    publishClientEvent: async () => undefined,
    publishGroupSnapshot: async () => undefined,
    publishGroupEvent: async () => undefined,
  };
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

await main();
