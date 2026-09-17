import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import {
    getDistributedRunMonitorReadinessStageLinks,
    type DistributedRunMonitorIndex
} from '../distributed-run-monitor-index.ts';
import { distributedRunMonitorAgentRole } from '../distributed-run-monitor-membership-index.ts';
import { computeDurationBetween } from './distributed-run-latency-summary.ts';
import type { DistributedRunMonitorDerivationWork } from './distributed-run-monitor-derivation-work.ts';
import type { DistributedRunReadinessRow } from './distributed-run-row-contracts.ts';

export interface DistributedRunReadiness {
    readonly rows: readonly DistributedRunReadinessRow[];
    readonly work: Pick<
        DistributedRunMonitorDerivationWork,
        'readinessLinkBucketLookupCount' | 'agentRoleLookupCount' | 'readinessStageLinkProjectionVisitCount'
    >;
}

interface ReadinessRowProjection {
    readonly row: DistributedRunReadinessRow;
    readonly stageLinkVisitCount: number;
}

/** One readiness row per target agent, with the bucket lookups and stage link visits the projection made. */
export function computeDistributedRunReadiness(index: DistributedRunMonitorIndex): DistributedRunReadiness {
    const projections = index.membership.targetAgentIds.map((agentId) => toReadinessRowProjection(index, agentId));
    return {
        rows: projections.map((projection) => projection.row),
        work: {
            readinessLinkBucketLookupCount: projections.length,
            agentRoleLookupCount: projections.length,
            readinessStageLinkProjectionVisitCount: projections.reduce(
                (total, projection) => total + projection.stageLinkVisitCount,
                0
            )
        }
    };
}

function toReadinessRowProjection(index: DistributedRunMonitorIndex, agentId: string): ReadinessRowProjection {
    const stageLinks = getDistributedRunMonitorReadinessStageLinks(index, agentId);
    const role = distributedRunMonitorAgentRole(index.membership, agentId);
    if (stageLinks.length === 0) {
        return {
            row: { agentId, role, status: 'missing', error: 'No stage command was queued for this target.' },
            stageLinkVisitCount: 0
        };
    }
    let failedLink: ControlDistributedRunCommandLink | undefined;
    let pendingLink: ControlDistributedRunCommandLink | undefined;
    let stageLinkVisitCount = 0;
    for (const link of stageLinks) {
        stageLinkVisitCount += 1;
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
        stageLinkVisitCount,
        row: {
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
        }
    };
}
