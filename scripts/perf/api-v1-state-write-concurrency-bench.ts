import type {
    ConnectGroupPresenceSessionRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    StateScope
} from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { dirname, normalize } from 'node:path';
import process from 'node:process';
import type { Sql } from 'postgres';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import type {
    AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import {
    deriveAppInboxAttemptObservations,
    type AppInboxAttemptObservation
} from './api-v1-state-write-attempt-evidence.ts';
import {
    queryStateWriteDurableEvidence,
    type StateWriteBenchmarkCommand,
    type StateWriteDurableEvidence
} from './api-v1-state-write-durable-evidence.ts';
import {
    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
    requiredStateWriteOutboxCount
} from './api-v1-state-write-outbox-contract.mjs';
import { createStateWriteBenchmarkSql } from './create-state-write-benchmark-sql.ts';
import { mapWithConcurrency } from './map-with-concurrency.ts';
import {
    toStateWriteBenchmarkGroupContextId,
    toStateWriteBenchmarkSessionId
} from './state-write/api-v1-state-write-app-inbox-evidence.ts';
import {
    createStateWriteBenchmarkArtifact,
    readBenchmarkGitIdentity,
    type BenchmarkGitIdentity,
    type StateWriteBenchmarkRegressionReason
} from './state-write/api-v1-state-write-benchmark-artifact.ts';
import {
    parseBenchmarkOptions,
    STATE_WRITE_REQUIRED_CONCURRENCY,
    type StateWriteBenchmarkOptions
} from './state-write/api-v1-state-write-benchmark-options.ts';

import { parseGroupTopologyRegressionReasons } from './pool-group-topology-state-write-position-balanced-results.mjs';

import { toApiV1PostgresClient } from '../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';
import {
    stateWriteProductionPhaseDuration,
    type StateWriteSqlMetrics
} from './create-instrumented-state-write-sql.ts';
import {
    createStateWriteServiceRuntime,
    type StateWriteServiceRuntime,
    type StateWriteServiceRuntimeContext
} from './create-state-write-service-runtime.ts';
import {
    assertStateWriteSchemaReady,
    readStateWritePostgresCounters,
    readStateWriteWalDifference,
    startStateWriteLockWaitSampler,
    type StateWritePostgresCounters
} from './read-state-write-postgres-counters.ts';
import { selectStateWriteRegressionReasons } from './state-write/api-v1-state-write-regression-reasons.ts';

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';
const CLIENT_COUNT = 100;
const BENCHMARK_SESSION_ISSUED_AT_EPOCH_MS = 1_700_000_000_000;
const BENCHMARK_SESSION_EXPIRES_AT_EPOCH_MS = 4_102_444_800_000;
const MUTATION_MIX = [
    'profile-instance',
    'membership',
    'presence-connect',
    'presence-heartbeat',
    'presence-disconnect',
    'config',
    'topology-source'
] as const;
const WORKLOADS = [
    { name: 'uncontended', clients: CLIENT_COUNT, groups: 100 },
    { name: 'shared', clients: CLIENT_COUNT, groups: 5 },
    { name: 'hot', clients: CLIENT_COUNT, groups: 1 }
] as const;

interface CorrectnessMetrics {
    acceptedCommandCount: number;
    receiptCount: number;
    effectfulCommandCount: number;
    requiredOutboxIntentCount: number;
    outboxIntentCount: number;
    atomicCompletionFailures: number;
    dbwFindings: string[];
}

interface OutcomeMetrics {
    accepted: number;
    conflicted: number;
    transientRetries: number;
    exhausted: number;
    attempts: number;
}

interface LatencySummary {
    p50: number;
    p95: number;
    p99: number;
}
type SqlArtifactMetrics = Pick<StateWriteSqlMetrics, 'statements' | 'rowsRead' | 'serializedResultBytes'>;
interface PostgresArtifactMetrics {
    transactionDurationMs: number;
    lockWaitMs: number;
    cpuTimeMs: number;
    sharedBufferHits: number;
    sharedBufferReads: number;
    walBytes: number;
}
interface TimingArtifactMetrics {
    read: number;
    compute: number;
    validate: number;
    write: number;
    transaction: number;
    outbox: number;
}
interface OutcomeArtifactMetrics extends OutcomeMetrics {
    readonly attemptsPerAcceptedMutation: number;
}
interface RunSample {
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
    commands: StateWriteBenchmarkCommand[];
    attemptObservations: AppInboxAttemptObservation[];
    stackCommandCounts: [number, number];
    durableEvidence: StateWriteDurableEvidence;
}
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

interface MutationCommand {
    kind: (typeof MUTATION_MIX)[number];
    clientIndex: number;
    groupIndex: number;
}

function createBenchmarkAuthSession(
    scope: StateScope,
    principalId: string,
    sessionLabel: string
): IssuedAuthSession {
    const scopeIdentity = [scope.applicationId, scope.workspaceId].map(
        encodeURIComponent
    ).join(':');
    const principalIdentity = encodeURIComponent(principalId);
    const sessionIdentity = encodeURIComponent(sessionLabel);
    return {
        clientId: principalId,
        username: principalId,
        sessionId: toStateWriteBenchmarkSessionId(scope, principalId, sessionLabel),
        accessToken: `state-write-benchmark:${scopeIdentity}:${principalIdentity}:${sessionIdentity}`,
        issuedAtEpochMs: BENCHMARK_SESSION_ISSUED_AT_EPOCH_MS,
        expiresAtEpochMs: BENCHMARK_SESSION_EXPIRES_AT_EPOCH_MS
    };
}

if (import.meta.main) {
    await main();
}

function validateBenchmarkRunOptions(
    options: StateWriteBenchmarkOptions
): Either<Error, StateWriteBenchmarkOptions> {
    if (options.backend !== 'postgres') {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --backend=postgres; received ${options.backend}`
            )
        );
    }
    if (options.warmup !== 1) {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --warmup=1; received ${options.warmup}`
            )
        );
    }
    if (options.runs < 3) {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --runs>=3; received ${options.runs}`
            )
        );
    }
    if (options.concurrency !== STATE_WRITE_REQUIRED_CONCURRENCY) {
        return Either.ofLeft(
            new Error(
                `State-write benchmark requires --concurrency=${STATE_WRITE_REQUIRED_CONCURRENCY}; ` +
                    `received ${options.concurrency}`
            )
        );
    }
    return Either.ofRight(options);
}

interface BenchmarkConfiguration {
    readonly options: StateWriteBenchmarkOptions;
    readonly gitIdentity: BenchmarkGitIdentity;
    readonly regressionReasons: readonly StateWriteBenchmarkRegressionReason[];
    readonly databaseUrl: string;
    readonly runId: string;
}

async function readBenchmarkConfiguration(): Promise<BenchmarkConfiguration> {
    const options = parseBenchmarkOptions(Deno.args);
    const validation = validateBenchmarkRunOptions(options);
    if (validation.left) {
        throw validation.left;
    }
    assertPerfOutputPath(options.out);
    const gitIdentity = await readBenchmarkGitIdentity();
    const reasonsText = options.regressionReasonsFile === undefined
        ? undefined
        : await Deno.readTextFile(options.regressionReasonsFile);
    const precommittedReasons = parseGroupTopologyRegressionReasons(
        reasonsText,
        gitIdentity
    );
    const regressionReasons = selectStateWriteRegressionReasons(
        options.regressionReasonProfile,
        precommittedReasons
    );

    const databaseUrl = Deno.env.get('DATABASE_URL')?.trim() ||
        DEFAULT_DATABASE_URL;
    const runId = `state-write-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    return { options, gitIdentity, regressionReasons, databaseUrl, runId };
}

