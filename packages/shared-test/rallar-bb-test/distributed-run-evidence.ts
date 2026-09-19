import type { DistributedRunMonitor } from './distributed-run-monitor.ts';
import type {
    DistributedRunArtifactValidationStatus,
    DistributedRunCompositeDrilldown,
    DistributedRunEventRow,
    DistributedRunFailureRow,
    DistributedRunTimelineItem
} from './distributed-run-observation/distributed-run-row-contracts.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from './distributed-run.ts';

export type DistributedRunFailureEvidenceDestinationKind = DistributedRunFailureEvidenceDestination['kind'];

export type DistributedRunFailureEvidenceDestination =
    | DistributedRunAgentEvidenceDestination
    | DistributedRunRecipeEvidenceDestination
    | DistributedRunCommandEvidenceDestination
    | DistributedRunDiagnosticEvidenceDestination
    | DistributedRunTimelineEvidenceDestination
    | DistributedRunEventEvidenceDestination
    | DistributedRunArtifactEvidenceDestination;

export interface DistributedRunAgentEvidenceDestination extends DistributedRunEvidenceDestinationFields {
    readonly kind: 'agent';
    readonly agentId: string;
}

export interface DistributedRunRecipeEvidenceDestination extends DistributedRunEvidenceDestinationFields {
    readonly kind: 'recipe';
    readonly recipeId: string;
}

export interface DistributedRunCommandEvidenceDestination extends DistributedRunEvidenceDestinationFields {
    readonly kind: 'command';
    /** Absent when the failure names no agent. */
    readonly agentId?: string;
    /** Absent when the failure names no recipe. */
    readonly recipeId?: string;
    readonly commandId: string;
}

export interface DistributedRunDiagnosticEvidenceDestination extends DistributedRunEvidenceDestinationFields {
    readonly kind: 'diagnostic';
    /** Absent when the diagnostic names no agent. */
    readonly agentId?: string;
    /** Absent when the diagnostic names no command. */
    readonly commandId?: string;
    readonly diagnosticId: string;
}

export interface DistributedRunTimelineEvidenceDestination extends DistributedRunEvidenceDestinationFields {
    readonly kind: 'timeline';
    /** Absent when the timeline item names no agent. */
    readonly agentId?: string;
    /** Absent when the timeline item names no recipe. */
    readonly recipeId?: string;
    /** Absent when the timeline item names no command. */
    readonly commandId?: string;
    readonly timelineId: string;
}

export interface DistributedRunEventEvidenceDestination extends DistributedRunEvidenceDestinationFields {
    readonly kind: 'event';
    /** Absent when the event names no agent. */
    readonly agentId?: string;
    /** Absent when the event names no command. */
    readonly commandId?: string;
    readonly eventId: string;
}

export interface DistributedRunArtifactEvidenceDestination extends DistributedRunEvidenceDestinationFields {
    readonly kind: 'artifact';
    readonly artifactStatus: DistributedRunArtifactValidationStatus;
}

export interface ComputeDistributedRunFailureEvidenceDestinationsInput {
    readonly failure: DistributedRunFailureRow;
    readonly monitor: DistributedRunMonitor;
}

interface DistributedRunEvidenceDestinationFields {
    readonly id: string;
    readonly label: string;
}

interface FailureEvidenceScope {
    readonly commandIds: readonly string[];
    readonly agentIds: readonly string[];
    readonly recipeIds: readonly string[];
    readonly matchingTimeline: readonly DistributedRunTimelineItem[];
    readonly recipeCommandIds: ReadonlySet<string>;
}

interface EventFailureMatchInput {
    readonly event: DistributedRunEventRow;
    readonly failure: DistributedRunFailureRow;
    readonly commandIds: readonly string[];
    readonly recipeCommandIds: ReadonlySet<string>;
}

/** The recipe key a selection contributes to command links, progress rows and group assertion sources. */
export function resolveDistributedRunRecipeSelectionKey(
    selection: RallarBlackBoxDistributedRunRecipeSelection
): string {
    return selection.recipeId.trim();
}

