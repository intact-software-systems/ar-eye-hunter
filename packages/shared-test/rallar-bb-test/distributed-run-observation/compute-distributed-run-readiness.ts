import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import {
    getDistributedRunMonitorReadinessStageLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import { computeDurationBetween } from './distributed-run-latency-summary.ts';
import type { DistributedRunReadinessRow } from './distributed-run-row-contracts.ts';

export function computeDistributedRunReadiness(
    index: DistributedRunMonitorIndex
): readonly DistributedRunReadinessRow[] {
    return index.membership.targetAgentIds.map((agentId) => toReadinessRow(index, agentId));
}

function toReadinessRow(index: DistributedRunMonitorIndex, agentId: string): DistributedRunReadinessRow {
    const stageLinks = getDistributedRunMonitorReadinessStageLinks(index, agentId);
    const role = index.membership.roleByAgentId.get(agentId);
    if (stageLinks.length === 0) {
        return { agentId, role, status: 'missing', error: 'No stage command was queued for this target.' };
    }
    let failedLink: ControlDistributedRunCommandLink | undefined;
    let pendingLink: ControlDistributedRunCommandLink | undefined;
    for (const link of stageLinks) {
        const result = index.resultsByCommandId.get(link.commandId);
        if (failedLink === undefined && result?.ok === false) {
            failedLink = link;
        }
        if (pendingLink === undefined && result === undefined) {
            pendingLink = link;
        }
    }
    const representative = failedLink ?? pendingLink ?? stageLinks[stageLinks.length - 1];
    const result = index.resultsByCommandId.get(representative.commandId);
    const command = index.commandsById.get(representative.commandId);

    return {
        agentId,
        role,
        status: failedLink
            ? 'failed'
            : pendingLink
            ? command?.dispatchedAtEpochMs !== undefined ? 'running' : 'queued'
            : 'ready',
        commandId: representative.commandId,
        queuedAtEpochMs: representative.queuedAtEpochMs,
        completedAtEpochMs: result?.result?.endedAtEpochMs ?? command?.completedAtEpochMs,
        latencyMs: result?.result?.durationMs ??
            computeDurationBetween(representative.queuedAtEpochMs, command?.completedAtEpochMs),
        error: result?.error?.message ?? result?.result?.error?.message
    };
}
