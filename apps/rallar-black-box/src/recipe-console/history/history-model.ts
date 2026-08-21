import type { ControlRetentionCandidate } from '@shared-test/rallar-bb-test/control-retention.ts';
import { createRecipeConsoleHistoryCollection, type RecipeConsoleHistoryInput } from './history-window-collection.ts';
import { deriveRecipeConsoleHistoryWindow, RECIPE_CONSOLE_HISTORY_WINDOW_SIZE } from './history-window-model.ts';

export {
    createRecipeConsoleHistoryCollection
} from './history-window-collection.ts';
export type {
    RecipeConsoleHistoryCollection,
    RecipeConsoleHistoryInput,
    RecipeConsoleHistoryProvenance
} from './history-window-collection.ts';
export {
    deriveRecipeConsoleHistoryWindow,
    RECIPE_CONSOLE_HISTORY_WINDOW_SIZE
} from './history-window-model.ts';
export type {
    RecipeConsoleHistoryModel,
    RecipeConsoleHistoryProjectionWork,
    RecipeConsoleHistoryRow
} from './history-window-model.ts';

/** @deprecated Prefer RECIPE_CONSOLE_HISTORY_WINDOW_SIZE. */
export const RECIPE_CONSOLE_HISTORY_ROW_LIMIT = RECIPE_CONSOLE_HISTORY_WINDOW_SIZE;

export type HistoryRetentionCandidateRow =
    & Readonly<{ key: string; }>
    & ControlRetentionCandidate;

/** Preserves the first-window public facade while HistoryWorkspace owns traversal. */
export function deriveRecipeConsoleHistoryModel(
    input: RecipeConsoleHistoryInput
) {
    return deriveRecipeConsoleHistoryWindow(
        createRecipeConsoleHistoryCollection(input),
        0
    );
}

export function projectHistoryRetentionCandidateRows(
    candidates: readonly ControlRetentionCandidate[]
): readonly HistoryRetentionCandidateRow[] {
    return candidates.map((candidate, index) => ({
        key: `retention-candidate:${index}`,
        ...candidate,
        distributedRuns: candidate.distributedRuns.map((run) => ({ ...run })),
        fleetReportIds: [...candidate.fleetReportIds]
    }));
}
