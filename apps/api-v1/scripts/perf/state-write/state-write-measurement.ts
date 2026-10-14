import {
    deriveAppInboxAttemptObservations,
    type AppInboxAttemptObservation
} from '../api-v1-state-write-attempt-evidence.ts';
import type { StateWriteDurableEvidence } from '../api-v1-state-write-durable-evidence.ts';
import {
    PRODUCTION_STATE_WRITE_MUTATION_CONTRACT,
    requiredStateWriteOutboxCount
} from '../api-v1-state-write-outbox-contract.mjs';
import {
    stateWriteProductionPhaseDuration,
    type StateWriteSqlMetrics
} from '../create-instrumented-state-write-sql.ts';
import type { StateWriteServiceRuntimeContext } from '../create-state-write-service-runtime.ts';
import type { StateWritePostgresCounters } from '../read-state-write-postgres-counters.ts';
import type { StateWriteBenchmarkCommand } from './state-write-workload.ts';
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
export interface RunSample {
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

export interface WorkloadEvidence {
    readonly postgresAfter: StateWritePostgresCounters;
    readonly walBytes: number;
    readonly durable: StateWriteDurableEvidence;
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

export function computeRunSample(facts: BenchmarkSampleFacts): RunSample {
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

export function summarizeSamples(samples: readonly RunSample[]): WorkloadSummary {
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

export function newRunContext(): StateWriteServiceRuntimeContext {
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
