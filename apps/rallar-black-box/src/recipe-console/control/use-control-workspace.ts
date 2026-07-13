import { useCallback, useEffect, useMemo } from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { controlCommandStatus } from './ControlCommandContext.tsx';
import { useControlConnection } from './ControlConnectionProvider.tsx';
import {
    deriveRecipeConsoleControlSelection,
    recipeConsoleControlRunSelectionPatch,
} from './control-selection.ts';

export function useRecipeConsoleControlWorkspace(input: Readonly<{
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const connection = useControlConnection();
    const selection = useMemo(() => deriveRecipeConsoleControlSelection({
        urlState: input.urlState,
        snapshot: connection.query.snapshot,
        bootstrapRunId: connection.bootstrap.bootstrapRunId,
        bootstrapGroup: connection.bootstrap.bootstrapGroup,
        queryStatus: connection.query.status,
        nowEpochMs: Date.now(),
        selectionIndex: connection.selectionIndex,
    }), [
        connection.bootstrap.bootstrapGroup,
        connection.bootstrap.bootstrapRunId,
        connection.query.snapshot,
        connection.query.status,
        connection.selectionIndex,
        input.urlState.agentId,
        input.urlState.controlRunId,
        input.urlState.distributedRunId,
    ]);
    const status = controlCommandStatus(connection.query);

    useEffect(() => {
        if (
            selection.urlReplacePatch &&
            (connection.query.status === 'live' || connection.query.status === 'partial')
        ) {
            input.replace(selection.urlReplacePatch);
        }
    }, [
        connection.query.status,
        input.replace,
        selection.urlReplacePatch,
    ]);

    const selectControlRun = useCallback((controlRunId: string) => {
        input.navigate(recipeConsoleControlRunSelectionPatch({
            state: input.urlState,
            controlRunId,
            distributedRuns: connection.query.snapshot?.distributedRuns ?? [],
        }));
    }, [connection.query.snapshot?.distributedRuns, input.navigate, input.urlState]);
    const selectAgent = useCallback((agentId: string) => {
        input.navigate({ agentId });
    }, [input.navigate]);

    return {
        connection,
        selection,
        status,
        selectAgent,
        selectControlRun,
    } as const;
}
