import process from 'node:process';
import { dirname, normalize } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from
  '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  createClientStateEventRepository,
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/\
persistence/group-topology-config-repository.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
  AuthSessionRepository, type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import { type ClientMutationIdempotencyRecord, validateClientMutationIdempotencyRecord } from '@shared-server/rallar-system/services/client-state-mutations.ts';
import { type GroupMutationIdempotencyRecord, validateGroupMutationIdempotencyRecord } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { readTopologyConfigMutationRecordBoundary } from
  '@shared-server/rallar-system/topology/config/mutation/topology-config-mutation-boundary.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
  AppClientInboxService,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import {
  AppGroupInboxService,
  toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  type RallarTimingEvent,
  type RallarTimingSink,
  recordRallarTiming,
} from '@shared-server/rallar-system/services/timing.ts';
import {
  createStateWriteBenchmarkArtifact,
  readBenchmarkGitIdentity,
} from './state-write/api-v1-state-write-benchmark-artifact.ts';
import { PRODUCTION_STATE_WRITE_MUTATION_CONTRACT } from './compare-api-v1-state-write-results.mjs';
import {
  type AppInboxAttemptObservation,
  deriveAppInboxAttemptObservations,
  parsePersistedResult,
  readAppInboxCommandType,
} from './api-v1-state-write-attempt-evidence.ts';
import {
  type ProductionReceiptEvidence,
  projectClientReceiptEvidence,
  projectGroupReceiptEvidence,
  projectTopologyReceiptEvidence,
} from './api-v1-state-write-receipt-evidence.ts';
import { STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS } from './state-write-wait-options.ts';
import {
  parseGroupTopologyRegressionReasons,
} from './pool-group-topology-state-write-position-balanced-results.mjs';
export { deriveAppInboxAttemptObservations } from './api-v1-state-write-attempt-evidence.ts';
export { STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS } from './state-write-wait-options.ts';
export { parseGroupTopologyRegressionReasons };

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';
const CLIENT_COUNT = 100;
const REQUIRED_CONCURRENCY = 10;
const MAX_WARMUP_RUNS = 10;
const MAX_MEASURED_RUNS = 100;
const MAX_CONCURRENCY = 256;
const BENCHMARK_SESSION_ISSUED_AT_EPOCH_MS = 1_700_000_000_000;
const BENCHMARK_SESSION_EXPIRES_AT_EPOCH_MS = 4_102_444_800_000;
const MUTATION_MIX = [
  'profile-instance',
  'membership',
  'presence-connect',
  'presence-heartbeat',
  'presence-disconnect',
  'config',
  'topology-source',
] as const;
type MutationKind = typeof MUTATION_MIX[number];

const WORKLOADS = [
  { name: 'uncontended', clients: CLIENT_COUNT, groups: 100 },
  { name: 'shared', clients: CLIENT_COUNT, groups: 5 },
  { name: 'hot', clients: CLIENT_COUNT, groups: 1 },
] as const;

type SqlMetrics = {
  statements: number;
  rowsRead: number;
  serializedResultBytes: number;
  readMs: number;
  writeMs: number;
  outboxSqlMs: number;
  transactionDurationMs: number;
};

type ProductionOutboxRecord = Readonly<{
  resourceId: string; outboxId: string;
  typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
  topicId: string;
  effectKind: string;
  canonicalCommandId?: string;
  commandIds: readonly string[];
}>;
type ProductionOutboxRepository = Readonly<{ find(outboxId: string): Promise<Readonly<{ record: ProductionOutboxRecord }> | undefined> }>;

type CorrectnessMetrics = {
  acceptedCommandCount: number;
  receiptCount: number;
  effectfulCommandCount: number;
  requiredOutboxIntentCount: number;
  outboxIntentCount: number;
  atomicCompletionFailures: number;
  dbwFindings: string[];
};

type OutcomeMetrics = {
  accepted: number;
  conflicted: number;
  transientRetries: number;
  exhausted: number;
  attempts: number;
};

type LatencySummary = { p50: number; p95: number; p99: number };
type SqlArtifactMetrics = Pick<
  SqlMetrics,
  'statements' | 'rowsRead' | 'serializedResultBytes'
>;
type PostgresArtifactMetrics = {
  transactionDurationMs: number;
  lockWaitMs: number;
  cpuTimeMs: number;
  sharedBufferHits: number;
  sharedBufferReads: number;
  walBytes: number;
};
type TimingArtifactMetrics = {
  read: number;
  compute: number;
  validate: number;
  write: number;
  transaction: number;
  outbox: number;
};
type OutcomeArtifactMetrics = OutcomeMetrics & { attemptsPerAcceptedMutation: number };
type RawCommand = {
  commandId: string;
  kind: MutationKind;
  latencyMs: number;
  stackIndex: number;
  status: 'accepted' | 'exhausted';
};
type AttemptObservation = AppInboxAttemptObservation;
type DurableEvidence = {
  appInbox: AppInboxAttemptEvidence[];
  receipts: MutationReceiptEvidence[];
  resourceOutbox: ResourceOutboxEvidence[];
  intermediateMutationIntents: [];
  atomicCompletionFailures: number;
};
type AppInboxAttemptEvidence = Readonly<{
  commandId: string;
  operationId: string;
  resourceId: string;
  topicId: string;
  status: string;
  resultStatus: string;
  attempts: number;
  retryDelayMs: number;
  dueAgeMs: number;
  selectedLane: 'fast' | 'fairness' | 'timeout';
  transactionDurationMs: number;
  commandType: string;
  durableResult: unknown;
}>;
type MutationReceiptEvidence = ProductionReceiptEvidence;
type ResourceOutboxEvidence = Readonly<{
  effectId: string; resourceId: string; outboxId: string;
  commandId: string;
  effectKind: string;
  typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
  topicId: string;
}>;
type RunSample = {
  runIndex: number;
  durationMs: number;
  throughputPerSecond: number;
  latencySamplesMs: number[];
  latencyMs: LatencySummary;
  outcomes: OutcomeArtifactMetrics;
  sql: SqlArtifactMetrics;
  postgres: PostgresArtifactMetrics;
  timingsMs: TimingArtifactMetrics;
  correctness: CorrectnessMetrics;
  commands: RawCommand[];
  attemptObservations: AttemptObservation[];
  stackCommandCounts: [number, number];
  durableEvidence: DurableEvidence;
};
type WorkloadSummary = Pick<
  RunSample,
  | 'throughputPerSecond'
  | 'latencyMs'
  | 'outcomes'
  | 'sql'
  | 'postgres'
  | 'timingsMs'
  | 'correctness'
>;

type RunContext = {
  sql: SqlMetrics;
  timingEvents: RallarTimingEvent[];
  attemptReleases: ResourceInboxAttemptReleaseTelemetry[];
};

type ServiceRuntime = {
  client: AppClientInboxService;
  group: AppGroupInboxService;
  inbox: InboxQueueReader;
  resilience: ResilienceDto;
  serviceId: string;
};

type MutationCommand = {
  kind: MutationKind;
  clientIndex: number;
  groupIndex: number;
};

