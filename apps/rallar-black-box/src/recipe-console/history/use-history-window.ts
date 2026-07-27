import {
    useExplicitWindow,
    useExplicitWindowFocusRecovery,
} from '../ui/use-explicit-window.ts';
import {
    type RecipeConsoleHistoryCollection,
} from './history-window-collection.ts';
import { RECIPE_CONSOLE_HISTORY_WINDOW_SIZE } from './history-window-model.ts';

export type HistoryWindowController = ReturnType<typeof useHistoryWindow>;

export function useHistoryWindow(collection: RecipeConsoleHistoryCollection) {
    const controller = useExplicitWindow({
        fingerprint: collection.fingerprint,
        total: collection.counts.total,
        windowSize: RECIPE_CONSOLE_HISTORY_WINDOW_SIZE,
    });
    const focus = useExplicitWindowFocusRecovery(controller.model);
    return {
        ...controller,
        contentFocusProps: focus.contentFocusProps,
        controlsFocusProps: focus.contentFocusProps,
        focusFallbackRef: focus.fallbackFocusRef,
    } as const;
}
