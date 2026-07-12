import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { TuneRunOption } from '../tune/tune-run-catalog.ts';
import {
    tuneLeftSelectionPatch,
    tuneRightSelectionPatch,
} from '../tune/tune-url-patches.ts';

export type HistoryRowSelectionActions = Readonly<{
    eligible: boolean;
    reason?: 'quarantined' | 'missing-control' | 'ambiguous-control';
    identity?: Readonly<{
        distributedRunId: string;
        controlRunId: string;
    }>;
    baselinePatch: Partial<RecipeConsoleUrlState>;
    candidatePatch: Partial<RecipeConsoleUrlState>;
}>;

export function historyBaselineSelectionPatch(
    option: TuneRunOption | undefined,
): Partial<RecipeConsoleUrlState> {
    return option?.pairStatus === 'paired'
        ? tuneLeftSelectionPatch(option)
        : {};
}

export function historyCandidateSelectionPatch(
    option: TuneRunOption | undefined,
): Partial<RecipeConsoleUrlState> {
    return option?.pairStatus === 'paired'
        ? tuneRightSelectionPatch(option)
        : {};
}

export function historyRowSelectionActions(
    option: TuneRunOption | undefined,
): HistoryRowSelectionActions {
    if (!option) {
        return {
            eligible: false,
            reason: 'quarantined',
            baselinePatch: {},
            candidatePatch: {},
        };
    }
    if (option.pairStatus !== 'paired') {
        return {
            eligible: false,
            reason: option.pairStatus === 'missing'
                ? 'missing-control'
                : 'ambiguous-control',
            baselinePatch: {},
            candidatePatch: {},
        };
    }
    const baselinePatch = historyBaselineSelectionPatch(option);
    const candidatePatch = historyCandidateSelectionPatch(option);
    if (!baselinePatch.compareLeft || !candidatePatch.compareRight) {
        return {
            eligible: false,
            reason: 'quarantined',
            baselinePatch: {},
            candidatePatch: {},
        };
    }
    return {
        eligible: true,
        identity: {
            distributedRunId: option.distributedRunId,
            controlRunId: option.controlRunId,
        },
        baselinePatch,
        candidatePatch,
    };
}