type PgCounters = {
  sharedBufferHits: number;
  sharedBufferReads: number;
  walLsn: string;
};

type PSqlSavepointMethod = <T>(
  fn: (sql: PSqlTransactionSql) => Promise<T>,
) => Promise<T>;

export function createBenchmarkAuthSession(
  scope: StateScope,
  principalId: string,
  sessionLabel: string,
): IssuedAuthSession {
  const scopeIdentity = `${encodeURIComponent(scope.applicationId)}:${
    encodeURIComponent(scope.workspaceId)
  }`;
  const principalIdentity = encodeURIComponent(principalId);
  const sessionIdentity = encodeURIComponent(sessionLabel);
  return {
    clientId: principalId,
    username: principalId,
    sessionId: `${scopeIdentity}:${principalIdentity}:${sessionIdentity}`,
    accessToken: `state-write-benchmark:${scopeIdentity}:${principalIdentity}:${sessionIdentity}`,
    issuedAtEpochMs: BENCHMARK_SESSION_ISSUED_AT_EPOCH_MS,
    expiresAtEpochMs: BENCHMARK_SESSION_EXPIRES_AT_EPOCH_MS,
  };
}

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const options = parseBenchmarkOptions(Deno.args);
  if (options.backend !== 'postgres') {
    throw new Error(`Task 0B requires --backend=postgres; received ${options.backend}`);
  }
  if (options.warmup !== 1) {
    throw new Error(`Task 0B requires --warmup=1; received ${options.warmup}`);
  }
  if (options.runs < 3) {
    throw new Error(`Task 0B requires --runs>=3; received ${options.runs}`);
  }
  if (options.concurrency !== REQUIRED_CONCURRENCY) {
    throw new Error(
      `Task 0B requires --concurrency=${REQUIRED_CONCURRENCY}; received ${options.concurrency}`,
    );
  }
  assertPerfOutputPath(options.out);
  const gitIdentity = await readBenchmarkGitIdentity();
  const reasonsText = options.regressionReasonsFile === undefined
    ? undefined : await Deno.readTextFile(options.regressionReasonsFile);
  const regressionReasons = parseGroupTopologyRegressionReasons(reasonsText, gitIdentity);

  const databaseUrl = Deno.env.get('DATABASE_URL')?.trim() || DEFAULT_DATABASE_URL;
  const runId = `state-write-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const adminSql = postgres(databaseUrl, {
    max: 10,
    connection: { application_name: `${runId}-admin` },
  });
  const serviceSql = [0, 1].map((index) =>
    postgres(databaseUrl, {
      max: options.concurrency,
      connection: { application_name: `${runId}-service-${index}` },
    })
  );

  try {
    await assertSchemaReady(adminSql);
    const workloads = [];
    for (const workload of WORKLOADS) {
      console.log(`Running ${workload.name}: warmup=${options.warmup}, measured=${options.runs}`);
      for (let warmup = 0; warmup < options.warmup; warmup += 1) {
        await runWorkloadPhase({
          adminSql,
          serviceSql,
          runId,
          workload,
          phaseLabel: `warmup-${warmup}`,
          runIndex: warmup,
          measured: false,
          concurrency: options.concurrency,
        });
      }
      const samples: RunSample[] = [];
      for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
        samples.push(
          await runWorkloadPhase({
            adminSql,
            serviceSql,
            runId,
            workload,
            phaseLabel: `measured-${runIndex}`,
            runIndex,
            measured: true,
            concurrency: options.concurrency,
          }),
        );
      }
      const summary = summarizeSamples(samples);
      workloads.push({
        name: workload.name,
        scale: {
          clients: workload.clients,
          groups: workload.groups,
          concurrency: options.concurrency,
        },
        mutationMix: [...MUTATION_MIX],
        warmupRuns: options.warmup,
        measuredRuns: options.runs,
        samples,
        summary,
      });
      console.log(JSON.stringify({ workload: workload.name, ...summary }));
    }

    const artifact = createStateWriteBenchmarkArtifact({
      generatedAt: new Date().toISOString(),
      gitIdentity,
      options,
      regressionReasons,
      workloads,
    });

    await Deno.mkdir(dirname(options.out), { recursive: true });
    await Deno.writeTextFile(options.out, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`Wrote ${options.out}`);
  } finally {
    await Promise.allSettled([
      adminSql.end({ timeout: 5 }),
      ...serviceSql.map((sql) => sql.end({ timeout: 5 })),
    ]);
  }
}

async function runWorkloadPhase(input: {
  adminSql: Sql;
  serviceSql: readonly Sql[];
  runId: string;
  workload: typeof WORKLOADS[number];
  phaseLabel: string;
  runIndex: number;
  measured: boolean;
  concurrency: number;
}): Promise<RunSample> {
  const scope: StateScope = {
    applicationId: `${input.runId}-${input.workload.name}-${input.phaseLabel}`,
    workspaceId: 'state-write-bench',
  };
  await seedCompleteState(input.adminSql, scope, input.workload);

  const context = newRunContext();
  const timing: RallarTimingSink = (event) => context.timingEvents.push(event);
  const runtimes = input.serviceSql.map((sql, index) =>
    createServiceRuntime(sql, `state-write-bench-${index}`, context, timing)
  );
  const commands = createCommands(input.workload);
  const postgresBefore = await capturePgCounters(input.adminSql);
  const cpuBefore = process.cpuUsage();
  const lockSampler = startLockWaitSampler(input.adminSql, `${input.runId}-service-`);
  const rawCommands: RawCommand[] = [];
  const startedAt = performance.now();

  try {
    for (const kind of MUTATION_MIX) {
      const phaseCommands = commands.filter((command) => command.kind === kind);
      const phaseResults = await mapWithConcurrency(
        phaseCommands,
        input.concurrency,
        async (command, commandIndex) => {
          const stackIndex = selectServiceStack(commandIndex, runtimes.length);
          const commandId = commandIdentifier(scope, command);
          const commandStartedAt = performance.now();
          await executeMeasuredCommand(
            runtimes[stackIndex]!,
            scope,
            command,
            commandId,
            timing,
          );
          return {
            commandId,
            kind,
            latencyMs: performance.now() - commandStartedAt,
            stackIndex,
            status: 'accepted' as const,
          };
        },
      );
      rawCommands.push(...phaseResults);
    }
  } catch (error) {
    await rethrowAfterCleanup(error, lockSampler.stop);
  }

  const durationMs = performance.now() - startedAt;
  const lockWaitMs = await lockSampler.stop();
  const cpu = process.cpuUsage(cpuBefore);
  const postgresAfter = await capturePgCounters(input.adminSql);
  const walBytes = await walDifference(input.adminSql, postgresBefore.walLsn, postgresAfter.walLsn);
  const durable = await queryDurableEvidence(
    input.adminSql,
    scope,
    rawCommands,
    input.workload.groups,
    context.timingEvents,
  );
  const attemptObservations = deriveAppInboxAttemptObservations(
    context.attemptReleases,
    durable.appInbox,
    rawCommands,
  );
  const accepted = rawCommands.filter((command) => command.status === 'accepted').length;
  const attempts = attemptObservations.length;
  const outcomes: OutcomeMetrics = {
    accepted,
    conflicted: attemptObservations.filter((entry) => entry.outcome === 'conflicted').length,
    transientRetries: attemptObservations.filter((entry) =>
      entry.outcome === 'transient-retry'
    ).length,
    exhausted: rawCommands.filter((command) => command.status === 'exhausted').length,
    attempts,
  };
  const correctness = deriveCorrectness(rawCommands, durable);
  const latencySamplesMs = rawCommands.map((command) => command.latencyMs);
  const stackCommandCounts: [number, number] = [
    rawCommands.filter((command) => command.stackIndex === 0).length,
    rawCommands.filter((command) => command.stackIndex === 1).length,
  ];
  const sample = {
    runIndex: input.runIndex,
    durationMs,
    throughputPerSecond: accepted / (durationMs / 1_000),
    latencySamplesMs,
    latencyMs: summarizeLatency(latencySamplesMs),
    outcomes: {
      ...outcomes,
      attemptsPerAcceptedMutation: accepted === 0 ? attempts : attempts / accepted,
    },
    sql: {
      statements: context.sql.statements,
      rowsRead: context.sql.rowsRead,
      serializedResultBytes: context.sql.serializedResultBytes,
    },
    postgres: {
      transactionDurationMs: context.sql.transactionDurationMs,
      lockWaitMs,
      cpuTimeMs: (cpu.user + cpu.system) / 1_000,
      sharedBufferHits: nonNegativeDelta(
        postgresAfter.sharedBufferHits,
        postgresBefore.sharedBufferHits,
      ),
      sharedBufferReads: nonNegativeDelta(
        postgresAfter.sharedBufferReads,
        postgresBefore.sharedBufferReads,
      ),
      walBytes,
    },
    timingsMs: {
      read: productionPhaseDuration(context.timingEvents, 'read'),
      compute: productionPhaseDuration(context.timingEvents, 'compute'),
      validate: productionPhaseDuration(context.timingEvents, 'validate'),
      write: productionPhaseDuration(context.timingEvents, 'write'),
      transaction: productionPhaseDuration(context.timingEvents, 'transaction'),
      outbox: context.sql.outboxSqlMs,
    },
    correctness,
    commands: rawCommands,
    attemptObservations,
    stackCommandCounts,
    durableEvidence: durable,
  };
  return sample;
}

export async function rethrowAfterCleanup(
  error: unknown,
  cleanup: () => Promise<unknown>,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error('State-write benchmark cleanup failed after command failure', cleanupError);
  }
  throw error;
}
function createServiceRuntime(
  sql: Sql,
  serviceId: string,
  context: RunContext,
  timing: RallarTimingSink,
): ServiceRuntime {
  const instrumentedSql = createInstrumentedSql(sql as unknown as PSqlSql, context, timing);
  const runtimeRepository = new PSqlRuntimeStateRepository(instrumentedSql);
  const authSessionRepository = new AuthSessionRepository(runtimeRepository);
  const groupState = createGroupStateService({
    runtimeRepository,
    createGroupStateEventStore: createGroupStateEventRepository,
    serviceId,
    timing,
    authSessionRepository,
  });
  const resourceInbox = new ResourceInboxRepository(instrumentedSql);
  const inbox = new InboxQueueReader(new PSqlQueueBox(resourceInbox), {
    onAttemptReleaseTelemetry: (event) => context.attemptReleases.push(event),
  });
  const results = new ResourceInboxResultsRepository(instrumentedSql);
  const client = new AppClientInboxService(
    inbox,
    resourceInbox,
    results,
    instrumentedSql,
    createClientStateService({
      runtimeRepository,
      createClientStateEventStore: createClientStateEventRepository,
      serviceId,
      timing,
    }),
    serviceId,
    timing,
    STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.client,
  );
  const group = new AppGroupInboxService(
    inbox,
    resourceInbox,
    results,
    instrumentedSql,
    groupState,
    serviceId,
    timing,
    STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS.group,
  );
  group.setTopologyManagementService(new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => groupState.readSnapshot(ref),
    groupStateRepository: new GroupStateRepository(runtimeRepository),
    configRepository: new GroupTopologyConfigRepository(runtimeRepository),
    topologyService: new RallarRtcTopologyService(),
    timing,
    serviceId,
  }));
  return {
    client, group, inbox,
    resilience: createBenchmarkResilience(),
    serviceId,
  };
}

function createBenchmarkResilience(): ResilienceDto {
  const duration = Temporal.Duration.from({ seconds: 10 });
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(100, duration, duration, duration),
    REQUIRED_CONCURRENCY,
    REQUIRED_CONCURRENCY,
    1,
    1,
  );
}

export function createInstrumentedSql(
  sql: PSqlSql,
  context: RunContext,
  timing: RallarTimingSink,
): PSqlSql {
  const instrumented = function <T>(
    stringsOrValues: TemplateStringsArray | readonly unknown[],
    ...values: unknown[]
  ): Promise<T> | unknown {
    if (!isTemplateStringsArray(stringsOrValues)) {
      return sql(stringsOrValues);
    }
    const queryText = stringsOrValues.join('?');
    const category = classifyBenchmarkSql(queryText, values);
    const startedAt = performance.now();
    return Promise.resolve(sql<T>(stringsOrValues, ...values)).then(
      (result) => {
        const durationMs = performance.now() - startedAt;
        observeSql(context.sql, category, result, durationMs);
        recordRallarTiming(
          timing,
          {
            component: 'state-write-benchmark-sql',
            operation: category,
            details: { statement: firstSqlKeyword(queryText) },
          },
          'ok',
          durationMs,
        );
        return result;
      },
      (error) => {
        const durationMs = performance.now() - startedAt;
        observeSql(context.sql, category, undefined, durationMs);
        recordRallarTiming(
          timing,
          {
            component: 'state-write-benchmark-sql',
            operation: category,
            details: { statement: firstSqlKeyword(queryText) },
          },
          'error',
          durationMs,
          error,
        );
        throw error;
      },
    );
  } as PSqlSql;
  instrumented.begin = async <T>(fn: (transaction: PSqlTransactionSql) => Promise<T>) => {
    const startedAt = performance.now();
    try {
      return await sql.begin(async (transaction) =>
        await fn(createInstrumentedSql(transaction, context, timing))
      );
    } finally {
      const durationMs = performance.now() - startedAt;
      context.sql.transactionDurationMs += durationMs;
      recordRallarTiming(
        timing,
        {
          component: 'state-write-benchmark-phase',
          operation: 'transaction',
        },
        'ok',
        durationMs,
      );
    }
  };
  const savepoint = (sql as PSqlSql & { savepoint?: PSqlSavepointMethod }).savepoint;
  if (typeof savepoint === 'function') {
    const invokeSavepoint = savepoint.bind(sql) as PSqlSavepointMethod;
    (instrumented as PSqlSql & { savepoint: PSqlSavepointMethod }).savepoint = async <T>(
      fn: (transaction: PSqlTransactionSql) => Promise<T>,
    ): Promise<T> =>
      await invokeSavepoint<T>(
        async (transaction) => await fn(createInstrumentedSql(transaction, context, timing)),
      );
  }
  return instrumented;
}

async function executeMeasuredCommand(
  runtime: ServiceRuntime,
  scope: StateScope,
  command: MutationCommand,
  requestId: string,
  timing: RallarTimingSink,
): Promise<void> {
  const prepared = {
    requestId,
    principalId: `client-${command.clientIndex}`,
    instanceId: `instance-${command.clientIndex}`,
    clientAuthority: createBenchmarkAuthSession(
      scope,
      `client-${command.clientIndex}`,
      `client-session-${command.clientIndex}`,
    ),
    ownerAuthority: createBenchmarkAuthSession(
      scope,
      `owner-${command.groupIndex}`,
      `owner-session-${command.groupIndex}`,
    ),
    groupId: `group-${command.groupIndex}`,
    ownerId: `owner-${command.groupIndex}`,
    timestamp: Date.now() + command.clientIndex,
  };
  const preparedWithPresenceIdentity = {
    ...prepared,
    sessionId: prepared.clientAuthority.sessionId,
    generationId: `${prepared.clientAuthority.sessionId}:generation-1`,
  };
  await executeMutation(
    runtime,
    scope,
    command.kind,
    preparedWithPresenceIdentity,
    timing,
  );
}

async function executeMutation(
  runtime: ServiceRuntime,
  scope: StateScope,
  kind: MutationKind,
  command: Readonly<{
    requestId: string;
    principalId: string;
    instanceId: string;
    sessionId: string;
    groupId: string;
    ownerId: string;
    timestamp: number;
    generationId: string;
    clientAuthority: IssuedAuthSession;
    ownerAuthority: IssuedAuthSession;
  }>,
  timing: RallarTimingSink,
): Promise<void> {
  void timing;
  const clientContextId = inboxContextId(scope.applicationId, scope.workspaceId, command.principalId);
  const groupContextId = inboxContextId(scope.applicationId, scope.workspaceId, command.groupId);
  switch (kind) {
    case 'profile-instance': {
      await runAppInboxMutation(runtime, () =>
        runtime.client.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
          resourceId: `${command.requestId}-profile`,
          contextId: clientContextId,
          senderId: command.principalId,
          data: {
            scope,
            principalId: command.principalId,
            request: {
              username: command.principalId,
              displayName: `${command.principalId}-measured`,
              metadata: { source: 'state-write-benchmark' },
              actorPrincipalId: command.principalId,
              requestId: `${command.requestId}-profile`,
            },
          },
        }, command.clientAuthority)
      );
      await runAppInboxMutation(runtime, () =>
        runtime.client.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.CLIENT_INSTANCE_UPSERT,
          resourceId: `${command.requestId}-instance`,
          contextId: clientContextId,
          senderId: command.principalId,
          data: {
            scope,
            principalId: command.principalId,
            clientInstanceId: command.instanceId,
            request: {
              status: 'active', platform: 'web', appVersion: 'task-12',
              capabilities: ['state-write-benchmark'],
              actorPrincipalId: command.principalId,
              requestId: `${command.requestId}-instance`,
            },
          },
        }, command.clientAuthority)
      );
      return;
    }
    case 'membership': {
      await runAppInboxMutation(runtime, () =>
        runtime.group.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.GROUP_MEMBER_UPSERT,
          resourceId: command.requestId,
          contextId: groupContextId,
          senderId: command.principalId,
          data: {
            scope, groupId: command.groupId, principalId: command.principalId,
            request: {
              status: 'active', actorPrincipalId: command.principalId,
              requestId: command.requestId,
            },
          },
        }, command.clientAuthority)
      );
      return;
    }
    case 'presence-connect': {
      await runGroupPresenceMutation(runtime, command, scope, groupContextId,
        AppInboxType.GROUP_PRESENCE_CONNECT, {
          principalId: command.principalId, generationId: command.generationId,
          connectedAtEpochMs: command.timestamp,
          lastHeartbeatAtEpochMs: command.timestamp,
          expiresAtEpochMs: command.timestamp + 60_000,
          actorPrincipalId: command.principalId, actorSessionId: command.sessionId,
          requestId: command.requestId,
        });
      return;
    }
    case 'presence-heartbeat': {
      await runGroupPresenceMutation(runtime, command, scope, groupContextId,
        AppInboxType.GROUP_PRESENCE_HEARTBEAT, {
          principalId: command.principalId, generationId: command.generationId,
          lastHeartbeatAtEpochMs: command.timestamp + 1_000,
          expiresAtEpochMs: command.timestamp + 61_000,
          actorPrincipalId: command.principalId, actorSessionId: command.sessionId,
          requestId: command.requestId,
        });
      return;
    }
    case 'presence-disconnect': {
      await runGroupPresenceMutation(runtime, command, scope, groupContextId,
        AppInboxType.GROUP_PRESENCE_DISCONNECT, {
          principalId: command.principalId, generationId: command.generationId,
          disconnectedAtEpochMs: command.timestamp + 2_000,
          lastHeartbeatAtEpochMs: command.timestamp + 1_000,
          expiresAtEpochMs: command.timestamp + 61_000,
          actorPrincipalId: command.principalId, actorSessionId: command.sessionId,
          requestId: command.requestId,
        });
      return;
    }
    case 'config': {
      await runAppInboxMutation(runtime, () =>
        runtime.group.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.GROUP_UPDATE,
          resourceId: command.requestId,
          contextId: groupContextId,
          senderId: command.ownerId,
          data: {
            scope, groupId: command.groupId,
            request: {
              metadata: { benchmarkConfigSource: command.requestId },
              actorPrincipalId: command.ownerId,
              requestId: command.requestId,
            },
          },
        }, command.ownerAuthority)
      );
      return;
    }
    case 'topology-source': {
      const data = await toTopologyAppInboxCommand({
        actor: { principalId: command.ownerId, sessionId: command.ownerAuthority.sessionId },
        groupRef: { ...scope, groupId: command.groupId },
        requestId: command.requestId,
        capturedAtEpochMs: command.timestamp,
        payload: { operation: 'putConfig', config: {
          topologyKind: command.timestamp % 2 === 0 ? 'tree' : 'mesh',
          degreeLimit: 5, treeMinSize: 5, meshMinSize: 16, meshParamK: 2,
        } },
      });
      await runAppInboxMutation(runtime, () =>
        runtime.group.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.TOPOLOGY_CONFIG_PUT,
          resourceId: command.requestId,
          contextId: groupContextId,
          senderId: command.ownerId,
          data,
        }, command.ownerAuthority)
      );
      return;
    }
  }
}

async function runGroupPresenceMutation(
  runtime: ServiceRuntime,
  command: Parameters<typeof executeMutation>[3],
  scope: StateScope,
  contextId: string,
  type: AppInboxType,
  request: Record<string, unknown>,
): Promise<void> {
  await runAppInboxMutation(runtime, () =>
    runtime.group.processAuthenticatedEntryUntilCompletion({
      type, resourceId: command.requestId, contextId,
      senderId: command.principalId,
      data: { scope, groupId: command.groupId, sessionId: command.sessionId, request },
    }, command.clientAuthority)
  );
}

async function runAppInboxMutation(
  runtime: ServiceRuntime,
  start: () => Promise<{ fold(left: (value: string) => never, right: (value: unknown) => unknown): unknown }>,
): Promise<void> {
  let settled = false;
  const pending = start().finally(() => settled = true);
  while (!settled) {
    await runtime.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, runtime.resilience);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const result = await pending;
  result.fold((error) => { throw new Error(error); }, () => undefined);
}

function inboxContextId(...parts: string[]): string {
  return parts.map(encodeURIComponent).join(':');
}

async function seedCompleteState(
  sql: Sql,
  scope: StateScope,
  workload: typeof WORKLOADS[number],
): Promise<void> {
  const pgSql = sql as unknown as PSqlSql;
  const runtimeRepository = new PSqlRuntimeStateRepository(pgSql);
  const authSessionRepository = new AuthSessionRepository(runtimeRepository);
  const runtime = createServiceRuntime(
    sql,
    'state-write-bench-seed',
    newRunContext(),
    () => undefined,
  );

  await mapWithConcurrency(
    Array.from({ length: workload.groups }, (_, groupIndex) => groupIndex),
    REQUIRED_CONCURRENCY,
    async (groupIndex) => {
      const ownerId = `owner-${groupIndex}`;
      const authority = createBenchmarkAuthSession(
        scope,
        ownerId,
        `owner-session-${groupIndex}`,
      );
      await authSessionRepository.putSession(authority);
      const groupId = `group-${groupIndex}`;
      await runAppInboxMutation(runtime, () =>
        runtime.group.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.GROUP_CREATE,
          resourceId: `seed-group-${groupIndex}`,
          contextId: inboxContextId(scope.applicationId, scope.workspaceId, groupId),
          senderId: ownerId,
          data: { scope, request: {
            groupId, displayName: `State Write Benchmark Group ${groupIndex}`,
            kind: 'room', joinMode: 'open', maxMembers: CLIENT_COUNT + 1,
            maxSessionsPerMember: 4, metadata: { benchmark: true },
            createdByPrincipalId: ownerId, actorPrincipalId: ownerId,
            actorSessionId: authority.sessionId, requestId: `seed-group-${groupIndex}`,
          } },
        }, authority)
      );
    },
  );

  await mapWithConcurrency(
    Array.from({ length: workload.clients }, (_, clientIndex) => clientIndex),
    REQUIRED_CONCURRENCY,
    async (clientIndex) => {
      const principalId = `client-${clientIndex}`;
      const authority = createBenchmarkAuthSession(
        scope,
        principalId,
        `client-session-${clientIndex}`,
      );
      await authSessionRepository.putSession(authority);
      const contextId = inboxContextId(scope.applicationId, scope.workspaceId, principalId);
      await runAppInboxMutation(runtime, () =>
        runtime.client.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
          resourceId: `seed-principal-${clientIndex}`,
          contextId, senderId: principalId,
          data: { scope, principalId, request: {
            username: principalId, displayName: `Seed Client ${clientIndex}`,
            status: 'active', actorPrincipalId: principalId,
            requestId: `seed-principal-${clientIndex}`,
          } },
        }, authority)
      );
      await runAppInboxMutation(runtime, () =>
        runtime.client.processAuthenticatedEntryUntilCompletion({
          type: AppInboxType.CLIENT_INSTANCE_UPSERT,
          resourceId: `seed-instance-${clientIndex}`,
          contextId, senderId: principalId,
          data: { scope, principalId, clientInstanceId: `instance-${clientIndex}`, request: {
            status: 'active', platform: 'web', appVersion: 'seed',
            actorPrincipalId: principalId, requestId: `seed-instance-${clientIndex}`,
          } },
        }, authority)
      );
    },
  );
}

function createCommands(workload: typeof WORKLOADS[number]): MutationCommand[] {
  return MUTATION_MIX.flatMap((kind) =>
    Array.from({ length: workload.clients }, (_, clientIndex) => ({
      kind,
      clientIndex,
      groupIndex: clientIndex % workload.groups,
    }))
  );
}

function commandIdentifier(scope: StateScope, command: MutationCommand): string {
  return `${scope.applicationId}:${command.kind}:${command.clientIndex}`;
}

export function selectServiceStack(commandIndex: number, stackCount: number): number {
  if (!Number.isInteger(commandIndex) || commandIndex < 0) {
    throw new Error('commandIndex must be a non-negative integer');
  }
  if (!Number.isInteger(stackCount) || stackCount < 1) {
    throw new Error('stackCount must be a positive integer');
  }
  return commandIndex % stackCount;
}

function productionPhaseDuration(
  events: readonly RallarTimingEvent[],
  phase: 'read' | 'compute' | 'validate' | 'write' | 'transaction',
): number {
  return sum(
    events.filter((event) =>
      (event.component === 'client-state-service' ||
        event.component === 'group-state-service' ||
        event.component === 'group-topology-config-service') &&
      event.operation === `mutation.${phase}`
    ).map((event) => event.durationMs),
  );
}

async function queryDurableEvidence(
  sql: Sql,
  scope: StateScope,
  commands: readonly RawCommand[],
  groupCount: number,
  timingEvents: readonly RallarTimingEvent[],
): Promise<DurableEvidence> {
  const runtime = new PSqlRuntimeStateRepository(sql as unknown as PSqlSql);
  const clients = new ClientStateRepository(runtime);
  const groups = new GroupStateRepository(runtime);
  const topology = new GroupTopologyConfigRepository(runtime);
  const outbox = createProductionOutboxRepository(sql);
  const acceptedCommands = commands.filter((command) => command.status === 'accepted');
  const receiptResults = await mapWithConcurrency(
    acceptedCommands,
    25,
    async (command): Promise<ProductionReceiptEvidence | undefined> => {
      const clientIndex = Number(
        command.commandId.slice(command.commandId.lastIndexOf(':') + 1),
      );
      if (!Number.isSafeInteger(clientIndex) || clientIndex < 0) {
        throw new Error(`Benchmark command ID has no client index: ${command.commandId}`);
      }
      const productionCommandIds = productionCommandIdsForRaw(command);

      if (command.kind === 'profile-instance') {
        const receipts = await Promise.all(productionCommandIds.map(async (requestId) =>
          await clients.findIdempotentClientMutationReceipt(
            { ...scope, principalId: `client-${clientIndex}` },
            requestId,
          )
        ));
        if (!receipts.every((receipt, index) =>
          isValidProductionReceipt(receipt, productionCommandIds[index]!))) {
          return undefined;
        }
        return projectClientReceiptEvidence(command.commandId, receipts);
      }
      if (command.kind === 'topology-source') {
        const groupRef = { ...scope, groupId: `group-${clientIndex % groupCount}` };
        const receipt = readValidatedTopologyMutationReceipt(
          await topology.findMutationRecord(groupRef, command.commandId),
          groupRef,
          command.commandId,
        );
        if (!receipt) {
          return undefined;
        }
        return projectTopologyReceiptEvidence(command.commandId, receipt);
      }
      const receipt = await groups.findIdempotentGroupMutationReceipt(
        { ...scope, groupId: `group-${clientIndex % groupCount}` },
        command.commandId,
      );
      if (!isValidatedReceiptIdentity(
        receipt,
        { ...scope, groupId: `group-${clientIndex % groupCount}` },
        command.commandId,
      )) return undefined;
      return projectGroupReceiptEvidence(command.commandId, receipt);
    },
  );
  const receipts = receiptResults.filter(
    (receipt): receipt is ProductionReceiptEvidence => receipt !== undefined,
  );
  const receiptsByCommand = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
  const productionRecords = await readReferencedProductionOutboxRecords(outbox, commands.flatMap(
    (command) => productionOutboxLookupIds(
      command, scope, groupCount, receiptsByCommand.get(command.commandId)?.outboxIds ?? [],
    ),
  ));

  const appInbox = await readAppInboxEvidence(sql, scope, commands, timingEvents);
  const resourceOutbox = projectProductionOutboxEvidence(commands, receipts, productionRecords);
  const provisional = {
    appInbox: appInbox.toSorted((left, right) => left.resourceId.localeCompare(right.resourceId)),
    receipts: receipts.toSorted((left, right) => left.commandId.localeCompare(right.commandId)),
    resourceOutbox: resourceOutbox.toSorted((left, right) => left.effectId.localeCompare(right.effectId)),
    intermediateMutationIntents: [] as [],
    atomicCompletionFailures: 0,
  };
  return {
    ...provisional,
    atomicCompletionFailures: countAtomicCompletionFailures(commands, provisional),
  };
}

async function readAppInboxEvidence(
  sql: Sql,
  scope: StateScope,
  commands: readonly RawCommand[],
  timingEvents: readonly RallarTimingEvent[],
): Promise<AppInboxAttemptEvidence[]> {
  const rows = await sql<readonly {
    ri_resource_id: string; ri_topic_id: string; ri_resource: string; ri_status: string;
    ri_attempts: number | string; retry_delay_ms: number | string; due_age_ms: number | string;
    result_status: string | null; result_resource: string | null;
  }[]>`
    select i.ri_resource_id, i.ri_topic_id, i.ri_resource, i.ri_status, i.ri_attempts,
           coalesce(greatest(0, extract(epoch from (i.next_ts - i.end_ts)) * 1000), 0)::float8 as retry_delay_ms,
           coalesce(greatest(0, extract(epoch from (now() - i.next_ts)) * 1000), 0)::float8 as due_age_ms,
           r.ris_status as result_status, r.ris_resource as result_resource
    from resource_inbox i
    left join resource_inbox_results r
      on r.fk_ext_bank_id = i.fk_ext_bank_id
     and r.ris_resource_id = i.ri_resource_id
     and r.ris_topic_id = i.ri_topic_id
    where i.ri_type_id = 'APP_INBOX'
      and i.ri_resource like ${`%${scope.applicationId}%`}
  `;
  const byProductionId = new Map(commands.flatMap((command) =>
    productionCommandIdsForRaw(command).map((productionId, index) => [productionId, {
      commandId: command.commandId,
      operationId: command.kind === 'profile-instance' ? index === 0 ? 'profile' : 'instance' : 'command',
    }] as const)
  ));
  return rows.flatMap((row) => {
    const ids = readAllCommandIds(row.ri_resource);
    const link = ids.map((id) => byProductionId.get(id)).find((entry) => entry !== undefined);
    if (!link) return [];
    const transaction = timingEvents.filter((event) =>
      event.component === 'app-inbox-phase' && event.operation === 'transaction' &&
      (event.requestId === row.ri_resource_id || ids.includes(event.requestId ?? ''))
    ).at(-1);
    const dueAgeMs = Number(transaction?.details?.dueAgeMs ?? row.due_age_ms);
    return [{
      ...link,
      resourceId: row.ri_resource_id,
      topicId: row.ri_topic_id,
      status: row.ri_status,
      resultStatus: row.result_status ?? 'MISSING',
      attempts: Number(row.ri_attempts),
      retryDelayMs: Number(row.retry_delay_ms),
      dueAgeMs,
      selectedLane: dueAgeMs >= 30_000 ? 'fairness' as const : 'fast' as const,
      transactionDurationMs: transaction?.durationMs ?? 0,
      commandType: readAppInboxCommandType(row.ri_resource),
      durableResult: parsePersistedResult(row.result_resource),
    }];
  });
}

export async function readReferencedProductionOutboxRecords(
  repository: ProductionOutboxRepository,
  outboxIds: readonly string[],
): Promise<readonly ProductionOutboxRecord[]> {
  const stored = await mapWithConcurrency(
    [...new Set(outboxIds)],
    25,
    async (outboxId) => await repository.find(outboxId),
  );
  return stored.flatMap((entry) => entry ? [entry.record] : []);
}

export function createProductionOutboxRepository(sql: Sql): ProductionOutboxRepository {
  return {
    find: async (outboxId) => {
      const rows = await sql<readonly { ri_resource_id: string; ri_topic_id: string; ri_type_id: string; ri_resource: string; outbox_id: string }[]>`
        select ri_resource_id, ri_topic_id, ri_type_id, ri_resource,
               ri_resource::jsonb #>> '{id,msgId}' as outbox_id
        from resource_inbox
        where ri_resource_id = ${outboxId}
      `;
      const row = rows[0];
      if (!row) return undefined;
      return {
        record: {
          resourceId: row.ri_resource_id, outboxId: row.outbox_id,
          typeId: requireOutboxType(row.ri_type_id),
          topicId: row.ri_topic_id,
          effectKind: readResourceEffectKind(row),
          canonicalCommandId: readCanonicalEffectCommandId(row.ri_resource),
          commandIds: readAllCommandIds(row.ri_resource),
        },
      };
    },
  };
}

export function readAllCommandIds(resource: string): string[] {
  try {
    return [...new Set(findCommandIds(JSON.parse(resource)))];
  } catch {
    return [];
  }
}

export function readCanonicalEffectCommandId(resource: string): string | undefined {
  try {
    const envelope = JSON.parse(resource) as { id?: { msgId?: unknown } };
    return effectIdentityCommandIds(envelope.id?.msgId)[0];
  } catch {
    return undefined;
  }
}

function findCommandIds(value: unknown): string[] {
  if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
    try {
      return findCommandIds(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.commandId === 'string' ? [record.commandId] : []),
    ...(typeof record.requestId === 'string' ? [record.requestId] : []),
    ...effectIdentityCommandIds(record.msgId),
    ...effectIdentityCommandIds(record.resourceId),
    ...Object.values(record).flatMap(findCommandIds),
  ];
}

function effectIdentityCommandIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  for (const marker of [
    ':rtc-topology-recompute:', ':group-presence-summary:', ':principal-state:',
  ]) {
    const index = value.indexOf(marker);
    if (index > 0) return [value.slice(0, index)];
  }
  return [];
}

export function productionOutboxLookupIds(
  command: RawCommand,
  scope: StateScope,
  groupCount: number,
  receiptOutboxIds: readonly string[],
): readonly string[] {
  if (command.kind !== 'topology-source') return receiptOutboxIds;
  const clientIndex = Number(command.commandId.slice(command.commandId.lastIndexOf(':') + 1));
  if (!Number.isSafeInteger(clientIndex) || clientIndex < 0) return [];
  const contextId = groupStateGroupStorageKey({
    ...scope,
    groupId: `group-${clientIndex % groupCount}`,
  });
  return receiptOutboxIds.map((resourceId) => toAppQueueKey({
    topicId: 'app-outbox.rtc-topology', resourceId, contextId,
  }).resourceId);
}

function productionCommandIdsForRaw(command: RawCommand): readonly string[] {
  return command.kind === 'profile-instance'
    ? [`${command.commandId}-profile`, `${command.commandId}-instance`]
    : [command.commandId];
}

export function projectProductionOutboxEvidence(
  commands: readonly RawCommand[],
  receipts: readonly ProductionReceiptEvidence[],
  records: readonly ProductionOutboxRecord[],
): DurableEvidence['resourceOutbox'] {
  const rawByProductionId = new Map(commands.flatMap((command) =>
    productionCommandIdsForRaw(command).map((productionId) => [productionId, command.commandId])
  ));
  const receiptByCommand = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
  const known = new Set(commands.map((command) => command.commandId));
  return records.flatMap((record) => {
    const commandId = record.canonicalCommandId === undefined
      ? undefined
      : rawByProductionId.get(record.canonicalCommandId);
    const receipt = commandId === undefined ? undefined : receiptByCommand.get(commandId);
    const effectId = receipt?.identityKind === 'logical-msg-id'
      ? record.outboxId : record.resourceId;
    if (!commandId || !known.has(commandId) || !receipt?.outboxIds.includes(effectId)) return [];
    return [{
      effectId, resourceId: record.resourceId, outboxId: record.outboxId,
      commandId,
      effectKind: record.effectKind,
      typeId: record.typeId,
      topicId: record.topicId,
    }];
  });
}

function requireOutboxType(value: string): 'APP_OUTBOX' | 'WS_OUTBOX' {
  if (value !== 'APP_OUTBOX' && value !== 'WS_OUTBOX') {
    throw new Error(`Receipt references non-outbox ResourceInbox row: ${value}`);
  }
  return value;
}

export function readResourceEffectKind(row: Readonly<{
  ri_resource_id: string; ri_topic_id: string; ri_type_id: string; ri_resource: string;
}>): string {
  if (row.ri_topic_id === 'app-outbox.group-presence-summary') return 'group-presence-summary';
  if (row.ri_topic_id === 'app-outbox.rtc-topology') return 'rtc-topology-recompute';
  if (row.ri_type_id === 'WS_OUTBOX') {
    if (row.ri_topic_id === 'client-state.snapshot') return 'principal-state:snapshot';
    if (row.ri_topic_id === 'client-state.event') return 'principal-state:event';
  }
  throw new Error(`Unrecognized final ResourceInbox effect ${row.ri_type_id}:${row.ri_topic_id}`);
}

export function isValidProductionReceipt(
  value: unknown,
  requestId: string,
): value is ClientMutationIdempotencyRecord {
  try {
    validateClientMutationIdempotencyRecord(value);
  } catch {
    return false;
  }
  return value.requestId === requestId && value.receipt.commandId === requestId;
}

function isValidatedReceiptIdentity(
  value: unknown, ref: GroupRef, requestId: string,
): value is GroupMutationIdempotencyRecord {
  try {
    validateGroupMutationIdempotencyRecord(value, ref);
  } catch {
    return false;
  }
  return value.requestId === requestId && value.receipt.commandId === requestId;
}
function readValidatedTopologyMutationReceipt(
  value: unknown, groupRef: GroupRef, requestId: string,
): GroupTopologyConfigMutationReceipt | undefined {
  try {
    const record = readTopologyConfigMutationRecordBoundary(value, { groupRef, requestId });
    return record.requestId === requestId && record.receipt.commandId === requestId
      ? record.receipt
      : undefined;
  } catch {
    return undefined;
  }
}

function deriveCorrectness(
  commands: readonly RawCommand[],
  durable: DurableEvidence,
): CorrectnessMetrics {
  const requiredOutboxIntentCount = sum(
    commands.map((command) =>
      command.status === 'accepted'
        ? PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length
        : 0
    ),
  );
  const effectfulCommandCount =
    commands.filter((command) =>
      command.status === 'accepted' &&
      PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0
    ).length;
  const acceptedCommandCount = commands.filter((command) => command.status === 'accepted').length;
  const dbwFindings: string[] = [];
  return {
    acceptedCommandCount,
    receiptCount: durable.receipts.length,
    effectfulCommandCount,
    requiredOutboxIntentCount,
    outboxIntentCount: durable.resourceOutbox.length,
    atomicCompletionFailures: durable.atomicCompletionFailures,
    dbwFindings,
  };
}

function countAtomicCompletionFailures(
  commands: readonly RawCommand[],
  durable: Pick<DurableEvidence, 'appInbox' | 'receipts' | 'resourceOutbox'>,
): number {
  return commands.filter((command) => command.status === 'accepted').filter((command) => {
    const expectedOperations = command.kind === 'profile-instance'
      ? ['instance', 'profile']
      : ['command'];
    const completed = durable.appInbox.filter((entry) =>
      entry.commandId === command.commandId && entry.status === 'COMPLETED' &&
      entry.resultStatus === 'COMPLETED'
    ).map((entry) => entry.operationId).toSorted();
    const receipt = durable.receipts.find((entry) => entry.commandId === command.commandId);
    const expectedEffects = [...PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind]].toSorted();
    const actualEffects = durable.resourceOutbox.filter((entry) => entry.commandId === command.commandId)
      .map((entry) => entry.effectKind).toSorted();
    return JSON.stringify(completed) !== JSON.stringify(expectedOperations) || !receipt ||
      JSON.stringify(actualEffects) !== JSON.stringify(expectedEffects);
  }).length;
}

function observeSql(
  metrics: SqlMetrics,
  category: 'read' | 'write' | 'outbox',
  result: unknown,
  durationMs: number,
): void {
  metrics.statements += 1;
  metrics.serializedResultBytes += byteLength(result);
  if (category === 'read') {
    metrics.rowsRead += Array.isArray(result) ? result.length : 0;
    metrics.readMs += durationMs;
  } else if (category === 'outbox') {
    metrics.outboxSqlMs += durationMs;
  } else {
    metrics.writeMs += durationMs;
  }
}

export function classifyBenchmarkSql(
  query: string,
  values: readonly unknown[],
): 'read' | 'write' | 'outbox' {
  const normalized = query.trim().toLowerCase();
  if (
    normalized.includes('resource_inbox') &&
    values.some((value) => value === 'APP_OUTBOX' || value === 'WS_OUTBOX')
  ) return 'outbox';
  return /^(select|show|explain)\b/.test(normalized) ? 'read' : 'write';
}

function firstSqlKeyword(query: string): string {
  return query.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? 'unknown';
}

function isTemplateStringsArray(value: readonly unknown[]): value is TemplateStringsArray {
  return Object.hasOwn(value, 'raw');
}

function byteLength(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

async function capturePgCounters(sql: Sql): Promise<PgCounters> {
  const rows = await sql<{
    shared_buffer_hits: number | string;
    shared_buffer_reads: number | string;
    wal_lsn: string;
  }[]>`
    select blks_hit as shared_buffer_hits,
           blks_read as shared_buffer_reads,
           pg_current_wal_lsn()::text as wal_lsn
    from pg_stat_database
    where datname = current_database()
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('pg_stat_database did not return the current database');
  }
  return {
    sharedBufferHits: Number(row.shared_buffer_hits),
    sharedBufferReads: Number(row.shared_buffer_reads),
    walLsn: row.wal_lsn,
  };
}

