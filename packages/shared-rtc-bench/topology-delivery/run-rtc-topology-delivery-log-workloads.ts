import type {
    RtcTopologyDeliveryAppendInput,
    RtcTopologyDeliveryAppendResult
} from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-contracts.ts';
import { isRtcTopologyDeliveryRetryableConflict } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-validation.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts';
import {
    RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY,
    summarizeRtcTopologyDeliveryLatencies,
    type BenchmarkSql,
    type WorkloadResult,
    type WorkloadVerification
} from './delivery-log-benchmark-contracts.ts';

const MAX_TRANSACTION_ATTEMPTS = 1_000;

interface WorkloadExecution {
    readonly latenciesMs: readonly number[];
    readonly transactionRetries: number;
}

interface BuildResultInput {
    readonly database: BenchmarkSql;
    readonly name: string;
    readonly streams: readonly string[];
    readonly operationCount: number;
    readonly startedAt: number;
    readonly execution: WorkloadExecution;
    readonly expectedRows: number;
}

interface RetryDuplicateLoserInput {
    readonly database: BenchmarkSql;
    readonly repository: PSqlRtcTopologyDeliveryRepository;
    readonly append: RtcTopologyDeliveryAppendInput;
    readonly firstAttempt: Promise<RtcTopologyDeliveryAppendResult>;
}

interface RegisterRtcTopologyDeliveryBenchmarkStreamsInput {
    readonly streams: readonly string[];
    readonly register: (streamId: string) => Promise<string>;
    readonly cleanup: (streamIds: readonly string[]) => Promise<void>;
}

export async function runRtcTopologyDeliveryLogWorkloads(
    database: BenchmarkSql
): Promise<readonly WorkloadResult[]> {
    return [
        await runAppendWorkload(database, 'one-stream-contention', 1),
        await runAppendWorkload(database, 'three-stream-independent', 3),
        await runDuplicatePublicationRace(database),
        await runRollbackWorkload(database)
    ];
}

async function runAppendWorkload(
    database: BenchmarkSql,
    name: string,
    streamCount: number
): Promise<WorkloadResult> {
    const repository = new PSqlRtcTopologyDeliveryRepository(database);
    const streams = Array.from({ length: streamCount }, () => crypto.randomUUID());
    await registerStreams(database, repository, streams);
    const applicationId = `delivery-bench-${name}-${crypto.randomUUID()}`;
    const startedAt = performance.now();
    try {
        const execution = await executeConcurrently(
            RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.appendCount,
            async (index) => {
                const streamId = streams[index % streams.length]!;
                return await appendWithRetry(
                    database,
                    repository,
                    appendInput(streamId, applicationId, `${name}-${index}`)
                );
            }
        );
        return await buildResult({
            database,
            name,
            streams,
            operationCount: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.appendCount,
            startedAt,
            execution,
            expectedRows: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.appendCount
        });
    }
    finally {
        await cleanupStreams(database, streams);
    }
}

async function runDuplicatePublicationRace(database: BenchmarkSql): Promise<WorkloadResult> {
    const name = 'duplicate-publication-race';
    const repository = new PSqlRtcTopologyDeliveryRepository(database);
    const streams = [crypto.randomUUID(), crypto.randomUUID()];
    await registerStreams(database, repository, streams);
    const applicationId = `delivery-bench-${name}-${crypto.randomUUID()}`;
    const latenciesMs: number[] = [];
    let transactionRetries = 0;
    const startedAt = performance.now();
    try {
        for (
            let index = 0;
            index < RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.duplicateRaceCount;
            index += 1
        ) {
            const winnerInput = appendInput(streams[0]!, applicationId, `${name}-${index}`);
            const loserInput = { ...winnerInput, publisherStreamId: streams[1]! };
            const winnerAppended = deferred<void>();
            const releaseWinner = deferred<void>();
            const operationStartedAt = performance.now();
            const winner = database.begin(async (transaction) => {
                const result = await repository.appendOrValidate(transaction, winnerInput);
                winnerAppended.resolve();
                await releaseWinner.promise;
                return result;
            });
            await winnerAppended.promise;
            const loser = database.begin(
                async (transaction) => await repository.appendOrValidate(transaction, loserInput)
            );
            await new Promise((resolve) => setTimeout(resolve, 2));
            releaseWinner.resolve();
            requireAppended(await winner, name);
            const loserResult = await retryDuplicateLoser({
                database,
                repository,
                append: loserInput,
                firstAttempt: loser
            });
            transactionRetries += loserResult.retries;
            latenciesMs.push(performance.now() - operationStartedAt);
        }
        return await buildResult({
            database,
            name,
            streams,
            operationCount: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.duplicateRaceCount,
            startedAt,
            execution: { latenciesMs, transactionRetries },
            expectedRows: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.duplicateRaceCount
        });
    }
    finally {
        await cleanupStreams(database, streams);
    }
}

