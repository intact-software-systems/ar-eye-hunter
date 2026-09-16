import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import {
    getDistributedRunMonitorReadinessStageLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import { distributedRunMonitorAgentRole } from '../distributed-run-monitor-membership-index.ts';
import { computeDurationBetween } from './distributed-run-latency-summary.ts';
import type { DistributedRunReadinessRow } from './distributed-run-row-contracts.ts';

export function computeDistributedRunReadiness(
    input: Readonly<{
        index: DistributedRunMonitorIndex;
    }>
): readonly DistributedRunReadinessRow[] {
    return input.index.membership.targetAgentIds.map((agentId) => {
        const stageLinks = getDistributedRunMonitorReadinessStageLinks(
            input.index,
            agentId
        );
        const role = distributedRunMonitorAgentRole(
            input.index.membership,
            agentId,
            input.index.work
        );
        if (stageLinks.length === 0) {
            return {
                agentId,
                role,
                status: 'missing',
                error: 'No stage command was queued for this target.'
            };
        }
        let failedLink: ControlDistributedRunCommandLink | undefined;
        let pendingLink: ControlDistributedRunCommandLink | undefined;
        for (const link of stageLinks) {
            input.index.work.readinessStageLinkProjectionVisitCount += 1;
            const result = input.index.resultsByCommandId.get(link.commandId);
            if (failedLink === undefined && result?.ok === false) {
                failedLink = link;
            }
            if (pendingLink === undefined && result === undefined) {
                pendingLink = link;
            }
        }
        const representative = failedLink ?? pendingLink ?? stageLinks[stageLinks.length - 1];
        const result = input.index.resultsByCommandId.get(representative.commandId);
        const command = input.index.commandsById.get(representative.commandId);
        const latencyMs = result?.result?.durationMs ??
            computeDurationBetween(representative.queuedAtEpochMs, command?.completedAtEpochMs);

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
            latencyMs,
            error: result?.error?.message ?? result?.result?.error?.message
        };
    });
}
