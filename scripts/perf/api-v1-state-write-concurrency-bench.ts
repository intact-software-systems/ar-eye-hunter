import process from 'node:process';
import { dirname, normalize } from 'node:path';
import postgres, { type Sql } from 'postgres';
import type { StateScope } from '@shared/api/state-types.ts';
import type { ClientMutationWritten } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { GroupMutationWritten } from '@shared-server/rallar-system/services/group-state-service.ts';
import { EntityStatus, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  createClientStateEventRepository,
  createGroupStateEventRepository,
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import {
  type ClientStateService,
  createClientStateService,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import {
  createGroupStateService,
  type GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
  type RallarTimingEvent,
  type RallarTimingSink,
  recordRallarTiming,
  timeRallarAsync,
} from '@shared-server/rallar-system/services/timing.ts';
import {
  STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
  STATE_WRITE_MUTATION_CONTRACT,
} from './compare-api-v1-state-write-results.mjs';

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';
const CLIENT_COUNT = 100;
const REQUIRED_CONCURRENCY = 10;
const RECEIPT_TOPIC = 'state-write-bench-receipt';
const OUTBOX_TOPIC = 'state-write-bench-outbox';
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
  status: 'accepted';
};
type AttemptObservation = {
  commandId: string;
  attempt: number;
  outcome: 'accepted' | 'conflicted' | 'exhausted';
  source: string;
};
type DurableEvidence = {
  receiptCommandIds: string[];
  outboxIntents: Array<{ intentId: string; commandId: string; intentKind: string }>;
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
  outbox: ResourceInboxRepository;
  receipts: ResourceInboxResultsRepository;
  serviceId: string;
};

type MutationCommand = {
  kind: MutationKind;
  clientIndex: number;
  groupIndex: number;
};

type CommandEffect = {
  payload: unknown;
  outboxIntents: readonly Readonly<{ intentKind: string; payload: unknown }>[];
};

type PgCounters = {
  sharedBufferHits: number;
  sharedBufferReads: number;
  walLsn: string;
};

const NOOP_PUBLISHER = {
  publishClientSnapshot: () => Promise.resolve(),
  publishClientEvent: () => Promise.resolve(),
  publishGroupSnapshot: () => Promise.resolve(),
  publishGroupEvent: () => Promise.resolve(),
};

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
        mutationTimingExcludes: ['setup', 'authentication', 'http'],
        tailSamplesDiscarded: false,
        counterSources: {
          sql: 'thin postgres.js wrapper around both independent service clients',
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
            'write-classified production SQL duration excluding resource_inbox outbox writes',
          outboxTiming: 'resource_inbox SQL duration from the postgres.js wrapper',
          attempts:
            'production service timing-sink events correlated by requestId; detailed retry observations supersede terminal service observations per request',
          receipts:
            'independent post-phase query of resource_inbox_results rows for the benchmark scope',
          outboxIntents:
            'independent post-phase query of resource_inbox rows for the benchmark scope',
        },
      },
      features: {
        presenceSplitFromGroupAggregate: false,
        governance: 'pre-remediation-baseline',
        evidence: 'Task 0B pre-remediation benchmark; group presence remains aggregate-backed',
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
  const startedAt = performance.now();

  for (const kind of MUTATION_MIX) {
    const phaseCommands = commands.filter((command) => command.kind === kind);
    const phaseResults = await mapWithConcurrency(
      phaseCommands,
      input.concurrency,
      async (command, commandIndex) => {
        const stackIndex = selectServiceStack(commandIndex, runtimes.length);
        const commandId = commandIdentifier(scope, command);
        const commandStartedAt = performance.now();
        await executeMeasuredCommand(runtimes[stackIndex]!, scope, command, commandId, timing);
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

  const durationMs = performance.now() - startedAt;
  const lockWaitMs = await lockSampler.stop();
  const cpu = process.cpuUsage(cpuBefore);
  const postgresAfter = await capturePgCounters(input.adminSql);
  const walBytes = await walDifference(input.adminSql, postgresBefore.walLsn, postgresAfter.walLsn);
  const durable = await queryDurableEvidence(input.adminSql, scope.applicationId);
  const attemptObservations = deriveAttemptObservations(context.timingEvents, rawCommands);
  const accepted = rawCommands.length;
  const attempts = attemptObservations.length;
  const outcomes: OutcomeMetrics = {
    accepted,
    conflicted: attemptObservations.filter((entry) => entry.outcome === 'conflicted').length,
    exhausted: attemptObservations.filter((entry) => entry.outcome === 'exhausted').length,
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
      read: context.sql.readMs,
      compute: productionPhaseDuration(context.timingEvents, 'compute'),
      validate: productionPhaseDuration(context.timingEvents, 'validate'),
      write: context.sql.writeMs,
      transaction: context.sql.transactionDurationMs,
      outbox: context.sql.outboxSqlMs,
    },
    correctness,
    commands: rawCommands,
    attemptObservations,
    stackCommandCounts,
    durable,
  };
  if (input.measured) {
    assertRunCorrectness(sample);
  }
  return sample;
}

function createServiceRuntime(
  sql: Sql,
  serviceId: string,
  context: RunContext,
  timing: RallarTimingSink,
): ServiceRuntime {
  const instrumentedSql = createInstrumentedSql(sql as unknown as PSqlSql, context, timing);
  const runtimeRepository = new PSqlRuntimeStateRepository(instrumentedSql);
  const group = createGroupStateService({
    runtimeRepository,
    createGroupStateEventStore: createGroupStateEventRepository,
    syncPublisher: NOOP_PUBLISHER,
    serviceId,
    timing,
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
      configRepository: new GroupTopologyConfigRepository(runtimeRepository),
      topologyService: new RallarRtcTopologyService(),
    }),
    outbox: new ResourceInboxRepository(instrumentedSql),
    receipts: new ResourceInboxResultsRepository(instrumentedSql),
    serviceId,
  };
}

function createInstrumentedSql(
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
    const category = classifySql(queryText);
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
    sessionId: `session-${command.clientIndex}`,
    groupId: `group-${command.groupIndex}`,
    ownerId: `owner-${command.groupIndex}`,
    timestamp: Date.now() + command.clientIndex,
  };
  const effect = await executeMutation(runtime, scope, command.kind, prepared, timing);
  for (const [index, intent] of effect.outboxIntents.entries()) {
    const intentId = `${requestId}:intent:${index}`;
    await runtime.outbox.writeIfAbsentOrReplaceExpired(toResourceEntryWithKey(
      { topicId: OUTBOX_TOPIC, contextId: scope.applicationId, resourceId: intentId },
      'STATE_WRITE_BENCH_OUTBOX',
      {
        originatingCommandId: requestId,
        intentId,
        intentKind: intent.intentKind,
        payload: intent.payload,
      },
    ));
  }
  await runtime.receipts.replace({
    ...toResourceEntryWithKey(
      { topicId: RECEIPT_TOPIC, contextId: scope.applicationId, resourceId: requestId },
      'STATE_WRITE_BENCH_RECEIPT',
      { originatingCommandId: requestId, result: effect.payload },
    ),
    status: EntityStatus.COMPLETED,
  });
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
  }>,
  timing: RallarTimingSink,
): Promise<CommandEffect> {
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
      return clientWrittenEffect([profile, instance], command.requestId);
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
            ),
        ),
      );
      return groupWrittenEffect(written, command.requestId);
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
                connectedAtEpochMs: command.timestamp,
                lastHeartbeatAtEpochMs: command.timestamp,
                expiresAtEpochMs: command.timestamp + 60_000,
                actorPrincipalId: command.principalId,
                actorSessionId: command.sessionId,
                requestId: command.requestId,
              },
            ),
        ),
      );
      return groupWrittenEffect(written, command.requestId);
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
                lastHeartbeatAtEpochMs: command.timestamp + 1_000,
                expiresAtEpochMs: command.timestamp + 61_000,
                actorPrincipalId: command.principalId,
                actorSessionId: command.sessionId,
                requestId: command.requestId,
              },
            ),
        ),
      );
      return { payload: written, outboxIntents: [] };
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
                disconnectedAtEpochMs: command.timestamp + 2_000,
                lastHeartbeatAtEpochMs: command.timestamp + 1_000,
                expiresAtEpochMs: command.timestamp + 61_000,
                actorPrincipalId: command.principalId,
                actorSessionId: command.sessionId,
                requestId: command.requestId,
              },
            ),
        ),
      );
      return groupWrittenEffect(written, command.requestId);
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
            ),
        ),
      );
      return groupWrittenEffect(written, command.requestId);
    }
    case 'topology-source': {
      const result = await timeRallarAsync(
        timing,
        {
          component: 'group-topology-management-service',
          operation: 'putConfig',
          serviceId: runtime.serviceId,
          requestId: command.requestId,
        },
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
            reconfigure: false,
            publish: false,
          }),
      );
      return {
        payload: result,
        outboxIntents: [{
          intentKind: 'topology-publication',
          payload: { requestId: command.requestId, config: result.config },
        }],
      };
    }
  }
}