async function main(): Promise<void> {
    const { options, gitIdentity, regressionReasons, databaseUrl, runId } = await readBenchmarkConfiguration();
    const adminSql = createStateWriteBenchmarkSql({
        databaseUrl,
        maxConnections: 10,
        applicationName: `${runId}-admin`
    });
    const serviceSql = [0, 1].map((index) =>
        createStateWriteBenchmarkSql({
            databaseUrl,
            maxConnections: options.concurrency,
            applicationName: `${runId}-service-${index}`
        })
    );

    try {
        await assertStateWriteSchemaReady(adminSql);
        const workloads = await runBenchmarkWorkloads({
            adminSql,
            serviceSql,
            runId,
            options
        });

        const artifact = createStateWriteBenchmarkArtifact({
            generatedAt: new Date().toISOString(),
            gitIdentity,
            options,
            regressionReasons,
            workloads
        });

        await Deno.mkdir(dirname(options.out), { recursive: true });
        await Deno.writeTextFile(
            options.out,
            `${JSON.stringify(artifact, null, 2)}\n`
        );
        console.log(`Wrote ${options.out}`);
    }
    finally {
        await Promise.allSettled([
            adminSql.end({ timeout: 5 }),
            ...serviceSql.map((sql) => sql.end({ timeout: 5 }))
        ]);
    }
}

interface BenchmarkWorkloadsInput {
    readonly adminSql: Sql;
    readonly serviceSql: readonly Sql[];
    readonly runId: string;
    readonly options: StateWriteBenchmarkOptions;
}

async function runBenchmarkWorkloads(
    { adminSql, serviceSql, runId, options }: BenchmarkWorkloadsInput
) {
    const workloads = [];
    for (const workload of WORKLOADS) {
        console.log(
            `Running ${workload.name}: warmup=${options.warmup}, measured=${options.runs}`
        );
        for (let warmup = 0; warmup < options.warmup; warmup += 1) {
            await runWorkloadPhase({
                adminSql,
                serviceSql,
                runId,
                workload,
                phaseLabel: `warmup-${warmup}`,
                runIndex: warmup,
                concurrency: options.concurrency
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
                    concurrency: options.concurrency
                })
            );
        }
        const summary = summarizeSamples(samples);
        workloads.push({
            name: workload.name,
            scale: {
                clients: workload.clients,
                groups: workload.groups,
                concurrency: options.concurrency
            },
            mutationMix: [...MUTATION_MIX],
            warmupRuns: options.warmup,
            measuredRuns: options.runs,
            samples,
            summary
        });
        console.log(JSON.stringify({ workload: workload.name, ...summary }));
    }
    return workloads;
}

