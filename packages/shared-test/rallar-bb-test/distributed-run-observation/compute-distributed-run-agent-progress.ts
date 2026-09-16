import type { ControlDistributedRunCommandLink, ControlRunSnapshot } from '../control-snapshots.ts';
import {
    getDistributedRunMonitorAgentEvents,
    getDistributedRunMonitorAgentLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import { distributedRunMonitorAgentRole } from '../distributed-run-monitor-membership-index.ts';
import {
    computeAverage,
    computeMaxFiniteNumber,
    isFiniteDurationMs
} from './distributed-run-latency-summary.ts';
import type {
    DistributedRunAgentProgressRow,
    DistributedRunEventRow,
    DistributedRunProgressStatus
} from './distributed-run-row-contracts.ts';

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];

export function computeDistributedRunAgentProgress(
    input: Readonly<{
        index: DistributedRunMonitorIndex;
        eventsByAgentId: ReadonlyMap<string, readonly DistributedRunEventRow[]>;
    }>
): readonly DistributedRunAgentProgressRow[] {
    return input.index.agentIds.map((agentId) => {
        const links = getDistributedRunMonitorAgentLinks(input.index, agentId);
        const linkedEvents = getDistributedRunMonitorAgentEvents(
            input.index,
            input.eventsByAgentId,
            agentId
        );
        const totals = toAgentLinkTotals({ index: input.index, links: links.all });
        const lastActivityAtEpochMs = computeMaxFiniteNumber([
            totals.lastActivityAtEpochMs,
            ...linkedEvents.map((event) => {
                input.index.work.agentEventProjectionVisitCount += 1;
                return event.atEpochMs;
            })
        ]);

        return {
            agentId,
            role: distributedRunMonitorAgentRole(
                input.index.membership,
                agentId,
                input.index.work
            ),
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
        };
    });
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
    for (const link of input.links) {
        input.index.work.agentLinkProjectionVisitCount += 1;
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
        lastActivityAtEpochMs
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