async function runRollbackWorkload(database: BenchmarkSql): Promise<WorkloadResult> {
    const name = 'surrounding-transaction-rollback';
    const repository = new PSqlRtcTopologyDeliveryRepository(database);
    const streams = [crypto.randomUUID()];
    await registerStreams(database, repository, streams);
    const applicationId = `delivery-bench-${name}-${crypto.randomUUID()}`;
    const startedAt = performance.now();
    try {
        const execution = await executeConcurrently(
            RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.rollbackCount,
            async (index) => {
                const operationStartedAt = performance.now();
                try {
                    await database.begin(async (transaction) => {
                        requireAppended(
                            await repository.appendOrValidate(
                                transaction,
                                appendInput(streams[0]!, applicationId, `${name}-${index}`)
                            ),
                            name
                        );
                        throw new IntentionalRollbackError();
                    });
                }
                catch (error) {
                    if (!(error instanceof IntentionalRollbackError)) {
                        throw error;
                    }
                }
                return { latencyMs: performance.now() - operationStartedAt, retries: 0 };
            }
        );
        return await buildResult({
            database,
            name,
            streams,
            operationCount: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.rollbackCount,
            startedAt,
            execution,
            expectedRows: 0
        });
    }
    finally {
        await cleanupStreams(database, streams);
    }
}

async function buildResult(input: BuildResultInput): Promise<WorkloadResult> {
    const durationMs = performance.now() - input.startedAt;
    const verification = await verifyStreams(input.database, input.streams);
    if (
        !verification.contiguous ||
        verification.rowCount !== input.expectedRows ||
        verification.headCount !== input.expectedRows
    ) {
        throw new Error(`RTC topology delivery benchmark ${input.name} failed verification`);
    }
    return {
        name: input.name,
        streamCount: input.streams.length,
        operationCount: input.operationCount,
        durationMs,
        throughputPerSecond: input.operationCount / (durationMs / 1_000),
        latencyMs: summarizeRtcTopologyDeliveryLatencies(input.execution.latenciesMs),
        transactionRetries: input.execution.transactionRetries,
        verification
    };
}

async function executeConcurrently(
    operationCount: number,
    operation: (index: number) => Promise<Readonly<{ latencyMs: number; retries: number; }>>
): Promise<WorkloadExecution> {
    let nextIndex = 0;
    const results = await Promise.all(
        Array.from({ length: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.concurrency }, async () => {
            const workerResults: Array<Readonly<{ latencyMs: number; retries: number; }>> = [];
            while (nextIndex < operationCount) {
                const index = nextIndex;
                nextIndex += 1;
                workerResults.push(await operation(index));
            }
            return workerResults;
        })
    );
    const flattened = results.flat();
    return {
        latenciesMs: flattened.map((result) => result.latencyMs),
        transactionRetries: flattened.reduce((sum, result) => sum + result.retries, 0)
    };
}

async function appendWithRetry(
    database: BenchmarkSql,
    repository: PSqlRtcTopologyDeliveryRepository,
    input: RtcTopologyDeliveryAppendInput
): Promise<Readonly<{ latencyMs: number; retries: number; }>> {
    const startedAt = performance.now();
    let retries = 0;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
        const result = await database.begin(
            async (transaction) => await repository.appendOrValidate(transaction, input)
        );
        if (result.status === 'conflict') {
            retries += 1;
            continue;
        }
        requireAppended(result, 'append');
        return { latencyMs: performance.now() - startedAt, retries };
    }
    throw new Error('RTC topology delivery benchmark exhausted transaction retries');
}