function clientWrittenEffect(
  written: readonly ClientMutationWritten[],
  requestId: string,
): CommandEffect {
  return {
    payload: written,
    outboxIntents: written.flatMap((entry, index) =>
      entry.event
        ? [
          {
            intentKind: index === 0 ? 'client-snapshot:profile' : 'client-snapshot:instance',
            payload: { requestId, index, snapshot: entry.snapshot },
          },
          {
            intentKind: index === 0 ? 'client-event:profile' : 'client-event:instance',
            payload: { requestId, index, event: entry.event },
          },
        ]
        : []
    ),
  };
}

function groupWrittenEffect(written: GroupMutationWritten, requestId: string): CommandEffect {
  return {
    payload: written,
    outboxIntents: written.event
      ? [
        { intentKind: 'group-snapshot', payload: { requestId, snapshot: written.snapshot } },
        { intentKind: 'group-event', payload: { requestId, event: written.event } },
        {
          intentKind: 'topology-publication',
          payload: { requestId, snapshot: written.snapshot },
        },
      ]
      : [],
  };
}

function observeProductionAttempt<T>(
  timing: RallarTimingSink,
  runtime: ServiceRuntime,
  requestId: string,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  return timeRallarAsync(
    timing,
    {
      component: 'state-write-production-service-call',
      operation,
      serviceId: runtime.serviceId,
      requestId,
      details: { attempt: 1, outcome: 'accepted' },
    },
    action,
  );
}

