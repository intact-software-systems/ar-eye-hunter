import { PRODUCTION_STATE_WRITE_MUTATION_CONTRACT, STATE_WRITE_ARTIFACT_SCHEMA_VERSION } from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';
import { binding, durableResult, effectIds } from './state-write-performance-result-fixture.ts';

const MUTATION_MIX = [
    'profile-instance',
    'membership',
    'presence-connect',
    'presence-heartbeat',
    'presence-disconnect',
    'config',
    'topology-source'
] as const;

type StateWriteMutationKind = (typeof MUTATION_MIX)[number];

interface StateWritePerformanceCommand {
    readonly commandId: string;
    readonly kind: StateWriteMutationKind;
}

interface StateWritePerformanceArtifactOverrides {
    readonly artifactId?: string;
    readonly generatedAt?: string;
    readonly gitCommit?: string;
    readonly measuredRuns?: number;
}

export function createStateWritePerformanceArtifact(
    overrides: StateWritePerformanceArtifactOverrides = {}
): any {
    const measuredRuns = overrides.measuredRuns ?? 3;
    const artifactId = overrides.artifactId ?? 'run';
    const workloads = [
        createWorkload({ name: 'uncontended', groups: 100, measuredRuns, artifactId }),
        createWorkload({ name: 'shared', groups: 5, measuredRuns, artifactId }),
        createWorkload({ name: 'hot', groups: 1, measuredRuns, artifactId })
    ];
    return {
        schemaVersion: STATE_WRITE_ARTIFACT_SCHEMA_VERSION,
        gitCommit: overrides.gitCommit ?? '4a0232d7b49b94b713459549c7bbb715e7e4842c',
        backend: 'postgres',
        generatedAt: overrides.generatedAt ?? '2026-07-27T00:00:00.000Z',
        measurement: {
            warmupRuns: 1,
            measuredRuns,
            concurrency: 10,
            mutationTimingExcludes: ['setup', 'auth-session insertion', 'http', 'evidence queries'],
            tailSamplesDiscarded: false,
            counterSources: createCounterSources()
        },
        regressionReasons: [],
        workloads
    };
}

interface CreateWorkloadInput {
    readonly name: string;
    readonly groups: number;
    readonly measuredRuns: number;
    readonly artifactId: string;
}

function createWorkload(input: CreateWorkloadInput): any {
    const { name, groups, measuredRuns, artifactId } = input;
    const samples = Array.from({ length: measuredRuns }, (_, index) => createSample(index, artifactId));
    const workload = {
        name,
        scale: { clients: 100, groups, concurrency: 10 },
        mutationMix: [...MUTATION_MIX],
        warmupRuns: 1,
        measuredRuns,
        samples,
        summary: {}
    };
    refreshStateWritePerformanceWorkload(workload);
    return workload;
}

function createSample(runIndex: number, artifactId: string): any {
    const commands = MUTATION_MIX.flatMap((kind) =>
        Array.from({ length: 100 }, (_, ordinal) => ({
            commandId: `${artifactId}-${runIndex}:${kind}:${ordinal}`,
            kind,
            latencyMs: (ordinal % 7) + 1,
            stackIndex: ordinal % 2,
            status: 'accepted'
        }))
    );
    const latencySamplesMs = commands.map((command) => command.latencyMs);
    const evidence = createFinalEvidence(commands);
    const attemptObservations = createAttemptObservations(evidence);
    const required = evidence.resourceOutbox.length;
    return {
        runIndex,
        durationMs: 100,
        throughputPerSecond: 7000,
        latencySamplesMs,
        latencyMs: toPercentiles(latencySamplesMs),
        commands,
        attemptObservations,
        stackCommandCounts: [350, 350],
        durableEvidence: evidence,
        outcomes: {
            accepted: 700,
            conflicted: 0,
            transientRetries: 0,
            exhausted: 0,
            attempts: 800,
            attemptsPerAcceptedMutation: 800 / 700
        },
        sql: { statements: 20, rowsRead: 10, serializedResultBytes: 1000 },
        postgres: {
            transactionDurationMs: 80,
            lockWaitMs: 0,
            cpuTimeMs: 30,
            sharedBufferHits: 100,
            sharedBufferReads: 2,
            walBytes: 4096
        },
        timingsMs: { read: 20, compute: 0, validate: 0, write: 40, transaction: 80, outbox: 10 },
        correctness: {
            acceptedCommandCount: 700,
            receiptCount: 700,
            effectfulCommandCount: 700,
            requiredOutboxIntentCount: required,
            outboxIntentCount: required,
            atomicCompletionFailures: 0,
            dbwFindings: []
        }
    };
}

function createAttemptObservations(evidence: any): any[] {
    return evidence.appInbox.flatMap((entry: any) =>
        Array.from({ length: entry.attempts }, (_, index) => ({
            commandId: entry.commandId,
            operationId: entry.operationId,
            attempt: index + 1,
            outcome: index + 1 === entry.attempts ? 'accepted' : 'conflicted',
            terminal: index + 1 === entry.attempts,
            source: 'resource_inbox.release.telemetry',
            retryDelayMs: 0,
            dueAgeMs: 0,
            selectedLane: 'fast',
            failure: index + 1 === entry.attempts
                ? { kind: 'none' }
                : { kind: 'retryable', code: 'runtime-state-write-conflict', name: 'Error' }
        }))
    );
}

