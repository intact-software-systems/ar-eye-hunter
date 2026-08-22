import type { DistributedRunMonitor } from '../../../distributed-recipes.ts';

export type DistributedRuntimeDiagnostic = DistributedRunMonitor['runtimeDiagnostics'][number];

export function distributedDiagnosticGroupValue(
    row: DistributedRuntimeDiagnostic
): string | undefined {
    return row.groupId ?? row.roomId ?? row.contextId;
}

export function distributedDiagnosticSearchText(
    row: DistributedRuntimeDiagnostic,
    distributedRunId: string | undefined
): string {
    return [
        distributedRunId,
        row.agentId,
        row.commandId,
        row.transport,
        row.severity,
        row.topic,
        row.diagnosticTypeId,
        row.message,
        row.summary,
        row.payloadSummary,
        row.connection,
        row.actor,
        row.groupId,
        row.roomId,
        row.laneId,
        row.expectedLaneId,
        row.observedLaneId,
        row.peerId,
        row.remotePeerId,
        row.senderId,
        row.typeId,
        row.topicId,
        row.contextId,
        row.resourceId,
        row.source,
        ...row.correlatedFailureKeys
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}
