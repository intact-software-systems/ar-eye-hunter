import type * as React from 'react';
import {
    useEffect,
    useRef,
    useState
} from 'react';

import type { RallarBlackBoxTestEvent } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { getRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/test-state-accessors.ts';

import type { ManualActionHistoryEntry } from '../../../manual-workbench.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import type { ManualRallarWorkbenchOptions } from './manual-rallar-workbench-options.ts';
import { ManualWorkbenchActions } from './manual-workbench-actions.ts';
import { useManualWorkbenchDraft } from './use-manual-workbench-draft.ts';
import { useManualWorkbenchRecipes } from './use-manual-workbench-recipes.ts';

export interface ManualRallarWorkbenchModel
    extends ReturnType<typeof useManualWorkbenchDraft>, ReturnType<typeof useManualWorkbenchRecipes> {
    readonly history: readonly ManualActionHistoryEntry[];
    readonly localError: string | undefined;
    readonly recipeVisible: boolean;
    readonly setRecipeVisible: React.Dispatch<React.SetStateAction<boolean>>;
    readonly events: readonly RallarBlackBoxTestEvent[];
    readonly runManualAction: ManualWorkbenchActions['runManualAction'];
    readonly runRtcMatrix: ManualWorkbenchActions['runRtcMatrix'];
    readonly runRtcNackProbe: ManualWorkbenchActions['runRtcNackProbe'];
    readonly copyRecipeSnippet: ManualWorkbenchActions['copyRecipeSnippet'];
    readonly copyRtcMatrixRecipe: ManualWorkbenchActions['copyRtcMatrixRecipe'];
    readonly copyNegativeRecipe: ManualWorkbenchActions['copyNegativeRecipe'];
}

interface ManualWorkbenchLifetime {
    active: boolean;
}

export function useManualRallarWorkbench(options: ManualRallarWorkbenchOptions): ManualRallarWorkbenchModel {
    const draft = useManualWorkbenchDraft(options);
    const [sequence, setSequence] = useState(1);
    const [history, setHistory] = useState<readonly ManualActionHistoryEntry[]>([]);
    const [localError, setLocalError] = useState<string | undefined>();
    const [recipeVisible, setRecipeVisible] = useState(false);
    const lifetime = useManualWorkbenchLifetime();
    const recipes = useManualWorkbenchRecipes({ ...draft, sequence, history });
    const input: ManualWorkbenchActions.Input = {
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
        runManualCommands: (commands, label) => rallarBlackBoxRuntimeStore.runManualCommands(commands, label)
    };
    const currentInput = useRef(input);
    currentInput.current = input;
    const actions = new ManualWorkbenchActions(() => currentInput.current);
    const runManualAction: ManualWorkbenchActions['runManualAction'] = (action) => {
        if (lifetime.active && action === 'reset') {
            draft.updateValue('rtcCaptureMode', undefined);
            draft.updateValue('rtcReadinessText', '');
        }
        return actions.runManualAction(action);
    };

    return {
        ...draft,
        ...recipes,
        history,
        localError,
        recipeVisible,
        setRecipeVisible,
        events: getRallarBlackBoxEvents(options.state),
        runManualAction,
        runRtcMatrix: actions.runRtcMatrix,
        runRtcNackProbe: actions.runRtcNackProbe,
        copyRecipeSnippet: actions.copyRecipeSnippet,
        copyRtcMatrixRecipe: actions.copyRtcMatrixRecipe,
        copyNegativeRecipe: actions.copyNegativeRecipe
    };
}

function useManualWorkbenchLifetime(): ManualWorkbenchLifetime {
    const lifetime = useRef<ManualWorkbenchLifetime>({ active: true }).current;
    useEffect(() => {
        lifetime.active = true;
        return () => {
            lifetime.active = false;
        };
    }, [lifetime]);
    return lifetime;
}