interface BenchmarkPhaseInput {
    readonly adminSql: Sql;
    readonly serviceSql: readonly Sql[];
    readonly runId: string;
    readonly workload: (typeof WORKLOADS)[number];
    readonly phaseLabel: string;
    readonly runIndex: number;
    readonly concurrency: number;
}

async function runWorkloadPhase(
    input: BenchmarkPhaseInput
): Promise<RunSample> {
    const { scope, context, runtimes, commands, postgresBefore, cpuBefore, lockSampler } =
        await prepareWorkloadMeasurement(input);
    let rawCommands: StateWriteBenchmarkCommand[];
    const startedAt = performance.now();

    try {
        rawCommands = await executeMeasuredWorkload({
            commands,
            runtimes,
            scope,
            concurrency: input.concurrency
        });
    }
    catch (error) {
        try {
            await lockSampler.stop();
        }
        catch (cleanupError) {
            console.error(
                'State-write benchmark cleanup failed after command failure',
                cleanupError
            );
        }
        throw error;
    }

    const durationMs = performance.now() - startedAt;
    const lockWaitMs = await lockSampler.stop();
    const cpu = process.cpuUsage(cpuBefore);
    const evidence = await readWorkloadEvidence({
        sql: input.adminSql,
        scope,
        rawCommands,
        groupCount: input.workload.groups,
        timingEvents: context.timingEvents,
        postgresBefore
    });
    return computeRunSample({
        runIndex: input.runIndex,
        rawCommands,
        context,
        durationMs,
        lockWaitMs,
        cpuTimeMs: (cpu.user + cpu.system) / 1_000,
        postgresBefore,
        evidence
    });
}

async function prepareWorkloadMeasurement(input: BenchmarkPhaseInput) {
    const scope: StateScope = {
        applicationId: `${input.runId}-${input.workload.name}-${input.phaseLabel}`,
        workspaceId: 'state-write-bench'
    };
    await seedCompleteState(input.adminSql, scope, input.workload);

    const context = newRunContext();
    const timing: RallarTimingSink = (event) => context.timingEvents.push(event);
    const runtimes = input.serviceSql.map((sql, index) =>
        createStateWriteServiceRuntime({
            sql,
            serviceId: `state-write-bench-${index}`,
            context,
            timing
        })
    );
    const commands = createCommands(input.workload);
    const postgresBefore = await readStateWritePostgresCounters(input.adminSql);
    const cpuBefore = process.cpuUsage();
    const lockSampler = startStateWriteLockWaitSampler(
        input.adminSql,
        `${input.runId}-service-`
    );
    return { scope, context, runtimes, commands, postgresBefore, cpuBefore, lockSampler };
}

interface WorkloadEvidenceInput {
    readonly sql: Sql;
    readonly scope: StateScope;
    readonly rawCommands: readonly StateWriteBenchmarkCommand[];
    readonly groupCount: number;
    readonly timingEvents: StateWriteServiceRuntimeContext['timingEvents'];
    readonly postgresBefore: StateWritePostgresCounters;
}

interface WorkloadEvidence {
    readonly postgresAfter: StateWritePostgresCounters;
    readonly walBytes: number;
    readonly durable: StateWriteDurableEvidence;
}

async function readWorkloadEvidence(
    { sql, scope, rawCommands, groupCount, timingEvents, postgresBefore }: WorkloadEvidenceInput
): Promise<WorkloadEvidence> {
    const postgresAfter = await readStateWritePostgresCounters(sql);
    const walBytes = await readStateWriteWalDifference({
        sql: sql,
        before: postgresBefore.walLsn,
        after: postgresAfter.walLsn
    });
    const durable = await queryStateWriteDurableEvidence({
        sql: sql,
        scope,
        commands: rawCommands,
        groupCount: groupCount,
        timingEvents: timingEvents
    });
    return { postgresAfter, walBytes, durable };
}

interface BenchmarkSampleFacts {
    readonly runIndex: number;
    readonly rawCommands: StateWriteBenchmarkCommand[];
    readonly context: StateWriteServiceRuntimeContext;
    readonly durationMs: number;
    readonly lockWaitMs: number;
    readonly cpuTimeMs: number;
    readonly postgresBefore: StateWritePostgresCounters;
    readonly evidence: WorkloadEvidence;
}

