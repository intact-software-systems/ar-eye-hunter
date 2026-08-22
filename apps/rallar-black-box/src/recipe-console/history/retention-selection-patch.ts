import type { ControlRetentionCandidate } from '@shared-test/rallar-bb-test/control-retention.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type RetentionSelectionCapture = Readonly<{
    urlState: RecipeConsoleUrlState;
    associations: readonly Readonly<{
        controlRunId: string;
        distributedRunIds: readonly string[];
    }>[];
}>;

export function captureRetentionSelectionBeforeCleanup(
    input: Readonly<{
        urlState: RecipeConsoleUrlState;
        candidates: readonly ControlRetentionCandidate[];
    }>
): RetentionSelectionCapture {
    return {
        urlState: {
            ...input.urlState,
            ...(input.urlState.fleetMapLayers
                ? { fleetMapLayers: [...input.urlState.fleetMapLayers] }
                : {})
        },
        associations: input.candidates.map((candidate) => ({
            controlRunId: candidate.runId,
            distributedRunIds: candidate.distributedRuns.map((run) => run.distributedRunId)
        }))
    };
}

export function retentionSelectionPatchAfterCleanup(
    input: Readonly<{
        capture: RetentionSelectionCapture;
        currentUrlState: RecipeConsoleUrlState;
        deletedRunIds: readonly string[];
    }>
): Partial<RecipeConsoleUrlState> {
    const confirmed = new Set(input.deletedRunIds);
    const deletedControlRunIds = new Set<string>();
    const deletedDistributedRunIds = new Set<string>();
    for (const association of input.capture.associations) {
        if (!confirmed.has(association.controlRunId)) {
            continue;
        }
        deletedControlRunIds.add(association.controlRunId);
        association.distributedRunIds.forEach((id) => deletedDistributedRunIds.add(id));
    }

    const state = input.currentUrlState;
    const patch: Partial<Record<keyof RecipeConsoleUrlState, undefined>> = {};
    if (
        state.controlRunId !== undefined &&
        deletedControlRunIds.has(state.controlRunId)
    ) {
        patch.controlRunId = undefined;
        patch.distributedRunId = undefined;
        patch.agentId = undefined;
        patch.recipeId = undefined;
        patch.commandId = undefined;
    }
    else if (
        state.distributedRunId !== undefined &&
        deletedDistributedRunIds.has(state.distributedRunId)
    ) {
        patch.distributedRunId = undefined;
        if (state.controlRunId === undefined) {
            patch.agentId = undefined;
        }
        patch.recipeId = undefined;
        patch.commandId = undefined;
    }
    if (
        state.compareLeft !== undefined &&
        deletedDistributedRunIds.has(state.compareLeft)
    ) {
        patch.compareLeft = undefined;
    }
    if (
        state.compareRight !== undefined &&
        deletedDistributedRunIds.has(state.compareRight)
    ) {
        patch.compareRight = undefined;
    }
    return patch;
}
