import { dirname } from 'node:path';

import type { RtcTopologyDeliveryLogEntry } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-contracts.ts';
import type {
    RtcTopologyReplayConsumerInput,
    RtcTopologyReplayCursorCasInput,
    RtcTopologyReplayCursorSnapshot,
    RtcTopologyReplayPageInput,
    RtcTopologyReplayPageResult
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-contracts.ts';
import {
    RTC_TOPOLOGY_REPLAY_ANTI_ENTROPY_INTERVAL_MS,
    RTC_TOPOLOGY_REPLAY_MAX_ENTRIES_PER_TURN,
    RTC_TOPOLOGY_REPLAY_MAX_PAGES_PER_TURN,
    RTC_TOPOLOGY_REPLAY_PAGE_SIZE
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-policy.ts';
import {
    RtcTopologyReplayService,
    type RtcTopologyReplayEntryHandlingResult,
    type RtcTopologyReplayPort,
    type RtcTopologyReplayServiceScheduler
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-service.ts';

export const RTC_TOPOLOGY_REPLAY_DRAIN_WORKLOAD_POLICY = {
    pageSize: RTC_TOPOLOGY_REPLAY_PAGE_SIZE,
    maxPagesPerTurn: RTC_TOPOLOGY_REPLAY_MAX_PAGES_PER_TURN,
    maxEntriesPerTurn: RTC_TOPOLOGY_REPLAY_MAX_ENTRIES_PER_TURN,
    entryCounts: [100, 1_000]
} as const;

const STREAM_ID = '00000000-0000-4000-8000-000000000001';

export interface RtcTopologyReplayDrainOperationCounts {
    readonly discoveryReads: number;
    readonly pageReads: number;
    readonly handledEntries: number;
    readonly cursorWrites: number;
    readonly hydrationRuns: number;
    readonly yieldedTurns: number;
}

type WorkloadName = 'caughtUp' | 'entries100' | 'entries1000' | 'noRecipient' | 'currentRepair' | 'gapHydration';

export interface RtcTopologyReplayDrainOperationArtifact {
    readonly schema: 'rallar.rtc-topology.replay-drain-operation-counts.v1';
    readonly workloads: Readonly<Record<WorkloadName, RtcTopologyReplayDrainOperationCounts>>;
}

export async function runRtcTopologyReplayDrainOperationWorkloads(): Promise<RtcTopologyReplayDrainOperationArtifact> {
    const workloads = {
        caughtUp: await runWorkload({ entryCount: 0, outcome: 'delivered' }),
        entries100: await runWorkload({ entryCount: 100, outcome: 'delivered' }),
        entries1000: await runWorkload({ entryCount: 1_000, outcome: 'delivered' }),
        noRecipient: await runWorkload({ entryCount: 100, outcome: 'no-local-recipient' }),
        currentRepair: await runWorkload({ entryCount: 100, outcome: 'current-repair' }),
        gapHydration: await runWorkload({ entryCount: 0, outcome: 'delivered', gap: true })
    } satisfies Record<WorkloadName, RtcTopologyReplayDrainOperationCounts>;
    return {
        schema: 'rallar.rtc-topology.replay-drain-operation-counts.v1',
        workloads
    };
}

interface WorkloadInput {
    readonly entryCount: number;
    readonly outcome: RtcTopologyReplayEntryHandlingResult['status'];
    readonly gap?: boolean;
}

async function runWorkload(input: WorkloadInput): Promise<RtcTopologyReplayDrainOperationCounts> {
    const operations = mutableCounts();
    const repository = new OperationCountingReplayRepository(operations);
    const scheduler = operationCountingScheduler(operations);
    const service = new RtcTopologyReplayService({
        consumerStreamId: STREAM_ID,
        repository,
        scheduler,
        entryHandler: {
            handle: async () => {
                operations.handledEntries += 1;
                return { status: input.outcome };
            }
        },
        hydrateGap: async () => {
            operations.hydrationRuns += 1;
        },
        policy: {
            antiEntropyIntervalMs: RTC_TOPOLOGY_REPLAY_ANTI_ENTROPY_INTERVAL_MS,
            pageSize: RTC_TOPOLOGY_REPLAY_DRAIN_WORKLOAD_POLICY.pageSize,
            maxPagesPerTurn: RTC_TOPOLOGY_REPLAY_DRAIN_WORKLOAD_POLICY.maxPagesPerTurn,
            maxEntriesPerTurn: RTC_TOPOLOGY_REPLAY_DRAIN_WORKLOAD_POLICY.maxEntriesPerTurn
        },
        onHealthFailure: (error) => {
            throw error;
        }
    });
    return executeRtcTopologyReplayServiceLifecycle(service, async () => {
        resetCounts(operations);
        if (input.gap) {
            repository.installGap();
        }
        else {
            repository.publish(input.entryCount);
        }

        service.wake('poll');
        await service.whenIdle();
        return { ...operations };
    });
}

export async function executeRtcTopologyReplayServiceLifecycle<Result>(
    service: Pick<RtcTopologyReplayService, 'start' | 'stop'>,
    execute: () => Promise<Result>
): Promise<Result> {
    let executionFailed = false;
    let executionFailure = new Error('RTC topology replay workload failed before cleanup');
    try {
        await service.start();
        return await execute();
    }
    catch (error) {
        executionFailed = true;
        executionFailure = error instanceof Error ? error : new Error(String(error));
        throw error;
    }
    finally {
        try {
            await service.stop();
        }
        catch (cleanupFailure) {
            if (executionFailed) {
                throw new AggregateError(
                    [executionFailure, cleanupFailure],
                    'RTC topology replay workload execution and cleanup failed'
                );
            }
            throw cleanupFailure;
        }
    }
}

interface MutableOperationCounts {
    discoveryReads: number;
    pageReads: number;
    handledEntries: number;
    cursorWrites: number;
    hydrationRuns: number;
    yieldedTurns: number;
}

class OperationCountingReplayRepository implements RtcTopologyReplayPort {
    readonly #operations: MutableOperationCounts;
    #entries: readonly RtcTopologyDeliveryLogEntry[] = [];
    #cursor = 0;
    #gap = false;

    constructor(operations: MutableOperationCounts) {
        this.#operations = operations;
    }

    initializeConsumer(
        _input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]> {
        return Promise.resolve([this.#snapshot()]);
    }

    discoverPublishers(
        _input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]> {
        this.#operations.discoveryReads += 1;
        return Promise.resolve([this.#snapshot()]);
    }

    capturePage(input: RtcTopologyReplayPageInput): Promise<RtcTopologyReplayPageResult> {
        this.#operations.pageReads += 1;
        const snapshot = this.#snapshot();
        if (this.#gap) {
            return Promise.resolve({
                status: 'gap',
                cursorSequence: this.#cursor,
                retainedFromSequence: 4,
                capturedHeadSequence: snapshot.headSequence,
                databaseNowEpochMs: 1_000
            });
        }
        if (this.#cursor === snapshot.headSequence) {
            return Promise.resolve({
                status: 'caught-up',
                cursorSequence: this.#cursor,
                retainedFromSequence: 1,
                capturedHeadSequence: snapshot.headSequence,
                databaseNowEpochMs: 1_000
            });
        }
        const entries = this.#entries.slice(this.#cursor, this.#cursor + input.pageSize);
        return Promise.resolve({
            status: 'page',
            expectedCursorSequence: this.#cursor,
            retainedFromSequence: 1,
            capturedHeadSequence: snapshot.headSequence,
            databaseNowEpochMs: 1_000,
            entries,
            hasMore: entries.at(-1)!.sequence < snapshot.headSequence
        });
    }

    compareAndSetCursor(input: RtcTopologyReplayCursorCasInput) {
        this.#operations.cursorWrites += 1;
        if (input.expectedSequence !== this.#cursor) {
            return Promise.resolve({ status: 'conflict', currentSequence: this.#cursor } as const);
        }
        this.#cursor = input.nextSequence;
        this.#gap = false;
        return Promise.resolve({ status: 'advanced' } as const);
    }

    publish(entryCount: number): void {
        this.#entries = entries(entryCount);
    }

    installGap(): void {
        this.#entries = entries(5);
        this.#gap = true;
    }

    #snapshot(): RtcTopologyReplayCursorSnapshot {
        return {
            consumerStreamId: STREAM_ID,
            publisherStreamId: STREAM_ID,
            headSequence: this.#entries.length,
            retainedFromSequence: this.#gap ? 4 : 1,
            lastProcessedSequence: this.#cursor,
            cursorUpdatedAtEpochMs: 1_000,
            publisherLeaseExpiresAtEpochMs: 31_000
        };
    }
}

function entries(count: number): readonly RtcTopologyDeliveryLogEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        publisherStreamId: STREAM_ID,
        sequence: index + 1,
        groupRef: {
            applicationId: 'performance',
            workspaceId: 'replay-drain',
            groupId: `group-${index + 1}`
        },
        publicationId: `publication-${index + 1}`,
        outboxKey: {
            topicId: 'app-outbox.rtc-topology',
            resourceId: `resource-${index + 1}`,
            contextId: `context-${index + 1}`
        },
        retainUntilEpochMs: 86_401_000,
        insertedAtEpochMs: 1_000
    }));
}

function operationCountingScheduler(
    operations: MutableOperationCounts
): RtcTopologyReplayServiceScheduler {
    return {
        repeat: () => () => undefined,
        yield: () => {
            operations.yieldedTurns += 1;
            return Promise.resolve();
        }
    };
}

function mutableCounts(): MutableOperationCounts {
    return {
        discoveryReads: 0,
        pageReads: 0,
        handledEntries: 0,
        cursorWrites: 0,
        hydrationRuns: 0,
        yieldedTurns: 0
    };
}

function resetCounts(counts: MutableOperationCounts): void {
    Object.assign(counts, mutableCounts());
}

async function main(): Promise<void> {
    const outPath = readOutputPath(Deno.args);
    const result = await runRtcTopologyReplayDrainOperationWorkloads();
    const artifact = {
        ...result,
        generatedAt: new Date().toISOString(),
        runtime: { deno: Deno.version.deno },
        policy: RTC_TOPOLOGY_REPLAY_DRAIN_WORKLOAD_POLICY
    };
    await Deno.mkdir(dirname(outPath), { recursive: true });
    await Deno.writeTextFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ outPath, ...result }, null, 2));
}

function readOutputPath(args: readonly string[]): string {
    let outPath = 'tmp/perf/rtc-topology-replay-drain-operation-counts.json';
    for (const argument of args) {
        if (argument.startsWith('--out=')) {
            outPath = argument.slice('--out='.length);
        }
        else {
            throw new TypeError(`Unsupported RTC topology replay drain option: ${argument}`);
        }
    }
    if (!outPath.trim()) {
        throw new TypeError('RTC topology replay drain output must be non-empty');
    }
    return outPath;
}

if (import.meta.main) {
    await main();
}