async function walDifference(sql: Sql, before: string, after: string): Promise<number> {
  const rows = await sql<{ wal_bytes: number | string }[]>`
    select pg_wal_lsn_diff(${after}::pg_lsn, ${before}::pg_lsn)::float8 as wal_bytes
  `;
  return Math.max(0, Number(rows[0]?.wal_bytes ?? 0));
}

function startLockWaitSampler(sql: Sql, applicationNamePrefix: string): {
  stop(): Promise<number>;
} {
  let stopped = false;
  let lockWaitMs = 0;
  const running = (async () => {
    let previousAt = performance.now();
    while (!stopped) {
      const rows = await sql<{ waiting: number | string }[]>`
        select count(*)::int as waiting
        from pg_stat_activity
        where application_name like ${`${applicationNamePrefix}%`}
          and wait_event_type = 'Lock'
      `;
      const now = performance.now();
      lockWaitMs += Number(rows[0]?.waiting ?? 0) * (now - previousAt);
      previousAt = now;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await running;
      return lockWaitMs;
    },
  };
}

async function assertSchemaReady(sql: Sql): Promise<void> {
  const rows = await sql<
    {
      runtime_state_store: string | null;
    }[]
  >`
    select to_regclass('runtime_state_store')::text as runtime_state_store
  `;
  const row = rows[0];
  if (!row?.runtime_state_store) {
    throw new Error('PostgreSQL schema is missing; run npm run db:migrate before the benchmark');
  }
}

function summarizeSamples(samples: readonly RunSample[]): WorkloadSummary {
  const latencySamples = samples.flatMap((sample) => sample.latencySamplesMs);
  const accepted = sum(samples.map((sample) => sample.outcomes.accepted));
  const attempts = sum(samples.map((sample) => sample.outcomes.attempts));
  return {
    latencyMs: summarizeLatency(latencySamples),
    throughputPerSecond: accepted / (sum(samples.map((sample) => sample.durationMs)) / 1_000),
    outcomes: {
      accepted,
      conflicted: sum(samples.map((sample) => sample.outcomes.conflicted)),
      transientRetries: sum(samples.map((sample) => sample.outcomes.transientRetries)),
      exhausted: sum(samples.map((sample) => sample.outcomes.exhausted)),
      attempts,
      attemptsPerAcceptedMutation: accepted === 0 ? attempts : attempts / accepted,
    },
    sql: medianObject(samples.map((sample) => sample.sql)),
    postgres: medianObject(samples.map((sample) => sample.postgres)),
    timingsMs: medianObject(samples.map((sample) => sample.timingsMs)),
    correctness: {
      acceptedCommandCount: sum(samples.map((sample) => sample.correctness.acceptedCommandCount)),
      receiptCount: sum(samples.map((sample) => sample.correctness.receiptCount)),
      effectfulCommandCount: sum(samples.map((sample) => sample.correctness.effectfulCommandCount)),
      requiredOutboxIntentCount: sum(
        samples.map((sample) => sample.correctness.requiredOutboxIntentCount),
      ),
      outboxIntentCount: sum(samples.map((sample) => sample.correctness.outboxIntentCount)),
      atomicCompletionFailures: sum(
        samples.map((sample) => sample.correctness.atomicCompletionFailures),
      ),
      dbwFindings: [...new Set(samples.flatMap((sample) => sample.correctness.dbwFindings))],
    },
  };
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
  return {
    p50: percentile(samples, 0.50),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  };
}

function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1]!;
}