function computeRunSample(facts: BenchmarkSampleFacts): RunSample {
    const { runIndex, rawCommands, context, durationMs, evidence } = facts;
    const { durable } = evidence;
    const attemptObservations = deriveAppInboxAttemptObservations(
        context.attemptReleases,
        durable.appInbox,
        rawCommands
    );
    const accepted = rawCommands.filter((command) => command.status === 'accepted').length;
    const attempts = attemptObservations.length;
    const outcomes: OutcomeMetrics = {
        accepted,
        conflicted: attemptObservations.filter((entry) => entry.outcome === 'conflicted')
            .length,
        transientRetries: attemptObservations.filter((entry) => entry.outcome === 'transient-retry')
            .length,
        exhausted: rawCommands.filter((command) => command.status === 'exhausted').length,
        attempts
    };
    const correctness = deriveCorrectness(rawCommands, durable);
    const latencySamplesMs = rawCommands.map((command) => command.latencyMs);
    const stackCommandCounts: [number, number] = [
        rawCommands.filter((command) => command.stackIndex === 0).length,
        rawCommands.filter((command) => command.stackIndex === 1).length
    ];
    const sample = {
        runIndex,
        durationMs,
        throughputPerSecond: accepted / (durationMs / 1_000),
        latencySamplesMs,
        latencyMs: summarizeLatency(latencySamplesMs),
        outcomes: {
            ...outcomes,
            attemptsPerAcceptedMutation: accepted === 0
                ? attempts
                : attempts / accepted
        },
        sql: {
            statements: context.sql.statements,
            rowsRead: context.sql.rowsRead,
            serializedResultBytes: context.sql.serializedResultBytes
        },
        postgres: computeSamplePostgresMetrics(facts),
        timingsMs: computeSampleTimingMetrics(context),
        correctness,
        commands: rawCommands,
        attemptObservations,
        stackCommandCounts,
        durableEvidence: durable
    };
    return sample;
}

function computeSamplePostgresMetrics(
    facts: BenchmarkSampleFacts
): PostgresArtifactMetrics {
    const { context, lockWaitMs, cpuTimeMs, postgresBefore } = facts;
    const { postgresAfter, walBytes } = facts.evidence;
    return {
        transactionDurationMs: context.sql.transactionDurationMs,
        lockWaitMs,
        cpuTimeMs: cpuTimeMs,
        sharedBufferHits: nonNegativeDelta(
            postgresAfter.sharedBufferHits,
            postgresBefore.sharedBufferHits
        ),
        sharedBufferReads: nonNegativeDelta(
            postgresAfter.sharedBufferReads,
            postgresBefore.sharedBufferReads
        ),
        walBytes
    };
}

function computeSampleTimingMetrics(
    context: StateWriteServiceRuntimeContext
): TimingArtifactMetrics {
    return {
        read: stateWriteProductionPhaseDuration(context.timingEvents, 'read'),
        compute: stateWriteProductionPhaseDuration(context.timingEvents, 'compute'),
        validate: stateWriteProductionPhaseDuration(
            context.timingEvents,
            'validate'
        ),
        write: stateWriteProductionPhaseDuration(context.timingEvents, 'write'),
        transaction: stateWriteProductionPhaseDuration(
            context.timingEvents,
            'transaction'
        ),
        outbox: context.sql.outboxSqlMs
    };
}

interface MeasuredWorkloadInput {
    readonly commands: readonly MutationCommand[];
    readonly runtimes: readonly StateWriteServiceRuntime[];
    readonly scope: StateScope;
    readonly concurrency: number;
}

async function executeMeasuredWorkload(
    { commands, runtimes, scope, concurrency }: MeasuredWorkloadInput
): Promise<StateWriteBenchmarkCommand[]> {
    const rawCommands: StateWriteBenchmarkCommand[] = [];
    for (const kind of MUTATION_MIX) {
        const phaseCommands = commands.filter((command) => command.kind === kind);
        const phaseResults = await mapWithConcurrency(
            phaseCommands,
            concurrency,
            async (command, commandIndex) => {
                const stackIndex = selectServiceStack(commandIndex, runtimes.length);
                const runtime = runtimes[stackIndex];
                if (!runtime) {
                    throw new Error(`Missing service runtime at stack ${stackIndex}`);
                }
                const commandId = commandIdentifier(scope, command);
                const commandStartedAt = performance.now();
                await executeMeasuredCommand({
                    runtime,
                    scope,
                    command,
                    requestId: commandId
                });
                return {
                    commandId,
                    kind,
                    latencyMs: performance.now() - commandStartedAt,
                    stackIndex,
                    status: 'accepted' as const
                };
            }
        );
        rawCommands.push(...phaseResults);
    }
    return rawCommands;
}

interface ExecuteMeasuredCommandInput {
    readonly runtime: StateWriteServiceRuntime;
    readonly scope: StateScope;
    readonly command: MutationCommand;
    readonly requestId: string;
}

async function executeMeasuredCommand({
    runtime,
    scope,
    command,
    requestId
}: ExecuteMeasuredCommandInput): Promise<void> {
    const prepared = {
        requestId,
        principalId: `client-${command.clientIndex}`,
        instanceId: `instance-${command.clientIndex}`,
        clientAuthority: createBenchmarkAuthSession(
            scope,
            `client-${command.clientIndex}`,
            `client-session-${command.clientIndex}`
        ),
        ownerAuthority: createBenchmarkAuthSession(
            scope,
            `owner-${command.groupIndex}`,
            `owner-session-${command.groupIndex}`
        ),
        groupId: `group-${command.groupIndex}`,
        ownerId: `owner-${command.groupIndex}`,
        timestamp: Date.now() + command.clientIndex
    };
    const preparedWithPresenceIdentity = {
        ...prepared,
        sessionId: prepared.clientAuthority.sessionId,
        generationId: `${prepared.clientAuthority.sessionId}:generation-1`
    };
    await executeMutation({
        runtime,
        scope,
        kind: command.kind,
        command: preparedWithPresenceIdentity
    });
}

