import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    StateScope
} from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { dirname, normalize } from 'node:path';
import process from 'node:process';
import postgres, { type Sql } from 'postgres';

import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import {
    AuthSessionRepository,
    type IssuedAuthSession
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
    AppGroupInboxService,
    toTopologyAppInboxCommand
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';

import type {
    AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import {
    deriveAppInboxAttemptObservations,
    type AppInboxAttemptObservation
} from './api-v1-state-write-attempt-evidence.ts';
import {
    queryStateWriteDurableEvidence,
    type StateWriteBenchmarkCommand,
    type StateWriteDurableEvidence
} from './api-v1-state-write-durable-evidence.ts';
import { PRODUCTION_STATE_WRITE_MUTATION_CONTRACT } from './compare-api-v1-state-write-results.mjs';
import { mapWithConcurrency } from './map-with-concurrency.ts';
import { STATE_WRITE_BENCHMARK_APP_INBOX_OPTIONS } from './state-write-wait-options.ts';
import {
    toStateWriteBenchmarkGroupContextId,
    toStateWriteBenchmarkSessionId
} from './state-write/api-v1-state-write-app-inbox-evidence.ts';
import {
    createStateWriteBenchmarkArtifact,
    readBenchmarkGitIdentity
} from './state-write/api-v1-state-write-benchmark-artifact.ts';
import {
    parseBenchmarkOptions,
    STATE_WRITE_REQUIRED_CONCURRENCY
} from './state-write/api-v1-state-write-benchmark-options.ts';

import { parseGroupTopologyRegressionReasons } from './pool-group-topology-state-write-position-balanced-results.mjs';

import { toPSqlSql } from '../../apps/api-v1/src/db/to-p-sql-sql.ts';
import { computeProductionOutboxEvidence } from './api-v1-state-write-outbox-evidence.ts';
import {
    createInstrumentedStateWriteSql,
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
    startStateWriteLockWaitSampler
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
type OutcomeArtifactMetrics = OutcomeMetrics & { attemptsPerAcceptedMutation: number; };
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

export function createBenchmarkAuthSession(
    scope: StateScope,
    principalId: string,
    sessionLabel: string
): IssuedAuthSession {
    const scopeIdentity = [scope.applicationId, scope.workspaceId].map(encodeURIComponent).join(':');
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
    if (options.concurrency !== STATE_WRITE_REQUIRED_CONCURRENCY) {
        throw new Error(
            `Task 0B requires --concurrency=${STATE_WRITE_REQUIRED_CONCURRENCY}; ` +
                `received ${options.concurrency}`
        );
    }
    assertPerfOutputPath(options.out);
    const gitIdentity = await readBenchmarkGitIdentity();
    const reasonsText = options.regressionReasonsFile === undefined
        ? undefined
        : await Deno.readTextFile(options.regressionReasonsFile);
    const precommittedReasons = parseGroupTopologyRegressionReasons(reasonsText, gitIdentity);
    const regressionReasons = selectStateWriteRegressionReasons(
        options.regressionReasonProfile,
        precommittedReasons
    );

    const databaseUrl = Deno.env.get('DATABASE_URL')?.trim() || DEFAULT_DATABASE_URL;
    const runId = `state-write-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const adminSql = postgres(databaseUrl, {
        max: 10,
        connection: { application_name: `${runId}-admin` }
    });
    const serviceSql = [0, 1].map((index) =>
        postgres(databaseUrl, {
            max: options.concurrency,
            connection: { application_name: `${runId}-service-${index}` }
        })
    );

    try {
        await assertStateWriteSchemaReady(adminSql);
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
                        measured: true,
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

        const artifact = createStateWriteBenchmarkArtifact({
            generatedAt: new Date().toISOString(),
            gitIdentity,
            options,
            regressionReasons,
            workloads
        });

        await Deno.mkdir(dirname(options.out), { recursive: true });
        await Deno.writeTextFile(options.out, `${JSON.stringify(artifact, null, 2)}\n`);
        console.log(`Wrote ${options.out}`);
    }
    finally {
        await Promise.allSettled([
            adminSql.end({ timeout: 5 }),
            ...serviceSql.map((sql) => sql.end({ timeout: 5 }))
        ]);
    }
}

async function runWorkloadPhase(input: {
    adminSql: Sql;
    serviceSql: readonly Sql[];
    runId: string;
    workload: (typeof WORKLOADS)[number];
    phaseLabel: string;
    runIndex: number;
    measured: boolean;
    concurrency: number;
}): Promise<RunSample> {
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
    const lockSampler = startStateWriteLockWaitSampler(input.adminSql, `${input.runId}-service-`);
    const rawCommands: StateWriteBenchmarkCommand[] = [];
    const startedAt = performance.now();

    try {
        for (const kind of MUTATION_MIX) {
            const phaseCommands = commands.filter((command) => command.kind === kind);
            const phaseResults = await mapWithConcurrency(
                phaseCommands,
                input.concurrency,
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
    }
    catch (error) {
        await rethrowAfterCleanup(error, lockSampler.stop);
    }

    const durationMs = performance.now() - startedAt;
    const lockWaitMs = await lockSampler.stop();
    const cpu = process.cpuUsage(cpuBefore);
    const postgresAfter = await readStateWritePostgresCounters(input.adminSql);
    const walBytes = await readStateWriteWalDifference({
        sql: input.adminSql,
        before: postgresBefore.walLsn,
        after: postgresAfter.walLsn
    });
    const queriedDurable = await queryStateWriteDurableEvidence({
        sql: input.adminSql,
        scope,
        commands: rawCommands,
        groupCount: input.workload.groups,
        timingEvents: context.timingEvents
    });
    const durable: StateWriteDurableEvidence = {
        ...queriedDurable,
        atomicCompletionFailures: countAtomicCompletionFailures(rawCommands, queriedDurable)
    };
    const attemptObservations = deriveAppInboxAttemptObservations(
        context.attemptReleases,
        durable.appInbox,
        rawCommands
    );
    const accepted = rawCommands.filter((command) => command.status === 'accepted').length;
    const attempts = attemptObservations.length;
    const outcomes: OutcomeMetrics = {
        accepted,
        conflicted: attemptObservations.filter((entry) => entry.outcome === 'conflicted').length,
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
        runIndex: input.runIndex,
        durationMs,
        throughputPerSecond: accepted / (durationMs / 1_000),
        latencySamplesMs,
        latencyMs: summarizeLatency(latencySamplesMs),
        outcomes: {
            ...outcomes,
            attemptsPerAcceptedMutation: accepted === 0 ? attempts : attempts / accepted
        },
        sql: {
            statements: context.sql.statements,
            rowsRead: context.sql.rowsRead,
            serializedResultBytes: context.sql.serializedResultBytes
        },
        postgres: {
            transactionDurationMs: context.sql.transactionDurationMs,
            lockWaitMs,
            cpuTimeMs: (cpu.user + cpu.system) / 1_000,
            sharedBufferHits: nonNegativeDelta(
                postgresAfter.sharedBufferHits,
                postgresBefore.sharedBufferHits
            ),
            sharedBufferReads: nonNegativeDelta(
                postgresAfter.sharedBufferReads,
                postgresBefore.sharedBufferReads
            ),
            walBytes
        },
        timingsMs: {
            read: stateWriteProductionPhaseDuration(context.timingEvents, 'read'),
            compute: stateWriteProductionPhaseDuration(context.timingEvents, 'compute'),
            validate: stateWriteProductionPhaseDuration(context.timingEvents, 'validate'),
            write: stateWriteProductionPhaseDuration(context.timingEvents, 'write'),
            transaction: stateWriteProductionPhaseDuration(context.timingEvents, 'transaction'),
            outbox: context.sql.outboxSqlMs
        },
        correctness,
        commands: rawCommands,
        attemptObservations,
        stackCommandCounts,
        durableEvidence: durable
    };
    return sample;
}

export async function rethrowAfterCleanup<Failure, CleanupResult>(
    error: Failure,
    cleanup: () => Promise<CleanupResult>
): Promise<never> {
    try {
        await cleanup();
    }
    catch (cleanupError) {
        console.error('State-write benchmark cleanup failed after command failure', cleanupError);
    }
    throw error;
}
export function createInstrumentedSql(
    sql: PSqlSql,
    context: StateWriteServiceRuntimeContext,
    timing: RallarTimingSink
): PSqlSql {
    return createInstrumentedStateWriteSql({ sql, metrics: context.sql, timing });
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

async function executeMutation({
    runtime,
    scope,
    kind,
    command
}: ExecuteMutationInput): Promise<void> {
    const clientContextId = toAuthenticatedClientMutationContextId({
        scope,
        principalId: command.principalId,
        callerClientId: command.clientAuthority.clientId,
        callerSessionId: command.clientAuthority.sessionId
    });
    const groupContextId = toStateWriteBenchmarkGroupContextId(scope, command.groupId);
    switch (kind) {
        case 'profile-instance': {
            await runAppInboxMutation(runtime, () =>
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
                ));
            await runAppInboxMutation(runtime, () =>
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
                ));
            return;
        }
        case 'membership': {
            await runAppInboxMutation(runtime, () =>
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
                ));
            return;
        }
        case 'presence-connect': {
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
            return;
        }
        case 'presence-heartbeat': {
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
            return;
        }
        case 'presence-disconnect': {
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
            return;
        }
        case 'config': {
            await runAppInboxMutation(runtime, () =>
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
                ));
            return;
        }
        case 'topology-source': {
            const data = await toTopologyAppInboxCommand({
                actor: { principalId: command.ownerId, sessionId: command.ownerAuthority.sessionId },
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
            await runAppInboxMutation(runtime, () =>
                runtime.group.processAuthenticatedTopologyEntryUntilCompletion(
                    {
                        type: AppInboxType.TOPOLOGY_CONFIG_PUT,
                        topicId: AppInboxType.TOPOLOGY_CONFIG_PUT,
                        resourceId: command.requestId,
                        contextId: groupContextId,
                        senderId: command.ownerId,
                        data
                    },
                    command.ownerAuthority
                ));
            return;
        }
    }
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

async function runGroupPresenceMutation(input: RunGroupPresenceMutationInput): Promise<void> {
    await runAppInboxMutation(input.runtime, () =>
        input.runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            toGroupPresenceEnqueue(input),
            input.command.clientAuthority
        ));
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

interface BenchmarkMutationOutcome {
    fold<T>(left: (value: string) => T, right: () => T): T;
}

async function runAppInboxMutation(
    runtime: StateWriteServiceRuntime,
    start: () => Promise<BenchmarkMutationOutcome>
): Promise<void> {
    let settled = false;
    const pending = start().finally(() => (settled = true));
    while (!settled) {
        await runtime.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, runtime.resilience);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const result = await pending;
    result.fold(
        (error) => {
            throw new Error(error);
        },
        () => undefined
    );
}

async function seedCompleteState(
    sql: Sql,
    scope: StateScope,
    workload: (typeof WORKLOADS)[number]
): Promise<void> {
    const pgSql = toPSqlSql(sql);
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
        async (groupIndex) => {
            const ownerId = `owner-${groupIndex}`;
            const authority = createBenchmarkAuthSession(scope, ownerId, `owner-session-${groupIndex}`);
            await authSessionRepository.putSession(authority);
            const groupId = `group-${groupIndex}`;
            await runAppInboxMutation(runtime, () =>
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
                ));
        }
    );

    await mapWithConcurrency(
        Array.from({ length: workload.clients }, (_, clientIndex) => clientIndex),
        STATE_WRITE_REQUIRED_CONCURRENCY,
        async (clientIndex) => {
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
            await runAppInboxMutation(runtime, () =>
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
                ));
            await runAppInboxMutation(runtime, () =>
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
                ));
        }
    );
}

function createCommands(workload: (typeof WORKLOADS)[number]): MutationCommand[] {
    return MUTATION_MIX.flatMap((kind) =>
        Array.from({ length: workload.clients }, (_, clientIndex) => ({
            kind,
            clientIndex,
            groupIndex: clientIndex % workload.groups
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

function deriveCorrectness(
    commands: readonly StateWriteBenchmarkCommand[],
    durable: StateWriteDurableEvidence
): CorrectnessMetrics {
    const requiredOutboxIntentCount = sum(
        commands.map((command) =>
            command.status === 'accepted'
                ? PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].length
                : 0
        )
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

function countAtomicCompletionFailures(
    commands: readonly StateWriteBenchmarkCommand[],
    durable: Pick<StateWriteDurableEvidence, 'appInbox' | 'receipts' | 'resourceOutbox'>
): number {
    return commands
        .filter((command) => command.status === 'accepted')
        .filter((command) => {
            const expectedOperations = command.kind === 'profile-instance' ? ['instance', 'profile'] : ['command'];
            const completed = durable.appInbox
                .filter(
                    (entry) =>
                        entry.commandId === command.commandId &&
                        entry.status === 'COMPLETED' &&
                        entry.resultStatus === 'COMPLETED'
                )
                .map((entry) => entry.operationId)
                .toSorted();
            const receipt = durable.receipts.find((entry) => entry.commandId === command.commandId);
            const expectedEffects = [
                ...PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind]
            ].toSorted();
            const actualEffects = durable.resourceOutbox
                .filter((entry) => entry.commandId === command.commandId)
                .map((entry) => entry.effectKind)
                .toSorted();
            return (
                JSON.stringify(completed) !== JSON.stringify(expectedOperations) ||
                !receipt ||
                JSON.stringify(actualEffects) !== JSON.stringify(expectedEffects)
            );
        }).length;
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
            attemptsPerAcceptedMutation: accepted === 0 ? attempts : attempts / accepted
        },
        sql: medianSqlMetrics(samples),
        postgres: medianPostgresMetrics(samples),
        timingsMs: medianTimingMetrics(samples),
        correctness: {
            acceptedCommandCount: sum(samples.map((sample) => sample.correctness.acceptedCommandCount)),
            receiptCount: sum(samples.map((sample) => sample.correctness.receiptCount)),
            effectfulCommandCount: sum(samples.map((sample) => sample.correctness.effectfulCommandCount)),
            requiredOutboxIntentCount: sum(
                samples.map((sample) => sample.correctness.requiredOutboxIntentCount)
            ),
            outboxIntentCount: sum(samples.map((sample) => sample.correctness.outboxIntentCount)),
            atomicCompletionFailures: sum(
                samples.map((sample) => sample.correctness.atomicCompletionFailures)
            ),
            dbwFindings: [...new Set(samples.flatMap((sample) => sample.correctness.dbwFindings))]
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

function percentile(samples: readonly number[], percentileValue: number): number {
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
        serializedResultBytes: median(samples.map((sample) => sample.sql.serializedResultBytes))
    };
}

function medianPostgresMetrics(samples: readonly RunSample[]): PostgresArtifactMetrics {
    return {
        transactionDurationMs: median(samples.map((sample) => sample.postgres.transactionDurationMs)),
        lockWaitMs: median(samples.map((sample) => sample.postgres.lockWaitMs)),
        cpuTimeMs: median(samples.map((sample) => sample.postgres.cpuTimeMs)),
        sharedBufferHits: median(samples.map((sample) => sample.postgres.sharedBufferHits)),
        sharedBufferReads: median(samples.map((sample) => sample.postgres.sharedBufferReads)),
        walBytes: median(samples.map((sample) => sample.postgres.walBytes))
    };
}

function medianTimingMetrics(samples: readonly RunSample[]): TimingArtifactMetrics {
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
