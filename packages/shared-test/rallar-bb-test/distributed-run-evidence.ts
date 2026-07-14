import type {
    RallarBlackBoxDistributedRoleAssignment,
    RallarBlackBoxDistributedRunRecipeSelection,
} from './distributed-run.ts';
import type { ControlDistributedRunSnapshot } from './control-snapshots.ts';
import type {
    DistributedRunArtifactValidationStatus,
    DistributedRunCompositeDrilldown,
    DistributedRunEventRow,
    DistributedRunFailureRow,
    DistributedRunMonitor,
    DistributedRunTimelineItem,
} from './distributed-run-monitor.ts';

export type DistributedRunFailureEvidenceDestinationKind =
    'agent' | 'recipe' | 'command' | 'diagnostic' | 'timeline' | 'event' | 'artifact';
export type DistributedRunFailureEvidenceDestination = Readonly<{
    kind: DistributedRunFailureEvidenceDestinationKind;
    id: string;
    label: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    diagnosticId?: string;
    timelineId?: string;
    eventId?: string;
    artifactStatus?: DistributedRunArtifactValidationStatus;
}>;
export function distributedRunRecipeSelectionKey(
    selection: RallarBlackBoxDistributedRunRecipeSelection,
): string | undefined {
    return cleanRecipeSelectionPart(selection.recipeId) ??
        cleanRecipeSelectionPart(selection.recipe?.recipeId) ??
        cleanRecipeSelectionPart(selection.role);
}
export function distributedRunExpectedAgentIdsForRecipe(
    distributedRun: ControlDistributedRunSnapshot,
    selection: RallarBlackBoxDistributedRunRecipeSelection,
): readonly string[] {
    return distributedRun.targetAgentIds.filter(agentId =>
        distributedRecipeSelectionsForAgent(distributedRun, agentId).includes(selection)
    );
}
export function deriveDistributedRunFailureEvidenceDestinations(input: Readonly<{
    failure: DistributedRunFailureRow;
    monitor: DistributedRunMonitor;
}>): readonly DistributedRunFailureEvidenceDestination[] {
    const destinations: DistributedRunFailureEvidenceDestination[] = [];
    const seen = new Set<string>();
    const add = (destination: DistributedRunFailureEvidenceDestination): void => {
        const key = `${destination.kind}:${destination.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            destinations.push(destination);
        }
    };
    const matchingDrilldowns = input.monitor.compositeDrilldowns
        .filter(drilldown => compositeDrilldownMatchesFailure(drilldown, input.failure));
    const directCommandIds = uniqueStrings([
        input.failure.commandId, ...matchingDrilldowns.map(drilldown => drilldown.commandId).sort(),
    ]);
    const inferScopedDestinations = input.failure.kind === 'participant' ||
        input.failure.kind === 'recipe';
    const initiallyMatchingTimeline = input.monitor.timeline
        .filter(item => timelineMatchesFailure(item, input.failure, directCommandIds));
    const commandIds = uniqueStrings([
        ...directCommandIds,
        ...(inferScopedDestinations
            ? initiallyMatchingTimeline.map(item => item.commandId).sort()
            : []),
    ]);
    const matchingTimeline = input.monitor.timeline
        .filter(item => timelineMatchesFailure(item, input.failure, commandIds));
    const agentIds = uniqueStrings([
        input.failure.agentId,
        ...(inferScopedDestinations ? matchingTimeline.map(item => item.agentId).sort() : []),
    ]);
    const recipeIds = uniqueStrings([
        input.failure.recipeId,
        ...(inferScopedDestinations ? matchingTimeline.map(item => item.recipeId).sort() : []),
    ]);
    agentIds.forEach(agentId => add({
        kind: 'agent', id: agentId, label: `Agent ${agentId}`, agentId,
    }));
    recipeIds.forEach(recipeId => add({
        kind: 'recipe', id: recipeId, label: `Recipe ${recipeId}`, recipeId,
    }));
    commandIds.forEach(commandId => add({
        kind: 'command',
        id: commandId,
        label: `Command ${commandId}`,
        agentId: input.failure.agentId,
        recipeId: input.failure.recipeId,
        commandId,
    }));
    const recipeCommandIds = new Set(input.monitor.timeline
        .filter(item => item.recipeId === input.failure.recipeId)
        .map(item => item.commandId)
        .filter((commandId): commandId is string => commandId !== undefined));
    input.monitor.runtimeDiagnostics
        .filter(diagnostic => {
            if (!diagnostic.correlatedFailureKeys.includes(input.failure.key)) {
                return false;
            }
            if (input.failure.kind === 'run') {
                return input.failure.key === input.monitor.distributedRunId;
            }
            if (input.failure.kind === 'participant') {
                return diagnostic.agentId === input.failure.agentId;
            }
            if (input.failure.kind === 'recipe') {
                return diagnostic.commandId !== undefined && recipeCommandIds.has(diagnostic.commandId);
            }
            return diagnostic.commandId !== undefined && commandIds.includes(diagnostic.commandId) &&
                (!input.failure.agentId || diagnostic.agentId === input.failure.agentId);
        })
        .forEach(diagnostic => add({
            kind: 'diagnostic',
            id: diagnostic.eventId,
            label: `${diagnostic.transport ?? 'Runtime'} diagnostic · ${diagnostic.diagnosticTypeId}`,
            agentId: diagnostic.agentId,
            commandId: diagnostic.commandId,
            diagnosticId: diagnostic.eventId,
        }));
    matchingTimeline.forEach(item => add({
        kind: 'timeline',
        id: item.id,
        label: item.label,
        agentId: item.agentId,
        recipeId: item.recipeId,
        commandId: item.commandId,
        timelineId: item.id,
    }));
    input.monitor.events
        .filter(event => event.kind !== 'diagnostic')
        .filter(event => eventMatchesFailure(
            event,
            input.failure,
            commandIds,
            recipeCommandIds,
        ))
        .forEach(event => add({
            kind: 'event',
            id: event.eventId,
            label: event.summary,
            agentId: event.agentId,
            commandId: event.commandId,
            eventId: event.eventId,
        }));
    if (input.monitor.artifact.status === 'valid') {
        add({
            kind: 'artifact',
            id: input.monitor.artifact.status,
            label: 'Valid distributed artifact',
            artifactStatus: input.monitor.artifact.status,
        });
    }
    return destinations;
}
function distributedRecipeSelectionsForAgent(
    distributedRun: ControlDistributedRunSnapshot,
    agentId: string,
): readonly RallarBlackBoxDistributedRunRecipeSelection[] {
    const assignments = distributedRecipeRoleAssignmentsForAgent(distributedRun, agentId);
    const assignedRecipeIds = new Set(assignments
        .flatMap(assignment => assignment.recipeIds ?? []));
    const roles = distributedRecipeRolesForAgent(distributedRun, agentId);
    const selections = distributedRun.manifest.recipes.filter(selection => {
        const recipeId = distributedRunRecipeSelectionKey(selection);
        if (assignedRecipeIds.size > 0 && recipeId && assignedRecipeIds.has(recipeId)) {
            return true;
        }
        if (selection.role) {
            return roles.has(selection.role);
        }
        return assignedRecipeIds.size === 0;
    });
    return selections.length > 0
        ? selections
        : distributedRun.manifest.recipes.filter(selection => !selection.role);
}
function distributedRecipeRolesForAgent(
    distributedRun: ControlDistributedRunSnapshot,
    agentId: string,
): ReadonlySet<string> {
    const roles = new Set<string>();
    const resolvedAssignments = distributedRun.targetResolution?.roleAssignments;
    if (resolvedAssignments) {
        resolvedAssignments.forEach(assignment => {
            if (assignment.agentId === agentId) {
                roles.add(assignment.role);
            }
        });
        return roles;
    }
    Object.entries(distributedRun.manifest.targetPolicy.roles ?? {}).forEach(([role, agentIds]) => {
        if (agentIds.includes(agentId)) {
            roles.add(role);
        }
    });
    (distributedRun.manifest.roleAssignments ?? []).forEach(assignment => {
        if (assignment.agentId === agentId) {
            roles.add(assignment.role);
        }
    });
    return roles;
}
function distributedRecipeRoleAssignmentsForAgent(
    distributedRun: ControlDistributedRunSnapshot,
    agentId: string,
): readonly RallarBlackBoxDistributedRoleAssignment[] {
    const assignments = distributedRun.targetResolution?.roleAssignments ??
        distributedRun.manifest.roleAssignments ??
        [];
    return assignments.filter(assignment => assignment.agentId === agentId);
}
function compositeDrilldownMatchesFailure(
    drilldown: DistributedRunCompositeDrilldown,
    failure: DistributedRunFailureRow,
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
        drilldown.rows.some(row => row.commandId === failure.commandId);
}

function timelineMatchesFailure(
    item: DistributedRunTimelineItem,
    failure: DistributedRunFailureRow,
    commandIds: readonly string[],
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
    failure: DistributedRunFailureRow,
): boolean {
    return item.kind === 'failure' &&
        item.detail === failure.message &&
        item.agentId === failure.agentId &&
        item.recipeId === failure.recipeId &&
        item.commandId === failure.commandId;
}

function eventMatchesFailure(
    event: DistributedRunEventRow,
    failure: DistributedRunFailureRow,
    commandIds: readonly string[],
    recipeCommandIds: ReadonlySet<string>,
): boolean {
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

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function cleanRecipeSelectionPart(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}