export function computeDistributedRunFailureEvidenceDestinations(
    input: ComputeDistributedRunFailureEvidenceDestinationsInput
): readonly DistributedRunFailureEvidenceDestination[] {
    const scope = computeFailureEvidenceScope(input);
    const destinations: readonly DistributedRunFailureEvidenceDestination[] = [
        ...scope.agentIds.map((agentId): DistributedRunAgentEvidenceDestination => ({
            kind: 'agent',
            id: agentId,
            label: `Agent ${agentId}`,
            agentId
        })),
        ...scope.recipeIds.map((recipeId): DistributedRunRecipeEvidenceDestination => ({
            kind: 'recipe',
            id: recipeId,
            label: `Recipe ${recipeId}`,
            recipeId
        })),
        ...scope.commandIds.map((commandId): DistributedRunCommandEvidenceDestination => ({
            kind: 'command',
            id: commandId,
            label: `Command ${commandId}`,
            agentId: input.failure.agentId,
            recipeId: input.failure.recipeId,
            commandId
        })),
        ...toDiagnosticDestinations(input, scope),
        ...scope.matchingTimeline.map((item): DistributedRunTimelineEvidenceDestination => ({
            kind: 'timeline',
            id: item.id,
            label: item.label,
            agentId: item.agentId,
            recipeId: item.recipeId,
            commandId: item.commandId,
            timelineId: item.id
        })),
        ...toEventDestinations(input, scope),
        ...toArtifactDestinations(input.monitor)
    ];
    return toUniqueDestinations(destinations);
}

/**
 * The ids a failure names directly, widened for participant and recipe failures by the command, agent and recipe
 * ids of the timeline items those failures cover.
 */
function computeFailureEvidenceScope(
    input: ComputeDistributedRunFailureEvidenceDestinationsInput
): FailureEvidenceScope {
    const { failure, monitor } = input;
    const directCommandIds = toUniqueStrings([
        failure.commandId,
        ...monitor.compositeDrilldowns
            .filter((drilldown) => isCompositeDrilldownMatchingFailure(drilldown, failure))
            .map((drilldown) => drilldown.commandId)
            .sort()
    ]);
    const infersScope = failure.kind === 'participant' || failure.kind === 'recipe';
    const commandIds = toUniqueStrings([
        ...directCommandIds,
        ...(infersScope
            ? monitor.timeline
                .filter((item) => isTimelineMatchingFailure(item, failure, directCommandIds))
                .map((item) => item.commandId)
                .sort()
            : [])
    ]);
    const matchingTimeline = monitor.timeline.filter((item) => isTimelineMatchingFailure(item, failure, commandIds));
    return {
        commandIds,
        agentIds: toUniqueStrings([
            failure.agentId,
            ...(infersScope ? matchingTimeline.map((item) => item.agentId).sort() : [])
        ]),
        recipeIds: toUniqueStrings([
            failure.recipeId,
            ...(infersScope ? matchingTimeline.map((item) => item.recipeId).sort() : [])
        ]),
        matchingTimeline,
        recipeCommandIds: new Set(
            monitor.timeline
                .filter((item) => item.recipeId === failure.recipeId)
                .flatMap((item) => item.commandId === undefined ? [] : [item.commandId])
        )
    };
}