interface ExecuteMutationInput {
    readonly runtime: StateWriteServiceRuntime;
    readonly scope: StateScope;
    readonly kind: (typeof MUTATION_MIX)[number];
    readonly command: Readonly<{
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
    }>;
}

interface RoutedBenchmarkMutation extends ExecuteMutationInput {
    readonly clientContextId: string;
    readonly groupContextId: string;
}

async function executeMutation(input: ExecuteMutationInput): Promise<void> {
    const { scope, command } = input;
    const routed: RoutedBenchmarkMutation = {
        ...input,
        clientContextId: toAuthenticatedClientMutationContextId({
            scope,
            principalId: command.principalId,
            callerClientId: command.clientAuthority.clientId,
            callerSessionId: command.clientAuthority.sessionId
        }),
        groupContextId: toStateWriteBenchmarkGroupContextId(scope, command.groupId)
    };
    switch (input.kind) {
        case 'profile-instance':
            await runMeasuredProfileMutation(routed);
            await runMeasuredInstanceMutation(routed);
            return;
        case 'membership':
            await runMeasuredMembershipMutation(routed);
            return;
        case 'presence-connect':
            await runMeasuredPresenceConnect(routed);
            return;
        case 'presence-heartbeat':
            await runMeasuredPresenceHeartbeat(routed);
            return;
        case 'presence-disconnect':
            await runMeasuredPresenceDisconnect(routed);
            return;
        case 'config':
            await runMeasuredConfigMutation(routed);
            return;
        case 'topology-source':
            await runMeasuredTopologyMutation(routed);
            return;
    }
}

async function runMeasuredProfileMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, clientContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
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
                        requestId: `${command.requestId}-profile`
                    }
                }
            },
            command.clientAuthority
        )
    );
}

async function runMeasuredInstanceMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, clientContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_INSTANCE_UPSERT,
                topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
                resourceId: `${command.requestId}-instance`,
                contextId: clientContextId,
                senderId: command.principalId,
                data: {
                    scope,
                    principalId: command.principalId,
                    clientInstanceId: command.instanceId,
                    request: {
                        status: 'active',
                        platform: 'web',
                        appVersion: 'task-12',
                        capabilities: ['state-write-benchmark'],
                        actorPrincipalId: command.principalId,
                        requestId: `${command.requestId}-instance`
                    }
                }
            },
            command.clientAuthority
        )
    );
}

async function runMeasuredMembershipMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            {
                type: AppInboxType.GROUP_MEMBER_UPSERT,
                topicId: AppInboxType.GROUP_MEMBER_UPSERT,
                resourceId: command.requestId,
                contextId: groupContextId,
                senderId: command.principalId,
                data: {
                    scope,
                    groupId: command.groupId,
                    principalId: command.principalId,
                    request: {
                        status: 'active',
                        actorPrincipalId: command.principalId,
                        requestId: command.requestId
                    }
                }
            },
            command.clientAuthority
        )
    );
}

async function runMeasuredPresenceConnect(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runGroupPresenceMutation({
        runtime,
        command,
        scope,
        contextId: groupContextId,
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        request: {
            principalId: command.principalId,
            generationId: command.generationId,
            connectedAtEpochMs: command.timestamp,
            lastHeartbeatAtEpochMs: command.timestamp,
            expiresAtEpochMs: command.timestamp + 60_000,
            actorPrincipalId: command.principalId,
            actorSessionId: command.sessionId,
            requestId: command.requestId
        }
    });
}

async function runMeasuredPresenceHeartbeat(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runGroupPresenceMutation({
        runtime,
        command,
        scope,
        contextId: groupContextId,
        type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        request: {
            principalId: command.principalId,
            generationId: command.generationId,
            lastHeartbeatAtEpochMs: command.timestamp + 1_000,
            expiresAtEpochMs: command.timestamp + 61_000,
            actorPrincipalId: command.principalId,
            actorSessionId: command.sessionId,
            requestId: command.requestId
        }
    });
}

async function runMeasuredPresenceDisconnect(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runGroupPresenceMutation({
        runtime,
        command,
        scope,
        contextId: groupContextId,
        type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
        request: {
            principalId: command.principalId,
            generationId: command.generationId,
            disconnectedAtEpochMs: command.timestamp + 2_000,
            lastHeartbeatAtEpochMs: command.timestamp + 1_000,
            expiresAtEpochMs: command.timestamp + 61_000,
            actorPrincipalId: command.principalId,
            actorSessionId: command.sessionId,
            requestId: command.requestId
        }
    });
}