function createFinalEvidence(commands: readonly StateWritePerformanceCommand[]): any {
    const appInbox = commands.flatMap((command) =>
        operationIds(command).map((operationId) => ({
            commandId: command.commandId,
            operationId,
            resourceId: `${command.commandId}:${operationId}`,
            topicId: 'app-inbox.state',
            status: 'COMPLETED',
            resultStatus: 'COMPLETED',
            attempts: 1,
            commandType: command.kind === 'profile-instance'
                ? 'CLIENT_INSTANCE_UPSERT'
                : command.kind === 'topology-source'
                ? 'TOPOLOGY_CONFIG_PUT'
                : command.kind.startsWith('presence-')
                ? 'GROUP_PRESENCE_CONNECT'
                : 'GROUP_MEMBER_UPSERT',
            durableResult: durableResult(command, operationId),
            retryDelayMs: 0,
            dueAgeMs: 0,
            selectedLane: 'fast',
            transactionDurationMs: 1
        }))
    );
    const receipts = commands.map((command) => ({
        commandId: command.commandId,
        receiptIds: command.kind === 'profile-instance'
            ? operationIds(command).map((operationId) => `${command.commandId}-${operationId}`)
            : [command.commandId],
        outboxIds: effectIds(command),
        identityKind: command.kind === 'topology-source' ? 'logical-msg-id' : 'physical-resource-id',
        resultBindings: operationIds(command).map((operationId) => binding(command, operationId))
    }));
    const resourceOutbox = commands.flatMap((command) =>
        PRODUCTION_STATE_WRITE_MUTATION_CONTRACT[command.kind].map((effectKind, index) => ({
            effectId: effectIds(command)[index],
            resourceId: effectIds(command)[index],
            outboxId: effectIds(command)[index],
            commandId: command.commandId,
            effectKind,
            typeId: effectKind.startsWith('principal-state') ? 'WS_OUTBOX' : 'APP_OUTBOX',
            topicId: effectKind
        }))
    );
    return {
        appInbox,
        receipts,
        resourceOutbox,
        intermediateMutationIntents: [],
        atomicCompletionFailures: 0
    };
}

function operationIds(command: any): string[] {
    return command.kind === 'profile-instance' ? ['profile', 'instance'] : ['command'];
}

export function refreshStateWritePerformanceWorkload(workload: any): void {
    const samples = workload.samples;
    for (const sample of samples) {
        const attempts = sample.attemptObservations.length;
        sample.outcomes = {
            accepted: 700,
            conflicted: countAttempts(sample, 'conflicted'),
            transientRetries: countAttempts(sample, 'transient-retry'),
            exhausted: 0,
            attempts,
            attemptsPerAcceptedMutation: attempts / 700
        };
    }
    workload.summary = createSummary(samples);
}

function createSummary(samples: any[]): any {
    const accepted = 700 * samples.length;
    const attempts = sum(samples.map((sample) => sample.attemptObservations.length));
    return {
        latencyMs: toPercentiles(samples.flatMap((sample) => sample.latencySamplesMs)),
        throughputPerSecond: accepted / (sum(samples.map((sample) => sample.durationMs)) / 1000),
        outcomes: {
            accepted,
            conflicted: sum(samples.map((sample) => countAttempts(sample, 'conflicted'))),
            transientRetries: sum(samples.map((sample) => countAttempts(sample, 'transient-retry'))),
            exhausted: 0,
            attempts,
            attemptsPerAcceptedMutation: attempts / accepted
        },
        sql: { ...samples[0].sql },
        postgres: { ...samples[0].postgres },
        timingsMs: { ...samples[0].timingsMs },
        correctness: {
            acceptedCommandCount: accepted,
            receiptCount: sum(samples.map((sample) => sample.correctness.receiptCount)),
            effectfulCommandCount: sum(samples.map((sample) => sample.correctness.effectfulCommandCount)),
            requiredOutboxIntentCount: sum(
                samples.map((sample) => sample.correctness.requiredOutboxIntentCount)
            ),
            outboxIntentCount: sum(samples.map((sample) => sample.correctness.outboxIntentCount)),
            atomicCompletionFailures: 0,
            dbwFindings: []
        }
    };
}

function countAttempts(sample: any, outcome: string): number {
    return sample.attemptObservations.filter((attempt: any) => attempt.outcome === outcome).length;
}

function toPercentiles(values: number[]): { p50: number; p95: number; p99: number; } {
    const sorted = [...values].sort((left, right) => left - right);
    const at = (ratio: number) => sorted[Math.ceil(sorted.length * ratio) - 1];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function createCounterSources(): Record<string, string> {
    return {
        sql: 'instrumented postgres.js',
        rowsRead: 'returned SQL rows',
        serializedResultBytes: 'JSON bytes',
        transactionDuration: 'AppInbox transaction wall duration',
        lockWait: 'pg_stat_activity',
        cpu: 'process CPU',
        sharedBuffers: 'pg_stat_database',
        wal: 'pg WAL LSN',
        readTiming: 'AppInbox read phase',
        computeTiming: 'AppInbox compute phase',
        validateTiming: 'AppInbox validate phase',
        writeTiming: 'AppInbox write phase',
        outboxTiming: 'ResourceInbox SQL',
        attempts: 'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation',
        receipts: 'same-observation mutation receipts',
        outboxIntents: 'ResourceInbox effect disclosure',
        outbox: 'resource_inbox'
    };
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
