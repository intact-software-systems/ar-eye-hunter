import type { RecipeConsoleTimingMetric, RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { projectTuneIdentitySurfaces } from './tune-identity.ts';
import type { TuneRunOption } from './tune-run-catalog.ts';

export function tuneRightSelectionPatch(
    option: TuneRunOption
): Partial<RecipeConsoleUrlState> {
    if (!safeOption(option)) {
        return {};
    }
    return {
        compareRight: option.distributedRunId,
        distributedRunId: option.distributedRunId,
        controlRunId: option.controlRunId,
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined
    };
}

export function tuneLeftSelectionPatch(
    option: TuneRunOption
): Partial<RecipeConsoleUrlState> {
    if (!safeOption(option)) {
        return {};
    }
    return { compareLeft: option.distributedRunId };
}

export function tuneTimingMetricPatch(
    timingMetric: RecipeConsoleTimingMetric
): Partial<RecipeConsoleUrlState> {
    return { timingMetric };
}

function safeOption(option: TuneRunOption): boolean {
    const identity = projectTuneIdentitySurfaces({
        distributedRunId: option.distributedRunId,
        controlRunId: option.controlRunId
    });
    return !identity.quarantined &&
        identity.distributedRunId === option.distributedRunId &&
        identity.controlRunId === option.controlRunId;
}