async function runMeasuredConfigMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            {
                type: AppInboxType.GROUP_UPDATE,
                topicId: AppInboxType.GROUP_UPDATE,
                resourceId: command.requestId,
                contextId: groupContextId,
                senderId: command.ownerId,
                data: {
                    scope,
                    groupId: command.groupId,
                    request: {
                        metadata: { benchmarkConfigSource: command.requestId },
                        actorPrincipalId: command.ownerId,
                        requestId: command.requestId
                    }
                }
            },
            command.ownerAuthority
        )
    );
}

async function runMeasuredTopologyMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    const data = await toTopologyAppInboxCommand({
        actor: {
            principalId: command.ownerId,
            sessionId: command.ownerAuthority.sessionId
        },
        groupRef: { ...scope, groupId: command.groupId },
        requestId: command.requestId,
        capturedAtEpochMs: command.timestamp,
        payload: {
            operation: 'putConfig',
            config: {
                topologyKind: command.timestamp % 2 === 0 ? 'tree' : 'mesh',
                degreeLimit: 5,
                treeMinSize: 5,
                meshMinSize: 16,
                meshParamK: 2
            }
        }
    });
    await runAppInboxMutation(
        runtime,
        runtime.topology.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.TOPOLOGY_CONFIG_PUT,
                topicId: AppInboxType.TOPOLOGY_CONFIG_PUT,
                resourceId: command.requestId,
                contextId: groupContextId,
                senderId: command.ownerId,
                data
            },
            command.ownerAuthority
        )
    );
}

interface RunGroupPresenceMutationInputBase {
    readonly runtime: StateWriteServiceRuntime;
    readonly command: ExecuteMutationInput['command'];
    readonly scope: StateScope;
    readonly contextId: string;
}

type RunGroupPresenceMutationInput =
    & RunGroupPresenceMutationInputBase
    & (
        | Readonly<{
            type: typeof AppInboxType.GROUP_PRESENCE_CONNECT;
            request: ConnectGroupPresenceSessionRequest;
        }>
        | Readonly<{
            type: typeof AppInboxType.GROUP_PRESENCE_HEARTBEAT;
            request: HeartbeatGroupPresenceSessionRequest;
        }>
        | Readonly<{
            type: typeof AppInboxType.GROUP_PRESENCE_DISCONNECT;
            request: DisconnectGroupPresenceSessionRequest;
        }>
    );

async function runGroupPresenceMutation(
    input: RunGroupPresenceMutationInput
): Promise<void> {
    await runAppInboxMutation(
        input.runtime,
        input.runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            toGroupPresenceEnqueue(input),
            input.command.clientAuthority
        )
    );
}

function toGroupPresenceEnqueue(
    input: RunGroupPresenceMutationInput
): AuthenticatedGroupMutationEnqueue {
    const command = input.command;
    const shared = {
        topicId: input.type,
        resourceId: command.requestId,
        contextId: input.contextId,
        senderId: command.principalId
    };
    const data = {
        scope: input.scope,
        groupId: command.groupId,
        sessionId: command.sessionId
    };

    switch (input.type) {
        case AppInboxType.GROUP_PRESENCE_CONNECT:
            return {
                ...shared,
                type: input.type,
                data: { ...data, request: input.request }
            };
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT:
            return {
                ...shared,
                type: input.type,
                data: { ...data, request: input.request }
            };
        case AppInboxType.GROUP_PRESENCE_DISCONNECT:
            return {
                ...shared,
                type: input.type,
                data: { ...data, request: input.request }
            };
    }
}

async function runAppInboxMutation<Failure extends string | Readonly<{ message: string; }>, Result>(
    runtime: StateWriteServiceRuntime,
    operation: Promise<Either<Failure, Result>>
): Promise<void> {
    let settled = false;
    const pending = operation.then(
        (value) => {
            settled = true;
            return { status: 'fulfilled' as const, value };
        },
        (reason: unknown) => {
            settled = true;
            return { status: 'rejected' as const, reason };
        }
    );
    while (!settled) {
        await runtime.inbox.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            runtime.resilience
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const completion = await pending;
    if (completion.status === 'rejected') {
        throw completion.reason;
    }
    completion.value.fold(
        (error) => {
            throw new Error(typeof error === 'string' ? error : error.message);
        },
        () => undefined
    );
}

async function seedCompleteState(
    sql: Sql,
    scope: StateScope,
    workload: (typeof WORKLOADS)[number]
): Promise<void> {
    const pgSql = toApiV1PostgresClient(sql);
    const runtimeRepository = new PSqlRuntimeStateRepository(pgSql);
    const authSessionRepository = new AuthSessionRepository(runtimeRepository);
    const runtime = createStateWriteServiceRuntime({
        sql,
        serviceId: 'state-write-bench-seed',
        context: newRunContext(),
        timing: () => undefined
    });

    await mapWithConcurrency(
        Array.from({ length: workload.groups }, (_, groupIndex) => groupIndex),
        STATE_WRITE_REQUIRED_CONCURRENCY,
        async (groupIndex) => await seedBenchmarkGroup({ runtime, scope, authSessionRepository }, groupIndex)
    );

    await mapWithConcurrency(
        Array.from({ length: workload.clients }, (_, clientIndex) => clientIndex),
        STATE_WRITE_REQUIRED_CONCURRENCY,
        async (clientIndex) => await seedBenchmarkClient({ runtime, scope, authSessionRepository }, clientIndex)
    );
}

interface BenchmarkSeedContext {
    readonly runtime: StateWriteServiceRuntime;
    readonly scope: StateScope;
    readonly authSessionRepository: AuthSessionRepository;
}

async function seedBenchmarkGroup(context: BenchmarkSeedContext, groupIndex: number): Promise<void> {
    const { runtime, scope, authSessionRepository } = context;
    const ownerId = `owner-${groupIndex}`;
    const authority = createBenchmarkAuthSession(
        scope,
        ownerId,
        `owner-session-${groupIndex}`
    );
    await authSessionRepository.putSession(authority);
    const groupId = `group-${groupIndex}`;
    await runAppInboxMutation(
        runtime,
        runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            {
                type: AppInboxType.GROUP_CREATE,
                topicId: AppInboxType.GROUP_CREATE,
                resourceId: `seed-group-${groupIndex}`,
                contextId: toStateWriteBenchmarkGroupContextId(scope, groupId),
                senderId: ownerId,
                data: {
                    scope,
                    request: {
                        groupId,
                        displayName: `State Write Benchmark Group ${groupIndex}`,
                        kind: 'room',
                        joinMode: 'open',
                        maxMembers: CLIENT_COUNT + 1,
                        maxSessionsPerMember: 4,
                        metadata: { benchmark: true },
                        createdByPrincipalId: ownerId,
                        actorPrincipalId: ownerId,
                        actorSessionId: authority.sessionId,
                        requestId: `seed-group-${groupIndex}`
                    }
                }
            },
            authority
        )
    );
}

