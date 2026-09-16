import type { DistributedRunMonitor } from '../distributed-run-monitor.ts';

export function toDistributedRunMonitorEvidenceText(monitor: DistributedRunMonitor): string {
    return [
        monitor.distributedRunId,
        monitor.state,
        ...monitor.events.flatMap(toEventEvidenceParts),
        ...monitor.runtimeDiagnostics.flatMap(toDiagnosticEvidenceParts),
        ...monitor.compositeDrilldowns.flatMap(toCompositeEvidenceParts),
        ...monitor.timeline.flatMap(toTimelineEvidenceParts)
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join('\n');
}

function toEventEvidenceParts(
    event: DistributedRunMonitor['events'][number]
): readonly (string | undefined)[] {
    return [
        event.eventId,
        event.kind,
        event.agentId,
        event.commandId,
        event.topic,
        event.summary,
        event.payloadSummary
    ];
}

function toDiagnosticEvidenceParts(
    diagnostic: DistributedRunMonitor['runtimeDiagnostics'][number]
): readonly (string | undefined)[] {
    return [
        diagnostic.eventId,
        diagnostic.agentId,
        diagnostic.commandId,
        diagnostic.transport,
        diagnostic.severity,
        diagnostic.topic,
        diagnostic.diagnosticTypeId,
        diagnostic.message,
        diagnostic.summary,
        diagnostic.payloadSummary,
        diagnostic.groupId,
        diagnostic.roomId,
        diagnostic.laneId,
        diagnostic.peerId,
        diagnostic.remotePeerId,
        diagnostic.senderId,
        diagnostic.typeId,
        diagnostic.topicId,
        diagnostic.contextId,
        diagnostic.resourceId,
        diagnostic.source,
        ...diagnostic.correlatedFailureKeys
    ];
}

function toCompositeEvidenceParts(
    drilldown: DistributedRunMonitor['compositeDrilldowns'][number]
): readonly (string | undefined)[] {
    return [
        drilldown.key,
        drilldown.commandId,
        drilldown.agentId,
        drilldown.recipeId,
        drilldown.role,
        drilldown.phase,
        drilldown.commandKind,
        drilldown.artifactRef,
        ...drilldown.rows.flatMap((row) => [
            row.path,
            row.sourceRecipePath,
            row.commandId,
            row.originalCommandId,
            row.kind,
            row.status,
            row.summary,
            row.detail,
            row.errorSummary,
            row.valueSummary,
            row.groupId
        ])
    ];
}

function toTimelineEvidenceParts(
    item: DistributedRunMonitor['timeline'][number]
): readonly (string | undefined)[] {
    return [
        item.id,
        item.kind,
        item.label,
        item.detail,
        item.agentId,
        item.recipeId,
        item.commandId,
        item.phase
    ];
}
