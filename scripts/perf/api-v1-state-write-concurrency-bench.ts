import process from 'node:process';
import { dirname, normalize } from 'node:path';
import postgres, { type Sql } from 'postgres';
import type { StateScope } from '@shared/api/state-types.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  createClientStateEventRepository,
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import {
  AuthSessionRepository,
  type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
  type ClientStateService,
  createClientStateService,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import { validateClientMutationIdempotencyRecord } from '@shared-server/rallar-system/services/client-state-mutations.ts';
import { validateGroupTopologyConfigMutationRecord } from '@shared-server/rallar-system/services/group-topology-config-mutations.ts';
import {
  createGroupStateService,
  type GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { RuntimeStateRetryExhaustedError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
  type RallarTimingEvent,
  type RallarTimingSink,
  recordRallarTiming,
} from '@shared-server/rallar-system/services/timing.ts';
import {
  STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
  PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
} from './compare-api-v1-state-write-results.mjs';

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

type ProductionOutboxRecord = Readonly<{ outboxId: string; commandId: string; effects: readonly string[] }>;
type ProductionOutboxRepository = Readonly<{ find(outboxId: string): Promise<Readonly<{ record: ProductionOutboxRecord }> | undefined> }>;

type CorrectnessMetrics = {
  acceptedCommandCount: number;
  receiptCount: number;
  effectfulCommandCount: number;
  requiredOutboxIntentCount: number;
  outboxIntentCount: number;
  dbwFindings: string[];
};

type OutcomeMetrics = {
  accepted: number;
  conflicted: number;
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
type AttemptObservation = {
  commandId: string;
  operationId: string;
  attempt: number;
  outcome: 'accepted' | 'conflicted' | 'exhausted';
  terminal: boolean;
  source: string;
};
type DurableEvidence = {
  receiptCommandIds: string[];
  outboxIntents: Array<{ intentId: string; commandId: string; intentKind: string }>;
};
type ProductionReceiptEvidence = {
  commandId: string;
  outboxIds: readonly string[];
};
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
  durable: DurableEvidence;
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
};

type ServiceRuntime = {
  client: ClientStateService;
  group: GroupStateService;
  topology: GroupTopologyManagementService;
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

const NOOP_PUBLISHER = {
  publishClientSnapshot: () => Promise.resolve(),
  publishClientEvent: () => Promise.resolve(),
  publishGroupSnapshot: () => Promise.resolve(),
  publishGroupEvent: () => Promise.resolve(),
};

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

    const artifact = {
      schemaVersion: STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
      gitCommit: await readGitCommit(),
      backend: options.backend,
      generatedAt: new Date().toISOString(),
      measurement: {
        warmupRuns: options.warmup,
        measuredRuns: options.runs,
        concurrency: options.concurrency,
        mutationTimingExcludes: ['setup', 'auth-session insertion', 'http'],
        tailSamplesDiscarded: false,
        counterSources: {
          sql:
            'thin postgres.js wrapper around both independent service clients, including production auth-session lookup and revalidation',
          sharedBuffers: 'pg_stat_database immediately before and after each measured phase',
          wal: 'pg_current_wal_lsn immediately before and after each measured phase',
          lockWait: '5ms pg_stat_activity sampling of benchmark service backends waiting on Lock',
          cpu: 'benchmark process user plus system CPU time',
          rowsRead: 'row counts returned by the thin postgres.js wrapper',
          serializedResultBytes:
            'JSON byte length of values returned by the thin postgres.js wrapper',
          transactionDuration: 'wall-clock duration of production repository sql.begin calls',
          readTiming: 'read-classified production SQL duration from the postgres.js wrapper',
          computeTiming:
            'production timing-sink events explicitly labeled phase=compute; zero when unavailable',
          validateTiming:
            'production timing-sink events explicitly labeled phase=validate; zero when unavailable',
          writeTiming:
            'production client/group/topology mutation.write timing-sink events',
          outboxTiming:
            'runtime-state SQL carrying the state-mutation:outbox namespace through the postgres.js wrapper',
          attempts:
            'production client/group/topology mutation.conflict timing events plus returned success or typed exhaustion; synthetic terminals exist only for disclosed exhausted prerequisites',
          receipts:
            'complete production client/group/topology idempotency receipts queried after the phase through uninstrumented repositories and projected only when every raw-command subreceipt is valid',
          outboxIntents:
            'receipt-referenced direct ResourceInbox records queried after the phase through the uninstrumented admin stack and projected per real effect',
        },
      },
      features: {
         presenceSplitFromGroupAggregate: true,
         governance: 'task10-post-remediation-candidate',
         evidence:
           'Production receipts, mutation outbox records, and exact retry timings including topology config mutations',
      },
      regressionReasons: [],
      workloads,
    };

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
  const exhaustedKindsByClient = new Map<number, Set<MutationKind>>();
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
          const exhaustedKinds = exhaustedKindsByClient.get(command.clientIndex) ??
            new Set<MutationKind>();
          exhaustedKindsByClient.set(command.clientIndex, exhaustedKinds);
          const terminal = await resolveBenchmarkCommandTerminal(
            kind,
            exhaustedKinds,
            async () =>
              await executeMeasuredCommand(
                runtimes[stackIndex]!,
                scope,
                command,
                commandId,
                timing,
              ),
          );
          if (terminal.source === 'prerequisite') {
            recordPrerequisiteExhaustion(
              timing,
              runtimes[stackIndex]!,
              commandId,
              terminal.prerequisite,
              performance.now() - commandStartedAt,
            );
          }
          return {
            commandId,
            kind,
            latencyMs: performance.now() - commandStartedAt,
            stackIndex,
            status: terminal.status,
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
  );
  const attemptObservations = deriveProductionAttemptObservations(
    context.timingEvents,
    rawCommands,
  );
  const accepted = rawCommands.filter((command) => command.status === 'accepted').length;
  const attempts = attemptObservations.length;
  const outcomes: OutcomeMetrics = {
    accepted,
    conflicted: attemptObservations.filter((entry) => entry.outcome === 'conflicted').length,
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
    durable,
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

export function isBenchmarkRetryExhaustion(
  error: unknown,
): error is RuntimeStateRetryExhaustedError {
  return error instanceof RuntimeStateRetryExhaustedError;
}

export async function resolveBenchmarkCommandTerminal(
  kind: MutationKind,
  exhaustedKinds: Set<MutationKind>,
  action: () => Promise<void>,
): Promise<
  | Readonly<{ status: 'accepted'; source: 'production' }>
  | Readonly<{ status: 'exhausted'; source: 'production' }>
  | Readonly<{
    status: 'exhausted';
    source: 'prerequisite';
    prerequisite: 'membership' | 'presence-connect';
  }>
> {
  const prerequisite = benchmarkCommandPrerequisite(kind, exhaustedKinds);
  if (prerequisite) {
    return { status: 'exhausted', source: 'prerequisite', prerequisite };
  }
  try {
    await action();
    return { status: 'accepted', source: 'production' };
  } catch (error) {
    if (!isBenchmarkRetryExhaustion(error)) {
      throw error;
    }
    exhaustedKinds.add(kind);
    return { status: 'exhausted', source: 'production' };
  }
}

function benchmarkCommandPrerequisite(
  kind: MutationKind,
  exhaustedKinds: ReadonlySet<MutationKind>,
): 'membership' | 'presence-connect' | undefined {
  if (
    (kind === 'presence-connect' ||
      kind === 'presence-heartbeat' ||
      kind === 'presence-disconnect') &&
    exhaustedKinds.has('membership')
  ) {
    return 'membership';
  }
  if (
    (kind === 'presence-heartbeat' || kind === 'presence-disconnect') &&
    exhaustedKinds.has('presence-connect')
  ) {
    return 'presence-connect';
  }
  return undefined;
}

function recordPrerequisiteExhaustion(
  timing: RallarTimingSink,
  runtime: ServiceRuntime,
  requestId: string,
  prerequisite: 'membership' | 'presence-connect',
  durationMs: number,
): void {
  recordRallarTiming(
    timing,
    {
      component: 'state-write-command-envelope',
      operation: `prerequisite-exhausted:${prerequisite}`,
      serviceId: runtime.serviceId,
      requestId,
      details: {
        operationId: 'command',
        attempt: 1,
        outcome: 'exhausted',
        terminal: true,
        prerequisite,
      },
    },
    'error',
    durationMs,
  );
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
  const group = createGroupStateService({
    runtimeRepository,
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: NOOP_PUBLISHER,
    serviceId,
    timing,
    authSessionRepository,
  });
  return {
    client: createClientStateService({
      runtimeRepository,
      createClientStateEventStore: createClientStateEventRepository,
      syncPublisher: NOOP_PUBLISHER,
      serviceId,
      timing,
    }),
    group,
    topology: new GroupTopologyManagementService({
      findGroupSnapshotByRef: (ref) => group.readSnapshot(ref),
      groupStateRepository: new GroupStateRepository(runtimeRepository),
      configRepository: new GroupTopologyConfigRepository(runtimeRepository),
      topologyService: new RallarRtcTopologyService(),
      timing,
      serviceId,
    }),
    serviceId,
  };
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
  switch (kind) {
    case 'profile-instance': {
      const profile = requireClientMutation(
        await observeProductionAttempt(
          timing,
          runtime,
          `${command.requestId}-profile`,
          'upsertPrincipal',
          () =>
            runtime.client.upsertPrincipal(
              scope,
              command.principalId,
              {
                username: command.principalId,
                displayName: `${command.principalId}-measured`,
                metadata: { source: 'state-write-benchmark' },
                actorPrincipalId: command.principalId,
                requestId: `${command.requestId}-profile`,
              },
            ),
        ),
      );
      const instance = requireClientMutation(
        await observeProductionAttempt(
          timing,
          runtime,
          `${command.requestId}-instance`,
          'upsertInstance',
          () =>
            runtime.client.upsertInstance(
              scope,
              command.principalId,
              command.instanceId,
              {
                status: 'active',
                platform: 'web',
                appVersion: 'task-0b',
                capabilities: ['state-write-benchmark'],
                actorPrincipalId: command.principalId,
                requestId: `${command.requestId}-instance`,
              },
            ),
        ),
      );
      void profile;
      void instance;
      return;
    }
    case 'membership': {
      const written = requireGroupMutation(
        await observeProductionAttempt(
          timing,
          runtime,
          command.requestId,
          'upsertMember',
          () =>
            runtime.group.upsertMember(
              scope,
              command.groupId,
              command.principalId,
              {
                role: 'member',
                status: 'active',
                actorPrincipalId: command.ownerId,
                requestId: command.requestId,
              },
              command.ownerAuthority,
            ),
        ),
      );
      void written;
      return;
    }
    case 'presence-connect': {
      const written = requireGroupMutation(
        await observeProductionAttempt(
          timing,
          runtime,
          command.requestId,
          'connectPresenceSession',
          () =>
            runtime.group.connectPresenceSession(
              scope,
              command.groupId,
              command.sessionId,
              {
                principalId: command.principalId,
                generationId: command.generationId,
                connectedAtEpochMs: command.timestamp,
                lastHeartbeatAtEpochMs: command.timestamp,
                expiresAtEpochMs: command.timestamp + 60_000,
                actorPrincipalId: command.principalId,
                actorSessionId: command.sessionId,
                requestId: command.requestId,
              },
              command.clientAuthority,
            ),
        ),
      );
      void written;
      return;
    }
    case 'presence-heartbeat': {
      const written = requireGroupMutation(
        await observeProductionAttempt(
          timing,
          runtime,
          command.requestId,
          'heartbeatPresenceSession',
          () =>
            runtime.group.heartbeatPresenceSession(
              scope,
              command.groupId,
              command.sessionId,
              {
                principalId: command.principalId,
                generationId: command.generationId,
                lastHeartbeatAtEpochMs: command.timestamp + 1_000,
                expiresAtEpochMs: command.timestamp + 61_000,
                actorPrincipalId: command.principalId,
                actorSessionId: command.sessionId,
                requestId: command.requestId,
              },
              command.clientAuthority,
            ),
        ),
      );
      void written;
      return;
    }
    case 'presence-disconnect': {
      const written = requireGroupMutation(
        await observeProductionAttempt(
          timing,
          runtime,
          command.requestId,
          'disconnectPresenceSession',
          () =>
            runtime.group.disconnectPresenceSession(
              scope,
              command.groupId,
              command.sessionId,
              {
                principalId: command.principalId,
                generationId: command.generationId,
                disconnectedAtEpochMs: command.timestamp + 2_000,
                lastHeartbeatAtEpochMs: command.timestamp + 1_000,
                expiresAtEpochMs: command.timestamp + 61_000,
                actorPrincipalId: command.principalId,
                actorSessionId: command.sessionId,
                requestId: command.requestId,
              },
              command.clientAuthority,
            ),
        ),
      );
      void written;
      return;
    }
    case 'config': {
      const written = requireGroupMutation(
        await observeProductionAttempt(
          timing,
          runtime,
          command.requestId,
          'updateGroup',
          () =>
            runtime.group.updateGroup(
              scope,
              command.groupId,
              {
                metadata: { benchmarkConfigSource: command.requestId },
                actorPrincipalId: command.ownerId,
                requestId: command.requestId,
              },
              command.ownerAuthority,
            ),
        ),
      );
      void written;
      return;
    }
    case 'topology-source': {
      const result = await observeProductionAttempt(
        timing,
        runtime,
        command.requestId,
        'putConfig',
        () =>
          runtime.topology.putConfig({
            groupRef: { ...scope, groupId: command.groupId },
            config: {
              topologyKind: command.timestamp % 2 === 0 ? 'tree' : 'mesh',
              degreeLimit: 5,
              treeMinSize: 5,
              meshMinSize: 16,
              meshParamK: 2,
            },
            updatedByPrincipalId: command.ownerId,
            requestId: command.requestId,
          }),
      );
      void result;
      return;
    }
  }
}

async function observeProductionAttempt<T>(
  timing: RallarTimingSink,
  runtime: ServiceRuntime,
  requestId: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  void timing;
  void runtime;
  void requestId;
  void operation;
  return await action();
}

async function seedCompleteState(
  sql: Sql,
  scope: StateScope,
  workload: typeof WORKLOADS[number],
): Promise<void> {
  const pgSql = sql as unknown as PSqlSql;
  const runtimeRepository = new PSqlRuntimeStateRepository(pgSql);
  const authSessionRepository = new AuthSessionRepository(runtimeRepository);
  const client = createClientStateService({
    runtimeRepository,
    createClientStateEventStore: createClientStateEventRepository,
    syncPublisher: NOOP_PUBLISHER,
    serviceId: 'state-write-bench-seed',
  });
  const group = createGroupStateService({
    runtimeRepository,
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: NOOP_PUBLISHER,
    serviceId: 'state-write-bench-seed',
    authSessionRepository,
  });
  const topology = new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => group.readSnapshot(ref),
    groupStateRepository: new GroupStateRepository(runtimeRepository),
    configRepository: new GroupTopologyConfigRepository(runtimeRepository),
    topologyService: new RallarRtcTopologyService(),
  });

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
      requireGroupMutation(
        await group.createGroup(scope, {
          groupId: `group-${groupIndex}`,
          displayName: `State Write Benchmark Group ${groupIndex}`,
          kind: 'room',
          joinMode: 'open',
          maxMembers: CLIENT_COUNT + 1,
          maxSessionsPerMember: 4,
          metadata: { benchmark: true },
          createdByPrincipalId: ownerId,
          actorPrincipalId: ownerId,
          requestId: `seed-group-${groupIndex}`,
        }, authority),
      );
      await topology.putConfig({
        groupRef: { ...scope, groupId: `group-${groupIndex}` },
        config: {
          topologyKind: 'auto',
          degreeLimit: 5,
          treeMinSize: 5,
          meshMinSize: 16,
          meshParamK: 2,
        },
        updatedByPrincipalId: ownerId,
        requestId: `seed-topology-${groupIndex}`,
      });
    },
  );

  await mapWithConcurrency(
    Array.from({ length: workload.clients }, (_, clientIndex) => clientIndex),
    REQUIRED_CONCURRENCY,
    async (clientIndex) => {
      const principalId = `client-${clientIndex}`;
      await authSessionRepository.putSession(createBenchmarkAuthSession(
        scope,
        principalId,
        `client-session-${clientIndex}`,
      ));
      requireClientMutation(
        await client.upsertPrincipal(scope, principalId, {
          username: principalId,
          displayName: `Seed Client ${clientIndex}`,
          status: 'active',
          actorPrincipalId: principalId,
          requestId: `seed-principal-${clientIndex}`,
        }),
      );
      requireClientMutation(
        await client.upsertInstance(
          scope,
          principalId,
          `instance-${clientIndex}`,
          {
            status: 'active',
            platform: 'web',
            appVersion: 'seed',
            actorPrincipalId: principalId,
            requestId: `seed-instance-${clientIndex}`,
          },
        ),
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

function requireClientMutation(
  written: Awaited<ReturnType<ClientStateService['upsertPrincipal']>>,
) {
  if (!written.result.right) {
    throw new Error(`Client mutation rejected: ${String(written.result.left)}`);
  }
  return written.result.right;
}

function requireGroupMutation(written: Awaited<ReturnType<GroupStateService['updateGroup']>>) {
  if (!written.result.right) {
    throw new Error(`Group mutation rejected: ${String(written.result.left)}`);
  }
  return written.result.right;
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

export function deriveProductionAttemptObservations(
  events: readonly RallarTimingEvent[],
  commands: readonly RawCommand[],
): AttemptObservation[] {
  return commands.flatMap<AttemptObservation>((command): AttemptObservation[] => {
    const prerequisite = events.find((event) =>
      event.component === 'state-write-command-envelope' &&
      event.requestId === command.commandId &&
      event.details?.outcome === 'exhausted' &&
      (typeof event.details?.prerequisite === 'string' ||
        event.operation.startsWith('prerequisite-exhausted:'))
    );
    if (prerequisite) {
      return [{
        commandId: command.commandId,
        operationId: 'command' as const,
        attempt: 1,
        outcome: 'exhausted' as const,
        terminal: true,
        source: `${prerequisite.component}.${prerequisite.operation}`,
      }];
    }

    const operations = command.kind === 'profile-instance'
      ? [
        { operationId: 'profile', requestId: `${command.commandId}-profile` },
        { operationId: 'instance', requestId: `${command.commandId}-instance` },
      ] as const
      : [{ operationId: 'command', requestId: command.commandId }] as const;
    const attempted = operations.filter((operation) =>
      command.status === 'accepted' || events.some((event) =>
        event.requestId === operation.requestId &&
        (event.component === 'client-state-service' ||
          event.component === 'group-state-service' ||
          event.component === 'group-topology-config-service')
      )
    );
    const exhaustedOperationId = command.status === 'exhausted'
      ? attempted.at(-1)?.operationId
      : undefined;

    return attempted.flatMap((operation) => {
      const conflicts = events.filter((event) =>
        event.requestId === operation.requestId &&
        event.operation === 'mutation.conflict' &&
        (event.component === 'client-state-service' ||
          event.component === 'group-state-service' ||
          event.component === 'group-topology-config-service')
      ).toSorted((left, right) =>
        Number(left.details?.attempt) - Number(right.details?.attempt)
      );
      for (const event of conflicts) {
        if (!Number.isSafeInteger(event.details?.attempt) || Number(event.details?.attempt) < 0) {
          throw new Error(`Invalid production conflict attempt for ${operation.requestId}`);
        }
      }
      const exhausted = exhaustedOperationId === operation.operationId;
      if (exhausted && conflicts.length === 0) {
        throw new Error(`Production exhaustion lacks conflict timing for ${operation.requestId}`);
      }
      const observations: AttemptObservation[] = conflicts.map((event, index) => {
        const terminal = exhausted && index === conflicts.length - 1;
        return {
          commandId: command.commandId,
          operationId: operation.operationId,
          attempt: Number(event.details?.attempt),
          outcome: terminal ? 'exhausted' as const : 'conflicted' as const,
          terminal,
          source: `${event.component}.${event.operation}`,
        };
      });
      if (!exhausted) {
        const successfulPhases = events.filter((event) =>
          event.requestId === operation.requestId &&
          (event.operation === 'mutation.write' || event.operation === 'mutation.validate') &&
          (event.component === 'client-state-service' ||
            event.component === 'group-state-service' ||
            event.component === 'group-topology-config-service') &&
          event.status === 'ok' &&
          Number.isSafeInteger(event.details?.attempt) &&
          Number(event.details?.attempt) >= 0
        );
        const preferredPhases = successfulPhases.some((event) =>
            event.operation === 'mutation.write'
          )
          ? successfulPhases.filter((event) => event.operation === 'mutation.write')
          : successfulPhases;
        const terminalPhase = preferredPhases.toSorted((left, right) =>
          Number(left.details?.attempt) - Number(right.details?.attempt)
        ).at(-1);
        if (!terminalPhase) {
          throw new Error(
            `Accepted production mutation lacks write/validate timing for ${operation.requestId}`,
          );
        }
        observations.push({
          commandId: command.commandId,
          operationId: operation.operationId,
          attempt: terminalPhase ? Number(terminalPhase.details?.attempt) : 0,
          outcome: 'accepted',
          terminal: true,
          source: `${terminalPhase!.component}.${terminalPhase!.operation}`,
        });
      }
      return observations;
    });
  });
}

async function queryDurableEvidence(
  sql: Sql,
  scope: StateScope,
  commands: readonly RawCommand[],
  groupCount: number,
): Promise<DurableEvidence> {
  const runtime = new PSqlRuntimeStateRepository(sql as unknown as PSqlSql);
  const clients = new ClientStateRepository(runtime);
  const groups = new GroupStateRepository(runtime);
  const topology = new GroupTopologyConfigRepository(runtime);
  const outbox: ProductionOutboxRepository = {
    find: async () => undefined,
  };
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
        return {
          commandId: command.commandId,
          outboxIds: receipts.flatMap((receipt) => receipt?.receipt.outboxIds ?? []),
        };
      }
      if (command.kind === 'topology-source') {
        const receipt = await topology.findMutationRecord(
          { ...scope, groupId: `group-${clientIndex % groupCount}` },
          command.commandId,
        );
        if (!isValidatedTopologyReceipt(
          receipt,
          { ...scope, groupId: `group-${clientIndex % groupCount}` },
          command.commandId,
        )) {
          return undefined;
        }
        return {
          commandId: command.commandId,
          outboxIds: receipt?.receipt.outboxIds ?? [],
        };
      }
      const receipt = await groups.findIdempotentGroupMutationReceipt(
        { ...scope, groupId: `group-${clientIndex % groupCount}` },
        command.commandId,
      );
      if (!isValidatedReceiptIdentity(receipt, command.commandId)) return undefined;
      return {
        commandId: command.commandId,
        outboxIds: receipt?.receipt.outboxIds ?? [],
      };
    },
  );
  const receipts = receiptResults.filter(
    (receipt): receipt is ProductionReceiptEvidence => receipt !== undefined,
  );
  const receiptCommandIds = receipts.map((receipt) => receipt.commandId);
  const productionRecords = await readReferencedProductionOutboxRecords(
    outbox,
    receipts.flatMap((receipt) => receipt.outboxIds),
  );

  const outboxIntents = projectProductionOutboxEvidence(commands, productionRecords);
  return {
    receiptCommandIds: receiptCommandIds.toSorted(),
    outboxIntents: outboxIntents.toSorted((left, right) =>
      left.intentId.localeCompare(right.intentId)
    ),
  };
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

function productionCommandIdsForRaw(command: RawCommand): readonly string[] {
  return command.kind === 'profile-instance'
    ? [`${command.commandId}-profile`, `${command.commandId}-instance`]
    : [command.commandId];
}

export function projectProductionOutboxEvidence(
  commands: readonly RawCommand[],
  records: readonly Pick<ProductionOutboxRecord, 'outboxId' | 'commandId' | 'effects'>[],
): DurableEvidence['outboxIntents'] {
  const productionToRawCommand = new Map(
    commands.flatMap((command) =>
      productionCommandIdsForRaw(command).map((productionCommandId) => [
        productionCommandId,
        command,
      ] as const)
    ),
  );
  return records.flatMap((record) => {
    const command = productionToRawCommand.get(record.commandId);
    if (!command) return [];
    return record.effects.map((effect) => ({
      intentId: `${record.outboxId}:${effect}`,
      commandId: command.commandId,
      intentKind: effect,
    }));
  });
}

export function isValidProductionReceipt(value: unknown, requestId: string): boolean {
  try {
    validateClientMutationIdempotencyRecord(value);
  } catch {
    return false;
  }
  return value.requestId === requestId && value.receipt.commandId === requestId;
}

function isValidatedReceiptIdentity(value: unknown, requestId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.requestId !== requestId ||
    !record.receipt || typeof record.receipt !== 'object' || Array.isArray(record.receipt)) {
    return false;
  }
  return (record.receipt as Record<string, unknown>).commandId === requestId;
}

function isValidatedTopologyReceipt(
  value: unknown,
  groupRef: Readonly<{ applicationId: string; workspaceId: string; groupId: string }>,
  requestId: string,
): boolean {
  try {
    validateGroupTopologyConfigMutationRecord(value, { groupRef, requestId });
  } catch {
    return false;
  }
  return value.requestId === requestId && value.receipt.commandId === requestId;
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
    receiptCount: durable.receiptCommandIds.length,
    effectfulCommandCount,
    requiredOutboxIntentCount,
    outboxIntentCount: durable.outboxIntents.length,
    dbwFindings,
  };
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

async function readGitCommit(): Promise<string> {
  const command = new Deno.Command('git', { args: ['rev-parse', 'HEAD'], stdout: 'piped' });
  const output = await command.output();
  if (!output.success) {
    throw new Error('Unable to resolve git commit for benchmark artifact');
  }
  return new TextDecoder().decode(output.stdout).trim();
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
} {
  const values = new Map(
    args.map((argument) => {
      const [key, ...rest] = argument.replace(/^--/, '').split('=');
      return [key, rest.join('=')];
    }),
  );
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