async function seedBenchmarkClient(context: BenchmarkSeedContext, clientIndex: number): Promise<void> {
    const { runtime, scope, authSessionRepository } = context;
    const principalId = `client-${clientIndex}`;
    const authority = createBenchmarkAuthSession(
        scope,
        principalId,
        `client-session-${clientIndex}`
    );
    await authSessionRepository.putSession(authority);
    const contextId = toAuthenticatedClientMutationContextId({
        scope,
        principalId,
        callerClientId: authority.clientId,
        callerSessionId: authority.sessionId
    });
    await seedClientPrincipal({ runtime, scope, authority, principalId, clientIndex, contextId });
    await seedClientInstance({ runtime, scope, authority, principalId, clientIndex, contextId });
}

interface BenchmarkSeedClient {
    readonly runtime: StateWriteServiceRuntime;
    readonly scope: StateScope;
    readonly authority: IssuedAuthSession;
    readonly principalId: string;
    readonly clientIndex: number;
    readonly contextId: string;
}

async function seedClientPrincipal(input: BenchmarkSeedClient): Promise<void> {
    const { runtime, scope, authority, principalId, clientIndex, contextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: `seed-principal-${clientIndex}`,
                contextId,
                senderId: principalId,
                data: {
                    scope,
                    principalId,
                    request: {
                        username: principalId,
                        displayName: `Seed Client ${clientIndex}`,
                        status: 'active',
                        actorPrincipalId: principalId,
                        requestId: `seed-principal-${clientIndex}`
                    }
                }
            },
            authority
        )
    );
}

async function seedClientInstance(input: BenchmarkSeedClient): Promise<void> {
    const { runtime, scope, authority, principalId, clientIndex, contextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_INSTANCE_UPSERT,
                topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
                resourceId: `seed-instance-${clientIndex}`,
                contextId,
                senderId: principalId,
                data: {
                    scope,
                    principalId,
                    clientInstanceId: `instance-${clientIndex}`,
                    request: {
                        status: 'active',
                        platform: 'web',
                        appVersion: 'seed',
                        actorPrincipalId: principalId,
                        requestId: `seed-instance-${clientIndex}`
                    }
                }
            },
            authority
        )
    );
}

function createCommands(
    workload: (typeof WORKLOADS)[number]
): MutationCommand[] {
    return MUTATION_MIX.flatMap((kind) =>
        Array.from({ length: workload.clients }, (_, clientIndex) => ({
            kind,
            clientIndex,
            groupIndex: clientIndex % workload.groups
        }))
    );
}

function commandIdentifier(
    scope: StateScope,
    command: MutationCommand
): string {
    return `${scope.applicationId}:${command.kind}:${command.clientIndex}`;
}

function selectServiceStack(commandIndex: number, stackCount: number): number {
    if (!Number.isInteger(commandIndex) || commandIndex < 0) {
        throw new Error('commandIndex must be a non-negative integer');
    }
    if (!Number.isInteger(stackCount) || stackCount < 1) {
        throw new Error('stackCount must be a positive integer');
    }
    return commandIndex % stackCount;
}

function deriveCorrectness(
    commands: readonly StateWriteBenchmarkCommand[],
    durable: StateWriteDurableEvidence
): CorrectnessMetrics {
    const requiredOutboxIntentCount = requiredStateWriteOutboxCount(
        commands,
        durable.receipts
    );
    const effectfulCommandCount = commands.filter(
        (command) =>
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
        dbwFindings
    };
}