function toDiagnosticDestinations(
    input: ComputeDistributedRunFailureEvidenceDestinationsInput,
    scope: FailureEvidenceScope
): readonly DistributedRunDiagnosticEvidenceDestination[] {
    const { failure, monitor } = input;
    return monitor.runtimeDiagnostics
        .filter((diagnostic) => {
            if (!diagnostic.correlatedFailureKeys.includes(failure.key)) {
                return false;
            }
            if (failure.kind === 'run') {
                return failure.key === monitor.distributedRunId;
            }
            if (failure.kind === 'participant') {
                return diagnostic.agentId === failure.agentId;
            }
            if (failure.kind === 'recipe') {
                return diagnostic.commandId !== undefined && scope.recipeCommandIds.has(diagnostic.commandId);
            }
            return diagnostic.commandId !== undefined && scope.commandIds.includes(diagnostic.commandId) &&
                (!failure.agentId || diagnostic.agentId === failure.agentId);
        })
        .map((diagnostic) => ({
            kind: 'diagnostic',
            id: diagnostic.eventId,
            label: `${diagnostic.transport ?? 'Runtime'} diagnostic · ${diagnostic.diagnosticTypeId}`,
            agentId: diagnostic.agentId,
            commandId: diagnostic.commandId,
            diagnosticId: diagnostic.eventId
        }));
}

function toEventDestinations(
    input: ComputeDistributedRunFailureEvidenceDestinationsInput,
    scope: FailureEvidenceScope
): readonly DistributedRunEventEvidenceDestination[] {
    return input.monitor.events
        .filter((event) =>
            event.kind !== 'diagnostic' &&
            isEventMatchingFailure({
                event,
                failure: input.failure,
                commandIds: scope.commandIds,
                recipeCommandIds: scope.recipeCommandIds
            })
        )
        .map((event) => ({
            kind: 'event',
            id: event.eventId,
            label: event.summary,
            agentId: event.agentId,
            commandId: event.commandId,
            eventId: event.eventId
        }));
}

function toArtifactDestinations(monitor: DistributedRunMonitor): readonly DistributedRunArtifactEvidenceDestination[] {
    return monitor.artifact.status === 'valid'
        ? [{
            kind: 'artifact',
            id: monitor.artifact.status,
            label: 'Valid distributed artifact',
            artifactStatus: monitor.artifact.status
        }]
        : [];
}

function toUniqueDestinations(
    destinations: readonly DistributedRunFailureEvidenceDestination[]
): readonly DistributedRunFailureEvidenceDestination[] {
    const seen = new Set<string>();
    return destinations.filter((destination) => {
        const key = `${destination.kind}:${destination.id}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function isCompositeDrilldownMatchingFailure(
    drilldown: DistributedRunCompositeDrilldown,
    failure: DistributedRunFailureRow
): boolean {
    if (!failure.commandId) {
        return false;
    }
    if (failure.agentId && drilldown.agentId !== failure.agentId) {
        return false;
    }
    if (failure.recipeId && drilldown.recipeId !== failure.recipeId) {
        return false;
    }
    return drilldown.commandId === failure.commandId ||
        drilldown.rows.some((row) => row.commandId === failure.commandId);
}

function isTimelineMatchingFailure(
    item: DistributedRunTimelineItem,
    failure: DistributedRunFailureRow,
    commandIds: readonly string[]
): boolean {
    if (isDirectFailureTimeline(item, failure)) {
        return true;
    }
    if (commandIds.length > 0) {
        return item.commandId !== undefined && commandIds.includes(item.commandId);
    }
    if (failure.recipeId) {
        return item.recipeId === failure.recipeId;
    }
    if (failure.agentId) {
        return item.agentId === failure.agentId;
    }
    return failure.kind === 'run';
}

function isDirectFailureTimeline(
    item: DistributedRunTimelineItem,
    failure: DistributedRunFailureRow
): boolean {
    return item.kind === 'failure' &&
        item.detail === failure.message &&
        item.agentId === failure.agentId &&
        item.recipeId === failure.recipeId &&
        item.commandId === failure.commandId;
}

function isEventMatchingFailure({ event, failure, commandIds, recipeCommandIds }: EventFailureMatchInput): boolean {
    if (commandIds.length > 0) {
        return event.commandId !== undefined && commandIds.includes(event.commandId);
    }
    if (failure.recipeId) {
        return event.commandId !== undefined && recipeCommandIds.has(event.commandId);
    }
    if (failure.agentId) {
        return event.agentId === failure.agentId;
    }
    return failure.kind === 'run';
}

function toUniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => value !== undefined))];
}
