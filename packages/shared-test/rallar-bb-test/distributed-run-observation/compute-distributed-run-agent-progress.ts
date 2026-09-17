import type { ControlDistributedRunCommandLink, ControlRunSnapshot } from '../control-snapshots.ts';
import {
    getDistributedRunMonitorAgentLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import { distributedRunMonitorAgentRole } from '../distributed-run-monitor-membership-index.ts';
import {
    computeAverage,
    computeMaxFiniteNumber,
    isFiniteDurationMs
} from './distributed-run-latency-summary.ts';
import type { DistributedRunMonitorDerivationWork } from './distributed-run-monitor-derivation-work.ts';
import type {
    DistributedRunAgentProgressRow,
    DistributedRunEventRow,
    DistributedRunProgressStatus
} from './distributed-run-row-contracts.ts';

export interface ComputeDistributedRunAgentProgressInput {
    readonly index: DistributedRunMonitorIndex;
    readonly eventsByAgentId: ReadonlyMap<string, readonly DistributedRunEventRow[]>;
}

export interface DistributedRunAgentProgress {
    readonly rows: readonly DistributedRunAgentProgressRow[];
    readonly work: Pick<
        DistributedRunMonitorDerivationWork,
        | 'agentLinkBucketLookupCount'
        | 'agentEventBucketLookupCount'
        | 'agentRoleLookupCount'
        | 'agentLinkProjectionVisitCount'
        | 'agentEventProjectionVisitCount'
    >;
}

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];

interface AgentProgressRowProjection {
    readonly row: DistributedRunAgentProgressRow;
    readonly linkVisitCount: number;
    readonly eventVisitCount: number;
}

/** One row per agent, with the bucket lookups and link and event visits the projection made. */
export function computeDistributedRunAgentProgress(
    input: ComputeDistributedRunAgentProgressInput
): DistributedRunAgentProgress {
    const projections = input.index.agentIds.map((agentId) => toAgentProgressRowProjection(input, agentId));
    return {
        rows: projections.map((projection) => projection.row),
        work: {
            agentLinkBucketLookupCount: projections.length,
            agentEventBucketLookupCount: projections.length,
            agentRoleLookupCount: projections.length,
            agentLinkProjectionVisitCount: projections.reduce(
                (total, projection) => total + projection.linkVisitCount,
                0
            ),
            agentEventProjectionVisitCount: projections.reduce(
                (total, projection) => total + projection.eventVisitCount,
                0
            )
        }
    };
}

function toAgentProgressRowProjection(
    input: ComputeDistributedRunAgentProgressInput,
    agentId: string
): AgentProgressRowProjection {
    const links = getDistributedRunMonitorAgentLinks(input.index, agentId);
    const linkedEvents = input.eventsByAgentId.get(agentId) ?? [];
    const totals = toAgentLinkTotals({ index: input.index, links: links.all });
    const eventTimes = linkedEvents.map((event) => event.atEpochMs);
    const lastActivityAtEpochMs = computeMaxFiniteNumber([totals.lastActivityAtEpochMs, ...eventTimes]);

    return {
        linkVisitCount: totals.linkVisitCount,
        eventVisitCount: eventTimes.length,
        row: {
            agentId,
            role: distributedRunMonitorAgentRole(input.index.membership, agentId),
            readiness: toLinkProgressStatus(totals.phaseProgress.stage, 'ready'),
            barrier: toLinkProgressStatus(totals.phaseProgress.barrier, 'ready'),
            execution: toLinkProgressStatus(totals.phaseProgress.start, 'passed'),
            stageCommandCount: links.stage.length,
            barrierCommandCount: links.barrier.length,
            startCommandCount: links.start.length,
            completedCommandCount: totals.completedCommandCount,
            failedCommandCount: totals.failedCommandCount,
            resultCount: totals.resultCount,
            eventCount: linkedEvents.length,
            averageLatencyMs: computeAverage(totals.latencies),
            lastActivityAtEpochMs
        }
    };
}

type AgentLinkTotals = Readonly<{
    phaseProgress: Readonly<{
        stage: LinkProgressSummary;
        barrier: LinkProgressSummary;
        start: LinkProgressSummary;
    }>;
    latencies: readonly number[];
    resultCount: number;
    failedCommandCount: number;
    completedCommandCount: number;
    lastActivityAtEpochMs: number | undefined;
    linkVisitCount: number;
}>;

function toAgentLinkTotals(
    input: Readonly<{
        index: DistributedRunMonitorIndex;
        links: readonly ControlDistributedRunCommandLink[];
    }>
): AgentLinkTotals {
    const phaseProgress = {
        stage: createEmptyLinkProgressSummary(),
        barrier: createEmptyLinkProgressSummary(),
        start: createEmptyLinkProgressSummary()
    };
    const latencies: number[] = [];
    let resultCount = 0;
    let failedCommandCount = 0;
    let completedCommandCount = 0;
    let lastActivityAtEpochMs: number | undefined;
    let linkVisitCount = 0;
    for (const link of input.links) {
        linkVisitCount += 1;
        const command = input.index.commandsById.get(link.commandId);
        const result = input.index.resultsByCommandId.get(link.commandId);
        lastActivityAtEpochMs = computeMaxFiniteNumber([
            lastActivityAtEpochMs,
            link.queuedAtEpochMs,
            command?.dispatchedAtEpochMs,
            command?.completedAtEpochMs,
            result?.result?.endedAtEpochMs
        ]);
        if (result !== undefined) {
            resultCount += 1;
            if (!result.ok) {
                failedCommandCount += 1;
            }
            const durationMs = result.result?.durationMs;
            if (isFiniteDurationMs(durationMs)) {
                latencies.push(durationMs);
            }
        }
        if (result !== undefined || command?.completedAtEpochMs !== undefined) {
            completedCommandCount += 1;
        }
        if (link.phase !== 'cancel') {
            setLinkProgressSummary(phaseProgress[link.phase], command, result);
        }
    }
    return {
        phaseProgress,
        latencies,
        resultCount,
        failedCommandCount,
        completedCommandCount,
        lastActivityAtEpochMs,
        linkVisitCount
    };
}

interface LinkProgressSummary {
    count: number;
    failed: boolean;
    allPassed: boolean;
    dispatched: boolean;
}

function createEmptyLinkProgressSummary(): LinkProgressSummary {
    return { count: 0, failed: false, allPassed: true, dispatched: false };
}

function setLinkProgressSummary(
    summary: LinkProgressSummary,
    command: ControlCommandSnapshot | undefined,
    result: ControlResultSnapshot | undefined
): void {
    summary.count += 1;
    summary.failed ||= result?.ok === false;
    summary.allPassed &&= result?.ok === true;
    summary.dispatched ||= command?.dispatchedAtEpochMs !== undefined;
}

function toLinkProgressStatus(
    summary: LinkProgressSummary,
    successStatus: DistributedRunProgressStatus
): DistributedRunProgressStatus {
    if (summary.count === 0) {
        return 'missing';
    }
    if (summary.failed) {
        return 'failed';
    }
    if (summary.allPassed) {
        return successStatus;
    }
    if (summary.dispatched) {
        return 'running';
    }
    return 'queued';
}