function medianObject<T extends object>(values: readonly T[]): T {
  const keys = Object.keys(values[0] ?? {}) as (keyof T)[];
  return Object.fromEntries(
    keys.map((key) => [String(key), median(values.map((value) => Number(value[key])))]),
  ) as T;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nonNegativeDelta(after: number, before: number): number {
  return Math.max(0, after - before);
}

function newRunContext(): RunContext {
  return {
    sql: {
      statements: 0,
      rowsRead: 0,
      serializedResultBytes: 0,
      readMs: 0,
      writeMs: 0,
      outboxSqlMs: 0,
      transactionDurationMs: 0,
    },
    timingEvents: [],
    attemptReleases: [],
  };
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let firstFailure: unknown;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      if (failed) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) {
    throw firstFailure;
  }
  return results;
}

export function parseBenchmarkOptions(args: readonly string[]): {
  backend: string;
  warmup: number;
  runs: number;
  concurrency: number;
  out: string;
  regressionReasonsFile?: string;
} {
  const values = new Map(
    args.map((argument) => {
      const [key, ...rest] = argument.replace(/^--/, '').split('=');
      return [key, rest.join('=')];
    }),
  );
  const regressionReasonsFile = values.get('regression-reasons-file');
  if (regressionReasonsFile !== undefined) assertPerfInputPath(regressionReasonsFile);
  return {
    backend: values.get('backend') || 'postgres',
    warmup: parseIntegerOption('warmup', values.get('warmup'), 1, 1, MAX_WARMUP_RUNS),
    runs: parseIntegerOption('runs', values.get('runs'), 3, 1, MAX_MEASURED_RUNS),
    concurrency: parseIntegerOption(
      'concurrency',
      values.get('concurrency'),
      REQUIRED_CONCURRENCY,
      1,
      MAX_CONCURRENCY,
    ),
    out: values.get('out') || 'tmp/perf/api-v1-state-write-results.json',
    ...(regressionReasonsFile === undefined ? {} : { regressionReasonsFile }),
  };
}

function parseIntegerOption(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `--${name} must be a safe integer between ${minimum} and ${maximum}; received ${raw}`,
    );
  }
  return value;
}

function assertPerfOutputPath(path: string): void {
  const normalized = normalize(path).replaceAll('\\', '/');
  if (!normalized.startsWith('tmp/perf/') || normalized.includes('/../')) {
    throw new Error(`Benchmark output must remain under tmp/perf/: ${path}`);
  }
}

function assertPerfInputPath(path: string): void {
  const normalized = normalize(path).replaceAll('\\', '/');
  if (normalized !== path || !normalized.startsWith('tmp/perf/') || normalized.includes('/../')) {
    throw new Error(`Regression-reason input must remain under tmp/perf/: ${path}`);
  }
}