function summarizeSamples(samples: readonly RunSample[]): WorkloadSummary {
    const latencySamples = samples.flatMap((sample) => sample.latencySamplesMs);
    const accepted = sum(samples.map((sample) => sample.outcomes.accepted));
    const attempts = sum(samples.map((sample) => sample.outcomes.attempts));
    return {
        latencyMs: summarizeLatency(latencySamples),
        throughputPerSecond: accepted /
            (sum(samples.map((sample) => sample.durationMs)) / 1_000),
        outcomes: {
            accepted,
            conflicted: sum(samples.map((sample) => sample.outcomes.conflicted)),
            transientRetries: sum(
                samples.map((sample) => sample.outcomes.transientRetries)
            ),
            exhausted: sum(samples.map((sample) => sample.outcomes.exhausted)),
            attempts,
            attemptsPerAcceptedMutation: accepted === 0
                ? attempts
                : attempts / accepted
        },
        sql: medianSqlMetrics(samples),
        postgres: medianPostgresMetrics(samples),
        timingsMs: medianTimingMetrics(samples),
        correctness: {
            acceptedCommandCount: sum(
                samples.map((sample) => sample.correctness.acceptedCommandCount)
            ),
            receiptCount: sum(
                samples.map((sample) => sample.correctness.receiptCount)
            ),
            effectfulCommandCount: sum(
                samples.map((sample) => sample.correctness.effectfulCommandCount)
            ),
            requiredOutboxIntentCount: sum(
                samples.map((sample) => sample.correctness.requiredOutboxIntentCount)
            ),
            outboxIntentCount: sum(
                samples.map((sample) => sample.correctness.outboxIntentCount)
            ),
            atomicCompletionFailures: sum(
                samples.map((sample) => sample.correctness.atomicCompletionFailures)
            ),
            dbwFindings: [
                ...new Set(samples.flatMap((sample) => sample.correctness.dbwFindings))
            ]
        }
    };
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
    return {
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99)
    };
}

function percentile(
    samples: readonly number[],
    percentileValue: number
): number {
    if (samples.length === 0) {
        return 0;
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const value = sorted[Math.ceil(percentileValue * sorted.length) - 1];
    if (value === undefined) {
        throw new Error('Percentile index is outside the sample set');
    }
    return value;
}

function medianSqlMetrics(samples: readonly RunSample[]): SqlArtifactMetrics {
    return {
        statements: median(samples.map((sample) => sample.sql.statements)),
        rowsRead: median(samples.map((sample) => sample.sql.rowsRead)),
        serializedResultBytes: median(
            samples.map((sample) => sample.sql.serializedResultBytes)
        )
    };
}

function medianPostgresMetrics(
    samples: readonly RunSample[]
): PostgresArtifactMetrics {
    return {
        transactionDurationMs: median(
            samples.map((sample) => sample.postgres.transactionDurationMs)
        ),
        lockWaitMs: median(samples.map((sample) => sample.postgres.lockWaitMs)),
        cpuTimeMs: median(samples.map((sample) => sample.postgres.cpuTimeMs)),
        sharedBufferHits: median(
            samples.map((sample) => sample.postgres.sharedBufferHits)
        ),
        sharedBufferReads: median(
            samples.map((sample) => sample.postgres.sharedBufferReads)
        ),
        walBytes: median(samples.map((sample) => sample.postgres.walBytes))
    };
}

function medianTimingMetrics(
    samples: readonly RunSample[]
): TimingArtifactMetrics {
    return {
        read: median(samples.map((sample) => sample.timingsMs.read)),
        compute: median(samples.map((sample) => sample.timingsMs.compute)),
        validate: median(samples.map((sample) => sample.timingsMs.validate)),
        write: median(samples.map((sample) => sample.timingsMs.write)),
        transaction: median(samples.map((sample) => sample.timingsMs.transaction)),
        outbox: median(samples.map((sample) => sample.timingsMs.outbox))
    };
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const upper = sorted[middle];
    if (upper === undefined) {
        throw new Error('Median requires at least one value');
    }
    if (sorted.length % 2 !== 0) {
        return upper;
    }
    const lower = sorted[middle - 1];
    if (lower === undefined) {
        throw new Error('Median pair is incomplete');
    }
    return (lower + upper) / 2;
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function nonNegativeDelta(after: number, before: number): number {
    return Math.max(0, after - before);
}

function newRunContext(): StateWriteServiceRuntimeContext {
    return {
        sql: {
            statements: 0,
            rowsRead: 0,
            serializedResultBytes: 0,
            readMs: 0,
            writeMs: 0,
            outboxSqlMs: 0,
            transactionDurationMs: 0
        },
        timingEvents: [],
        attemptReleases: []
    };
}

function assertPerfOutputPath(path: string): void {
    const normalized = normalize(path).replaceAll('\\', '/');
    if (!normalized.startsWith('tmp/perf/') || normalized.includes('/../')) {
        throw new Error(`Benchmark output must remain under tmp/perf/: ${path}`);
    }
}