async function seedCompleteState(
  sql: Sql,
  scope: StateScope,
  workload: typeof WORKLOADS[number],
): Promise<void> {
  const pgSql = sql as unknown as PSqlSql;
  const runtimeRepository = new PSqlRuntimeStateRepository(pgSql);
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
  });
  const topology = new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => group.readSnapshot(ref),
    configRepository: new GroupTopologyConfigRepository(runtimeRepository),
    topologyService: new RallarRtcTopologyService(),
  });

  await mapWithConcurrency(
    Array.from({ length: workload.groups }, (_, groupIndex) => groupIndex),
    REQUIRED_CONCURRENCY,
    async (groupIndex) => {
      const ownerId = `owner-${groupIndex}`;
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
        }),
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
        reconfigure: false,
        publish: false,
      });
    },
  );

  await mapWithConcurrency(
    Array.from({ length: workload.clients }, (_, clientIndex) => clientIndex),
    REQUIRED_CONCURRENCY,
    async (clientIndex) => {
      const principalId = `client-${clientIndex}`;
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
  phase: 'compute' | 'validate',
): number {
  return sum(
    events.filter((event) =>
      event.component !== 'state-write-benchmark-sql' && event.details?.phase === phase
    ).map((event) => event.durationMs),
  );
}

function deriveAttemptObservations(
  events: readonly RallarTimingEvent[],
  commands: readonly RawCommand[],
): AttemptObservation[] {
  const productionComponents = new Set([
    'state-write-production-service-call',
    'client-state-service',
    'group-state-service',
    'group-topology-management-service',
  ]);
  return commands.flatMap((command) => {
    const correlated = events.filter((event) =>
      productionComponents.has(event.component) &&
      typeof event.requestId === 'string' &&
      (event.requestId === command.commandId || event.requestId.startsWith(`${command.commandId}-`))
    );
    const byRequest = Map.groupBy(correlated, (event) => event.requestId!);
    return [...byRequest.values()].flatMap((requestEvents) => {
      const detailed = requestEvents.filter((event) =>
        event.component !== 'state-write-production-service-call' &&
        Number.isInteger(event.details?.attempt) && Number(event.details?.attempt) > 0
      );
      const fallback = requestEvents.filter((event) =>
        event.component === 'state-write-production-service-call' ||
        event.component === 'group-topology-management-service'
      ).slice(-1);
      const observations = detailed.length > 0 ? detailed : fallback;
      return observations.map((event, index) => ({
        commandId: command.commandId,
        attempt: Number(event.details?.attempt ?? index + 1),
        outcome: timingOutcome(event),
        source: `${event.component}.${event.operation}`,
      }));
    });
  });
}

function timingOutcome(event: RallarTimingEvent): AttemptObservation['outcome'] {
  const outcome = String(event.details?.outcome ?? '').toLowerCase();
  if (outcome.includes('exhaust')) return 'exhausted';
  if (outcome.includes('conflict') || outcome.includes('retry')) return 'conflicted';
  return 'accepted';
}

async function queryDurableEvidence(sql: Sql, contextId: string): Promise<DurableEvidence> {
  const receiptRows = await sql<{ ris_resource_id: string; ris_resource: unknown }[]>`
    select ris_resource_id, ris_resource
    from resource_inbox_results
    where fk_ext_bank_id = ${contextId} and ris_topic_id = ${RECEIPT_TOPIC}
    order by ris_resource_id
  `;
  const intentRows = await sql<{ ri_resource_id: string; ri_resource: unknown }[]>`
    select ri_resource_id, ri_resource
    from resource_inbox
    where fk_ext_bank_id = ${contextId} and ri_topic_id = ${OUTBOX_TOPIC}
    order by ri_resource_id
  `;
  return {
    receiptCommandIds: receiptRows.map((row) => {
      const payload = parseResourcePayload(row.ris_resource);
      return String(payload.originatingCommandId ?? row.ris_resource_id);
    }),
    outboxIntents: intentRows.map((row) => {
      const payload = parseResourcePayload(row.ri_resource);
      return {
        intentId: String(payload.intentId ?? row.ri_resource_id),
        commandId: String(payload.originatingCommandId ?? ''),
        intentKind: String(payload.intentKind ?? ''),
      };
    }),
  };
}

function parseResourcePayload(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Durable benchmark payload must be an object');
  }
  return parsed as Record<string, unknown>;
}

