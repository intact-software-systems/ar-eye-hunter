import type { ControlResultEnvelope } from '../control-protocol.ts';
import type { ControlDistributedRunCommandLink, ControlQueuedCommandSnapshot } from '../control-snapshots.ts';
import {
    getDistributedRunMonitorAgentLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
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

export interface ComputeDistributedRunAgentProgressInput {
    readonly index: DistributedRunMonitorIndex;
    readonly eventsByAgentId: ReadonlyMap<string, readonly DistributedRunEventRow[]>;
}

interface LinkEvidence {
    readonly link: ControlDistributedRunCommandLink;
    /** Absent when the control run snapshot holds no queued command for the link. */
    readonly command: ControlQueuedCommandSnapshot | undefined;
    /** Absent until the agent reports the linked command's result. */
    readonly result: ControlResultEnvelope | undefined;
}

interface AgentLinkTotals {
    readonly stageProgress: LinkProgressSummary;
    readonly barrierProgress: LinkProgressSummary;
    readonly startProgress: LinkProgressSummary;
    readonly latencies: readonly number[];
    readonly resultCount: number;
    readonly failedCommandCount: number;
    readonly completedCommandCount: number;
    /** Absent when no link, command or result records a finite time. */
    readonly lastActivityAtEpochMs: number | undefined;
}

interface LinkProgressSummary {
    readonly count: number;
    readonly failed: boolean;
    readonly allPassed: boolean;
    readonly dispatched: boolean;
}

export function computeDistributedRunAgentProgress(
    input: ComputeDistributedRunAgentProgressInput
): readonly DistributedRunAgentProgressRow[] {
    return input.index.agentIds.map((agentId) => toAgentProgressRow(input, agentId));
}

function toAgentProgressRow(
    input: ComputeDistributedRunAgentProgressInput,
    agentId: string
): DistributedRunAgentProgressRow {
    const links = getDistributedRunMonitorAgentLinks(input.index, agentId);
    const linkedEvents = input.eventsByAgentId.get(agentId) ?? [];
    const totals = computeAgentLinkTotals(links.all.map((link) => toLinkEvidence(input.index, link)));
    const lastActivityAtEpochMs = computeMaxFiniteNumber([
        totals.lastActivityAtEpochMs,
        ...linkedEvents.map((event) => event.atEpochMs)
    ]);

    return {
        agentId,
        role: input.index.membership.roleByAgentId.get(agentId),
        readiness: toLinkProgressStatus(totals.stageProgress, 'ready'),
        barrier: toLinkProgressStatus(totals.barrierProgress, 'ready'),
        execution: toLinkProgressStatus(totals.startProgress, 'passed'),
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
}

function toLinkEvidence(index: DistributedRunMonitorIndex, link: ControlDistributedRunCommandLink): LinkEvidence {
    return {
        link,
        command: index.commandsById.get(link.commandId),
        result: index.resultsByCommandId.get(link.commandId)
    };
}

function computeAgentLinkTotals(linkEvidence: readonly LinkEvidence[]): AgentLinkTotals {
    const results = linkEvidence.flatMap(({ result }) => result === undefined ? [] : [result]);
    return {
        stageProgress: computeLinkProgressSummary(linkEvidence.filter(({ link }) => link.phase === 'stage')),
        barrierProgress: computeLinkProgressSummary(linkEvidence.filter(({ link }) => link.phase === 'barrier')),
        startProgress: computeLinkProgressSummary(linkEvidence.filter(({ link }) => link.phase === 'start')),
        latencies: results.map((result) => result.result?.durationMs).filter(isFiniteDurationMs),
        resultCount: results.length,
        failedCommandCount: results.filter((result) => !result.ok).length,
        completedCommandCount:
            linkEvidence.filter(({ command, result }) =>
                result !== undefined || command?.completedAtEpochMs !== undefined
            ).length,
        lastActivityAtEpochMs: computeMaxFiniteNumber(linkEvidence.flatMap(({ link, command, result }) => [
            link.queuedAtEpochMs,
            command?.dispatchedAtEpochMs,
            command?.completedAtEpochMs,
            result?.result?.endedAtEpochMs
        ]))
    };
}

function computeLinkProgressSummary(linkEvidence: readonly LinkEvidence[]): LinkProgressSummary {
    return {
        count: linkEvidence.length,
        failed: linkEvidence.some(({ result }) => result?.ok === false),
        allPassed: linkEvidence.every(({ result }) => result?.ok === true),
        dispatched: linkEvidence.some(({ command }) => command?.dispatchedAtEpochMs !== undefined)
    };
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
