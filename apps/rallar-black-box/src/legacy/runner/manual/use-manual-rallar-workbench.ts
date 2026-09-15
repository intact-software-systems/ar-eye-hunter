import { selectRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useEffect, useState } from 'react';
import {
    type ManualActionHistoryEntry
} from '../../../manual-workbench.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

import { useRef } from 'react';
import { ManualWorkbenchActions } from './manual-workbench-actions.ts';
import { useManualWorkbenchDraft } from './use-manual-workbench-draft.ts';
import { useManualWorkbenchRecipes } from './use-manual-workbench-recipes.ts';
export interface ManualRallarWorkbenchOptions {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    globalValuesEdited?: boolean;
    onSelectCommand(commandId: string): void;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K]
    ): void;
}

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
        executeManualCommands: (commands, label) => rallarBlackBoxRuntimeStore.executeManualCommands(commands, label)
    });
    return {
        ...draft,
        ...recipes,
        history,
        localError,
        recipeVisible,
        setRecipeVisible,
        events: selectRallarBlackBoxEvents(options.state),
        runManualAction: actions.runManualAction,
        runRtcMatrix: actions.runRtcMatrix,
        runRtcNackProbe: actions.runRtcNackProbe,
        copyRecipeSnippet: actions.copyRecipeSnippet,
        copyRtcMatrixRecipe: actions.copyRtcMatrixRecipe,
        copyNegativeRecipe: actions.copyNegativeRecipe
    };
}
export type ManualRallarWorkbenchModel = ReturnType<typeof useManualRallarWorkbench>;
