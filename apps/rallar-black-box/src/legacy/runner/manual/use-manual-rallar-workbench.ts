import { getRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import { useEffect, useRef, useState } from 'react';
import type { ManualActionHistoryEntry } from '../../../manual-workbench.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import type { ManualRallarWorkbenchOptions } from './manual-rallar-workbench-options.ts';
import { ManualWorkbenchActions } from './manual-workbench-actions.ts';
import { useManualWorkbenchDraft } from './use-manual-workbench-draft.ts';
import { useManualWorkbenchRecipes } from './use-manual-workbench-recipes.ts';

export function useManualRallarWorkbench(options: ManualRallarWorkbenchOptions) {
    const draft = useManualWorkbenchDraft(options);
    const [sequence, setSequence] = useState(1);
    const [history, setHistory] = useState<readonly ManualActionHistoryEntry[]>([]);
    const [localError, setLocalError] = useState<string | undefined>();
    const [recipeVisible, setRecipeVisible] = useState(false);
    const lifetime = useRef({ active: true }).current;
    useEffect(() => {
        lifetime.active = true;
        return () => {
            lifetime.active = false;
        };
    }, [lifetime]);
    const recipes = useManualWorkbenchRecipes({ ...draft, sequence, history });
    const actions = new ManualWorkbenchActions({
        ...options,
        ...draft,
        ...recipes,
        sequence,
        setSequence,
        setHistory,
        setLocalError,
        lifetime,
        nowMs: Date.now,
        createRequestId: () => crypto.randomUUID(),
        runManualCommands: (commands, label) => rallarBlackBoxRuntimeStore.executeManualCommands(commands, label)
    });
    return {
        ...draft,
        ...recipes,
        history,
        localError,
        recipeVisible,
        setRecipeVisible,
        events: getRallarBlackBoxEvents(options.state),
        runManualAction: actions.runManualAction,
        runRtcMatrix: actions.runRtcMatrix,
        runRtcNackProbe: actions.runRtcNackProbe,
        copyRecipeSnippet: actions.copyRecipeSnippet,
        copyRtcMatrixRecipe: actions.copyRtcMatrixRecipe,
        copyNegativeRecipe: actions.copyNegativeRecipe
    };
}
export type ManualRallarWorkbenchModel = ReturnType<typeof useManualRallarWorkbench>;