async function retryDuplicateLoser(
    input: RetryDuplicateLoserInput
): Promise<Readonly<{ retries: number; }>> {
    try {
        const result = await input.firstAttempt;
        if (result.status !== 'existing') {
            throw new Error('Duplicate topology publication did not resolve to the canonical row');
        }
        return { retries: 0 };
    }
    catch (error) {
        if (!(error instanceof Error) || !isRtcTopologyDeliveryRetryableConflict(error)) {
            throw error;
        }
        const retry = await input.database.begin(
            async (transaction) => await input.repository.appendOrValidate(transaction, input.append)
        );
        if (retry.status !== 'existing') {
            throw new Error('Duplicate topology publication retry did not load the canonical row');
        }
        return { retries: 1 };
    }
}

async function registerStreams(
    database: BenchmarkSql,
    repository: PSqlRtcTopologyDeliveryRepository,
    streams: readonly string[]
): Promise<void> {
    return registerRtcTopologyDeliveryBenchmarkStreams({
        streams,
        register: async (streamId) =>
            (
                await repository.registerStream({
                    streamId,
                    leaseDurationMs: RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.leaseDurationMs
                })
            ).status,
        cleanup: (registered) => cleanupStreams(database, registered)
    });
}

export async function registerRtcTopologyDeliveryBenchmarkStreams(
    input: RegisterRtcTopologyDeliveryBenchmarkStreamsInput
): Promise<void> {
    const registered: string[] = [];
    try {
        for (const streamId of input.streams) {
            const status = await input.register(streamId);
            if (status !== 'registered') {
                throw new Error(`RTC topology delivery benchmark stream collision: ${streamId}`);
            }
            registered.push(streamId);
        }
    }
    catch (registrationFailure) {
        try {
            await input.cleanup(registered);
        }
        catch (cleanupFailure) {
            throw new AggregateError(
                [registrationFailure, cleanupFailure],
                'RTC topology delivery benchmark registration and cleanup failed'
            );
        }
        throw registrationFailure;
    }
}

function appendInput(
    publisherStreamId: string,
    applicationId: string,
    publicationId: string
): RtcTopologyDeliveryAppendInput {
    return {
        publisherStreamId,
        groupRef: { applicationId, workspaceId: 'performance', groupId: 'room' },
        publicationId,
        outboxKey: {
            topicId: 'rtc-topology-publication',
            resourceId: publicationId,
            contextId: 'performance:room'
        },
        retainUntilEpochMs: Date.now() + RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY.retentionMs
    };
}

async function verifyStreams(
    database: BenchmarkSql,
    streams: readonly string[]
): Promise<WorkloadVerification> {
    const heads = await database<Readonly<{ stream_id: string; head_sequence: number; }>[]>`
    select stream_id::text, head_sequence::integer as head_sequence
    from rtc_topology_delivery_stream
    where stream_id = any(${streams}::uuid[])
    order by stream_id
  `;
    const entries = await database<Readonly<{ stream_id: string; sequence: number; }>[]>`
    select publisher_stream_id::text as stream_id, sequence::integer as sequence
    from rtc_topology_delivery_log
    where publisher_stream_id = any(${streams}::uuid[])
    order by publisher_stream_id, sequence
  `;
    const streamHeads = Object.fromEntries(heads.map((row) => [row.stream_id, row.head_sequence]));
    const contiguous = heads.every((head) => {
        const sequences = entries
            .filter((entry) => entry.stream_id === head.stream_id)
            .map((entry) => entry.sequence);
        return (
            sequences.length === head.head_sequence &&
            sequences.every((sequence, index) => sequence === index + 1)
        );
    });
    return {
        rowCount: entries.length,
        headCount: heads.reduce((sum, row) => sum + row.head_sequence, 0),
        contiguous,
        streamHeads
    };
}

async function cleanupStreams(database: BenchmarkSql, streams: readonly string[]): Promise<void> {
    await database`
    delete from rtc_topology_delivery_log
    where publisher_stream_id = any(${streams}::uuid[])
  `;
    await database`
    delete from rtc_topology_delivery_stream
    where stream_id = any(${streams}::uuid[])
  `;
}

function requireAppended(result: RtcTopologyDeliveryAppendResult, workload: string): void {
    if (result.status !== 'appended') {
        throw new Error(`RTC topology delivery benchmark ${workload} did not append`);
    }
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void; }> {
    let resolve = (_value: T): void => undefined;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

class IntentionalRollbackError extends Error {}
