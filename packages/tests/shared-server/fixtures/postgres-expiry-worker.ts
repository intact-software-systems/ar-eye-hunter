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
import type {
  PSqlSql,
  PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
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
import {
  createClientStateService,
  requiresClientWrite,
  toClientMutationCommand,
  toClientMutationIssuedSessionAuthority,
  toClientMutationSystemAuthority,
  toConnectCommandInput,
  toDisconnectCommandInput,
  toExpiryCommandInput,
  toHeartbeatCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import type {
  ClientMutationCommandInput,
  ClientMutationComputed,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
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

type WorkerMutationRequest<T> = Omit<T, 'requestId'> & Readonly<{
  requestId: string;
}>;

type ClientWorkerInput =
  & WorkerCommandBase
  & Readonly<{
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
  }>
  & (
    | Readonly<{
      command: 'client-heartbeat';
      request: WorkerMutationRequest<HeartbeatClientSessionRequest>;
    }>
    | Readonly<{
      command: 'client-disconnect';
      request: WorkerMutationRequest<DisconnectClientSessionRequest>;
    }>
    | Readonly<{
      command: 'client-reconnect';
      request: WorkerMutationRequest<ConnectClientSessionRequest>;
    }>
  );

type GroupWorkerInput =
  & WorkerCommandBase
  & Readonly<{
    groupId: string;
  }>
  & (
    | Readonly<{
      command: 'group-join';
      request: WorkerMutationRequest<JoinGroupRequest>;
    }>
    | Readonly<{
      command: 'group-ban';
      targetPrincipalId: string;
      request: WorkerMutationRequest<BanGroupMemberRequest>;
    }>
    | Readonly<{
      command: 'group-presence-connect';
      sessionId: string;
      request: WorkerMutationRequest<ConnectGroupPresenceSessionRequest>;
    }>
    | Readonly<{
      command: 'group-presence-heartbeat';
      sessionId: string;
      request: WorkerMutationRequest<HeartbeatGroupPresenceSessionRequest>;
    }>
    | Readonly<{
      command: 'group-presence-disconnect';
      sessionId: string;
      request: WorkerMutationRequest<DisconnectGroupPresenceSessionRequest>;
    }>
  );

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
      request: WorkerMutationRequest<Omit<PutGroupTopologyConfigInput, 'groupRef'>>;
    }>
    | Readonly<{
      command: 'topology-config-delete';
      request: WorkerMutationRequest<Omit<DeleteGroupTopologyConfigInput, 'groupRef'>>;
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
  requestId: string;
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
  requireRequestId(input.request.requestId);
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
  const requestId = requireRequestId(input.request.requestId);
  const service = createClientStateService({
    runtimeRepository,
    createClientStateEventStore: createClientStateEventRepository,
    timing: createTimingSink(trace),
    serviceId: `postgres-state-worker-${Deno.pid}`,
  });
  const authoritySession: IssuedAuthSession = {
    clientId: input.principalId,
    accessToken: `${input.sessionId}-postgres-worker-token`,
    username: input.principalId,
    sessionId: input.sessionId,
    issuedAtEpochMs: Math.max(0, input.atEpochMs - 1),
    expiresAtEpochMs: input.atEpochMs + 24 * 60 * 60 * 1_000,
  };
  await new AuthSessionRepository(runtimeRepository).putSession(authoritySession);
  runtimeRepository.armBarrier();
  const commandInput = toClientWorkerCommandInput(input);
  await executeClientCommandWithOuterAttempts({
    service,
    runtimeRepository,
    commandInput,
    authoritySession,
    atEpochMs: input.atEpochMs,
    trace,
  });

  const stored = await createClientStateRepository(runtimeRepository)
    .findIdempotentClientMutationReceipt(
      { ...input.scope, principalId: input.principalId },
      requestId,
    );
  if (!stored) {
    throw new Error(`Client mutation receipt not found: ${requestId}`);
  }
  return compactClientReceipt(input.command, requestId, stored.receipt);
}

function toClientWorkerCommandInput(
  input: ClientWorkerInput,
): ClientMutationCommandInput {
  if (input.command === 'client-heartbeat') {
    return toHeartbeatCommandInput(
      input.scope,
      input.principalId,
      input.clientInstanceId,
      input.sessionId,
      input.request,
      input.request.requestId,
    );
  }
  if (input.command === 'client-disconnect') {
    return toDisconnectCommandInput(
      'disconnectSession',
      input.scope,
      input.principalId,
      input.clientInstanceId,
      input.sessionId,
      input.request,
      input.request.requestId,
    );
  }
  return toConnectCommandInput(
    'connectSession',
    input.scope,
    input.principalId,
    input.clientInstanceId,
    input.sessionId,
    input.request,
    input.request.requestId,
    {},
  );
}

async function executeClientCommandWithOuterAttempts(input: Readonly<{
  service: ReturnType<typeof createClientStateService>;
  runtimeRepository: BarrierControlledRuntimeStateRepository;
  commandInput: ClientMutationCommandInput;
  authoritySession: IssuedAuthSession;
  atEpochMs: number;
  trace: WorkerTraceState;
}>): Promise<ClientMutationComputed> {
  const sleep = createRecordedSleep(input.runtimeRepository, input.trace);
  if (input.commandInput.operation === 'expireSession') {
    throw new Error('Client worker command requires issued-session authority');
  }
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const command = await toClientMutationCommand(
      input.commandInput,
      {
        nowEpochMs: input.atEpochMs,
        serviceId: `postgres-state-worker-${Deno.pid}`,
        eventId: `postgres-client-event:${input.commandInput.commandId}`,
        attemptCount: attempt,
        expireAtEpochMs: input.atEpochMs + 24 * 60 * 60 * 1_000,
      },
      toClientMutationIssuedSessionAuthority(
        input.authoritySession,
        input.commandInput.aggregateRef,
        input.commandInput.operation,
      ),
    );
    const read = await input.service.read(command);
    const computed = input.service.compute(command, read);
    input.service.validate(command, read, computed);
    try {
      if (requiresClientWrite(computed)) {
        await input.runtimeRepository.beginSqlTransaction(
          async (transaction) => await input.service.write(transaction, computed),
        );
      }
      return computed;
    } catch (error) {
      if (!(error instanceof RuntimeStateWriteConflictError) || attempt === 8) throw error;
      await sleep(Math.min(16, 2 ** (attempt - 1)));
    }
  }
  throw new Error('Client AppInbox-equivalent outer attempts exhausted');
}

async function runGroupMutation(
  input: GroupWorkerInput,
  runtimeRepository: BarrierControlledRuntimeStateRepository,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const requestId = requireRequestId(input.request.requestId);
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
    receipt = (await createGroupStateRepository(runtimeRepository)
      .findIdempotentGroupMutationReceipt(
        { ...input.scope, groupId: input.groupId },
        requestId,
      ))?.receipt;
    if (!receipt) {
      throw new Error(`Group mutation receipt not found: ${requestId}`);
    }
  }
  return compactGroupReceipt(input.command, requestId, receipt);
}