function deriveCorrectness(
  commands: readonly RawCommand[],
  durable: DurableEvidence,
): CorrectnessMetrics {
  const requiredOutboxIntentCount = sum(
    commands.map((command) => STATE_WRITE_MUTATION_CONTRACT[command.kind].length),
  );
  const effectfulCommandCount =
    commands.filter((command) => STATE_WRITE_MUTATION_CONTRACT[command.kind].length > 0).length;
  const dbwFindings: string[] = [];
  if (durable.receiptCommandIds.length !== commands.length) {
    dbwFindings.push('DBW-RECEIPT-CARDINALITY');
  }
  if (durable.outboxIntents.length !== requiredOutboxIntentCount) {
    dbwFindings.push('DBW-OUTBOX-CARDINALITY');
  }
  return {
    acceptedCommandCount: commands.length,
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

function classifySql(query: string): 'read' | 'write' | 'outbox' {
  const normalized = query.trim().toLowerCase();
  if (/\bresource_inbox\b/.test(normalized) && !/\bresource_inbox_results\b/.test(normalized)) {
    return 'outbox';
  }
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
      resource_inbox: string | null;
      resource_inbox_results: string | null;
    }[]
  >`
    select to_regclass('runtime_state_store')::text as runtime_state_store,
           to_regclass('resource_inbox')::text as resource_inbox,
           to_regclass('resource_inbox_results')::text as resource_inbox_results
  `;
  const row = rows[0];
  if (!row?.runtime_state_store || !row.resource_inbox || !row.resource_inbox_results) {
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

function assertRunCorrectness(sample: RunSample): void {
  if (sample.correctness.acceptedCommandCount !== sample.correctness.receiptCount) {
    sample.correctness.dbwFindings.push('DBW-RECEIPT-CARDINALITY');
  }
  if (sample.correctness.requiredOutboxIntentCount !== sample.correctness.outboxIntentCount) {
    sample.correctness.dbwFindings.push('DBW-OUTBOX-CARDINALITY');
  }
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
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
    warmup: parseIntegerOption('warmup', values.get('warmup'), 1, 0),
    runs: parseIntegerOption('runs', values.get('runs'), 3, 1),
    concurrency: parseIntegerOption(
      'concurrency',
      values.get('concurrency'),
      REQUIRED_CONCURRENCY,
      1,
    ),
    out: values.get('out') || 'tmp/perf/api-v1-state-write-results.json',
  };
}

function parseIntegerOption(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error(`--${name} must be a finite integer >= ${minimum}; received ${raw}`);
  }
  return value;
}

function assertPerfOutputPath(path: string): void {
  const normalized = normalize(path).replaceAll('\\', '/');
  if (!normalized.startsWith('tmp/perf/') || normalized.includes('/../')) {
    throw new Error(`Benchmark output must remain under tmp/perf/: ${path}`);
  }
}
