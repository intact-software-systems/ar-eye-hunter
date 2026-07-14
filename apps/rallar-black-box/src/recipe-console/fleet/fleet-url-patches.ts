import type {
    ControlFleetFailureSignature,
    ControlFleetRunReport,
} from '@shared-test/rallar-bb-test/fleet-report.ts';
import type { RecipeConsoleUrlState } from
    '../routing/url-state-contract.ts';

type FleetHandoffReport = Pick<
    ControlFleetRunReport,
    | 'distributedRunId'
    | 'controlRunId'
    | 'group'
    | 'recipeIds'
>;

export function fleetAffectedAgentPatch(
    agentId: string,
): Partial<RecipeConsoleUrlState> {
    return { agentId };
}

export function fleetRegionSelectionPatch(
    fleetRegion: string | undefined,
): Partial<RecipeConsoleUrlState> {
    return { fleetRegion };
}

export function fleetReportMonitorPatch(
    report: FleetHandoffReport,
    agentId?: string,
): Partial<RecipeConsoleUrlState> {
    return {
        view: 'monitor',
        controlRunId: report.controlRunId,
        distributedRunId: report.distributedRunId,
        agentId,
        recipeId: undefined,
        commandId: undefined,
    };
}

export function fleetReportAnalyzePatch(
    report: FleetHandoffReport,
    agentId?: string,
): Partial<RecipeConsoleUrlState> {
    return {
        view: 'analyze',
        controlRunId: report.controlRunId,
        distributedRunId: report.distributedRunId,
        agentId,
        recipeId: undefined,
        commandId: undefined,
    };
}

export function fleetReportTuneHistoryPatch(
    report: FleetHandoffReport,
    failure: Pick<
        ControlFleetFailureSignature,
        'signatureId' | 'category' | 'recipeId'
    >,
): Partial<RecipeConsoleUrlState> {
    return {
        view: 'tune',
        controlRunId: report.controlRunId,
        distributedRunId: report.distributedRunId,
        compareRight: report.distributedRunId,
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined,
        historyQuery: report.distributedRunId,
        historyGroup: report.group.groupId,
        historyRecipeId: failure.recipeId ?? (
            report.recipeIds.length === 1 ? report.recipeIds[0] : undefined
        ),
        failureCategory: undefined,
    };
}

export function fleetReturnPatch(): Partial<RecipeConsoleUrlState> {
    return { view: 'fleet' };
}