async function runTopologyMutation(
  input: TopologyWorkerInput,
  runtimeRepository: BarrierControlledRuntimeStateRepository,
  trace: WorkerTraceState,
): Promise<CompactStateMutationWorkerOutput> {
  const requestId = requireRequestId(input.request.requestId);
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
  return compactTopologyReceipt(input.command, requestId, receipt);
}

function compactClientReceipt(
  operation: ClientWorkerInput['command'],
  requestId: string,
  receipt: ClientMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: requireMatchingRequestId(receipt.requestId, requestId),
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
  requestId: string,
  receipt: GroupMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: requireMatchingRequestId(receipt.requestId, requestId),
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
  requestId: string,
  receipt: GroupTopologyConfigMutationReceipt,
): CompactStateMutationWorkerOutput {
  return {
    operation,
    requestId: requireMatchingRequestId(receipt.requestId, requestId),
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

  async beginSqlTransaction<T>(
    write: (transaction: PSqlTransactionSql) => Promise<T>,
  ): Promise<T> {
    if (this.barrierArmed && !this.barrierConsumed) {
      this.barrierConsumed = true;
      this.trace.barrierWaitCount += 1;
      await waitAtBarrier(this.barrier);
    }
    this.transactionDepth += 1;
    try {
      return await this.sql.begin(write);
    } finally {
      this.transactionDepth -= 1;
    }
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
    const service = createClientStateService({
      runtimeRepository,
      createClientStateEventStore: createClientStateEventRepository,
      serviceId: `postgres-expiry-worker-${Deno.pid}`,
    });
    const candidates = await service.listExpiredSessionCandidates(input.atEpochMs);
    const results: ClientMutationComputed[] = [];
    for (const candidate of candidates) {
      results.push(await executeClientExpiryWithOuterAttempts(
        service,
        runtimeRepository,
        toExpiryCommandInput(candidate),
        input.atEpochMs,
      ));
    }

    return {
      mode: input.mode,
      backendPid,
      resultCount: results.length,
      eventTypes: results
        .map((result) => result.outcome === 'idempotency-conflict'
          ? undefined
          : result.event?.eventType)
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

async function executeClientExpiryWithOuterAttempts(
  service: ReturnType<typeof createClientStateService>,
  runtimeRepository: PSqlRuntimeStateRepository,
  commandInput: Extract<ClientMutationCommandInput, { operation: 'expireSession' }>,
  atEpochMs: number,
): Promise<ClientMutationComputed> {
  const serviceId = `postgres-expiry-worker-${Deno.pid}`;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const command = await toClientMutationCommand(
      commandInput,
      {
        nowEpochMs: atEpochMs,
        serviceId,
        eventId: `postgres-client-expiry-event:${commandInput.commandId}`,
        attemptCount: attempt,
        expireAtEpochMs: atEpochMs + 24 * 60 * 60 * 1_000,
      },
      toClientMutationSystemAuthority(serviceId),
    );
    const read = await service.read(command);
    const computed = service.compute(command, read);
    service.validate(command, read, computed);
    try {
      if (requiresClientWrite(computed)) {
        await runtimeRepository.sql.begin(
          async (transaction) => await service.write(transaction, computed),
        );
      }
      return computed;
    } catch (error) {
      if (!(error instanceof RuntimeStateWriteConflictError) || attempt === 8) throw error;
      await delay(Math.min(16, 2 ** (attempt - 1)));
    }
  }
  throw new Error('Client expiry AppInbox-equivalent outer attempts exhausted');
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

function requireRequestId(requestId: unknown): string {
  return requireString(requestId, 'requestId');
}

function requireMatchingRequestId(
  actual: string | null,
  expected: string,
): string {
  if (actual !== expected) {
    throw new Error(`Mutation receipt requestId differs: expected ${expected}`);
  }
  return actual;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
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
